# Canvas UI — Copilot instructions (repo: canvas-ui)

You are building the Canvas viewer from scratch. Canvas is a
governed publication and audit layer for agent-built documents.
This repo is the viewer only. Do not build the API, CLI, or MCP
server here — those are separate repos. This repo talks to the
Canvas API over HTTP and to nothing else for data.

## Authentication: unauthenticated for now

- **The viewer and every API call it makes are unauthenticated
  for now.** Do not build login, token storage, token refresh,
  session cookies, or RBAC in this repo. The maintainer will wire
  authentication later and will say so explicitly when that changes.
- Send no credentials with any request. Do not read, store, or
  forward a token URL, and do not perform a token fetch, even if
  the API registry contains a `token_url` — in unauthenticated
  mode it is stored but never used.
- Never put a secret, token, or credential in code, logs, or
  error messages. Never render a bucket URL, an S3 key, or a
  token in the UI.

## Stack

- React + Vite. Viewer chrome only.
- Documents are plain, self-contained HTML — never React, never
  JSX inside a document. The viewer must render any valid
  published HTML, including old versions, unchanged.
- Tests: the viewer's own test runner; `npm run build` must pass.
- API base URL from an environment variable (default
  `http://127.0.0.1:8000` for local dev). Do not hardcode a
  production API URL.

## What the viewer does (locked scope)

- Document list, document view, version history, shared-state
  editor, registry view. Nothing else: no comments, reactions,
  mentions, notifications, grants/sharing UI, folders, search,
  live presence, or in-browser document editing.

## Rendering: sandboxed iframe + bridge

- Render each document in a sandboxed iframe. The React chrome
  owns the page around it.
- The document never calls the network directly. The chrome
  injects a bridge via `postMessage` exposing, at minimum:
  - `window.agentdocs.kv` — get / set / delete / patch shared
    state for the current document.
  - `window.agentdocs.apiFetch` — live data. GET by default;
    POST, PUT, DELETE supported. First argument is a registered
    `app_name` or a full URL resolved via the registry; second
    is the path. Example: `apiFetch("reports", "/reports/q3")`.
    In unauthenticated mode, `apiFetch` sends no credentials.
  - `window.agentdocs.navigate` — move to another document by id,
    plus `<a data-agentdocs-doc="doc_...">` links and
    `?doc=<id>` deep-links.
- Live data goes only via `apiFetch`. Documents must never
  `fetch()` an internal API directly, and must never see S3
  objects or bucket URLs — version HTML comes from the API's
  `.../versions/{number}/html` endpoint, after the API's SHA-256
  check.

## Version resolution (exact, never fallback)

- No version in the URL means latest: `?doc=<id>` shows
  `max(version_no)`.
- An explicit version means exactly that version or 404:
  `?version=N` pins N. NEVER fall back to latest for an
  explicitly requested version.
- Version history lists versions by number, newest first, from
  `GET /v1/documents/{doc_id}/versions`.
- A document with no versions still appears, with NULL version
  columns — that is how an unpublished doc reads.

## Shared state (KV, document-scoped)

- State is document-scoped, NOT version-scoped: changing it
  never creates a version, and publishing a new version does not
  reset it. The state editor in the chrome edits the same keys
  the document's bridge sees.
- Endpoints used (Canvas API, unauthenticated):
  `GET /v1/documents/{doc_id}/state`,
  `POST /v1/documents/{doc_id}/state` (patch),
  `GET /v1/documents/{doc_id}/state/{key}`,
  `PUT /v1/documents/{doc_id}/state/{key}`,
  `DELETE /v1/documents/{doc_id}/state/{key}`.
- Setting a key to null deletes it. Do not display a stored null.

## Registry view (read-only in this repo)

- Read the registry with `GET /v1/apis` and
  `GET /v1/apis/{app_name}` for display and for resolving
  `apiFetch` app names to base URLs.
- Do not add registry create/update/delete/sync UI here unless
  asked — registry writes belong to the API/CLI/MCP surface.
- Display fields are `app_name` / `base_url`, with nullable
  `token_url` / `swagger_url`. Never display a token, and in
  unauthenticated mode never use `token_url` for a fetch.

## Usage beacon (fire-and-forget)

- After every `apiFetch` settles (success or failure), report
  the call to `POST /v1/usage` with `document_id`,
  `version_no` (the resolved version that made the call),
  `app_name`, `method`, `path`, `status_code` (NULL when no
  response arrived), `error`, `duration_ms`.
- Strip query strings from `path` before sending. NEVER send
  query strings, request or response bodies, headers, or tokens.
  Prefer the endpoint template from the registry snapshot over
  a raw path when the path matches a known endpoint.
- Beacon failures are dropped silently. A logging failure must
  never break a document.

## API endpoints this repo consumes (do not invent others)

- `GET /health`
- `GET /v1/documents`, `GET /v1/documents/{doc_id}`
- `GET /v1/documents/{doc_id}/versions`,
  `GET /v1/documents/{doc_id}/versions/{number}`,
  `GET /v1/documents/{doc_id}/versions/{number}/html`
- State endpoints above, registry read endpoints above,
  `POST /v1/usage`.
- This repo does NOT call publish, create, registry write, or
  sync endpoints. If a user asks to publish from the viewer,
  that is out of scope for this repo — say so, do not add it.

## Tests and acceptance

- Tests for: latest vs pinned version resolution (including
  404 with no fallback), state editor round-trip with no new
  version created, beacon payload with no query string/body/
  token, bridge `kv` / `apiFetch` / `navigate` wiring.
- Acceptance, before calling the build done: open a published
  document (latest renders), pin `?version=1` (version 1
  renders, unchanged after a v2 publish), open a missing version
  (404, no fallback), change a state key (no new version, key
  survives a publish), and confirm one usage row per `apiFetch`.
- A live click-through against a running Canvas API is still
  required before shipping, even if unit tests pass.

## Never reintroduce

Drafts, `?draft=1`, approval gates, version ids, `base_version_id`,
409 flow, `change_summary`, `byte_size`, inline HTML handling,
comments, reactions, mentions, notifications, grants, sharing UI,
authentication, login, token verification, RBAC, or any direct
network call from a document.
