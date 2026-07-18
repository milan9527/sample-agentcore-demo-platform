#!/bin/bash
set -euo pipefail

# Disable AWS CLI pager (compatible with both v1 and v2)
export AWS_PAGER=""

# =============================================================================
# Super Agent — Full Deploy Script (CDK + CloudFront + AgentCore)
#
# Deploys the complete stack: CDK infra with CloudFront CDN (local auth),
# then sets up AgentCore Runtime (ECR, IAM, container build/push, Runtime).
#
# Prerequisites:
#   - AWS CLI v2 + SSM Session Manager plugin
#   - Docker (with buildx, ARM64 support — native on Apple Silicon)
#   - Node.js 22+
#   - An EC2 Key Pair in the target region
#
# Usage:
#   ./deploy-full.sh <SSH_KEY> [options]
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
#   --skip-backend          Skip backend build/sync
#   --agentcore-storage <efs|s3>  Workspace storage backend for AgentCore
#                                 (default: efs). In "efs" mode the AgentCore
#                                 runtime and the EC2 host mount a shared EFS
#                                 access point at /mnt/efs and skip S3 workspace
#                                 sync. In "s3" mode the legacy S3 workspace sync
#                                 path is used with a PUBLIC-network runtime.
#                                 The skills S3 bucket is always used regardless.
#
# EFS mode (default) idempotently ensures these resources in the stack VPC:
#   - EFS filesystem  (Name tag: super-agent-workspaces-efs)
#   - Access point    (Name tag: super-agent-workspaces-ap, /workspaces 1000:1000 0755)
#   - NFS security group (Name tag: super-agent-efs-nfs, inbound TCP 2049)
#   - A mount target in the EC2 instance's subnet AZ
#
# Examples:
#   # Full deploy with custom domain:
#   ./deploy-full.sh ~/my-key.pem --domain app.example.com --hosted-zone-id Z0123
#
#   # Full deploy, IP-only (no custom domain):
#   ./deploy-full.sh ~/my-key.pem
#
#   # Redeploy code only (stack + AgentCore already exist):
#   ./deploy-full.sh ~/my-key.pem --skip-cdk
#
# =============================================================================

SSH_KEY="${1:?Usage: ./deploy-full.sh <SSH_KEY_PATH> [options]}"
shift

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
ECR_URI="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/super-agent-agentcore"

echo "============================================="
echo "  Super Agent Full Deploy"
echo "  Account:  $ACCOUNT_ID"
echo "  Region:   $REGION"
echo "  Stack:    $STACK_NAME"
echo "  Storage:  $AGENTCORE_STORAGE (AgentCore workspaces)"
[ -n "$DOMAIN_NAME" ] && echo "  Domain:   $DOMAIN_NAME"
echo "============================================="

# =========================================================================
# Phase 1: CDK Deploy
# =========================================================================
if [ "$SKIP_CDK" = false ]; then
  echo ""
  echo "=== Phase 1: CDK Deploy ==="
  cd "$SCRIPT_DIR/.."

  npm install

  CDK_ARGS="-c stackName=$STACK_NAME -c enableCdn=true"
  CDK_PARAMS="--parameters KeyPairName=$(basename "$SSH_KEY" .pem)"

  if [ -n "$DOMAIN_NAME" ] && [ -n "$HOSTED_ZONE_ID" ]; then
    CDK_ARGS="$CDK_ARGS -c domainName=$DOMAIN_NAME -c hostedZoneId=$HOSTED_ZONE_ID"
  fi

  echo "  Running: npx cdk deploy $CDK_ARGS $CDK_PARAMS --region $REGION --require-approval never"
  npx cdk deploy $CDK_ARGS $CDK_PARAMS --region "$REGION" --require-approval never

  echo "  Waiting for EC2 SSM agent..."
  INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

  for i in $(seq 1 30); do
    STATUS=$(aws ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
      --region "$REGION" \
      --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null || echo "None")
    [ "$STATUS" = "Online" ] && echo "  SSM agent online." && break
    echo "  Attempt $i/30 - status: $STATUS, waiting 10s..."
    sleep 10
  done

  # Wait for UserData bootstrap to complete (fetch-db-url.sh is created at the end)
  echo "  Waiting for EC2 UserData bootstrap to complete..."
  for i in $(seq 1 60); do
    BOOTSTRAP_CHECK=$(aws ssm send-command \
      --instance-ids "$INSTANCE_ID" --region "$REGION" \
      --document-name AWS-RunShellScript \
      --parameters 'commands=["test -f /opt/super-agent/fetch-db-url.sh && echo READY || echo WAITING"]' \
      --output text --query "Command.CommandId" 2>/dev/null || echo "")
    if [ -n "$BOOTSTRAP_CHECK" ]; then
      sleep 5
      RESULT=$(aws ssm get-command-invocation \
        --command-id "$BOOTSTRAP_CHECK" --instance-id "$INSTANCE_ID" \
        --region "$REGION" --query "StandardOutputContent" --output text 2>/dev/null || echo "WAITING")
      if echo "$RESULT" | grep -q "READY"; then
        echo "  EC2 bootstrap complete."
        break
      fi
    fi
    echo "  Attempt $i/60 - bootstrap still running, waiting 10s..."
    sleep 10
  done
