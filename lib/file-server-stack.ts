import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_iam as iam,
  aws_lambda as lambda,
  aws_logs as logs,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
  aws_s3_deployment as s3deploy,
  aws_ssm as ssm,
  Annotations,
  CfnOutput,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps,
} from 'aws-cdk-lib';

const ROOT = path.join(__dirname, '..');
export const PARAMETER_PREFIX = '/files';

export interface FileServerStackProps extends StackProps {
  /** Subdomain under the MainDomain export. */
  subdomain: string;
  /** Other sites allowed to show files and folders in an iframe (CSP frame-ancestors). */
  frameAncestors: string[];
  /** Largest file the upload page accepts. */
  maxUploadBytes: number;
}

// Everything here is pay-per-use: S3, CloudFront, one Lambda behind a function URL, a CloudFront Function and
// standard SSM parameters. Nothing runs while nobody uses the site; idle cost is the S3 storage of the files.
export class FileServerStack extends Stack {
  constructor(scope: Construct, id: string, props: FileServerStackProps) {
    super(scope, id, props);

    const rootDomain = Fn.importValue('MainDomain');
    const domainName = Fn.join('', [`${props.subdomain}.`, rootDomain]);
    const siteUrl = Fn.join('', ['https://', domainName]);
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'ImportedHostedZone', {
      zoneName: rootDomain,
      hostedZoneId: Fn.importValue('MainHostedZoneId'),
    });

