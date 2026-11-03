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
    .toEqual(['_app/*', '_data/*', 'api/*', 'auth/*', 'health']);
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

test('the public /health behavior is cached and forwards no cookies, auth or query string', () => {
  const health = behavior('health');
  expect(health.AllowedMethods).toEqual(expect.arrayContaining(['GET', 'HEAD']));
  expect(health.AllowedMethods).not.toContain('POST');
  // No origin request policy on /health => CloudFront forwards no cookies, Authorization header or query string.
  expect(health.OriginRequestPolicyId).toBeUndefined();
  const cachePolicies = template.findResources('AWS::CloudFront::CachePolicy');
  const healthPolicy: any = Object.values(cachePolicies).find((p: any) => p.Properties.CachePolicyConfig.MaxTTL === 60);
  expect(healthPolicy).toBeDefined();
  const cfg = healthPolicy.Properties.CachePolicyConfig;
  expect(cfg.DefaultTTL).toBe(60);
  const keys = cfg.ParametersInCacheKeyAndForwardedToOrigin;
  expect(keys.CookiesConfig.CookieBehavior).toBe('none');
  expect(keys.HeadersConfig.HeaderBehavior).toBe('none');
  expect(keys.QueryStringsConfig.QueryStringBehavior).toBe('none');
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
    ReservedConcurrentExecutions: 10,
    Environment: { Variables: Match.objectLike({ PARAMETER_PREFIX: '/files', MAX_UPLOAD_BYTES: String(50 * 1024 ** 3) }) },
  }));
  template.hasResourceProperties('AWS::SSM::Parameter', { Name: '/files/distribution-id' });
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: { Statement: [Match.objectLike({ Action: 'cloudfront:CreateInvalidation' })] },
  });
});

test('both the website and managed API roles may invalidate the CDN after a change', () => {
  // Default stack has no managed API: only the website role may invalidate.
  const base = Object.values(template.findResources('AWS::IAM::Policy', {
    Properties: { PolicyName: Match.stringLikeRegexp('^InvalidatePolicy') },
  }));
  expect(base).toHaveLength(1);
  expect(base[0].Properties.Roles).toHaveLength(1);
  // With the managed API enabled, both roles may invalidate, so a managed replace/move/delete clears the CDN.
  const enabled = Template.fromStack(new FileServerStack(new App(), 'FileServerInvalidate', {
    subdomain: 'files', frameAncestors: ['https://dliu.com'], maxUploadBytes: 50 * 1024 ** 3,
    microsoftApi: true, env: { account: '123456789012', region: 'eu-west-1' },
  }));
  const split = Object.values(enabled.findResources('AWS::IAM::Policy', {
    Properties: { PolicyName: Match.stringLikeRegexp('^InvalidatePolicy') },
  }));
  expect(split).toHaveLength(1);
  expect(split[0].Properties.Roles).toHaveLength(2);
});

test('Lambda log groups keep three months, matching the account-wide standard', () => {
  template.resourcePropertiesCountIs('AWS::Logs::LogGroup', { RetentionInDays: 90 }, 2);
  template.resourcePropertiesCountIs('AWS::Logs::LogGroup', { RetentionInDays: 30 }, 0);
});

test('files replaced or deleted in S3 by any route are cleared from CloudFront', () => {
  template.hasResourceProperties('Custom::S3BucketNotifications', {
    NotificationConfiguration: { EventBridgeConfiguration: {} },
  });
  template.hasResourceProperties('AWS::Events::Rule', {
    EventPattern: {
      source: ['aws.s3'],
      'detail-type': ['Object Created', 'Object Deleted'],
      detail: { bucket: { name: [Match.anyValue()] }, object: { key: [{ 'anything-but': { prefix: '_' } }] } },
    },
    Targets: [Match.objectLike({ RetryPolicy: { MaximumRetryAttempts: 4, MaximumEventAgeInSeconds: 3600 } })],
  });
  template.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Handler: 'clear.handler',
    Environment: { Variables: { FILE_BUCKET: Match.anyValue(), DISTRIBUTION_ID: Match.anyValue() } },
  }));
  const policies = JSON.stringify(template.findResources('AWS::IAM::Policy', {
    Properties: { PolicyName: Match.stringLikeRegexp('^ClearChangedFiles') },
  }));
  expect(policies).toContain('cloudfront:CreateInvalidation');
  expect(policies).toContain('s3:ListBucketVersions');
  expect(policies).not.toContain('s3:GetObject');
  expect(policies).not.toContain('s3:DeleteObject');
});

test('the website role is denied writing the site code and the shared dliu.com assets', () => {
  template.hasResourceProperties('AWS::IAM::Policy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Action: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
          Resource: [
            Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('_app/\\*')])]) }),
            Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('dliu\\.com/\\*')])]) }),
          ],
        }),
      ]),
    },
  });
});

