# Super Agent Infra — 部署指南

## 概述

本项目提供三种部署方式：

- **ECS 一键部署**（推荐）：`deploy-full-ecs.sh` 使用 ECS Fargate 运行后端，无需 SSH/EC2，约 15-20 分钟
- **EC2 一键部署**：`deploy-full.sh` 使用 EC2 实例运行后端，需要 SSH Key，约 20-30 分钟
- **分步部署**：手动执行 CDK、`deploy.sh`、AgentCore 各阶段

### 架构（ECS 模式）

```
用户 → CloudFront → S3 (前端静态文件)
                  → ALB → ECS Fargate (API /api/*, WebSocket /ws/*)
                              → Node.js 后端 (port 3000)
                              → RDS PostgreSQL
                              → ElastiCache Redis
                              → EFS (/mnt/efs 共享工作区，与 AgentCore 同挂)
                              → Bedrock AgentCore Runtime (容器化 Agent，private-NAT 子网)
```

### 架构（EC2 模式）

```
用户 → CloudFront → S3 (前端静态文件)
                  → EC2 Nginx (API /api/*, WebSocket /ws/*)
                       → Node.js 后端 (port 3000)
                       → RDS PostgreSQL
                       → ElastiCache Redis
                       → Bedrock AgentCore Runtime (容器化 Agent)
```

## 前置条件

| 工具 | 用途 | ECS 模式 | EC2 模式 |
|------|------|:--------:|:--------:|
| AWS CLI **≥ 2.36** | 基础设施操作（EFS 模式的 `--filesystem-configurations` 需要 2.36+）| ✅ | ✅ |
| Node.js 22+ | 前端构建 | ✅ | ✅ |
| Docker (buildx, ARM64) | 后端 + AgentCore 容器构建 | ✅ | ✅ |
| SSM Session Manager 插件 | SSH 隧道 | — | ✅ |
| EC2 Key Pair | SSH 访问 | — | ✅ |

确认 AWS 身份：

```bash
aws sts get-caller-identity
```

## ECS 一键部署（推荐）

ECS 模式使用 Fargate 运行后端容器，无需管理 EC2 实例、SSH Key 或 Nginx。

### 带自定义域名（CloudFront CDN）

需要 Route53 托管的域名。查找 hosted zone ID：

```bash
aws route53 list-hosted-zones --query "HostedZones[].{Name:Name,Id:Id}" --output table
```

执行部署：

```bash
cd /path/to/super-agent

./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd \
  --region ap-northeast-1 \
  --domain app.example.com \
  --hosted-zone-id Z01234567890ABC
```

### 无域名部署（CloudFront 默认域名）

省略 `--domain`/`--hosted-zone-id`，应用会挂在自动生成的 `*.cloudfront.net` 域名上
（不创建 Route53/ACM，CloudFront 把 `/api/*`、`/ws/*` 反代到 ALB）。部署结束会打印访问 URL。

```bash
./infra/scripts/deploy-full-ecs.sh --stack SuperAgentDev --region us-east-1
```

### 可选参数

```bash
--stack <name>          # Stack 名称（默认 SuperAgent），不同 stack 完全隔离
--region <region>       # AWS Region（默认 us-west-2）
--domain <domain>       # 可选自定义域名（需配合 --hosted-zone-id）；省略则用 CloudFront 默认域名
--hosted-zone-id <id>   # Route53 Hosted Zone ID（仅配合 --domain）
--vpc-id <id>           # 导入已有 VPC（默认新建专属 VPC）
--use-default-vpc       # 使用账号默认 VPC（默认新建专属 VPC）
--agentcore-storage <efs|s3>  # AgentCore 工作区存储（默认 efs）
--bedrock-ak <key>      # 跨账号 Bedrock 凭证（可选）
--bedrock-sk <secret>   # 跨账号 Bedrock 凭证（可选）
--skip-cdk              # 跳过基础设施（已有 stack 时用）
--skip-agentcore        # 跳过 AgentCore 容器部署
--skip-frontend         # 跳过前端构建
--skip-backend          # 跳过后端构建
```

> **VPC**：默认**新建专属 VPC**（10.20.0.0/16，跨 AZ 的 public + private-NAT 子网，锁定在
> AgentCore 支持的 AZ；us-east-1 = us-east-1a/b/c）。AgentCore Runtime 跑在 private 子网
> （需 NAT 出口，无公网 IP），EFS 挂载目标也在 private 子网。用 `--vpc-id` 或
> `--use-default-vpc` 覆盖。

