//**------------------------------------------------------------------------**//

import * as cdk from 'aws-cdk-lib'
import * as amq from 'aws-cdk-lib/aws-amazonmq'
import * as cm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as dns from 'aws-cdk-lib/aws-route53'
import * as sm from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

export class ProdStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    //!!--------------------------------------------------------------------------//
    //!! CHAPTER 1/3
    //!!--------------------------------------------------------------------------//

    const prefix = 'prod'
    const defaultPort = 3001

    //**------------------------------------------------------------------------**//
    //** VPC
    //**------------------------------------------------------------------------**//
    const vpc = new ec2.Vpc(this, `${prefix}-vpc`, {
      ipAddresses: ec2.IpAddresses.cidr('10.10.0.0/16'),
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          subnetType: ec2.SubnetType.PUBLIC,
          name: `${prefix}-publicSN`,
        },
        {
          cidrMask: 24,
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          name: `${prefix}-privateSN`,
        },
      ],
    })

    //**------------------------------------------------------------------------**//
    //** RDS instance
    //**------------------------------------------------------------------------**//
    const dbSecret = new sm.Secret(this, `${prefix}-dbSecret`, {
      secretName: `prod/aurora/mysql`, // to specify the name explicitly
      generateSecretString: {
        excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!\'/@"\\',
        generateStringKey: 'password',
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: 'admin' }),
      },
    })
    const dbCredentials = rds.Credentials.fromSecret(dbSecret, 'admin')
    const dbSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-auroraSG`, {
      vpc,
      allowAllOutbound: true,
      description: 'MySQL/Aurora security group',
      securityGroupName: `${prefix}-auroraSG`,
    })
    dbSecurityGroup.addIngressRule(
      dbSecurityGroup,
      ec2.Port.allTraffic(),
      'traffic from self'
    )
    dbSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(3306),
      'MySQL'
    )
    const auroraCluster = new rds.DatabaseCluster(this, `${prefix}-aurora`, {
      engine: rds.DatabaseClusterEngine.auroraMysql({
        version: rds.AuroraMysqlEngineVersion.VER_3_02_0,
      }),
      credentials: dbCredentials,
      instanceProps: {
        instanceType: ec2.InstanceType.of(
          ec2.InstanceClass.T4G,
          ec2.InstanceSize.MEDIUM
        ),
        vpc: vpc,
        vpcSubnets: {
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
        securityGroups: [dbSecurityGroup],
        publiclyAccessible: false,
        deleteAutomatedBackups: true,
      },
      clusterIdentifier: `${prefix}-aurora`,
      defaultDatabaseName: 'gangnam',
      instances: 2,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: '18:00-19:00',
      },
    })
    // new cdk.CfnOutput(this, 'dbEndpointAddress', {
    //   value: dbInstance.dbInstanceEndpointAddress,
    // })
    // new cdk.CfnOutput(this, 'dbSecretArn', {
    //   value: dbInstance.secret!.secretArn,
    // })

    //**------------------------------------------------------------------------**//
    //** Bastion Host (will work regardless of environment)
    //** - ssh tunneling for database client
    //** - ssh tunneling for rabbitmq console
    //**------------------------------------------------------------------------**//
    const bastionSg = new ec2.SecurityGroup(this, `${prefix}-bastionSG`, {
      vpc,
      allowAllOutbound: true,
      description: 'bastion security group',
      securityGroupName: `${prefix}-bastionSG`,
    })
    bastionSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(22), 'SSH')
    const bastion = new ec2.BastionHostLinux(this, `${prefix}-bastion`, {
      vpc,
      instanceName: `${prefix}-bastion`,
      securityGroup: bastionSg,
      subnetSelection: {
        subnetType: ec2.SubnetType.PUBLIC,
      },
    })

    //**------------------------------------------------------------------------**//
    //** Redis
    //**------------------------------------------------------------------------**//
    const redisSg = new ec2.SecurityGroup(this, `${prefix}-redisSG`, {
      vpc,
      allowAllOutbound: true,
      description: 'Redis security group',
      securityGroupName: `${prefix}-redisSG`,
    })
    redisSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(6379), 'redis')
    const redisSubnet = new elasticache.CfnSubnetGroup(
      this,
      `${prefix}-redisSN`,
      {
        cacheSubnetGroupName: `${prefix}-redisSN`,
        description: `redis subnet group`,
        subnetIds: vpc.selectSubnets({
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }).subnetIds,
      }
    )
    const redisCluster = new elasticache.CfnCacheCluster(
      this,
      `${prefix}-redis`,
      {
        cacheNodeType: 'cache.t3.micro',
        cacheSubnetGroupName: redisSubnet.ref,
        clusterName: `${prefix}-redis`,
        engine: 'redis',
        engineVersion: '6.x',
        numCacheNodes: 1,
        vpcSecurityGroupIds: [redisSg.securityGroupId],
      }
    )

    //**------------------------------------------------------------------------**//
    //** RabbitMQ
    //**------------------------------------------------------------------------**//
    const rmqSecurityGroup = new ec2.SecurityGroup(this, `${prefix}-rmqSG`, {
      vpc,
      allowAllOutbound: true,
      securityGroupName: `${prefix}-rmqSG`,
    })
    rmqSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443))
    rmqSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(5671))
    rmqSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(15671))
    const privateSubnet = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    })

    const rabbitMq = new amq.CfnBroker(this, `${prefix}-rmq`, {
      autoMinorVersionUpgrade: true,
      brokerName: `${prefix}-rmq`,
      engineType: 'RABBITMQ',
      engineVersion: '3.10.10',
      deploymentMode: 'SINGLE_INSTANCE',
      hostInstanceType: 'mq.m5.large',
      publiclyAccessible: false,
      users: [
        {
          username: 'admin',
          password: 'dhfgoRhr1djrekftjd!',
          consoleAccess: true,
        },
      ],
      securityGroups: [rmqSecurityGroup.securityGroupId],
      subnetIds: [privateSubnet.subnetIds[0]],
    })

    //**------------------------------------------------------------------------**//
    //** ECR (will work regardless of environment)
    //**------------------------------------------------------------------------**//
    const repository = new ecr.Repository(this, 'fleaauction-api', {
      repositoryName: 'fleaauction-api',
      imageScanOnPush: false,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    //!!--------------------------------------------------------------------------//
    //!! CHAPTER 2/3
    //!!--------------------------------------------------------------------------//

    //**------------------------------------------------------------------------**//
    //** ECS cluster
    //**------------------------------------------------------------------------**//
    const cluster = new ecs.Cluster(this, `${prefix}-apiCluster`, {
      vpc,
      clusterName: `${prefix}-apiCluster`,
      containerInsights: true,
    })

    //**------------------------------------------------------------------------**//
    //** ECS task
    //**------------------------------------------------------------------------**//
    const fargateTask = new ecs.FargateTaskDefinition(
      this,
      `${prefix}-apiTask`,
      {
        cpu: 256,
        memoryLimitMiB: 512,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
      }
    )

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
        'logs:CreateLogGroup',
        'logs:CreateLogStream',
        'logs:PutLogEvents',
      ],
    })
    //** `Task Role` is specific capabilities within the task itself when your actual code runs.
    //** 예를 들어, 아래의 서비스 같은 것들은 특정 테이블 접근을 위해서 해당 권한이 있는 IAM policy 가 필요.
    //** - S3
    //** - SQS
    //** - DynamoDB, etc.
    const taskRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['arn:aws:s3:::auction-uploads/*'],
      actions: ['s3:*'],
    })

    fargateTask.addToTaskRolePolicy(taskRolePolicy)
    fargateTask.addToExecutionRolePolicy(executionRolePolicy)

    //**------------------------------------------------------------------------**//
    //** ECS Container
    //**------------------------------------------------------------------------**//
    const logGroup = new logs.LogGroup(this, `${prefix}-apiLog`, {
      logGroupName: '/ecs/prodApi',
    })
    const container = fargateTask.addContainer(`${prefix}-apiContainer`, {
      environment: {
        MYSQL_SECRETS_ARN: auroraCluster.secret!.secretArn,
        NODE_ENV: 'prod',
        RABBITMQ_HOST: cdk.Fn.select(0, rabbitMq.attrAmqpEndpoints),
        RABBITMQ_QUEUE: rabbitMq.brokerName,
        REDIS_HOST: redisCluster.attrRedisEndpointAddress,
        REDIS_PORT: redisCluster.attrRedisEndpointPort,
      },
      image: ecs.EcrImage.fromEcrRepository(repository),
      // image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: `ecs`,
        logGroup,
      }),
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
      `${prefix}-hostZone`,
      {
        zoneName: 'fleaauction.world',
        hostedZoneId: 'Z08193362JY5ZYEXTSKLM',
      }
    )
    const cert = new cm.Certificate(this, `${prefix}-cert`, {
      domainName: 'api.fleaauction.world',
      validation: cm.CertificateValidation.fromDns(hostedZone),
    })

    const albSg = new ec2.SecurityGroup(this, `${prefix}-albSG`, {
      vpc,
    })
    albSg.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443))
    const targetGroup = new elbv2.ApplicationTargetGroup(
      this,
      `${prefix}-albTG`,
      {
        vpc,
        port: defaultPort,
        protocol: elbv2.ApplicationProtocol.HTTP,
        targetType: elbv2.TargetType.IP,
        healthCheck: {
          path: '/',
          healthyHttpCodes: '200',
        },
      }
    )
    const alb = new elbv2.ApplicationLoadBalancer(this, `${prefix}-alb`, {
      vpc,
      deletionProtection: false,
      idleTimeout: cdk.Duration.minutes(10),
      internetFacing: true,
      http2Enabled: false,
      loadBalancerName: `${prefix}-alb`,
      securityGroup: albSg,
    })
    const httpListener = alb.addListener(`${prefix}-httpListener`, {
      port: 80,
      open: true,
      defaultAction: elbv2.ListenerAction.redirect({
        port: '443',
        protocol: elbv2.ApplicationProtocol.HTTPS,
      }),
    })
    const httpsListener = alb.addListener(`${prefix}-httpsListner`, {
      port: 443,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED,
      certificates: [cert],
    })
    httpsListener.addTargetGroups(`${prefix}-albTG`, {
      targetGroups: [targetGroup],
    })
    new dns.ARecord(this, `${prefix}-dnsRecord`, {
      zone: hostedZone,
      recordName: 'api.fleaauction.world',
      target: dns.RecordTarget.fromAlias(
        new cdk.aws_route53_targets.LoadBalancerTarget(alb)
      ),
    })

    //**------------------------------------------------------------------------**//
    //** ECS Service
    //**------------------------------------------------------------------------**//
    const apiSrvSg = new ec2.SecurityGroup(this, `${prefix}-apiSrvSG`, {
      vpc,
      allowAllOutbound: true,
    })
    apiSrvSg.addIngressRule(
      ec2.Peer.securityGroupId(albSg.securityGroupId),
      ec2.Port.tcp(defaultPort)
    )
    const service = new ecs.FargateService(this, `${prefix}-apiSvc`, {
      cluster,
      assignPublicIp: false,
      desiredCount: 1,
      securityGroups: [apiSrvSg],
      serviceName: `${prefix}-apiSvc`,
      taskDefinition: fargateTask,
    })
    const scaling = service.autoScaleTaskCount({
      maxCapacity: 6,
      minCapacity: 1,
    })
    scaling.scaleOnCpuUtilization(`${prefix}-scalingPolicy`, {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    })
    service.attachToApplicationTargetGroup(targetGroup)

    //!!--------------------------------------------------------------------------//
    //!! CHAPTER 3/3
    //!!--------------------------------------------------------------------------//

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
