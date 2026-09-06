import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';

import { HerdrClient, HERDR_MAX_OUTPUT_BYTES, HerdrError, HerdrRpcError, type HerdrReportAgentInput, type HerdrReleaseAgentInput, type HerdrReportMetadataInput } from '../modules/herdr/index.js';

class FakeSocket extends Duplex {
  writes: string[] = [];
  constructor(private readonly onWriteLine: (line: string, socket: FakeSocket) => void) { super(); }
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(chunk.toString('utf8'));
    this.onWriteLine(chunk.toString('utf8').trim(), this);
    callback();
  }
  reply(value: unknown) { this.push(`${JSON.stringify(value)}\n`); }
}

describe('HerdrClient', () => {
  const agentReport: HerdrReportAgentInput = {
    paneId: 'w1:p1', source: 'gjc:owner-generation', state: 'idle', seq: 0,
  };

  it('reports only agent status and releases only the exact owner metadata', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      calls.push({ method: request.method, params: request.params });
      socket.reply({ id: request.id, result: { type: 'ok' } });
    }));
    for (const [seq, state] of (['idle', 'blocked', 'working', 'unknown'] as const).entries()) {
      await client.reportAgent({ ...agentReport, seq, state });
      assert.deepEqual(calls[seq], { method: 'pane.report_agent', params: {
        pane_id: 'w1:p1', source: 'gjc:owner-generation', agent: 'gjc', state, seq,
      } });
    }
    await client.releaseAgent({ paneId: agentReport.paneId, source: agentReport.source, seq: 4 });
    assert.deepEqual(calls[4], { method: 'pane.release_agent', params: {
      pane_id: 'w1:p1', source: 'gjc:owner-generation', agent: 'gjc', seq: 4,
    } });
    assert.equal(calls.length, 5);
    assert.doesNotMatch(JSON.stringify(calls), /path|prompt|token|session/);
  });

  it('reports native identity through pane metadata with a strict acknowledgement', async () => {
    const calls: { method: string; params: unknown }[] = [];
    const metadata: HerdrReportMetadataInput = {
      paneId: 'w1:p1',
      source: 'gajae-owner:generation',
      seq: 3,
      tokens: {
        gajae_native_session_id: 'native-session-123',
        gajae_owner_generation: 'owner-generation',
        gajae_app_session_id: 'app-session',
      },
    };
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      calls.push({ method: request.method, params: request.params });
      socket.reply({ id: request.id, result: { type: 'ok' } });
    }));

    await client.reportMetadata(metadata);
    assert.deepEqual(calls, [{ method: 'pane.report_metadata', params: {
      pane_id: 'w1:p1',
      source: 'gajae-owner:generation',
      tokens: metadata.tokens,
      seq: 3,
    } }]);
  });

  it('accepts an all-null metadata removal without claiming reporter ownership', async () => {
    let writes = 0;
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      writes++;
      const request = JSON.parse(line);
      socket.reply({ id: request.id, result: { type: 'ok' } });
    }));

    await client.reportMetadata({
      paneId: 'w1:p1',
      source: 'gajae-owner:generation',
      seq: 4,
      tokens: {
        gajae_native_session_id: null,
        gajae_owner_generation: null,
        gajae_app_session_id: null,
      },
    });
    assert.equal(writes, 1);
  });

  it('rejects invalid metadata and extra identity or private fields before connecting', async () => {
    let connects = 0;
    const client = new HerdrClient('/unused', () => { connects++; throw new Error('must not connect'); });
    for (const patch of [
      { seq: -1 }, { seq: 0.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: NaN }, { seq: Infinity },
      { source: '' }, { source: 'owner\n' }, { source: 'owner\0' }, { source: 'owner name' },
      { source: '한' }, { source: 'x'.repeat(129) }, { paneId: '' },
    ]) {
      await assert.rejects(client.reportAgent({ ...agentReport, ...patch }), { code: 'HERDR_INVALID_REQUEST' });
      await assert.rejects(client.releaseAgent({ paneId: 'w1:p1', source: 'gjc:owner', seq: 0, ...patch }), { code: 'HERDR_INVALID_REQUEST' });
    }
    for (const patch of [
      { state: 'done' }, { providerSessionId: undefined }, { providerSessionId: '' },
      { providerSessionId: 'native\nid' }, { providerSessionId: 'native id' }, { providerSessionId: 'x'.repeat(257) },
      { agent: 'pi' }, { agent_session_id: 'other' }, { agent_session_path: '/private/session' },
      { prompt: 'private' }, { token: 'private' },
    ]) {
      await assert.rejects(client.reportAgent({ ...agentReport, ...patch } as HerdrReportAgentInput), { code: 'HERDR_INVALID_REQUEST' });
    }
    await assert.rejects(client.releaseAgent({ paneId: 'w1:p1', source: 'gjc:owner', seq: 0, providerSessionId: 'native' } as HerdrReleaseAgentInput), { code: 'HERDR_INVALID_REQUEST' });
    assert.equal(connects, 0);
  });

  it('rejects malformed metadata identity reports before connecting', async () => {
    let connects = 0;
    const client = new HerdrClient('/unused', () => { connects++; throw new Error('must not connect'); });
    const base: HerdrReportMetadataInput = {
      paneId: 'w1:p1',
      source: 'gajae-owner:generation',
      seq: 0,
      tokens: {
        gajae_native_session_id: 'native',
        gajae_owner_generation: 'generation',
        gajae_app_session_id: 'app',
      },
    };
    for (const patch of [
      { seq: -1 }, { seq: 0.5 }, { seq: Number.MAX_SAFE_INTEGER + 1 }, { seq: NaN }, { seq: Infinity },
      { source: '' }, { source: 'owner\n' }, { source: 'owner\0' }, { source: 'owner name' },
      { source: '한' }, { source: 'x'.repeat(81) }, { paneId: '' },
      { tokens: {} },
      { tokens: { unknown: 'value' } },
      { tokens: { gajae_native_session_id: 'native', gajae_owner_generation: 'generation', gajae_app_session_id: 'app', extra: 'value' } },
      { tokens: { ['gajae_native_session_id'.repeat(2)]: 'native' } },
      { tokens: { gajae_native_session_id: 123, gajae_owner_generation: 'generation' } },
      { tokens: { gajae_native_session_id: 'n'.repeat(81), gajae_owner_generation: 'generation' } },
      { tokens: { gajae_native_session_id: ' native ', gajae_owner_generation: 'generation' } },
      { tokens: { gajae_native_session_id: 'native', gajae_owner_generation: null } },
      { tokens: { gajae_native_session_id: null, gajae_owner_generation: null, gajae_app_session_id: 'app' } },
      { tokens: { gajae_native_session_id: 'native', gajae_owner_generation: 'generation', gajae_app_session_id: null } },
      { tokens: { gajae_app_session_id: 'app' } },
      { agent_session_path: '/private/session' },
      { token: 'private' },
    ]) {
      await assert.rejects(client.reportMetadata({ ...base, ...patch } as HerdrReportMetadataInput), { code: 'HERDR_INVALID_REQUEST' });
    }
    assert.equal(connects, 0);
  });

  it('never treats malformed, non-ok, or RPC error metadata replies as success', async () => {
    for (const response of [
      { result: null }, { result: {} }, { result: { type: 'accepted' } },
      { result: { type: 'ok', extra: true } }, { result: { type: 'ok', error: 'failed' } },
      { error: { code: 'invalid_request', message: 'rejected' } },
    ]) {
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
        socket.reply({ id: JSON.parse(line).id, ...response });
      }));
      const code = 'error' in response ? 'HERDR_RPC_ERROR' : 'HERDR_INVALID_RESPONSE';
      await assert.rejects(client.reportAgent(agentReport), { code });
      await assert.rejects(client.releaseAgent({ paneId: 'w1:p1', source: 'gjc:owner', seq: 1 }), { code });
    }
  });

  it('checks metadata ownership after admission and refuses dispatch when ownership changes', async () => {
    for (const report of [true, false]) {
      const events: string[] = [];
      const socket = new FakeSocket(() => { events.push('write'); });
      const client = new HerdrClient('/unused', () => socket);
      let owned = true;
      const guard = {
        admit: async () => { events.push('admit'); await Promise.resolve(); owned = false; },
        check: () => {
          events.push('check');
          if (!owned) throw new HerdrError('HERDR_CANCELLED', 499, 'Ownership changed.');
        },
      };
      await assert.rejects(report
        ? client.reportAgent(agentReport, undefined, guard)
        : client.releaseAgent({ paneId: 'w1:p1', source: 'gjc:owner', seq: 1 }, undefined, guard),
      { code: 'HERDR_CANCELLED' });
      assert.deepEqual(events, ['admit', 'check']);
      assert.equal(socket.writes.length, 0);
      assert.equal(socket.destroyed, true);
    }
  });

  it('decodes Herdr agent_session ID records and never exposes path records', async () => {
    const idRecord = { source: 'gajae-owner:generation', agent: 'gjc', kind: 'id', value: 'native-id' };
    const pathRecord = { source: 'foreign', agent: 'pi', kind: 'path', value: '/private/session' };
    for (const record of [idRecord, pathRecord, null, undefined, 123, {}, { ...idRecord, value: 123 }]) {
      const snapshot = managedSnapshot();
      const pane = { ...snapshot.panes[0], agent_session: record };
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
        socket.reply({ id: JSON.parse(line).id, result: { type: 'session_snapshot', snapshot: { ...snapshot, panes: [pane] } } });
      }));
      if (record === idRecord || record === pathRecord || record == null) {
        const decoded = await client.snapshot();
        assert.deepEqual(decoded.panes[0]?.agent_session, record === idRecord ? idRecord : undefined);
        assert.equal('agent_session_path' in decoded.panes[0]!, false);
        assert.equal(JSON.stringify(decoded).includes('/private/session'), false);
      } else await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
    }
  });

  it('decodes pane metadata tokens without requiring an agent_session and retains foreign keys', async () => {
    const snapshot = managedSnapshot();
    const tokens = {
      ...Object.fromEntries(Array.from({ length: 28 }, (_, index) => [`foreign_${index}`, 'untouched'])),
      gajae_native_session_id: 'native-session-123',
      gajae_owner_generation: 'owner-generation',
      gajae_app_session_id: 'app-session',
      foreign_agent_token: 'preserved',
    };
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      socket.reply({ id: request.id, result: {
        type: 'session_snapshot',
        snapshot: { ...snapshot, panes: [{ ...snapshot.panes[0], tokens }] },
      } });
    }));

    const decoded = await client.snapshot();
    assert.deepEqual(decoded.panes[0]?.tokens, tokens);
    assert.equal('agent_session' in decoded.panes[0]!, false);
  });

  it('rejects malformed pane metadata token snapshots', async () => {
    for (const tokens of [
      null,
      { gajae_native_session_id: null },
      { gajae_native_session_id: 'native', gajae_owner_generation: 123 },
      { ['invalid key']: 'value' },
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`key_${index}`, 'value'])),
    ]) {
      const snapshot = managedSnapshot();
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({
        id: JSON.parse(line).id,
        result: { type: 'session_snapshot', snapshot: { ...snapshot, panes: [{ ...snapshot.panes[0], tokens }] } },
      })));
      await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
    }
  });

  const managedSnapshot = () => ({
    version: 'test', protocol: 19, layouts: [], agents: [],
    workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
    tabs: [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: false, pane_count: 1, agent_status: 'idle' }],
    panes: [{ pane_id: 'w1:p1', terminal_id: 'term1', workspace_id: 'w1', tab_id: 'w1:t1', focused: false, agent_status: 'idle' }],
  });

  it('creates only unfocused workspaces and validates frozen mapped receipts', async () => {
    const snap = managedSnapshot();
    const result = { type: 'workspace_created', workspace: snap.workspaces[0], tab: snap.tabs[0], root_pane: snap.panes[0] };
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      assert.equal(request.method, 'workspace.create');
      assert.deepEqual(request.params, { cwd: '/repo', label: 'Owned', env: {}, focus: false });
      socket.reply({ id: request.id, result });
    }));
    const receipt = await client.createWorkspace('/repo', 'Owned');
    assert.deepEqual(receipt, { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term1' });
    assert.ok(Object.isFrozen(receipt));
    for (const bad of [{ ...result, type: 'ok' }, { ...result, root_pane: {} }, { ...result, tab: { ...result.tab, workspace_id: 'foreign' } }]) {
      const malformed = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, result: bad })));
      await assert.rejects(malformed.createWorkspace('/repo', 'Owned'), { code: 'HERDR_INVALID_RESPONSE' });
    }
  });

  it('appends layout without tab_id, preserves argv, and resolves exact terminal mapping', async () => {
    const argv = ['/path with spaces/bun', 'host.ts', '--value', 'quotes " $ ; 한'];
    const methods: string[] = [];
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      methods.push(request.method);
      if (request.method === 'layout.apply') {
        assert.deepEqual(request.params, { workspace_id: 'w1', focus: false, root: { type: 'pane', command: argv, cwd: '/repo', env: {} } });
        assert.equal('tab_id' in request.params, false);
        socket.reply({ id: request.id, result: { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } } } });
      } else socket.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: managedSnapshot() } });
    }));
    const receipt = await client.applyLayout('w1', argv, '/repo');
    assert.equal(receipt.terminalId, 'term1');
    assert.ok(Object.isFrozen(receipt));
    assert.deepEqual(methods, ['session.snapshot', 'layout.apply', 'session.snapshot']);
  });

  it('appending into an already-focused owned workspace keeps the receipt valid', async () => {
    // The user may have focused the owned workspace; focus:false leaves that
    // focus exactly where it was and the new tab/pane stay unfocused.
    const focusedSnapshot = () => ({
      ...managedSnapshot(),
      workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: true, pane_count: 2, tab_count: 2, active_tab_id: 'w1:t1', agent_status: 'idle' }],
      tabs: [
        { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'idle' },
        { tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: '2', focused: false, pane_count: 1, agent_status: 'idle' },
      ],
      panes: [
        { pane_id: 'w1:p1', terminal_id: 'term1', workspace_id: 'w1', tab_id: 'w1:t1', focused: true, agent_status: 'idle' },
        { pane_id: 'w1:p2', terminal_id: 'term2', workspace_id: 'w1', tab_id: 'w1:t2', focused: false, agent_status: 'idle' },
      ],
    });
    const methods: string[] = [];
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      methods.push(request.method);
      socket.reply({ id: request.id, result: request.method === 'layout.apply'
        ? { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t2', zoomed: false, focused_pane_id: 'w1:p2', root: { type: 'pane', pane_id: 'w1:p2' } } }
        : { type: 'session_snapshot', snapshot: focusedSnapshot() } });
    }));
    assert.deepEqual(await client.applyLayout('w1', ['bun'], '/repo'), { workspaceId: 'w1', tabId: 'w1:t2', paneId: 'w1:p2', terminalId: 'term2' });
    assert.deepEqual(methods, ['session.snapshot', 'layout.apply', 'session.snapshot']);
  });

  it('a layout that moves focus is rejected', async () => {
    let snapshots = 0;
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      if (request.method === 'layout.apply') {
        socket.reply({ id: request.id, result: { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t2', zoomed: false, focused_pane_id: 'w1:p2', root: { type: 'pane', pane_id: 'w1:p2' } } } });
        return;
      }
      const moved = snapshots++ > 0;
      socket.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: {
        ...managedSnapshot(),
        workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: true, pane_count: 2, tab_count: 2, active_tab_id: moved ? 'w1:t2' : 'w1:t1', agent_status: 'idle' }],
        tabs: [
          { tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: !moved, pane_count: 1, agent_status: 'idle' },
          { tab_id: 'w1:t2', workspace_id: 'w1', number: 2, label: '2', focused: false, pane_count: 1, agent_status: 'idle' },
        ],
        panes: [
          { pane_id: 'w1:p1', terminal_id: 'term1', workspace_id: 'w1', tab_id: 'w1:t1', focused: !moved, agent_status: 'idle' },
          { pane_id: 'w1:p2', terminal_id: 'term2', workspace_id: 'w1', tab_id: 'w1:t2', focused: false, agent_status: 'idle' },
        ],
      } } });
    }));
    await assert.rejects(client.applyLayout('w1', ['bun'], '/repo'), /changed focus/);
  });

  it('a Herdr rejection is a known non-dispatch only when a fresh snapshot proves no pane appeared', async () => {
    const run = async (afterPanes: Array<{ pane_id: string; tab_id: string }>, workspacePresent = true) => {
      let snapshots = 0;
      const methods: string[] = [];
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
        const request = JSON.parse(line);
        methods.push(request.method);
        if (request.method === 'layout.apply') { socket.reply({ id: request.id, error: { code: 'workspace_not_found', message: 'no such workspace' } }); return; }
        const after = snapshots++ > 0;
        const panes = (after ? afterPanes : [{ pane_id: 'w1:p1', tab_id: 'w1:t1' }]).map((pane) => ({ ...pane, terminal_id: 'term-' + pane.pane_id, workspace_id: 'w1', focused: false, agent_status: 'idle' }));
        socket.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: {
          ...managedSnapshot(),
          workspaces: after && !workspacePresent ? [] : [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: panes.length, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
          tabs: after && !workspacePresent ? [] : [{ tab_id: 'w1:t1', workspace_id: 'w1', number: 1, label: '1', focused: false, pane_count: panes.length, agent_status: 'idle' }],
          panes: after && !workspacePresent ? [] : panes,
        } } });
      }));
      const outcome = await client.applyLayout('w1', ['bun'], '/repo').then(() => 'resolved', (error: HerdrError) => error.code);
      return { outcome, methods };
    };
    assert.deepEqual(await run([{ pane_id: 'w1:p1', tab_id: 'w1:t1' }]), { outcome: 'HERDR_LAYOUT_NOT_DISPATCHED', methods: ['session.snapshot', 'layout.apply', 'session.snapshot'] });
    assert.equal((await run([], false)).outcome, 'HERDR_LAYOUT_NOT_DISPATCHED', 'a vanished workspace cannot hold a new pane');
    assert.equal((await run([{ pane_id: 'w1:p1', tab_id: 'w1:t1' }, { pane_id: 'w1:p2', tab_id: 'w1:t2' }])).outcome, 'HERDR_RPC_ERROR', 'a new pane after a rejection stays unknown');
  });

  it('inspects a registered owned workspace by exact id and label', async () => {
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      socket.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: { ...managedSnapshot(), workspaces: [
        { workspace_id: 'w1', number: 1, label: 'Gajae install', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' },
        { workspace_id: 'w2', number: 2, label: 'Someone else', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 'w2:t1', agent_status: 'idle' },
      ], tabs: [], panes: [] } } });
    }));
    assert.equal(await client.inspectWorkspace('w1', 'Gajae install'), 'present');
    assert.equal(await client.inspectWorkspace('w2', 'Gajae install'), 'foreign');
    assert.equal(await client.inspectWorkspace('w3', 'Gajae install'), 'absent');
  });

  it('rejects malformed layout receipts without retries or snapshot guesses', async () => {
    for (const layout of [
      { workspace_id: 'foreign', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } },
      { workspace_id: 'w1', tab_id: 'foreign:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } },
      { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane' } },
    ]) {
      let writes = 0;
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
        const request = JSON.parse(line);
        writes++;
        socket.reply({ id: request.id, result: request.method === 'layout.apply'
          ? { type: 'layout_apply', layout }
          : { type: 'session_snapshot', snapshot: managedSnapshot() } });
      }));
      await assert.rejects(client.applyLayout('w1', ['bun'], '/repo'), { code: 'HERDR_INVALID_RESPONSE' });
      // The pre-append focus snapshot plus the rejected receipt; no follow-up snapshot, no retry.
      assert.equal(writes, 2);
    }
  });

  it('keeps layout outcome unknown when the follow-up snapshot maps the pane elsewhere', async () => {
    let writes = 0;
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => {
      const request = JSON.parse(line);
      writes++;
      const snap = managedSnapshot();
      snap.panes[0]!.tab_id = 'w1:foreign';
      socket.reply({ id: request.id, result: request.method === 'layout.apply'
        ? { type: 'layout_apply', layout: { workspace_id: 'w1', tab_id: 'w1:t1', zoomed: false, focused_pane_id: 'w1:p1', root: { type: 'pane', pane_id: 'w1:p1' } } }
        : { type: 'session_snapshot', snapshot: snap } });
    }));
    await assert.rejects(client.applyLayout('w1', ['bun'], '/repo'), { code: 'HERDR_INVALID_RESPONSE' });
    assert.equal(writes, 3);
  });

  it('uses one string-id JSON RPC and decodes session snapshots', async () => {
    let socket!: FakeSocket;
    const client = new HerdrClient('/tmp/herdr.sock', () => {
      socket = new FakeSocket((line, current) => {
        const request = JSON.parse(line);
        assert.equal(request.method, 'session.snapshot');
        assert.equal(typeof request.id, 'string');
        current.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: {
          version: 'test', protocol: 1, layouts: [], agents: [],
          workspaces: [{ workspace_id: 'w1', number: 1, label: 'Main', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'idle' }],
          panes: [{ pane_id: 'p1', terminal_id: 'term1', workspace_id: 'w1', tab_id: 't1', focused: true, cwd: '/repo', agent: 'gjc', agent_status: 'idle' }],
        } } });
      });
      return socket;
    });

    const snapshot = await client.snapshot();
    assert.equal(snapshot.panes[0]?.pane_id, 'p1');
    assert.equal(snapshot.panes[0]?.terminal_id, 'term1');
    assert.match(socket.writes[0]!, /"method":"session.snapshot"/);
  });

  it('reads visible plain text, never recent scrollback', async () => {
    const client = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      assert.equal(request.method, 'pane.read');
      assert.deepEqual(request.params, { pane_id: 'p1', source: 'visible', lines: 400, format: 'text' });
      current.reply({ id: request.id, result: { type: 'pane_read', read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', text: '<script>nope</script>', truncated: false, revision: 0 } } });
    }));

    const read = await client.readPane('p1', 400);
    assert.equal(read.text, '<script>nope</script>');
    assert.equal(read.truncated, false);
  });

  it('sends explicit input with only pane_id, text and keys', async () => {
    const calls: unknown[] = [];
    const client = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      calls.push(request);
      current.reply({ id: request.id, result: { type: 'ok' } });
    }));

    await client.sendInput('p1', 'hello', ['Enter']);
    assert.deepEqual((calls[0] as any).params, { pane_id: 'p1', text: 'hello', keys: ['Enter'] });
  });

  it('rejects Herdr error frames and mismatched ids', async () => {
    const errorClient = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      current.reply({ id: request.id, error: { code: 'invalid_request', message: 'bad' } });
    }));
    await assert.rejects(errorClient.snapshot(), (error: unknown) => error instanceof HerdrRpcError && error.rpcCode === 'invalid_request' && error.rpcMessage === 'bad' && error.status === 502);

    const mismatchClient = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((_line, current) => {
      current.reply({ id: 'other', result: { snapshot: { workspaces: [], tabs: [], panes: [] } } });
    }));
    await assert.rejects(mismatchClient.snapshot(), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
  });

  it('rejects malformed matching-id acknowledgements and untagged method results', async () => {
    for (const result of [null, {}, { type: 'pane_read' }, { type: 'ok', snapshot: {} }]) {
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, result })));
      if (result && 'type' in result && result.type === 'ok') {
        await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
      } else {
        await assert.rejects(client.sendInput('p1', 'hello', []), { code: 'HERDR_INVALID_RESPONSE' });
      }
    }
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, result: { snapshot: { workspaces: [], tabs: [], panes: [] } } })));
    await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
  });

  it('caps multibyte output at a complete UTF-8 boundary', async () => {
    const text = '한😀'.repeat(80_000);
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({
      id: JSON.parse(line).id,
      result: { type: 'pane_read', read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', revision: 1, truncated: false, text } },
    })));
    const read = await client.readPane('p1', 400);
    assert.ok(Buffer.byteLength(read.text) <= HERDR_MAX_OUTPUT_BYTES);
    assert.ok(text.endsWith(read.text));
    assert.ok(!read.text.includes('�'));
    assert.equal(read.truncated, true);
  });

  it('rejects missing required wire fields and malformed error frames as upstream failures', async () => {
    const malformed = [
      { result: { type: 'session_snapshot', snapshot: { workspaces: [], tabs: [], panes: [] } } },
      { result: { type: 'pane_read', read: { pane_id: 'p1', text: 'looks valid', truncated: false } } },
      { error: { code: 'pane_not_found' } },
      { error: { code: 'pane_not_found', message: 'secret' }, result: { type: 'ok' } },
    ];
    for (const response of malformed) {
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, ...response })));
      await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
    }
    const readClient = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, ...malformed[1] })));
    await assert.rejects(readClient.readPane('p1', 400), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
  });

  it('checks cancellation both before connecting and immediately before writing', async () => {
    const controller = new AbortController();
    controller.abort();
    let connects = 0;
    const client = new HerdrClient('/unused', () => { connects++; throw new Error('must not connect'); });
    await assert.rejects(client.snapshot(controller.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(connects, 0);
    const duringConnect = new AbortController();
    const socket = new FakeSocket(() => { throw new Error('must not write'); });
    const cancelled = new HerdrClient('/unused', () => { duringConnect.abort(); return socket; });
    await assert.rejects(cancelled.sendInput('p1', 'hello', [], duringConnect.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(socket.writes.length, 0);
    assert.equal(socket.destroyed, true);
  });

  it('aborts pending transport and reports timeout without retrying input', async () => {
    const controller = new AbortController();
    let socket!: FakeSocket;
    const client = new HerdrClient('/unused', () => (socket = new FakeSocket(() => controller.abort())));
    await assert.rejects(client.snapshot(controller.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(socket.writes.length, 1);
    const timeout = new HerdrClient('/unused', () => (socket = new FakeSocket(() => {})), 1);
    await assert.rejects(timeout.sendInput('p1', 'hello', []), { code: 'HERDR_TIMEOUT', status: 504 });
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.destroyed, true);
  });
});