else
  echo ""
  echo "=== Phase 1: CDK Deploy (skipped) ==="
fi

# =========================================================================
# Fix CloudFront EC2 origin (replace placeholder with actual EC2 public DNS)
# =========================================================================
if [ -n "$DOMAIN_NAME" ]; then
  CF_DIST_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDistributionId'].OutputValue" --output text 2>/dev/null || echo "")
  if [ -n "$CF_DIST_ID" ] && [ "$CF_DIST_ID" != "None" ]; then
    INSTANCE_ID_FOR_DNS=$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
    EC2_PUBLIC_DNS=$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID_FOR_DNS" --region "$REGION" \
      --query "Reservations[0].Instances[0].PublicDnsName" --output text 2>/dev/null || echo "")
    if [ -n "$EC2_PUBLIC_DNS" ] && [ "$EC2_PUBLIC_DNS" != "None" ]; then
      # Check if origin still has placeholder
      CURRENT_ORIGINS=$(aws cloudfront get-distribution-config --id "$CF_DIST_ID" \
        --query "DistributionConfig.Origins.Items[*].DomainName" --output text 2>/dev/null || echo "")
      if echo "$CURRENT_ORIGINS" | grep -q "ec2-placeholder"; then
        echo ""
        echo "=== Updating CloudFront EC2 origin → $EC2_PUBLIC_DNS ==="
        CF_ETAG=$(aws cloudfront get-distribution-config --id "$CF_DIST_ID" --query "ETag" --output text)
        aws cloudfront get-distribution-config --id "$CF_DIST_ID" --output json | \
          python3 -c "
import sys, json
data = json.load(sys.stdin)
config = data['DistributionConfig']
for origin in config['Origins']['Items']:
    if 'ec2-placeholder' in origin['DomainName']:
        origin['DomainName'] = '$EC2_PUBLIC_DNS'
json.dump(config, open('/tmp/cf-origin-fix.json', 'w'))
"
        aws cloudfront update-distribution --id "$CF_DIST_ID" --if-match "$CF_ETAG" \
          --distribution-config file:///tmp/cf-origin-fix.json \
          --query "Distribution.Status" --output text 2>/dev/null || true
        rm -f /tmp/cf-origin-fix.json
        echo "  CloudFront origin updated."
      fi
    fi
  fi
fi

# =========================================================================
# Phase 2: Run existing deploy.sh for .env + frontend + backend
# =========================================================================
echo ""
echo "=== Phase 2: Code Deploy (deploy.sh) ==="

DEPLOY_ARGS="$SSH_KEY --stack $STACK_NAME --region $REGION"
[ "$SKIP_FRONTEND" = true ] && DEPLOY_ARGS="$DEPLOY_ARGS --skip-frontend"
[ "$SKIP_BACKEND" = true ] && DEPLOY_ARGS="$DEPLOY_ARGS --skip-backend"

"$SCRIPT_DIR/deploy.sh" $DEPLOY_ARGS

