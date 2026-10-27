const auth = require('../lambda/api/auth');
const { createHandler } = require('../lambda/api/index');
const { cleanPath } = require('../lambda/api/files');
const { LISTING_KEY, urlPath } = require('../lambda/api/store');
const { createFakeS3 } = require('./fake-s3');

const SITE = 'https://files.dliu.com';
const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);
const MiB = 1024 * 1024;
const config = { tenantId: 't', clientId: 'c', clientSecret: 'secret', allowedDomain: 'example.com' };

process.env.SITE_URL = SITE;
process.env.FILE_BUCKET = 'file-bucket';
process.env.AWS_REGION = 'eu-west-1';
process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE';
process.env.AWS_SECRET_ACCESS_KEY = 'secret';
process.env.MAX_UPLOAD_BYTES = String(10 * 1024 ** 3);

const session = auth.sign({ user: 'me@example.com', name: 'Me', exp: Math.floor(NOW / 1000) + 7 * 24 * 3600 }, auth.sessionKey(config));

function setup({ now = NOW } = {}) {
  const s3 = createFakeS3();
  const invalidated = [];
  const clock = { now };
  const handler = createHandler({ loadConfig: async () => config, s3, now: () => clock.now, invalidate: async (paths) => { invalidated.push(...paths); } });
  const call = (method, path, { body, signedIn = true, origin = SITE, query } = {}) => handler({
    rawPath: path,
    requestContext: { http: { method } },
    queryStringParameters: query,
    headers: { ...(origin ? { origin } : {}) },
    cookies: signedIn ? [`${auth.SESSION_COOKIE}=${session}`] : [],
    body: body === undefined ? undefined : JSON.stringify(body),
  }).then((r) => ({ ...r, json: r.body && r.body.startsWith('{') ? JSON.parse(r.body) : undefined }));
  return { s3, call, invalidated, clock };
}

const listed = (s3) => s3.json(LISTING_KEY).files.map((f) => f.path);

async function upload(call, s3, path, { size = 1234, contentType = 'application/pdf', overwrite } = {}) {
  s3.completedSize = size;
  const created = await call('POST', '/api/uploads', { body: { path, contentType, size, overwrite } });
  expect(created.statusCode).toBe(200);
  const plan = created.json;
  const parts = Array.from({ length: plan.partCount }, (_, i) => ({ partNumber: i + 1, etag: `"${'a'.repeat(32)}"` }));
  const done = await call('POST', '/api/uploads/complete', { body: { token: plan.token, parts } });
  expect(done.statusCode).toBe(200);
  return { plan, file: done.json.file };
}

