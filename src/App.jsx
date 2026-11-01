import React, { useEffect, useRef, useState } from "react";

// Viewer chrome only. Document HTML is NEVER rendered by React:
// it is loaded in a sandboxed iframe. The stored HTML is never
// changed — the viewer only wraps it at render time with a
// bridge script that exposes window.agentdocs.kv and
// window.agentdocs.apiFetch via postMessage to this chrome.
// kv calls the api repo's state endpoints; apiFetch resolves a
// registered internal API (or an author-provided token URL, if
// its origin is trusted), fetches that endpoint's token with
// the viewer's sign-in, calls the API, and returns only
// {status, data} to the document. Tokens never enter document
// code. No dangerouslySetInnerHTML, no parsing of document HTML
// anywhere in this app.
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

async function api(path) {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    throw new Error(`${res.status} ${path}`);
  }
  return res.json();
}

async function apiCall(path, method, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}`);
  }
  return res.json();
}

async function apiText(path) {
  const res = await fetch(`${API}${path}`);
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

// Viewer token source — MAINTAINER: replace this with the real
// Entra token acquisition (e.g. MSAL acquireTokenSilent) before
// distributing the viewer. Returning null means token-URL calls
// are attempted without an Authorization header; token URLs
// that need a viewer token will fail until this is wired.
async function getViewerToken() {
  return null;
}

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
  function apiFetch(apiRef, second) {
    // apiFetch("reports", "/reports/q3") — registered name + path.
    // apiFetch("https://internal-a/api/reports") — full URL, resolved via registry.
    // apiFetch("https://internal-a/api/reports", "https://internal-a/token") — author-provided token URL.
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      apiPending[id] = { resolve: resolve, reject: reject };
      var tokenUrl = null;
      var path = second || "";
      if (second && second.indexOf("http") === 0) {
        tokenUrl = second;
        path = "";
      }
      window.parent.postMessage(
        { type: "agentdocs-api", id: id, apiRef: apiRef, path: path, tokenUrl: tokenUrl },
        "*"
      );
    });
  }
  var kv = {
    get: function (key) { return call("get", key); },
    all: function () { return call("all"); },
    set: function (key, value) { return call("set", key, value); },
    delete: function (key) { return call("delete", key); },
    patch: function (patch) { return call("patch", null, null, patch); },
  };
  window.agentdocs = { kv: kv, apiFetch: apiFetch };
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

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [error, setError] = useState("");
  const [docSrc, setDocSrc] = useState("");
  const [stateEntries, setStateEntries] = useState({});
  const [stateKey, setStateKey] = useState("");
  const [stateValue, setStateValue] = useState("");
  const [apis, setApis] = useState([]);
  const iframeRef = useRef(null);
  const apisRef = useRef([]);
  const tokenCacheRef = useRef(new Map());

  useEffect(() => {
    api("/v1/documents")
      .then((data) => setDocuments(data.documents || []))
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

  async function openDocument(docId) {
    setError("");
    setSelectedId(docId);
    try {
      const data = await api(`/v1/documents/${docId}/versions`);
      setVersions(data.versions || []);
      const latest = (data.versions || []).at(-1);
      setSelectedVersionId(latest ? latest.id : null);
      await loadState(docId);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!selectedId || !selectedVersionId) {
      setDocSrc("");
      return;
    }
    apiText(`/v1/documents/${selectedId}/versions/${selectedVersionId}/html`)
      .then((html) => setDocSrc(withBridge(html)))
      .catch((e) => setError(String(e)));
  }, [selectedId, selectedVersionId]);

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
  async function fetchTokenFor(entry) {
    const cached = tokenCacheRef.current.get(entry.name || entry.api_url);
    if (cached && cached.exp && cached.exp > Date.now() + 60000) {
      return cached.token;
    }
    const viewerToken = await getViewerToken();
    const headers = { "Content-Type": "application/json" };
    if (viewerToken) headers.Authorization = `Bearer ${viewerToken}`;
    const body = entry.scope ? { scope: entry.scope } : {};
    const res = await fetch(entry.token_url, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`token fetch failed ${res.status}`);
    const data = await res.json();
    const token = data.access_token;
    if (!token) throw new Error("token URL did not return an access_token");
    const exp = jwtExpiryMs(token);
    tokenCacheRef.current.set(entry.name || entry.api_url, { token, exp });
    return token;
  }

  async function callRegisteredApi(apiRef, path, tokenUrlOverride) {
    let entry = apisRef.current.find((a) => a.name === apiRef);
    let fullUrl;
    if (entry) {
      const base = entry.api_url.replace(/\/$/, "");
      fullUrl = path ? `${base}/${String(path).replace(/^\//, "")}` : base;
    } else if (typeof apiRef === "string" && apiRef.indexOf("http") === 0) {
      fullUrl = apiRef;
      entry = apisRef.current.find((a) => fullUrl.indexOf(a.api_url.replace(/\/$/, "")) === 0);
      if (!entry && tokenUrlOverride) {
        if (TRUSTED_TOKEN_URL_ORIGINS.length > 0) {
          const origin = new URL(tokenUrlOverride).host;
          if (!TRUSTED_TOKEN_URL_ORIGINS.includes(origin)) {
            throw new Error("token URL origin not trusted");
          }
        }
        entry = { name: fullUrl, api_url: fullUrl, token_url: tokenUrlOverride, scope: "" };
      }
      if (!entry) throw new Error("api_not_registered");
    } else {
      throw new Error("api_not_registered");
    }
    async function doCall() {
      const token = await fetchTokenFor(entry);
      return fetch(fullUrl, { headers: { Authorization: `Bearer ${token}` } });
    }
    let res = await doCall();
    if (res.status === 401) {
      tokenCacheRef.current.delete(entry.name || entry.api_url);
      res = await doCall();
    }
    let data;
    try {
      data = await res.json();
    } catch {
      data = await res.text();
    }
    return { status: res.status, data };
  }

  useEffect(() => {
    async function onApiMessage(e) {
      const frame = iframeRef.current;
      if (!frame || e.source !== frame.contentWindow) return;
      const d = e.data || {};
      if (d.type !== "agentdocs-api") return;
      try {
        const result = await callRegisteredApi(d.apiRef, d.path, d.tokenUrl);
        frame.contentWindow.postMessage({ type: "agentdocs-api-response", id: d.id, ok: true, status: result.status, data: result.data }, "*");
      } catch (err) {
        frame.contentWindow.postMessage({ type: "agentdocs-api-response", id: d.id, ok: false, error: String(err) }, "*");
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
                <span>latest v{d.latest_version}</span>
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
              <li key={a.name}>
                {a.name}
                <span>{a.api_url}</span>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <main className="viewer">
        {selectedVersionId && (
          <div className="toolbar">
            <label>
              Version{" "}
              <select
                value={selectedVersionId}
                onChange={(e) => setSelectedVersionId(e.target.value)}
              >
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    v{v.number} — {v.change_summary || "(no summary)"}
                  </option>
                ))}
              </select>
            </label>
            <span className="hint">
              Latest is the default; any older version is viewable.
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