### ECS 部署流程（4 个阶段）

**Phase 1: CDK Deploy**
- （默认）新建专属 VPC：跨 AZ 的 public + private-NAT 子网 + NAT 网关（默认 1 个，`-c natGateways=<n>` 可调）
- Security Groups、ECS Cluster、ALB
- RDS PostgreSQL 16.9、ElastiCache Redis 7.1
- S3 桶（Avatar、Skills、Workspace、Frontend）
- **EFS**（文件系统 + access point `/workspaces` uid/gid 1000 + private 子网内的挂载目标 + NFS 安全组）
- CloudFront（默认域名，或配合 `--domain` 时加 ACM 证书 + Route53 ALIAS）
- IAM Roles（ECS Task Execution + Task Role，含 Bedrock Invoke/List、EFS、S3 权限）
- ECS Service（初始 desiredCount=0，等待真实镜像）

**Phase 2: Backend Deploy**
- 构建后端 Docker 镜像（ARM64，含 LibreOffice + CJK 字体用于文档转 PDF）→ 推送到 ECR
- 从 SecretsManager 获取 RDS 凭证
- 通过 ECS run-task 执行 Prisma 迁移 + `seed.ts`（org / admin / 5 业务域 / 7 agent / model_providers）+ `seed-showcase-from-packs.ts`（行业大赏 showcase 数据）
- 注册 ECS Task Definition（含所有环境变量；JWT_SECRET 跨部署复用，不会登出用户）
- 更新 ECS Service → 等待服务稳定
- 首次部署自动创建 admin 用户：`admin@example.com` / `Admin1234!`

**Phase 3: Frontend Deploy**
- 构建前端（Vite）→ S3 sync + CloudFront 失效

**Phase 4: AgentCore Setup**
- 创建 ECR 仓库，构建推送 AgentCore ARM64 Docker 镜像
- 创建 IAM Execution Role（Bedrock、S3、ECR、Browser、Code Interpreter、EFS 权限）
- 创建/确保 AgentCore Browser（web-bot-auth，非致命：失败也不阻断部署）
- 创建 Bedrock AgentCore Runtime（EFS 模式：VPC 网络用 private-NAT 子网 + 挂载 EFS access point 到 `/mnt/efs`；默认模型 `us.anthropic.claude-opus-4-8` + `CLAUDE_CODE_DISABLE_THINKING=1`）
- 更新 ECS Task Definition 启用 AgentCore 模式

### ECS 部署完成后

访问脚本结尾打印的 URL（自定义域名，或 `https://xxxx.cloudfront.net`），使用
`admin@example.com` / `Admin1234!` 登录。

查看后端日志（日志组以 stack 名为前缀）：

```bash
aws logs tail /super-agent/<stack-lowercase>/ecs-backend --region <region> --follow
```

> **重要**：首次登录后请立即修改 admin 密码。

### ECS 增量部署

```bash
# 只部署代码（跳过 CDK 和 AgentCore）
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore

# 只更新后端
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore --skip-frontend

# 只更新前端
./infra/scripts/deploy-full-ecs.sh \
  --stack SuperAgentProd --skip-cdk --skip-agentcore --skip-backend
```

---

## EC2 一键部署

### 带自定义域名（CloudFront CDN）

需要 Route53 托管的域名和 EC2 Key Pair：

```bash
aws ec2 describe-key-pairs --query "KeyPairs[].KeyName" --region us-west-2
```

执行部署：

```bash
cd /path/to/super-agent

./infra/scripts/deploy-full.sh ~/Downloads/my-key.pem \
  --stack SuperAgentProd \
  --region us-west-2 \
  --domain app.example.com \
  --hosted-zone-id Z01234567890ABC
```

### EC2 可选参数

```bash
--stack <name>          # Stack 名称（默认 SuperAgent），不同 stack 完全隔离
--region <region>       # AWS Region（默认 us-west-2）
--bedrock-ak <key>      # 跨账号 Bedrock 凭证（可选）
--bedrock-sk <secret>   # 跨账号 Bedrock 凭证（可选）
--skip-cdk              # 跳过基础设施（已有 stack 时用）
--skip-agentcore        # 跳过 AgentCore 容器部署
--skip-frontend         # 跳过前端构建
--skip-backend          # 跳过后端构建
```

