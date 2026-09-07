import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { WebSocket, WebSocketServer } from 'ws';

import { closeConnection, getConnection } from '../modules/database/connection.js';
import { INIT_SCHEMA_SQL } from '../modules/database/schema.js';
import { sessionsDb } from '../modules/database/repositories/sessions.db.js';
import { herdrManagedDb } from '../modules/database/repositories/herdr-managed.db.js';
import { herdrManagedProvisionDb as db } from '../modules/database/repositories/herdr-managed-provision.db.js';
import { createHerdrManagedState, pageHerdrManagedState, serializeHerdrManagedState } from '../../shared/herdr-managed-state.js';
import { assembleManagedTransfer, MANAGED_CHAT_MAX_FRAME_BYTES, type ManagedSnapshotFrame } from '../../shared/herdr-managed-chat.js';
import type { HerdrManagedCommand, HerdrManagedEvent } from '../../shared/herdr-managed-protocol.js';
import { automationService } from '../modules/automation/automation.service.js';
import { HerdrManagedAttachClient, HerdrManagedChatService, type ManagedChatConnection } from '../modules/herdr/index.js';

function viewer() {
  const frames: Record<string, unknown>[] = [];
  const connection: ManagedChatConnection = { readyState: 1, send: text => { frames.push(JSON.parse(text)); } };
  return { connection, frames };
}

