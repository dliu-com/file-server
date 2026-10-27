const { SignatureV4 } = require('@smithy/signature-v4');
const { HttpRequest } = require('@smithy/protocol-http');
const { Sha256 } = require('@aws-crypto/sha256-js');
// The S3 client escapes object keys (RFC 3986, keeping "/") before signing them.
const escapeKey = (key) => key.split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
const { presignUrl } = require('../lambda/api/presign');

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'token/with+chars=' };
const NOW = Date.UTC(2026, 9, 27, 12, 30, 15);

async function reference({ method, bucket, region, key, query, expiresIn }) {
  const signer = new SignatureV4({ credentials, region, service: 's3', sha256: Sha256, uriEscapePath: false, applyChecksum: false });
  const request = new HttpRequest({
    method, protocol: 'https:', hostname: `${bucket}.s3.${region}.amazonaws.com`, path: `/${escapeKey(key)}`,
    query: Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    headers: { host: `${bucket}.s3.${region}.amazonaws.com`, 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  });
  const signed = await signer.presign(request, { signingDate: new Date(NOW), expiresIn, unsignableHeaders: new Set(['x-amz-content-sha256']), unhoistableHeaders: new Set(['x-amz-content-sha256']) });
  return new URL(`https://${signed.hostname}${signed.path}?${new URLSearchParams(signed.query)}`);
}

describe('presignUrl', () => {
  test.each([
    ['part upload', { method: 'PUT', key: 'me/videos/graduation day.mp4', query: { partNumber: 7, uploadId: 'abc.def~ghi' } }],
    ['unicode path', { method: 'PUT', key: 'docs/简历 (2026).pdf', query: { partNumber: 1, uploadId: 'x' } }],
  ])('matches the AWS SDK signer for a %s', async (_, input) => {
    const opts = { ...input, bucket: 'fileserver-filebucket-abc123', region: 'eu-west-1', expiresIn: 3600 };
    const ours = new URL(presignUrl({ ...opts, credentials, now: NOW }));
    const theirs = await reference(opts);
    expect(ours.host).toBe(theirs.host);
    expect(ours.pathname).toBe(theirs.pathname);
    expect(Object.fromEntries(ours.searchParams)).toEqual(Object.fromEntries(theirs.searchParams));
  });

  test('omits the security token when there is none', () => {
    const url = new URL(presignUrl({
      method: 'PUT', bucket: 'b', region: 'eu-west-1', key: 'k', now: NOW,
      credentials: { accessKeyId: 'A', secretAccessKey: 'S' },
    }));
    expect(url.searchParams.has('X-Amz-Security-Token')).toBe(false);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
  });
});
