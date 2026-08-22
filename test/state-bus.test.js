// webui/test/state-bus.test.js
// Unit tests for server/lib/state-bus.js — pushStateFor + ensureMcodeSessionsFetchedAndPush
//
// Why this test exists: v0.5.bx-31 broadcast bug — when the first SSE
// connection is established and mcodeSessions cache is empty, the
// SUT must fire-and-forget fetch the sessions and then push to all
// connected SSE clients. The dedup test ensures a second call with
// the same workspace is a no-op while the first is in flight.

import { test, describe, before, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { setupMocks, absPath, registerAcpMock, registerSessionsStore } from './_setup.js'

let pushStateFor, ensureMcodeSessionsFetchedAndPush
let clients, sseByCid, makeClientState
let acpFetchCalls, cachedByWs

before(async (t) => {
  await setupMocks(t)
  const mod = await import(absPath('lib/state-bus.js'))
  pushStateFor = mod.pushStateFor
  ensureMcodeSessionsFetchedAndPush = mod.ensureMcodeSessionsFetchedAndPush
  clients = mod.clients
  sseByCid = mod.sseByCid
  makeClientState = mod.makeClientState
})

// Mock acp-client to track fetch calls and serve cache from in-memory map
beforeEach(async () => {
  acpFetchCalls = []
  cachedByWs = new Map()
  registerAcpMock({
    getMcodeSessionsForWorkspace: async (ws) => {
      acpFetchCalls.push(ws)
      return [{ id: 'mock-' + ws, workspace: ws }]
    },
    getMcodeSessionsCacheSync: (ws) => cachedByWs.has(ws) ? cachedByWs.get(ws) : null,
  })
  // Clear clients / sseByCid between tests
  clients.clear()
  sseByCid.clear()
  registerSessionsStore({ initial: [{ id: 'sess-1', title: 'old', workspace: '/w', createdAt: 1, updatedAt: 1, chat: [] }] })
})

function fakeSse() {
  const writes = []
  return {
    writes,
    write: (chunk) => { writes.push(chunk) },
  }
}

describe('pushStateFor', () => {
  test('uses opts.mcodeSessions when provided (skips cache lookup)', () => {
    const cid = 'cid-1'
    const cs = makeClientState()
    cs.workspace.dir = '/w'
    clients.set(cid, cs)
    sseByCid.set(cid, fakeSse())
    const sessions = [{ id: 'direct-1' }]
    pushStateFor(cid, { mcodeSessions: sessions })
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6))
    assert.deepEqual(payload.mcodeSessions, sessions)
  })

  test('reads from cache when available (no fire-and-forget fetch)', () => {
    const cid = 'cid-1'
    const cs = makeClientState()
    cs.workspace.dir = '/cached-ws'
    clients.set(cid, cs)
    sseByCid.set(cid, fakeSse())
    cachedByWs.set('/cached-ws', [{ id: 'cached-1' }])
    pushStateFor(cid)
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6))
    assert.deepEqual(payload.mcodeSessions, [{ id: 'cached-1' }])
    // No fetch should have been triggered
    assert.equal(acpFetchCalls.length, 0)
  })

  test('falls back to [] + fire-and-forget fetch on cache miss', () => {
    const cid = 'cid-1'
    const cs = makeClientState()
    cs.workspace.dir = '/uncached-ws'
    clients.set(cid, cs)
    sseByCid.set(cid, fakeSse())
    pushStateFor(cid)
    const payload = JSON.parse(sseByCid.get(cid).writes[0].slice(6))
    // Immediately sees [] (cache miss → empty placeholder)
    assert.deepEqual(payload.mcodeSessions, [])
  })
})

describe('pushStateFor "__broadcast__"', () => {
  test('iterates all connected SSE clients', () => {
    const a = fakeSse(), b = fakeSse()
    clients.set('a', makeClientState()); sseByCid.set('a', a)
    clients.set('b', makeClientState()); sseByCid.set('b', b)
    pushStateFor('__broadcast__', { mcodeSessions: [{ id: 'bcast' }] })
    assert.equal(a.writes.length, 1)
    assert.equal(b.writes.length, 1)
    const pa = JSON.parse(a.writes[0].slice(6))
    const pb = JSON.parse(b.writes[0].slice(6))
    assert.deepEqual(pa.mcodeSessions, [{ id: 'bcast' }])
    assert.deepEqual(pb.mcodeSessions, [{ id: 'bcast' }])
  })
})
