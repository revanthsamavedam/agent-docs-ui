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
the API registry from `GET /v1/apis`, resolves the API's
per-endpoint token URL, fetches that token with the viewer's
sign-in (see `getViewerToken` in `src/App.jsx` — MAINTAINER:
replace it with real Entra token acquisition before
distributing), caches the token per API until expiry,
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

## Drafts — test a local file on the actual viewer link

"Open local file as draft" in the sidebar creates a new
draft-only document from a local HTML file (nothing is
published) and opens it at `?doc=<id>&draft=1`, through the
same bridge as a published page — live data, state, and
navigation all work. The draft banner on that link has
Publish draft and Discard draft buttons, and a document with
a draft shows a View draft button on its published view.
A draft is never a version, and saving one touches no
published version.

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
