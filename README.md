# agent-docs-ui

React + Vite frontend for agent-docs — viewer chrome only.
Separate repo — it talks to the api repo over HTTP and never
imports api, mcp, or cli code.

## Scope — publish, view, version history, and shared state

Screens:

- Document list
- Document viewer
- Version picker (latest by default; any older version viewable)
- Document state panel (view/set/delete shared state keys)
- Registered APIs list (from `GET /v1/apis`)

No comments, reactions, mentions, notifications, grants UI,
or approvals UI.

## The one rule this UI must never break

Document HTML is rendered only in a sandboxed iframe. This app
never uses `dangerouslySetInnerHTML` and never parses document
HTML. The stored version is never changed: the viewer fetches
the api repo's raw HTML, then renders a copy with a bridge
script added at render time only. That bridge exposes
`window.agentdocs.kv` (plus `window.slashdocs.kv`) to document
JavaScript, talking to this chrome by postMessage, which calls
the api repo's `/state` endpoints. The same bridge exposes
`window.agentdocs.apiFetch(apiName, path, options?)`: the chrome loads
the API registry from `GET /v1/apis`, resolves the app by
`app_name`, fetches that app's token with the viewer's
sign-in when the app has a `token_url` (a null `token_url`
means no token fetch — apiKey/bearer schemes — and the call
goes out without Authorization; see `getViewerToken` in
`src/App.jsx` — MAINTAINER: replace it with real Entra token
acquisition before distributing), caches the token per API
until expiry,
calls the API, and returns only
`{status, data}` to the document. Tokens never enter document
code. Methods: GET (default), POST, PUT, DELETE — e.g.
`apiFetch("refdp", "/reports", { method: "POST", body: { status: "open" } })`.
A GET with a body is rejected; a 401 is retried once for
idempotent methods only, never automatically for POST (a blind
retry could duplicate a creation). An author-provided token URL is honoured only if its
origin is in `TRUSTED_TOKEN_URL_ORIGINS` (empty in this build).
The iframe uses
`sandbox="allow-scripts"` only — `allow-same-origin` is
deliberately not set, so document code cannot reach the app's
origin. In production the API/render origin differs from this
UI origin.

The components in `src/` are plain React placeholders. Swap them
for the approved component library later; no approved library
name is invented or depended on here.

## Configuration

`VITE_API_URL` is baked into the bundle at build time. Changing
the API URL requires a rebuild and redeploy, not a config edit.

```
# .env.example (copy to .env for local dev)
VITE_API_URL=http://127.0.0.1:8000
```

## Run

```
npm ci
npm run dev
# with the api repo running on http://127.0.0.1:8000
```

## Versions — latest by default, ?version=N pins one

`?doc=<id>` with no version shows the latest version.
`?doc=<id>&version=N` shows exactly version N; if that
version does not exist the viewer shows a not-found error
and never silently falls back to latest, so a pinned link
can never show different content than it promises. The
version picker lists every version; picking one pins it in
the URL. Navigation between documents (nav bar,
`navigate(docId)`, `data-agentdocs-doc` links) always opens
the latest version. Version HTML always comes from the api
repo — the viewer never talks to S3 and never sees a
bucket URL.

## Usage beacon — what live data a document touched

After every apiFetch settles (success or failure), the
viewer chrome queues a usage event and flushes it to
`POST /v1/usage` (fetch keepalive, sendBeacon fallback; see
`src/usageBeacon.js`). Each event carries document_id, the
resolved version_no, app_name, method, path with any query
string stripped, status_code (null when no response
arrived), error, and duration_ms. The actor is derived
server-side from the viewer token. The beacon never carries
query strings, request/response bodies, headers, or tokens,
and a beacon failure never breaks the document or the call.

## Build

```
npm ci
npm run build
# produces dist/index.html + dist/assets/* hashed JS
```

## Deploy to S3 + CloudFront

`scripts/deploy.sh` deploys this repo's build to a private S3
bucket fronted by CloudFront (see the script's usage header).
It syncs hashed assets first with a long immutable cache, then
`index.html` last with no cache, then invalidates `/index.html`
on CloudFront. This script deploys the React chrome only —
document HTML is never put in this bucket; it stays served by
the api/render origin.

```
S3_BUCKET=agentdocs-ui-prod \
CLOUDFRONT_DISTRIBUTION_ID=E1234567890ABC \
VITE_API_URL=https://api.example.com \
./scripts/deploy.sh
```

One-time setup (bucket, Origin Access Control, distribution with
`index.html` as default root and 403/404 → `/index.html` SPA
fallbacks, bucket policy allowing only that distribution) must
be done before the first deploy; the API repo must also allow
CORS from the CloudFront origin.
