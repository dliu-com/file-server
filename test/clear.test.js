const { createClear } = require('../lambda/api/clear');

process.env.AWS_REGION = 'eu-west-1';

const BUCKET = 'file-bucket';

function setup(versions = {}) {
  const listed = [];
  const invalidations = [];
  const s3 = {
    send: async (command) => {
      listed.push(command.input);
      const items = (versions[command.input.Prefix] || []).map((key) => ({ Key: key }));
      return { Versions: items.slice(0, command.input.MaxKeys) };
    },
  };
  const cloudfront = { send: async (command) => { invalidations.push(command.input); return {}; } };
  const clear = createClear({ s3, cloudfront, bucket: BUCKET, distributionId: 'E123' });
  return { clear, listed, invalidations };
}

const change = (type, key, extra = {}) => ({
  'detail-type': type,
  source: 'aws.s3',
  detail: { bucket: { name: BUCKET }, object: { key, sequencer: '0001' }, 'request-id': 'R1', reason: 'PutObject', ...extra },
});

test('a file replaced in S3 (for example in the console) is cleared at its browser URL', async () => {
  const { clear, invalidations } = setup({ 'me/Graduation Day.mp4': ['me/Graduation Day.mp4', 'me/Graduation Day.mp4'] });
  await expect(clear(change('Object Created', 'me/Graduation Day.mp4'))).resolves.toEqual({ cleared: ['/me/Graduation%20Day.mp4'] });
  expect(invalidations).toEqual([expect.objectContaining({
    DistributionId: 'E123',
    InvalidationBatch: expect.objectContaining({ Paths: { Quantity: 1, Items: ['/me/Graduation%20Day.mp4'] } }),
  })]);
});

test('a deleted file is cleared without checking versions', async () => {
  const { clear, listed, invalidations } = setup();
  await expect(clear(change('Object Deleted', 'me/resume.pdf', { reason: 'DeleteObject' }))).resolves.toEqual({ cleared: ['/me/resume.pdf'] });
  expect(listed).toEqual([]);
  expect(invalidations).toHaveLength(1);
});

test('a new file is not cleared, because CloudFront never had it', async () => {
  const { clear, invalidations } = setup({ 'notes.txt': ['notes.txt', 'notes.txt.bak'] });
  await expect(clear(change('Object Created', 'notes.txt'))).resolves.toEqual({ cleared: [], skipped: 'new file' });
  expect(invalidations).toEqual([]);
});

test('site content, lifecycle clean-up and other buckets are ignored', async () => {
  const { clear, listed, invalidations } = setup();
  await expect(clear(change('Object Created', '_data/files.json'))).resolves.toMatchObject({ skipped: 'site content' });
  await expect(clear(change('Object Deleted', 'a.txt', { reason: 'Lifecycle Expiration' }))).resolves.toMatchObject({ skipped: 'lifecycle' });
  await expect(clear({ ...change('Object Deleted', 'a.txt'), detail: { bucket: { name: 'other' }, object: { key: 'a.txt' } } }))
    .resolves.toMatchObject({ skipped: 'other bucket' });
  expect(listed).toEqual([]);
  expect(invalidations).toEqual([]);
});

test('a failed invalidation is retried by EventBridge', async () => {
  const s3 = { send: async () => ({}) };
  const cloudfront = { send: async () => { throw new Error('Throttling'); } };
  const clear = createClear({ s3, cloudfront, bucket: BUCKET, distributionId: 'E123' });
  await expect(clear(change('Object Deleted', 'a.txt'))).rejects.toThrow('Throttling');
});
