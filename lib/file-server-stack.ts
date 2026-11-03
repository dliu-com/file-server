import * as fs from 'fs';
import * as path from 'path';
import { Construct } from 'constructs';
import {
  aws_apigatewayv2 as apigateway,
  aws_apigatewayv2_authorizers as authorizers,
  aws_apigatewayv2_integrations as integrations,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_events as events,
  aws_events_targets as eventTargets,
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
import apiRoutes from '../lambda/api/routes.json';

const ROOT = path.join(__dirname, '..');
export const PARAMETER_PREFIX = '/files';
/** Replaced at deploy time in web/docs/api.md with the managed API's actual origin. */
export const API_URL_PLACEHOLDER = '{{FILES_API_URL}}';

export interface FileServerStackProps extends StackProps {
  /** Subdomain under the MainDomain export. */
  subdomain: string;
  /** Other sites allowed to show files and folders in an iframe (CSP frame-ancestors). */
  frameAncestors: string[];
  /** Largest file the upload page accepts. */
  maxUploadBytes: number;
  /**
   * Adds the managed API: an HTTP API that accepts Microsoft-issued access tokens for the shared dliu API
   * registration. Needs the /files/api-tenant-id, /files/api-audience and /files/api-client-id SSM parameters.
   */
  microsoftApi?: boolean;
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
      // Every change is sent to EventBridge, so files changed outside the app are cleared from the CDN too.
      eventBridgeEnabled: true,
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

    // ---------- API Lambdas ----------
    // Two functions run the same code (lambda/api) with different IAM roles, so the write-protection for the
    // shared dliu.com/ assets can differ by entry point:
    //   - the website function (Function URL, cookie sign-in) is denied writing dliu.com/* as well as _app/*;
    //   - the managed-API function (auth.dliu.com Microsoft tokens) may write dliu.com/* so the listing stays
    //     accurate, but is still denied _app/*.
    // cleanPath enforces the same split in code (store.SHARED, allowShared); the IAM Deny is the backstop.
    const apiCode = lambda.Code.fromAsset(path.join(ROOT, 'lambda/api'));
    const baseEnv: Record<string, string> = {
      SITE_URL: siteUrl,
      ROOT_DOMAIN: rootDomain,
      PARAMETER_PREFIX,
      FILE_BUCKET: fileBucket.bucketName,
      MAX_UPLOAD_BYTES: String(props.maxUploadBytes),
    };
    const makeApi = (id: string, logsId: string, description: string, denyShared: boolean, extraEnv: Record<string, string> = {}) => {
      const fn = new lambda.Function(this, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: 'index.handler',
        code: apiCode,
        // Moving a large folder copies every file inside S3.
        timeout: Duration.seconds(60),
        memorySize: 256,
        // A denial-of-wallet cap: bounds Lambda spend if the entry point is ever flooded (matches the other
        // dliu.com sites). The managed API is also throttled at the gateway.
        reservedConcurrentExecutions: 10,
        description,
        environment: { ...baseEnv, ...extraEnv },
        logGroup: new logs.LogGroup(this, logsId, {
          retention: logs.RetentionDays.THREE_MONTHS,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
      });
      fileBucket.grantReadWrite(fn);
      fileBucket.grantDelete(fn);
      // Backstop to cleanPath: the role must never change the site's own code (_app/). The website role is also
      // denied the shared dliu.com/ assets every dliu.com site loads; the managed-API role may write them so the
      // listing (_data/, not under these prefixes) stays accurate. An explicit Deny wins over the grants above.
      const denied = [fileBucket.arnForObjects('_app/*')];
      if (denyShared) denied.push(fileBucket.arnForObjects('dliu.com/*'));
      fn.addToRolePolicy(new iam.PolicyStatement({
        effect: iam.Effect.DENY,
        actions: ['s3:PutObject', 's3:DeleteObject', 's3:AbortMultipartUpload'],
        resources: denied,
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['ssm:GetParameters'],
        resources: [this.formatArn({ service: 'ssm', resource: 'parameter', resourceName: PARAMETER_PREFIX.slice(1) + '/*' })],
      }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['kms:Decrypt'],
        resources: ['*'],
        conditions: { StringEquals: { 'kms:ViaService': `ssm.${this.region}.amazonaws.com` } },
      }));
      return fn;
    };

    // Website: sign-in and owner actions only; visitors never call it. Denied dliu.com/* (view-only here).
    const api = makeApi('ApiHandler', 'ApiLogs',
      'files.dliu.com sign-in (Microsoft Entra) and website upload/move/delete API', true);
    const functionUrl = api.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    // ---------- Managed API (Microsoft access tokens for tools and agents; separate from website sign-in) ----------
    // API Gateway validates Microsoft's signature, issuer, audience, expiry and each route's delegated scope;
    // the Lambda then checks the gateway, tenant, approved client, shared api.access user role and scope again.
    let managedApiUrl: string | undefined;
    if (props.microsoftApi) {
      const parameter = (name: string) => ssm.StringParameter.valueForStringParameter(this, `${PARAMETER_PREFIX}/api-${name}`);
      const tenantId = parameter('tenant-id');
      const audience = parameter('audience');
      const clientId = parameter('client-id');
      const httpApi = new apigateway.HttpApi(this, 'MicrosoftApi', {
        description: 'Files API: Microsoft Entra access tokens, delegated permissions and assigned users',
      });
      // A separate function and role for the managed API: it may write the shared dliu.com/ assets (so the
      // listing stays accurate) while the website function above keeps its dliu.com/* Deny. Both are still
      // denied _app/*. This handler never serves the website's Function URL, cookie sign-in or /health.
      const managedApi = makeApi('ManagedApiHandler', 'ManagedApiLogs',
        'files.dliu.com managed API (auth.dliu.com Microsoft tokens): upload/move/delete, including dliu.com/', false, {
          API_GATEWAY_ID: httpApi.apiId,
          API_TENANT_ID: tenantId,
          API_AUDIENCE: audience,
          API_CLIENT_ID: clientId,
        });
      const authorizer = new authorizers.HttpJwtAuthorizer('MicrosoftJwt',
        Fn.join('', ['https://login.microsoftonline.com/', tenantId, '/v2.0']), { jwtAudience: [audience] });
      const integration = new integrations.HttpLambdaIntegration('FilesApi', managedApi);
      for (const [route, permission] of Object.entries(apiRoutes)) {
        const [method, routePath] = route.split(' ');
        httpApi.addRoutes({
          path: routePath,
          methods: [apigateway.HttpMethod[method as 'GET' | 'POST']],
          integration,
          authorizer,
          authorizationScopes: [permission.scope],
        });
      }
      // Throttle the managed API so a stolen or misused token cannot drive unbounded cost (matches the
      // other dliu.com sites). Legitimate tool and agent use stays well under this.
      const defaultStage = httpApi.defaultStage!.node.defaultChild as apigateway.CfnStage;
      defaultStage.defaultRouteSettings = { throttlingRateLimit: 10, throttlingBurstLimit: 20 };
      managedApiUrl = httpApi.apiEndpoint;
      new CfnOutput(this, 'MicrosoftApiUrl', { value: managedApiUrl });
    }

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
      comment: 'Serves the file browser for / and every folder URL (ending in /), and the API reference',
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
    // /health is public and read only. Cache it 60s and forward no cookies, Authorization header or query string to
    // the origin, so the check cannot be influenced by the caller and the Lambda runs at most about once a minute.
    const healthCache = new cloudfront.CachePolicy(this, 'HealthCache', {
      comment: 'files.dliu.com /health: cache 60s, key on nothing',
      minTtl: Duration.seconds(0),
      defaultTtl: Duration.seconds(60),
      maxTtl: Duration.seconds(60),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });
    const functionOrigin = origins.FunctionUrlOrigin.withOriginAccessControl(functionUrl, { readTimeout: Duration.seconds(60) });
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: functionOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      responseHeadersPolicy: headers,
    };
    // No origin request policy: CloudFront forwards no cookies, Authorization header or query string to the origin.
    const healthBehavior: cloudfront.BehaviorOptions = {
      origin: functionOrigin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: healthCache,
      responseHeadersPolicy: headers,
      compress: true,
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
        'health': healthBehavior,
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
      // Every edge location and HTTP/3, for the lowest latency worldwide (other sites embed these files).
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
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

    // Files are cached at CloudFront for a day. Replacing or deleting one in S3 by any route (this site, the S3 console,
    // a script) clears CloudFront's copy within seconds. New files, the site's own _app/ and _data/, and lifecycle
    // clean-up are skipped, so only real changes use the account's 1,000 free invalidation paths a month.
    const clearFunction = new lambda.Function(this, 'ClearChangedFiles', {
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'clear.handler',
      code: lambda.Code.fromAsset(path.join(ROOT, 'lambda/api')),
      timeout: Duration.seconds(30),
      memorySize: 128,
      description: 'files.dliu.com: clears CloudFront copies of files replaced or deleted in S3',
      environment: { FILE_BUCKET: fileBucket.bucketName, DISTRIBUTION_ID: distribution.distributionId },
      logGroup: new logs.LogGroup(this, 'ClearLogs', {
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
    });
    clearFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['s3:ListBucketVersions'], resources: [fileBucket.bucketArn] }));
    clearFunction.addToRolePolicy(new iam.PolicyStatement({ actions: ['cloudfront:CreateInvalidation'], resources: [distribution.distributionArn] }));
    new events.Rule(this, 'FileChangedRule', {
      description: 'files.dliu.com: a file was written or deleted in the file bucket',
      eventPattern: {
        source: ['aws.s3'],
        detailType: ['Object Created', 'Object Deleted'],
        detail: {
          bucket: { name: [fileBucket.bucketName] },
          object: { key: events.Match.anythingButPrefix('_') },
        },
      },
      targets: [new eventTargets.LambdaFunction(clearFunction, { retryAttempts: 4, maxEventAge: Duration.hours(1) })],
    });

    // The API reference names the managed API's actual origin, which is known only at deploy time.
    const apiReference = fs.readFileSync(path.join(ROOT, 'web/docs/api.md'), 'utf8');
    if (!apiReference.includes(API_URL_PLACEHOLDER)) throw new Error(`web/docs/api.md must contain ${API_URL_PLACEHOLDER}`);
    new s3deploy.BucketDeployment(this, 'SiteContent', {
      sources: [
        s3deploy.Source.asset(path.join(ROOT, 'web'), { exclude: ['docs/api.md'] }),
        // Source.data resolves the embedded API URL token at deploy time.
        s3deploy.Source.data('docs/api.md', apiReference.split(API_URL_PLACEHOLDER).join(managedApiUrl || '(not deployed)')),
      ],
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
