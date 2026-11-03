const auth = require('../lambda/api/auth');
const { authorize, parseRoles } = require('../lambda/api/api-access');
const { createHandler } = require('../lambda/api/index');
const { LISTING_KEY } = require('../lambda/api/store');
const routes = require('../lambda/api/routes.json');
const { createFakeS3 } = require('./fake-s3');

// Synthetic identifiers only; no real tenant, client or user values.
const NOW = Date.UTC(2026, 9, 31, 12);
const TENANT = '11111111-1111-4111-8111-111111111111';
const AUDIENCE = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const SITE = 'https://files.dliu.com';
const config = { tenantId: 'website', clientId: 'website', clientSecret: 'secret', allowedDomain: 'example.com' };
const originalEnv = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, { API_GATEWAY_ID: 'test-api', API_TENANT_ID: TENANT, API_AUDIENCE: AUDIENCE,
    API_CLIENT_ID: CLIENT, SITE_URL: SITE, FILE_BUCKET: 'test-bucket', MAX_UPLOAD_BYTES: String(10 * 1024 ** 3),
    AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'secret' });
});
afterEach(() => { process.env = { ...originalEnv }; });

const cookie = () => `${auth.SESSION_COOKIE}=${auth.sign({ typ: 'session', user: 'owner@example.com', exp: NOW / 1000 + 300 }, auth.sessionKey(config))}`;

