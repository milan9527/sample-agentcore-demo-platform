#!/bin/bash
set -euo pipefail

# Disable AWS CLI pager (compatible with both v1 and v2)
export AWS_PAGER=""

# =============================================================================
# Super Agent — Full Deploy Script (CDK + CloudFront + ECS Backend + AgentCore)
#
# Deploys the complete stack using ECS Fargate for the backend instead of EC2.
# CDK infra with CloudFront CDN (local auth), ECS service for backend,
# then sets up AgentCore Runtime (ECR, IAM, container build/push, Runtime).
#
# Prerequisites:
#   - AWS CLI v2
#   - Docker (with buildx, ARM64 support — native on Apple Silicon)
#   - Node.js 22+
#
# Usage:
#   ./deploy-full-ecs.sh [options]
#
# Options:
#   --stack <name>          CloudFormation stack name (default: SuperAgent)
#   --region <region>       AWS region (default: us-west-2)
#   --domain <domain>       Custom domain for CloudFront (requires --hosted-zone-id)
#   --hosted-zone-id <id>   Route53 hosted zone ID
#   --bedrock-ak <key>      Bedrock AWS Access Key (cross-account, optional)
#   --bedrock-sk <secret>   Bedrock AWS Secret Key (cross-account, optional)
#   --skip-cdk              Skip CDK deploy (reuse existing stack)
#   --skip-agentcore        Skip AgentCore setup
#   --skip-frontend         Skip frontend build/sync
#   --skip-backend          Skip backend build/deploy
#
# Examples:
#   # Full deploy with custom domain:
#   ./deploy-full-ecs.sh --stack SuperAgent36 --region ap-northeast-1 \
#     --domain app36.zhangwangshu.com --hosted-zone-id Z0941803Z9XESANM6GCQ
#
#   # Full deploy, IP-only (no custom domain):
#   ./deploy-full-ecs.sh
#
#   # Redeploy code only (stack + AgentCore already exist):
#   ./deploy-full-ecs.sh --skip-cdk
#
# =============================================================================

STACK_NAME="SuperAgent"
REGION="us-west-2"
DOMAIN_NAME=""
HOSTED_ZONE_ID=""
BEDROCK_AK=""
BEDROCK_SK=""
SKIP_CDK=false
SKIP_AGENTCORE=false
SKIP_FRONTEND=false
SKIP_BACKEND=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)            STACK_NAME="$2"; shift 2 ;;
    --region)           REGION="$2"; shift 2 ;;
    --domain)           DOMAIN_NAME="$2"; shift 2 ;;
    --hosted-zone-id)   HOSTED_ZONE_ID="$2"; shift 2 ;;
    --bedrock-ak)       BEDROCK_AK="$2"; shift 2 ;;
    --bedrock-sk)       BEDROCK_SK="$2"; shift 2 ;;
    --skip-cdk)         SKIP_CDK=true; shift ;;
    --skip-agentcore)   SKIP_AGENTCORE=true; shift ;;
    --skip-frontend)    SKIP_FRONTEND=true; shift ;;
    --skip-backend)     SKIP_BACKEND=true; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BACKEND_ECR_REPO="super-agent-backend"
BACKEND_ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/$BACKEND_ECR_REPO"
AGENTCORE_ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/super-agent-agentcore"

echo "============================================="
echo "  Super Agent Full Deploy (ECS)"
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $REGION"
echo "  Stack:    $STACK_NAME"
[ -n "$DOMAIN_NAME" ] && echo "  Domain:   $DOMAIN_NAME"
echo "============================================="

# =========================================================================
# Phase 1: CDK Deploy (creates VPC, RDS, Redis, S3, ECS cluster, ALB, etc.)
# =========================================================================
if [ "$SKIP_CDK" = false ]; then
  echo ""
  echo "=== Phase 1: CDK Deploy ==="
  cd "$SCRIPT_DIR/.."

  npm install

  CDK_ARGS="-c stackName=$STACK_NAME -c enableCdn=true -c deployTarget=ecs"

  if [ -n "$DOMAIN_NAME" ] && [ -n "$HOSTED_ZONE_ID" ]; then
    CDK_ARGS="$CDK_ARGS -c domainName=$DOMAIN_NAME -c hostedZoneId=$HOSTED_ZONE_ID"
  fi

  echo "  Running: npx cdk deploy $CDK_ARGS --region $REGION --require-approval never"
  npx cdk deploy $CDK_ARGS --region "$REGION" --require-approval never
else
  echo ""
  echo "=== Phase 1: CDK Deploy (skipped) ==="
