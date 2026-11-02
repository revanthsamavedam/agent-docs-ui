// Live-call usage beacon (POST /v1/usage).
//
// apiFetch calls go browser -> target API directly, so the
// agent-docs API never sees them. The viewer chrome reports
// each settled call back here, fire-and-forget, so the log
// becomes audit evidence for what live data a document
// actually touched (which doc, which resolved version, which
// app, status, duration, viewer).
//
// What NEVER leaves the browser in a beacon event: query
// strings, request/response bodies, headers, and tokens.
// The actor is derived server-side from the viewer token,
// never from a client-supplied field. Event fields are
// whitelisted on enqueue, so extra caller fields are dropped.
//
// Delivery: fetch with keepalive is preferred — it carries
// the viewer auth headers and handles CORS preflights.
// navigator.sendBeacon is the fallback when fetch is
// unavailable; it cannot carry auth headers, so a beacon
// sent that way records the server-side actor as anonymous.
// Any delivery failure is swallowed: a logging outage must
// never break a document or an apiFetch call.

export function stripPath(path) {
  return String(path ?? "").split("?")[0].split("#")[0];
}

const EVENT_FIELDS = [
  "document_id",
  "version_no",
  "app_name",
  "method",
  "path",
  "status_code",
  "error",
  "duration_ms",
];

export function createUsageBeacon({
  apiBase,
  getHeaders = async () => ({}),
  sendBeaconImpl = null,
  fetchImpl = null,
  flushIntervalMs = 5000,
  maxBatch = 20,
}) {
  const base = String(apiBase || "").replace(/\/$/, "");
  let queue = [];
  let timer = null;

  function enqueue(event) {
    const ev = {
      document_id: event.document_id,
      version_no: event.version_no ?? null,
      app_name: event.app_name,
      method: event.method,
      path: stripPath(event.path ?? ""),
      status_code: event.status_code ?? null,
      error: event.error ?? null,
      duration_ms: event.duration_ms ?? 0,
    };
    // Whitelist: anything else the caller attached never leaves.
    for (const key of Object.keys(ev)) {
      if (!EVENT_FIELDS.includes(key)) delete ev[key];
    }
    queue.push(ev);
    if (queue.length >= maxBatch) void flush();
  }

  async function sendOne(ev) {
    const headers = await getHeaders().catch(() => ({}));
    const url = `${base}/v1/usage`;
    const body = JSON.stringify(ev);
    try {
      if (fetchImpl) {
        await fetchImpl(url, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
        return;
      }
      if (sendBeaconImpl) {
        const payload =
          typeof Blob !== "undefined"
            ? new Blob([body], { type: "application/json" })
            : body;
        sendBeaconImpl(url, payload);
      }
    } catch {
      // Dropped silently, by design.
    }
  }

  async function flush() {
    if (queue.length === 0) return;
    const events = queue;
    queue = [];
    for (const ev of events) {
      await sendOne(ev);
    }
  }

  function start() {
    stop();
    timer = setInterval(() => {
      void flush();
    }, flushIntervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    enqueue,
    flush,
    start,
    stop,
    get length() {
      return queue.length;
    },
  };
}
