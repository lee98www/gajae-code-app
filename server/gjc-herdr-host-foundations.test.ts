import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { herdrManagedDb } from '@/modules/database/repositories/herdr-managed.db.js';
import { projectPermissionsDb } from '@/modules/database/repositories/project-permissions.db.js';

import { canonicalManagedInvocation, verifyManagedBridgeReceipt } from '../shared/herdr-managed-bridge.js';
import type { HerdrManagedCommand, HerdrManagedAutomationOperation, HerdrManagedAutomationIdentity } from '../shared/herdr-managed-protocol.js';

import { commandHash, HerdrTaskHost, initializeManagedChildSession, type ManagedSdkSessionFactory } from './gjc-herdr-task-host.js';
import { ManagedAutomationStore, automationCanonical } from './gjc-herdr-automation-store.js';
import { HerdrManagedAttachClient } from './modules/herdr/index.js';
import { AutomationService } from './modules/automation/automation.service.js';
import { AutomationGrantStore } from './modules/automation/automation-grants.js';
import { ManagedBridgeLedger } from './modules/automation/managed-bridge-ledger.js';

const identity = { appSessionId: 'foundation-session', ownerGeneration: 'foundation-owner' };
const command = (actionId: string, kind: HerdrManagedCommand['kind'], payload: unknown): HerdrManagedCommand => ({ protocolVersion: 1, ...identity, actionId, kind, payload, payloadHash: commandHash(payload) });
const wait = async (condition: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'observation deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
async function fixture(run: (root: string, create: (factory: ManagedSdkSessionFactory) => Promise<HerdrTaskHost>, client: () => HerdrManagedAttachClient) => Promise<void>) {
  const prior = process.env.DATABASE_PATH;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-foundations-')));
  const hosts: HerdrTaskHost[] = [];
  const clients: HerdrManagedAttachClient[] = [];
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
  try {
    await initializeDatabase();
    herdrManagedDb.reserve({ ...identity, projectPath: root, herdrInstanceId: 'test' });
    await run(root, async createSession => {
      const host = new HerdrTaskHost({ bootstrap: { ...identity, projectPath: root, sessionRoot: root, herdrInstanceId: 'test', attachSocketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }, createSession });
      hosts.push(host); await host.initialize(); await host.startPrivateAttachServer(); return host;
    }, () => { const client = new HerdrManagedAttachClient({ ...identity, socketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }); clients.push(client); return client; });
  } finally {
    for (const client of clients) client.close();
    for (const host of hosts) await host.close();
    closeConnection();
    if (prior === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
}

test('host drains durable FIFO, fences completion before abort acknowledgement, and retains paused content', async () => {
  await fixture(async (_root, create) => {
    const starts: string[] = []; const finish = new Map<string, () => void>();
    let confirmAbort!: (value: boolean) => void;
    const host = await create(() => ({ providerSessionId: 'provider',
      prompt(text, actionId) { starts.push(text); return new Promise<void>(resolve => finish.set(actionId, resolve)); },
      abort() { finish.get('one')!(); return new Promise<boolean>(resolve => { confirmAbort = resolve; }); },
    }));
    const first = host.dispatch(command('one', 'prompt', { text: 'one' }));
    assert.equal((await host.dispatch(command('two', 'followup', { text: 'two' }))).state, 'admitted');
    assert.equal((await host.dispatch(command('three', 'followup', { text: 'three' }))).state, 'admitted');
    assert.deepEqual(host.snapshot().queue.entries.map(e => e.command.actionId), ['two', 'three']);
    const abort = host.dispatch(command('abort', 'abort', { turnId: 'one' }));
    await first;
    assert.deepEqual(starts, ['one']); assert.equal(host.snapshot().queue.paused, true);
    confirmAbort(true); assert.equal((await abort).state, 'settled');
    assert.deepEqual(starts, ['one']);
    assert.equal((await host.dispatch(command('four', 'followup', { text: 'four' }))).state, 'admitted');
    assert.deepEqual(starts, ['one', 'two']);
    finish.get('two')!(); await wait(() => starts.includes('three'));
    finish.get('three')!(); await wait(() => starts.includes('four'));
    finish.get('four')!(); await wait(() => host.snapshot().lifecycle === 'idle');
    assert.deepEqual(starts, ['one', 'two', 'three', 'four']);
    assert.equal(host.snapshot().queue.bytes, 0);
    assert.ok(Object.values(host.snapshot().turns).every(turn => turn.status === 'finished'));
  });
});

test('SDK rejection caused by a confirmed abort finishes the turn without poisoning the paused owner', async () => {
  await fixture(async (_root, create) => {
    let rejectPrompt!: (error: Error) => void;
    let aborted = false;
    const host = await create(() => ({ providerSessionId: 'provider',
      prompt: () => aborted ? Promise.resolve() : new Promise<void>((_resolve, reject) => { rejectPrompt = reject; }),
      async abort() { aborted = true; rejectPrompt(new Error('aborted')); return true; },
    }));
    const running = host.dispatch(command('turn', 'prompt', { text: 'go' }));
    assert.equal((await host.dispatch(command('queued', 'followup', { text: 'retained' }))).state, 'admitted');
    assert.equal((await host.dispatch(command('abort', 'abort', { turnId: 'turn' }))).state, 'settled');
    assert.equal((await running).state, 'settled');
    assert.equal(host.snapshot().lifecycle, 'idle');
    assert.equal(host.snapshot().turns.turn.abortConfirmed, true);
    assert.equal(host.snapshot().queue.paused, true);
    await host.dispatch(command('resume', 'followup', { text: 'resume' }));
    await wait(() => host.snapshot().commands.resume?.state === 'settled');
    assert.equal(host.snapshot().commands.queued.state, 'settled');
  });
});

test('host renews public permission IDs without replacing SDK callbacks and applies Always to the next request', async () => {
  await fixture(async (root, create) => {
    let emit!: Parameters<ManagedSdkSessionFactory>[0]['onEvent']; let finish!: () => void;
    const resolved: { requestId: string; decision: Record<string, unknown> }[] = [];
    const host = await create(input => { emit = input.onEvent; return {
      providerSessionId: 'provider', prompt: () => new Promise<void>(resolve => { finish = resolve; }),
      validateApproval: () => true,
      resolveApproval(requestId, decision) { resolved.push({ requestId, decision }); return true; },
    }; });
    const running = host.dispatch(command('turn', 'prompt', { text: 'go' }));
    const request = (requestId: string) => emit({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: 1,
      event: { kind: 'permission_request', requestId, toolName: 'bash', input: {}, context: { source: 'sdk-permission', options: ['allow_once', 'allow_always', 'reject_once', 'reject_always'] } } });
    await request('sdk-first');
    const old = Object.values(host.snapshot().requests)[0];
    projectPermissionsDb.reset(root);
    await wait(() => !host.snapshot().requests[old.requestId]);
    const renewed = Object.values(host.snapshot().requests)[0];
    assert.notEqual(renewed.requestId, old.requestId); assert.ok(renewed.policyRevision > old.policyRevision);
    const answer = (value: typeof renewed, decision: string) => ({ requestId: value.requestId, providerSessionId: value.providerSessionId, turnId: value.turnId, policyRevision: value.policyRevision, decision });
    assert.equal((await host.dispatch(command('stale', 'permission', answer(old, 'allow-once')))).state, 'rejected');
    assert.equal((await host.dispatch(command('always', 'permission', answer(renewed, 'allow-always')))).state, 'settled');
    assert.deepEqual(resolved[0], { requestId: 'sdk-first', decision: { allow: true, always: true } });
    await request('sdk-next'); await wait(() => resolved.length === 2);
    assert.deepEqual(resolved[1], { requestId: 'sdk-next', decision: { allow: true } });
    projectPermissionsDb.reset(root);
    await request('sdk-deny'); const deny = Object.values(host.snapshot().requests).find(value => value.scope.status === 'pending')!;
    const policyBefore = herdrManagedDb.currentPolicy(identity.appSessionId, identity.ownerGeneration);
    assert.equal((await host.dispatch(command('deny-remaining', 'permission', answer(deny, 'deny-remaining')))).state, 'settled');
    assert.deepEqual(herdrManagedDb.currentPolicy(identity.appSessionId, identity.ownerGeneration), policyBefore);
    assert.deepEqual(resolved[2], { requestId: 'sdk-deny', decision: { allow: false, always: true } });
    finish(); await running;
  });
});

test('queue capacity rejects overflow without evicting admitted content', async () => {
  await fixture(async (_root, create) => {
    let finish!: () => void;
    const host = await create(() => ({ providerSessionId: 'provider', prompt: () => new Promise<void>(resolve => { finish = resolve; }), abort: async () => false }));
    const running = host.dispatch(command('turn', 'prompt', { text: 'go' }));
    for (let index = 0; index < 16; index++) assert.equal((await host.dispatch(command(`q-${index}`, 'followup', { text: `queued-${index}` }))).state, 'admitted');
    const queued = host.snapshot().queue.entries;
    assert.equal((await host.dispatch(command('overflow', 'followup', { text: 'overflow' }))).state, 'rejected');
    assert.deepEqual(host.snapshot().queue.entries, queued);
    assert.equal((await host.dispatch(command('abort', 'abort', { turnId: 'turn' }))).state, 'unknown');
    assert.equal(host.snapshot().queue.paused, true);
    finish(); await running;
    assert.deepEqual(host.snapshot().queue.entries, queued);
  });
});

test('two snapshot leases coexist while live request resolutions and over-tail history are retained', async () => {
  await fixture(async (_root, create, client) => {
    let emit!: Parameters<ManagedSdkSessionFactory>[0]['onEvent']; let finish!: () => void;
    const host = await create(input => { emit = input.onEvent; return { providerSessionId: 'provider', prompt: () => new Promise<void>(resolve => { finish = resolve; }), validateApproval: () => true, resolveApproval: () => true }; });
    const running = host.dispatch(command('turn', 'prompt', { text: 'go' }));
    await emit({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: 1, event: { kind: 'tool_use', toolId: 'browser-tool', toolName: 'browser', toolInput: { privateArgument: 'never-public' } } });
    await emit({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: 2, event: { kind: 'tool_result', toolId: 'browser-tool', content: 'never-public', isFinal: true } });
    assert.equal(JSON.stringify(host.snapshot()).includes('never-public'), false);
    for (let index = 0; index < 300; index++) await emit({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: index + 1, event: { kind: 'stream_delta', content: `${index}:` + 'x'.repeat(1024) } });
    const first = client(); const second = client();
    const hello1 = await first.connect(); const hello2 = await second.connect();
    assert.equal(hello1.type, 'ready'); assert.equal(hello2.type, 'ready');
    if (hello1.type !== 'ready' || hello2.type !== 'ready') throw new Error('Missing descriptor');
    assert.ok(hello1.snapshot.pageCount > 1); assert.notEqual(hello1.snapshot.snapshotId, hello2.snapshot.snapshotId);
    assert.equal(Object.hasOwn(hello1.snapshot, 'events'), false);
    const recovering = Promise.all([first.recover(), second.recover()]);
    await emit({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: 301, event: { kind: 'permission_request', requestId: 'callback', toolName: 'ask', input: { questions: [{ question: 'Continue?', options: [{ label: 'yes' }] }] } } });
    const request = Object.values(host.snapshot().requests)[0];
    assert.equal((await host.dispatch(command('answer', 'answer', { requestId: request.requestId, providerSessionId: 'provider', turnId: 'turn', answer: 'yes' }))).state, 'settled');
    finish(); await running; await recovering;
    await wait(() => first.state?.watermark === host.snapshot().watermark && second.state?.watermark === host.snapshot().watermark);
    assert.deepEqual(first.state, host.snapshot()); assert.deepEqual(second.state, host.snapshot());
    assert.equal(first.state?.messages[0].content.includes('0:'), true);
    assert.deepEqual(first.state?.requests, {});
  });
});

test('protected chunkstore rejects gaps, tampering and false references and survives reopen', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'managed-chunks-'));
  let store = new ManagedAutomationStore(root, identity.ownerGeneration);
  try {
    const args = { value: 'private-value' };
    const opIdentity: HerdrManagedAutomationIdentity = { generation: identity.ownerGeneration, provider: 'provider', turn: 'turn', toolCallId: 'tool', operationId: 'operation', index: 0, argumentsHash: createHash('sha256').update(automationCanonical(args)).digest('hex'), policyRevision: 0, targetContext: 'https://example.test' };
    const bytes = Buffer.from(JSON.stringify({ identity: opIdentity, arguments: args }));
    const chunk = { kind: 'managed.automation-record-chunk', recordId: 'record', operationId: 'operation', index: 0, total: 1, encoding: 'base64', data: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') };
    assert.throws(() => store.putChunk({ ...chunk, index: 1, total: 2 }), /order/);
    assert.throws(() => store.putChunk({ ...chunk, sha256: '0'.repeat(64) }), /hash/);
    store.putChunk(chunk); assert.throws(() => store.putChunk(chunk), /order/);
    store.close(); store = new ManagedAutomationStore(root, identity.ownerGeneration);
    assert.deepEqual(store.read('record', 'operation').arguments, args);
    const operation: HerdrManagedAutomationOperation = { identity: opIdentity, phase: 'waiting_attachment', argumentsRef: 'record', resultRef: null, evidenceRef: null, capabilityGeneration: null, approvalRequestId: null, dispatchCount: 0 };
    store.verify(operation);
    assert.throws(() => store.verify({ ...operation, resultRef: 'record' }), /result missing/);
    assert.throws(() => store.verify({ ...operation, argumentsRef: 'fabricated' }), /Incomplete/);
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('private child broker retains callback across owner connection EOF and dispatches reattached approval exactly once', { timeout: 30_000 }, async () => {
  await fixture(async (root, create, client) => {
    const script = path.join(root, 'child.ts');
    await fs.writeFile(script, `
import { runManagedChild } from ${JSON.stringify(fileURLToPath(new URL('./gjc-herdr-managed-child.ts', import.meta.url)))};
import { GjcHerdrAutomationBroker } from ${JSON.stringify(fileURLToPath(new URL('./gjc-herdr-automation-broker.ts', import.meta.url)))};
await runManagedChild({ createAdapter: async () => ({ initializeManagedGjcSession: async (_id, _config, writer, managed) => {
  const broker = new GjcHerdrAutomationBroker({ generation: managed.generation, provider: 'provider', policyRevision: 0, emit: event => writer.send(event), flush: managed.flush });
  return { providerSessionId: 'provider', setAutomationTurn: turn => broker.setTurn(turn), automationControl: control => broker.control(control), operationStatus: id => broker.status(id),
    prompt: () => broker.dispatch({ toolCallId: 'tool', index: 0, request: { surface: 'browser', sessionId: 's', operation: 'command', payload: { command: { action: 'observe' } } } }),
    steer: async () => false, abort: async () => { await broker.abort(); return true; }, dispose: () => broker.abort(), validateApproval: () => false, resolveApproval: () => false };
} }) });
`);
    const child = spawn(fileURLToPath(new URL('../dist-native/bun', import.meta.url)), [script], { stdio: ['pipe', 'pipe', 'pipe'] });
    const priorSocket = process.env.GAJAE_AUTOMATION_SOCKET;
    process.env.GAJAE_AUTOMATION_SOCKET = path.join(root, 'bridge.sock');
    let dispatches = 0;
    const bridge = new AutomationService(root);
    Object.defineProperty(bridge, 'supported', { value: true });
    Object.defineProperty(bridge, 'grants', { value: new AutomationGrantStore({ get: () => null, set: () => {} }) });
    bridge.browser.state = async () => ({ sessionId: 's', activeTabId: 'tab-1', tabs: [{ id: 'tab-1', url: 'https://example.test/private', title: '', loading: false, canGoBack: false, canGoForward: false }] });
    bridge.browser.command = async (session, invocation, _signal, target) => {
      assert.equal(session, 's');
      assert.deepEqual(invocation, { action: 'observe' });
      assert.deepEqual(target, { tabId: 'tab-1', origin: 'https://example.test' });
      dispatches++; return { observed: 'actual' };
    };
    bridge.browser.shutdown = async () => {};
    bridge.cua.shutdown = async () => {};
    try {
      await bridge.startBridge();
      const host = await create(({ onEvent, appSessionId, ownerGeneration }) => initializeManagedChildSession(child, { appSessionId, ownerGeneration, onEvent, agentDir: root, runConfig: { cwd: root, sessionRoot: root, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'fixture', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } } }));
      const running = host.dispatch(command('turn', 'prompt', { text: 'inspect' }));
      await wait(() => Object.keys(host.snapshot().automation).length === 1);
      const owner = client(); const observer = client(); await owner.connect(); await observer.connect();
      const source = Object.values(host.snapshot().automation)[0];
      assert.equal(source.identity.targetContext, 'unresolved');
      const transport = bridge.managedBridgeCapability()!;
      const attach = () => {
        const pending = Object.values(host.snapshot().automation).find(op => op.phase === 'waiting_attachment')!;
        assert.ok(pending);
        return { type: 'bind-capability' as const, actionId: randomUUID(), identity: pending.identity, currentTransport: { ownerConnectionId: 'caller-cannot-choose', bridgeInstanceId: transport.bridgeInstanceId, transportLocator: transport.socketPath, transportToken: transport.token } };
      };
      const response = await owner.automationControl(attach()); assert.deepEqual(response.type === 'automation-control' && response.accepted, true);
      await wait(() => Object.values(host.snapshot().automation).some(op => op.phase === 'awaiting_reattach_approval'));
      const offered = Object.values(host.snapshot().automation).find(op => op.phase === 'awaiting_reattach_approval')!;
      const persisted = new ManagedAutomationStore(root, identity.ownerGeneration);
      assert.equal(offered.identity.targetContext, canonicalManagedInvocation({ kind: 'browser-origin', origin: 'https://example.test', tabId: 'tab-1' }));
      try { assert.deepEqual(persisted.read(offered.argumentsRef, offered.identity.operationId).arguments, { surface: 'browser', sessionId: 's', operation: 'command', payload: { command: { action: 'observe' } } }); }
      finally { persisted.close(); }
      assert.equal(await host.session!.operationStatus!(offered.identity.operationId), 'in_flight');
      observer.close(); await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(host.snapshot().automation[offered.identity.operationId].phase, 'awaiting_reattach_approval');
      owner.close(); await wait(() => host.snapshot().automation[offered.identity.operationId].phase === 'waiting_attachment');
      assert.equal(dispatches, 0);
      const reattached = client(); await reattached.connect();
      const rebound = await reattached.automationControl(attach());
      assert.ok(rebound.type === 'automation-control' && rebound.accepted);
      await wait(() => Object.values(host.snapshot().automation).some(op => op.phase === 'awaiting_reattach_approval'));
      const current = Object.values(host.snapshot().automation).find(op => op.phase === 'awaiting_reattach_approval')!;
      const payload = { identity: current.identity, capabilityGeneration: current.capabilityGeneration, approvalRequestId: current.approvalRequestId, decision: 'approve' };
      assert.equal((await host.dispatch(command('old-approval', 'resume', { ...payload, approvalRequestId: offered.approvalRequestId }))).state, 'rejected');
      assert.equal((await host.dispatch(command('deny', 'resume', { ...payload, decision: 'deny' }))).state, 'settled'); assert.equal(dispatches, 0);
      // A denial consumes its request: the same ID can no longer approve, and a fresh request is offered.
      assert.equal((await host.dispatch(command('approve-consumed', 'resume', payload))).state, 'rejected'); assert.equal(dispatches, 0);
      await wait(() => host.snapshot().automation[current.identity.operationId].approvalRequestId !== current.approvalRequestId);
      const renewed = host.snapshot().automation[current.identity.operationId];
      assert.equal(renewed.phase, 'awaiting_reattach_approval');
      const approval = command('approve', 'resume', { ...payload, approvalRequestId: renewed.approvalRequestId });
      const receipts = await Promise.all([host.dispatch(approval), host.dispatch(approval)]); assert.deepEqual(receipts[0], receipts[1]); assert.equal(receipts[0].state, 'settled');
      await running; assert.equal(dispatches, 1);
      assert.equal(await host.session!.operationStatus!(current.identity.operationId), 'completed');
      const publicState = JSON.stringify(host.snapshot());
      assert.doesNotMatch(publicState, /transportToken|managed\.automation-record-chunk|"action":"observe"/);
      assert.equal(publicState.includes(transport.token), false);
      const completed = host.snapshot().automation[current.identity.operationId];
      assert.equal(completed.phase, 'completed');
      const store = new ManagedAutomationStore(root, identity.ownerGeneration);
      const ledger = new ManagedBridgeLedger(root);
      try {
        store.verify(completed);
        const record = store.read(completed.evidenceRef!, completed.identity.operationId);
        const attempt = store.read(completed.argumentsRef, completed.identity.operationId).attempt;
        assert.ok(attempt);
        assert.deepEqual(attempt.identity, current.identity);
        assert.equal(attempt.originalCapabilityGeneration, current.capabilityGeneration);
        assert.equal(attempt.bridgeInstanceId, transport.bridgeInstanceId);
        assert.equal(attempt.sourceOperationId, source.identity.operationId);
        assert.ok(attempt.requestId);
        assert.deepEqual(attempt.targetBinding, { kind: 'browser-origin', origin: 'https://example.test', tabId: 'tab-1' });
        const receipt = verifyManagedBridgeReceipt(record.evidence!.content, attempt);
        assert.equal(receipt.status, 'completed');
        assert.deepEqual(receipt, ledger.lookupOutcome(attempt));
        if (receipt.status !== 'completed') throw new Error('Missing completed receipt');
        assert.deepEqual(receipt.response, { ok: true, result: { observed: 'actual' } });
      } finally { store.close(); ledger.close(); }
      await host.close();
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      await bridge.shutdown();
      if (priorSocket === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET;
      else process.env.GAJAE_AUTOMATION_SOCKET = priorSocket;
    }
  });
});
