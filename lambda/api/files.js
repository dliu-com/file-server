'use strict';

const { presignUrl } = require('./presign');
const { sign, verifySigned } = require('./auth');
const store = require('./store');

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
const MIN_PART = 16 * MiB;
const MAX_PARTS = 10000;
const PARTS_PER_CALL = 100;
const URL_SECONDS = 60 * 60;
const TOKEN_SECONDS = 2 * 24 * 60 * 60; // S3 aborts unfinished multipart uploads after 2 days anyway.
const SIMPLE_COPY_MAX = 256 * MiB;
const COPY_PART_MIN = 512 * MiB;
const COPY_CONCURRENCY = 20;
const MAX_MOVE_FILES = 200;
const MAX_MOVE_BYTES = 50 * GiB;
const STORAGE_CLASS = 'INTELLIGENT_TIERING';

class BadRequest extends Error {}
class NotFound extends Error {}
class Conflict extends Error {}

/**
 * A file or folder path without leading or trailing slashes, e.g. "me/videos/graduation.mp4".
 * Segments may hold any printable characters except / \ ? # %, which would make URLs ambiguous.
 */
function cleanPath(value, name = 'path') {
  if (typeof value !== 'string') throw new BadRequest(`${name} is required`);
  const path = value.normalize('NFC').trim().replace(/^\/+|\/+$/g, '');
  if (!path) throw new BadRequest(`${name} is required`);
  if (Buffer.byteLength(path, 'utf8') > 1024) throw new BadRequest(`${name} is too long`);
  const segments = path.split('/');
  for (const segment of segments) {
    if (!segment || segment !== segment.trim()) throw new BadRequest(`${name} has an empty name or one that starts or ends with a space`);
    if (segment === '.' || segment === '..') throw new BadRequest(`${name} cannot contain . or ..`);
    if (segment.length > 255) throw new BadRequest(`${name} has a name longer than 255 characters`);
    // Control characters and characters with a special meaning in URLs.
    if (/[\u0000-\u001F\u007F\\?#%]/.test(segment)) throw new BadRequest(`${name} cannot contain \\ ? # % or control characters`);
  }
  if (store.RESERVED.has(segments[0])) throw new BadRequest(`"${segments[0]}" is reserved for the site; choose another top-level name`);
  if (path === 'index.html') throw new BadRequest('"index.html" at the top level is reserved for the site');
  return path;
}

function size(value, maxBytes) {
  if (!Number.isInteger(value) || value < 1 || value > maxBytes) {
    throw new BadRequest(value === 0 ? 'Empty files cannot be uploaded' : `size must be between 1 byte and ${Math.floor(maxBytes / GiB)} GiB`);
  }
  return value;
}

function contentType(value) {
  if (value === undefined || value === null || value === '') return 'application/octet-stream';
  if (typeof value !== 'string' || value.length > 200 || !/^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=[\w.+-]+)*$/.test(value)) {
    throw new BadRequest('Invalid content type');
  }
  return value.toLowerCase();
}

function partPlan(bytes) {
  const partSize = Math.max(MIN_PART, Math.ceil(bytes / MAX_PARTS / MiB) * MiB);
  return { partSize, partCount: Math.ceil(bytes / partSize) };
}

const isUnder = (path, folder) => path.startsWith(`${folder}/`);

/** Throws if `path` would clash with an existing folder, or a file where one of its folders should be. */
function checkFolderClash(files, path) {
  if (files.some((file) => isUnder(file.path, path))) throw new Conflict(`"${path}" is a folder`);
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    const folder = parts.slice(0, i).join('/');
    if (files.some((file) => file.path === folder)) throw new Conflict(`"${folder}" is a file, not a folder`);
  }
}

