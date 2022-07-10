//**------------------------------------------------------------------------**//

import * as cdk from 'aws-cdk-lib'
import * as cm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as dns from 'aws-cdk-lib/aws-route53'
import * as sm from 'aws-cdk-lib/aws-secretsmanager'

import { Construct } from 'constructs'

export class FleaauctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    const defaultPort = 3001

    //**------------------------------------------------------------------------**//
    //** VPC
    //**------------------------------------------------------------------------**//
    const vpc = new ec2.Vpc(this, 'fa-v2-vpc', {
      cidr: '10.1.0.0/16',
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { cidrMask: 24, subnetType: ec2.SubnetType.PUBLIC, name: 'Public' },
        {
          cidrMask: 24,
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
          name: 'Private',
        },
      ],
    })

    //**------------------------------------------------------------------------**//
    //** RDS instance
    //**------------------------------------------------------------------------**//
    const credentials = new sm.Secret(this, 'fa-v2-db-secret', {
      secretName: 'dev/fa-v2/mysql', // to specify the name explicitly
      generateSecretString: {
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
      },
    })
    const dbCredentials = rds.Credentials.fromSecret(credentials, 'admin')
    const dbSg = new ec2.SecurityGroup(this, 'fa-v2-mysql-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'MySQL security group',
      securityGroupName: 'fa-v2-mysql-sg',
    })
    dbSg.addIngressRule(dbSg, ec2.Port.allTraffic(), 'traffic from self')
    dbSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(3306), 'MySQL')
    const dbInstance = new rds.DatabaseInstance(this, 'fa-v2-mysql', {
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
      },
      allocatedStorage: 20,
      allowMajorVersionUpgrade: false,
      autoMinorVersionUpgrade: true,
      backupRetention: cdk.Duration.days(7),
      credentials: dbCredentials,
      databaseName: 'gangnam',
      deleteAutomatedBackups: true,
      engine: rds.DatabaseInstanceEngine.mysql({
        version: rds.MysqlEngineVersion.VER_8_0_28,
      }),
      instanceIdentifier: 'dev-fa-v2',
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.SMALL
      ),
      multiAz: false,
      publiclyAccessible: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      securityGroups: [dbSg],
    })
    new cdk.CfnOutput(this, 'dbEndpointAddress', {
      value: dbInstance.dbInstanceEndpointAddress,
    })
    new cdk.CfnOutput(this, 'dbSecretArn', {
      value: dbInstance.secret!.secretArn,
    })

    //**------------------------------------------------------------------------**//
    //** Bastion Host
    //**------------------------------------------------------------------------**//
    const bastionSg = new ec2.SecurityGroup(this, 'fa-v2-bastion-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'bastion host security group',
      securityGroupName: 'fa-v2-bastion-sg',
    })
    bastionSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH')
    const bastion = new ec2.BastionHostLinux(this, 'fa-v2-bastion', {
      vpc,
      instanceName: 'fa-v2-bastion',
      securityGroup: bastionSg,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    })

    //**------------------------------------------------------------------------**//
    //** Redis
    //**------------------------------------------------------------------------**//
    const redisSg = new ec2.SecurityGroup(this, 'fa-v2-redis-sg', {
      vpc,
      allowAllOutbound: true,
      description: 'Redis security group',
      securityGroupName: 'fa-v2-redis-sg',
    })
    redisSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6379), 'Redis')
    const redisSubnet = new elasticache.CfnSubnetGroup(
      this,
      'fa-v2-redis-subnet',
      {
        cacheSubnetGroupName: 'fa-v2-redis-subnet',
        description: `Redis subnet group`,
        subnetIds: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_WITH_NAT,
        }).subnetIds,
      }
    )
    const redisCluster = new elasticache.CfnCacheCluster(this, 'fa-v2-redis-dev', {
      cacheNodeType: 'cache.t3.micro',
      cacheSubnetGroupName: redisSubnet.ref,
      clusterName: 'fa-v2-redis-dev',
      engine: 'redis',
      engineVersion: '6.x',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSg.securityGroupId],
    })

    //**------------------------------------------------------------------------**//
    //** ECR
    //**------------------------------------------------------------------------**//
    const repository = new ecr.Repository(this, 'fa-v2-api', {
      repositoryName: 'fa-v2-api',
      imageScanOnPush: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    //!!--------------------------------------------------------------------------//

    //**------------------------------------------------------------------------**//
    //** ECS cluster
    //**------------------------------------------------------------------------**//
    const cluster = new ecs.Cluster(this, 'fa-v2-dev-cluster', {
      vpc,
      clusterName: 'fa-v2-dev-cluster',
      containerInsights: true,
    })

    //**------------------------------------------------------------------------**//
    //** ECS task
    //**------------------------------------------------------------------------**//
    const fargateTask = new ecs.FargateTaskDefinition(this, 'fa-v2-api-task', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: {
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    })

    //** ref) https://stackoverflow.com/questions/48999472/difference-between-aws-elastic-container-services-ecs-executionrole-and-taskr
    //**
    //** `Execution Role` is the IAM role that executes ECS actions such as
    //** - pulling an image from ECR
    //** - storing logs in Cloudwatch
    //**
    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        'ecr:GetAuthorizationToken',
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
    })
    //** `Task Role` is specific capabilities within the task itself when your actual code runs.
    //** 예를 들어, 아래의 서비스 같은 것들은 특정 테이블 접근을 위해서 해당 권한이 있는 IAM policy 가 필요.
    //** - S3
    //** - SQS
    //** - DynamoDB, etc.
    // const taskRolePolicy = new iam.PolicyStatement({
    //   effect: iam.Effect.ALLOW,
    //   resources: [table.tableArn],
    //   actions: ['dynamodb:*'],
    // })

    fargateTask.addToExecutionRolePolicy(executionRolePolicy)
    // fargateTask.addToTaskRolePolicy(taskRolePolicy)

    //**------------------------------------------------------------------------**//
    //** ECS Container
    //**------------------------------------------------------------------------**//
    const container = fargateTask.addContainer('fa-v2-api', {
      environment: {
        ENV: 'dev',
        REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        REDIS_PORT: redisCluster.attrRedisEndpointPort,
        MYSQL_HOST: dbInstance.dbInstanceEndpointAddress,
        MYSQL_PORT: dbInstance.dbInstanceEndpointPort,
        MYSQL_SECRETS_ARN: dbInstance.secret!.secretArn,
      },
      // image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      image: ecs.EcrImage.fromEcrRepository(repository),
      // image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fa-v2-api' }),
    })
    container.addPortMappings({
      containerPort: defaultPort,
      hostPort: defaultPort,
    })

    //**------------------------------------------------------------------------**//
    //** ALB
    //**------------------------------------------------------------------------**//
    const hostedZone = dns.HostedZone.fromHostedZoneAttributes(
      this,
      'fa-v2-hz',
      {
        zoneName: 'fleaauction.world',
        hostedZoneId: 'Z08193362JY5ZYEXTSKLM',
      }
    )
    const cert = new cm.Certificate(this, 'fa-v2-certificate', {
      domainName: 'dev.fleaauction.world',
      validation: cm.CertificateValidation.fromDns(hostedZone),
    })
    const albSg = new ec2.SecurityGroup(this, 'fa-v2-alb-sg', {
      vpc,
    })
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443))
    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'fa-v2-alb-tg', {
      vpc,
      port: defaultPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
      },
    })
    const alb = new elbv2.ApplicationLoadBalancer(this, 'fa-v2-alb', {
      vpc,
      deletionProtection: false,
      idleTimeout: cdk.Duration.minutes(10),
      internetFacing: true,
      http2Enabled: false,
      loadBalancerName: 'fa-v2-alb',
      securityGroup: albSg,
    })
    const httpListener = alb.addListener('fa-v2-alb-http-listener', {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: elbv2.ApplicationProtocol.HTTPS,
      }),
    })
    const httpsListener = alb.addListener('fa-v2-alb-https-listner', {
      port: 443,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      certificates: [cert],
    })
    httpsListener.addTargetGroups('fa-v2-alb-https-tg', {
      targetGroups: [targetGroup],
    })
    new dns.ARecord(this, 'fa-v2-dns-record', {
      zone: hostedZone,
      recordName: 'dev.fleaauction.world',
      target: dns.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.LoadBalancerTarget(alb)
      ),
    })

    //**------------------------------------------------------------------------**//
    //** ECS Service
    //**------------------------------------------------------------------------**//
    const serviceSg = new ec2.SecurityGroup(this, 'fa-v2-api-sg', {
      vpc,
      allowAllOutbound: true,
    })
    serviceSg.addIngressRule(
      ec2.Peer.securityGroupId(albSg.securityGroupId),
      ec2.Port.tcp(defaultPort)
    )
    const service = new ecs.FargateService(this, 'fa-v2-api', {
      cluster,
      assignPublicIp: false,
      desiredCount: 1,
      securityGroups: [serviceSg],
      serviceName: 'fa-v2-api',
      taskDefinition: fargateTask,
    })
    const scaling = service.autoScaleTaskCount({
      maxCapacity: 4,
      minCapacity: 1,
    })
    scaling.scaleOnCpuUtilization('fa-v2-api-scaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    })
    service.attachToApplicationTargetGroup(targetGroup)

    // // Code repository
    // const code = new codecommit.Repository(this, 'Repository', {
    //   repositoryName: 'msg-app-backend',
    //   description: 'Node.js backend.',
    // })

    // // Codebuild
    // const project = new codebuild.PipelineProject(this, 'MyProject', {
    //   environment: {
    //     buildImage: codebuild.LinuxBuildImage.STANDARD_2_0,
    //     privileged: true,
    //   },
    // })
    // const buildRolePolicy = new iam.PolicyStatement({
    //   effect: iam.Effect.ALLOW,
    //   resources: ['*'],
    //   actions: [
    //     'ecr:GetAuthorizationToken',
    //     'ecr:BatchCheckLayerAvailability',
    //     'ecr:GetDownloadUrlForLayer',
    //     'ecr:GetRepositoryPolicy',
    //     'ecr:DescribeRepositories',
    //     'ecr:ListImages',
    //     'ecr:DescribeImages',
    //     'ecr:BatchGetImage',
    //     'ecr:InitiateLayerUpload',
    //     'ecr:UploadLayerPart',
    //     'ecr:CompleteLayerUpload',
    //     'ecr:PutImage',
    //   ],
    // })
    // project.addToRolePolicy(buildRolePolicy)

    // const sourceOutput = new codepipeline.Artifact()
    // const buildOutput = new codepipeline.Artifact()
    // const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
    //   actionName: 'CodeCommit',
    //   repository: code,
    //   output: sourceOutput,
    // })
    // const buildAction = new codepipeline_actions.CodeBuildAction({
    //   actionName: 'CodeBuild',
    //   project,
    //   input: sourceOutput,
    //   outputs: [buildOutput],
    // })

    // new codepipeline.Pipeline(this, 'MyPipeline', {
    //   stages: [
    //     {
    //       stageName: 'Source',
    //       actions: [sourceAction],
    //     },
    //     {
    //       stageName: 'Build',
    //       actions: [buildAction],
    //     },
    //     {
    //       stageName: 'Deploy',
    //       actions: [
    //         new codepipeline_actions.EcsDeployAction({
    //           actionName: 'ECS-Service',
    //           service: service,
    //           input: buildOutput,
    //         }),
    //       ],
    //     },
    //   ],
    // })
  }
}
