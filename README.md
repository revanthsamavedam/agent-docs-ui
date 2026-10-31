# agent-docs-ui

React + Vite frontend for agent-docs — viewer chrome only.
Separate repo — it talks to the api repo over HTTP and never
imports api, mcp, or cli code.

## Scope — publish, view, and version history only

Screens:

- Document list
- Document viewer
- Version picker (latest by default; any older version viewable)

No comments, reactions, mentions, notifications, shared state,
grants UI, or approvals UI.

## The one rule this UI must never break

Document HTML is rendered only in a sandboxed iframe whose `src`
is the api repo's raw-HTML endpoint
(`/v1/documents/{id}/versions/{version_id}/html`). This app never
uses `dangerouslySetInnerHTML` and never parses document HTML.
In production the API/render origin differs from this UI origin,
so document code cannot reach the app's origin. The iframe uses
`sandbox="allow-scripts"` only — `allow-same-origin` is
deliberately not set.

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
