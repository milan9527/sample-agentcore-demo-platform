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
#   --agentcore-storage <efs|s3>  Workspace storage backend for AgentCore
#                                 (default: efs). In "efs" mode the AgentCore
#                                 runtime + ECS backend mount a shared EFS access
#                                 point at /mnt/efs and skip S3 workspace sync.
#                                 In "s3" mode the legacy S3 workspace sync path
#                                 is used and the runtime runs with PUBLIC network.
#                                 The skills S3 bucket is always used regardless.
#
# EFS mode (default) idempotently ensures these resources in the stack VPC:
#   - EFS filesystem  (Name tag: super-agent-workspaces-efs)
#   - Access point    (Name tag: super-agent-workspaces-ap, /workspaces 1000:1000 0755)
#   - NFS security group (Name tag: super-agent-efs-nfs, inbound TCP 2049)
#   - One mount target per ECS subnet AZ
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
AGENTCORE_STORAGE="efs"

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
    --agentcore-storage) AGENTCORE_STORAGE="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [ "$AGENTCORE_STORAGE" != "efs" ] && [ "$AGENTCORE_STORAGE" != "s3" ]; then
  echo "Invalid --agentcore-storage '$AGENTCORE_STORAGE' (expected 'efs' or 's3')"; exit 1
fi

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
echo "  Storage:  $AGENTCORE_STORAGE (AgentCore workspaces)"
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
  else
    mkdir -p ./industry-packs-build
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
                "awslogs-group": "/super-agent/${STACK_NAME,,}/ecs-backend",
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
    echo "  WARNING: Migration task exited with code $MIGRATE_EXIT (check logs: /super-agent/${STACK_NAME,,}/ecs-backend/migrate)"
  fi

  # --- 2d-2: Seed database and set admin password ---
  echo "  [2d-2] Seeding database..."

  # Use python to safely build the JSON overrides (avoids shell quoting/newline issues)
  SEED_OVERRIDES_FILE="/tmp/ecs-seed-overrides.json"
  DATABASE_URL_FOR_SEED="$DATABASE_URL"
  export DATABASE_URL_FOR_SEED
  python3 << 'PYEOF'
import json, os

db_url = os.environ.get("DATABASE_URL_FOR_SEED", "")

cmd = """cat > prisma.config.ts << 'HEREDOC'
import { defineConfig } from "prisma/config";
export default defineConfig({ schema: "prisma/schema.prisma", migrations: { path: "prisma/migrations" }, datasource: { url: process.env.DATABASE_URL } });
HEREDOC
npx tsx prisma/seed.ts 2>&1 || echo "(Seed skipped - may already exist)"
echo 'const b=require("bcryptjs");const{Client}=require("pg");(async()=>{const h=await b.hash("Admin1234!",10);const c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();const r=await c.query("UPDATE profiles SET password_hash=$1 WHERE username=$2",[h,"admin@example.com"]);console.log("Updated:",r.rowCount);await c.end()})()' > /app/setpw.cjs && node /app/setpw.cjs"""

overrides = {
    "containerOverrides": [{
        "name": "migrate",
        "command": ["sh", "-c", cmd],
        "environment": [{"name": "DATABASE_URL", "value": db_url}]
    }]
}
with open("/tmp/ecs-seed-overrides.json", "w") as f:
    json.dump(overrides, f)
