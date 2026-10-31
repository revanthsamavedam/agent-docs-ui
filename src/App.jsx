import React, { useEffect, useState } from "react";

// Viewer chrome only. Document HTML is NEVER rendered by React:
// it is loaded in a sandboxed iframe whose src is the api repo's
// raw-HTML endpoint. No dangerouslySetInnerHTML, no parsing of
// document HTML anywhere in this app.
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

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [versions, setVersions] = useState([]);
  const [selectedVersionId, setSelectedVersionId] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api("/v1/documents")
      .then((data) => setDocuments(data.documents || []))
      .catch((e) => setError(String(e)));
  }, []);

  async function openDocument(docId) {
    setError("");
    setSelectedId(docId);
    try {
      const data = await api(`/v1/documents/${docId}/versions`);
      setVersions(data.versions || []);
      const latest = (data.versions || []).at(-1);
      setSelectedVersionId(latest ? latest.id : null);
    } catch (e) {
      setError(String(e));
    }
  }

  const iframeSrc =
    selectedId && selectedVersionId
      ? `${API}/v1/documents/${selectedId}/versions/${selectedVersionId}/html`
      : null;

  return (
    <div className="layout">
      <aside className="sidebar">
        <h1>agent-docs</h1>
        <p className="hint">Publish, view, and version history only.</p>
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
        {iframeSrc ? (
          <iframe
            title="Document"
            src={iframeSrc}
            // Sandboxed render surface. allow-scripts lets the document's
            // own scripts run; allow-same-origin is deliberately NOT set,
            // so document code cannot reach this app's origin.
            // In production the API/render origin differs from this UI origin.
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
