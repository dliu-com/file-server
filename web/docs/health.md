# Testing files.dliu.com

How [status.dliu.com](https://status.dliu.com) tests this site as an anonymous guest. This is separate from the
[API reference](/docs/api), which is for signed-in users changing content. The tests here share no routes and no
credentials with it: they never sign in and have no AWS access.

A human-readable version with a diagram is at [/docs/health](/docs/health). This Markdown file is the full technical
version and is enough on its own to implement the tests.

## Rules

- **Read only.** Every check is a `GET` or `HEAD`. Nothing here changes content.
- **No credentials.** Send no cookies and no `Authorization` header. The checks must pass for any anonymous client.
- User agent for the live checker: `dliu-status-bot/1.0 (+https://status.dliu.com/docs)`. traffic.dliu.com drops this
  user agent, so the checks never count as traffic.

## Functions

| Key | Name | What it does | Critical |
| --- | --- | --- | --- |
| `pages` | Pages | The file browser (`/` and folder URLs) and the docs pages. | Yes |
| `shared-ui` | Shared UI | The shared stylesheet and icon under `/dliu.com/` that every dliu.com site loads. | Yes |
| `listing` | File list | The public file list `/_data/files.json` the browser reads. | No |
| `signin` | Sign-in | `/auth/login` redirects the owner to Microsoft. | Yes |
| `api` | API | The managed API refuses anonymous requests. | Yes |
| `health` | Health check | The `/health` endpoint reports each backend dependency. | Yes |

## Guest checks

One row per check. Method is `GET` (or `HEAD`) only, with no cookies and no `Authorization` header. URLs are absolute.

| Function | Method | URL | Expected status | Content-Type | Body marker / redirect |
| --- | --- | --- | --- | --- | --- |
| `pages` | GET | `https://files.dliu.com/` | 200 | `text/html` | body contains `dl-header` |
| `shared-ui` | GET | `https://files.dliu.com/dliu.com/ui/v1/dl.css` | 200 | `text/css` | body contains `--dl-` |
| `shared-ui` | GET | `https://files.dliu.com/dliu.com/favicon.png` | 200 | `image/png` | non-empty body |
| `listing` | GET | `https://files.dliu.com/_data/files.json` | 200 | `application/json` | JSON has key `files` |
| `signin` | GET | `https://files.dliu.com/auth/login` | 302 | — | `Location` starts with `https://login.microsoftonline.com/` |
| `api` | GET | `https://files.dliu.com/api/files` | 401 | `application/json` | JSON has key `error` |
| `health` | GET | `https://files.dliu.com/health` | 200 (or 503 when failing) | `application/health+json` | JSON has key `status` |

Notes:

- `/auth/login` is followed with redirects disabled; read the `Location` header, do not follow it to Microsoft.
- A missing file anywhere on the site returns `404` and the not-found page (`text/html`). The checks above target
  URLs that always exist.
- Treat a response slower than about 2 s as degraded (`warn`), not down.

## Health endpoint

`GET https://files.dliu.com/health`

- **No authentication.** CloudFront's `/health` behavior forwards no cookies, no `Authorization` header and no query
  string to the origin, and the Lambda reads none of them.
- **Read only.** One cheap read per dependency: an S3 `HeadObject` of a fixed key and an SSM parameter read the app
  already does. No S3 `LIST`, no writes, no calls to paid or rate-limited third parties. Each check has a 3 s timeout
  and the whole response returns within 5 s.
- **Cached 60 s** at CloudFront (cache key on nothing), so the Lambda runs at most about once a minute.
- **Reveals nothing private:** no bucket, table or function names, no counts, no user data, no stack traces. `output`
  is a short generic reason such as `timeout` or `read failed`.

Response: `Content-Type: application/health+json`. HTTP `200` when the top-level `status` is `pass` or `warn`, `503`
when it is `fail`. The top-level `status` is the worst of the functions'.

```json
{
  "status": "pass",
  "time": "2026-11-03T23:00:00Z",
  "functions": [
    { "key": "storage", "name": "File storage", "status": "pass" },
    { "key": "signin", "name": "Microsoft sign-in", "status": "pass" }
  ]
}
```

| Key | Name | Reads |
| --- | --- | --- |
| `storage` | File storage | S3 `HeadObject` of the file list key. A `404` still counts as reachable; only a timeout or real error is `fail`. |
| `signin` | Microsoft sign-in | Loads the Entra sign-in configuration from SSM (the same read the site uses to sign in). Missing configuration is `fail`. |

## Not tested

- Signed-in actions: uploading, moving or deleting files (the tests never sign in).
- Whether any particular file exists; the contents change over time.
- The owner account itself or its Microsoft password.
