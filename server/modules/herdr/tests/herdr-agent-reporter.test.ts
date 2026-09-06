import assert from 'node:assert/strict';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createHerdrManagedState } from '../../../../shared/herdr-managed-state.js';
import { HerdrAgentReporter, herdrAgentDisplayState, type HerdrAgentReporterTarget } from '../services/herdr-agent-reporter.js';
import { HerdrClient } from '../services/herdr-client.js';

async function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'reporter-')));
  const path = join(directory, 'herdr.sock');
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let terminal = 'term-1';
  let absent = false;
  let fail = false;
  let applyMetadata = true;
  let applyReport = true;
  let publication: Record<string, unknown> | null = null;
  const tokens: Record<string, string> = {};
  let afterSnapshot: (() => void) | undefined;
  let afterMetadata: (() => void) | undefined;
  let afterReport: (() => void) | undefined;
  const server = net.createServer(socket => {
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.split('\n')[0]!);
      calls.push(request);
      const snapshot = { version: 'test', protocol: 19, layouts: [], agents: [],
        workspaces: [{ workspace_id: 'w1', number: 1, label: '', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
        tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: '', focused: false, pane_count: 1, agent_status: 'idle' }],
        panes: absent ? [] : [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: terminal, focused: false,
          agent: publication ? 'gjc' : null, agent_status: publication?.state ?? 'idle',
          tokens: { ...tokens } }],
      };
      if (request.method === 'session.snapshot') {
        afterSnapshot?.();
        socket.end(JSON.stringify({ id: request.id, result: { type: 'session_snapshot', snapshot } }) + '\n');
      } else {
        if (request.method === 'pane.report_agent') afterReport?.();
        if (!fail && request.method === 'pane.report_metadata' && applyMetadata) {
          for (const [key, value] of Object.entries(request.params.tokens as Record<string, string | null>)) {
            if (value === null) delete tokens[key];
            else tokens[key] = value;
          }
        }
        if (request.method === 'pane.report_metadata') afterMetadata?.();
        if (!fail && applyReport && request.method === 'pane.report_agent') publication = request.params;
        if (!fail && request.method === 'pane.release_agent') publication = null;
        socket.end(JSON.stringify(fail ? { id: request.id, error: { code: 'unavailable', message: 'private failure' } } :
          { id: request.id, result: { type: 'ok' } }) + '\n');
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  chmodSync(path, 0o600);
  const stat = lstatSync(path);
  const target: HerdrAgentReporterTarget = {
    record: { appSessionId: 'app-id', ownerGeneration: 'generation', selectedSessionName: 'selected',
      endpoint: { name: 'selected', canonicalPath: path, dev: stat.dev, inode: stat.ino }, phase: 'ready', workspaceId: 'w1',
      placement: { sessionName: 'selected', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' },
      providerSessionId: 'sdk-id', privateDirectory: directory, claimNonce: 'private', updatedAt: 'now' },
    binding: { appSessionId: 'app-id', ownerGeneration: 'generation', providerSessionId: 'sdk-id', herdrInstanceId: 'selected',
      workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1', lifecycle: 'ready', lastSeq: 0, updatedAt: 'now' },
  };
  const state = createHerdrManagedState({ appSessionId: 'app-id', ownerGeneration: 'generation' });
  state.providerSessionId = 'sdk-id'; state.lifecycle = 'ready';
  const reporter = new HerdrAgentReporter({ appSessionId: 'app-id', ownerGeneration: 'generation', providerSessionId: 'sdk-id',
    readTarget: () => target, readState: () => state, createClient: endpoint => new HerdrClient(endpoint, undefined, 100) });
  return { target, state, reporter, calls, path,
    setFail: (value: boolean) => { fail = value; },
    setApplyMetadata: (value: boolean) => { applyMetadata = value; },
    setApplyReport: (value: boolean) => { applyReport = value; },
    setTokens: (value: Record<string, string>) => {
      for (const key of Object.keys(tokens)) delete tokens[key];
      Object.assign(tokens, value);
    },
    readTokens: () => ({ ...tokens }),
    replace: () => { terminal = 'term-2'; },
    remove: () => { absent = true; },
    onSnapshot: (callback: () => void) => { afterSnapshot = callback; },
    onMetadata: (callback: () => void) => { afterMetadata = callback; },
    onReport: (callback: () => void) => { afterReport = callback; },
    async close() { await reporter.quiesce(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Reporter did not reach expected state');
}

test('publishes native identity, coalesces token updates, transitions, and releases only closed owner source', async () => {
  const f = await fixture();
  try {
    f.reporter.start();
    await until(() => f.reporter.status().status === 'published');
    f.state.activeTurnId = 'turn';
    for (let i = 0; i < 100; i++) { f.state.watermark++; f.reporter.update(f.state); }
    await until(() => f.calls.filter(c => c.method === 'pane.report_agent').length === 2 && f.reporter.status().seq === 3);
    await until(() => f.reporter.status().status === 'published');
    f.state.lifecycle = 'awaiting_input'; f.reporter.update(f.state);
    await until(() => f.calls.filter(c => c.method === 'pane.report_agent').length === 3);
    await f.reporter.quiesce();
    const reports = f.calls.filter(c => c.method === 'pane.report_agent');
    assert.deepEqual(reports.map(c => c.params.state), ['idle', 'working', 'blocked']);
    assert.deepEqual(Object.keys(reports[0]!.params).sort(), ['agent', 'pane_id', 'seq', 'source', 'state']);
    assert.equal('providerSessionId' in reports[0]!.params, false);
    const metadata = f.calls.find(c => c.method === 'pane.report_metadata')!;
    assert.equal(f.calls.filter(c => c.method === 'pane.report_metadata').length, 1);
    assert.deepEqual(metadata.params.tokens, {
      gajae_native_session_id: 'sdk-id',
      gajae_owner_generation: 'generation',
      gajae_app_session_id: 'app-id',
    });
    await f.reporter.release(); assert.equal(f.reporter.status().status, 'not_closed');
    f.target.binding!.lifecycle = 'closed';
    await f.reporter.release();
    const release = f.calls.find(c => c.method === 'pane.release_agent')!;
    assert.equal(release.params.source, reports[0]!.params.source);
    assert.equal(release.params.seq, 6);
    const clear = f.calls.find(c => c.method === 'pane.report_metadata' && (c.params.tokens as Record<string, unknown>).gajae_native_session_id === null)!;
    assert.deepEqual(clear.params.tokens, {
      gajae_native_session_id: null,
      gajae_owner_generation: null,
      gajae_app_session_id: null,
    });
    assert.deepEqual(f.calls.filter(c => c.params.seq !== undefined).map(c => c.params.seq), [1, 2, 3, 4, 5, 6]);
    assert.equal(f.reporter.status().status, 'released');
  } finally { await f.close(); }
});

test('an RPC acknowledgement without matching native snapshot metadata stays unconfirmed', async () => {
  const f = await fixture();
  try {
    f.setApplyMetadata(false);
    f.reporter.start();
    await until(() => f.reporter.status().status === 'unavailable');
    for (let index = 0; index < 20; index++) f.reporter.update(f.state);
    await f.reporter.quiesce();
    assert.equal(f.calls.filter(call => call.method === 'pane.report_metadata').length, 1);
    assert.equal(f.calls.filter(call => call.method === 'pane.report_agent').length, 0);
  } finally { await f.close(); }
});

test('closure cleans matching metadata after an unconfirmed status report without touching foreign keys', async () => {
  const f = await fixture();
  try {
    f.setTokens({ foreign_key: 'preserve' });
    f.setApplyReport(false);
    f.reporter.start();
    await until(() => f.reporter.status().status === 'unavailable');
    assert.equal(f.readTokens().gajae_native_session_id, 'sdk-id');
    f.target.binding!.lifecycle = 'closed';
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'released');
    assert.deepEqual(f.readTokens(), { foreign_key: 'preserve' });
    assert.equal(f.calls.filter(call => call.method === 'pane.release_agent').length, 1);
    const mutations = f.calls.filter(call => call.params.seq !== undefined);
    assert.deepEqual(mutations.map(call => call.params.seq), [1, 2, 3, 4]);
  } finally { await f.close(); }
});

test('unconfirmed null removal is not retried or reported released', async () => {
  const f = await fixture();
  try {
    f.reporter.start();
    await until(() => f.reporter.status().status === 'published');
    f.target.binding!.lifecycle = 'closed';
    f.setApplyMetadata(false);
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'unavailable');
    const mutationCount = f.calls.filter(call => call.params.seq !== undefined).length;
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'unavailable');
    assert.equal(f.calls.filter(call => call.params.seq !== undefined).length, mutationCount);
    assert.equal(f.calls.some(call => call.method === 'pane.release_agent'), false);
    assert.equal(f.readTokens().gajae_owner_generation, 'generation');
  } finally { await f.close(); }
});

test('placement polling sends nothing until ready projection without any App client', async () => {
  const f = await fixture();
  try {
    const record = f.target.record;
    f.target.record = null; f.reporter.start();
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(f.calls.length, 0);
    f.target.record = { ...record!, phase: 'layout_created' };
    await new Promise(resolve => setTimeout(resolve, 280));
    assert.equal(f.calls.length, 0);
    f.target.record = record;
    await until(() => f.reporter.status().status === 'published');
  } finally { await f.close(); }
});

test('foreign namespaced metadata refuses before publication', async () => {
  const f = await fixture();
  try {
    f.setTokens({
      gajae_native_session_id: 'other-native',
      gajae_owner_generation: 'other-generation',
      gajae_app_session_id: 'other-app',
      foreign_key: 'preserve',
    });
    f.reporter.start();
    await until(() => f.reporter.status().status === 'stale');
    assert.equal(f.calls.filter(call => call.method === 'pane.report_metadata').length, 0);
    assert.equal(f.calls.filter(call => call.method === 'pane.report_agent').length, 0);
  } finally { await f.close(); }
});

test('partial owned metadata refuses without clearing or adopting a namespace', async () => {
  const f = await fixture();
  try {
    f.setTokens({ gajae_native_session_id: 'sdk-id', foreign_key: 'preserve' });
    f.reporter.start();
    await until(() => f.reporter.status().status === 'stale');
    assert.equal(f.calls.filter(call => call.method === 'pane.report_metadata').length, 0);
    assert.equal(f.calls.filter(call => call.method === 'pane.report_agent').length, 0);
  } finally { await f.close(); }
});

test('failed display state is not retried by token updates; new display state may attempt', async () => {
  const f = await fixture();
  try {
    f.reporter.start();
    await until(() => f.reporter.status().status === 'published');
    f.setFail(true); f.state.activeTurnId = 'turn'; f.reporter.update(f.state);
    await until(() => f.reporter.status().status === 'unavailable');
    for (let i = 0; i < 30; i++) f.reporter.update(f.state);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.filter(c => c.method === 'pane.report_agent').length, 2);
    f.setFail(false); f.state.lifecycle = 'awaiting_input'; f.reporter.update(f.state);
    await until(() => f.reporter.status().status === 'published');
    assert.equal(f.reporter.status().seq, 4);
  } finally { await f.close(); }
});

test('late namespace replacement prevents cleanup and preserves foreign keys', async () => {
  const f = await fixture();
  try {
    f.reporter.start();
    await until(() => f.reporter.status().status === 'published');
    await f.reporter.quiesce();
    f.target.binding!.lifecycle = 'closed';
    f.setTokens({
      gajae_native_session_id: 'replacement-native',
      gajae_owner_generation: 'replacement-generation',
      gajae_app_session_id: 'replacement-app',
      foreign_key: 'preserve',
    });
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'stale');
    assert.equal(f.calls.filter(call => call.method === 'pane.report_metadata' &&
      (call.params.tokens as Record<string, unknown>).gajae_native_session_id === null).length, 0);
    assert.equal(f.calls.filter(call => call.method === 'pane.release_agent').length, 0);
    assert.deepEqual(f.calls.length > 0 ? f.calls.at(-1)?.method : undefined, 'session.snapshot');
    assert.deepEqual(f.readTokens(), {
      gajae_native_session_id: 'replacement-native',
      gajae_owner_generation: 'replacement-generation',
      gajae_app_session_id: 'replacement-app',
      foreign_key: 'preserve',
    });
  } finally { await f.close(); }
});