fi

# =========================================================================
# Read stack outputs
# =========================================================================
echo ""
echo "=== Reading stack outputs ==="
OUTPUTS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs" --output json)

get_output() {
  echo "$OUTPUTS" | python3 -c "
import sys, json
outputs = json.load(sys.stdin)
for o in outputs:
    if o['OutputKey'] == '$1':
        print(o['OutputValue'])
        break
" 2>/dev/null || echo ""
}

DB_ENDPOINT=$(get_output "DBEndpoint")
DB_SECRET_ARN=$(get_output "DBSecretArn")
AVATAR_BUCKET=$(get_output "AvatarBucketName")
SKILLS_BUCKET=$(get_output "SkillsBucketName")
WORKSPACE_BUCKET=$(get_output "WorkspaceBucketName")
AUTH_MODE=$(get_output "AuthMode")
ENABLE_CDN=$(get_output "EnableCdn")
REDIS_ENDPOINT=$(get_output "RedisEndpoint")
REDIS_PORT_OUTPUT=$(get_output "RedisPort")
FRONTEND_BUCKET=$(get_output "FrontendBucketName")
CF_DIST_ID=$(get_output "CloudFrontDistributionId")
COGNITO_USER_POOL_ID=$(get_output "CognitoUserPoolId")
COGNITO_CLIENT_ID=$(get_output "CognitoClientId")
COGNITO_DOMAIN=$(get_output "CognitoDomainUrl")

# ECS-specific outputs
ECS_CLUSTER_NAME=$(get_output "EcsClusterName")
ECS_SERVICE_NAME=$(get_output "EcsServiceName")
ECS_TASK_FAMILY=$(get_output "EcsTaskFamily")
ECS_TASK_EXEC_ROLE_ARN=$(get_output "EcsTaskExecRoleArn")
ECS_TASK_ROLE_ARN=$(get_output "EcsTaskRoleArn")
ALB_DNS=$(get_output "AlbDnsName")
ECS_SUBNETS=$(get_output "EcsSubnets")
ECS_SG=$(get_output "EcsSecurityGroup")

echo "  DBEndpoint:       $DB_ENDPOINT"
echo "  AuthMode:         $AUTH_MODE"
echo "  WorkspaceBucket:  $WORKSPACE_BUCKET"
echo "  SkillsBucket:     $SKILLS_BUCKET"
echo "  RedisEndpoint:    ${REDIS_ENDPOINT:-localhost}:${REDIS_PORT_OUTPUT:-6379}"
echo "  ECS Cluster:      $ECS_CLUSTER_NAME"
echo "  ECS Service:      $ECS_SERVICE_NAME"
echo "  ALB DNS:          $ALB_DNS"
[ -n "$DOMAIN_NAME" ] && echo "  DomainName:       $DOMAIN_NAME"
[ -n "$CF_DIST_ID" ]  && echo "  CloudFrontDistId: $CF_DIST_ID"

# =========================================================================
# Fix CloudFront ALB origin (replace placeholder with actual ALB DNS)
# =========================================================================
if [ -n "$DOMAIN_NAME" ] && [ -n "$CF_DIST_ID" ] && [ -n "$ALB_DNS" ]; then
  CURRENT_ORIGINS=$(aws cloudfront get-distribution-config --id "$CF_DIST_ID" \
    --query "DistributionConfig.Origins.Items[*].DomainName" --output text 2>/dev/null || echo "")
  if echo "$CURRENT_ORIGINS" | grep -q "ec2-placeholder\|alb-placeholder"; then
    echo ""
    echo "=== Updating CloudFront API origin → $ALB_DNS ==="
    CF_ETAG=$(aws cloudfront get-distribution-config --id "$CF_DIST_ID" --query "ETag" --output text)
    aws cloudfront get-distribution-config --id "$CF_DIST_ID" --output json | \
      python3 -c "
import sys, json
data = json.load(sys.stdin)
config = data['DistributionConfig']
for origin in config['Origins']['Items']:
    if 'placeholder' in origin['DomainName']:
        origin['DomainName'] = '$ALB_DNS'
json.dump(config, open('/tmp/cf-origin-fix.json', 'w'))
"
    aws cloudfront update-distribution --id "$CF_DIST_ID" --if-match "$CF_ETAG" \
      --distribution-config file:///tmp/cf-origin-fix.json \
      --query "Distribution.Status" --output text 2>/dev/null || true
    rm -f /tmp/cf-origin-fix.json
    echo "  CloudFront origin updated."
  fi
