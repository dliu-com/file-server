#!/usr/bin/env node
// End-to-end test against the deployed site: upload a throwaway file (multipart, straight to S3), serve it,
// move it and delete it. It signs a short-lived owner session with the session key derived from the
// Entra client secret in SSM, so it needs AWS credentials.
// Usage: node scripts/smoke-test.js [--keep]
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const auth = require('../lambda/api/auth');

const SITE = process.env.SITE_URL || 'https://files.dliu.com';
const REGION = process.env.AWS_REGION || 'eu-west-1';
const PREFIX = process.env.PARAMETER_PREFIX || '/files';
const keep = process.argv.includes('--keep');

const param = (name) => execFileSync('aws', ['ssm', 'get-parameter', '--region', REGION, '--name', `${PREFIX}/${name}`,
  '--with-decryption', '--query', 'Parameter.Value', '--output', 'text']).toString().trim();
const config = { tenantId: param('entra-tenant-id'), clientId: param('entra-client-id'), clientSecret: param('entra-client-secret') };
const session = auth.sign({ user: `smoke-test@${new URL(SITE).hostname}`, name: 'Smoke test', exp: Math.floor(Date.now() / 1000) + 600 }, auth.sessionKey(config));
const cookie = `${auth.SESSION_COOKIE}=${session}`;

function check(condition, message) {
  if (!condition) throw new Error(`not ok - ${message}`);
  console.log(`ok - ${message}`);
}

async function api(path, body) {
  const text = JSON.stringify(body);
  const response = await fetch(SITE + path, {
    method: 'POST',
    headers: { cookie, origin: SITE, 'content-type': 'application/json', 'x-amz-content-sha256': crypto.createHash('sha256').update(text).digest('hex') },
    body: text,
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${json.error || ''}`);
  return json;
}

const listing = async () => (await fetch(`${SITE}/_data/files.json`, { cache: 'no-store' })).json();
const url = (path) => SITE + '/' + path.split('/').map(encodeURIComponent).join('/');

async function main() {
  check((await (await fetch(`${SITE}/api/me`, { headers: { cookie } })).json()).user, 'owner session accepted');

  const folder = `smoke-test-${crypto.randomBytes(4).toString('hex')}`;
  const path = `${folder}/test file (1).bin`;
  // S3 doesn't look inside the file, so random bytes are enough to exercise two upload parts.
  const file = crypto.randomBytes(20 * 1024 * 1024);
  const plan = await api('/api/uploads', { path, contentType: 'application/octet-stream', size: file.length });
  check(plan.partCount === 2, `upload planned as ${plan.partCount} parts`);
  try {
    const { urls } = await api('/api/uploads/parts', { token: plan.token, parts: [1, 2] });
    const preflight = await fetch(urls[1], { method: 'OPTIONS', headers: { origin: SITE, 'access-control-request-method': 'PUT' } });
    check(preflight.headers.get('access-control-allow-origin') === SITE, 'S3 CORS allows uploads from the site');
    const parts = [];
    for (const n of [1, 2]) {
      const response = await fetch(urls[n], { method: 'PUT', body: file.subarray((n - 1) * plan.partSize, n * plan.partSize) });
      check(response.ok && response.headers.get('etag'), `part ${n} uploaded to S3`);
      parts.push({ partNumber: n, etag: response.headers.get('etag') });
    }
    const done = await api('/api/uploads/complete', { token: plan.token, parts });
    check(done.file.size === file.length, `uploaded ${path}`);
  } catch (error) {
    await api('/api/uploads/abort', { token: plan.token }).catch(() => {});
    throw error;
  }

  let current = path;
  try {
    const range = await fetch(url(path), { headers: { range: 'bytes=100-199' } });
    check(range.status === 206 && Buffer.from(await range.arrayBuffer()).equals(file.subarray(100, 200)), 'file served with byte ranges');
    check((await listing()).files.some((f) => f.path === path), 'file listed');
    const page = await fetch(`${SITE}/${folder}/`);
    const csp = page.headers.get('content-security-policy') || '';
    check(page.ok && (await page.text()).includes('/_app/app.js') && csp.includes(`script-src ${SITE}/_app/`), 'folder page served with its CSP');
    check((await fetch(`${SITE}/${folder}/missing.txt`)).status === 404, 'missing files answer 404');

    const moved = `${folder}/moved/renamed.bin`;
    await api('/api/files/move', { from: path, to: moved });
    current = moved;
    const files = (await listing()).files;
    check(files.some((f) => f.path === moved) && !files.some((f) => f.path === path), 'file moved');
    check((await fetch(url(moved), { method: 'HEAD' })).ok, 'moved file served');
  } finally {
    if (keep) {
      console.log(`kept ${url(current)}`);
    } else {
      await api('/api/files/delete', { path: folder });
      check(!(await listing()).files.some((f) => f.path.startsWith(`${folder}/`)), 'deleted');
    }
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