test('large immutable snapshots drain over a real paused WebSocket and retain concurrent journal changes', async () => {
  const identity = { appSessionId: 'large-chat', ownerGeneration: 'large-owner' };
  let state = createHerdrManagedState(identity);
  state = { ...state, lifecycle: 'idle', providerSessionId: 'native-large', watermark: 10,
    messages: [{ id: 'message-1', turnId: 'turn-1', content: 'owned transcript\n'.repeat(600_000), reasoning: [], final: true, metadata: {} }] };
  let onState: (value: typeof state) => void = () => {};
  let onEvent: (value: HerdrManagedEvent) => void = () => {};
  const client = {
    get state() { return state; }, connected: true,
    recover: async () => state,
    subscribe: (callback: typeof onEvent) => { onEvent = callback; return () => {}; },
    subscribeState: (callback: typeof onState) => { onState = callback; return () => {}; },
    command: async () => { throw new Error('Snapshot transfer must not dispatch commands.'); },
    automationControl: async () => { throw new Error('Snapshot transfer must not dispatch automation.'); },
    close: () => {},
  };
  const service = new HerdrManagedChatService({
    workspaces: { isManaged: () => true, attach: async () => client, ensure: async () => { throw new Error('Existing owner must not be provisioned.'); } },
    db: { get: () => null, projectState: () => true }, automationTransport: async () => null,
  });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  let browser: WebSocket | undefined;
  let peer: WebSocket | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = setTimeout(() => { browser?.terminate(); peer?.terminate(); }, 15_000);
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const accepted = new Promise<WebSocket>(resolve => server.once('connection', resolve));
    browser = new WebSocket(`ws://127.0.0.1:${(server.address() as net.AddressInfo).port}`);
    const frames: ManagedSnapshotFrame[] = [];
    let updates = 0;
    const recovered = new Promise<void>((resolve, reject) => {
      browser!.on('error', reject);
      browser!.on('message', data => {
        const frame = JSON.parse(data.toString()) as ManagedSnapshotFrame;
        frames.push(frame);
        if (frame.kind === 'managed_snapshot_page' && updates < 2) {
          updates++;
          state = { ...state, watermark: state.watermark + 1, title: `Concurrent title ${updates}` };
          onState(state);
          onEvent({ protocolVersion: 1, ...identity, seq: state.watermark, kind: 'session_title', payload: { title: state.title }, createdAt: new Date().toISOString() });
        }
        if (frame.kind === 'managed_snapshot_end' && frame.watermark === 12) resolve();
      });
      browser!.once('close', () => reject(new Error('A progressing snapshot viewer was disconnected.')));
    });
    await new Promise<void>(resolve => browser!.once('open', resolve));
    browser.pause();
    peer = await accepted;
    resumeTimer = setTimeout(() => browser!.resume(), 75);
    const subscribed = await service.subscribe(identity.appSessionId, peer);
    assert.equal(subscribed.ok, true);
    await recovered;
    const ends = frames.filter(frame => frame.kind === 'managed_snapshot_end');
    assert.deepEqual(ends.map(frame => frame.watermark), [10, 12]);
    for (const end of ends) {
      const transfer = frames.filter(frame => frame.transferId === end.transferId);
      assert.ok(JSON.stringify(transfer).length > MANAGED_CHAT_MAX_FRAME_BYTES * 4);
      const projection = assembleManagedTransfer(transfer);
      assert.equal(projection.records[0].content, state.messages[0].content);
      assert.equal(projection.metadata.providerSessionId, 'native-large');
      assert.equal(projection.metadata.ownerGeneration, identity.ownerGeneration);
      if (end.watermark === 12) assert.equal(projection.metadata.title, 'Concurrent title 2');
    }
    assert.equal(peer.readyState, WebSocket.OPEN);
  } finally {
    clearTimeout(watchdog);
    clearTimeout(resumeTimer);
    service.close(); browser?.terminate(); peer?.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('real attach projects mapping before send, reuses owner, orders two viewers and detaches without terminating host', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-chat-'));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
  const sockets = new Set<net.Socket>();
  let service: HerdrManagedChatService | undefined;
  let client: HerdrManagedAttachClient | undefined;
  let server: net.Server | undefined;
  try {
    getConnection().exec(INIT_SCHEMA_SQL);
    sessionsDb.createAppSession('app', 'gjc', '/project'); db.registerNewSession('app', '/project');
    const record = db.reserve('app', { name: 'chosen', canonicalPath: '/owned/herdr.sock', dev: 1, inode: 2 }, root);
    const identity = { appSessionId: 'app', ownerGeneration: record.ownerGeneration };
    db.cas('app', identity.ownerGeneration, 'reserved', 'layout_requested');
    db.claimLaunch('app', identity.ownerGeneration, record.claimNonce);
    herdrManagedDb.beginClaim('app', identity.ownerGeneration);
    herdrManagedDb.claim({ protocolVersion: 1, ...identity, providerSessionId: 'native' });
    const placement = { sessionName: 'chosen', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' };
    db.cas('app', identity.ownerGeneration, 'layout_requested', 'layout_created', 'w1', placement);
    const state = () => herdrManagedDb.getState('app', identity.ownerGeneration);
    const commands: HerdrManagedCommand[] = [];
    const order: string[] = [];
    let snapshots = 0;
    let attaches = 0;
    const socketPath = path.join(root, 'socket');
    server = net.createServer(socket => {
      sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf('\n'); if (end < 0) break;
          const frame = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const send = (value: unknown) => socket.write(`${JSON.stringify(value)}\n`);
          const pages = pageHerdrManagedState(state());
          const snapshot = { identity, snapshotId: 'snapshot', watermark: state().watermark, pageCount: pages.length, byteLength: Buffer.byteLength(serializeHerdrManagedState(state())), leaseExpiresAt: Date.now() + 60_000 };
          if (frame.type === 'hello' || frame.type === 'snapshot') { snapshots++; send({ type: 'ready', id: frame.id, snapshot }); }
          else if (frame.type === 'snapshot-page') send({ type: 'snapshot-page', id: frame.id, snapshotId: 'snapshot', page: frame.page, chunk: pages[frame.page], leaseExpiresAt: snapshot.leaseExpiresAt });
          else if (frame.type === 'subscribe') send({ type: 'subscribed', id: frame.id, watermark: frame.watermark });
          else if (frame.type === 'command') {
            assert.equal(sessionsDb.getSessionById('app')?.provider_session_id, 'native');
            order.push('command'); commands.push(frame.value);
            send({ type: 'receipt', id: frame.id, receipt: { protocolVersion: 1, ...identity, actionId: frame.value.actionId, seq: state().watermark, state: 'settled', message: 'accepted' } });
          }
        }
      });
    });
    await new Promise<void>(resolve => server!.listen(socketPath, resolve));
    client = new HerdrManagedAttachClient({ socketPath, ...identity, attachSecret: 'x'.repeat(32) });
    await client.connect(); await client.recover();
    let pin: { changed: boolean; model: string | null } = { changed: false, model: null };
    service = new HerdrManagedChatService({ workspaces: {
      isManaged: id => id === 'app',
      ensure: async () => { order.push('ensure'); db.projectReady('app', identity.ownerGeneration, 'native'); return { status: 'ready', ...identity, providerSessionId: 'native', placement }; },
      attach: async () => { attaches++; return client!; },
    }, pinnedModel: async () => pin });
    const first = viewer(); const second = viewer();
    for (const actionId of [undefined, '', 'invalid action', 'a'.repeat(97)]) {
      await service.handle(first.connection, { type: 'chat.send', sessionId: 'app', actionId, content: 'invalid' });
      assert.deepEqual(first.frames.at(-1), { kind: 'managed_command_result', sessionId: 'app', actionId: null, requestId: null, result: { ok: false, error: 'Managed command requires a stable actionId.' } });
    }
    assert.equal((await service.send({ sessionId: 'app', content: ' ', actionId: 'empty' }, first.connection)).ok, false);
    assert.deepEqual(order, []);
    assert.equal(attaches, 0);
    assert.equal((await service.send({ sessionId: 'app', content: 'hello', actionId: 'first' }, first.connection)).ok, true);
    assert.deepEqual(order, ['ensure', 'command']);
    assert.equal((await service.subscribe('app', second.connection)).ok, true);
    assert.equal((await service.send({ sessionId: 'app', content: 'again', actionId: 'second' }, first.connection)).ok, true);
    assert.equal(commands.length, 2);
    assert.equal((await service.send({ sessionId: 'app', content: 'image turn', actionId: 'third', options: { images: ['image'], modelId: 'provider/model', effort: 'high' } }, first.connection)).ok, true);
    assert.equal(commands.length, 3);
    assert.equal(attaches, 1);
    assert.equal(snapshots, 1, 'healthy commands and viewers reuse the live state');
    assert.deepEqual((commands.at(-1)!.payload as { turnOptions: unknown }).turnOptions, { modelId: 'provider/model', effort: 'high' });
    // A reopened App only knows its ambient default. Once the owner has a
    // configured model, that default must not switch it; an explicit pin may.
    const turnOptionsOf = () => (commands.at(-1)!.payload as { turnOptions: unknown }).turnOptions;
    assert.equal((await service.send({ sessionId: 'app', content: 'ambient before configuration', actionId: 'ambient-0', options: { model: 'default', effort: 'low' } }, first.connection)).ok, true);
    assert.deepEqual(turnOptionsOf(), { modelId: 'default', effort: 'low' }, 'without an owner configuration the default is the only choice');
    herdrManagedDb.appendEvent({ ...identity, kind: 'managed.session', payload: { configuration: { modelId: 'gpt-owner', thinkingLevel: 'low' } } });
    await client.recover();
    assert.equal(client.state?.configuration?.modelId, 'gpt-owner');
    assert.equal((await service.send({ sessionId: 'app', content: 'ambient after reopen', actionId: 'ambient-1', options: { model: 'default', effort: 'low' } }, first.connection)).ok, true);
    assert.deepEqual(turnOptionsOf(), { effort: 'low' }, 'the ambient default keeps the owner model');
    assert.equal((await service.send({ sessionId: 'app', content: 'explicit switch', actionId: 'explicit-1', options: { model: 'provider/other', effort: 'low' } }, first.connection)).ok, true);
    assert.deepEqual(turnOptionsOf(), { modelId: 'provider/other', effort: 'low' });
    pin = { changed: true, model: 'default' };
    assert.equal((await service.send({ sessionId: 'app', content: 'pinned default', actionId: 'pinned-default', options: { model: 'default' } }, first.connection)).ok, true);
    assert.deepEqual(turnOptionsOf(), { modelId: 'default' }, 'an explicit per-session pin to the default is honoured');
    pin = { changed: false, model: null };
    assert.match(record.claimNonce, /^[a-f0-9]{64}$/);
    db.assertReadyProjection('app', identity.ownerGeneration);
    const event = herdrManagedDb.appendEvent({ ...identity, kind: 'sdk.event', payload: { kind: 'text', role: 'user', content: 'console turn' } }) as HerdrManagedEvent;
    for (const socket of sockets) socket.write(`${JSON.stringify({ type: 'event', event })}\n`);
    await new Promise<void>(resolve => {
      const off = client!.subscribe(() => { off(); resolve(); });
    });
    for (const v of [first, second]) {
      assert.equal(v.frames.at(-1)?.kind, 'managed_live_event');
      assert.ok(v.frames.findIndex(f => f.kind === 'managed_snapshot_end') < v.frames.findIndex(f => f.kind === 'managed_live_event'));
    }
    service.detach(first.connection); first.connection.readyState = 3;
    assert.equal(sockets.size, 1);
    assert.equal((await service.status('app', 'status')).ok, true);
    assert.equal((await service.permissionResponse({ sessionId: 'app', actionId: 'answer', requestId: 'missing', allow: true })).ok, false);
    herdrManagedDb.beginTurn('app', identity.ownerGeneration, 'turn');
    await client.recover();
    assert.equal(await service.handle(second.connection, { type: 'chat.send', sessionId: 'app', actionId: 'queued', content: 'follow up' }), true);
    assert.equal(commands.at(-1)?.kind, 'followup');
    herdrManagedDb.appendSdkEvent({ ...identity, providerSessionId: 'native', turnId: 'turn', kind: 'sdk.event', payload: {},
      request: { requestId: 'sdk-ask', requestKind: 'ask', schema: { questions: [{ question: 'Choose', options: [] }] } } });
    await client.recover();
    const pending = Object.values(client.state!.requests)[0]!;
    assert.notEqual(pending.requestId, 'sdk-ask');
    const decision = await service.permissionResponse({ sessionId: 'app', actionId: 'reply', requestId: pending.requestId, allow: true, message: 'answer' });
    assert.equal(decision.ok, true);
    assert.equal(commands.at(-1)?.kind, 'answer');
    assert.equal(herdrManagedDb.getPending({ ...identity, providerSessionId: 'native', turnId: 'turn', requestId: pending.requestId })?.status, 'pending');
    assert.ok(client.state!.requests[pending.requestId], 'receipt alone must not optimistically remove host request');
    await service.handle(second.connection, { type: 'chat.permission-response', actionId: 'sessionless', requestId: pending.requestId, allow: true });
    assert.deepEqual(second.frames.at(-1), {
      kind: 'managed_command_result', sessionId: 'app', actionId: 'sessionless', requestId: pending.requestId,
      result: { ok: true, receipt: { protocolVersion: 1, ...identity, actionId: 'sessionless', seq: state().watermark, state: 'settled', message: 'accepted' } },
    });
    let slowClosed = 0;
    const slow = viewer();
    slow.connection.bufferedAmount = 8 * 1024 * 1024;
    slow.connection.close = code => { assert.equal(code, 1013); slowClosed++; };
    assert.equal((await service.subscribe('app', slow.connection)).ok, false);
    assert.equal(slowClosed, 1);
    assert.deepEqual(slow.frames, []);
    assert.equal(service.isManaged('legacy'), false);
    assert.equal(await service.handle(second.connection, { type: 'chat.send', sessionId: 'legacy', content: 'unmanaged' }), false);
    assert.equal((await service.send({ sessionId: 'legacy', content: 'no fallback', actionId: 'legacy' }, second.connection)).ok, false);

    assert.equal(db.projectState('app', identity.ownerGeneration, 100, { providerSessionId: 'native', title: 'Generated', jsonlPath: '/real/native.jsonl' }), true);
    getConnection().prepare("UPDATE sessions SET custom_name = 'User title', name_source = 'user' WHERE session_id = 'app'").run();
    assert.equal(db.projectState('app', identity.ownerGeneration, 99, { providerSessionId: 'native', title: 'Old' }), false);
    assert.equal(db.projectState('app', identity.ownerGeneration, 101, { providerSessionId: 'native', title: 'New' }), true);
    assert.equal(sessionsDb.getSessionById('app')?.custom_name, 'User title');
    assert.equal(sessionsDb.getSessionById('app')?.jsonl_path, '/real/native.jsonl');
    assert.throws(() => db.projectState('app', 'stale', 200, { providerSessionId: 'native', title: 'Bad' }), /identity/);
    service.close();
    const controls: Record<string, unknown>[] = [];
    const originalBridgeCapability = automationService.managedBridgeCapability;
    automationService.managedBridgeCapability = () => ({ socketPath: '/private/bridge.sock', token: 't'.repeat(64), bridgeInstanceId: 'real-app-instance' });
    const unresolved = { generation: identity.ownerGeneration, provider: 'native', turn: 'turn', toolCallId: 'url-less', operationId: 'url-less-operation', index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 0, targetContext: 'unresolved' };
    const waiting = { identity: unresolved, phase: 'waiting_attachment' as const, argumentsRef: 'private-args', resultRef: null, evidenceRef: null, capabilityGeneration: null, approvalRequestId: null, dispatchCount: 0 };
    const pendingState = { ...state(), automation: {
      [unresolved.operationId]: waiting,
      historical: { ...waiting, identity: { ...unresolved, operationId: 'historical' }, phase: 'outcome_unknown' as const, capabilityGeneration: 'original-capability', dispatchCount: 1 },
    } };
    const normal = new HerdrManagedChatService({
      db: { get: db.get, projectState: () => true },
      workspaces: { isManaged: () => true, ensure: async () => { throw new Error('Subscribe does not provision'); }, attach: async () => ({
        state: pendingState, connected: true, recover: async () => pendingState, subscribe: () => () => {}, subscribeState: () => () => {},
        automationControl: async (control: Parameters<HerdrManagedAttachClient['automationControl']>[0]) => { controls.push(control); return { type: 'automation-control' as const, id: 'reply', accepted: true }; },
        command: async () => { throw new Error('No command expected'); }, close() {},
      } as unknown as HerdrManagedAttachClient) },
    });
    try {
      assert.equal((await normal.subscribe('app', viewer().connection)).ok, true);
      assert.deepEqual(controls.map(control => control.type), ['bind-capability', 'reconcile']);
      assert.deepEqual(controls[0].identity, unresolved);
      assert.equal(controls[1].originalCapabilityGeneration, 'original-capability');
      assert.equal(Object.hasOwn(controls[0], 'capability'), false);
      assert.equal(Object.hasOwn(controls[0], 'argumentsRef'), false);
    } finally { normal.close(); }
    // A bind the host cannot complete yet: the host answers why, the viewer is
    // told what the step waits for, and a later successful bind clears it.
    const binds: number[] = [];
    const waitingState = { ...state(), automation: { [unresolved.operationId]: waiting } };
    const told = new HerdrManagedChatService({
      db: { get: db.get, projectState: () => true },
      workspaces: { isManaged: () => true, ensure: async () => { throw new Error('Subscribe does not provision'); }, attach: async () => ({
        state: waitingState, connected: true, recover: async () => waitingState, subscribe: () => () => {}, subscribeState: () => () => {},
        automationControl: async (control: Parameters<HerdrManagedAttachClient['automationControl']>[0]) => {
          if (control.type !== 'bind-capability') throw new Error('Only binds expected');
          binds.push(Date.now());
          if (binds.length === 1) return { type: 'automation-control' as const, id: 'reply', accepted: false, reason: 'session_not_found: Open the browser session first.' };
          return { type: 'automation-control' as const, id: 'reply', accepted: true };
        },
        command: async () => { throw new Error('No command expected'); }, close() {},
      } as unknown as HerdrManagedAttachClient) },
    });
    try {
      const watcher = viewer();
      assert.equal((await told.subscribe('app', watcher.connection)).ok, true);
      type Status = { text?: string; automationWaiting?: boolean };
      const statusOf = (frame: Record<string, unknown>): Status | undefined => {
        const pages = frame.kind === 'managed_snapshot_page' && typeof frame.chunk === 'string' ? frame.chunk : null;
        if (pages) return { automationWaiting: /"automationWaiting":true/.test(pages), text: (/"text":"([^"]*)"/.exec(pages) ?? [])[1] };
        const projection = frame.projection as { metadata?: { status?: Status } } | undefined;
        return (frame.metadata as { status?: Status } | undefined)?.status ?? projection?.metadata?.status;
      };
      const statuses = () => watcher.frames.map(statusOf).filter(Boolean) as Status[];
      for (let i = 0; i < 200 && !statuses().some(status => status.automationWaiting); i++) await new Promise(resolve => setTimeout(resolve, 5));
      const waitingStatus = statuses().find(status => status.automationWaiting);
      assert.ok(waitingStatus, 'the viewer is told what the step waits for');
      assert.equal(waitingStatus.text, 'Automation step waiting for its target: session_not_found: Open the browser session first.');
      // The next renewal binds: the reason is gone from the projection again.
      for (let i = 0; i < 600 && binds.length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
      for (let i = 0; i < 200 && (statuses().at(-1)?.automationWaiting); i++) await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(Boolean(statuses().at(-1)?.automationWaiting), false, 'a successful bind clears the wait reason');
    } finally { told.close(); automationService.managedBridgeCapability = originalBridgeCapability; }
    let finishAttach!: (value: HerdrManagedAttachClient) => void;
    let renewals = 0;
    const closing = new HerdrManagedChatService({
      automationTransport: async () => { renewals++; return null; },
      workspaces: {
        isManaged: () => true,
        ensure: async () => { assert.fail('Closed coordinator must not ensure a host'); },
        attach: () => new Promise(resolve => { finishAttach = resolve; }),
      },
    });
    const late = viewer();
    const pendingAttach = closing.subscribe('app', late.connection);
    closing.close();
    finishAttach(client);
    assert.equal((await pendingAttach).ok, false);
    assert.equal(renewals, 0);
    assert.deepEqual(late.frames, []);
    assert.equal((await closing.send({ sessionId: 'app', actionId: 'closed', content: 'late' }, late.connection)).ok, false);
  } finally {
    service?.close(); client?.close(); for (const socket of sockets) socket.destroy();
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('unavailable selection reports context without inventing idle or falling back', async () => {
  const v = viewer(); let attaches = 0;
  const service = new HerdrManagedChatService({ db: { get: () => null, projectState: () => { throw new Error('No projection expected'); } }, workspaces: {
    isManaged: () => true,
    ensure: async () => ({ status: 'unavailable', appSessionId: 'app', providerSessionId: null, ownerGeneration: null, selectedSessionName: 'absent' }),
    attach: async () => { attaches++; throw new Error('No attach expected'); },
  } });
  const result = await service.send({ sessionId: 'app', content: 'hello', actionId: 'send' }, v.connection);
  assert.equal(result.status, 'unavailable'); assert.equal(attaches, 0);
  assert.equal(v.frames[0]?.kind, 'managed_ui_status'); assert.equal(v.frames[0]?.lifecycle, undefined);
  assert.equal(v.frames[0]?.isProcessing, undefined); service.close();
});