### EC2 部署流程（3 个阶段）

**Phase 1: CDK Deploy**
- 创建 VPC Security Groups、EC2 (t4g.small ARM64)、EIP
- RDS PostgreSQL 16.9、ElastiCache Redis 7.1
- S3 桶（Avatar、Skills、Workspace、Frontend）
- CloudFront + ACM 证书 + Route53 ALIAS
- IAM Role（EC2 + AgentCore）
- 等待 EC2 UserData 完成（安装 Node.js、Nginx、PostgreSQL client 等）

**Phase 2: Code Deploy**（调用 `deploy.sh`）
- 从 SecretsManager 获取 RDS 凭证，生成 `.env`
- 构建前端（Vite）→ rsync 到 EC2 + S3 sync + CloudFront 失效
- 编译后端（tsc）→ rsync 到 EC2 → npm ci → prisma migrate → seed → 重启
- 首次部署自动创建 admin 用户：`admin@example.com` / `Admin1234!`

**Phase 3: AgentCore Setup**
- 创建 ECR 仓库，构建推送 ARM64 Docker 镜像
- 创建 IAM Execution Role（Bedrock、S3、ECR、Browser、Code Interpreter 权限）
- 创建 Bedrock AgentCore Runtime
- 更新 EC2 `.env` 启用 AgentCore 模式

### EC2 部署完成后

访问 `https://app.example.com`，使用 `admin@example.com` / `Admin1234!` 登录。

> **重要**：首次登录后请立即修改 admin 密码。

## 增量部署

全量部署完成后，日常代码更新不需要重建基础设施：

```bash
# 只部署代码（跳过 CDK 和 AgentCore）
./infra/scripts/deploy-full.sh ~/Downloads/my-key.pem \
  --stack SuperAgentProd --skip-cdk --skip-agentcore

# 或直接用 deploy.sh
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd

# 只更新前端
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd --skip-backend

# 只更新后端
./infra/scripts/deploy.sh ~/Downloads/my-key.pem --stack SuperAgentProd --skip-frontend
```

## 多环境隔离

每个 `--stack` 名称创建完全独立的资源（EC2、RDS、Redis、S3、CloudFront）：

```bash
# 生产环境
./infra/scripts/deploy-full.sh ~/key.pem --stack SuperAgentProd --domain app.example.com --hosted-zone-id Z0XXX

# 测试环境
./infra/scripts/deploy-full.sh ~/key.pem --stack SuperAgentTest --domain test.example.com --hosted-zone-id Z0XXX
```

S3 桶名、SecretsManager secret 名、ElastiCache 集群名都以 stack 名为前缀，不会冲突。

## CI/CD（GitHub Actions）

项目包含 `.github/workflows/deploy-test.yml`，push 到 main 自动部署测试环境。

### 配置 GitHub Secrets

```bash
./infra/scripts/setup-github-secrets.sh ~/Downloads/my-key.pem --repo owner/repo
```

自动配置：`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`、`EC2_KEY_PAIR_NAME`、`EC2_SSH_PRIVATE_KEY`。

另需手动添加（如使用 CDN）：`TEST_DOMAIN_NAME`、`TEST_HOSTED_ZONE_ID`。

### Pipeline 流程

1. **Build & Test** — 编译前后端 + 运行测试
2. **CDK Deploy** — 部署/更新测试 Stack（`SuperAgentTest`）
3. **Deploy Application** — 通过 SSM 部署代码到 EC2
4. **Smoke Test** — 健康检查 + 前端可达性验证

## LiteLLM 模型网关（可选）

部署完成后，如需接入第三方模型（Kimi K2.5、GLM 5.1 等），SSH 到 EC2 执行：

```bash
sudo bash /path/to/infra/scripts/setup-litellm.sh
```

然后编辑 `/opt/litellm/.env` 填入 API Key，重启 `sudo systemctl restart litellm`。

访问 `https://your-domain/modelservice/ui/` 管理模型。

## 运维

### 查看日志

**ECS 模式：**

```bash
# CloudWatch Logs（推荐；日志组以 stack 名为前缀）
aws logs tail /super-agent/<stack-lowercase>/ecs-backend --region <region> --follow

# 或通过 ECS Exec 进入容器
TASK_ARN=$(aws ecs list-tasks --cluster <cluster-name> --service-name <service-name> --region <region> --query "taskArns[0]" --output text)
aws ecs execute-command --cluster <cluster-name> --task $TASK_ARN --container backend --interactive --command "/bin/sh" --region <region>
```

