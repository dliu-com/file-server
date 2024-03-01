import { Construct } from 'constructs';
import {
  aws_ec2 as ec2,
  aws_iam as iam,
  StackProps,
  CfnOutput,
  Stack,
  aws_s3 as s3,
  aws_datasync as datasync,
} from 'aws-cdk-lib';

import { ImportValues } from './import-values';
export interface CdkStackProps extends StackProps { appName: string; }
export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props: CdkStackProps) {
    super(scope, id, props);

    const get = new ImportValues(this, props);

    const bucket = new s3.Bucket(this, 'SyncBucket', { bucketName: 'file-server-sync-bucket-test' });

    const s3Role = new iam.Role(this, "S3Role", {
      assumedBy: new iam.ServicePrincipal('datasync.amazonaws.com'),
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')],
    });

    const s3Location = new datasync.CfnLocationS3(this, 'S3Location', {
      s3BucketArn: bucket.bucketArn,
      s3Config: { bucketAccessRoleArn: s3Role.roleArn },
    });

    const sg = new ec2.SecurityGroup(this, 'DataSyncSecurityGroup', { vpc: get.vpc });
    const fsSecurityGroup = ec2.SecurityGroup.fromSecurityGroupId(this, 'EfsSecurityGroup', get.efsSecurityGroup);
    fsSecurityGroup.connections.allowFrom(sg, ec2.Port.tcp(2049), `Allow traffic from ${get.appName} to the File System`);

    const EfsLocation = new datasync.CfnLocationEFS(this, 'EfsLocation', {
      ec2Config: {
        securityGroupArns: [`arn:aws:ec2:${this.region}:${this.account}:security-group/${sg.securityGroupId}`],
        subnetArn: `arn:aws:ec2:${this.region}:${this.account}:subnet/${get.efsSubnetId}`,
      },
      efsFilesystemArn: get.fsArn,
      subdirectory: '/files',
    });

    const task = new datasync.CfnTask(this, 'S3ToEfsTask', {
      destinationLocationArn: EfsLocation.attrLocationArn,
      name: 'file-server-s3-to-efs',
      sourceLocationArn: s3Location.attrLocationArn,
      schedule: { scheduleExpression: 'cron(0/2 0 ? * * *)' },
      options: {
        preserveDeletedFiles: 'REMOVE',
        transferMode: 'CHANGED',
        verifyMode: 'ONLY_FILES_TRANSFERRED',
      },
    });
    new CfnOutput(this, 'DataSyncTask', { value: task.name as string });

  }
}