    // ---------- Storage ----------
    // One bucket: files at their own paths, the site under _app/ and the file listing under _data/.
    const fileBucket = new s3.Bucket(this, 'FileBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      // Deleted and replaced files can be restored for 30 days.
      versioned: true,
      // The upload page sends files straight to S3 with presigned URLs.
      cors: [{
        allowedOrigins: [siteUrl],
        allowedMethods: [s3.HttpMethods.PUT],
        allowedHeaders: ['*'],
        exposedHeaders: ['ETag'],
        maxAge: 3600,
      }],
      lifecycleRules: [
        { id: 'abort-unfinished-uploads', abortIncompleteMultipartUploadAfter: Duration.days(2) },
        { id: 'expire-old-versions', noncurrentVersionExpiration: Duration.days(30) },
        { id: 'remove-delete-markers', expiredObjectDeleteMarker: true },
      ],
    });

    // ---------- API (sign-in and owner actions only; visitors never call it) ----------
    const api = new lambda.Function(this, 'ApiHandler', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'index.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/api')),
      // Moving a large folder copies every file inside S3.
      timeout: Duration.seconds(60),
      memorySize: 256,
      description: 'files.dliu.com sign-in (Microsoft Entra) and upload/move/delete API',
      environment: {
        SITE_URL: siteUrl,
        ROOT_DOMAIN: rootDomain,
        PARAMETER_PREFIX,
        FILE_BUCKET: fileBucket.bucketName,
        MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
      },
      logGroup: new logs.LogGroup(this, 'ApiLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    fileBucket.grantReadWrite(api);
    fileBucket.grantDelete(api);
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameters'],
      resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
    }));
    api.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Decrypt'],
      resources: ['*'],
      conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
    }));
    const functionUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- CDN ----------
    // CloudFront requires its certificate in us-east-1 (same pattern as the other sites).
    const certificate = new acm.DnsValidatedCertificate(this, 'FileServerCertificate', {
      domainName,
      hostedZone,
      region: 'us-east-1',
    });

    // Pages and files share one origin and one policy. Scripts may only come from the site's own _app/ folder,
    // so an uploaded HTML or SVG file cannot run code on this origin.
    const headers = new cloudfront.ResponseHeadersPolicy(this, 'SiteHeaders', {
      securityHeadersBehavior: {
        contentSecurityPolicy: {
          contentSecurityPolicy: Fn.join('; ', [
            "default-src 'self'",
            Fn.join('', ['script-src ', siteUrl, '/_app/']),
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:",
            `connect-src 'self' https://${fileBucket.bucketRegionalDomainName}`,
            `frame-ancestors ${["'self'", ...props.frameAncestors].join(' ')}`,
            "base-uri 'none'",
            "form-action 'none'",
          ]),
          override: true,
        },
        contentTypeOptions: { override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: false, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()', override: true }],
      },
    });

    // Central traffic monitoring (dliu-com/traffic-monitor): shared visitor cookie and city logging.
    const visitorId = cloudfront.Function.fromFunctionAttributes(this, 'VisitorId', {
      functionArn: Fn.importValue('TrafficVisitorFunctionArn'),
      functionName: 'dliu-visitor-id',
    });
    const trafficGeo = cloudfront.OriginRequestPolicy.fromOriginRequestPolicyId(
      this, 'TrafficGeo', Fn.importValue('TrafficGeoOriginRequestPolicyId'));

    const pagesFunction = new cloudfront.Function(this, 'PagesFunction', {
      comment: 'Serves the file browser for / and every folder URL (ending in /)',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromFile({ filePath: path.join(ROOT, 'functions/pages.js') }),
    });

    // LIST makes S3 answer 404 (not 403) for missing files, so CloudFront can show the not-found page.
    // The bucket root, which would be the S3 listing, is never requested: the pages function rewrites "/".
    const fileOrigin = origins.S3BucketOrigin.withOriginAccessControl(fileBucket, {
      originAccessLevels: [cloudfront.AccessLevel.READ, cloudfront.AccessLevel.LIST],
    });
    const staticBehavior: cloudfront.BehaviorOptions = {
      origin: fileOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      responseHeadersPolicy: headers,
      compress: true,
    };
    // The listing is written with Cache-Control: no-cache, so changes show at once.
    const dataCache = new cloudfront.CachePolicy(this, 'DataCache', {
      comment: 'files.dliu.com listing JSON: honour origin no-cache',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.days(1),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout: Duration.seconds(60) }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
    };

    const distribution = new cloudfront.Distribution(this, 'FileServerDistribution', {
      comment: 'files.dliu.com',
      // Files and folder pages: cached at the edge; S3 answers range requests.
      defaultBehavior: {
        ...staticBehavior,
        originRequestPolicy: trafficGeo,
        functionAssociations: [
          { function: pagesFunction, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
          { function: visitorId, eventType: cloudfront.FunctionEventType.VIEWER_RESPONSE },
        ],
      },
      additionalBehaviors: {
        '_app/*': staticBehavior,
        '_data/*': { ...staticBehavior, cachePolicy: dataCache },
        'api/*': { ...apiBehavior, allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL },
        'auth/*': apiBehavior,
      },
      // Missing files and folder URLs without the trailing slash get the file browser, which shows
      // "not found" or opens the folder.
      errorResponses: [{
        httpStatus: 404,
        responseHttpStatus: 404,
        responsePagePath: '/_app/index.html',
        ttl: Duration.seconds(10),
      }],
      // The pages function already rewrites "/"; this also keeps the bucket listing (LIST access) out of reach.
      defaultRootObject: '_app/index.html',
      domainNames: [domainName],
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
    });
    Annotations.of(distribution).acknowledgeWarning('@aws-cdk/aws-cloudfront-origins:listBucketSecurityRisk',
      'The bucket root is never requested: the pages function rewrites "/" and defaultRootObject is set.');
    // IncludeCookies is the only legacy logging setting v2 honours: it puts the dl_vid cookie in the logs.
    (distribution.node.defaultChild as cloudfront.CfnDistribution)
      .addPropertyOverride('DistributionConfig.Logging', { IncludeCookies: true });

    // New function URLs require both invoke permissions. CDK adds InvokeFunctionUrl.
    api.addPermission('CloudFrontInvokeFunction', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: distribution.distributionArn,
      invokedViaFunctionUrl: true,
    });

    // Replacing, moving and deleting files invalidates the CDN. A separate policy (not the role's default one)
    // and an SSM parameter keep the function from depending on the distribution, which depends on the function.
    new ssm.StringParameter(this, 'DistributionIdParameter', {
      parameterName: `${PARAMETER_PREFIX}/distribution-id`,
      stringValue: distribution.distributionId,
      description: 'files.dliu.com CloudFront distribution, for invalidating changed files',
    });
    new iam.Policy(this, 'InvalidatePolicy', {
      roles: [api.role!],
      statements: [new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [distribution.distributionArn] })],
    });

    new s3deploy.BucketDeployment(this, 'SiteContent', {
      sources: [s3deploy.Source.asset(path.join(ROOT, 'web'))],
      destinationBucket: fileBucket,
      // Pruning only touches this prefix, never the files.
      destinationKeyPrefix: '_app/',
      // Browsers and CloudFront revalidate on every load (a 304 when unchanged), so a deploy shows up at once.
      cacheControl: [s3deploy.CacheControl.noCache()],
    });

    new route53.ARecord(this, 'FileServerAliasRecord', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });
    new route53.AaaaRecord(this, 'FileServerAliasIpv6Record', {
      recordName: props.subdomain,
      zone: hostedZone,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    new CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new CfnOutput(this, 'AuthRedirectUri', { value: Fn.join('', [siteUrl, '/auth/callback']) });
    new CfnOutput(this, 'FileBucketName', { value: fileBucket.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'ApiFunctionName', { value: api.functionName });
  }
}
