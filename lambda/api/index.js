'use strict';

const auth = require('./auth');
const apiAccess = require('./api-access');
const { loadConfig, NotConfigured } = require('./config');
const { BadRequest, Conflict, NotFound, createFiles } = require('./files');
const store = require('./store');
const ROUTES = require('./routes.json');

const SECURITY_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };
const MAX_BODY = 64 * 1024;

function json(statusCode, body, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: JSON.stringify(body),
  };
}

function redirect(location, cookies) {
  return { statusCode: 302, headers: { ...SECURITY_HEADERS, location }, ...(cookies ? { cookies } : {}), body: '' };
}

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function errorPage(statusCode, message, cookies) {
  return {
    statusCode,
    headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8' },
    ...(cookies ? { cookies } : {}),
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign-in problem · Files · dliu.com</title><link rel="icon" type="image/svg+xml" href="/_app/logo.svg">
<link rel="stylesheet" href="https://files.dliu.com/dliu.com/ui/v1/dl.css"><link rel="stylesheet" href="/_app/style.css"></head>
<body class="dl-page"><header class="dl-header">
<a class="dl-brand" href="/"><img class="dl-logo" src="/_app/logo.svg" alt="" width="32" height="32">Files</a><nav class="dl-nav" aria-label="Site"><a class="dl-button" href="/docs/api">Docs</a><a class="dl-button dl-signin" href="/auth/login">Sign in</a></nav></header>
<main class="dl-main dl-narrow"><h1>Sign-in problem</h1><p>${escapeHtml(message)}</p><p><a class="dl-button dl-button-primary" href="/auth/login">Try again</a></p></main>
<footer class="dl-footer"><a class="dl-footer-logo" href="https://dliu.com" aria-label="dliu.com"><img src="https://files.dliu.com/dliu.com/favicon.png" alt="" width="24" height="24"></a> <a href="https://dliu.com">dliu.com</a> · <a href="/">Files</a> · <a href="/docs/api">Docs</a></footer></body></html>`,
  };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > MAX_BODY) throw new BadRequest('Request too large');
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new BadRequest('Body must be a JSON object');
  }
}

let clients = {};
const client = (name, make) => clients[name] || (clients[name] = make());
const s3Client = () => client('s3', () => { const { S3Client } = require('@aws-sdk/client-s3'); return new S3Client({}); });

// Replacing, moving and deleting files drops the old copies from the CDN. The distribution ID is in SSM: the stack cannot pass it to this
// function directly, because the distribution itself points at this function.
async function invalidateWithCloudFront(paths) {
  const prefix = process.env.PARAMETER_PREFIX || '/files';
  const { SSMClient, GetParametersCommand } = require('@aws-sdk/client-ssm');
  const ssm = client('ssm', () => new SSMClient({}));
  const result = await ssm.send(new GetParametersCommand({ Names: [`${prefix}/distribution-id`] }));
  const distributionId = result.Parameters && result.Parameters[0] && result.Parameters[0].Value;
  if (!distributionId) {
    console.warn(JSON.stringify({ message: 'No distribution ID; skipped CDN invalidation', paths }));
    return;
  }
  const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
  const cloudfront = client('cloudfront', () => new CloudFrontClient({}));
  await cloudfront.send(new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: { CallerReference: `${Date.now()}-${Math.random()}`, Paths: { Quantity: paths.length, Items: paths } },
  }));
}

// Upload tokens are signed with a key derived from the website's Entra secret. Managed API requests load that
// configuration only for these actions, and never use it to authenticate the caller.
const UPLOAD_ACTIONS = new Set(['createUpload', 'signParts', 'completeUpload', 'abortUpload']);

function createHandler(deps = {}) {
  const getConfig = deps.loadConfig || loadConfig;
  const fetchImpl = deps.fetchImpl || ((...args) => fetch(...args));
  const clock = deps.now || Date.now;

  async function respond(route, path, event, session, config) {
    if (!route) return json(404, { error: 'Not found' });
    if (path === '/api/me') return json(200, { user: session.user, name: session.name });
    if (path === '/api/files') {
      const listing = await store.readListing(deps.s3 || s3Client(), process.env.FILE_BUCKET);
      return json(200, { files: listing.files, updatedAt: listing.updatedAt || null });
    }
    const files = createFiles({
      s3: deps.s3 || s3Client(),
      bucket: process.env.FILE_BUCKET,
      region: process.env.AWS_REGION,
      maxBytes: Number(process.env.MAX_UPLOAD_BYTES) || 50 * 1024 ** 3,
      tokenKey: config ? auth.uploadKey(config) : null,
      now: clock,
      invalidate: deps.invalidate || invalidateWithCloudFront,
    });
    return json(200, await files[route.action](parseBody(event)));
  }

  return async function handler(event) {
    const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'GET';
    const path = event.rawPath || '/';
    const params = event.queryStringParameters || {};
    const siteUrl = process.env.SITE_URL;
    const route = Object.hasOwn(ROUTES, `${method} ${path}`) ? ROUTES[`${method} ${path}`] : undefined;
    // The Microsoft API (API Gateway with a JWT authorizer) shares this function with the website's function URL,
    // whose events have routeKey "$default".
    const context = event.requestContext;
    const managedApi = Boolean(context && ((context.authorizer && context.authorizer.jwt) ||
      (context.apiId && context.routeKey !== '$default')));
    if (managedApi && !route) return json(404, { error: 'Not found' });
    if (!route && method !== 'GET') return json(405, { error: 'Method not allowed' });

    try {
      if (managedApi) {
        const session = apiAccess.authorize(event, route.scope);
        if (session.status) return json(session.status, { error: session.error });
        const config = UPLOAD_ACTIONS.has(route.action) ? await getConfig() : null;
        return await respond(route, path, event, session, config);
      }

      const config = await getConfig();

      if (path === '/auth/login') {
        const login = auth.startLogin(config, siteUrl, clock(), params.return);
        return redirect(login.location, login.cookies);
      }
      if (path === '/auth/callback') {
        const result = await auth.finishLogin(event, config, siteUrl, { fetchImpl, now: clock() });
        return result.location ? redirect(result.location, result.cookies) : errorPage(result.status, result.error, result.cookies);
      }
      if (path === '/auth/logout') return redirect('/', auth.logoutCookies());

      if (!path.startsWith('/api/')) return json(404, { error: 'Not found' });
      const session = auth.getSession(event, config, clock());
      // Clearing the hint cookie makes the pages hide the owner controls again.
      if (!session) return json(401, { error: 'Not signed in' }, auth.logoutCookies());

      if (route && route.action) {
        // Cross-site requests carry no session (SameSite=Lax); the Origin check is a second guard.
        const origin = (event.headers && event.headers.origin) || '';
        if (origin !== siteUrl) return json(403, { error: 'Forbidden' });
      }
      return await respond(route, path, event, session, config);
    } catch (error) {
      if (error instanceof BadRequest) return json(400, { error: error.message });
      if (error instanceof NotFound) return json(404, { error: error.message });
      if (error instanceof Conflict) return json(409, { error: error.message });
      if (error instanceof NotConfigured) {
        console.error(JSON.stringify({ message: 'Sign-in not configured', path, error: error.message }));
        const text = 'Sign-in is not configured yet. Run "make set-secrets".';
        return path.startsWith('/auth/') ? errorPage(503, text) : json(503, { error: text });
      }
      console.error(JSON.stringify({ message: 'Request failed', path, error: error.message, stack: error.stack }));
      if (path.startsWith('/auth/')) return errorPage(500, 'Something went wrong while signing in.');
      return json(500, { error: 'Internal error' });
    }
  };
}

module.exports = { createHandler, handler: createHandler() };
