//**------------------------------------------------------------------------**//

// import * as cdk from 'aws-cdk-lib'
// import * as ec2 from 'aws-cdk-lib/aws-ec2'
// import * as rds from 'aws-cdk-lib/aws-rds'
// import * as sm from 'aws-cdk-lib/aws-secretsmanager'
// import * as ecr from 'aws-cdk-lib/aws-ecr'
// import * as ecs from 'aws-cdk-lib/aws-ecs'
// import * as elasticache from 'aws-cdk-lib/aws-elasticache'
// import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2'
// import * as iam from 'aws-cdk-lib/aws-iam'

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as elasticache from 'aws-cdk-lib/aws-elasticache'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as sm from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

export class FleaauctionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

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
    const redisCluster = new elasticache.CfnCacheCluster(this, 'fa-v2-redis', {
      cacheNodeType: 'cache.t3.micro',
      cacheSubnetGroupName: redisSubnet.ref,
      clusterName: 'fa-v2-redis',
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

    // // ECS cluster
    // const cluster = new ecs.Cluster(this, 'fa-v2-ecs-cluster', {
    //   vpc: vpc,
    // })

    // // Task
    // const fargateTaskDefinition = new ecs.FargateTaskDefinition(
    //   this,
    //   'ApiTaskDefinition',
    //   {
    //     memoryLimitMiB: 512,
    //     cpu: 256,
    //   }
    // )
    // // IAM Policy
    // const executionRolePolicy = new iam.PolicyStatement({
    //   effect: iam.Effect.ALLOW,
    //   resources: ['*'],
    //   actions: [
    //     'ecr:GetAuthorizationToken',
    //     'ecr:BatchCheckLayerAvailability',
    //     'ecr:GetDownloadUrlForLayer',
    //     'ecr:BatchGetImage',
    //     'logs:CreateLogStream',
    //     'logs:PutLogEvents',
    //   ],
    // })
    // // const taskRolePolicy = new iam.PolicyStatement({
    // //   effect: iam.Effect.ALLOW,
    // //   resources: [table.tableArn],
    // //   actions: ['dynamodb:*'],
    // // })

    // fargateTaskDefinition.addToExecutionRolePolicy(executionRolePolicy)
    // // fargateTaskDefinition.addToTaskRolePolicy(taskRolePolicy)

    // // Container
    // const container = fargateTaskDefinition.addContainer('fa-v2-api', {
    //   image: ecs.ContainerImage.fromRegistry(repository.repositoryUri),
    //   logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'fa-v2-api' }),
    //   environment: {
    //     APP_ID: 'fa-v2-api',
    //     REDIS_HOST: redisCluster.attrRedisEndpointAddress,
    //     REDIS_PORT: redisCluster.attrRedisEndpointPort,
    //     MYSQL_HOST: dbInstance.dbInstanceEndpointAddress,
    //     MYSQL_PORT: dbInstance.dbInstanceEndpointPort,
    //     //MYSQL_PASSWORD: dbPassword,
    //   },
    //   // ... other options here ...
    // })
    // container.addPortMappings({
    //   containerPort: 3000,
    //   hostPort: 3000,
    // })

    // // Service
    // const serviceSg = new ec2.SecurityGroup(this, 'fa-v2-service-sg', {
    //   vpc: vpc,
    // })
    // serviceSg.addIngressRule(ec2.Peer.ipv4('0.0.0.0/0'), ec2.Port.tcp(3000))

    // const service = new ecs.FargateService(this, 'fa-v2-service', {
    //   cluster,
    //   taskDefinition: fargateTaskDefinition,
    //   desiredCount: 1,
    //   assignPublicIp: false,
    //   securityGroups: [serviceSg],
    // })

    // // Setup AutoScaling policy
    // const scaling = service.autoScaleTaskCount({
    //   maxCapacity: 4,
    //   minCapacity: 1,
    // })
    // scaling.scaleOnCpuUtilization('CpuScaling', {
    //   targetUtilizationPercent: 50,
    //   scaleInCooldown: cdk.Duration.seconds(60),
    //   scaleOutCooldown: cdk.Duration.seconds(60),
    // })

    // // ALB
    // const lb = new elbv2.ApplicationLoadBalancer(this, 'fa-v2-lb', {
    //   vpc,
    //   internetFacing: true,
    // })
    // const listener = lb.addListener('Listener', {
    //   port: 80,
    // })
    // listener.addTargets('Target', {
    //   port: 80,
    //   targets: [service],
    //   healthCheck: { path: '/' },
    // })
    // listener.connections.allowDefaultPortFromAnyIpv4('Open to the world')

    // Code repository
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