test('the managed-API role may write dliu.com/ (its own function and role) but is still denied _app/', () => {
  const enabled = Template.fromStack(new FileServerStack(new App(), 'FileServerSplit', {
    subdomain: 'files', frameAncestors: ['https://dliu.com'], maxUploadBytes: 50 * 1024 ** 3,
    microsoftApi: true, env: { account: '123456789012', region: 'eu-west-1' },
  }));
  // The managed API runs on its own function, so the website function keeps its dliu.com/* Deny.
  const descriptions = Object.values(enabled.findResources('AWS::Lambda::Function'))
    .map((fn: any) => fn.Properties.Description).filter(Boolean);
  expect(descriptions.some((d: string) => d.includes('managed API'))).toBe(true);
  // Collect every PutObject Deny statement across all roles.
  const denies: any[] = [];
  for (const policy of Object.values(enabled.findResources('AWS::IAM::Policy')) as any[]) {
    for (const statement of policy.Properties.PolicyDocument.Statement) {
      if (statement.Effect === 'Deny' && Array.isArray(statement.Action) && statement.Action.includes('s3:PutObject')) {
        denies.push(JSON.stringify(statement.Resource));
      }
    }
  }
  // Two roles deny _app/*; exactly one of them also denies dliu.com/* (the website), and one does not (managed).
  const denyApp = denies.filter((r) => r.includes('_app/*'));
  expect(denyApp.length).toBe(2);
  expect(denyApp.filter((r) => r.includes('dliu.com/*')).length).toBe(1);
  expect(denyApp.filter((r) => !r.includes('dliu.com/*')).length).toBe(1);
});

test('files are cached at the edge worldwide over HTTP/3', () => {
  expect(distributionConfig().PriceClass).toBe('PriceClass_All');
  expect(distributionConfig().HttpVersion).toBe('http2and3');
});

test('the Microsoft API is opt-in and every exposed route has its exact delegated scope', () => {
  template.resourceCountIs('AWS::ApiGatewayV2::Api', 0);
  expect(Object.keys(template.toJSON().Outputs)).not.toContain('MicrosoftApiUrl');
  const enabled = Template.fromStack(new FileServerStack(new App(), 'FileServerMicrosoft', {
    subdomain: 'files', frameAncestors: ['https://dliu.com'], maxUploadBytes: 50 * 1024 ** 3,
    microsoftApi: true, env: { account: '123456789012', region: 'eu-west-1' },
  }));
  enabled.resourceCountIs('AWS::ApiGatewayV2::Api', 1);
  enabled.resourceCountIs('AWS::ApiGatewayV2::Authorizer', 1);
  enabled.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
    AuthorizerType: 'JWT', IdentitySource: ['$request.header.Authorization'],
    JwtConfiguration: { Audience: [Match.anyValue()], Issuer: Match.anyValue() },
  });
  const issuer = JSON.stringify(Object.values(enabled.findResources('AWS::ApiGatewayV2::Authorizer'))[0].Properties.JwtConfiguration.Issuer);
  expect(issuer).toContain('https://login.microsoftonline.com/');
  expect(issuer).toContain('/v2.0');
  const parameters = JSON.stringify(enabled.toJSON().Parameters);
  for (const name of ['/files/api-tenant-id', '/files/api-audience', '/files/api-client-id']) expect(parameters).toContain(name);
  const routes = require('../lambda/api/routes.json');
  const deployed = Object.values(enabled.findResources('AWS::ApiGatewayV2::Route'));
  expect(deployed.map((route) => route.Properties.RouteKey).sort()).toEqual(Object.keys(routes).sort());
  for (const route of deployed) {
    expect(route.Properties.AuthorizationType).toBe('JWT');
    expect(route.Properties.AuthorizationScopes).toEqual([routes[route.Properties.RouteKey].scope]);
    expect(route.Properties.AuthorizerId).toBeDefined();
  }
  expect(deployed.some((route) => route.Properties.RouteKey.includes('/auth/') || route.Properties.RouteKey.includes('$default'))).toBe(false);
  enabled.hasResourceProperties('AWS::Lambda::Url', { AuthType: 'AWS_IAM' });
  enabled.hasResourceProperties('AWS::Lambda::Permission', {
    Principal: 'apigateway.amazonaws.com', Action: 'lambda:InvokeFunction', SourceArn: Match.anyValue(),
  });
  enabled.hasResourceProperties('AWS::ApiGatewayV2::Integration', { PayloadFormatVersion: '2.0' });
  enabled.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
    DefaultRouteSettings: { ThrottlingRateLimit: 10, ThrottlingBurstLimit: 20 },
  });
  enabled.hasResourceProperties('AWS::Lambda::Function', Match.objectLike({
    Environment: { Variables: Match.objectLike({
      API_GATEWAY_ID: Match.anyValue(), API_TENANT_ID: Match.anyValue(), API_AUDIENCE: Match.anyValue(), API_CLIENT_ID: Match.anyValue(),
    }) },
  }));
  enabled.hasOutput('MicrosoftApiUrl', { Value: Match.anyValue() });
  // The website's routing and auth are the same with or without the managed API.
  const config = (t: Template) => Object.values(t.findResources('AWS::CloudFront::Distribution'))[0].Properties.DistributionConfig;
  expect(config(enabled).CacheBehaviors.map((b: { PathPattern: string }) => b.PathPattern)).toEqual(['_app/*', '_data/*', 'api/*', 'auth/*', 'health']);
});

test('the API reference is deployed with the managed API origin filled in', () => {
  const sources = (t: Template) => Object.values(t.findResources('Custom::CDKBucketDeployment'))[0].Properties;
  expect(sources(template).SourceObjectKeys).toHaveLength(2);
  expect(JSON.stringify(sources(template).SourceMarkers)).not.toContain('{{FILES_API_URL}}');
  const enabled = Template.fromStack(new FileServerStack(new App(), 'FileServerDocs', {
    subdomain: 'files', frameAncestors: [], maxUploadBytes: 1024, microsoftApi: true,
    env: { account: '123456789012', region: 'eu-west-1' },
  }));
  const markers = JSON.stringify(sources(enabled).SourceMarkers);
  expect(markers).not.toContain('{{FILES_API_URL}}');
  expect(markers).toContain('MicrosoftApi');
});
