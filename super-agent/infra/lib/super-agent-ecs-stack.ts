import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53targets from 'aws-cdk-lib/aws-route53-targets';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

/**
 * SuperAgentEcsStack — ECS Fargate deployment with ALB + CloudFront CDN.
 *
 * Core resources (always created):
 *   VPC (default), Security Groups, ECS Fargate cluster + service + ALB,
 *   RDS PostgreSQL, ElastiCache Redis, S3 buckets, IAM roles.
 *
 * Optional Cognito (authMode=cognito):
 *   User Pool + App Client + initial admin user.
 *
 * Optional CDN layer (enableCdn=true):
 *   S3 frontend bucket, CloudFront distribution (serving S3 static + proxying
 *   /api/* and /ws/* to the ALB), OAC. When a custom domain is provided it also
 *   adds an ACM certificate + Route53 ALIAS; otherwise the app is served on the
 *   default *.cloudfront.net domain with the CloudFront-managed certificate.
 *
 * Context parameters:
 *   enableCdn     - "true" to deploy CloudFront (default: "false")
 *   domainName    - OPTIONAL custom domain, e.g. "app.example.com" (requires hostedZoneId)
 *   hostedZoneId  - Route53 hosted zone ID (only with domainName)
 *   authMode      - "cognito" | "local" (default: "local")
 *   deployTarget  - "ecs" to use this stack (checked in bin/app.ts)
 */
