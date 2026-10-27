import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { FileServerStack } from '../lib/file-server-stack';

const template = Template.fromStack(new FileServerStack(new App(), 'FileServer', {
  subdomain: 'files',
  frameAncestors: ['https://dliu.com', 'https://*.dliu.com'],
  maxUploadBytes: 50 * 1024 ** 3,
  env: { account: '123456789012', region: 'eu-west-1' },
}));

const distributions = template.findResources('AWS::CloudFront::Distribution');
const distributionConfig = () => Object.values(distributions)[0].Properties.DistributionConfig;
const behavior = (pattern: string) => distributionConfig().CacheBehaviors.find((b: { PathPattern: string }) => b.PathPattern === pattern);
const headers = () => Object.values(template.findResources('AWS::CloudFront::ResponseHeadersPolicy'))[0]
  .Properties.ResponseHeadersPolicyConfig.SecurityHeadersConfig;
const csp = () => JSON.stringify(headers().ContentSecurityPolicy);

test('has nothing that bills while idle', () => {
  for (const type of ['AWS::EC2::Instance', 'AWS::EC2::NatGateway', 'AWS::ElasticLoadBalancingV2::LoadBalancer',
    'AWS::DynamoDB::Table', 'AWS::WAFv2::WebACL', 'AWS::RDS::DBInstance', 'AWS::ApiGateway::RestApi']) {
    template.resourceCountIs(type, 0);
  }
});

test('keeps the live distribution, certificate and DNS records (same logical IDs)', () => {
  expect(Object.keys(distributions)).toEqual([expect.stringMatching(/^FileServerDistribution[0-9A-F]{8}$/)]);
  expect(Object.keys(template.findResources('AWS::CloudFormation::CustomResource')).some((id) => id.startsWith('FileServerCertificate'))).toBe(true);
  const records = Object.keys(template.findResources('AWS::Route53::RecordSet'));
  expect(records.some((id) => id.startsWith('FileServerAliasRecord'))).toBe(true);
  expect(records.some((id) => id.startsWith('FileServerAliasIpv6Record'))).toBe(true);
});

test('the file bucket is private, versioned, retained and accepts browser uploads from the site', () => {
  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.hasResource('AWS::S3::Bucket', {
    DeletionPolicy: 'Retain',
    Properties: Match.objectLike({
      VersioningConfiguration: { Status: 'Enabled' },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
      CorsConfiguration: { CorsRules: [Match.objectLike({ AllowedMethods: ['PUT'], ExposedHeaders: ['ETag'] })] },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({ AbortIncompleteMultipartUpload: { DaysAfterInitiation: 2 } }),
          Match.objectLike({ NoncurrentVersionExpiration: { NoncurrentDays: 30 } }),
          Match.objectLike({ ExpiredObjectDeleteMarker: true }),
        ]),
      },
    }),
  });
});

test('the site is deployed under _app/ only, so it never prunes files', () => {
  template.hasResourceProperties('Custom::CDKBucketDeployment', Match.objectLike({ DestinationBucketKeyPrefix: '_app/', Prune: true }));
});

test('routes pages, files, data and the API to the right origins', () => {
  expect(distributionConfig().CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern))
    .toEqual(['_app/*', '_data/*', 'api/*', 'auth/*']);
  expect(behavior('api/*').AllowedMethods).toContain('POST');
  expect(behavior('auth/*').AllowedMethods).not.toContain('POST');
  expect(distributionConfig().DefaultCacheBehavior.FunctionAssociations).toHaveLength(2);
  expect(behavior('_app/*').FunctionAssociations).toBeUndefined();
  expect(distributionConfig().DefaultRootObject).toBe('_app/index.html');
  expect(distributionConfig().CustomErrorResponses).toEqual([
    { ErrorCode: 404, ResponseCode: 404, ResponsePagePath: '/_app/index.html', ErrorCachingMinTTL: 10 },
  ]);
  expect(distributionConfig().Logging).toEqual({ IncludeCookies: true });
});

test('scripts only run from the site itself, and other dliu.com sites may frame it', () => {
  expect(csp()).toContain('script-src https://files.');
  expect(csp()).toContain('/_app/');
  expect(csp()).toContain("frame-ancestors 'self' https://dliu.com https://*.dliu.com");
  expect(csp()).toContain("form-action 'none'");
  expect(headers().FrameOptions).toBeUndefined();
  expect(headers().ContentTypeOptions).toEqual({ Override: true });
});

test('the API Lambda is invoked only through CloudFront and can invalidate it', () => {
  template.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Runtime: 'nodejs22.x',
    Architectures: ['arm64'],
    Timeout: 60,
    Environment: { Variables: Match.objectLike({ PARAMETER_PREFIX: '/files', MAX_UPLOAD_BYTES: String(50 * 1024 ** 3) }) },
  }));
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/files/distribution-id' });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: [Match.objectLike({ Action: 'cloudfront:CreateInvalidation' })] },
  });
});