test('absent owned namespace skips null clear and releases this source', async () => {
  const f = await fixture();
  try {
    f.reporter.start();
    await until(() => f.reporter.status().status === 'published');
    await f.reporter.quiesce();
    f.target.binding!.lifecycle = 'closed';
    f.setTokens({ foreign_key: 'preserve' });
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'released');
    const metadata = f.calls.filter(call => call.method === 'pane.report_metadata');
    assert.equal(metadata.length, 1);
    const mutations = f.calls.filter(call => call.method !== 'session.snapshot');
    assert.equal(mutations.at(-1)?.method, 'pane.release_agent');
    assert.deepEqual(mutations.at(-1)?.params.tokens, undefined);
  } finally { await f.close(); }
});

test('endpoint changes between snapshot and dispatch prevent report writes', async () => {
  const f = await fixture();
  try {
    f.onSnapshot(() => chmodSync(f.path, 0o666));
    f.reporter.start();
    await until(() => f.reporter.status().status === 'stale');
    assert.equal(f.calls.filter(c => c.method === 'pane.report_agent').length, 0);
  } finally { await f.close(); }
});

test('post-reply terminal replacement is stale, not published or released', async () => {
  const f = await fixture();
  try {
    f.onReport(f.replace); f.reporter.start();
    await until(() => f.reporter.status().status === 'stale');
    f.target.binding!.lifecycle = 'closed'; await f.reporter.release();
    assert.equal(f.calls.filter(c => c.method === 'pane.release_agent').length, 0);
  } finally { await f.close(); }
});