PYEOF

  SEED_TASK_ID=$(aws ecs run-task \
    --cluster "$ECS_CLUSTER_NAME" \
    --task-definition "$MIGRATE_TASK_ARN" \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[${ECS_SUBNETS}],securityGroups=[$ECS_SG],assignPublicIp=ENABLED}" \
    --overrides "file://$SEED_OVERRIDES_FILE" \
    --region "$REGION" \
    --query "tasks[0].taskArn" --output text)
  rm -f "$SEED_OVERRIDES_FILE"
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

  # If skipping AgentCore setup, try to preserve existing AgentCore env vars from current task def
  EXISTING_AGENT_RUNTIME="claude"
  EXISTING_AGENTCORE_RUNTIME_ARN=""
  EXISTING_AGENTCORE_EXECUTION_ROLE_ARN=""
  EXISTING_AGENTCORE_BROWSER_IDENTIFIER=""
  if [ "$SKIP_AGENTCORE" = true ]; then
    EXISTING_ENV=$(aws ecs describe-task-definition \
      --task-definition "${ECS_TASK_FAMILY:-super-agent-backend}" --region "$REGION" \
      --query "taskDefinition.containerDefinitions[0].environment" --output json 2>/dev/null || echo "[]")
    EXISTING_AGENT_RUNTIME=$(echo "$EXISTING_ENV" | python3 -c "
import sys, json
env = {e['name']: e['value'] for e in json.load(sys.stdin)}
print(env.get('AGENT_RUNTIME', 'claude'))
" 2>/dev/null || echo "claude")
    EXISTING_AGENTCORE_RUNTIME_ARN=$(echo "$EXISTING_ENV" | python3 -c "
import sys, json
env = {e['name']: e['value'] for e in json.load(sys.stdin)}
print(env.get('AGENTCORE_RUNTIME_ARN', ''))
" 2>/dev/null || echo "")
    EXISTING_AGENTCORE_EXECUTION_ROLE_ARN=$(echo "$EXISTING_ENV" | python3 -c "
import sys, json
env = {e['name']: e['value'] for e in json.load(sys.stdin)}
print(env.get('AGENTCORE_EXECUTION_ROLE_ARN', ''))
" 2>/dev/null || echo "")
    EXISTING_AGENTCORE_BROWSER_IDENTIFIER=$(echo "$EXISTING_ENV" | python3 -c "
import sys, json
env = {e['name']: e['value'] for e in json.load(sys.stdin)}
print(env.get('AGENTCORE_BROWSER_IDENTIFIER', ''))
" 2>/dev/null || echo "")
    echo "  Preserving existing AGENT_RUNTIME=$EXISTING_AGENT_RUNTIME"
  fi

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
    'AGENT_RUNTIME': '$EXISTING_AGENT_RUNTIME',
    'AGENTCORE_WORKSPACE_S3_BUCKET': '$WORKSPACE_BUCKET',
    'RAG_ENABLED': 'true',
    'JWT_SECRET': '$JWT_SECRET',
}
# Preserve AgentCore vars if they existed
agentcore_arn = '$EXISTING_AGENTCORE_RUNTIME_ARN'
agentcore_role = '$EXISTING_AGENTCORE_EXECUTION_ROLE_ARN'
agentcore_browser = '$EXISTING_AGENTCORE_BROWSER_IDENTIFIER'
if agentcore_arn:
    env['AGENTCORE_RUNTIME_ARN'] = agentcore_arn
if agentcore_role:
    env['AGENTCORE_EXECUTION_ROLE_ARN'] = agentcore_role
if agentcore_browser:
    env['AGENTCORE_BROWSER_IDENTIFIER'] = agentcore_browser
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
                'awslogs-group': '/super-agent/${STACK_NAME,,}/ecs-backend',
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

  # --- 4b-efs: Ensure EFS infrastructure (EFS mode only) ---
  # EFS is ADDITIVE to S3: the skills bucket (and, in s3 mode, the workspace
  # bucket) remain in use. In efs mode we mount a shared access point at
  # /mnt/efs on both the AgentCore runtime and the ECS backend task.
  EFS_ID=""
  EFS_AP_ID=""
  EFS_AP_ARN=""
  EFS_SG=""
  EFS_STATEMENT=""
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    echo "  [4b-efs] Ensuring EFS infrastructure..."
    EFS_FS_NAME="super-agent-workspaces-efs"
    EFS_AP_NAME="super-agent-workspaces-ap"
    EFS_SG_NAME="super-agent-efs-nfs"

    # Resolve the VPC id from the first ECS subnet
    FIRST_SUBNET="${ECS_SUBNETS%%,*}"
    if [ -z "$FIRST_SUBNET" ]; then
      echo "  ERROR: EcsSubnets stack output is empty; cannot provision EFS." >&2
      exit 1
    fi
    VPC_ID=$(aws ec2 describe-subnets --subnet-ids "$FIRST_SUBNET" --region "$REGION" \
      --query "Subnets[0].VpcId" --output text)
    echo "    VPC: $VPC_ID"

    # 1) Look up (or create) the EFS filesystem by Name tag
    EFS_ID=$(aws efs describe-file-systems --region "$REGION" \
      --query "FileSystems[?Name=='$EFS_FS_NAME'].FileSystemId | [0]" --output text 2>/dev/null || echo "")
    if [ -z "$EFS_ID" ] || [ "$EFS_ID" = "None" ]; then
      echo "    Creating EFS filesystem $EFS_FS_NAME..."
      EFS_ID=$(aws efs create-file-system --region "$REGION" \
        --encrypted --performance-mode generalPurpose --throughput-mode elastic \
        --tags "Key=Name,Value=$EFS_FS_NAME" \
        --query "FileSystemId" --output text)
      echo "    Waiting for EFS $EFS_ID to become available..."
      for i in $(seq 1 30); do
        FS_STATE=$(aws efs describe-file-systems --file-system-id "$EFS_ID" --region "$REGION" \
          --query "FileSystems[0].LifeCycleState" --output text 2>/dev/null || echo "unknown")
        [ "$FS_STATE" = "available" ] && break
        echo "    Attempt $i/30 - EFS state: $FS_STATE, waiting 5s..."
        sleep 5
      done
    fi
    echo "    EFS_ID: $EFS_ID"

    # 2) Ensure NFS security group (inbound 2049 from ECS SG + itself)
    EFS_SG=$(aws ec2 describe-security-groups --region "$REGION" \
      --filters "Name=group-name,Values=$EFS_SG_NAME" "Name=vpc-id,Values=$VPC_ID" \
      --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "")
    if [ -z "$EFS_SG" ] || [ "$EFS_SG" = "None" ]; then
      echo "    Creating security group $EFS_SG_NAME..."
      EFS_SG=$(aws ec2 create-security-group --region "$REGION" \
        --group-name "$EFS_SG_NAME" --vpc-id "$VPC_ID" \
        --description "NFS 2049 for super-agent EFS workspaces" \
        --query "GroupId" --output text)
    fi
    echo "    EFS_SG: $EFS_SG"
    # Ingress from the ECS service SG (idempotent; tolerate Duplicate)
    if [ -n "$ECS_SG" ] && [ "$ECS_SG" != "None" ]; then
      aws ec2 authorize-security-group-ingress --region "$REGION" \
        --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$ECS_SG" \
        2>/dev/null || echo "    (ingress from ECS_SG already present)"
    fi
    # Ingress from itself (covers runtime ENIs that use the EFS SG)
    aws ec2 authorize-security-group-ingress --region "$REGION" \
      --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$EFS_SG" \
      2>/dev/null || echo "    (ingress from self already present)"

    # 3) Ensure one mount target per ECS subnet AZ
    IFS=',' read -ra EFS_SUBNET_ARR <<< "$ECS_SUBNETS"
    for SUBNET in "${EFS_SUBNET_ARR[@]}"; do
      [ -z "$SUBNET" ] && continue
      SUBNET_AZ=$(aws ec2 describe-subnets --subnet-ids "$SUBNET" --region "$REGION" \
        --query "Subnets[0].AvailabilityZone" --output text 2>/dev/null || echo "")
      # Is there already a mount target in this AZ?
      EXISTING_MT_AZ=$(aws efs describe-mount-targets --file-system-id "$EFS_ID" --region "$REGION" \
        --query "MountTargets[?AvailabilityZoneName=='$SUBNET_AZ'].MountTargetId | [0]" \
        --output text 2>/dev/null || echo "")
      if [ -n "$EXISTING_MT_AZ" ] && [ "$EXISTING_MT_AZ" != "None" ]; then
        echo "    Mount target already exists in $SUBNET_AZ ($EXISTING_MT_AZ)"
        continue
      fi
      echo "    Creating mount target in $SUBNET ($SUBNET_AZ)..."
      aws efs create-mount-target --file-system-id "$EFS_ID" --region "$REGION" \
        --subnet-id "$SUBNET" --security-groups "$EFS_SG" 2>/dev/null \
        || echo "    (mount target for $SUBNET_AZ already exists or conflicts; continuing)"
    done

    # 4) Ensure access point (look up by Name tag on this filesystem)
    EFS_AP_ID=$(aws efs describe-access-points --file-system-id "$EFS_ID" --region "$REGION" \
      --query "AccessPoints[?Tags[?Key=='Name' && Value=='$EFS_AP_NAME']].AccessPointId | [0]" \
      --output text 2>/dev/null || echo "")
    if [ -z "$EFS_AP_ID" ] || [ "$EFS_AP_ID" = "None" ]; then
      echo "    Creating access point $EFS_AP_NAME..."
      EFS_AP_ID=$(aws efs create-access-point --file-system-id "$EFS_ID" --region "$REGION" \
        --posix-user "Uid=1000,Gid=1000" \
        --root-directory 'Path=/workspaces,CreationInfo={OwnerUid=1000,OwnerGid=1000,Permissions=0755}' \
        --tags "Key=Name,Value=$EFS_AP_NAME" \
        --query "AccessPointId" --output text)
    fi
    EFS_AP_ARN="arn:aws:elasticfilesystem:$REGION:$ACCOUNT_ID:access-point/$EFS_AP_ID"
    echo "    EFS_AP_ID: $EFS_AP_ID"
    echo "    EFS_AP_ARN: $EFS_AP_ARN"

    # Build the extra IAM statement (leading comma so it appends cleanly).
    EFS_STATEMENT=",
        {
          \"Sid\": \"EFSMount\",
          \"Effect\": \"Allow\",
          \"Action\": [\"elasticfilesystem:ClientMount\", \"elasticfilesystem:ClientWrite\"],
          \"Resource\": \"arn:aws:elasticfilesystem:$REGION:$ACCOUNT_ID:file-system/$EFS_ID\",
          \"Condition\": { \"ArnEquals\": { \"elasticfilesystem:AccessPointArn\": \"$EFS_AP_ARN\" } }
        }"
    echo "  [4b-efs] EFS ready — EFS_ID=$EFS_ID EFS_AP_ID=$EFS_AP_ID EFS_SG=$EFS_SG"
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
          \"Resource\": [\"arn:aws:bedrock-agentcore:*:*:browser/*\", \"arn:aws:bedrock-agentcore:*:*:browser-custom/*\"]
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
        }$EFS_STATEMENT
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

  # --- 4c-2: Create AgentCore Browser with web bot auth ---
  echo "  [4c-2] Ensuring AgentCore Browser (web bot auth enabled)..."
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"
  BROWSER_NAME="${STACK_NAME}_browser_webauth"
  BROWSER_ID=$(aws bedrock-agentcore-control list-browsers --region "$REGION" \
    --query "browserSummaries[?name=='${BROWSER_NAME}'].browserId" \
    --output text 2>/dev/null || echo "")

  if [ -z "$BROWSER_ID" ] || [ "$BROWSER_ID" = "None" ]; then
    echo "  Creating new browser: $BROWSER_NAME"
    BROWSER_OUTPUT=$(aws bedrock-agentcore-control create-browser \
      --name "$BROWSER_NAME" \
      --execution-role-arn "$ROLE_ARN" \
      --network-configuration '{"networkMode":"PUBLIC"}' \
      --browser-signing '{"enabled":true}' \
      --description "Browser with web bot auth for $STACK_NAME" \
      --region "$REGION" --output json 2>&1)
    BROWSER_ID=$(echo "$BROWSER_OUTPUT" | python3 -c "import sys,json; print(json.load(sys.stdin)['browserId'])" 2>/dev/null || echo "")
    if [ -n "$BROWSER_ID" ] && [ "$BROWSER_ID" != "None" ]; then
      echo "  Browser created: $BROWSER_ID"
    else
      echo "  WARNING: Failed to create browser. Output: $BROWSER_OUTPUT"
      BROWSER_ID=""
    fi
  else
    echo "  Browser already exists: $BROWSER_ID"
  fi

  # Wait for browser to be READY
  if [ -n "$BROWSER_ID" ] && [ "$BROWSER_ID" != "None" ]; then
    echo "  Waiting for browser to be READY..."
    for i in $(seq 1 12); do
      BR_STATUS=$(aws bedrock-agentcore-control get-browser \
        --browser-id "$BROWSER_ID" --region "$REGION" \
        --query 'status' --output text 2>/dev/null || echo "UNKNOWN")
      [ "$BR_STATUS" = "READY" ] && echo "  Browser is READY." && break
      echo "  Attempt $i/12 - status: $BR_STATUS, waiting 5s..."
      sleep 5
    done
  fi
  AGENTCORE_BROWSER_ID="${BROWSER_ID:-}"
  echo "  AGENTCORE_BROWSER_ID=$AGENTCORE_BROWSER_ID"

  # --- 4d: Create or Update AgentCore Runtime ---
  echo "  [4d] Creating/updating AgentCore Runtime..."
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"

  # Build environment variables JSON
  ENV_VARS="{\"CLAUDE_CODE_USE_BEDROCK\":\"1\",\"ANTHROPIC_MODEL\":\"global.anthropic.claude-opus-4-6-v1\",\"AWS_REGION\":\"$REGION\",\"WORKSPACE_S3_REGION\":\"$REGION\""
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    # Documents intent; the container derives cwd/HOME from workspace_path in the invoke payload.
    ENV_VARS="$ENV_VARS,\"AGENT_WORKSPACE_BASE_DIR\":\"/mnt/efs\""
  fi
  if [ -n "$BEDROCK_AK" ] && [ -n "$BEDROCK_SK" ]; then
    ENV_VARS="$ENV_VARS,\"AWS_ACCESS_KEY_ID\":\"$BEDROCK_AK\",\"AWS_SECRET_ACCESS_KEY\":\"$BEDROCK_SK\""
  fi
  ENV_VARS="$ENV_VARS}"

  # Build network + filesystem configuration based on storage mode.
  # EFS mode: VPC network on the same subnets that have EFS mount targets, using
  # the EFS SG (permits 2049) plus the ECS SG, and mount the access point at /mnt/efs.
  # S3 mode: legacy PUBLIC network, no filesystem.
  FS_CONFIG_ARGS=()
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    # Convert bare "subnet-a,subnet-b" into JSON array ["subnet-a","subnet-b"]
    SUBNETS_JSON=$(IFS=','; for s in $ECS_SUBNETS; do [ -n "$s" ] && printf '"%s",' "$s"; done)
    SUBNETS_JSON="[${SUBNETS_JSON%,}]"
    RUNTIME_SG_JSON="[\"$EFS_SG\""
    if [ -n "$ECS_SG" ] && [ "$ECS_SG" != "None" ]; then
      RUNTIME_SG_JSON="$RUNTIME_SG_JSON,\"$ECS_SG\""
    fi
    RUNTIME_SG_JSON="$RUNTIME_SG_JSON]"
    NETWORK_CONFIG="{\"networkMode\":\"VPC\",\"networkModeConfig\":{\"subnets\":$SUBNETS_JSON,\"securityGroups\":$RUNTIME_SG_JSON}}"
    FS_CONFIG_ARGS=(--filesystem-configurations "[{\"efsAccessPoint\":{\"accessPointArn\":\"$EFS_AP_ARN\",\"mountPath\":\"/mnt/efs\"}}]")
  else
    NETWORK_CONFIG='{"networkMode":"PUBLIC"}'
  fi

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
      --network-configuration "$NETWORK_CONFIG" \
      "${FS_CONFIG_ARGS[@]}" \
      --environment-variables "$ENV_VARS" \
      --region "$REGION"
  else
    echo "  Creating new runtime..."
    RUNTIME_OUTPUT=$(aws bedrock-agentcore-control create-agent-runtime \
      --agent-runtime-name "${RUNTIME_NAME}" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$AGENTCORE_ECR_URI:latest\"}}" \
      --role-arn "$ROLE_ARN" \
      --network-configuration "$NETWORK_CONFIG" \
      "${FS_CONFIG_ARGS[@]}" \
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

  # In EFS mode the ECS Fargate backend also mounts the EFS access point at
  # /mnt/efs (to read/write workspaces), so its task role needs EFS perms too.
  # NOTE: the ECS task role ($ECS_TASK_ROLE_ARN) is a DIFFERENT role than the
  # AgentCore execution role ($ROLE_NAME).
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    ECS_TASK_ROLE_NAME=""
    if [ -n "$ECS_TASK_ROLE_ARN" ] && [ "$ECS_TASK_ROLE_ARN" != "None" ]; then
      ECS_TASK_ROLE_NAME="${ECS_TASK_ROLE_ARN##*/}"
    fi
    if [ -n "$ECS_TASK_ROLE_NAME" ]; then
      echo "    Attaching EFS access policy to ECS task role $ECS_TASK_ROLE_NAME..."
      aws iam put-role-policy \
        --role-name "$ECS_TASK_ROLE_NAME" \
        --policy-name "efs-workspaces-${STACK_NAME}" \
        --policy-document "{
          \"Version\": \"2012-10-17\",
          \"Statement\": [
            {
              \"Sid\": \"EFSMount\",
              \"Effect\": \"Allow\",
              \"Action\": [\"elasticfilesystem:ClientMount\", \"elasticfilesystem:ClientWrite\"],
              \"Resource\": \"arn:aws:elasticfilesystem:$REGION:$ACCOUNT_ID:file-system/$EFS_ID\",
              \"Condition\": { \"ArnEquals\": { \"elasticfilesystem:AccessPointArn\": \"$EFS_AP_ARN\" } }
            }
          ]
        }" 2>/dev/null || echo "    WARNING: could not attach EFS policy to $ECS_TASK_ROLE_NAME"
    else
      echo "    WARNING: EcsTaskRoleArn not found in stack outputs; the ECS task role"
      echo "             may need elasticfilesystem:ClientMount/ClientWrite for EFS."
    fi
  fi

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
browser_id = '$AGENTCORE_BROWSER_ID'
if browser_id:
    env['AGENTCORE_BROWSER_IDENTIFIER'] = browser_id

storage_mode = '$AGENTCORE_STORAGE'
env['AGENTCORE_STORAGE'] = storage_mode
if storage_mode == 'efs':
    env['AGENT_WORKSPACE_BASE_DIR'] = '/mnt/efs'
    # Attach a shared EFS volume + mount the access point at /mnt/efs on the backend.
    volumes = td.get('volumes', []) or []
    if not any(v.get('name') == 'efs-workspaces' for v in volumes):
        volumes.append({
            'name': 'efs-workspaces',
            'efsVolumeConfiguration': {
                'fileSystemId': '$EFS_ID',
                'transitEncryption': 'ENABLED',
                'authorizationConfig': {'accessPointId': '$EFS_AP_ID', 'iam': 'ENABLED'}
            }
        })
    td['volumes'] = volumes
    mount_points = container.get('mountPoints', []) or []
    if not any(m.get('sourceVolume') == 'efs-workspaces' for m in mount_points):
        mount_points.append({
            'sourceVolume': 'efs-workspaces',
            'containerPath': '/mnt/efs',
            'readOnly': False
        })
    container['mountPoints'] = mount_points

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
if [ "$SKIP_AGENTCORE" = false ]; then
  echo "  AgentCore:  $RUNTIME_ARN"
  echo "  Storage:    $AGENTCORE_STORAGE"
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    echo "  EFS:        ${EFS_ID:-?} / AP ${EFS_AP_ID:-?} (mounted at /mnt/efs)"
    echo "              (use --agentcore-storage s3 to fall back to S3 workspace sync)"
  fi
fi
echo "  Logs:       aws logs tail /super-agent/${STACK_NAME,,}/ecs-backend --region $REGION --follow"
echo "============================================="