describe('API', () => {
  test('owner endpoints need a session, and clear the owner hint when it is missing', async () => {
    const { call } = setup();
    const result = await call('GET', '/api/me', { signedIn: false });
    expect(result.statusCode).toBe(401);
    expect(result.cookies.some((c) => c.startsWith(`${auth.OWNER_HINT_COOKIE}=;`))).toBe(true);
    expect((await call('GET', '/api/me')).json).toEqual({ user: 'me@example.com', name: 'Me' });
  });

  test('POSTs from another origin are refused', async () => {
    const { call } = setup();
    expect((await call('POST', '/api/uploads', { body: {}, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await call('POST', '/api/files/delete', { body: {}, origin: '' })).statusCode).toBe(403);
  });

  test('unknown methods and paths', async () => {
    const { call } = setup();
    expect((await call('PUT', '/api/files/delete')).statusCode).toBe(405);
    expect((await call('GET', '/api/nope')).statusCode).toBe(404);
  });

  test('upload plan: a multipart upload at the file path with 16 MiB parts and a signed token', async () => {
    const { call, s3 } = setup();
    const result = await call('POST', '/api/uploads', { body: { path: '/me/videos/Graduation Day.mp4', contentType: 'video/mp4', size: 40 * MiB } });
    expect(result.statusCode).toBe(200);
    const plan = result.json;
    expect(plan).toMatchObject({ path: 'me/videos/Graduation Day.mp4', partSize: 16 * MiB, partCount: 3, replacing: false });
    const create = s3.calls.find((c) => c.name === 'CreateMultipartUploadCommand').input;
    expect(create).toMatchObject({
      Key: 'me/videos/Graduation Day.mp4', ContentType: 'video/mp4', StorageClass: 'INTELLIGENT_TIERING', CacheControl: 'public, max-age=300',
    });

    const parts = await call('POST', '/api/uploads/parts', { body: { token: plan.token, parts: [1, 2, 3] } });
    expect(Object.keys(parts.json.urls)).toEqual(['1', '2', '3']);
    const url = new URL(parts.json.urls[2]);
    expect(url.host).toBe('file-bucket.s3.eu-west-1.amazonaws.com');
    expect(url.pathname).toBe('/me/videos/Graduation%20Day.mp4');
    expect(url.searchParams.get('partNumber')).toBe('2');
    expect(url.searchParams.get('uploadId')).toBe(create && s3.calls.length && [...s3.uploads.keys()][0]);

    expect((await call('POST', '/api/uploads/parts', { body: { token: plan.token, parts: [4] } })).statusCode).toBe(400);
    expect((await call('POST', '/api/uploads/parts', { body: { token: `${plan.token}x`, parts: [1] } })).statusCode).toBe(404);
  });

  test('upload tokens expire', async () => {
    const { call, clock } = setup();
    const plan = (await call('POST', '/api/uploads', { body: { path: 'a.bin', size: 10 } })).json;
    clock.now += 3 * 24 * 3600 * 1000;
    expect((await call('POST', '/api/uploads/parts', { body: { token: plan.token, parts: [1] } })).statusCode).toBe(404);
  });

  test('part size grows so a large file stays within 10,000 parts', async () => {
    const { call } = setup();
    const size = 9 * 1024 ** 3 + 5;
    const plan = (await call('POST', '/api/uploads', { body: { path: 'big.iso', size } })).json;
    expect(plan.partCount).toBeLessThanOrEqual(10000);
    expect(plan.partSize * plan.partCount).toBeGreaterThanOrEqual(size);
  });

  test.each([
    [{ path: '', size: 10 }, 'path is required'],
    [{ path: 'a/../b', size: 10 }, 'cannot contain . or ..'],
    [{ path: 'a//b', size: 10 }, 'empty name'],
    [{ path: 'a/b?.txt', size: 10 }, 'cannot contain'],
    [{ path: 'a/100%.txt', size: 10 }, 'cannot contain'],
    [{ path: 'a/b\u0007.txt', size: 10 }, 'control characters'],
    [{ path: '_app/app.js', size: 10 }, 'reserved'],
    [{ path: 'api/x', size: 10 }, 'reserved'],
    [{ path: 'index.html', size: 10 }, 'reserved'],
    [{ path: `${'a'.repeat(256)}.txt`, size: 10 }, 'longer than 255'],
    [{ path: 'a.txt', size: 0 }, 'Empty files'],
    [{ path: 'a.txt', size: 11 * 1024 ** 3 }, 'size must be'],
    [{ path: 'a.txt', size: 10, contentType: 'text/html"><script>' }, 'Invalid content type'],
  ])('rejects bad upload %#', async (body, message) => {
    const { call } = setup();
    const result = await call('POST', '/api/uploads', { body });
    expect(result.statusCode).toBe(400);
    expect(result.json.error).toContain(message);
  });

  test('paths are NFC-normalised and may hold spaces, Unicode and URL punctuation', () => {
    expect(cleanPath('/docs/简历 (2026).pdf/')).toBe('docs/简历 (2026).pdf');
    expect(cleanPath('cafe\u0301.txt')).toBe('café.txt');
    expect(cleanPath("a/it's [1] & more+.txt")).toBe("a/it's [1] & more+.txt");
    expect(urlPath("a/简历 it's [1] & more+.txt")).toBe("/a/%E7%AE%80%E5%8E%86%20it's%20%5B1%5D%20&%20more+.txt");
  });

  test('completing an upload lists the file', async () => {
    const { call, s3, invalidated } = setup();
    const { file } = await upload(call, s3, 'me/resume.pdf', { size: 178305 });
    expect(file).toEqual({ path: 'me/resume.pdf', size: 178305, type: 'application/pdf', modified: new Date(NOW).toISOString() });
    expect(s3.json(LISTING_KEY)).toEqual({ files: [file], updatedAt: new Date(NOW).toISOString() });
    expect(s3.objects.get(LISTING_KEY).cacheControl).toBe('no-cache');
    await upload(call, s3, 'dliu.com/favicon.png', { contentType: 'image/png' });
    expect(listed(s3)).toEqual(['dliu.com/favicon.png', 'me/resume.pdf']);
    expect(invalidated).toEqual([]);
  });

  test('an existing file is replaced only when asked, and the CDN copy is invalidated', async () => {
    const { call, s3, invalidated } = setup();
    await upload(call, s3, 'me/resume.pdf');
    const refused = await call('POST', '/api/uploads', { body: { path: 'me/resume.pdf', size: 10 } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json.error).toContain('already exists');
    const { plan, file } = await upload(call, s3, 'me/resume.pdf', { size: 999, overwrite: true });
    expect(plan.replacing).toBe(true);
    expect(file.size).toBe(999);
    expect(listed(s3)).toEqual(['me/resume.pdf']);
    expect(invalidated).toEqual(['/me/resume.pdf']);
  });

  test('a file cannot take the place of a folder, or the other way round', async () => {
    const { call, s3 } = setup();
    await upload(call, s3, 'me/resume.pdf');
    expect((await call('POST', '/api/uploads', { body: { path: 'me', size: 10 } })).statusCode).toBe(409);
    expect((await call('POST', '/api/uploads', { body: { path: 'me/resume.pdf/x', size: 10 } })).statusCode).toBe(409);
  });

  test('complete needs every part, in order', async () => {
    const { call } = setup();
    const plan = (await call('POST', '/api/uploads', { body: { path: 'x.bin', size: 40 * MiB } })).json;
    const send = (parts) => call('POST', '/api/uploads/complete', { body: { token: plan.token, parts } });
    expect((await send([{ partNumber: 1, etag: '"a"' }])).statusCode).toBe(400);
    expect((await send([1, 1, 3].map((n) => ({ partNumber: n, etag: '"a"' })))).statusCode).toBe(400);
    expect((await send([1, 2, 3].map((n) => ({ partNumber: n, etag: '<bad>' })))).statusCode).toBe(400);
  });

  test('abort cancels the multipart upload', async () => {
    const { call, s3 } = setup();
    const plan = (await call('POST', '/api/uploads', { body: { path: 'x.bin', size: 10 } })).json;
    expect((await call('POST', '/api/uploads/abort', { body: { token: plan.token } })).statusCode).toBe(200);
    expect(s3.uploads.size).toBe(0);
    expect((await call('POST', '/api/uploads/abort', { body: { token: plan.token } })).statusCode).toBe(200);
  });

  test('move renames a file', async () => {
    const { call, s3, invalidated } = setup();
    await upload(call, s3, 'old name.pdf', { size: 5 });
    const result = await call('POST', '/api/files/move', { body: { from: 'old name.pdf', to: 'docs/new name.pdf' } });
    expect(result.json).toEqual({ moved: [{ from: 'old name.pdf', to: 'docs/new name.pdf' }] });
    expect(s3.objects.has('old name.pdf')).toBe(false);
    expect(s3.objects.get('docs/new name.pdf')).toMatchObject({ contentType: 'application/pdf', storageClass: 'INTELLIGENT_TIERING' });
    const copy = s3.calls.find((c) => c.name === 'CopyObjectCommand').input;
    expect(copy.CopySource).toBe('file-bucket/old%20name.pdf');
    expect(listed(s3)).toEqual(['docs/new name.pdf']);
    expect(invalidated).toEqual(['/old%20name.pdf']);
  });

  test('move takes a folder and everything in it', async () => {
    const { call, s3, invalidated } = setup();
    for (const path of ['me/a.txt', 'me/videos/b.mp4', 'meadow.txt']) await upload(call, s3, path, { size: 3 });
    const result = await call('POST', '/api/files/move', { body: { from: 'me', to: 'dewei' } });
    expect(result.statusCode).toBe(200);
    expect(listed(s3)).toEqual(['dewei/a.txt', 'dewei/videos/b.mp4', 'meadow.txt']);
    expect([...s3.objects.keys()].filter((k) => !k.startsWith('_data/')).sort()).toEqual(['dewei/a.txt', 'dewei/videos/b.mp4', 'meadow.txt']);
    expect(invalidated).toEqual(['/me/*']);
  });

  test('large files are copied in parts', async () => {
    const { call, s3 } = setup();
    const size = 600 * MiB;
    await upload(call, s3, 'big.bin', { size, contentType: 'application/octet-stream' });
    s3.objects.get('big.bin').body = Buffer.alloc(size, 7);
    expect((await call('POST', '/api/files/move', { body: { from: 'big.bin', to: 'archive/big.bin' } })).statusCode).toBe(200);
    const copies = s3.calls.filter((c) => c.name === 'UploadPartCopyCommand').map((c) => c.input.CopySourceRange);
    expect(copies).toEqual([`bytes=0-${512 * MiB - 1}`, `bytes=${512 * MiB}-${size - 1}`]);
    expect(s3.objects.get('archive/big.bin').body.length).toBe(size);
    expect(s3.objects.has('big.bin')).toBe(false);
  });

  test.each([
    [{ from: 'a.txt', to: 'b.txt' }, 409, 'already exists'],
    [{ from: 'a.txt', to: 'a.txt' }, 400, 'same'],
    [{ from: 'dir', to: 'dir/sub' }, 400, 'into itself'],
    [{ from: 'missing', to: 'x' }, 404, 'not found'],
    [{ from: 'a.txt', to: 'b.txt/c.txt' }, 409, 'is a file'],
    [{ from: 'a.txt', to: '_data/x' }, 400, 'reserved'],
  ])('refuses bad move %#', async (body, status, message) => {
    const { call, s3 } = setup();
    for (const path of ['a.txt', 'b.txt', 'dir/c.txt']) await upload(call, s3, path, { size: 3 });
    const result = await call('POST', '/api/files/move', { body });
    expect(result.statusCode).toBe(status);
    expect(result.json.error).toContain(message);
    expect(listed(s3)).toEqual(['a.txt', 'b.txt', 'dir/c.txt']);
  });

  test('a failed copy leaves everything as it was', async () => {
    const { call, s3 } = setup();
    for (const path of ['dir/a.txt', 'dir/b.txt']) await upload(call, s3, path, { size: 3 });
    const realSend = s3.send;
    s3.send = async (command) => {
      if (command.constructor.name === 'CopyObjectCommand' && command.input.Key === 'new/b.txt') throw new Error('boom');
      return realSend(command);
    };
    expect((await call('POST', '/api/files/move', { body: { from: 'dir', to: 'new' } })).statusCode).toBe(500);
    expect(listed(s3)).toEqual(['dir/a.txt', 'dir/b.txt']);
    expect([...s3.objects.keys()].filter((k) => k.startsWith('new/'))).toEqual([]);
  });

  test('delete removes a file, or a folder and everything in it', async () => {
    const { call, s3, invalidated } = setup();
    for (const path of ['me/a.txt', 'me/videos/b.mp4', 'meadow.txt', 'x/简历.pdf']) await upload(call, s3, path, { size: 3 });
    expect((await call('POST', '/api/files/delete', { body: { path: 'x/简历.pdf' } })).json).toEqual({ deleted: ['x/简历.pdf'] });
    expect((await call('POST', '/api/files/delete', { body: { path: 'me' } })).json.deleted.sort()).toEqual(['me/a.txt', 'me/videos/b.mp4']);
    expect(listed(s3)).toEqual(['meadow.txt']);
    expect(s3.objects.has('me/a.txt')).toBe(false);
    expect(s3.objects.has('meadow.txt')).toBe(true);
    expect(invalidated).toEqual(['/x/%E7%AE%80%E5%8E%86.pdf', '/me/*']);
    expect((await call('POST', '/api/files/delete', { body: { path: 'me' } })).statusCode).toBe(404);
  });

  test('the listing write retries when another request changed it first', async () => {
    const { call, s3 } = setup();
    await upload(call, s3, 'a.txt');
    const realSend = s3.send;
    let raced = false;
    s3.send = async (command) => {
      if (!raced && command.constructor.name === 'PutObjectCommand' && command.input.Key === LISTING_KEY) {
        raced = true;
        const listing = s3.json(LISTING_KEY);
        listing.files.push({ path: 'other.txt', size: 1, type: 'text/plain', modified: '' });
        s3.put(LISTING_KEY, JSON.stringify(listing));
      }
      return realSend(command);
    };
    await upload(call, s3, 'b.txt');
    expect(raced).toBe(true);
    expect(listed(s3)).toEqual(['a.txt', 'b.txt', 'other.txt']);
  });

  test('login keeps a safe return path', async () => {
    const { call } = setup();
    const result = await call('GET', '/auth/login', { signedIn: false, query: { return: '/me/videos/' } });
    expect(result.statusCode).toBe(302);
    expect(new URL(result.headers.location).host).toBe('login.microsoftonline.com');
    for (const bad of ['//evil.com', 'https://evil.com', '/\\evil.com', '/a"b']) expect(auth.safeReturnPath(bad)).toBe('/');
    expect(auth.safeReturnPath('/me/%E7%AE%80%E5%8E%86/')).toBe('/me/%E7%AE%80%E5%8E%86/');
  });

  test('sign-in errors link the site stylesheet', async () => {
    const { call } = setup();
    const result = await call('GET', '/auth/callback', { signedIn: false, query: {} });
    expect(result.headers['content-type']).toContain('text/html');
    expect(result.body).toContain('/_app/style.css');
  });
});
