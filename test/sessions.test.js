// webui/test/sessions.test.js
// Unit tests for server/routes/sessions.js — handleSwitchSession
//
// Why this test exists: v0.5.bx-32 — handleSwitchSession must NOT
// write cs.lastUsedWorkspace. Ponkan's feedback: "点 c 区任意对话
// (不发消息),c 区就自动置顶了,我想的是发消息才置顶". Switching
// session is browsing, not sending, so lastUsedWorkspace is only
// written by handleSend.

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { setupMocks, absPath, registerSessionsStore } from "./_setup.js";

// Helper: build a fake IncomingMessage that readJson() can consume
function fakeReq(body) {
  return Readable.from([Buffer.from(JSON.stringify(body), "utf8")]);
}
function fakeRes() {
  const res = {
    _status: 200,
    _headers: {},
    _body: null,
    writeHead(s, h) {
      this._status = s;
      if (h) this._headers = h;
    },
    end(b) {
      this._body = b;
    },
  };
  return res;
}

let handleSwitchSession, handleNewSession;
let makeClientState, clients;
let initialSessions;

before(async (t) => {
  await setupMocks(t, {
    // Mock mavis-usage to avoid loading the real one (which would re-import
    // node:child_process in the test context — Node 24 mock.module +
    // builtin interplay can stall the import).
    mavis: {
      applyMavisUsageToCs: async () => {}, // no-op
    },
  });
  const sb = await import(absPath("lib/state-bus.js"));
  makeClientState = sb.makeClientState;
  clients = sb.clients;
  const mod = await import(absPath("routes/sessions.js"));
  handleSwitchSession = mod.handleSwitchSession;
  handleNewSession = mod.handleNewSession;
});

beforeEach(() => {
  clients.clear();
  // Two pre-existing sessions on different workspaces
  initialSessions = [
    {
      id: "webui-A",
      title: "A on ws-A",
      workspace: "/ws-A",
      createdAt: 1,
      updatedAt: 1,
      chat: ["● hi from A"],
    },
    {
      id: "webui-B",
      title: "B on ws-B",
      workspace: "/ws-B",
      createdAt: 2,
      updatedAt: 2,
      chat: ["● hi from B"],
    },
  ];
  registerSessionsStore({ initial: initialSessions });
});

describe("handleSwitchSession — v0.5.bx-32 lastUsedWorkspace contract", () => {
  test("switching to a different workspace does NOT write lastUsedWorkspace", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    cs.lastUsedWorkspace = null; // initial state
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-B" }), res, ctx);

    assert.equal(res._status, 200, "switch should succeed");
    // The cs is mutated, but lastUsedWorkspace must still be null
    assert.equal(
      cs.lastUsedWorkspace,
      null,
      "switching sessions must not write lastUsedWorkspace (v0.5.bx-32)",
    );
  });

  test("switching to the same workspace does NOT write lastUsedWorkspace", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    cs.lastUsedWorkspace = "previous-value"; // pretend user sent earlier
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-A" }), res, ctx);

    assert.equal(res._status, 200);
    // lastUsedWorkspace unchanged — only handleSend should touch it
    assert.equal(
      cs.lastUsedWorkspace,
      "previous-value",
      "lastUsedWorkspace must not be touched by switch (v0.5.bx-32)",
    );
  });

  test("switch updates sessionId, mcodeSessionId, sessionTitle, chat", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-A", branch: null, tree: null };
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleSwitchSession(fakeReq({ id: "webui-B" }), res, ctx);

    assert.equal(cs.sessionId, "webui-B");
    assert.equal(cs.sessionTitle, "B on ws-B");
    assert.deepEqual(cs.chat, ["● hi from B"]);
  });
});

describe("handleNewSession", () => {
  test("creates a new session entry on disk and assigns cs.sessionId", async () => {
    const cid = "cid-1";
    const cs = makeClientState();
    cs.workspace = { dir: "/ws-NEW", branch: null, tree: null };
    clients.set(cid, cs);

    const ctx = { cs, cid, pathname: "" };
    const res = fakeRes();
    await handleNewSession(fakeReq({}), res, ctx);
    assert.equal(res._status, 200);
    assert.ok(cs.sessionId, "should assign a new sessionId");
    assert.equal(cs.chat.length, 0);
  });
});