**EC2 模式：**

```bash
# 通过 SSM 连接
aws ssm start-session --target <InstanceId> --region us-west-2

# 后端日志
tail -f /opt/super-agent/logs/backend.log
tail -f /opt/super-agent/logs/backend-error.log

# Nginx 日志
tail -f /var/log/nginx/access.log
tail -f /var/log/nginx/error.log
```

日志也会自动推送到 CloudWatch Logs（`/super-agent/backend`、`/super-agent/nginx-*`）。

### 重启服务

**ECS 模式：**

```bash
# 强制新部署（拉取最新镜像）
aws ecs update-service --cluster <cluster-name> --service <service-name> --force-new-deployment --region <region>

# 等待稳定
aws ecs wait services-stable --cluster <cluster-name> --services <service-name> --region <region>
```

**EC2 模式：**

```bash
sudo systemctl restart backend
sudo systemctl status backend
```

### 环境变量

**ECS 模式：** 环境变量在 ECS Task Definition 中管理。更新方式：

```bash
# 重新运行 deploy 脚本（会注册新 task definition 并更新 service）
./infra/scripts/deploy-full-ecs.sh --stack <StackName> --skip-cdk --skip-frontend
```

**EC2 模式：** 生产环境变量在 `/opt/super-agent/.env`（systemd EnvironmentFile）。
`deploy.sh` 的合并策略是"已有值不覆盖"，手动添加的变量不会被后续部署覆盖。

### AgentCore ↔ Claude 模式切换

```bash
# 切换到 Claude 模式（EC2 子进程）
sed -i 's/^AGENT_RUNTIME=agentcore/AGENT_RUNTIME=claude/' /opt/super-agent/.env
sudo systemctl restart backend

# 切回 AgentCore 模式
sed -i 's/^AGENT_RUNTIME=claude/AGENT_RUNTIME=agentcore/' /opt/super-agent/.env
sudo systemctl restart backend
```

### 更新 AgentCore 容器

```bash
cd agentcore
docker buildx build --platform linux/arm64 \
  -t <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/super-agent-agentcore:latest \
  --load .
docker push <ACCOUNT_ID>.dkr.ecr.<REGION>.amazonaws.com/super-agent-agentcore:latest

# 通知 AgentCore 拉取新镜像（⚠️ --environment-variables 是全量替换，必须传完整；
# EFS 模式下还必须带 --network-configuration 的 VPC/子网 与 --filesystem-configurations，
# 否则会退化成 PUBLIC 且丢失 EFS 挂载。最省事是直接重跑 deploy 脚本的 Phase 4。）
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <runtime-id> \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<ECR_URI>:latest"}}' \
  --role-arn "arn:aws:iam::<ACCOUNT_ID>:role/super-agent-agentcore-role-<StackName>" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --environment-variables '{"CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_DISABLE_THINKING":"1","ANTHROPIC_MODEL":"us.anthropic.claude-opus-4-8","AWS_REGION":"<REGION>","WORKSPACE_S3_REGION":"<REGION>"}' \
  --region <REGION>
```

> **模型 ID 注意事项**：
> - 默认使用 `us.anthropic.claude-opus-4-8`（配合 `CLAUDE_CODE_DISABLE_THINKING=1`，否则 CLI 发送的 `thinking.type.enabled` 会被 Opus 拒绝导致 agent 退出）
> - 也可用 `global.anthropic.*` inference profile；用 `aws bedrock list-inference-profiles --region <region>` 查看当前区域支持的 profile
> - Seed 会把 Bedrock provider 的 `default_model_id` 设为同一模型，后端每次调用都会显式带上

## AgentCore 存储模式（本地文件 / S3 / EFS）

Agent 工作区（项目文件、会话、`.claude` 配置、skill、产出物）的存储由 `AGENT_RUNTIME`
和 `AGENTCORE_STORAGE` 两个环境变量共同决定：