export class SuperAgentEcsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const enableCdn = this.node.tryGetContext('enableCdn') === 'true';
    const domainName = this.node.tryGetContext('domainName') as string | undefined;
    const hostedZoneId = this.node.tryGetContext('hostedZoneId') as string | undefined;
    const authMode = (this.node.tryGetContext('authMode') as string) || 'local';

    // A custom domain requires a Route53 hosted zone (for ACM validation + ALIAS).
    // Without a domain, CloudFront is served on its default *.cloudfront.net name
    // using the CloudFront-managed certificate — no ACM/Route53 needed.
    const useCustomDomain = enableCdn && !!domainName && !!hostedZoneId;
    if (domainName && !hostedZoneId) {
      throw new Error('domainName requires hostedZoneId (Route53 zone for ACM + ALIAS). Omit both to use the default *.cloudfront.net domain.');
    }

    // =========================================================================
    // Parameters
    // =========================================================================
    const allowedCidr = new cdk.CfnParameter(this, 'AllowedCidr', {
      type: 'String',
      default: '0.0.0.0/0',
      description: 'CIDR allowed to access ALB HTTP/HTTPS',
    });

    // Cognito parameters (only used when authMode=cognito)
    const adminEmail = new cdk.CfnParameter(this, 'AdminEmail', {
      type: 'String',
      default: 'admin@example.com',
      description: 'Initial admin email (Cognito mode only)',
    });

    const cognitoDomainPrefix = new cdk.CfnParameter(this, 'CognitoDomainPrefix', {
      type: 'String',
      default: 'super-agent-unused',
      description: 'Cognito domain prefix (Cognito mode only)',
    });

    // =========================================================================
    // VPC
    // =========================================================================
    // By default create a NEW dedicated VPC with cross-AZ PUBLIC + PRIVATE(NAT)
    // subnets. This is the clean, self-contained layout AgentCore needs: the
    // runtime runs in a PRIVATE_WITH_EGRESS subnet (NAT egress, no public IP) and
    // the EFS mount targets live in the same private subnets — no reliance on a
    // default VPC's ad-hoc subnet routing.
    //
    // Context overrides:
    //   -c vpcId=<id>      → import an existing VPC instead of creating one
    //   -c createVpc=false → import the account's default VPC
    //   -c azCount=<n>     → number of AZs (default 3)
    const vpcId = this.node.tryGetContext('vpcId') as string | undefined;
    const createVpc = this.node.tryGetContext('createVpc') !== 'false' && !vpcId;
    const azCount = parseInt((this.node.tryGetContext('azCount') as string) || '3', 10);

    let vpc: ec2.IVpc;
    if (vpcId) {
      vpc = ec2.Vpc.fromLookup(this, 'AppVpc', { vpcId });
    } else if (createVpc) {
      // AgentCore-supported AZs in us-east-1 are use1-az1/az2/az4 = us-east-1a/b/c.
      // Pin the VPC to those AZ names so the runtime always lands in a supported AZ.
      const supportedAzs = (this.node.tryGetContext('vpcAzs') as string | undefined)
        ?.split(',').map(s => s.trim()).filter(Boolean)
        ?? (this.region === 'us-east-1'
            ? ['us-east-1a', 'us-east-1b', 'us-east-1c'].slice(0, azCount)
            : undefined);

      // NAT gateways: default to 1 (shared across AZs) to conserve EIPs/cost;
      // override with -c natGateways=<n> for per-AZ HA. All private subnets in
      // all AZs still get NAT egress (routed to the single NAT).
      const natGateways = parseInt((this.node.tryGetContext('natGateways') as string) || '1', 10);
      vpc = new ec2.Vpc(this, 'AppVpc', {
        ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
        ...(supportedAzs ? { availabilityZones: supportedAzs } : { maxAzs: azCount }),
        natGateways,
        subnetConfiguration: [
          { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 20 },
          { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 20 },
        ],
      });
    } else {
      vpc = ec2.Vpc.fromLookup(this, 'AppVpc', { isDefault: true });
    }

    // =========================================================================
    // Security Groups
    // =========================================================================
    const albSg = new ec2.SecurityGroup(this, 'AlbSG', {
      vpc,
      description: 'Super Agent ALB',
      allowAllOutbound: true,
    });
    albSg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(80), 'HTTP',
    );
    albSg.addIngressRule(
      ec2.Peer.ipv4(allowedCidr.valueAsString),
      ec2.Port.tcp(443), 'HTTPS',
    );

    const ecsSg = new ec2.SecurityGroup(this, 'EcsSG', {
      vpc,
      description: 'Super Agent ECS tasks',
      allowAllOutbound: true,
    });
    ecsSg.addIngressRule(albSg, ec2.Port.tcp(3000), 'Backend from ALB');

    const dbSg = new ec2.SecurityGroup(this, 'DBSG', {
      vpc,
      description: 'RDS PostgreSQL',
      allowAllOutbound: false,
    });
    dbSg.addIngressRule(ecsSg, ec2.Port.tcp(5432), 'PostgreSQL from ECS');

    const redisSg = new ec2.SecurityGroup(this, 'RedisSG', {
      vpc,
      description: 'ElastiCache Redis',
      allowAllOutbound: false,
    });
    redisSg.addIngressRule(ecsSg, ec2.Port.tcp(6379), 'Redis from ECS');

    // =========================================================================
    // EFS — shared workspace/skills storage (AGENTCORE_STORAGE=efs)
    // =========================================================================
    // Created in CloudFormation (not the deploy script) so the filesystem,
    // access point, mount targets and NFS SG are all managed declaratively.
    // The ECS backend task and the AgentCore runtime both mount the access
    // point at /mnt/efs. AgentCore VPC runtimes are only supported in a subset
    // of AZs (us-east-1: use1-az1/az2/az4), and the runtime's subnets must have
    // an EFS mount target — so we place a mount target in the supported-AZ
    // subnets. `agentcoreAzIds` context lets other regions override.
    const efsSg = new ec2.SecurityGroup(this, 'EfsSG', {
      vpc,
      description: 'NFS 2049 for super-agent EFS workspaces',
      allowAllOutbound: true,
    });
    // Allow NFS from the ECS tasks, the AgentCore runtime ENIs (which use the
    // EFS SG), and self.
    efsSg.addIngressRule(ecsSg, ec2.Port.tcp(2049), 'NFS from ECS tasks');
    efsSg.addIngressRule(efsSg, ec2.Port.tcp(2049), 'NFS from EFS/runtime ENIs');

    const fileSystem = new efs.FileSystem(this, 'WorkspacesEfs', {
      vpc,
      securityGroup: efsSg,
      encrypted: true,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.ELASTIC,
      // Keep workspace data across stack updates; destroy only on stack delete.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      // Mount targets go in PRIVATE_WITH_EGRESS (NAT-routed) subnets. This is
      // REQUIRED for the AgentCore runtime: its ENIs get no public IP, so they
      // reach Bedrock/AWS endpoints only via a NAT gateway. IGW-only "public"
      // subnets would make the runtime health check time out. The ECS backend
      // runs in public subnets but can still mount cross-AZ within the same VPC.
      // Fall back to public subnets only if the VPC has no private subnets.
      vpcSubnets: vpc.privateSubnets.length > 0
        ? { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }
        : { subnetType: ec2.SubnetType.PUBLIC },
    });

    const efsAccessPoint = fileSystem.addAccessPoint('WorkspacesAp', {
      path: '/workspaces',
      createAcl: { ownerUid: '1000', ownerGid: '1000', permissions: '0755' },
      posixUser: { uid: '1000', gid: '1000' },
    });

    // =========================================================================
    // RDS PostgreSQL
    // =========================================================================
    const dbInstance = new rds.DatabaseInstance(this, 'SuperAgentDB', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_9,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroups: [dbSg],
      databaseName: 'super_agent',
      credentials: rds.Credentials.fromGeneratedSecret('superagent', {
        secretName: `${id}/db-credentials`,
      }),
      allocatedStorage: 20,
      maxAllocatedStorage: 50,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      multiAz: false,
      publiclyAccessible: false,
      backupRetention: cdk.Duration.days(7),
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    // =========================================================================
    // ElastiCache Redis
    // =========================================================================
    const redisSubnetGroup = new cdk.aws_elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnets for ElastiCache Redis',
      subnetIds: vpc.publicSubnets.map(s => s.subnetId),
      cacheSubnetGroupName: `${id}-redis-subnets`.toLowerCase(),
    });

    const redisCluster = new cdk.aws_elasticache.CfnCacheCluster(this, 'RedisCluster', {
      engine: 'redis',
      cacheNodeType: 'cache.t4g.micro',
      numCacheNodes: 1,
      clusterName: `${id}-redis`.toLowerCase(),
      vpcSecurityGroupIds: [redisSg.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.cacheSubnetGroupName,
      engineVersion: '7.1',
      port: 6379,
    });
    redisCluster.addDependency(redisSubnetGroup);

    // =========================================================================
    // S3 Buckets
    // =========================================================================
    const bucketPrefix = id.toLowerCase();

    const avatarBucket = new s3.Bucket(this, 'AvatarBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const skillsBucket = new s3.Bucket(this, 'SkillsBucket', {
      bucketName: `${bucketPrefix}-skills-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
    });

    const workspaceBucket = new s3.Bucket(this, 'WorkspaceBucket', {
      bucketName: `${bucketPrefix}-workspace-${this.account}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [{ expiration: cdk.Duration.days(30) }],
    });

    // =========================================================================
    // IAM Roles for ECS
    // =========================================================================

    // Task Execution Role (used by ECS agent to pull images, push logs)
    const taskExecRole = new iam.Role(this, 'EcsTaskExecRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    // Allow pulling from ECR and creating log groups
    taskExecRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/super-agent/*`],
    }));

    // Task Role (used by the application container at runtime)
    const taskRole = new iam.Role(this, 'EcsTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Bedrock model invocation + model listing.
    // List* is required so the chat/agent model picker can enumerate available
    // Bedrock models (backend calls ListFoundationModels / ListInferenceProfiles);
    // without it the Bedrock provider's model dropdown is empty.
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:ListFoundationModels',
        'bedrock:ListInferenceProfiles',
        'bedrock:GetFoundationModel',
        'bedrock:GetInferenceProfile',
      ],
      resources: ['*'],
    }));

    // Secrets Manager (for DB credentials)
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
      resources: [dbInstance.secret!.secretArn, `${dbInstance.secret!.secretArn}*`],
    }));

    // CloudWatch Logs
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: [`arn:aws:logs:${this.region}:${this.account}:log-group:/super-agent/*`],
    }));

    // AgentCore invoke permission
    taskRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:InvokeAgentRuntime'],
      resources: [`arn:aws:bedrock-agentcore:${this.region}:${this.account}:runtime/*`],
    }));

    // S3 bucket access
    avatarBucket.grantReadWrite(taskRole);
    skillsBucket.grantReadWrite(taskRole);
    workspaceBucket.grantReadWrite(taskRole);

    // =========================================================================
    // ECS Cluster + Fargate Service + ALB
    // =========================================================================
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: `${id}-cluster`.toLowerCase(),
      containerInsights: true,
    });

    // CloudWatch log group for backend container
    const backendLogGroup = new logs.LogGroup(this, 'BackendLogGroup', {
      logGroupName: `/super-agent/${id.toLowerCase()}/ecs-backend`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Task definition (placeholder image — deploy script updates this)
    const taskFamily = `${id}-backend`.toLowerCase();
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'BackendTaskDef', {
      family: taskFamily,
      cpu: 1024,
      memoryLimitMiB: 2048,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.ARM64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      executionRole: taskExecRole,
      taskRole,
    });

    taskDefinition.addContainer('backend', {
      // Placeholder image — replaced by deploy script on first deploy
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/docker/library/node:20-alpine'),
      essential: true,
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
      logging: ecs.LogDrivers.awsLogs({
        logGroup: backendLogGroup,
        streamPrefix: 'backend',
      }),
      healthCheck: {
        command: ['CMD-SHELL', 'curl -f http://localhost:3000/health || exit 1'],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      environment: {
        PORT: '3000',
        HOST: '0.0.0.0',
        NODE_ENV: 'production',
      },
    });

    // Application Load Balancer
    const alb = new elbv2.ApplicationLoadBalancer(this, 'ALB', {
      vpc,
      internetFacing: true,
      securityGroup: albSg,
      loadBalancerName: `${id}-alb`.toLowerCase().substring(0, 32),
    });

    // Target group for backend
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'BackendTG', {
      vpc,
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(10),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
      },
      // Enable stickiness for WebSocket connections
      stickinessCookieDuration: cdk.Duration.hours(1),
    });

    // HTTP listener (port 80) — used by CloudFront as origin
    alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultTargetGroups: [targetGroup],
    });

    // ECS Fargate Service
    // desiredCount=0 on initial deploy (placeholder image has no /health endpoint).
    // The deploy script registers the real task definition and scales to 1.
    const service = new ecs.FargateService(this, 'BackendService', {
      cluster,
      taskDefinition,
      desiredCount: 0,
      securityGroups: [ecsSg],
      assignPublicIp: true, // Required for public subnets (default VPC)
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      serviceName: `${id}-backend-svc`.toLowerCase(),
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true, // Allows `aws ecs execute-command` for debugging
    });

    service.attachToApplicationTargetGroup(targetGroup);

    // =========================================================================
    // Optional: Cognito (authMode=cognito)
    // =========================================================================
    let userPool: cognito.UserPool | undefined;
    let appClient: cognito.UserPoolClient | undefined;
    let cognitoDomainFull: string | undefined;

    if (authMode === 'cognito') {
      userPool = new cognito.UserPool(this, 'SuperAgentUserPool', {
        userPoolName: 'super-agent-users',
        selfSignUpEnabled: false,
        signInAliases: { email: true },
        autoVerify: { email: true },
        standardAttributes: {
          email: { required: true, mutable: true },
          fullname: { required: false, mutable: true },
        },
        customAttributes: {
          orgId: new cognito.StringAttribute({ mutable: true }),
          role: new cognito.StringAttribute({ mutable: true }),
        },
        passwordPolicy: {
          minLength: 8, requireLowercase: true, requireUppercase: true,
          requireDigits: true, requireSymbols: false,
        },
        accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });

      userPool.addDomain('CognitoDomain', {
        cognitoDomain: { domainPrefix: cognitoDomainPrefix.valueAsString },
      });

      appClient = userPool.addClient('SuperAgentAppClient', {
        userPoolClientName: 'super-agent-web',
        generateSecret: false,
        authFlows: { userSrp: true },
        oAuth: {
          flows: { authorizationCodeGrant: true },
          scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
          callbackUrls: ['http://localhost:5173/auth/callback'],
          logoutUrls: ['http://localhost:5173/login'],
        },
        preventUserExistenceErrors: true,
      });

      new cognito.CfnUserPoolUser(this, 'AdminUser', {
        userPoolId: userPool.userPoolId,
        username: adminEmail.valueAsString,
        userAttributes: [
          { name: 'email', value: adminEmail.valueAsString },
          { name: 'email_verified', value: 'true' },
        ],
        desiredDeliveryMediums: ['EMAIL'],
      });

      cognitoDomainFull = `${cognitoDomainPrefix.valueAsString}.auth.${this.region}.amazoncognito.com`;

      taskRole.addToPolicy(new iam.PolicyStatement({
        actions: ['cognito-idp:UpdateUserPoolClient', 'cognito-idp:DescribeUserPoolClient'],
        resources: [userPool.userPoolArn],
      }));
    }

    // =========================================================================
    // Optional: CloudFront CDN (enableCdn=true)
    // =========================================================================
    let frontendBucket: s3.Bucket | undefined;
    let distribution: cloudfront.Distribution | undefined;

    if (enableCdn) {
      // S3 bucket for frontend static files
      frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
        removalPolicy: cdk.RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
      });
      frontendBucket.grantReadWrite(taskRole);

      // ACM certificate + hosted zone only when a custom domain is used.
      // Without a domain, CloudFront serves its default *.cloudfront.net cert.
      let certificate: acm.ICertificate | undefined;
      let hostedZone: route53.IHostedZone | undefined;
      if (useCustomDomain) {
        hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
          hostedZoneId: hostedZoneId!,
          zoneName: domainName!.split('.').slice(1).join('.'),
        });

        certificate = new acm.DnsValidatedCertificate(this, 'Certificate', {
          domainName: domainName!,
          hostedZone,
          region: 'us-east-1', // CloudFront requires us-east-1
        });
      }

      // OAC for S3
      new cloudfront.CfnOriginAccessControl(this, 'OAC', {
        originAccessControlConfig: {
          name: `${id}-oac`,
          originAccessControlOriginType: 's3',
          signingBehavior: 'always',
          signingProtocol: 'sigv4',
        },
      });

      // CloudFront distribution — S3 for static, ALB for API/WS.
      // ALB DNS is known at synth time, so wire it directly (no placeholder).
      const albOrigin = new origins.HttpOrigin(alb.loadBalancerDnsName, {
        protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
        httpPort: 80,
      });

      distribution = new cloudfront.Distribution(this, 'CDN', {
        defaultBehavior: {
          origin: origins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        },
        // Only set custom domain + cert when provided; otherwise use the
        // CloudFront default domain and managed certificate.
        ...(useCustomDomain ? { domainNames: [domainName!], certificate } : {}),
        defaultRootObject: 'index.html',
        errorResponses: [
          { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
          { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.seconds(0) },
        ],
      });

      // /api/* → ALB (no caching, pass all headers)
      distribution.addBehavior('/api/*', albOrigin, {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      });

      // /ws/* → ALB (WebSocket upgrade needs all headers forwarded)
      distribution.addBehavior('/ws/*', albOrigin, {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      });

      // Route53 ALIAS → CloudFront (only when a custom domain is used)
      if (useCustomDomain && hostedZone) {
        new route53.ARecord(this, 'DnsAlias', {
          zone: hostedZone,
          recordName: domainName!,
          target: route53.RecordTarget.fromAlias(new route53targets.CloudFrontTarget(distribution)),
        });
      }
    }

    // =========================================================================
    // Outputs — Core
    // =========================================================================
    new cdk.CfnOutput(this, 'DBEndpoint', { value: dbInstance.dbInstanceEndpointAddress });
    new cdk.CfnOutput(this, 'DBSecretArn', { value: dbInstance.secret!.secretArn });
    new cdk.CfnOutput(this, 'AvatarBucketName', { value: avatarBucket.bucketName });
    new cdk.CfnOutput(this, 'SkillsBucketName', { value: skillsBucket.bucketName });
    new cdk.CfnOutput(this, 'WorkspaceBucketName', { value: workspaceBucket.bucketName });
    new cdk.CfnOutput(this, 'RedisEndpoint', { value: redisCluster.attrRedisEndpointAddress });
    new cdk.CfnOutput(this, 'RedisPort', { value: redisCluster.attrRedisEndpointPort });
    new cdk.CfnOutput(this, 'AuthMode', { value: authMode });
    new cdk.CfnOutput(this, 'EnableCdn', { value: enableCdn ? 'true' : 'false' });

    // Outputs — ECS
    new cdk.CfnOutput(this, 'EcsClusterName', { value: cluster.clusterName });
    new cdk.CfnOutput(this, 'EcsServiceName', { value: service.serviceName });
    new cdk.CfnOutput(this, 'EcsTaskFamily', { value: taskFamily });
    new cdk.CfnOutput(this, 'EcsTaskExecRoleArn', { value: taskExecRole.roleArn });
    new cdk.CfnOutput(this, 'EcsTaskRoleArn', { value: taskRole.roleArn });
    new cdk.CfnOutput(this, 'AlbDnsName', { value: alb.loadBalancerDnsName });
    new cdk.CfnOutput(this, 'AlbArn', { value: alb.loadBalancerArn });
    new cdk.CfnOutput(this, 'EcsSubnets', {
      value: vpc.publicSubnets.map(s => s.subnetId).join(','),
    });
    new cdk.CfnOutput(this, 'EcsSecurityGroup', { value: ecsSg.securityGroupId });
    new cdk.CfnOutput(this, 'VpcId', { value: vpc.vpcId });
    // Private (NAT-routed) subnets — the AgentCore runtime MUST run here so its
    // ENI has NAT egress to Bedrock. Falls back to public if the VPC has none.
    new cdk.CfnOutput(this, 'AgentcoreSubnets', {
      value: (vpc.privateSubnets.length > 0 ? vpc.privateSubnets : vpc.publicSubnets)
        .map(s => s.subnetId).join(','),
    });

    // Outputs — EFS (consumed by deploy-full-ecs.sh for backend mount + AgentCore runtime)
    new cdk.CfnOutput(this, 'EfsFileSystemId', { value: fileSystem.fileSystemId });
    new cdk.CfnOutput(this, 'EfsAccessPointId', { value: efsAccessPoint.accessPointId });
    new cdk.CfnOutput(this, 'EfsAccessPointArn', { value: efsAccessPoint.accessPointArn });
    new cdk.CfnOutput(this, 'EfsSecurityGroup', { value: efsSg.securityGroupId });

    // Outputs — Cognito (only when authMode=cognito)
    if (userPool && appClient && cognitoDomainFull) {
      new cdk.CfnOutput(this, 'CognitoUserPoolId', { value: userPool.userPoolId });
      new cdk.CfnOutput(this, 'CognitoClientId', { value: appClient.userPoolClientId });
      new cdk.CfnOutput(this, 'CognitoDomainUrl', { value: cognitoDomainFull });
    }

    // Outputs — CDN (only when enableCdn=true)
    if (frontendBucket) {
      new cdk.CfnOutput(this, 'FrontendBucketName', { value: frontendBucket.bucketName });
    }
    if (distribution) {
      new cdk.CfnOutput(this, 'CloudFrontDistributionId', { value: distribution.distributionId });
      new cdk.CfnOutput(this, 'CloudFrontDomainName', { value: distribution.distributionDomainName });
    }
    if (domainName) {
      new cdk.CfnOutput(this, 'DomainName', { value: domainName });
    }
  }
}
