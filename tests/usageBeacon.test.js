import test from "node:test";
import assert from "node:assert/strict";
import { stripPath, createUsageBeacon } from "../src/usageBeacon.js";

test("stripPath removes query strings and fragments", () => {
  assert.equal(stripPath("/reports/1?secret=2"), "/reports/1");
  assert.equal(stripPath("/reports/1#section"), "/reports/1");
  assert.equal(stripPath("/reports/1?a=b#s"), "/reports/1");
  assert.equal(stripPath("/reports"), "/reports");
  assert.equal(stripPath(""), "");
});

test("flush sends one POST per event with keepalive and whitelisted fields", async () => {
  const sent = [];
  const beacon = createUsageBeacon({
    apiBase: "http://api.test/",
    getHeaders: async () => ({}),
    fetchImpl: async (url, init) => {
      sent.push({ url, init });
    },
  });
  beacon.enqueue({
    document_id: "doc_abc",
    version_no: 3,
    app_name: "refdp",
    method: "GET",
    path: "/reports/1?secret=2",
    status_code: 200,
    error: null,
    duration_ms: 42,
    token: "must-never-leave",
    body: { x: 1 },
    headers: { Authorization: "Bearer nope" },
  });
  await beacon.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, "http://api.test/v1/usage");
  assert.equal(sent[0].init.method, "POST");
  assert.equal(sent[0].init.keepalive, true);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.path, "/reports/1");
  assert.equal(body.document_id, "doc_abc");
  assert.equal(body.version_no, 3);
  assert.equal("token" in body, false);
  assert.equal("body" in body, false);
  assert.equal("headers" in body, false);
  assert.equal(beacon.length, 0);
});

test("flush drains the whole batch", async () => {
  const sent = [];
  const beacon = createUsageBeacon({
    apiBase: "http://api.test",
    getHeaders: async () => ({}),
    fetchImpl: async (url, init) => {
      sent.push(init.body);
    },
  });
  beacon.enqueue({ document_id: "d", version_no: 1, app_name: "a", method: "GET", path: "/x", status_code: 200, error: null, duration_ms: 1 });
  beacon.enqueue({ document_id: "d", version_no: 1, app_name: "a", method: "POST", path: "/y", status_code: 201, error: null, duration_ms: 2 });
  beacon.enqueue({ document_id: "d", version_no: 2, app_name: "a", method: "GET", path: "/z", status_code: null, error: "network_error", duration_ms: 3 });
  await beacon.flush();
  assert.equal(sent.length, 3);
  assert.equal(beacon.length, 0);
});

test("delivery failures are swallowed and the queue still drains", async () => {
  const beacon = createUsageBeacon({
    apiBase: "http://api.test",
    getHeaders: async () => ({}),
    fetchImpl: async () => {
      throw new Error("beacon down");
    },
  });
  beacon.enqueue({ document_id: "d", version_no: 1, app_name: "a", method: "GET", path: "/x", status_code: null, error: "network_error", duration_ms: 1 });
  await beacon.flush();
  assert.equal(beacon.length, 0);
});

test("viewer auth headers ride the fetch keepalive call", async () => {
  const sent = [];
  const beacon = createUsageBeacon({
    apiBase: "http://api.test",
    getHeaders: async () => ({ Authorization: "Bearer viewer-token" }),
    sendBeaconImpl: () => {
      throw new Error("sendBeacon must not be used when auth headers exist");
    },
    fetchImpl: async (url, init) => {
      sent.push(init);
    },
  });
  beacon.enqueue({ document_id: "d", version_no: 1, app_name: "a", method: "GET", path: "/x", status_code: 200, error: null, duration_ms: 1 });
  await beacon.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].headers.Authorization, "Bearer viewer-token");
  assert.equal(sent[0].keepalive, true);
});

test("sendBeacon fallback is used when fetch is unavailable", async () => {
  const captured = [];
  const beacon = createUsageBeacon({
    apiBase: "http://api.test",
    getHeaders: async () => ({}),
    sendBeaconImpl: (url, payload) => {
      captured.push({ url, payload });
      return true;
    },
    fetchImpl: null,
  });
  beacon.enqueue({ document_id: "d", version_no: 1, app_name: "a", method: "GET", path: "/x?token=leak", status_code: 200, error: null, duration_ms: 1 });
  await beacon.flush();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].url, "http://api.test/v1/usage");
  const raw = captured[0].payload;
  const text = typeof raw === "string" ? raw : await raw.text();
  const body = JSON.parse(text);
  assert.equal(body.path, "/x");
  assert.equal("token" in body, false);
});
