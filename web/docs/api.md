# Files API

This reference is for trusted tools, scripts and AI agents managing files on https://files.dliu.com. The same guide is available as plain Markdown at https://files.dliu.com/docs/api.md.

The managed API accepts Microsoft-issued user access tokens. It can list files, upload new files or replace existing ones, move or rename files and folders, and delete them when the token has the corresponding permission. **Every file is public:** a completed upload is immediately downloadable by anyone at its URL and appears in the public listing. There is no private, draft or unlisted state.

**Authentication is required:** configure your requester using the [Auth API documentation](https://auth.dliu.com/docs/api). That is the canonical guide for credentials, token acquisition, the default `~/.dliu_token` file, expiry and bearer transport; this reference covers only the Files API.

## Quick rules

1. The managed API origin is `{{FILES_API_URL}}` (deployment output `MicrosoftApiUrl`). Use it exactly, with no path, query, credentials or trailing slash. All eight managed routes are listed below.
2. Configure authentication according to the [Auth API documentation](https://auth.dliu.com/docs/api) before using any managed route. Files website sign-in is not managed API authentication.
3. POST bodies are JSON objects with `Content-Type: application/json`. Keep bodies below 64 KiB; the Lambda checks decoded string length against 65,536 JavaScript code units. Do not send file bytes or multipart form data to this API.
4. Managed API requests do not need `Origin`, website cookies or `x-amz-content-sha256`. The website cookie API is a separate entry point; do not send bearer requests to `https://files.dliu.com/api/*`.
5. Every successful managed endpoint returns HTTP 200 and JSON, including creation and deletion. Errors come from either the gateway (`{"message":"..."}`) or Lambda (`{"error":"..."}`).
6. Request only user-authorized operations. Completing an upload publishes the file; replacing changes what existing links download; moving changes URLs; deletion removes files. Do not run write/delete examples just to check a token.
7. Treat presigned S3 URLs and upload tokens as credentials. Never put them in chat, URLs you share, source files, logs or saved tool settings. Do not follow API or S3 redirects with credentials.
8. Read the current listing before changing anything, and serialize operations on the same path. There is no ETag or conditional-update API.
9. Public file URLs are cached at CloudFront for up to a day and in browsers for 5 minutes. Replacing or deleting a file clears CloudFront's copy within seconds, so a browser may still show the old file for up to 5 minutes.

## Endpoint summary

| Method and path | Required scope | Operation |
| --- | --- | --- |
| [GET /api/me](#get-api-me) | `files.read` | Read the authenticated user identity |
| [GET /api/files](#get-api-files) | `files.read` | List every file |
| [POST /api/uploads](#post-api-uploads) | `files.write` | Start a new upload or a replacement |
| [POST /api/uploads/parts](#post-api-uploads-parts) | `files.write` | Request presigned S3 part URLs |
| [POST /api/uploads/complete](#post-api-uploads-complete) | `files.write` | Complete and publish the uploaded file |
| [POST /api/uploads/abort](#post-api-uploads-abort) | `files.write` | Cancel an unfinished upload |
| [POST /api/files/move](#post-api-files-move) | `files.write` | Move or rename a file or folder |
| [POST /api/files/delete](#post-api-files-delete) | `files.delete` | Delete a file or folder |

`files.write` does not include `files.delete`. There is no per-file GET, download, PUT/PATCH, token-management, login or logout route on the managed API. Download public files from the website.

## Authentication

Follow the required [Auth API documentation](https://auth.dliu.com/docs/api) before calling Files. Credential lookup, token storage, expiry/renewal and authorization-header construction belong there, not in this site-specific guide.

Microsoft consent and user assignment still apply. The gateway validates the Microsoft signature, tenant-specific v2 issuer, audience, token times and route scope. Lambda also requires the configured gateway context, tenant, audience, approved client `azp`, user object/subject IDs and the shared Microsoft-issued user role `api.access` (display name "dliu API user"). That role is shared by the dliu managed APIs and grants nothing alone: every route still requires its own `files.*` scope. Only the site owner's designated account is assigned the role; other organisation users who can sign in to the website do not gain API access from that sign-in, and their tokens are refused. Website cookies never provide a fallback on this entry point.

The existing dliu API registration is both the SPA client and resource; its ID must match both `azp` and `aud`. Tokens come only from Central Microsoft sign-in at auth.dliu.com. An ID token, Graph access token, app-only token or Files session cookie is not a substitute for the required delegated access token.

Managed Files code has no application-global bearer-token cache, token persistence or raw bearer-header/full-event logging across Lambda invocations. Request-local values and warm-runtime memory may remain until garbage collection; this is not a forensic zeroization guarantee. Website sign-in, cookies and public downloads remain separate and unchanged.

## Files request examples

These examples assume a token configured per the [Auth API documentation](https://auth.dliu.com/docs/api). Any requester that follows that guide works: send the documented method, path and JSON body to `{{FILES_API_URL}}`. From a Files checkout (dliu-com/file-server), the bundled client does this with Node.js 22+ after `npm ci`. It reads `~/.dliu_token` for every request, refuses redirects and accepts only the routes below:

```bash
export FILES_API_URL='{{FILES_API_URL}}'
node scripts/api-client.js GET /api/me
node scripts/api-client.js GET /api/files
```

The workflow examples below use this Bash adapter. Placeholder paths and sample data are illustrative; use the paths of your authorized task:

```bash
# files_api METHOD /api/path [JSON_BODY]
files_api() {
  node scripts/api-client.js "$@"
}

files_api GET /api/me
files_api GET /api/files
```

Capture responses containing upload tokens or presigned URLs in local variables rather than printing them. Build JSON with `jq` so paths and tokens are escaped.

## Paths and file objects

A path is the file's location without leading or trailing slashes, such as `me/resume.pdf`. Folders are not stored: a folder exists while at least one file has a path under it, so there is no create-folder call, and empty folders disappear.

| Rule | Detail |
| --- | --- |
| Normalization | Unicode NFC; surrounding whitespace and leading/trailing slashes are removed |
| Names | Each `/`-separated name is 1 to 255 characters, with no leading/trailing spaces, not `.` or `..`, and without `\`, `?`, `#`, `%` or control characters |
| Length | At most 1,024 UTF-8 bytes |
| Reserved | Top-level `_app`, `_data`, `api`, `auth` and `index.html`, and the exact paths `docs/api` and `docs/api.md` |
| Clashes | A file cannot have the same path as a folder, or sit under a path that is a file |

The listing uses this complete file object:

```json
{"path":"me/resume.pdf","size":524288,"type":"application/pdf","modified":"2026-11-01T12:00:00.000Z"}
```

| Field | Meaning |
| --- | --- |
| `path` | The normalized path |
| `size` | Actual stored length in bytes |
| `type` | MIME type served with the file |
| `modified` | ISO 8601 time of the last upload, replacement or move |

The public download URL is `https://files.dliu.com/` followed by the path with each name percent-encoded, for example `https://files.dliu.com/me/resume.pdf`. A folder's page is the folder path with a trailing slash, such as `https://files.dliu.com/me/`. These URLs are on the website, not the managed API origin.

## Read endpoints

### GET /api/me

Required scope: `files.read`.

No body or query parameters. Response (200):

```json
{"user":"<user-object-id>","name":"Example user"}
```

`user` is the Microsoft user object ID, not an email address. `name` is the token's display name when present, otherwise the same object ID.

### GET /api/files

Required scope: `files.read`.

No body or query parameters. Response (200):

```json
{"files":[{"path":"me/resume.pdf","size":524288,"type":"application/pdf","modified":"2026-11-01T12:00:00.000Z"}],"updatedAt":"2026-11-01T12:00:00.000Z"}
```

Every file in one response, sorted by path; there is no pagination or filter. `updatedAt` is the time of the last change, or null before the first upload. It is the same data as the public `https://files.dliu.com/_data/files.json`.

## Multipart upload and replacement

File bytes go directly to S3, never through API Gateway or Lambda. New uploads and replacements use the same four routes.

1. Start the upload with the path, byte length and MIME type. Keep the returned `token`, `partSize` and `partCount` in memory.
2. Request URLs for the part numbers you need (1-based, at most 100 per request).
3. Split the file into exactly `partCount` sequential chunks of `partSize` bytes, with only the final chunk smaller. PUT each chunk's raw bytes to its own URL and keep the S3 `ETag` response header.
4. Complete with every part number and its ETag. This publishes the file at its path, replacing any existing file there.
5. To cancel before completion, abort with the same `token`. Aborting a replacement leaves the existing file untouched.

`token` is a signed upload token returned by Files, not your Microsoft access token; send it only in these request bodies. It is valid for 2 days, after which S3 also discards unfinished uploads. Part size is at least 16 MiB and a whole number of MiB, increased if needed to stay within 10,000 parts; use the returned plan rather than hardcoding it. Presigned URLs are issued for 3,600 seconds, but the signing Lambda's temporary AWS credentials can expire sooner; request fresh URLs with the same token when needed.

Do not send Microsoft bearer authorization, website cookies or `x-amz-content-sha256` to S3. Keep the exact presigned URL, including its query string, and do not use multipart form encoding. Browser uploads are CORS-enabled only for `https://files.dliu.com`; the token console is not an upload UI. There is no upload-status or resume-list endpoint.

### POST /api/uploads

Required scope: `files.write`.

Request:

```json
{"path":"me/resume.pdf","size":524288,"contentType":"application/pdf"}
```

| Field | Required/limits |
| --- | --- |
| `path` | Required; see path rules |
| `size` | Required integer, 1 to 53,687,091,200 bytes (current 50 GiB configured cap) |
| `contentType` | Optional MIME type such as `application/pdf`, at most 200 characters; omitted, null or empty becomes `application/octet-stream`. Stored in lower case |
| `overwrite` | Must be `true` to replace an existing file at `path`; otherwise that returns 409 |

Response (200):

```json
{"token":"<upload-token>","path":"me/resume.pdf","partSize":16777216,"partCount":1,"replacing":false}
```

`path` is the normalized path that will be published. `replacing` is true when a file existed at the start. The existing file keeps being served until completion. Files are not scanned or inspected; send exactly the declared bytes.

**Large-upload limitation:** the 50 GiB start cap does not guarantee completion. The completion JSON, including the upload token and every part ETag, must fit the 65,536-code-unit body limit. With S3's usual quoted 32-character part ETags that is about 1,000 parts, roughly 15 GiB at 16 MiB parts. Budget the completion JSON before sending bytes, as the example below does, and abort if it is too large.

### POST /api/uploads/parts

Required scope: `files.write`.

Request:

```json
{"token":"<upload-token>","parts":[1,2,3]}
```

`parts` is an array of 1 to 100 integers, each from 1 to `partCount`. You can request a part URL again if it expires.

Response (200):

```json
{"urls":{"1":"https://<presigned-part-1-url>","2":"https://<presigned-part-2-url>","3":"https://<presigned-part-3-url>"}}
```

Keys are JSON strings for the requested part numbers. PUT the raw bytes of one chunk:

```bash
# PART_URL is one URL returned above; part-1.bin is exactly that file chunk.
curl --silent --show-error --fail-with-body --proto '=https' \
  --request PUT --upload-file part-1.bin "$PART_URL" --dump-header part-1.headers
```

Extract the `ETag` from the response headers without printing the URL. It is opaque and can include surrounding quotes; keep it as a properly escaped JSON string. Remove saved header files after the operation.

### POST /api/uploads/complete

Required scope: `files.write`.

Request:

```json
{
  "token": "<upload-token>",
  "parts": [
    {"partNumber":1,"etag":"\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\""}
  ]
}
```

Send exactly `partCount` entries, numbered 1 through `partCount` once each, in any order. Each ETag is 1 to 64 hexadecimal/hyphen characters, optionally in quotes, and must be the actual S3 ETag of that part.

Response (200):

```json
{"file":{"path":"me/resume.pdf","size":524288,"type":"application/pdf","modified":"2026-11-01T12:00:00.000Z"}}
```

The file is public and listed at once. Completion replaces whatever is at the path at that moment, even if the start reported `replacing: false`; the CDN copy of a replaced file is invalidated. Do not retry completion blindly: if a response is lost, list files and check the result before doing anything else.

### POST /api/uploads/abort

Required scope: `files.write`.

Request:

```json
{"token":"<upload-token>"}
```

Response (200):

```json
{"aborted":true}
```

Cancels the multipart upload and discards uploaded parts. Aborting an already cancelled or completed upload also returns `aborted: true` and does not touch a published file. An invalid or expired token returns 404.

## Moving and deleting

### POST /api/files/move

Required scope: `files.write`.

Request:

```json
{"from":"me/resume.pdf","to":"me/cv/resume.pdf"}
```

`from` is an existing file, or a folder to move with everything under it. `to` is the new path; it must not already exist, clash with a file or folder, be the same as `from`, or be inside the folder being moved. A folder move is limited to 200 files and 50 GiB in total.

Response (200):

```json
{"moved":[{"from":"me/resume.pdf","to":"me/cv/resume.pdf"}]}
```

Files are copied within S3, listed at their new paths with a new `modified` time, then removed from the old paths, whose URLs stop working. A missing `from` returns 404 and an existing destination returns 409.

### POST /api/files/delete

Required scope: `files.delete`.

Request:

```json
{"path":"me/cv/resume.pdf"}
```

Response (200):

```json
{"deleted":["me/cv/resume.pdf"]}
```

Deletes one file, or a folder and every file under it, and invalidates their CDN paths. A missing path returns 404. The bucket keeps deleted and replaced versions for 30 days for administrator recovery; the API cannot restore them.

## Errors

| Status | Body | Meaning |
| --- | --- | --- |
| 400 | `{"error":"..."}` | Invalid body, path, size, content type, part list or move |
| 401 | `{"message":"Unauthorized"}` | Gateway: missing, malformed, expired or wrong-audience/issuer token |
| 401 | `{"error":"Microsoft access token required"}` | Lambda: token claims are not from the configured gateway, tenant or resource |
| 403 | `{"message":"Forbidden"}` | Gateway: the token lacks the route's scope |
| 403 | `{"error":"Files API permission required"}` | Lambda: wrong client, missing `api.access` role or missing scope |
| 404 | `{"message":"Not Found"}` or `{"error":"..."}` | Unknown route, missing file or folder, or an invalid or expired upload token |
| 409 | `{"error":"..."}` | The path already exists or clashes with a file or folder |
| 503 | `{"error":"..."}` | Upload routes only: the server's upload-signing configuration is missing; this is not a token problem |
| 500 | `{"error":"Internal error"}` | Unexpected failure; check the listing before retrying a change |

Do not retry 400, 401, 403 or 409 responses unchanged. For 401 obtain a fresh token as described in the [Auth API documentation](https://auth.dliu.com/docs/api).

## Practical upload

This Bash example uploads an explicitly authorized local file to an explicitly chosen path with curl and `jq`; do not run it as a read-only check. It does not overwrite an existing file. It requests one part URL at a time and completes only after every PUT succeeds.

```bash
(
  set -e
  LOCAL_FILE=resume.pdf
  REMOTE_PATH=me/resume.pdf
  SIZE=$(wc -c < "$LOCAL_FILE" | tr -d ' ')
  PLAN=$(files_api POST /api/uploads \
    "$(jq -cn --arg path "$REMOTE_PATH" --argjson size "$SIZE" \
      '{path:$path,size:$size,contentType:"application/pdf"}')")
  TOKEN=$(printf '%s' "$PLAN" | jq -er '.token')
  PART_SIZE=$(printf '%s' "$PLAN" | jq -er '.partSize')
  PART_COUNT=$(printf '%s' "$PLAN" | jq -er '.partCount')
  # Sized for S3's usual quoted 32-character part ETags.
  BUDGET=$(jq -cn --arg token "$TOKEN" --argjson count "$PART_COUNT" \
    '{token:$token,parts:[range(1;$count+1) | {partNumber:.,etag:("\""+("a"*32)+"\"")}]}')
  if [ "$(printf '%s' "$BUDGET" | wc -c)" -gt 65536 ]; then
    files_api POST /api/uploads/abort "$(jq -cn --arg token "$TOKEN" '{token:$token}')" > /dev/null
    printf 'Completion JSON would exceed the API limit; upload cancelled before sending bytes.\n' >&2
    exit 1
  fi
  PARTS='[]'
  WORK_DIR=$(mktemp -d)
  cleanup() {
    rm -f -- "$WORK_DIR/part.bin" "$WORK_DIR/headers"
    rmdir "$WORK_DIR"
  }
  trap cleanup EXIT

  for ((part=1; part<=PART_COUNT; part++)); do
    URLS=$(files_api POST /api/uploads/parts \
      "$(jq -cn --arg token "$TOKEN" --argjson part "$part" '{token:$token,parts:[$part]}')")
    PART_URL=$(printf '%s' "$URLS" | jq -er --arg key "$part" '.urls[$key]')
    dd if="$LOCAL_FILE" of="$WORK_DIR/part.bin" bs=1048576 \
      skip=$(((part-1)*(PART_SIZE/1048576))) count=$((PART_SIZE/1048576)) 2> /dev/null
    curl --silent --show-error --fail-with-body --proto '=https' \
      --request PUT --upload-file "$WORK_DIR/part.bin" "$PART_URL" \
      --dump-header "$WORK_DIR/headers" --output /dev/null
    ETAG=$(awk 'tolower($1) == "etag:" {
      sub(/^[^:]*:[ \t]*/, ""); sub(/\r$/, ""); print; exit
    }' "$WORK_DIR/headers")
    : "${ETAG:?S3 did not return an ETag}"
    PARTS=$(jq -cn --argjson parts "$PARTS" --argjson part "$part" --arg etag "$ETAG" \
      '$parts + [{partNumber:$part,etag:$etag}]')
  done

  files_api POST /api/uploads/complete \
    "$(jq -cn --arg token "$TOKEN" --argjson parts "$PARTS" '{token:$token,parts:$parts}')"
)
```

## dliu.com shared resources

This site also hosts the files every dliu.com site shares, under `/dliu.com/`: the shared look (`ui/v1/dl.css`, `ui/v1/dl-docs.css`) and the DL logo. They are published from the shared-resources repository, not through this API; do not upload, move or delete anything under `dliu.com/`.

The [shared resources guide](https://files.dliu.com/dliu.com/README.md) explains how a site uses them, including the page markup, the Content-Security-Policy additions and the optional traffic monitoring page script (`https://traffic.dliu.com/t/s.js`), which stays on traffic.dliu.com.

Architecture, running costs and security of this site are on the [docs page](https://files.dliu.com/docs).
