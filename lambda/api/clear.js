'use strict';

// Clears CloudFront's copy of a file whenever it is replaced or deleted in S3, however that happens
// (this site, the S3 console, a script). S3 sends each change to EventBridge, which invokes this function.
// New files are skipped: CloudFront never had them, so there is nothing to clear. Clearing a path is free
// for the first 1,000 a month across the account (then $0.005 each).
const store = require('./store');

let clients = {};
const client = (name, make) => clients[name] || (clients[name] = make());

// The file had an earlier version (or was deleted before), so CloudFront may still be serving the old one.
async function replaced(s3, bucket, key) {
  const { ListObjectVersionsCommand } = require('@aws-sdk/client-s3');
  const result = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, MaxKeys: 2 }));
  return [...(result.Versions || []), ...(result.DeleteMarkers || [])].filter((v) => v.Key === key).length > 1;
}

function createClear({ s3, cloudfront, bucket, distributionId }) {
  return async function clear(event) {
    const detail = (event && event.detail) || {};
    const key = detail.object && detail.object.key;
    const skip = (reason) => ({ cleared: [], skipped: reason });
    if (!key || !detail.bucket || detail.bucket.name !== bucket) return skip('other bucket');
    // The site's own pages and listing are cleared by each deploy and are never cached for long.
    if (key.startsWith('_')) return skip('site content');
    // Lifecycle rules only remove old versions and delete markers, which visitors never see.
    if (detail.reason === 'Lifecycle Expiration') return skip('lifecycle');
    if (event['detail-type'] === 'Object Created' && !(await replaced(s3, bucket, key))) return skip('new file');
    const paths = [store.urlPath(key)];
    const { CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
    await cloudfront.send(new CreateInvalidationCommand({
      DistributionId: distributionId,
      InvalidationBatch: { CallerReference: `auto-${detail['request-id'] || ''}-${detail.object.sequencer || Date.now()}`, Paths: { Quantity: 1, Items: paths } },
    }));
    console.log(JSON.stringify({ message: 'Cleared CDN path', paths, change: event['detail-type'] }));
    return { cleared: paths };
  };
}

async function handler(event) {
  const s3 = client('s3', () => { const { S3Client } = require('@aws-sdk/client-s3'); return new S3Client({}); });
  const cloudfront = client('cloudfront', () => { const { CloudFrontClient } = require('@aws-sdk/client-cloudfront'); return new CloudFrontClient({}); });
  return createClear({ s3, cloudfront, bucket: process.env.FILE_BUCKET, distributionId: process.env.DISTRIBUTION_ID })(event);
}

module.exports = { handler, createClear };