test('removed pane does not release foreign metadata', async () => {
  const f = await fixture();
  try {
    f.reporter.start(); await until(() => f.reporter.status().status === 'published');
    await f.reporter.quiesce(); f.remove(); f.target.binding!.lifecycle = 'closed';
    await f.reporter.release();
    assert.equal(f.reporter.status().status, 'not_present');
    assert.equal(f.calls.filter(c => c.method === 'pane.release_agent').length, 0);
  } finally { await f.close(); }
});

test('in-flight updates retain only newest desired state', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.onReport(() => {
      if (changed) return;
      changed = true;
      f.state.activeTurnId = 'turn'; f.reporter.update(f.state);
      f.state.lifecycle = 'awaiting_input'; f.reporter.update(f.state);
    });
    f.reporter.start();
    await until(() => f.calls.filter(c => c.method === 'pane.report_agent').length === 2);
    await f.reporter.quiesce();
    assert.deepEqual(f.calls.filter(c => c.method === 'pane.report_agent').map(c => c.params.state), ['idle', 'blocked']);
  } finally { await f.close(); }
});

test('durable endpoint replacement stops permanently without adopting new selection', async () => {
  const f = await fixture();
  try {
    f.reporter.start(); await until(() => f.reporter.status().status === 'published');
    f.target.record = { ...f.target.record!, endpoint: { ...f.target.record!.endpoint, inode: 0 } };
    f.state.activeTurnId = 'turn'; f.reporter.update(f.state);
    await until(() => f.reporter.status().status === 'stale');
    assert.equal(f.calls.filter(c => c.method === 'pane.report_agent').length, 1);
  } finally { await f.close(); }
});

test('settled requests are not blocked; uncertain lifecycle is unknown', () => {
  const state = createHerdrManagedState({ appSessionId: 'app', ownerGeneration: 'generation' });
  state.lifecycle = 'ready'; state.providerSessionId = 'sdk';
  state.requests.r = { requestId: 'r', generation: 'generation', appSessionId: 'app', providerSessionId: 'sdk', turnId: 'turn', kind: 'permission', policyRevision: 0, scope: { status: 'settled' }, schema: {}, createdAt: 'now' };
  assert.equal(herdrAgentDisplayState(state), 'idle');
  state.requests.r.scope.status = 'pending'; assert.equal(herdrAgentDisplayState(state), 'blocked');
  state.lifecycle = 'interrupted'; assert.equal(herdrAgentDisplayState(state), 'unknown');
});
