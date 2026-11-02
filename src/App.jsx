import React, { useEffect, useRef, useState } from "react";
import { createUsageBeacon } from "./usageBeacon.js";

// Viewer chrome only. Document HTML is NEVER rendered by React:
// it is loaded in a sandboxed iframe. The stored HTML is never
// changed — the viewer only wraps it at render time with a
// bridge script that exposes window.agentdocs.kv,
// window.agentdocs.apiFetch, and window.agentdocs.navigate
// via postMessage to this chrome. Navigation: the chrome
// renders a nav bar over the document list, documents link
// to each other with window.agentdocs.navigate(docId) or
// <a data-agentdocs-doc="doc_...">, and ?doc=<id> deep-links
// a page, with an optional ?version=N pinning one version.
// State stays document-scoped across navigation.
// kv calls the api repo's state endpoints; apiFetch resolves a
// registered internal API by app_name, fetches that API's token
// with the viewer's sign-in, calls the API, and returns only
// {status, data} to the document. Tokens never enter document
// code. apiFetch supports GET (default), POST, PUT, and DELETE;
// a GET with a body is rejected, and a POST is not auto-retried
// on 401 (a blind retry could duplicate a creation). No
// dangerouslySetInnerHTML, no parsing of document HTML anywhere
// in this app.
//
// Versions: a document's versions are numbered 1, 2, 3, ... and
// immutable. ?doc=<id> with no version shows the LATEST
// version. ?doc=<id>&version=N shows exactly version N; if
// that version does not exist the viewer shows a not-found
// error and NEVER silently falls back to latest, so a pinned
// link can never show different content than it promises.
//
// Usage beacon: after every apiFetch settles (success or
// failure), the chrome queues a usage event and flushes it to
// POST /v1/usage (see usageBeacon.js). The beacon carries no
// query strings, bodies, headers, or tokens, and a beacon
// failure never breaks the document or the call.
//
// Shared state is document-scoped, not version-scoped: changing
// it never creates a version, and it survives across versions.
//
// The components below are plain React placeholders. Swap them
// for the approved component library later; no approved library
// name is invented or depended on here.
const API = (import.meta.env.VITE_API_URL || "http://127.0.0.1:8000").replace(
  /\/$/,
  ""
);

// Viewer token source — MAINTAINER: replace this with the real
// Entra token acquisition (e.g. MSAL acquireTokenSilent) before
// distributing the viewer. Returning null means api-repo calls
// are attempted without an Authorization header; the server
// then records the actor as anonymous. Token-URL calls that
// need a viewer token will fail until this is wired.
async function getViewerToken() {
  return null;
}

// Auth headers shared by every bridge call to the api repo,
// including the usage beacon: the server derives the actor
// from this header, never from a client-supplied field.
async function viewerHeaders() {
  let token = null;
  try {
    token = await getViewerToken();
  } catch {
    token = null;
  }
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function api(path) {
  const res = await fetch(`${API}${path}`, {
    headers: await viewerHeaders(),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}`);
  }
  return res.json();
}

async function apiCall(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { ...(await viewerHeaders()), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}`);
  }
  return res.json();
}

