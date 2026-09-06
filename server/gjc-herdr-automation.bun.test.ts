import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { applyHerdrManagedEvent, createHerdrManagedState } from '../shared/herdr-managed-state.js';
import type { HerdrManagedAutomationOperation, HerdrManagedCapability } from '../shared/herdr-managed-protocol.js';
import { canonicalManagedInvocation, type HerdrManagedBridgeLedger } from '../shared/herdr-managed-bridge.js';

import { GjcBunSdkAdapter } from './gjc-bun-sdk-adapter.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { const value = read(); if (value !== undefined) return value; await tick(); }
  throw new Error('Expected managed automation transition did not arrive.');
}
async function harness(actions: unknown[], loseResponseAt = -1, holdResponseAt = -1, configuredTarget = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'automation-')));
  const socketPath = join(root, 'bridge.sock');
  // The production ledger uses a Node native SQLite addon; keep the adapter in Bun.
  const ledgerCall = (method: keyof HerdrManagedBridgeLedger, args: unknown[]): any => {
    const child = spawnSync('node', ['--import', 'tsx', '--input-type=module', '-e', `
      import { ManagedBridgeLedger } from './server/modules/automation/managed-bridge-ledger.ts';
      const ledger = new ManagedBridgeLedger(process.env.LEDGER_ROOT);
      try { console.log(JSON.stringify(ledger[process.env.LEDGER_METHOD](...JSON.parse(process.env.LEDGER_ARGS)))); }
      finally { ledger.close(); }
    `], { cwd: new URL('..', import.meta.url), env: { ...process.env, LEDGER_ROOT: root, LEDGER_METHOD: method, LEDGER_ARGS: JSON.stringify(args) }, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
  };
  const ledger: HerdrManagedBridgeLedger = {
    reserveDispatch: attempt => ledgerCall('reserveDispatch', [attempt]),
    completeDispatch: (attempt, reservation, response) => ledgerCall('completeDispatch', [attempt, reservation, response]),
    lookupOutcome: attempt => ledgerCall('lookupOutcome', [attempt]),
    fenceUndispatched: attempt => ledgerCall('fenceUndispatched', [attempt]),
  };
  const requests: Record<string, any>[] = [];
  const sockets = new Set<net.Socket>();
  let releaseResponse: (() => void) | undefined;
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      requests.push(request);
      if (requests.length === loseResponseAt) { socket.destroy(); return; }
      const reservation = ledger.reserveDispatch(request.attempt);
      assert.equal(reservation.status, 'reserved');
      if (reservation.status !== 'reserved') return;
      const receipt = ledger.completeDispatch(request.attempt, reservation.reservationId, { ok: true, result: request.invocation.operation === 'authorize' ? { granted: true } : { completedIndex: requests.length } });
      const response = JSON.stringify({ id: request.id, ok: true, result: receipt }) + '\n';
      if (requests.length === holdResponseAt) releaseResponse = () => socket.end(response);
      else socket.end(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  const events: Record<string, any>[] = [];
  const operations = new Map<string, HerdrManagedAutomationOperation>();
  let replay = createHerdrManagedState({ appSessionId: 'app', ownerGeneration: 'generation' });
  const releases = new Set<() => void>();
  let hold = false;
  let failCompletion = false;
  let creations = 0;
  let resolutions = 0;
  let capturedResult: any;
  let ui: any;
  let steers = 0;
  const model = { id: 'managed-model', provider: 'managed-provider' };
  const authStorage = { exportSnapshot: () => ({ credentials: [] }), setRuntimeApiKey() {}, removeRuntimeApiKey() {} };
  const registry = { authStorage, getAll: () => [model], getAvailable: () => [model] };
  const priorKey = process.env.GJC_RUNTIME_API_KEY;
  process.env.GJC_RUNTIME_API_KEY = 'test-key';
  const adapter = new GjcBunSdkAdapter(authStorage as any, registry as any, {
    settings: { cloneForCwd: async () => ({ override() {} }) } as any,
    createSessionFactory: (async (input: any) => {
      creations++;
      assert.equal(input.sdkHostModeSupported, false);
      let permissionMode: string;
      let permissionProvider: unknown;
      const session = {
        isStreaming: false, model, thinkingLevel: 'high',
        setSdkPermissionMode(value: string) { permissionMode = value; },
        setSdkPermissionProvider(value: unknown) { permissionProvider = value; },
        getContextUsage: () => ({ tokens: 0, contextWindow: 100, source: 'exact' }),
        setModelTemporary: async () => {}, setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
        subscribe: () => () => {},
        async prompt(text: string, options?: any) {
          if (options?.streamingBehavior === 'steer') { steers++; return; }
          this.isStreaming = true;
          assert.equal(permissionMode!, 'prompt'); assert.equal(typeof permissionProvider, 'function');
          try {
            const pending = input.automationTools.browser.execute('original-tool', { action: 'act', actions });
            const answer = await ui.select('Independent question', ['continue']);
            assert.equal(answer, 'continue');
            capturedResult = await pending; resolutions++;
          } finally { this.isStreaming = false; }
        },
        async abort() {}, async dispose() {},
      };
      return { session, setToolUIContext(value: any) { ui = value; } };
    }) as any,
  });
  const owner = await adapter.initializeManagedGjcSession('generation:managed', {
    appSessionId: 'app', cwd: root, sessionRoot: root,
    credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'managed-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] },
    automationPolicyRevision: 7, ...(configuredTarget ? { automationTargetContext: 'https://example.test' } : {}),
  }, {
    send(event: any) {
      events.push(event);
      if (event.kind === 'managed.automation') {
        if (replay.providerSessionId === null) replay = applyHerdrManagedEvent(replay, {
          protocolVersion: 1, appSessionId: 'app', ownerGeneration: 'generation', seq: replay.watermark + 1,
          kind: 'managed.session', payload: { providerSessionId: event.payload.identity.provider }, createdAt: 'test',
        });
        replay = applyHerdrManagedEvent(replay, {
          protocolVersion: 1, appSessionId: 'app', ownerGeneration: 'generation', seq: replay.watermark + 1,
          kind: event.kind, payload: event.payload, createdAt: 'test',
        });
        operations.set(event.payload.identity.operationId, event.payload);
      }
    },
    setSessionId() {}, setCredential() {}, setModel() {},
  }, { generation: 'generation', flush: () => {
    const last = events.at(-1);
    if (failCompletion && last?.kind === 'managed.automation' && last.payload.phase === 'completed') return Promise.reject(new Error('fixture completion persistence failure'));
    return hold ? new Promise<void>((resolve) => { releases.add(resolve); }) : Promise.resolve();
  } });
  owner.setAutomationTurn('turn');
  const targetContext = canonicalManagedInvocation({ kind: 'browser-origin', origin: 'https://example.test', tabId: 'tab' });
  const capability = (id: string, op: HerdrManagedAutomationOperation): HerdrManagedCapability => ({
    generation: 'generation', capabilityGeneration: id, ownerConnectionId: 'connection', targetContext, policyRevision: 7, transportLocator: socketPath, transportToken: 'a'.repeat(64),
    bridgeInstanceId: 'bridge', operationIdentity: { ...op.identity, operationId: op.identity.targetContext === targetContext ? op.identity.operationId : randomUUID(), targetContext },
    sourceOperationId: [...operations.values()].find(previous => previous.identity.toolCallId === op.identity.toolCallId && previous.identity.index === op.identity.index)?.identity.operationId ?? op.identity.operationId,
    targetBinding: { kind: 'browser-origin', origin: 'https://example.test', tabId: 'tab' },
  });
  const attach = async (id: string, index?: number) => {
    const op = await phase('waiting_attachment', index);
    return owner.automationControl({ type: 'attach-capability', actionId: `attach-${id}`, capability: capability(id, op) });
  };
  const approve = (op: HerdrManagedAutomationOperation) => owner.automationControl({ type: 'resume-approved', actionId: `approve-${op.identity.operationId}`, identity: op.identity, capabilityGeneration: op.capabilityGeneration!, approvalRequestId: op.approvalRequestId! });
  const phase = (name: string, index?: number) => until(() => [...operations.values()].find((op) => op.phase === name && (index === undefined || op.identity.index === index)));
  const prompt = owner.prompt('automation');
  // Attach a rejection observer before explicit abort tests cancel the original promise.
  void prompt.catch(() => {});
  const ask = await until(() => events.find((e) => e.kind === 'permission_request'));
  assert.equal(owner.resolveApproval(ask.requestId, { allow: true, message: 'continue' }), true);
  return { owner, events, operations, requests, prompt, attach, approve, phase, capability, ledger,
    rejectCompletionAck() { failCompletion = true; },
    holdAck() { hold = true; }, releaseAck() { hold = false; for (const release of releases) release(); releases.clear(); },
    releaseResponse() { releaseResponse?.(); },
    counts: () => ({ creations, resolutions, steers, capturedResult }),
    async close() {
      hold = false; for (const release of releases) release(); releases.clear(); await owner.abort(); await owner.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
      if (priorKey === undefined) delete process.env.GJC_RUNTIME_API_KEY; else process.env.GJC_RUNTIME_API_KEY = priorKey;
    },
  };
}

test('completion persistence failure rejects the original callback without redispatch', async () => {
  const h = await harness([{ verb: 'observe' }]);
  try {
    await h.attach('cap-failure');
    const operation = await h.phase('awaiting_reattach_approval', 0);
    h.rejectCompletionAck();
    await h.approve(operation);
    await assert.rejects(h.prompt, /completion persistence failed/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.owner.operationStatus(operation.identity.operationId), 'completed');
    assert.equal(await h.approve(operation), false);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('actual managed adapter retains original callback and completed multi-action prefix across renewal', async () => {
  const h = await harness([{ verb: 'observe' }, { verb: 'screenshot' }]);
  try {
    const waiting = await h.phase('waiting_attachment', 0);
    assert.equal(h.owner.operationStatus(waiting.identity.operationId), 'in_flight');
    assert.equal(h.requests.length, 0);
    assert.equal(await h.owner.steer('independent steering'), true);
    await h.attach('cap1');
    const first = await h.phase('awaiting_reattach_approval', 0);
    h.holdAck();
    const approval = h.approve(first);
    await tick(); assert.equal(h.requests.length, 0, 'durable ACK precedes transport');
    h.releaseAck(); assert.equal(await approval, true);
    await h.phase('completed', 0);
    await h.phase('waiting_attachment', 1);
    assert.equal(h.requests.length, 1, 'new invocation never inherits an earlier capability');
    await h.attach('cap1', 1);
    const second = await h.phase('awaiting_reattach_approval', 1);
    assert.equal(await h.owner.automationControl({ type: 'detach-capability', actionId: 'wrong-detach', generation: 'generation', capabilityGeneration: 'cap1', ownerConnectionId: 'other' }), false);
    assert.equal(await h.owner.automationControl({ type: 'detach-capability', actionId: 'detach', generation: 'generation', capabilityGeneration: 'cap1', ownerConnectionId: 'connection' }), true);
    assert.equal(await h.approve(second), false);
    await h.attach('cap2');
    const renewed = await h.phase('awaiting_reattach_approval', 1);
    assert.notEqual(renewed.approvalRequestId, second.approvalRequestId);
    for (const identity of [{ ...renewed.identity, argumentsHash: 'b'.repeat(64) }, { ...renewed.identity, policyRevision: 8 }, { ...renewed.identity, targetContext: 'https://other.test' }]) {
      assert.equal(await h.owner.automationControl({ type: 'resume-approved', actionId: 'mismatch', identity, capabilityGeneration: 'cap2', approvalRequestId: renewed.approvalRequestId! }), false);
    }
    for (let index = 1; index < 4; index++) {
      if (index > 1) await h.attach(`cap-${index}`, index);
      await h.approve(await h.phase('awaiting_reattach_approval', index));
    }
    await h.prompt;
    assert.equal(h.requests.length, 4);
    assert.deepEqual(h.counts(), { creations: 1, resolutions: 1, steers: 1, capturedResult: { content: [{ type: 'text', text: JSON.stringify([{ completedIndex: 2 }, { completedIndex: 4 }], null, 2) }], details: [{ completedIndex: 2 }, { completedIndex: 4 }] } });
    assert.ok([...h.operations.values()].filter(op => op.phase === 'completed').every((op) => op.dispatchCount === 1));
    for (const event of h.events.filter((e) => e.kind === 'managed.automation')) {
      assert.equal(JSON.stringify(event.payload).includes('transportToken'), false);
      assert.equal(event.protectedRecords, undefined);
    }
    const chunk = h.events.find((e) => e.kind === 'managed.automation-record-chunk')!;
    assert.equal(JSON.parse(Buffer.from(chunk.data, 'base64').toString()).arguments.sessionId, 'app');
  } finally { await h.close(); }
});

test('lost dispatched result stays unknown, refuses unverified reconciliation and aborts original callback', async () => {
  const h = await harness([{ verb: 'observe' }], 2);
  try {
    await h.attach('cap1');
    await h.approve(await h.phase('awaiting_reattach_approval', 0));
    await h.attach('cap1', 1);
    await h.approve(await h.phase('awaiting_reattach_approval', 1));
    const unknown = await h.phase('outcome_unknown', 1);
    assert.equal(await h.approve(unknown), false);
    assert.equal(await h.owner.automationControl({ type: 'reconcile', actionId: 'unsupported', identity: unknown.identity, originalCapabilityGeneration: 'cap1', currentTransport: { transportLocator: 'unused', transportToken: 'a'.repeat(64), ownerConnectionId: 'connection', bridgeInstanceId: 'bridge' } }), false);
    await tick(); assert.equal(h.requests.length, 2); assert.equal(h.counts().resolutions, 0);
    await h.owner.abort();
    await assert.rejects(h.prompt, /aborted/);
    await h.phase('cancelled', 1);
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

test('pre-send detachment cancels predecessor and retains callback with a fresh approval', async () => {
  const h = await harness([{ verb: 'observe' }], -1, -1, false);
  try {
    const unresolved = await h.phase('waiting_attachment', 0);
    await h.attach('cap1');
    const bound = await h.phase('awaiting_reattach_approval', 0);
    assert.notEqual(bound.identity.operationId, unresolved.identity.operationId);
    assert.equal(h.operations.get(unresolved.identity.operationId)?.phase, 'cancelled');
    h.holdAck();
    const approved = h.approve(bound);
    await tick();
    const detached = h.owner.automationControl({ type: 'detach-capability', actionId: 'detach-before-send', generation: 'generation', capabilityGeneration: 'cap1', ownerConnectionId: 'connection' });
    h.releaseAck();
    assert.equal(await approved, false);
    assert.equal(await detached, true);
    assert.equal(h.requests.length, 0);
    await h.attach('cap2');
    const replacement = await h.phase('awaiting_reattach_approval', 0);
    assert.notEqual(replacement.identity.operationId, bound.identity.operationId);
    await h.approve(replacement);
    await h.attach('cap2', 1);
    await h.approve(await h.phase('awaiting_reattach_approval', 1));
    await h.prompt;
    assert.equal(h.requests.length, 2);
    assert.equal(h.counts().resolutions, 1);
  } finally { await h.close(); }
});

test('late exact bridge receipt reconciles unknown outcome with protected evidence', async () => {
  const h = await harness([{ verb: 'observe' }], -1, 2);
  try {
    await h.attach('cap1');
    await h.approve(await h.phase('awaiting_reattach_approval', 0));
    await h.attach('cap1', 1);
    await h.approve(await h.phase('awaiting_reattach_approval', 1));
    await until(() => h.requests.length === 2 ? true : undefined);
    await h.owner.automationControl({ type: 'detach-capability', actionId: 'detach-after-send', generation: 'generation', capabilityGeneration: 'cap1', ownerConnectionId: 'connection' });
    await h.phase('outcome_unknown', 1);
    h.releaseResponse();
    await h.prompt;
    const completed = await h.phase('completed', 1);
    assert.ok(completed.evidenceRef);
    const chunks = h.events.filter(e => e.kind === 'managed.automation-record-chunk' && e.recordId === completed.evidenceRef);
    const record = JSON.parse(Buffer.concat(chunks.map(e => Buffer.from(e.data, 'base64'))).toString());
    assert.deepEqual(record.evidence.content.response, { ok: true, result: { completedIndex: 2 } });
    assert.deepEqual(record.attempt, h.requests[1].attempt);
    assert.equal(h.requests.length, 2);
  } finally { await h.close(); }
});

for (const explicit of [true, false]) {
  test(`host-issued replacement identity binds exact protected attempt for ${explicit ? 'explicit URL' : 'unresolved'} request`, async () => {
    const h = await harness(explicit ? [{ verb: 'navigate', url: 'https://example.test/page' }] : [{ verb: 'observe' }], -1, -1, false);
    try {
      const waiting = await h.phase('waiting_attachment', 0);
      assert.equal(waiting.identity.targetContext, explicit ? 'https://example.test' : 'unresolved');
      const cap = h.capability('host-cap', waiting);
      assert.notEqual(cap.operationIdentity.operationId, waiting.identity.operationId);
      assert.equal(await h.owner.automationControl({ type: 'attach-capability', actionId: 'host-bind', capability: cap }), true);
      const approved = await h.phase('awaiting_reattach_approval', 0);
      assert.deepEqual(approved.identity, cap.operationIdentity);
      assert.equal(h.operations.get(waiting.identity.operationId)?.phase, 'cancelled');
      assert.equal(await h.approve(approved), true);
      await h.phase('completed', 0);
      assert.deepEqual(h.requests[0].attempt.identity, cap.operationIdentity);
      assert.equal(h.requests[0].attempt.sourceOperationId, waiting.identity.operationId);
      const dispatched = h.events.find(event => event.kind === 'managed.automation' && event.payload.phase === 'dispatching');
      assert.ok(dispatched);
      const chunks = h.events.filter(event => event.kind === 'managed.automation-record-chunk' && event.recordId === dispatched.payload.argumentsRef);
      const record = JSON.parse(Buffer.concat(chunks.map(event => Buffer.from(event.data, 'base64'))).toString());
      assert.deepEqual(record.attempt.identity, cap.operationIdentity);
      assert.equal(record.sourceOperationId, waiting.identity.operationId);
      await h.attach('next-cap', 1);
      await h.approve(await h.phase('awaiting_reattach_approval', 1));
      await h.prompt;
      assert.equal(h.counts().resolutions, 1);
    } finally { await h.close(); }
  });
}

for (const ok of [true, false]) {
  test(`private ledger recovery preserves original callback response ok=${ok}`, async () => {
    const h = await harness([{ verb: 'observe' }], 2);
    try {
      await h.attach('cap1');
      await h.approve(await h.phase('awaiting_reattach_approval', 0));
      await h.attach('cap2', 1);
      await h.approve(await h.phase('awaiting_reattach_approval', 1));
      const unknown = await h.phase('outcome_unknown', 1);
      const attempt = h.requests[1].attempt;
      const reservation = h.ledger.reserveDispatch(attempt);
      assert.equal(reservation.status, 'reserved');
      if (reservation.status !== 'reserved') throw new Error('Expected reservation');
      const receipt = h.ledger.completeDispatch(attempt, reservation.reservationId, ok ? { ok: true, result: { recovered: true } } : { ok: false, error: 'Actual bridge failure' });
      const control = { type: 'reconcile-verified' as const, actionId: 'recovery', identity: unknown.identity, receipt };
      assert.equal(await h.owner.automationControl({ ...control, receipt: { ...receipt, attempt: { ...attempt, requestId: 'forged' } } }), false);
      assert.equal(await h.owner.automationControl(control), true);
      if (ok) {
        await h.prompt;
        assert.deepEqual(h.counts().capturedResult.details, { recovered: true });
        assert.equal(h.counts().resolutions, 1);
      } else {
        await assert.rejects(h.prompt, /Actual bridge failure/);
        assert.equal(h.counts().resolutions, 0);
      }
      assert.equal(h.counts().creations, 1);
      assert.equal(h.requests.length, 2);
      await h.phase('completed', 1);
    } finally { await h.close(); }
  });
}

test('authoritative fence retires attempt, keeps callback, and requires fresh approval; unknown does not retry', async () => {
  const h = await harness([{ verb: 'observe' }], 2);
  try {
    await h.attach('cap1');
    await h.approve(await h.phase('awaiting_reattach_approval', 0));
    await h.attach('cap2', 1);
    await h.approve(await h.phase('awaiting_reattach_approval', 1));
    const old = await h.phase('outcome_unknown', 1);
    const attempt = h.requests[1].attempt;
    const control = { type: 'reconcile-verified' as const, actionId: 'recovery', identity: old.identity };
    assert.equal(await h.owner.automationControl({ ...control, receipt: h.ledger.lookupOutcome(attempt) }), true);
    await tick();
    assert.equal(h.requests.length, 2);
    assert.equal(h.counts().resolutions, 0);
    const fence = h.ledger.fenceUndispatched(attempt);
    assert.equal(fence.status, 'not_dispatched');
    assert.equal(await h.owner.automationControl({ ...control, receipt: fence }), true);
    const replacement = await h.phase('waiting_attachment', 1);
    assert.notEqual(replacement.identity.operationId, old.identity.operationId);
    const retired = h.operations.get(old.identity.operationId)!;
    assert.equal(retired.phase, 'cancelled');
    assert.ok(retired.evidenceRef);
    assert.equal(retired.resultRef, null);
    const evidence = h.events.filter(e => e.kind === 'managed.automation-record-chunk' && e.recordId === retired.evidenceRef);
    assert.deepEqual(JSON.parse(Buffer.concat(evidence.map(e => Buffer.from(e.data, 'base64'))).toString()).receipt, fence);
    assert.equal(await h.owner.automationControl({ ...control, receipt: { status: 'completed', attempt, response: { ok: true, result: 'stale' }, completedAt: new Date().toISOString(), receiptId: 'stale' } }), false);
    assert.equal(h.counts().resolutions, 0);
    assert.equal(await h.approve(old), false);
    await h.attach('cap3', 1);
    await h.approve(await h.phase('awaiting_reattach_approval', 1));
    await h.prompt;
    assert.equal(h.requests.length, 3);
    assert.notEqual(h.requests[1].id, h.requests[2].id);
    assert.equal(h.requests[2].attempt.sourceOperationId, attempt.sourceOperationId);
    assert.equal(h.counts().resolutions, 1);
    assert.equal(h.counts().creations, 1);
  } finally { await h.close(); }
});