| 场景 | AGENT_RUNTIME | AGENTCORE_STORAGE | AGENT_WORKSPACE_BASE_DIR | 说明 |
|------|---------------|-------------------|--------------------------|------|
| **本地开发** | `claude` | `s3`（或不设）| `/tmp/workspaces` | Agent 跑在后端本机子进程，工作区就是本地目录，**不走 S3、不走 EFS** |
| **AgentCore + S3** | `agentcore` | `s3` | `/tmp/workspaces` | 后端本地构建工作区 → 上传 S3 → 容器下载到 `/workspace` → 回传 S3 |
| **AgentCore + EFS**（推荐）| `agentcore` | `efs` | `/mnt/efs` | 后端与容器共享挂载同一 EFS，直接读写、**无 S3 往返**；按 `/mnt/efs/{org}/{userId}/{scope}/sessions/{session}` 每用户隔离 |

> `deploy-full-ecs.sh` / `deploy-full.sh` **默认使用 EFS**；用 `--agentcore-storage s3`
> 回退到 S3 模式。`AGENTCORE_STORAGE` 只影响 `agentcore` 运行时；`claude` 运行时始终用本地文件。

### 切换到本地文件（本地开发）

```bash
# backend/.env
AGENT_RUNTIME=claude
AGENT_WORKSPACE_BASE_DIR=/tmp/workspaces
# AGENTCORE_STORAGE 可删除或设为 s3（claude 模式下忽略此项）
```

### 切换 AgentCore 的 S3 ↔ EFS

**改后端 `.env`（本地或 EC2 `/opt/super-agent/.env`）：**

```bash
# → EFS 模式
sed -i 's/^AGENTCORE_STORAGE=.*/AGENTCORE_STORAGE=efs/' .env
sed -i 's#^AGENT_WORKSPACE_BASE_DIR=.*#AGENT_WORKSPACE_BASE_DIR=/mnt/efs#' .env
# 确保本机已挂载 EFS 到 /mnt/efs（见下方“挂载 EFS”），然后重启后端

# → S3 模式
sed -i 's/^AGENTCORE_STORAGE=.*/AGENTCORE_STORAGE=s3/' .env
sed -i 's#^AGENT_WORKSPACE_BASE_DIR=.*#AGENT_WORKSPACE_BASE_DIR=/tmp/workspaces#' .env
```

**同时 runtime 也要匹配**——EFS 模式要求 runtime 为 VPC 网络并挂载 EFS access point：

```bash
# EFS 模式：VPC + 挂载 access point 到 /mnt/efs（需 aws-cli ≥ 2.36）
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <runtime-id> \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<ECR_URI>:latest"}}' \
  --role-arn "arn:aws:iam::<ACCOUNT_ID>:role/super-agent-agentcore-role-<StackName>" \
  --network-configuration '{"networkMode":"VPC","networkModeConfig":{"subnets":["<private-NAT 子网,同 AZ 有 EFS 挂载目标>"],"securityGroups":["<允许2049的SG>"]}}' \
  --filesystem-configurations '[{"efsAccessPoint":{"accessPointArn":"<access-point-arn>","mountPath":"/mnt/efs"}}]' \
  --environment-variables '{"CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_DISABLE_THINKING":"1","ANTHROPIC_MODEL":"us.anthropic.claude-opus-4-8","AWS_REGION":"<REGION>","AGENT_WORKSPACE_BASE_DIR":"/mnt/efs"}' \
  --region <REGION>

# S3 模式：PUBLIC + 无 filesystem-configurations
aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id <runtime-id> \
  --agent-runtime-artifact '{"containerConfiguration":{"containerUri":"<ECR_URI>:latest"}}' \
  --role-arn "arn:aws:iam::<ACCOUNT_ID>:role/super-agent-agentcore-role-<StackName>" \
  --network-configuration '{"networkMode":"PUBLIC"}' \
  --environment-variables '{"CLAUDE_CODE_USE_BEDROCK":"1","CLAUDE_CODE_DISABLE_THINKING":"1","ANTHROPIC_MODEL":"us.anthropic.claude-opus-4-8","AWS_REGION":"<REGION>","WORKSPACE_S3_REGION":"<REGION>"}' \
  --region <REGION>
```

### EFS 模式的前置资源（ECS 模式由 CDK 在 CloudFormation 中创建）

`deploy-full-ecs.sh` 下这些资源由 CDK 栈（`super-agent-ecs-stack.ts`）声明式创建，脚本从
stack 输出读取，无需手工建：

