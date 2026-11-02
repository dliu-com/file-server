const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawnSync } = require('child_process');
const routes = require('../lambda/api/routes.json');
const auth = require('../lambda/api/auth');
const { partPlan } = require('../lambda/api/files');
const { createHandler } = require('../lambda/api/index');
const { createFakeS3 } = require('./fake-s3');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const markdown = read('web/docs/api.md');
const blocks = (text, language) => [...text.matchAll(new RegExp('```' + language + '\\n([\\s\\S]*?)\\n```', 'g'))].map((match) => match[1]);
const endpoints = [...markdown.matchAll(/^### (GET|POST) (\/api\/\S+)\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm)];
const examples = Object.fromEntries(endpoints.map((match) => [
  `${match[1]} ${match[2]}`, blocks(match[3], 'json').map((text) => JSON.parse(text)),
]));

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(name, value) { this.attributes[name] = value; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
}
const el = (tag, attrs = {}, ...children) => {
  const node = new Element(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
};
const walk = (node) => [node, ...node.children.filter((child) => child instanceof Element).flatMap(walk)];

function renderer() {
  const context = { el, renderNav: jest.fn(), document: { getElementById: () => null }, fetch: jest.fn() };
  vm.runInNewContext(read('web/docs-api.js').replace(/^import .*;$/gm, '').replace(/^export /gm, ''), context);
  return context;
}

test('the reference documents exactly the managed routes and their route scopes', () => {
  expect(endpoints.map((match) => `${match[1]} ${match[2]}`)).toEqual(Object.keys(routes));
  for (const match of endpoints) {
    const route = `${match[1]} ${match[2]}`;
    expect(match[3]).toContain(`Required scope: \`${routes[route].scope}\``);
    expect(match[3]).toContain('Response (200)');
    expect(examples[route]).toHaveLength(match[1] === 'GET' ? 1 : 2);
  }
  const summary = markdown.split('## Endpoint summary\n')[1].split('\n## ')[0];
  for (const [route, { scope }] of Object.entries(routes)) {
    const anchor = route.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    expect(summary).toContain(`| [${route}](#${anchor}) | \`${scope}\` |`);
  }
  expect(partPlan(examples['POST /api/uploads'][0].size)).toEqual({
    partSize: examples['POST /api/uploads'][1].partSize, partCount: examples['POST /api/uploads'][1].partCount,
  });
  expect(require('../config/site.json').maxUploadGiB).toBe(50);
  expect(markdown).toContain('53,687,091,200 bytes');
  expect(markdown).toContain('`docs/api` and `docs/api.md`');
});

test('the managed API origin is a deploy-time placeholder, never a hardcoded gateway or the website', () => {
  expect(markdown.split('{{FILES_API_URL}}').length).toBeGreaterThan(2);
  expect(markdown).not.toMatch(/execute-api|amazonaws\.com\/|lambda-url/);
  expect(markdown).toContain('do not send bearer requests to `https://files.dliu.com/api/*`');
});

test('the reference documents the actual large-upload completion-body limitation', () => {
  const token = auth.sign({ path: 'x'.repeat(40), uploadId: 'A'.repeat(140), size: 1, partSize: 16 * 1024 ** 2,
    partCount: 1000, exp: 1800000000 }, Buffer.alloc(32));
  const body = (count) => JSON.stringify({ token, parts: Array.from({ length: count }, (_, index) => ({
    partNumber: index + 1, etag: `"${'a'.repeat(32)}"` })) }).length;
  expect(body(950)).toBeLessThan(65536);
  expect(body(1050)).toBeGreaterThan(65536);
  expect(partPlan(50 * 1024 ** 3).partCount).toBe(3200);
  expect(markdown).toContain('the 50 GiB start cap does not guarantee completion');
  expect(markdown).toContain('about 1,000 parts, roughly 15 GiB');
  expect(markdown).toContain('BUDGET');
});

function sameShape(actual, example) {
  if (example === null) expect(actual).toBeNull();
  else if (Array.isArray(example)) {
    expect(Array.isArray(actual)).toBe(true);
    if (example.length && actual.length) sameShape(actual[0], example[0]);
  } else if (typeof example === 'object') {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(example).sort());
    for (const key of Object.keys(example)) sameShape(actual[key], example[key]);
  } else expect(typeof actual).toBe(typeof example);
}

test('documented request examples exercise all eight handlers locally with matching response shapes', async () => {
  const original = { ...process.env };
  const tenant = '11111111-1111-4111-8111-111111111111';
  const application = '22222222-2222-4222-8222-222222222222';
  Object.assign(process.env, { API_GATEWAY_ID: 'docs-test-api', API_TENANT_ID: tenant, API_AUDIENCE: application,
    API_CLIENT_ID: application, SITE_URL: 'https://files.dliu.com', FILE_BUCKET: 'docs-test-bucket',
    AWS_REGION: 'eu-west-1', AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE', AWS_SECRET_ACCESS_KEY: 'test-secret',
    MAX_UPLOAD_BYTES: String(50 * 1024 ** 3) });
  try {
    const s3 = createFakeS3();
    s3.completedSize = examples['POST /api/uploads'][0].size;
    const config = { tenantId: 'website', clientId: 'website', clientSecret: 'docs-test-secret' };
    const handler = createHandler({ s3, now: () => Date.UTC(2026, 10, 1, 12), invalidate: async () => {},
      loadConfig: async () => config });
    const call = async (route, body, example = examples[route].at(-1)) => {
      const [method, rawPath] = route.split(' ');
      const response = await handler({ rawPath, body: body === undefined ? undefined : JSON.stringify(body),
        headers: {}, requestContext: { apiId: 'docs-test-api', routeKey: route, http: { method },
          authorizer: { jwt: { scopes: ['files.read', 'files.write', 'files.delete'], claims: {
            ver: '2.0', tid: tenant, aud: application, azp: application,
            iss: `https://login.microsoftonline.com/${tenant}/v2.0`, oid: 'docs-test-user',
            sub: 'docs-test-subject', roles: '[api.access]', name: 'Example user',
          } } } } });
      expect([route, response.statusCode]).toEqual([route, 200]);
      const value = JSON.parse(response.body);
      sameShape(value, example);
      return value;
    };
    await call('GET /api/me');
    const plan = await call('POST /api/uploads', examples['POST /api/uploads'][0]);
    expect(plan).toMatchObject({ ...examples['POST /api/uploads'][1], token: plan.token });
    const urls = await call('POST /api/uploads/parts', { ...examples['POST /api/uploads/parts'][0], token: plan.token, parts: [1] },
      { urls: { 1: examples['POST /api/uploads/parts'][1].urls[1] } });
    expect(urls.urls[1]).toMatch(/^https:\/\//);
    const done = await call('POST /api/uploads/complete', { ...examples['POST /api/uploads/complete'][0], token: plan.token });
    expect(done.file).toEqual(examples['POST /api/uploads/complete'][1].file);
    expect(await call('GET /api/files')).toEqual(examples['GET /api/files'][0]);
    expect(await call('POST /api/files/move', examples['POST /api/files/move'][0])).toEqual(examples['POST /api/files/move'][1]);
    const cancelled = await call('POST /api/uploads', examples['POST /api/uploads'][0]);
    expect(await call('POST /api/uploads/abort', { token: cancelled.token })).toEqual(examples['POST /api/uploads/abort'][1]);
    expect(await call('POST /api/files/delete', examples['POST /api/files/delete'][0])).toEqual(examples['POST /api/files/delete'][1]);
  } finally { process.env = original; }
});

test('the Markdown reference renders tables, code and endpoint anchors without executing HTML', () => {
  const { renderApiMarkdown } = renderer();
  const content = renderApiMarkdown(markdown);
  const nodes = walk(content);
  expect(nodes.filter((node) => node.tag === 'h3').map((node) => node.textContent)).toEqual(Object.keys(routes));
  expect(nodes.filter((node) => node.tag === 'table').length).toBeGreaterThanOrEqual(5);
  for (const node of nodes.filter((node) => node.tag === 'a' && node.attributes.href.startsWith('#'))) {
    expect(nodes.some((target) => target.attributes.id === node.attributes.href.slice(1))).toBe(true);
  }
  const malicious = renderApiMarkdown('# Reference\n\n<script>alert(1)</script> [bad](javascript:alert) [bad2](//evil.example)\n\n```html\n<img onerror="bad">\n```');
  expect(walk(malicious).some((node) => ['script', 'img', 'a'].includes(node.tag))).toBe(false);
  expect(malicious.textContent).toContain('<script>alert(1)</script>');
});

test('fetch and document-format failures are surfaced instead of leaving a loading or success placeholder', async () => {
  const context = renderer();
  const root = el('div');
  context.fetch.mockResolvedValueOnce({ ok: true, text: async () => markdown });
  await context.loadApiDocs(root);
  expect(context.fetch).toHaveBeenCalledWith('/docs/api.md');
  expect(root.textContent).toContain('POST /api/uploads/complete');
  context.fetch.mockResolvedValueOnce({ ok: false, status: 503 });
  await context.loadApiDocs(root);
  expect(root.textContent).toContain('Could not load the API reference: HTTP 503');
  expect(walk(root).some((node) => node.attributes.role === 'alert')).toBe(true);
  context.fetch.mockResolvedValueOnce({ ok: true, text: async () => '```json\nunclosed' });
  await context.loadApiDocs(root);
  expect(root.textContent).toContain('Unclosed code block');
});

test('the page shell loads only site assets and links the Markdown and Auth references', () => {
  const shell = read('web/docs-api.html');
  expect(shell).toContain('<script type="module" src="/_app/docs-api.js"></script>');
  expect(shell).toContain('<link rel="stylesheet" href="/_app/style.css">');
  expect(shell).toContain('href="/docs/api.md"');
  expect(shell).toContain('href="https://auth.dliu.com/docs/api">Auth API documentation</a>');
  expect(shell).toContain('Authentication is required');
  expect(shell).toContain('id="api-doc"');
  expect(shell).not.toMatch(/<script(?![^>]*src="\/_app\/)/);
});

test('Files examples are valid Bash and preserve the separate direct-to-S3 upload contract', () => {
  const bash = blocks(markdown, 'bash');
  expect(bash.length).toBeGreaterThanOrEqual(4);
  for (const example of bash) {
    const result = spawnSync('bash', ['-n'], { input: example, encoding: 'utf8' });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  }
  expect(markdown).toContain('node scripts/api-client.js "$@"');
  expect(markdown).not.toMatch(/blog_[a-f0-9]|~\/\.dliu_credentials/);
  expect(markdown).toContain('Managed API requests do not need `Origin`, website cookies or `x-amz-content-sha256`');
  expect(markdown).toContain('Do not send Microsoft bearer authorization, website cookies or `x-amz-content-sha256` to S3');
  expect(markdown).toContain('`files.write` does not include `files.delete`');
});

test('the reference requires canonical Auth setup without duplicating generic credential or header instructions', () => {
  expect(markdown).toContain('**Authentication is required:**');
  expect(markdown).toContain('[Auth API documentation](https://auth.dliu.com/docs/api)');
  expect(markdown).toContain('the default `~/.dliu_token` file, expiry and bearer transport');
  expect(markdown).toContain('no application-global bearer-token cache');
  expect(markdown).toContain('not a forensic zeroization guarantee');
  expect(markdown).toContain('`api.access`');
  expect(markdown).not.toContain('files.access');
  expect(markdown).toContain('display name "dliu API user"');
  expect(markdown).not.toMatch(/[\w.+-]+@dliu\.com/);
  const nodes = walk(renderer().renderApiMarkdown(markdown));
  expect(nodes.some((node) => node.tag === 'a' && node.attributes.href === 'https://auth.dliu.com/docs/api')).toBe(true);
  for (const source of [markdown, read('web/docs-api.html')]) {
    expect(source).not.toMatch(/FILES_API_ACCESS_TOKEN|FILES_API_TOKEN_FILE|expires_at=|Authorization:|Bearer |readAccessToken|client_secret/);
  }
});

test('the documented Files adapter forwards method/path/JSON unchanged and propagates client failures', () => {
  const helper = blocks(markdown, 'bash').find((example) => example.includes('files_api()'))
    .split('\nfiles_api GET /api/me')[0];
  const body = '{"from":"me/resume.pdf","to":"me/cv/resume.pdf"}';
  const run = (stub) => spawnSync('/bin/bash', ['-c',
    `${stub}\n${helper}\nfiles_api POST /api/files/move '${body}'`], {
    encoding: 'utf8', timeout: 10000, env: { PATH: '/usr/bin:/bin' },
  });
  const success = run('node() { printf "%s\\n" "$@"; }');
  expect(success.status).toBe(0);
  expect(success.stdout.trim().split('\n')).toEqual([
    'scripts/api-client.js', 'POST', '/api/files/move', body,
  ]);
  expect(success.stderr).toBe('');
  const failed = run('node() { return 17; }');
  expect(failed.status).toBe(17);
  expect(failed.stdout).toBe('');
});