function event(method = 'GET', path = '/api/files', scopes = ['files.read'], body) {
  return {
    rawPath: path,
    headers: {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    requestContext: {
      apiId: 'test-api', routeKey: `${method} ${path}`, http: { method },
      authorizer: { jwt: { scopes, claims: { ver: '2.0', tid: TENANT, aud: AUDIENCE,
        iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, azp: CLIENT,
        oid: 'assigned-user', sub: 'subject', roles: ['api.access'], name: 'Test user' } } },
    },
  };
}

function setup() {
  const s3 = createFakeS3();
  const loadConfig = jest.fn(async () => config);
  const invalidated = [];
  const handler = createHandler({ loadConfig, s3, now: () => NOW, invalidate: async (paths) => { invalidated.push(...paths); } });
  const call = async (...args) => {
    const response = await handler(event(...args));
    return { ...response, json: JSON.parse(response.body) };
  };
  return { s3, loadConfig, handler, call, invalidated };
}

test('only the configured gateway and Microsoft v2 resource are trusted', () => {
  expect(authorize(event(), 'files.read')).toEqual({ user: 'assigned-user', name: 'Test user' });
  for (const claim of ['ver', 'tid', 'aud', 'iss', 'oid', 'sub']) {
    const request = event();
    delete request.requestContext.authorizer.jwt.claims[claim];
    expect(authorize(request, 'files.read').status).toBe(401);
  }
  for (const [claim, value] of [['ver', '1.0'], ['tid', AUDIENCE], ['aud', CLIENT], ['oid', ''], ['sub', 7],
    ['iss', `https://sts.windows.net/${TENANT}/`], ['iss', `https://login.microsoftonline.com/${AUDIENCE}/v2.0`]]) {
    const request = event();
    request.requestContext.authorizer.jwt.claims[claim] = value;
    expect(authorize(request, 'files.read').status).toBe(401);
  }
  const request = event();
  request.requestContext.apiId = 'other-api';
  expect(authorize(request, 'files.read').status).toBe(401);
  delete request.requestContext.authorizer;
  expect(authorize(request, 'files.read').status).toBe(401);
  delete request.requestContext;
  expect(authorize(request, 'files.read').status).toBe(401);
  for (const name of ['API_GATEWAY_ID', 'API_TENANT_ID', 'API_AUDIENCE', 'API_CLIENT_ID']) {
    const saved = process.env[name];
    delete process.env[name];
    expect(authorize(event(), 'files.read').status).toBe(401);
    process.env[name] = saved;
  }
});

test('client permission, user assignment and exact route scope are all required', () => {
  for (const change of [
    (jwt) => { jwt.claims.azp = 'other-client'; },
    (jwt) => { delete jwt.claims.azp; },
    (jwt) => { jwt.claims.roles = ['other.access']; },
    (jwt) => { jwt.claims.roles = ['video.access']; },
    // Retired per-site roles do not grant access, alone or together.
    (jwt) => { jwt.claims.roles = ['files.access']; },
    (jwt) => { jwt.claims.roles = '[files.access]'; },
    (jwt) => { jwt.claims.roles = '[files.access video.access]'; },
    (jwt) => { jwt.claims.roles = 'files.access'; },
    (jwt) => { jwt.claims.roles = '[API user]'; },
    (jwt) => { jwt.claims.roles = ['API user']; },
    (jwt) => { jwt.claims.roles = ['dliu API user']; },
    (jwt) => { jwt.claims.roles = ['API.ACCESS']; },
    (jwt) => { jwt.claims.roles = '[api.access]'; jwt.claims.azp = 'other-client'; jwt.scopes = ['files.read']; },
    (jwt) => { jwt.claims.roles = '[api.access files.access]'; jwt.scopes = ['video.read', 'files.write', 'files.delete']; },
    (jwt) => { delete jwt.claims.roles; },
    (jwt) => { jwt.claims.roles = '["other,api.access"]'; },
    (jwt) => { jwt.claims.roles = '[broken'; },
    (jwt) => { jwt.claims.roles = '[]'; },
    (jwt) => { jwt.claims.roles = '[other.access]'; },
    (jwt) => { jwt.claims.roles = '[api.access.admin]'; },
    (jwt) => { jwt.claims.roles = '[xapi.access]'; },
    (jwt) => { jwt.claims.roles = '[other,api.access]'; },
    (jwt) => { jwt.claims.roles = '[other  api.access]'; },
    (jwt) => { jwt.claims.roles = '[other\tapi.access]'; },
    (jwt) => { jwt.claims.roles = '["api.access" other]'; },
    (jwt) => { jwt.claims.roles = '[api.access'; },
    (jwt) => { jwt.claims.roles = 'api.access]'; },
    (jwt) => { jwt.claims.roles = 'other api.access'; },
    (jwt) => { jwt.claims.roles = 'api.access.admin'; },
    (jwt) => { jwt.claims.roles = '{"0":"api.access"}'; },
    (jwt) => { jwt.claims.roles = '[1]'; },
    (jwt) => { jwt.claims.roles = [['api.access']]; },
    (jwt) => { jwt.claims.roles = { 0: 'api.access', length: 1 }; },
    (jwt) => { jwt.claims.roles = '[api.access]'; jwt.claims.azp = 'other-client'; },
    (jwt) => { jwt.claims.roles = '[api.access]'; jwt.scopes = ['files.write']; },
    (jwt) => { jwt.scopes = ['files.write']; },
    (jwt) => { jwt.scopes = ['files.read.all']; },
    (jwt) => { jwt.scopes = ['video.read']; },
    (jwt) => { jwt.scopes = 'files.read'; },
    (jwt) => { delete jwt.scopes; },
  ]) {
    const request = event();
    change(request.requestContext.authorizer.jwt);
    expect(authorize(request, 'files.read').status).toBe(403);
  }
  for (const roles of ['api.access', '["api.access"]', '[api.access]', '[other.access api.access]']) {
    const request = event();
    request.requestContext.authorizer.jwt.claims.roles = roles;
    expect(authorize(request, 'files.read').user).toBe('assigned-user');
  }
});

test('roles arrive from API Gateway as a bracketed, space-separated string and are matched exactly', () => {
  expect(parseRoles('[api.access]')).toEqual(['api.access']);
  expect(parseRoles('[a.b api.access c-d]')).toEqual(['a.b', 'api.access', 'c-d']);
  expect(parseRoles('[]')).toEqual([]);
  expect(parseRoles(['api.access'])).toEqual(['api.access']);
  expect(parseRoles('["api.access"]')).toEqual(['api.access']);
  for (const bad of [undefined, null, 1, '', ' ', '[ api.access]', '[api.access ]', '[a  b]', '[a\nb]', '["a"', '[1]x',
    'a b', '"api.access"', [1], {}]) {
    expect(parseRoles(bad)).toBeNull();
  }
});

test('the shared SPA client and resource ID still require exact gateway, audience, client, role and scope', () => {
  process.env.API_CLIENT_ID = AUDIENCE;
  const shared = () => {
    const request = event();
    request.requestContext.authorizer.jwt.claims.azp = AUDIENCE;
    return request;
  };
  expect(authorize(shared(), 'files.read')).toEqual({ user: 'assigned-user', name: 'Test user' });
  for (const [change, status] of [
    [(request) => { request.requestContext.apiId = 'other-api'; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.claims.aud = CLIENT; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.claims.azp = CLIENT; }, 403],
    [(request) => { delete request.requestContext.authorizer.jwt.claims.roles; }, 403],
    [(request) => { delete request.requestContext.authorizer.jwt.claims.oid; }, 401],
    [(request) => { request.requestContext.authorizer.jwt.scopes = ['files.write']; }, 403],
    [(request) => { request.requestContext.authorizer.jwt.scopes = ['.default']; }, 403],
  ]) {
    const request = shared();
    change(request);
    expect(authorize(request, 'files.read').status).toBe(status);
  }
  expect(authorize(shared(), 'files.delete').status).toBe(403);
});

test('the shared api.access role is not a scope bypass on any route', async () => {
  const { handler, s3 } = setup();
  for (const route of Object.keys(routes)) {
    const [method, path] = route.split(' ');
    for (const scopes of [[], ['.default'], ['video.read', 'video.write', 'video.delete'], ['api.access']]) {
      const request = event(method, path, scopes, {});
      request.requestContext.authorizer.jwt.claims.roles = '[api.access]';
      expect([route, (await handler(request)).statusCode]).toEqual([route, 403]);
    }
  }
  expect(s3.calls).toEqual([]);
});

test('each route needs exactly its own scope: read cannot write, write cannot delete', async () => {
  const { call, s3 } = setup();
  const bodies = {
    'POST /api/uploads': { path: 'a.txt', size: 1 },
    'POST /api/files/move': { from: 'a.txt', to: 'b.txt' },
    'POST /api/files/delete': { path: 'a.txt' },
  };
  for (const [route, { scope }] of Object.entries(routes)) {
    const [method, path] = route.split(' ');
    for (const other of ['files.read', 'files.write', 'files.delete'].filter((name) => name !== scope)) {
      const denied = await call(method, path, [other], bodies[route] || {});
      expect([route, denied.statusCode, denied.json]).toEqual([route, 403, { error: 'Files API permission required' }]);
    }
  }
  expect(s3.calls).toEqual([]);
});

test('a bearer client can upload, list, move and delete without Origin or cookies', async () => {
  const { call, s3, loadConfig, invalidated } = setup();
  s3.completedSize = 5;
  const started = await call('POST', '/api/uploads', ['files.write'], { path: 'agent/notes.txt', size: 5, contentType: 'text/plain' });
  expect(started.statusCode).toBe(200);
  expect(started.json).toMatchObject({ path: 'agent/notes.txt', partCount: 1, replacing: false });
  const parts = await call('POST', '/api/uploads/parts', ['files.write'], { token: started.json.token, parts: [1] });
  expect(Object.keys(parts.json.urls)).toEqual(['1']);
  const done = await call('POST', '/api/uploads/complete', ['files.write'],
    { token: started.json.token, parts: [{ partNumber: 1, etag: `"${'a'.repeat(32)}"` }] });
  expect(done.json.file).toEqual({ path: 'agent/notes.txt', size: 5, type: 'text/plain', modified: new Date(NOW).toISOString() });
  expect((await call('POST', '/api/uploads/abort', ['files.write'], { token: started.json.token })).json).toEqual({ aborted: true });

  const list = await call('GET', '/api/files', ['files.read']);
  expect(list.json).toEqual({ files: [done.json.file], updatedAt: new Date(NOW).toISOString() });
  expect(list.json).toEqual(s3.json(LISTING_KEY));

  const replace = await call('POST', '/api/uploads', ['files.write'], { path: 'agent/notes.txt', size: 5 });
  expect(replace.statusCode).toBe(409);
  const moved = await call('POST', '/api/files/move', ['files.write'], { from: 'agent', to: 'shared' });
  expect(moved.json).toEqual({ moved: [{ from: 'agent/notes.txt', to: 'shared/notes.txt' }] });
  const deleted = await call('POST', '/api/files/delete', ['files.delete'], { path: 'shared' });
  expect(deleted.json).toEqual({ deleted: ['shared/notes.txt'] });
  expect(invalidated).toEqual(['/agent/*', '/shared/*']);
  expect((await call('POST', '/api/files/delete', ['files.delete'], { path: 'shared' })).statusCode).toBe(404);

  // Website configuration is loaded only to sign and verify upload tokens.
  expect(loadConfig).toHaveBeenCalledTimes(5);
});

test('the managed API may write, move and delete the shared dliu.com/ assets', async () => {
  const { call, s3 } = setup();
  s3.completedSize = 9;
  // Upload a shared asset the website cannot touch.
  const started = await call('POST', '/api/uploads', ['files.write'], { path: 'dliu.com/ui/v1/dl.css', size: 9, contentType: 'text/css' });
  expect(started.statusCode).toBe(200);
  expect(started.json).toMatchObject({ path: 'dliu.com/ui/v1/dl.css', replacing: false });
  const done = await call('POST', '/api/uploads/complete', ['files.write'],
    { token: started.json.token, parts: [{ partNumber: 1, etag: `"${'a'.repeat(32)}"` }] });
  expect(done.json.file.path).toBe('dliu.com/ui/v1/dl.css');
  // Move and delete under dliu.com/ also work for the managed API.
  const moved = await call('POST', '/api/files/move', ['files.write'], { from: 'dliu.com/ui/v1/dl.css', to: 'dliu.com/ui/v1/dl2.css' });
  expect(moved.json).toEqual({ moved: [{ from: 'dliu.com/ui/v1/dl.css', to: 'dliu.com/ui/v1/dl2.css' }] });
  expect((await call('POST', '/api/files/delete', ['files.delete'], { path: 'dliu.com/ui/v1/dl2.css' })).json)
    .toEqual({ deleted: ['dliu.com/ui/v1/dl2.css'] });
});

test('the managed API still cannot write the site code or docs paths', async () => {
  const { call } = setup();
  for (const path of ['_app/app.js', '_data/files.json', 'api/x', 'auth/x', 'index.html', 'docs/api']) {
    const result = await call('POST', '/api/uploads', ['files.write'], { path, size: 1, contentType: 'text/plain' });
    expect(result.statusCode).toBe(400);
  }
});

test('reads, moves and deletes never load website configuration', async () => {
  const s3 = createFakeS3();
  const loadConfig = jest.fn(() => { throw new Error('Must not load website configuration'); });
  const handler = createHandler({ loadConfig, s3, now: () => NOW, invalidate: async () => {} });
  expect((await handler(event('GET', '/api/me'))).statusCode).toBe(200);
  expect((await handler(event('GET', '/api/files'))).statusCode).toBe(200);
  expect((await handler(event('POST', '/api/files/move', ['files.write'], { from: 'a', to: 'b' }))).statusCode).toBe(404);
  expect((await handler(event('POST', '/api/files/delete', ['files.delete'], { path: 'a' }))).statusCode).toBe(404);
  expect(loadConfig).not.toHaveBeenCalled();
});

test('upload tokens are checked on the managed API too', async () => {
  const { call } = setup();
  const forged = auth.sign({ path: 'x.txt', uploadId: 'u', partCount: 1, exp: NOW / 1000 + 60 }, Buffer.alloc(32));
  for (const token of [forged, 'garbage', undefined]) {
    const result = await call('POST', '/api/uploads/parts', ['files.write'], { token, parts: [1] });
    expect(result.statusCode).toBe(404);
  }
});

test('managed requests never accept cookies as a fallback or set cookies', async () => {
  const { handler, loadConfig } = setup();
  const request = event('GET', '/api/me');
  expect(JSON.parse((await handler(request)).body).user).toBe('assigned-user');
  request.requestContext.authorizer.jwt.scopes = [];
  request.cookies = [cookie()];
  const denied = await handler(request);
  expect(denied.statusCode).toBe(403);
  expect(denied.cookies).toBeUndefined();
  delete request.requestContext.authorizer;
  const missing = await handler(request);
  expect(missing.statusCode).toBe(401);
  expect(missing.cookies).toBeUndefined();
  const upload = event('POST', '/api/uploads', ['files.write'], { path: 'a.txt', size: 1 });
  delete upload.requestContext.authorizer;
  upload.cookies = [cookie()];
  upload.headers.origin = SITE;
  expect((await handler(upload)).statusCode).toBe(401);
  expect(loadConfig).not.toHaveBeenCalled();
});

test('warm managed invocations do not retain bearer tokens, reuse an identity or log headers', async () => {
  const s3 = createFakeS3();
  const handler = createHandler({ loadConfig: async () => config, s3, now: () => NOW });
  const logs = ['error', 'warn', 'log'].map((name) => jest.spyOn(console, name).mockImplementation(() => {}));
  const marker = 'synthetic-bearer-retention-marker';
  let headerReads = 0;
  const request = (path = '/api/me') => {
    const value = event('GET', path);
    Object.defineProperty(value.headers, 'authorization', {
      enumerable: true, get() { headerReads += 1; return `Bearer ${marker}`; },
    });
    return value;
  };
  try {
    const first = await handler(request());
    expect(JSON.parse(first.body).user).toBe('assigned-user');
    const another = request();
    another.requestContext.authorizer.jwt.claims.oid = 'another-user';
    expect(JSON.parse((await handler(another)).body).user).toBe('another-user');
    const unsigned = request();
    delete unsigned.requestContext.authorizer;
    const denied = await handler(unsigned);
    expect(denied.statusCode).toBe(401);
    s3.send = jest.fn(async () => { throw new Error('Synthetic storage failure'); });
    const failed = await handler(request('/api/files'));
    expect(failed.statusCode).toBe(500);
    for (const response of [first, denied, failed]) {
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.cookies).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain(marker);
    }
    expect(headerReads).toBe(0);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(marker);
  } finally { logs.forEach((log) => log.mockRestore()); }
});

