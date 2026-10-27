// A tiny in-memory S3 for the API tests: handles the commands the Lambda sends.
const crypto = require('crypto');

function error(name, status) {
  return Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
}

const sourceKey = (copySource) => decodeURIComponent(copySource.slice(copySource.indexOf('/') + 1));

function createFakeS3() {
  const objects = new Map();
  const uploads = new Map();
  const calls = [];
  let etagCounter = 0;
  const put = (key, body, extra = {}) => {
    etagCounter += 1;
    const value = { body: Buffer.from(body || ''), etag: `"etag-${etagCounter}"`, ...extra };
    objects.set(key, value);
    return value;
  };

  async function send(command) {
    const name = command.constructor.name;
    const input = command.input;
    calls.push({ name, input });
    switch (name) {
      case 'GetObjectCommand': {
        const object = objects.get(input.Key);
        if (!object) throw error('NoSuchKey', 404);
        return { ETag: object.etag, Body: { transformToString: async () => object.body.toString('utf8') } };
      }
      case 'HeadObjectCommand': {
        const object = objects.get(input.Key);
        if (!object) throw error('NotFound', 404);
        return { ETag: object.etag, ContentLength: object.body.length, ContentType: object.contentType };
      }
      case 'PutObjectCommand': {
        const existing = objects.get(input.Key);
        if (input.IfNoneMatch === '*' && existing) throw error('PreconditionFailed', 412);
        if (input.IfMatch && (!existing || existing.etag !== input.IfMatch)) throw error('PreconditionFailed', 412);
        const object = put(input.Key, input.Body, { contentType: input.ContentType, cacheControl: input.CacheControl });
        return { ETag: object.etag };
      }
      case 'DeleteObjectCommand':
        objects.delete(input.Key);
        return {};
      case 'DeleteObjectsCommand':
        for (const { Key } of input.Delete.Objects) objects.delete(Key);
        return {};
      case 'CopyObjectCommand': {
        const object = objects.get(sourceKey(input.CopySource));
        if (!object) throw error('NoSuchKey', 404);
        put(input.Key, object.body, { contentType: input.ContentType, cacheControl: input.CacheControl, storageClass: input.StorageClass });
        return {};
      }
      case 'UploadPartCopyCommand': {
        const upload = uploads.get(input.UploadId);
        const object = objects.get(sourceKey(input.CopySource));
        if (!upload || !object) throw error('NoSuchKey', 404);
        const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(input.CopySourceRange);
        upload.parts.set(input.PartNumber, object.body.subarray(Number(start), Number(end) + 1));
        return { CopyPartResult: { ETag: `"part-${input.PartNumber}"` } };
      }
      case 'CreateMultipartUploadCommand': {
        const uploadId = crypto.randomBytes(6).toString('hex');
        uploads.set(uploadId, { key: input.Key, input, parts: new Map() });
        return { UploadId: uploadId };
      }
      case 'CompleteMultipartUploadCommand': {
        const upload = uploads.get(input.UploadId);
        if (!upload) throw error('NoSuchUpload', 404);
        uploads.delete(input.UploadId);
        // Copied parts are joined; browser-uploaded parts never reach this fake, so those get `completedSize` bytes.
        const body = upload.parts.size
          ? Buffer.concat(input.MultipartUpload.Parts.map((p) => upload.parts.get(p.PartNumber)))
          : Buffer.alloc(fakeS3.completedSize || 1234);
        put(input.Key, body, { contentType: upload.input.ContentType, cacheControl: upload.input.CacheControl, storageClass: upload.input.StorageClass });
        return {};
      }
      case 'AbortMultipartUploadCommand':
        if (!uploads.delete(input.UploadId)) throw error('NoSuchUpload', 404);
        return {};
      default:
        throw new Error(`Fake S3 does not handle ${name}`);
    }
  }

  const fakeS3 = { send, objects, uploads, calls, put, json: (key) => JSON.parse(objects.get(key).body.toString('utf8')) };
  return fakeS3;
}

module.exports = { createFakeS3 };