async function apiText(path) {
  const res = await fetch(`${API}${path}`, {
    headers: await viewerHeaders(),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}`);
  }
  return res.text();
}

// Trusted token-URL origins, set in code by the maintainer
// before production (empty = no origin restriction in this
// build, for local onboarding; production should list the
// internal domains / Entra tenant allowed here).
const TRUSTED_TOKEN_URL_ORIGINS = [];

function jwtExpiryMs(token) {
  try {
    const payload = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Render-time bridge, injected into a copy of the stored HTML only.
// The stored version stays byte-identical; this script never lands
// in the api repo. It talks to the viewer chrome by postMessage,
// and the chrome talks to the api repo's /state endpoints.
const BRIDGE_SCRIPT = `
(function () {
  var pending = {};
  var nextId = 1;
  function call(op, key, value, patch) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      window.parent.postMessage(
        { type: "agentdocs-kv", id: id, op: op, key: key, value: value, patch: patch },
        "*"
      );
    });
  }
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type !== "agentdocs-kv-response" || !pending[d.id]) return;
    var p = pending[d.id];
    delete pending[d.id];
    if (d.ok) p.resolve(d.value);
    else p.reject(new Error(d.error || "kv error"));
  });
  var apiPending = {};
  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type !== "agentdocs-api-response" || !apiPending[d.id]) return;
    var p = apiPending[d.id];
    delete apiPending[d.id];
    if (d.ok) p.resolve({ status: d.status, data: d.data });
    else p.reject(new Error(d.error || "api error"));
  });
  function apiFetch(apiRef, second, third) {
    // apiFetch("reports", "/reports/q3") — GET, registered app_name + path.
    // apiFetch("https://internal-a/api/reports") — GET, full URL, resolved via registry.
    // apiFetch("https://internal-a/api/reports", "https://internal-a/token") — GET, author-provided token URL.
    // apiFetch("reports", "/reports", { method: "POST", body: { status: "open" } }) — POST/PUT/DELETE.
    // apiFetch("reports", { method: "DELETE" }) — options as the second argument (path defaults to "").
    // The document never sees a token and never sets Authorization:
    // the viewer chrome adds the token and owns the call. A GET
    // with a body is rejected by the chrome, not sent.
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      apiPending[id] = { resolve: resolve, reject: reject };
      var tokenUrl = null;
      var path = "";
      var options = null;
      if (second && typeof second === "object") {
        options = second;
      } else if (second && second.indexOf("http") === 0) {
        tokenUrl = second;
      } else {
        path = second || "";
      }
      if (third) options = third;
      window.parent.postMessage(
        { type: "agentdocs-api", id: id, apiRef: apiRef, path: path, tokenUrl: tokenUrl,
          method: options ? options.method : null, body: options ? options.body : null },
        "*"
      );
    });
  }
  function navigate(docId) {
    // navigate("doc_...") — ask the viewer chrome to switch pages.
    // A plain <a href> inside the sandboxed iframe would navigate
    // the iframe itself and lose the chrome, so navigation goes
    // through this bridge, same pattern as kv and apiFetch.
    window.parent.postMessage({ type: "agentdocs-navigate", docId: docId }, "*");
  }
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[data-agentdocs-doc]") : null;
    if (a) {
      e.preventDefault();
      navigate(a.getAttribute("data-agentdocs-doc"));
    }
  });
  var kv = {
    get: function (key) { return call("get", key); },
    all: function () { return call("all"); },
    set: function (key, value) { return call("set", key, value); },
    delete: function (key) { return call("delete", key); },
    patch: function (patch) { return call("patch", null, null, patch); },
  };
  window.agentdocs = { kv: kv, apiFetch: apiFetch, navigate: navigate };
  window.slashdocs = { kv: kv };
})();
`;

function withBridge(html) {
  const script = `<script>${BRIDGE_SCRIPT}<\/script>`;
  if (html.includes("</body>")) {
    return html.replace("</body>", `${script}</body>`);
  }
  return html + script;
}

function nowMs() {
  if (typeof performance !== "undefined" && performance.now) {
    return performance.now();
  }
  return Date.now();
}

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedVersionNo, setSelectedVersionNo] = useState(null);
  const [error, setError] = useState("");
  const [docSrc, setDocSrc] = useState("");
  const [stateEntries, setStateEntries] = useState({});
  const [stateKey, setStateKey] = useState("");
  const [stateValue, setStateValue] = useState("");
  const [apis, setApis] = useState([]);
  const iframeRef = useRef(null);
  const apisRef = useRef([]);
  const documentsRef = useRef([]);
  const tokenCacheRef = useRef(new Map());
  // Refs (not state) for the beacon: apiFetch handlers are
  // registered once, so they must read the document/version
  // that made the call, not a stale closure.
  const selectedIdRef = useRef(null);
  const selectedVersionNoRef = useRef(null);
  const beaconRef = useRef(null);
  if (beaconRef.current === null) {
    beaconRef.current = createUsageBeacon({
      apiBase: API,
      getHeaders: viewerHeaders,
      sendBeaconImpl:
        typeof navigator !== "undefined" && navigator.sendBeacon
          ? navigator.sendBeacon.bind(navigator)
          : null,
      fetchImpl: typeof fetch !== "undefined" ? fetch.bind(window) : null,
    });
  }

  async function refreshDocuments() {
    const data = await api("/v1/documents");
    const docs = data.documents || [];
    setDocuments(docs);
    documentsRef.current = docs;
    return docs;
  }

  // Beacon flush on a timer, on page hide, and on unload-path
  // visibility loss. A failed flush is dropped by the beacon
  // itself; nothing here can throw into the document.
  useEffect(() => {
    const beacon = beaconRef.current;
    beacon.start();
    const flush = () => {
      void beacon.flush();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      beacon.stop();
    };
  }, []);

  useEffect(() => {
    api("/v1/documents")
      .then((data) => {
        const docs = data.documents || [];
        setDocuments(docs);
        documentsRef.current = docs;
        // Deep-link: ?doc=<id> opens that page on load, so nav
        // links are shareable and bookmarkable. ?doc=<id>&version=N
        // pins exactly version N; a missing or invalid version
        // is an error, never a silent fall back to latest.
        const params = new URLSearchParams(window.location.search);
        const wanted = params.get("doc");
        if (wanted && docs.some((d) => d.id === wanted)) {
          if (params.has("version")) {
            const n = Number(params.get("version"));
            if (!Number.isInteger(n) || n < 1) {
              setError("Invalid version in link.");
            } else {
              openDocument(wanted, n);
            }
          } else {
            openDocument(wanted);
          }
        }
      })
      .catch((e) => setError(String(e)));
    api("/v1/apis")
      .then((data) => {
        setApis(data.apis || []);
        apisRef.current = data.apis || [];
      })
      .catch(() => setApis([]));
  }, []);

  async function loadState(docId) {
    try {
      const data = await api(`/v1/documents/${docId}/state`);
      setStateEntries(data.state || {});
    } catch (e) {
      setStateEntries({});
    }
  }

  async function openDocument(docId, versionNo = null) {
    setError("");
    setSelectedId(docId);
    selectedIdRef.current = docId;
    try {
      const url =
        versionNo === null
          ? `?doc=${encodeURIComponent(docId)}`
          : `?doc=${encodeURIComponent(docId)}&version=${versionNo}`;
      window.history.replaceState(null, "", url);
    } catch {
      // Non-browser / restricted contexts: URL sync is best-effort.
    }
    try {
      const data = await api(`/v1/documents/${docId}/versions`);
      const list = data.versions || [];
      setVersions(list);
      await loadState(docId);
      if (versionNo === null) {
        const latest = list.at(-1);
        if (!latest) {
          setSelectedVersionNo(null);
          selectedVersionNoRef.current = null;
          setDocSrc("");
          return;
        }
        setSelectedVersionNo(latest.number);
        selectedVersionNoRef.current = latest.number;
      } else {
        const wanted = list.find((v) => v.number === versionNo);
        if (!wanted) {
          // Explicit version requested but missing: never fall
          // back to latest — a pinned link must not show
          // different content than it promises.
          setSelectedVersionNo(null);
          selectedVersionNoRef.current = null;
          setDocSrc("");
          setError(`Version ${versionNo} not found for this document.`);
          return;
        }
        setSelectedVersionNo(wanted.number);
        selectedVersionNoRef.current = wanted.number;
      }
    } catch (e) {
      setVersions([]);
      setSelectedVersionNo(null);
      selectedVersionNoRef.current = null;
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!selectedId || selectedVersionNo === null || selectedVersionNo === undefined) {
      setDocSrc("");
      return;
    }
    apiText(`/v1/documents/${selectedId}/versions/${selectedVersionNo}/html`)
      .then((html) => setDocSrc(withBridge(html)))
      .catch((e) => setError(String(e)));
  }, [selectedId, selectedVersionNo]);

  // Bridge replies: document JS -> chrome -> api repo -> document JS.
  // Only messages from this viewer iframe are honoured.
  useEffect(() => {
    async function onMessage(e) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data || {};
      if (d.type !== "agentdocs-kv" || !selectedId) return;
      try {
        let value;
        if (d.op === "all") {
          value = (await api(`/v1/documents/${selectedId}/state`)).state;
        } else if (d.op === "get") {
          value = (await api(`/v1/documents/${selectedId}/state/${encodeURIComponent(d.key)}`)).value;
        } else if (d.op === "set") {
          await apiCall(`/v1/documents/${selectedId}/state/${encodeURIComponent(d.key)}`, "PUT", { value: d.value });
          value = d.value;
        } else if (d.op === "delete") {
          await apiCall(`/v1/documents/${selectedId}/state/${encodeURIComponent(d.key)}`, "DELETE");
          value = null;
        } else if (d.op === "patch") {
          value = (await apiCall(`/v1/documents/${selectedId}/state`, "POST", { patch: d.patch })).state;
        } else {
          throw new Error(`unknown kv op ${d.op}`);
        }
        frame.contentWindow.postMessage({ type: "agentdocs-kv-response", id: d.id, ok: true, value }, "*");
        await loadState(selectedId);
      } catch (err) {
        frame.contentWindow.postMessage({ type: "agentdocs-kv-response", id: d.id, ok: false, error: String(err) }, "*");
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [selectedId]);

  // apiFetch bridge: document -> chrome -> token URL -> internal API -> document.
  // The document never receives a token. Tokens are cached per API
  // until expiry, refreshed once on a 401, and never stored.
  // A token_url of null on a registry entry means no token fetch
  // (apiKey/bearer schemes): the call goes out without
  // Authorization instead of failing.
  async function fetchTokenFor(entry) {
    const cached = tokenCacheRef.current.get(entry.app_name || entry.base_url);
    if (cached && cached.exp && cached.exp > Date.now() + 60000) {
      return cached.token;
    }
    const viewerToken = await getViewerToken();
    const headers = { "Content-Type": "application/json" };
    if (viewerToken) headers.Authorization = `Bearer ${viewerToken}`;
    const res = await fetch(entry.token_url, { method: "POST", headers, body: JSON.stringify({}) });
    if (!res.ok) throw new Error(`token fetch failed ${res.status}`);
    const data = await res.json();
    const token = data.access_token;
    if (!token) throw new Error("token URL did not return an access_token");
    const exp = jwtExpiryMs(token);
    tokenCacheRef.current.set(entry.app_name || entry.base_url, { token, exp });
    return token;
  }

  // Methods the bridge supports. GET is the default. POST/PUT/
  // DELETE go through the same registry lookup, token fetch, and
  // trusted-origin checks as GET — the document still never sees
  // a token and cannot set Authorization (the chrome sets it).
  const API_METHODS = ["GET", "POST", "PUT", "DELETE"];

  function beaconError(err) {
    const msg = err && err.message ? err.message : String(err);
    if (msg === "api_not_registered") return "unregistered_app";
    if (msg === "unsupported_method") return "unsupported_method";
    if (msg === "get_with_body_not_allowed") return "get_with_body_not_allowed";
    if (msg === "token URL origin not trusted") return "token_url_origin_not_trusted";
    if (msg.startsWith("token fetch failed")) return "token_fetch_failed";
    if (msg === "token URL did not return an access_token") return "token_fetch_failed";
    if (err instanceof TypeError) return "network_error";
    return "call_failed";
  }

  async function callRegisteredApi(apiRef, path, tokenUrlOverride, options) {
    const method = (options?.method || "GET").toUpperCase();
    const fail = (message, appName, beaconPath) => {
      const err = new Error(message);
      err.beaconAppName = appName;
      err.beaconPath = beaconPath;
      throw err;
    };
    if (!API_METHODS.includes(method)) {
      fail("unsupported_method", typeof apiRef === "string" ? apiRef : "", path || "");
    }
    if (method === "GET" && options?.body !== undefined && options?.body !== null) {
      fail("get_with_body_not_allowed", typeof apiRef === "string" ? apiRef : "", path || "");
    }
    let entry = apisRef.current.find((a) => a.app_name === apiRef);
    let fullUrl;
    let beaconPath = path || "";
    if (entry) {
      const base = entry.base_url.replace(/\/$/, "");
      fullUrl = path ? `${base}/${String(path).replace(/^\//, "")}` : base;
    } else if (typeof apiRef === "string" && apiRef.indexOf("http") === 0) {
      fullUrl = apiRef;
      try {
        beaconPath = new URL(fullUrl).pathname;
      } catch {
        beaconPath = "";
      }
      entry = apisRef.current.find((a) => fullUrl.indexOf(a.base_url.replace(/\/$/, "")) === 0);
      if (!entry && tokenUrlOverride) {
        if (TRUSTED_TOKEN_URL_ORIGINS.length > 0) {
          const origin = new URL(tokenUrlOverride).host;
          if (!TRUSTED_TOKEN_URL_ORIGINS.includes(origin)) {
            fail("token URL origin not trusted", fullUrl, beaconPath);
          }
        }
        entry = { app_name: fullUrl, base_url: fullUrl, token_url: tokenUrlOverride };
      }
      if (!entry) fail("api_not_registered", fullUrl, beaconPath);
    } else {
      fail("api_not_registered", typeof apiRef === "string" ? apiRef : "", path || "");
    }
    const beaconAppName = entry.app_name;
    async function doCall() {
      // Null token_url = no token fetch: call without Authorization.
      const token = entry.token_url ? await fetchTokenFor(entry) : null;
      const headers = {};
      if (token) headers.Authorization = `Bearer ${token}`;
      const init = { method, headers };
      if (options?.body !== undefined && options?.body !== null) {
        headers["Content-Type"] = "application/json";
        init.body = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
      }
      return fetch(fullUrl, init);
    }
    try {
      let res = await doCall();
      // 401 retry, once — but only for idempotent methods and only
      // when a token was actually fetched. A POST is not retried
      // automatically: if the first attempt was actually applied,
      // a blind retry could create a duplicate. A POST that
      // returns 401 is returned to the document, which can retry
      // explicitly if it knows the call is safe to repeat.
      if (res.status === 401 && method !== "POST" && entry.token_url) {
        tokenCacheRef.current.delete(entry.app_name || entry.base_url);
        res = await doCall();
      }
      let data;
      try {
        data = await res.json();
      } catch {
        data = await res.text();
      }
      return { status: res.status, data, beaconAppName, beaconPath };
    } catch (e) {
      if (e.beaconAppName === undefined) e.beaconAppName = beaconAppName;
      if (e.beaconPath === undefined) e.beaconPath = beaconPath;
      throw e;
    }
  }

  // Navigate bridge: document -> chrome -> switch document.
  // Only a document id already in the viewer's list is honoured;
  // an unknown id is ignored, never fetched blindly.
  // Navigation always opens the LATEST version (no version pin).
  useEffect(() => {
    function onNavigateMessage(e) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data || {};
      if (d.type !== "agentdocs-navigate") return;
      if (documentsRef.current.some((doc) => doc.id === d.docId)) {
        openDocument(d.docId);
      }
    }
    window.addEventListener("message", onNavigateMessage);
    return () => window.removeEventListener("message", onNavigateMessage);
  }, []);

  useEffect(() => {
    async function onApiMessage(e) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data || {};
      if (d.type !== "agentdocs-api") return;
      // Attribute the call to the document/version that made it,
      // captured here — not at settle time, when the user may
      // already have navigated elsewhere.
      const docId = selectedIdRef.current;
      const versionNo = selectedVersionNoRef.current;
      const method = (d.method || "GET").toUpperCase();
      const start = nowMs();
      const beacon = beaconRef.current;
      const report = (fields) => {
        // No document selected (should not happen for an iframe
        // call) means no attribution: skip rather than log junk.
        if (!docId || !beacon) return;
        beacon.enqueue({
          document_id: docId,
          version_no: versionNo,
          method,
          duration_ms: Math.round(nowMs() - start),
          ...fields,
        });
      };
      try {
        const result = await callRegisteredApi(d.apiRef, d.path, d.tokenUrl, { method: d.method, body: d.body });
        frame.contentWindow.postMessage({ type: "agentdocs-api-response", id: d.id, ok: true, status: result.status, data: result.data }, "*");
        report({
          app_name: result.beaconAppName,
          path: result.beaconPath,
          status_code: result.status,
          error: null,
        });
      } catch (err) {
        frame.contentWindow.postMessage({ type: "agentdocs-api-response", id: d.id, ok: false, error: String(err) }, "*");
        report({
          app_name: err.beaconAppName || (typeof d.apiRef === "string" ? d.apiRef : ""),
          path: err.beaconPath || d.path || "",
          status_code: null,
          error: beaconError(err),
        });
      }
    }
    window.addEventListener("message", onApiMessage);
    return () => window.removeEventListener("message", onApiMessage);
  }, []);

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>agent-docs</h1>
        <p className="hint">Publish, view, version history, and shared state.</p>
        {error && <p className="error">{error}</p>}
        <ul>
          {documents.map((d) => (
            <li key={d.id}>
              <button
                className={d.id === selectedId ? "active" : ""}
                onClick={() => openDocument(d.id)}
              >
                {d.title}
                <span>
                  {d.latest_version ? `latest v${d.latest_version}` : "no versions yet"}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {documents.length === 0 && !error && (
          <p className="hint">No documents yet. Publish one via the MCP or CLI.</p>
        )}
        <h2>Registered APIs</h2>
        {apis.length === 0 ? (
          <p className="hint">None yet. Register one via `apis register` (CLI) or `register_api` (MCP).</p>
        ) : (
          <ul>
            {apis.map((a) => (
              <li key={a.app_name}>
                {a.app_name}
                <span>{a.base_url}</span>
                {a.swagger_url && <span>swagger: {a.swagger_url}</span>}
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="viewer">
        {documents.length > 0 && (
          <nav className="doc-nav" aria-label="Site navigation">
            {documents.map((d) => (
              <button
                key={d.id}
                className={d.id === selectedId ? "active" : ""}
                onClick={() => openDocument(d.id)}
              >
                {d.title}
              </button>
            ))}
          </nav>
        )}
        {selectedVersionNo !== null && selectedVersionNo !== undefined && (
          <div className="toolbar">
            <label>
              Version{" "}
              <select
                value={selectedVersionNo}
                onChange={(e) => openDocument(selectedId, Number(e.target.value))}
              >
                {versions.map((v) => (
                  <option key={v.number} value={v.number}>
                    v{v.number} — {v.created_at || ""}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">
              Latest is the default; any older version is viewable.
              A ?version=N link pins that version exactly.
            </span>
          </div>
        )}
        {selectedId && (
          <div className="toolbar">
            <strong>Document state</strong>
            <span className="hint">
              Shared, document-scoped — survives versions, never creates one.
            </span>
            <ul>
              {Object.entries(stateEntries).map(([k, v]) => (
                <li key={k}>
                  {k}: {JSON.stringify(v)}{" "}
                  <button
                    onClick={async () => {
                      await apiCall(`/v1/documents/${selectedId}/state/${encodeURIComponent(k)}`, "DELETE");
                      await loadState(selectedId);
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
            <label>
              Key{" "}
              <input value={stateKey} onChange={(e) => setStateKey(e.target.value)} />
            </label>{" "}
            <label>
              Value (JSON, or plain text){" "}
              <input value={stateValue} onChange={(e) => setStateValue(e.target.value)} />
            </label>{" "}
            <button
              onClick={async () => {
                if (!stateKey) return;
                let parsed;
                try {
                  parsed = JSON.parse(stateValue);
                } catch {
                  parsed = stateValue;
                }
                await apiCall(`/v1/documents/${selectedId}/state/${encodeURIComponent(stateKey)}`, "PUT", { value: parsed });
                setStateKey("");
                setStateValue("");
                await loadState(selectedId);
              }}
            >
              Set
            </button>
          </div>
        )}
        {docSrc ? (
          <iframe
            ref={iframeRef}
            title="Document"
            srcDoc={docSrc}
            // Sandboxed render surface. allow-scripts lets the document's
            // own scripts run (including the render-time kv bridge);
            // allow-same-origin is deliberately NOT set, so document
            // code cannot reach this app's origin. The stored HTML is
            // unchanged; the bridge is added only to this render copy.
            sandbox="allow-scripts"
            className="doc-frame"
          />
        ) : (
          <p className="hint">Select a document to view it.</p>
        )}
      </main>
    </div>
  );
}