test('the HTTP API has no login, logout or unknown routes, and the function URL stays on website auth', async () => {
  const { handler } = setup();
  for (const [method, path] of [['GET', '/auth/login'], ['GET', '/auth/callback'], ['GET', '/auth/logout'],
    ['GET', '/api/unknown'], ['PUT', '/api/files'], ['GET', '/api/files/delete']]) {
    expect((await handler(event(method, path))).statusCode).toBe(404);
  }
  const request = event('GET', '/auth/login');
  request.requestContext = { apiId: 'function-url-id', routeKey: '$default',
    domainName: 'example.lambda-url.eu-west-1.on.aws', http: { method: 'GET' }, authorizer: { iam: {} } };
  expect((await handler(request)).statusCode).toBe(302);
  request.rawPath = '/api/files';
  request.headers = { 'x-jwt-claims': JSON.stringify(event().requestContext.authorizer.jwt.claims), authorization: 'Bearer synthetic' };
  expect((await handler(request)).statusCode).toBe(401);
  request.cookies = [cookie()];
  expect((await handler(request)).statusCode).toBe(200);
  request.rawPath = '/api/uploads';
  request.requestContext.http.method = 'POST';
  request.body = '{}';
  expect((await handler(request)).statusCode).toBe(403);
});

test('production-shaped gateway events (shared client, bracketed roles) reach /api/me and /api/files; wrong role does not', async () => {
  process.env.API_CLIENT_ID = AUDIENCE;
  const { handler } = setup();
  const gatewayEvent = (path, roles) => {
    const request = event('GET', path);
    Object.assign(request.requestContext.authorizer.jwt.claims, { azp: AUDIENCE, roles, scp: 'files.delete files.read files.write' });
    request.requestContext.authorizer.jwt.scopes = ['files.delete', 'files.read', 'files.write'];
    return request;
  };
  const me = await handler(gatewayEvent('/api/me', '[api.access]'));
  expect(me.statusCode).toBe(200);
  expect(JSON.parse(me.body)).toEqual({ user: 'assigned-user', name: 'Test user' });
  const list = await handler(gatewayEvent('/api/files', '[api.access video.access]'));
  expect(JSON.parse(list.body)).toEqual({ files: [], updatedAt: null });
  for (const roles of ['[other.access]', '[api.access.extra]', '[video.access]', '[files.access]', '[files.access video.access]', '[]']) {
    const denied = await handler(gatewayEvent('/api/files', roles));
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).error).toBe('Files API permission required');
  }
});