# =========================================================================
# Phase 3: AgentCore Setup
# =========================================================================
if [ "$SKIP_AGENTCORE" = false ]; then
  echo ""
  echo "=== Phase 3: AgentCore Setup ==="

  # --- 3a: ECR Repository ---
  echo "  [3a] Ensuring ECR repository..."
  aws ecr describe-repositories --repository-names super-agent-agentcore --region "$REGION" 2>/dev/null \
    || aws ecr create-repository --repository-name super-agent-agentcore --region "$REGION"
  echo "  ECR: $ECR_URI"

  # --- 3b: IAM Execution Role ---
  # Role and policy names are scoped by stack name to avoid conflicts
  # when multiple stacks share the same AWS account.
  echo "  [3b] Ensuring IAM execution role..."
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
  # Read the actual workspace bucket name from stack outputs (matches CDK: super-agent-workspace-<account>)
  WORKSPACE_BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='WorkspaceBucketName'].OutputValue" --output text 2>/dev/null || echo "super-agent-workspace-$ACCOUNT_ID")
  SKILLS_BUCKET_NAME=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='SkillsBucketName'].OutputValue" --output text 2>/dev/null || echo "")

  # --- 3b-efs: Ensure EFS infrastructure (EFS mode only) ---
  # EFS is ADDITIVE to S3: the skills bucket (and, in s3 mode, the workspace
  # bucket) remain in use. In efs mode we mount a shared access point at
  # /mnt/efs on both the AgentCore runtime and the EC2 host.
  EFS_ID=""
  EFS_AP_ID=""
  EFS_AP_ARN=""
  EFS_SG=""
  EFS_STATEMENT=""
  EC2_SUBNET_ID=""
  EC2_SG_ID=""
  EC2_VPC_ID=""
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    echo "  [3b-efs] Ensuring EFS infrastructure..."
    EFS_FS_NAME="super-agent-workspaces-efs"
    EFS_AP_NAME="super-agent-workspaces-ap"
    EFS_SG_NAME="super-agent-efs-nfs"

    # Resolve the EC2 instance's VPC / subnet / security group
    EFS_INSTANCE_ID=$(aws cloudformation describe-stacks \
      --stack-name "$STACK_NAME" --region "$REGION" \
      --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
    read -r EC2_VPC_ID EC2_SUBNET_ID EC2_SG_ID <<< "$(aws ec2 describe-instances \
      --instance-ids "$EFS_INSTANCE_ID" --region "$REGION" \
      --query "Reservations[0].Instances[0].[VpcId,SubnetId,SecurityGroups[0].GroupId]" \
      --output text)"
    echo "    VPC: $EC2_VPC_ID  Subnet: $EC2_SUBNET_ID  InstanceSG: $EC2_SG_ID"

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

    # 2) Ensure NFS security group (inbound 2049 from the instance SG + itself)
    EFS_SG=$(aws ec2 describe-security-groups --region "$REGION" \
      --filters "Name=group-name,Values=$EFS_SG_NAME" "Name=vpc-id,Values=$EC2_VPC_ID" \
      --query "SecurityGroups[0].GroupId" --output text 2>/dev/null || echo "")
    if [ -z "$EFS_SG" ] || [ "$EFS_SG" = "None" ]; then
      echo "    Creating security group $EFS_SG_NAME..."
      EFS_SG=$(aws ec2 create-security-group --region "$REGION" \
        --group-name "$EFS_SG_NAME" --vpc-id "$EC2_VPC_ID" \
        --description "NFS 2049 for super-agent EFS workspaces" \
        --query "GroupId" --output text)
    fi
    echo "    EFS_SG: $EFS_SG"
    if [ -n "$EC2_SG_ID" ] && [ "$EC2_SG_ID" != "None" ]; then
      aws ec2 authorize-security-group-ingress --region "$REGION" \
        --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$EC2_SG_ID" \
        2>/dev/null || echo "    (ingress from instance SG already present)"
    fi
    aws ec2 authorize-security-group-ingress --region "$REGION" \
      --group-id "$EFS_SG" --protocol tcp --port 2049 --source-group "$EFS_SG" \
      2>/dev/null || echo "    (ingress from self already present)"

    # 3) Ensure a mount target in the instance's subnet AZ
    EC2_SUBNET_AZ=$(aws ec2 describe-subnets --subnet-ids "$EC2_SUBNET_ID" --region "$REGION" \
      --query "Subnets[0].AvailabilityZone" --output text 2>/dev/null || echo "")
    EXISTING_MT_AZ=$(aws efs describe-mount-targets --file-system-id "$EFS_ID" --region "$REGION" \
      --query "MountTargets[?AvailabilityZoneName=='$EC2_SUBNET_AZ'].MountTargetId | [0]" \
      --output text 2>/dev/null || echo "")
    if [ -n "$EXISTING_MT_AZ" ] && [ "$EXISTING_MT_AZ" != "None" ]; then
      echo "    Mount target already exists in $EC2_SUBNET_AZ ($EXISTING_MT_AZ)"
    else
      echo "    Creating mount target in $EC2_SUBNET_ID ($EC2_SUBNET_AZ)..."
      aws efs create-mount-target --file-system-id "$EFS_ID" --region "$REGION" \
        --subnet-id "$EC2_SUBNET_ID" --security-groups "$EFS_SG" 2>/dev/null \
        || echo "    (mount target for $EC2_SUBNET_AZ already exists or conflicts; continuing)"
    fi

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
    echo "  [3b-efs] EFS ready — EFS_ID=$EFS_ID EFS_AP_ID=$EFS_AP_ID EFS_SG=$EFS_SG"
  fi

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
        }$EFS_STATEMENT
      ]
    }"

  # --- 3c: Build + Push Docker Image ---
  echo "  [3c] Building and pushing AgentCore container..."
  aws ecr get-login-password --region "$REGION" | \
    docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"

  cd "$PROJECT_ROOT/agentcore"
  docker buildx build --platform linux/arm64 \
    -t "super-agent-agentcore:latest" \
    -t "$ECR_URI:latest" \
    --load .
  docker push "$ECR_URI:latest"
  echo "  Image pushed: $ECR_URI:latest"

  # --- 3d: Create or Update AgentCore Runtime ---
  echo "  [3d] Creating/updating AgentCore Runtime..."
  ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/$ROLE_NAME"

  # Build environment variables JSON
  ENV_VARS="{\"CLAUDE_CODE_USE_BEDROCK\":\"1\",\"ANTHROPIC_MODEL\":\"us.anthropic.claude-opus-4-6-v1\",\"AWS_REGION\":\"$REGION\",\"WORKSPACE_S3_REGION\":\"$REGION\""
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    # Documents intent; the container derives cwd/HOME from workspace_path in the invoke payload.
    ENV_VARS="$ENV_VARS,\"AGENT_WORKSPACE_BASE_DIR\":\"/mnt/efs\""
  fi
  if [ -n "$BEDROCK_AK" ] && [ -n "$BEDROCK_SK" ]; then
    ENV_VARS="$ENV_VARS,\"AWS_ACCESS_KEY_ID\":\"$BEDROCK_AK\",\"AWS_SECRET_ACCESS_KEY\":\"$BEDROCK_SK\""
  fi
  ENV_VARS="$ENV_VARS}"

  # Build network + filesystem configuration based on storage mode.
  # EFS mode: VPC network on the instance subnet (which has an EFS mount target),
  # using the EFS SG (permits 2049) plus the instance SG, and mount the access
  # point at /mnt/efs. S3 mode: legacy PUBLIC network, no filesystem.
  FS_CONFIG_ARGS=()
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    RUNTIME_SG_JSON="[\"$EFS_SG\""
    if [ -n "$EC2_SG_ID" ] && [ "$EC2_SG_ID" != "None" ]; then
      RUNTIME_SG_JSON="$RUNTIME_SG_JSON,\"$EC2_SG_ID\""
    fi
    RUNTIME_SG_JSON="$RUNTIME_SG_JSON]"
    NETWORK_CONFIG="{\"networkMode\":\"VPC\",\"networkModeConfig\":{\"subnets\":[\"$EC2_SUBNET_ID\"],\"securityGroups\":$RUNTIME_SG_JSON}}"
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
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$ECR_URI:latest\"}}" \
      --role-arn "$ROLE_ARN" \
      --network-configuration "$NETWORK_CONFIG" \
      "${FS_CONFIG_ARGS[@]}" \
      --environment-variables "$ENV_VARS" \
      --region "$REGION"
  else
    echo "  Creating new runtime..."
    RUNTIME_OUTPUT=$(aws bedrock-agentcore-control create-agent-runtime \
      --agent-runtime-name "${RUNTIME_NAME}" \
      --agent-runtime-artifact "{\"containerConfiguration\":{\"containerUri\":\"$ECR_URI:latest\"}}" \
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

  # --- 3e: Update EC2 .env to enable AgentCore ---
  echo "  [3e] Enabling AgentCore mode on EC2..."
  INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)

  # Storage-mode specific SSM command lines (each a JSON string, comma-prefixed).
  # In EFS mode: install amazon-efs-utils, mount the access point at /mnt/efs
  # (idempotent via fstab + mountpoint check), and set the EFS env vars.
  # In S3 mode: just record AGENTCORE_STORAGE=s3 (legacy S3 workspace sync).
  STORAGE_SSM_LINES=""
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    STORAGE_SSM_LINES="
      \"(command -v mount.efs >/dev/null 2>&1 || (yum install -y amazon-efs-utils || dnf install -y amazon-efs-utils))\",
      \"mkdir -p /mnt/efs\",
      \"grep -q '^$EFS_ID:/ /mnt/efs ' /etc/fstab || echo '$EFS_ID:/ /mnt/efs efs _netdev,tls,accesspoint=$EFS_AP_ID 0 0' >> /etc/fstab\",
      \"mountpoint -q /mnt/efs || mount -t efs -o tls,accesspoint=$EFS_AP_ID $EFS_ID:/ /mnt/efs\",
      \"grep -q '^AGENTCORE_STORAGE=' /opt/super-agent/.env && sed -i 's|^AGENTCORE_STORAGE=.*|AGENTCORE_STORAGE=efs|' /opt/super-agent/.env || echo 'AGENTCORE_STORAGE=efs' >> /opt/super-agent/.env\",
      \"grep -q '^AGENT_WORKSPACE_BASE_DIR=' /opt/super-agent/.env && sed -i 's|^AGENT_WORKSPACE_BASE_DIR=.*|AGENT_WORKSPACE_BASE_DIR=/mnt/efs|' /opt/super-agent/.env || echo 'AGENT_WORKSPACE_BASE_DIR=/mnt/efs' >> /opt/super-agent/.env\","
  else
    STORAGE_SSM_LINES="
      \"grep -q '^AGENTCORE_STORAGE=' /opt/super-agent/.env && sed -i 's|^AGENTCORE_STORAGE=.*|AGENTCORE_STORAGE=s3|' /opt/super-agent/.env || echo 'AGENTCORE_STORAGE=s3' >> /opt/super-agent/.env\","
  fi

  aws ssm send-command \
    --instance-ids "$INSTANCE_ID" \
    --region "$REGION" \
    --document-name AWS-RunShellScript \
    --parameters "commands=[
      \"sed -i 's/^AGENT_RUNTIME=.*/AGENT_RUNTIME=agentcore/' /opt/super-agent/.env\",
      \"grep -q '^AGENTCORE_RUNTIME_ARN=' /opt/super-agent/.env && sed -i 's|^AGENTCORE_RUNTIME_ARN=.*|AGENTCORE_RUNTIME_ARN=$RUNTIME_ARN|' /opt/super-agent/.env || echo 'AGENTCORE_RUNTIME_ARN=$RUNTIME_ARN' >> /opt/super-agent/.env\",
      \"grep -q '^AGENTCORE_EXECUTION_ROLE_ARN=' /opt/super-agent/.env && sed -i 's|^AGENTCORE_EXECUTION_ROLE_ARN=.*|AGENTCORE_EXECUTION_ROLE_ARN=$ROLE_ARN|' /opt/super-agent/.env || echo 'AGENTCORE_EXECUTION_ROLE_ARN=$ROLE_ARN' >> /opt/super-agent/.env\",
      \"grep -q '^AGENTCORE_WORKSPACE_S3_BUCKET=' /opt/super-agent/.env && sed -i 's|^AGENTCORE_WORKSPACE_S3_BUCKET=.*|AGENTCORE_WORKSPACE_S3_BUCKET=$WORKSPACE_BUCKET_NAME|' /opt/super-agent/.env || echo 'AGENTCORE_WORKSPACE_S3_BUCKET=$WORKSPACE_BUCKET_NAME' >> /opt/super-agent/.env\",$STORAGE_SSM_LINES
      \"systemctl restart backend\",
      \"sleep 2\",
      \"systemctl status backend --no-pager -l\"
    ]" \
    --output json --query "Command.CommandId" 2>/dev/null

  echo "  AgentCore mode enabled ($AGENTCORE_STORAGE storage). Backend restarting..."
  sleep 5

else
  echo ""
  echo "=== Phase 3: AgentCore Setup (skipped) ==="
fi

# =========================================================================
# Done
# =========================================================================
echo ""
echo "============================================="
echo "  Full Deployment Complete!"
echo "============================================="
INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text 2>/dev/null || echo "")
PUBLIC_IP=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='PublicIP'].OutputValue" --output text 2>/dev/null || echo "")
if [ -n "$DOMAIN_NAME" ]; then
  echo "  App URL:    https://$DOMAIN_NAME"
else
  echo "  App URL:    https://$PUBLIC_IP"
fi
echo "  Instance:   $INSTANCE_ID"
if [ "$SKIP_AGENTCORE" = false ]; then
  echo "  AgentCore:  $RUNTIME_ARN"
  echo "  Storage:    $AGENTCORE_STORAGE"
  if [ "$AGENTCORE_STORAGE" = "efs" ]; then
    echo "  EFS:        ${EFS_ID:-?} / AP ${EFS_AP_ID:-?} (mounted at /mnt/efs)"
    echo "              (use --agentcore-storage s3 to fall back to S3 workspace sync)"
  fi
fi
echo "  SSM:        aws ssm start-session --target $INSTANCE_ID --region $REGION"
echo "============================================="