fi

# =========================================================================
# Phase 2: Build + Deploy Backend to ECS
# =========================================================================
if [ "$SKIP_BACKEND" = false ]; then
  echo ""
  echo "=== Phase 2: Build & Deploy Backend to ECS ==="

  # --- 2a: Ensure ECR repository for backend ---
  echo "  [2a] Ensuring ECR repository for backend..."
  aws ecr describe-repositories --repository-names "$BACKEND_ECR_REPO" --region "$REGION" 2>/dev/null \
    || aws ecr create-repository --repository-name "$BACKEND_ECR_REPO" --region "$REGION"
  echo "  ECR: $BACKEND_ECR_URI"

  # --- 2b: Build and push backend Docker image ---
  echo "  [2b] Building and pushing backend container..."
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

  cd "$PROJECT_ROOT/backend"

  # Copy industry-packs into build context if available
  if [ -d "$PROJECT_ROOT/industry-packs" ]; then
    cp -r "$PROJECT_ROOT/industry-packs" ./industry-packs-build
  fi

  IMAGE_TAG="$(date +%Y%m%d%H%M%S)-$(git rev-parse --short HEAD 2>/dev/null || echo 'latest')"
  docker buildx build --platform linux/arm64 \
    -t "$BACKEND_ECR_URI:latest" \
    -t "$BACKEND_ECR_URI:$IMAGE_TAG" \
    --load .
  docker push "$BACKEND_ECR_URI:latest"
  docker push "$BACKEND_ECR_URI:$IMAGE_TAG"
  echo "  Image pushed: $BACKEND_ECR_URI:$IMAGE_TAG"

  # Cleanup build artifacts
  rm -rf ./industry-packs-build

  # --- 2c: Fetch DATABASE_URL from Secrets Manager ---
  echo "  [2c] Fetching DATABASE_URL from Secrets Manager..."
  SECRET_JSON=$(aws secretsmanager get-secret-value \
    --secret-id "$DB_SECRET_ARN" --region "$REGION" \
    --query SecretString --output text)
  DB_USER=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['username'])")
  DB_PASS=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['password'])")
  DB_HOST=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['host'])")
  DB_PORT=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['port'])")
  DB_NAME=$(echo "$SECRET_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('dbname','super_agent'))")
  ENCODED_DB_PASS=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$DB_PASS', safe=''))")
  DATABASE_URL="postgresql://${DB_USER}:${ENCODED_DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=no-verify"

  # --- 2d: Run Prisma migrations via ECS run-task (RDS is not publicly accessible) ---
  echo "  [2d] Running Prisma migrations via ECS task..."

  # Register a one-off migration task definition
  # Note: We rewrite prisma.config.ts without dotenv (not installed in prod image)
  MIGRATE_TASK_JSON=$(python3 << PYEOF
import json
task_def = {
    "family": "${ECS_TASK_FAMILY:-super-agent-backend}-migrate",
    "networkMode": "awsvpc",
    "requiresCompatibilities": ["FARGATE"],
    "cpu": "512",
    "memory": "1024",
    "runtimePlatform": {
        "cpuArchitecture": "ARM64",
        "operatingSystemFamily": "LINUX"
    },
    "executionRoleArn": "$ECS_TASK_EXEC_ROLE_ARN",
    "taskRoleArn": "$ECS_TASK_ROLE_ARN",
    "containerDefinitions": [{
        "name": "migrate",
        "image": "$BACKEND_ECR_URI:$IMAGE_TAG",
        "essential": True,
        "entryPoint": ["sh", "-c"],
        "command": ["cat > prisma.config.ts << 'EOF'\nimport { defineConfig } from \"prisma/config\";\nexport default defineConfig({\n  schema: \"prisma/schema.prisma\",\n  migrations: { path: \"prisma/migrations\" },\n  datasource: { url: process.env.DATABASE_URL },\n});\nEOF\nnpx prisma migrate deploy && echo MIGRATE_OK || exit 1"],
        "environment": [
            {"name": "DATABASE_URL", "value": "$DATABASE_URL"}
        ],
        "logConfiguration": {
            "logDriver": "awslogs",
            "options": {
                "awslogs-group": "/super-agent/ecs-backend",
                "awslogs-region": "$REGION",
                "awslogs-stream-prefix": "migrate",
                "awslogs-create-group": "true"
            }
        }
    }]
}
print(json.dumps(task_def))
PYEOF
)

  echo "$MIGRATE_TASK_JSON" > /tmp/ecs-migrate-task.json
  MIGRATE_TASK_ARN=$(aws ecs register-task-definition \
    --cli-input-json file:///tmp/ecs-migrate-task.json \
    --region "$REGION" \
    --query "taskDefinition.taskDefinitionArn" --output text)
  rm -f /tmp/ecs-migrate-task.json
  echo "  Migration task registered: $MIGRATE_TASK_ARN"

  # Run the migration task
  MIGRATE_TASK_ID=$(aws ecs run-task \
    --cluster "$ECS_CLUSTER_NAME" \
    --task-definition "$MIGRATE_TASK_ARN" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" \
    --region "$REGION" \
    --query "tasks[0].taskArn" --output text)
  echo "  Migration task started: $MIGRATE_TASK_ID"

  # Wait for migration task to complete
  echo "  Waiting for migration to complete..."
  aws ecs wait tasks-stopped \
    --cluster "$ECS_CLUSTER_NAME" \
    --tasks "$MIGRATE_TASK_ID" \
    --region "$REGION" 2>/dev/null || true

  # Check exit code
  MIGRATE_EXIT=$(aws ecs describe-tasks \
    --cluster "$ECS_CLUSTER_NAME" \
    --tasks "$MIGRATE_TASK_ID" \
    --region "$REGION" \
    --query "tasks[0].containers[0].exitCode" --output text 2>/dev/null || echo "unknown")
  if [ "$MIGRATE_EXIT" = "0" ]; then
    echo "  Migrations completed successfully."
  else
    echo "  WARNING: Migration task exited with code $MIGRATE_EXIT (check logs: /super-agent/ecs-backend/migrate)"
  fi

  # --- 2d-2: Seed database and set admin password ---
  echo "  [2d-2] Seeding database..."
  SEED_CMD='cat > prisma.config.ts << EOF
import { defineConfig } from "prisma/config";
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env.DATABASE_URL },
});
EOF
npx tsx prisma/seed.ts 2>&1 || echo "(Seed skipped - may already exist)"
echo "Setting admin password..."
echo '"'"'const b=require("bcryptjs");const{Client}=require("pg");(async()=>{const h=await b.hash("Admin1234!",10);const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query("UPDATE profiles SET password_hash=$1 WHERE username=$2",[h,"admin@example.com"]);console.log("Updated:",r.rowCount);await c.end()})()'"'"' > /app/setpw.cjs && node /app/setpw.cjs'

  SEED_TASK_ID=$(aws ecs run-task \
    --cluster "$ECS_CLUSTER_NAME" \
    --task-definition "$MIGRATE_TASK_ARN" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"migrate\",\"entryPoint\":[\"sh\",\"-c\"],\"command\":[\"$SEED_CMD\"],\"environment\":[{\"name\":\"DATABASE_URL\",\"value\":\"$DATABASE_URL\"}]}]}" \
    --region "$REGION" \
    --query "tasks[0].taskArn" --output text)
  echo "  Seed task started: $SEED_TASK_ID"
  aws ecs wait tasks-stopped --cluster "$ECS_CLUSTER_NAME" --tasks "$SEED_TASK_ID" --region "$REGION" 2>/dev/null || true
  echo "  Seed complete. Admin login: admin@example.com / Admin1234!"

  # --- 2e: Determine environment variables for ECS task ---
  echo "  [2e] Configuring ECS task environment..."

  # Determine CORS and APP_URL
  if [ -n "$DOMAIN_NAME" ]; then
    APP_URL="https://$DOMAIN_NAME"
    CORS_VALUE="https://$DOMAIN_NAME"
  else
    APP_URL="http://$ALB_DNS"
    CORS_VALUE="http://$ALB_DNS"
  fi

  JWT_SECRET=$(openssl rand -hex 32)

  # --- 2f: Register new ECS task definition ---
  echo "  [2f] Registering ECS task definition..."

  # Build environment JSON array
  ENV_JSON=$(python3 -c "
import json
env = {
    'PORT': '3000',
    'HOST': '0.0.0.0',
    'NODE_ENV': 'production',
    'LOG_LEVEL': 'info',
    'DATABASE_URL': '$DATABASE_URL',
    'REDIS_HOST': '${REDIS_ENDPOINT:-localhost}',
    'REDIS_PORT': '${REDIS_PORT_OUTPUT:-6379}',
    'REDIS_PASSWORD': '',
    'AUTH_MODE': '${AUTH_MODE:-local}',
    'AWS_REGION': '$REGION',
    'S3_BUCKET_NAME': '$AVATAR_BUCKET',
    'S3_PRESIGNED_URL_EXPIRES': '3600',
    'SKILLS_S3_BUCKET': '$SKILLS_BUCKET',
    'CORS_ORIGIN': '$CORS_VALUE',
    'APP_URL': '$APP_URL',
    'CLAUDE_CODE_USE_BEDROCK': '1',
    'CLAUDE_MODEL': 'global.anthropic.claude-sonnet-4-6',
    'AGENT_WORKSPACE_BASE_DIR': '/app/workspaces',
    'AGENT_RUNTIME': 'claude',
    'AGENTCORE_WORKSPACE_S3_BUCKET': '$WORKSPACE_BUCKET',
    'RAG_ENABLED': 'true',
    'JWT_SECRET': '$JWT_SECRET',
}
# Add Cognito vars if applicable
cognito_pool = '${COGNITO_USER_POOL_ID:-}'
if cognito_pool:
    env['COGNITO_USER_POOL_ID'] = cognito_pool
    env['COGNITO_CLIENT_ID'] = '${COGNITO_CLIENT_ID:-}'
    env['COGNITO_REGION'] = '$REGION'
    env['COGNITO_DOMAIN'] = '${COGNITO_DOMAIN:-}'
result = [{'name': k, 'value': v} for k, v in env.items()]
print(json.dumps(result))
")

  # Build task definition JSON
  TASK_DEF_JSON=$(python3 -c "
import json
task_def = {
    'family': '${ECS_TASK_FAMILY:-super-agent-backend}',
    'networkMode': 'awsvpc',
    'requiresCompatibilities': ['FARGATE'],
    'cpu': '1024',
    'memory': '2048',
    'runtimePlatform': {
        'cpuArchitecture': 'ARM64',
        'operatingSystemFamily': 'LINUX'
    },
    'executionRoleArn': '$ECS_TASK_EXEC_ROLE_ARN',
    'taskRoleArn': '$ECS_TASK_ROLE_ARN',
    'containerDefinitions': [{
        'name': 'backend',
        'image': '$BACKEND_ECR_URI:$IMAGE_TAG',
        'essential': True,
        'portMappings': [{
            'containerPort': 3000,
            'protocol': 'tcp'
        }],
        'environment': $ENV_JSON,
        'logConfiguration': {
            'logDriver': 'awslogs',
            'options': {
                'awslogs-group': '/super-agent/ecs-backend',
                'awslogs-region': '$REGION',
                'awslogs-stream-prefix': 'backend',
                'awslogs-create-group': 'true'
            }
        },
        'healthCheck': {
            'command': ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
            'interval': 30,
            'timeout': 10,
            'retries': 3,
            'startPeriod': 60
        }
    }]
}
print(json.dumps(task_def))
")

  # Write task definition to temp file and register
  echo "$TASK_DEF_JSON" > /tmp/ecs-task-def.json
  TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json file:///tmp/ecs-task-def.json \
    --region "$REGION" \
    --query "taskDefinition.taskDefinitionArn" --output text)
  rm -f /tmp/ecs-task-def.json
  echo "  Task definition registered: $TASK_DEF_ARN"

  # --- 2g: Update ECS service with new task definition ---
  echo "  [2g] Updating ECS service..."
  aws ecs update-service \
    --cluster "$ECS_CLUSTER_NAME" \
    --service "$ECS_SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --force-new-deployment \
    --region "$REGION" \
    --query "service.serviceName" --output text

  echo "  Waiting for ECS service to stabilize..."
  aws ecs wait services-stable \
    --cluster "$ECS_CLUSTER_NAME" \
    --services "$ECS_SERVICE_NAME" \
    --region "$REGION" 2>/dev/null || echo "  (Wait timed out, service may still be deploying)"

  echo "  Backend deployed to ECS."
else
  echo ""
  echo "=== Phase 2: Backend Deploy (skipped) ==="
fi

# =========================================================================
# Phase 3: Build + Deploy Frontend
# =========================================================================
if [ "$SKIP_FRONTEND" = false ]; then
  echo ""
  echo "=== Phase 3: Build & Deploy Frontend ==="

  # Determine APP_URL for frontend build
  if [ -n "$DOMAIN_NAME" ]; then
    APP_URL="https://$DOMAIN_NAME"
  else
    APP_URL="http://$ALB_DNS"
  fi

  cd "$PROJECT_ROOT/frontend"

  # Generate .env.production for Vite
  if [ "${AUTH_MODE:-local}" = "cognito" ] && [ -n "$COGNITO_USER_POOL_ID" ]; then
    cat > .env.production << VITE_EOF
VITE_API_BASE_URL=
VITE_COGNITO_REGION=$REGION
VITE_COGNITO_USER_POOL_ID=$COGNITO_USER_POOL_ID
VITE_COGNITO_CLIENT_ID=$COGNITO_CLIENT_ID
VITE_COGNITO_DOMAIN=$COGNITO_DOMAIN
VITE_COGNITO_REDIRECT_URI=$APP_URL/auth/callback
VITE_EOF
  else
    cat > .env.production << VITE_EOF
VITE_API_BASE_URL=
VITE_AUTH_MODE=local
VITE_EOF
  fi

  npm ci
  npx vite build

  # Sync to S3 + CloudFront invalidation
  if [ -n "$FRONTEND_BUCKET" ]; then
    echo "  Syncing frontend to S3 ($FRONTEND_BUCKET)..."
    cd "$PROJECT_ROOT"
    aws s3 sync frontend/dist/ "s3://$FRONTEND_BUCKET/" --delete --region "$REGION"
    if [ -n "$CF_DIST_ID" ]; then
      echo "  Invalidating CloudFront ($CF_DIST_ID)..."
      aws cloudfront create-invalidation \
        --distribution-id "$CF_DIST_ID" --paths "/*" \
        --region "$REGION" 2>/dev/null || true
    fi
  else
    echo "  WARNING: No frontend bucket found. Frontend not deployed."
  fi
else
  echo ""
  echo "=== Phase 3: Frontend Deploy (skipped) ==="
fi

# =========================================================================
# Phase 4: AgentCore Setup
# =========================================================================
if [ "$SKIP_AGENTCORE" = false ]; then
  echo ""
  echo "=== Phase 4: AgentCore Setup ==="

  # --- 4a: ECR Repository ---
  echo "  [4a] Ensuring ECR repository for AgentCore..."
  aws ecr describe-repositories --repository-names super-agent-agentcore --region "$REGION" 2>/dev/null \
    || aws ecr create-repository --repository-name super-agent-agentcore --region "$REGION"
  echo "  ECR: $AGENTCORE_ECR_URI"

  # --- 4b: IAM Execution Role ---
  echo "  [4b] Ensuring IAM execution role..."
  ROLE_NAME="super-agent-agentcore-role-${STACK_NAME}"
  POLICY_NAME="agentcore-permissions-${STACK_NAME}"

  if ! aws iam get-role --role-name "$ROLE_NAME" 2>/dev/null; then
    echo "  Creating role $ROLE_NAME..."
    aws iam create-role \
      --role-name "$ROLE_NAME" \
      --assume-role-policy-document '{
        "Version": "2012-10-17",
        "Statement": [{
          "Effect": "Allow",
          "Principal": { "Service": "bedrock-agentcore.amazonaws.com" },
          "Action": "sts:AssumeRole"
        }]
      }' \
      --description "Execution role for Super Agent AgentCore containers ($STACK_NAME)"
  fi

  # Always update permissions to latest
  echo "  Updating permissions policy ($POLICY_NAME)..."
  WORKSPACE_BUCKET_NAME="${WORKSPACE_BUCKET:-super-agent-workspace-$ACCOUNT_ID}"
  SKILLS_BUCKET_NAME="${SKILLS_BUCKET:-}"

  aws iam put-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-name "$POLICY_NAME" \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [
        {
          \"Sid\": \"BedrockInvoke\",
          \"Effect\": \"Allow\",
          \"Action\": [\"bedrock:InvokeModel\", \"bedrock:InvokeModelWithResponseStream\"],
          \"Resource\": \"*\"
        },
        {
          \"Sid\": \"WorkspaceS3\",
          \"Effect\": \"Allow\",
          \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:ListBucket\", \"s3:DeleteObject\"],
          \"Resource\": [
            \"arn:aws:s3:::$WORKSPACE_BUCKET_NAME\",
            \"arn:aws:s3:::$WORKSPACE_BUCKET_NAME/*\"
          ]
        },
        {
          \"Sid\": \"SkillsS3\",
          \"Effect\": \"Allow\",
          \"Action\": [\"s3:GetObject\", \"s3:ListBucket\"],
          \"Resource\": [
            \"arn:aws:s3:::$SKILLS_BUCKET_NAME\",
            \"arn:aws:s3:::$SKILLS_BUCKET_NAME/*\"
          ]
        },
        {
          \"Sid\": \"ECRPull\",
          \"Effect\": \"Allow\",
          \"Action\": [\"ecr:GetDownloadUrlForLayer\", \"ecr:BatchGetImage\", \"ecr:GetAuthorizationToken\"],
          \"Resource\": \"*\"
        },
        {
          \"Sid\": \"BrowserTool\",
          \"Effect\": \"Allow\",
          \"Action\": [
            \"bedrock-agentcore:CreateBrowser\",
            \"bedrock-agentcore:ListBrowsers\",
            \"bedrock-agentcore:GetBrowser\",
            \"bedrock-agentcore:DeleteBrowser\",
            \"bedrock-agentcore:StartBrowserSession\",
            \"bedrock-agentcore:StopBrowserSession\",
            \"bedrock-agentcore:GetBrowserSession\",
            \"bedrock-agentcore:ListBrowserSessions\",
            \"bedrock-agentcore:ConnectBrowserAutomationStream\",
            \"bedrock-agentcore:ConnectBrowserLiveViewStream\",
            \"bedrock-agentcore:UpdateBrowserStream\"
          ],
          \"Resource\": \"arn:aws:bedrock-agentcore:*:*:browser/*\"
        },
        {
          \"Sid\": \"CodeInterpreter\",
          \"Effect\": \"Allow\",
          \"Action\": [
            \"bedrock-agentcore:StartCodeInterpreterSession\",
            \"bedrock-agentcore:InvokeCodeInterpreter\",
            \"bedrock-agentcore:StopCodeInterpreterSession\",
            \"bedrock-agentcore:GetCodeInterpreterSession\",
            \"bedrock-agentcore:ListCodeInterpreterSessions\"
          ],
          \"Resource\": \"arn:aws:bedrock-agentcore:*:*:code-interpreter/*\"
        }
      ]
    }"

  # --- 4c: Build + Push AgentCore Docker Image ---
  echo "  [4c] Building and pushing AgentCore container..."
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

  cd "$PROJECT_ROOT/agentcore"
  docker buildx build --platform linux/arm64 \
    -t "super-agent-agentcore:latest" \
    -t "$AGENTCORE_ECR_URI:latest" \
    --load .
  docker push "$AGENTCORE_ECR_URI:latest"
  echo "  Image pushed: $AGENTCORE_ECR_URI:latest"

  # --- 4d: Create or Update AgentCore Runtime ---
  echo "  [4d] Creating/updating AgentCore Runtime..."
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"

  # Build environment variables JSON
  ENV_VARS="{\"CLAUDE_CODE_USE_BEDROCK\":\"1\",\"ANTHROPIC_MODEL\":\"global.anthropic.claude-opus-4-6-v1\",\"AWS_REGION\":\"$REGION\",\"WORKSPACE_S3_REGION\":\"$REGION\""
  if [ -n "$BEDROCK_AK" ] && [ -n "$BEDROCK_SK" ]; then
    ENV_VARS="$ENV_VARS,\"AWS_ACCESS_KEY_ID\":\"$BEDROCK_AK\",\"AWS_SECRET_ACCESS_KEY\":\"$BEDROCK_SK\""
  fi
  ENV_VARS="$ENV_VARS}"

  # Try to find existing runtime (stack-scoped name)
  RUNTIME_NAME="${STACK_NAME}Runtime"
  RUNTIME_ID=$(aws bedrock-agentcore-control list-agent-runtimes --region "$REGION" \
    --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId" \
    --output text 2>/dev/null || echo "")

  if [ -n "$RUNTIME_ID" ] && [ "$RUNTIME_ID" != "None" ]; then
    echo "  Updating existing runtime: $RUNTIME_ID"
    aws bedrock-agentcore-control update-agent-runtime \
      --agent-runtime-id "$RUNTIME_ID" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$AGENTCORE_ECR_URI:latest\"}}" \
      --role-arn "$ROLE_ARN" \
      --network-configuration '{"networkMode":"PUBLIC"}' \
      --environment-variables "$ENV_VARS" \
      --region "$REGION"
  else
    echo "  Creating new runtime..."
    RUNTIME_OUTPUT=$(aws bedrock-agentcore-control create-agent-runtime \
      --agent-runtime-name "${RUNTIME_NAME}" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$AGENTCORE_ECR_URI:latest\"}}" \
      --role-arn "$ROLE_ARN" \
      --network-configuration '{"networkMode":"PUBLIC"}' \
      --environment-variables "$ENV_VARS" \
      --description "Super Agent AgentCore Runtime" \
      --region "$REGION" --output json)
    RUNTIME_ID=$(echo "$RUNTIME_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['agentRuntimeId'])")
  fi

  RUNTIME_ARN="arn:aws:bedrock-agentcore:$REGION:$ACCOUNT_ID:runtime/$RUNTIME_ID"
  echo "  Runtime ARN: $RUNTIME_ARN"

  # Wait for runtime to be READY
  echo "  Waiting for runtime to be READY..."
  for i in $(seq 1 30); do
    RT_STATUS=$(aws bedrock-agentcore-control get-agent-runtime \
      --agent-runtime-id "$RUNTIME_ID" --region "$REGION" \
      --query 'status' --output text 2>/dev/null || echo "UNKNOWN")
    [ "$RT_STATUS" = "READY" ] && echo "  Runtime is READY." && break
    echo "  Attempt $i/30 - status: $RT_STATUS, waiting 10s..."
    sleep 10
  done

  if [ "$RT_STATUS" != "READY" ]; then
    echo "WARNING: Runtime not READY after 5 minutes (status: $RT_STATUS). Continuing anyway."
  fi

  # --- 4e: Update ECS task with AgentCore env vars ---
  echo "  [4e] Enabling AgentCore mode in ECS task..."

  # Re-register task definition with AgentCore environment variables added
  CURRENT_TASK_DEF=$(aws ecs describe-task-definition \
    --task-definition "$ECS_TASK_FAMILY" --region "$REGION" \
    --query "taskDefinition" --output json)

  UPDATED_TASK_DEF=$(echo "$CURRENT_TASK_DEF" | python3 -c "
import sys, json
td = json.load(sys.stdin)
container = td['containerDefinitions'][0]
env = {e['name']: e['value'] for e in container.get('environment', [])}
env['AGENT_RUNTIME'] = 'agentcore'
env['AGENTCORE_RUNTIME_ARN'] = '$RUNTIME_ARN'
env['AGENTCORE_EXECUTION_ROLE_ARN'] = '$ROLE_ARN'
env['AGENTCORE_WORKSPACE_S3_BUCKET'] = '$WORKSPACE_BUCKET_NAME'
container['environment'] = [{'name': k, 'value': v} for k, v in env.items()]

# Build register-task-definition input (remove read-only fields)
for key in ['taskDefinitionArn', 'revision', 'status', 'requiresAttributes',
            'compatibilities', 'registeredAt', 'registeredBy', 'deregisteredAt']:
    td.pop(key, None)
print(json.dumps(td))
")

  echo "$UPDATED_TASK_DEF" > /tmp/ecs-task-def-agentcore.json
  TASK_DEF_ARN=$(aws ecs register-task-definition \
    --cli-input-json file:///tmp/ecs-task-def-agentcore.json \
    --region "$REGION" \
    --query "taskDefinition.taskDefinitionArn" --output text)
  rm -f /tmp/ecs-task-def-agentcore.json
  echo "  Updated task definition: $TASK_DEF_ARN"

  # Update ECS service with AgentCore-enabled task
  aws ecs update-service \
    --cluster "$ECS_CLUSTER_NAME" \
    --service "$ECS_SERVICE_NAME" \
    --task-definition "$TASK_DEF_ARN" \
    --desired-count 1 \
    --force-new-deployment \
    --region "$REGION" \
    --query "service.serviceName" --output text

  echo "  ECS service updating with AgentCore mode..."
  aws ecs wait services-stable \
    --cluster "$ECS_CLUSTER_NAME" \
    --services "$ECS_SERVICE_NAME" \
    --region "$REGION" 2>/dev/null || echo "  (Wait timed out, service may still be deploying)"

  echo "  AgentCore mode enabled on ECS."
else
  echo ""
  echo "=== Phase 4: AgentCore Setup (skipped) ==="
fi

# =========================================================================
# Done
# =========================================================================
echo ""
echo "============================================="
echo "  Full Deployment Complete! (ECS)"
echo "============================================="
if [ -n "$DOMAIN_NAME" ]; then
  echo "  App URL:    https://$DOMAIN_NAME"
else
  echo "  App URL:    http://$ALB_DNS"
fi
echo "  ALB:        $ALB_DNS"
echo "  ECS:        $ECS_CLUSTER_NAME / $ECS_SERVICE_NAME"
[ "$SKIP_AGENTCORE" = false ] && echo "  AgentCore:  $RUNTIME_ARN"
echo "  Logs:       aws logs tail /super-agent/ecs-backend --region $REGION --follow"
echo "============================================="