function entry(path, head, now) {
  return {
    path,
    size: head.ContentLength,
    type: head.ContentType || 'application/octet-stream',
    modified: new Date(now).toISOString(),
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function createFiles({ s3, bucket, region, maxBytes, tokenKey, now = Date.now, invalidate = async () => {} }) {
  const sdk = () => require('@aws-sdk/client-s3');
  const presign = (key, query) => presignUrl({ method: 'PUT', bucket, region, key, query, expiresIn: URL_SECONDS, now: now() });
  const seconds = () => Math.floor(now() / 1000);

  function readToken(token) {
    const upload = verifySigned(token, tokenKey, now());
    if (!upload || typeof upload.path !== 'string' || typeof upload.uploadId !== 'string') throw new NotFound('Upload not found or expired');
    return upload;
  }

  // Server-side copy within the bucket. Large files are copied in parallel parts so moves stay fast.
  async function copy(from, to, file) {
    const { CopyObjectCommand, CreateMultipartUploadCommand, UploadPartCopyCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } = sdk();
    const source = `${bucket}/${from.split('/').map(encodeURIComponent).join('/')}`;
    if (file.size <= SIMPLE_COPY_MAX) {
      await s3.send(new CopyObjectCommand({
        Bucket: bucket, Key: to, CopySource: source, MetadataDirective: 'REPLACE',
        ContentType: file.type, CacheControl: store.FILE_CACHE_CONTROL, StorageClass: STORAGE_CLASS,
      }));
      return;
    }
    const partSize = Math.max(COPY_PART_MIN, Math.ceil(file.size / MAX_PARTS / MiB) * MiB);
    const count = Math.ceil(file.size / partSize);
    const { UploadId } = await s3.send(new CreateMultipartUploadCommand({
      Bucket: bucket, Key: to, ContentType: file.type, CacheControl: store.FILE_CACHE_CONTROL, StorageClass: STORAGE_CLASS,
    }));
    try {
      const parts = await mapLimit(Array.from({ length: count }, (_, i) => i + 1), COPY_CONCURRENCY, async (n) => {
        const start = (n - 1) * partSize;
        const end = Math.min(n * partSize, file.size) - 1;
        const result = await s3.send(new UploadPartCopyCommand({
          Bucket: bucket, Key: to, UploadId, PartNumber: n, CopySource: source, CopySourceRange: `bytes=${start}-${end}`,
        }));
        return { PartNumber: n, ETag: result.CopyPartResult.ETag };
      });
      await s3.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: to, UploadId, MultipartUpload: { Parts: parts } }));
    } catch (error) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: to, UploadId })).catch(() => {});
      throw error;
    }
  }

  return {
    async createUpload(body) {
      const path = cleanPath(body.path);
      const bytes = size(body.size, maxBytes);
      const type = contentType(body.contentType);
      const listing = await store.readListing(s3, bucket);
      checkFolderClash(listing.files, path);
      const replacing = listing.files.some((file) => file.path === path);
      if (replacing && body.overwrite !== true) throw new Conflict(`"${path}" already exists`);

      const { CreateMultipartUploadCommand } = sdk();
      const created = await s3.send(new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: path,
        ContentType: type,
        CacheControl: store.FILE_CACHE_CONTROL,
        // Rarely downloaded files move to cheaper tiers by themselves.
        StorageClass: STORAGE_CLASS,
      }));
      const plan = partPlan(bytes);
      const token = sign({ path, uploadId: created.UploadId, size: bytes, ...plan, exp: seconds() + TOKEN_SECONDS }, tokenKey);
      return { token, path, ...plan, replacing };
    },

    async signParts(body) {
      const upload = readToken(body.token);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (!parts.length || parts.length > PARTS_PER_CALL) throw new BadRequest(`Ask for 1 to ${PARTS_PER_CALL} parts at a time`);
      const urls = {};
      for (const part of parts) {
        if (!Number.isInteger(part) || part < 1 || part > upload.partCount) throw new BadRequest('Invalid part number');
        urls[part] = presign(upload.path, { partNumber: part, uploadId: upload.uploadId });
      }
      return { urls };
    },

    async completeUpload(body) {
      const upload = readToken(body.token);
      const parts = Array.isArray(body.parts) ? body.parts : [];
      if (parts.length !== upload.partCount) throw new BadRequest(`Expected ${upload.partCount} parts, got ${parts.length}`);
      const sorted = parts.map((p) => {
        if (!p || !Number.isInteger(p.partNumber) || typeof p.etag !== 'string' || !/^"?[0-9a-fA-F-]{1,64}"?$/.test(p.etag)) {
          throw new BadRequest('Invalid part list');
        }
        return { PartNumber: p.partNumber, ETag: p.etag };
      }).sort((a, b) => a.PartNumber - b.PartNumber);
      if (sorted.some((p, i) => p.PartNumber !== i + 1)) throw new BadRequest('Invalid part list');

      const { CompleteMultipartUploadCommand } = sdk();
      await s3.send(new CompleteMultipartUploadCommand({
        Bucket: bucket, Key: upload.path, UploadId: upload.uploadId, MultipartUpload: { Parts: sorted },
      }));
      const head = await store.headObject(s3, bucket, upload.path);
      if (!head) throw new Error('Uploaded file is missing');
      const file = entry(upload.path, head, now());
      let replaced = false;
      await store.updateListing(s3, bucket, (listing) => {
        replaced = listing.files.some((f) => f.path === file.path);
        listing.files = listing.files.filter((f) => f.path !== file.path).concat(file);
        return true;
      }, now());
      if (replaced) await invalidate([store.urlPath(file.path)]);
      return { file };
    },

    async abortUpload(body) {
      const upload = readToken(body.token);
      const { AbortMultipartUploadCommand } = sdk();
      await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: upload.path, UploadId: upload.uploadId }))
        .catch((error) => { if (!store.isMissing(error) && error.name !== 'NoSuchUpload') throw error; });
      return { aborted: true };
    },

    /** Moves or renames a file, or a folder and everything in it. */
    async move(body) {
      const from = cleanPath(body.from, 'from');
      const to = cleanPath(body.to, 'to');
      if (from === to) throw new BadRequest('The new path is the same as the old one');
      if (isUnder(to, from)) throw new BadRequest('A folder cannot be moved into itself');

      const listing = await store.readListing(s3, bucket);
      const file = listing.files.find((f) => f.path === from);
      const moves = (file ? [file] : listing.files.filter((f) => isUnder(f.path, from)))
        .map((f) => ({ file: f, to: to + f.path.slice(from.length) }));
      if (!moves.length) throw new NotFound(`"${from}" not found`);
      if (moves.length > MAX_MOVE_FILES) throw new BadRequest(`Folders with more than ${MAX_MOVE_FILES} files cannot be moved here`);
      if (moves.reduce((sum, m) => sum + m.file.size, 0) > MAX_MOVE_BYTES) throw new BadRequest('Too much data to move at once');
      const remaining = listing.files.filter((f) => !moves.some((m) => m.file.path === f.path));
      for (const m of moves) {
        if (remaining.some((f) => f.path === m.to)) throw new Conflict(`"${m.to}" already exists`);
        checkFolderClash(remaining, m.to);
      }

      const copied = [];
      try {
        await mapLimit(moves, 4, async (m) => {
          await copy(m.file.path, m.to, m.file);
          copied.push(m.to);
        });
      } catch (error) {
        await store.deleteKeys(s3, bucket, copied).catch(() => {});
        throw error;
      }
      const stamp = new Date(now()).toISOString();
      const moved = new Map(moves.map((m) => [m.file.path, m.to]));
      await store.updateListing(s3, bucket, (current) => {
        current.files = current.files
          .filter((f) => !moves.some((m) => m.to === f.path))
          .map((f) => (moved.has(f.path) ? { ...f, path: moved.get(f.path), modified: stamp } : f));
        return true;
      }, now());
      await store.deleteKeys(s3, bucket, moves.map((m) => m.file.path));
      await invalidate(file ? [store.urlPath(from)] : [`${store.urlPath(from)}/*`]);
      return { moved: moves.map((m) => ({ from: m.file.path, to: m.to })) };
    },

    /** Deletes a file, or a folder and everything in it. */
    async remove(body) {
      const path = cleanPath(body.path);
      let removed = [];
      let isFile = false;
      await store.updateListing(s3, bucket, (listing) => {
        isFile = listing.files.some((f) => f.path === path);
        removed = listing.files.filter((f) => f.path === path || (!isFile && isUnder(f.path, path))).map((f) => f.path);
        if (!removed.length) return undefined;
        listing.files = listing.files.filter((f) => !removed.includes(f.path));
        return true;
      }, now());
      if (!removed.length) throw new NotFound(`"${path}" not found`);
      await store.deleteKeys(s3, bucket, removed);
      await invalidate(isFile ? [store.urlPath(path)] : [`${store.urlPath(path)}/*`]);
      return { deleted: removed };
    },
  };
}

module.exports = { BadRequest, Conflict, NotFound, cleanPath, createFiles, partPlan };