- **EFS 文件系统** + **access point**（根目录 `/workspaces`，POSIX uid/gid **1000:1000**，与容器 `node` 用户一致）
- **挂载目标**：建在 **private-NAT 子网**（EFS 按 AZ 生效，覆盖该 AZ 全部子网）；runtime 在同 AZ 的 private 子网即可挂载并有 NAT 出口
- **NFS 安全组**：放行 TCP **2049**（来自 ECS SG 与自身）
- **执行/任务角色 IAM**：`elasticfilesystem:ClientMount`、`ClientWrite`（带 access point 条件）、`DescribeAccessPoints`、`DescribeMountTargets`
- **ECS 后端任务**：任务定义加 EFS volume + mountPoint 到 `/mnt/efs`（部署脚本 Phase 4 注入）

> EC2 模式（`deploy-full.sh`）仍由脚本按 Name 标签幂等创建 EFS，不走 CDK。

### 在后端主机手动挂载 EFS

```bash
sudo mkdir -p /mnt/efs
# 用 access point 挂载（TLS）；amazon-efs-utils 提供 mount -t efs
sudo mount -t efs -o tls,accesspoint=<access-point-id> <fs-id>:/ /mnt/efs
# 若 DNS 无法解析 <fs-id>.efs.<region>.amazonaws.com，可临时加 /etc/hosts 指向本 AZ 挂载目标 IP
```

> **回退能力**：应用代码同时保留 S3 与 EFS 两条路径，`AGENTCORE_STORAGE` 切换即可；
> 无需改代码。切回 S3 时记得把 runtime 也改回 PUBLIC（或部署时 `--agentcore-storage s3`）。

## 销毁环境

```bash
cd infra

# EC2 模式
npx cdk destroy -c stackName=SuperAgentProd --region us-west-2 --force

# ECS 模式
npx cdk destroy -c stackName=SuperAgentProd -c deployTarget=ecs --region us-west-2 --force
```

CDK destroy 后需要手动清理：

```bash
# Avatar 和 Skills 桶（removalPolicy=RETAIN，CDK 不删）
aws s3 rb s3://<avatar-bucket-name> --force
aws s3 rb s3://<skills-bucket-name> --force

# ECR 仓库
aws ecr delete-repository --repository-name super-agent-agentcore --force --region <REGION>
aws ecr delete-repository --repository-name super-agent-backend --force --region <REGION>  # ECS 模式

# AgentCore 资源（不在 CDK 管理范围）
aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id <id> --region <REGION>
aws iam delete-role-policy --role-name super-agent-agentcore-role-<StackName> --policy-name agentcore-permissions-<StackName>
aws iam delete-role --role-name super-agent-agentcore-role-<StackName>
```

## 已知注意事项

- **Bedrock 模型 ID**：默认 `us.anthropic.claude-opus-4-8`（配合 `CLAUDE_CODE_DISABLE_THINKING=1`）；`global.anthropic.*` inference profile 也可用。`aws bedrock list-inference-profiles` 查看当前区域支持的 profile
- **AgentCore Runtime 必须在 private-NAT 子网**：runtime ENI 无公网 IP，只能经 NAT 出口访问 Bedrock；用 IGW-only 的 public 子网会导致 health check 超时。deploy 脚本从 `AgentcoreSubnets` stack 输出取 private 子网
- **EFS 一次性调优**：EFS 挂载是**按 AZ**（不是按子网），挂载目标在某 AZ 的任一子网即可服务该 AZ 的全部子网；CloudFormation **无法**原地把挂载目标在同 AZ 内换子网（1-per-AZ 限制），全新 VPC 首次部署无此问题
- **ECS 模式 — Prisma 迁移/seed**：RDS 不可公网访问，迁移与 seed 通过 ECS run-task 在 VPC 内执行；镜像已把 `tsx`+`dotenv` 放进生产依赖，`prisma.config.ts` 由脚本重写（不依赖 `dotenv/config`）
- **ECS 模式 — 初始 desiredCount=0**：CDK 创建 ECS Service 时用占位镜像，desiredCount=0 避免健康检查失败；部署脚本推送真实镜像后设为 1
- **CloudFront Origin**：ECS 模式直接用 ALB DNS 作为 origin；`/api/*`、`/ws/*` 反代到 ALB，静态文件走 S3（OAC）
- **S3 桶 RETAIN 策略**：Avatar 和 Skills 桶设为 RETAIN，CDK destroy 不会删除，需手动清理
- **所有资源同 VPC**：ECS tasks、RDS、ElastiCache、ALB、EFS、AgentCore Runtime 在同一 VPC，安全组规则控制互访
