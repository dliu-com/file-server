'use strict';

// Everything lives in the file bucket; there is no database.
//   <path>             a file, served at https://files.dliu.com/<path>
//   _app/...           the site's pages, scripts and styles (deployed by the stack)
//   _data/files.json   every file: the public listing and the source of truth
const LISTING_KEY = '_data/files.json';
// Top-level names the site itself uses. Files cannot go there from either entry point.
const RESERVED = new Set(['_app', '_data', 'api', 'auth']);
// Shared assets every dliu.com site loads (the stylesheet and icon). These are view-only for website (cookie)
// sessions: only the managed API (an auth.dliu.com Microsoft token with files.write / files.delete) may change
// them, so the listing stays accurate. The website Lambda's IAM role is also denied writing dliu.com/* as a
// backstop; the managed API runs as a separate role that may write it.
const SHARED = new Set(['dliu.com']);
// Exact paths the pages function serves as the docs pages.
const RESERVED_PATHS = new Set(['docs', 'docs/api', 'docs/api.md', 'docs/health', 'docs/health.md']);
// Browsers keep a file for 5 minutes; CloudFront keeps it for a day so visitors far from Ireland get it from a nearby
// edge, and serves the old copy while it refreshes in the background. Replacing or deleting a file in S3, however
// it happens, clears CloudFront's copy (clear.js), so the day only applies to unchanged files.
const FILE_CACHE_CONTROL = 'public, max-age=300, s-maxage=86400, stale-while-revalidate=86400';

const s3sdk = () => require('@aws-sdk/client-s3');

const isMissing = (error) => error && (error.name === 'NoSuchKey' || error.name === 'NotFound' || (error.$metadata && error.$metadata.httpStatusCode === 404));
const isConflict = (error) => error && (error.name === 'PreconditionFailed' || error.name === 'ConditionalRequestConflict'
  || (error.$metadata && [409, 412].includes(error.$metadata.httpStatusCode)));

/** The URL path of a file or folder, encoded the way browsers send it, so CDN invalidations match. */
function urlPath(path) {
  return '/' + path.split('/').map((segment) => encodeURIComponent(segment)
    .replace(/%(2[146-9ABC]|3[ABD]|40)/gi, (match) => decodeURIComponent(match))).join('/');
}

async function readJson(s3, bucket, key) {
  const { GetObjectCommand } = s3sdk();
  try {
    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return { value: JSON.parse(await result.Body.transformToString()), etag: result.ETag };
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function writeJson(s3, bucket, key, value, extra = {}) {
  const { PutObjectCommand } = s3sdk();
  return s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: JSON.stringify(value), ContentType: 'application/json; charset=utf-8', ...extra,
  }));
}

async function headObject(s3, bucket, key) {
  const { HeadObjectCommand } = s3sdk();
  try {
    return await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

async function deleteKeys(s3, bucket, keys) {
  const { DeleteObjectsCommand } = s3sdk();
  for (let i = 0; i < keys.length; i += 1000) {
    const result = await s3.send(new DeleteObjectsCommand({
      Bucket: bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
    if (result.Errors && result.Errors.length) throw new Error(`Could not delete ${result.Errors.map((e) => e.Key).join(', ')}`);
  }
}

async function readListing(s3, bucket) {
  const found = await readJson(s3, bucket, LISTING_KEY);
  return found ? found.value : { files: [] };
}

const byPath = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Changes the listing with a conditional write, retrying if another request changed it first.
 * `change(listing)` mutates the listing and returns a result; return `undefined` from it to skip the write.
 */
async function updateListing(s3, bucket, change, now = Date.now(), attempts = 5) {
  for (let attempt = 1; ; attempt += 1) {
    const found = await readJson(s3, bucket, LISTING_KEY);
    const listing = found ? found.value : { files: [] };
    const result = await change(listing);
    if (result === undefined) return { listing, result };
    listing.files.sort(byPath);
    listing.updatedAt = new Date(now).toISOString();
    try {
      await writeJson(s3, bucket, LISTING_KEY, listing, {
        CacheControl: 'no-cache',
        ...(found ? { IfMatch: found.etag } : { IfNoneMatch: '*' }),
      });
      return { listing, result };
    } catch (error) {
      if (!isConflict(error) || attempt >= attempts) throw error;
    }
  }
}

module.exports = {
  FILE_CACHE_CONTROL,
  LISTING_KEY,
  RESERVED,
  RESERVED_PATHS,
  SHARED,
  deleteKeys,
  headObject,
  isConflict,
  isMissing,
  readJson,
  readListing,
  updateListing,
  urlPath,
  writeJson,
};
