import assert from 'node:assert/strict';
import { chmod, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalManagedInvocation, hashManagedInvocation, type HerdrManagedBridgeAttempt, type HerdrManagedBridgeResolveResponse } from '../../../shared/herdr-managed-bridge.js';

import { AutomationService } from './automation.service.js';
import { AutomationGrantStore } from './automation-grants.js';
import { ManagedBridgeLedger } from './managed-bridge-ledger.js';

function rpc(service: AutomationService, body: Record<string, unknown>): Promise<any> {
  const transport = service.managedBridgeCapability()!;
  const id = body.type === 'managed-resolve-target' ? body.requestId : (body.attempt as HerdrManagedBridgeAttempt).requestId;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(transport.socketPath);
    let buffer = '';
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('RPC timeout')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(`${JSON.stringify({ ...body, id, token: transport.token })}\n`));
    socket.on('data', chunk => {
      buffer += chunk.toString();
      if (!buffer.includes('\n')) return;
      socket.destroy();
      const response = JSON.parse(buffer.slice(0, buffer.indexOf('\n')));
      assert.equal(response.id, id);
      if (response.ok) resolve(response.result);
      else reject(new Error(response.error));
    });
  });
}

test('completed receipts release worst-case reservation budget without evicting idempotency', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-ledger-budget-')));
  const ledger = new ManagedBridgeLedger(root);
  const attempts: HerdrManagedBridgeAttempt[] = [];
  try {
    for (let index = 0; index < 80; index++) {
      const attempt: HerdrManagedBridgeAttempt = {
        identity: { generation: 'g', provider: 'p', turn: 't', toolCallId: 'tool', index, operationId: `op-${index}`,
          argumentsHash: 'a'.repeat(64), policyRevision: 0, targetContext: 'context' },
        originalCapabilityGeneration: 'cap', requestId: `request-${index}`, bridgeInstanceId: 'bridge',
        sourceOperationId: `source-${index}`, targetBinding: { kind: 'discovery', operation: 'list_apps' },
      };
      attempts.push(attempt);
      const reservation = ledger.reserveDispatch(attempt);
      assert.equal(reservation.status, 'reserved');
      if (reservation.status !== 'reserved') throw new Error('Expected fresh reservation.');
      ledger.completeDispatch(attempt, reservation.reservationId, { ok: true, result: index });
    }
    for (const attempt of attempts) {
      assert.equal(ledger.reserveDispatch(attempt).status, 'existing');
      assert.equal(ledger.lookupOutcome(attempt).status, 'completed');
    }
  } finally { ledger.close(); await rm(root, { recursive: true, force: true }); }
});

test('managed Unix bridge resolves actual targets and durably arbitrates exact attempts', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-bridge-')));
  const oldSocket = process.env.GAJAE_AUTOMATION_SOCKET;
  process.env.GAJAE_AUTOMATION_SOCKET = join(root, 'bridge.sock');
  let service: AutomationService;
  let active = true;
  let origin = 'https://example.test/private';
  let executions = 0;
  let failure = false;
  let lastBrowserTarget: unknown;
  let lastComputerArgs: unknown;
  const create = async () => {
    const instance = new AutomationService(root);
    Object.defineProperty(instance, 'supported', { value: true });
    Object.defineProperty(instance, 'grants', { value: new AutomationGrantStore({ get: () => null, set: () => {} }) });
    instance.browser.state = async () => ({ sessionId: 's', activeTabId: active ? 'tab-1' : null, tabs: active ? [{ id: 'tab-1', url: origin, title: '', loading: false, canGoBack: false, canGoForward: false }] : [] });
    instance.browser.command = async (_session, _command, _signal, expectedTarget) => { lastBrowserTarget = expectedTarget; executions++; if (failure) throw new Error('executor failed'); return { value: 42 }; };
    instance.browser.open = async (_session, _payload, _signal, expectedTarget) => { lastBrowserTarget = expectedTarget; return { opened: true }; };
    instance.browser.shutdown = async () => {};
    instance.cua.shutdown = async () => {};
    instance.cua.call = async tool => tool === 'list_windows' ? { windows: [{ window_id: 7, pid: 42 }] } : { apps: [{ pid: 42, bundle_id: 'real.app', name: 'Actual App' }] };
    await instance.startBridge();
    return instance;
  };
  const invocation = { surface: 'browser', sessionId: 's', operation: 'command', payload: { command: { action: 'observe' } } };
  let sequence = 0;
  const resolve = async (value: unknown = invocation) => {
    const sourceOperationId = `source-${++sequence}`;
    const identity = { generation: 'g', provider: 'p', turn: 't', toolCallId: 'tool', index: 0, operationId: sourceOperationId, argumentsHash: await hashManagedInvocation(value), policyRevision: 1, targetContext: 'unresolved' };
    return rpc(service, { type: 'managed-resolve-target', requestId: `resolve-${sequence}`, identity, sourceOperationId, bridgeInstanceId: service.managedBridgeCapability()!.bridgeInstanceId, invocation: value }) as Promise<HerdrManagedBridgeResolveResponse>;
  };
  const attempt = (target: HerdrManagedBridgeResolveResponse): HerdrManagedBridgeAttempt => ({ identity: { ...target.identity, operationId: `bound-${sequence}`, targetContext: canonicalManagedInvocation(target.targetBinding) }, originalCapabilityGeneration: 'cap', requestId: `dispatch-${sequence}`, bridgeInstanceId: target.bridgeInstanceId, sourceOperationId: target.sourceOperationId, targetBinding: target.targetBinding });
  try {
    service = await create();
    const target = await resolve();
    assert.deepEqual(target.targetBinding, { kind: 'browser-origin', origin: 'https://example.test', tabId: 'tab-1' });
    assert.equal(executions, 0);
    const first = attempt(target);
    await assert.rejects(rpc(service, { type: 'managed-dispatch', attempt: first, invocation: { ...invocation, sessionId: 'other' } }), /hash mismatch/);
    await assert.rejects(rpc(service, { type: 'managed-dispatch', attempt: { ...first, identity: { ...first.identity, targetContext: 'claimed' } }, invocation }), /binding mismatch/);
    origin = 'https://changed.test';
    await assert.rejects(rpc(service, { type: 'managed-dispatch', attempt: first, invocation }), /target changed/);
    origin = 'https://example.test/private';
    const results = await Promise.all([rpc(service, { type: 'managed-dispatch', attempt: first, invocation }), rpc(service, { type: 'managed-dispatch', attempt: first, invocation })]);
    assert.equal(executions, 1);
    assert.deepEqual(lastBrowserTarget, { tabId: 'tab-1', origin: 'https://example.test' });
    assert.ok(results.some(result => result.status === 'completed'));
    const completed = await rpc(service, { type: 'managed-lookup', attempt: first });
    assert.deepEqual(completed.response, { ok: true, result: { value: 42 } });
    await service.shutdown();
    service = await create();
    assert.notEqual(service.managedBridgeCapability()!.bridgeInstanceId, first.bridgeInstanceId);
    assert.deepEqual(await rpc(service, { type: 'managed-lookup', attempt: first }), completed);
    assert.deepEqual(await rpc(service, { type: 'managed-dispatch', attempt: first, invocation }), completed);
    assert.equal(executions, 1);

    const fenced = attempt(await resolve());
    assert.equal((await rpc(service, { type: 'managed-lookup', attempt: fenced })).status, 'unknown');
    assert.equal((await rpc(service, { type: 'managed-fence', attempt: fenced })).status, 'not_dispatched');
    assert.equal((await rpc(service, { type: 'managed-dispatch', attempt: fenced, invocation })).status, 'not_dispatched');
    assert.equal(executions, 1);

    const failed = attempt(await resolve());
    failure = true;
    const failedResult = await rpc(service, { type: 'managed-dispatch', attempt: failed, invocation });
    assert.deepEqual(failedResult.response, { ok: false, error: 'executor failed' });
    await service.shutdown();
    service = await create();
    assert.deepEqual(await rpc(service, { type: 'managed-lookup', attempt: failed }), failedResult);
    failure = false;

    const pending = attempt(await resolve());
    const ledger = new ManagedBridgeLedger(root);
    assert.equal(ledger.reserveDispatch(pending).status, 'reserved');
    ledger.close();
    assert.equal((await rpc(service, { type: 'managed-lookup', attempt: pending })).status, 'unknown');
    assert.equal((await rpc(service, { type: 'managed-fence', attempt: pending })).status, 'unknown');
    assert.equal((await rpc(service, { type: 'managed-dispatch', attempt: pending, invocation })).status, 'unknown');
    assert.equal(executions, 2);

    const raced = attempt(await resolve());
    const beforeRace = executions;
    const race = await Promise.all([
      rpc(service, { type: 'managed-dispatch', attempt: raced, invocation }),
      rpc(service, { type: 'managed-fence', attempt: raced }),
    ]);
    const raceOutcome = await rpc(service, { type: 'managed-lookup', attempt: raced });
    assert.ok(['completed', 'not_dispatched'].includes(raceOutcome.status));
    assert.equal(executions - beforeRace, raceOutcome.status === 'completed' ? 1 : 0);
    assert.ok(race.every(result => result.status !== 'not_dispatched') || raceOutcome.status === 'not_dispatched');

    const navigate = { surface: 'browser', sessionId: 's', operation: 'command', payload: { command: { action: 'navigate', url: 'https://destination.test/path' } } };
    await rpc(service, { type: 'managed-dispatch', attempt: attempt(await resolve(navigate)), invocation: navigate });
    assert.deepEqual(lastBrowserTarget, { tabId: 'tab-1', origin: 'https://destination.test' });

    active = false;
    await assert.rejects(resolve(), /unresolved/);
    const open = { surface: 'browser', sessionId: 's', operation: 'open', payload: {} };
    const openTarget = await resolve(open);
    assert.deepEqual(openTarget.targetBinding, { kind: 'session-management', operation: 'open', sessionId: 's' });
    await rpc(service, { type: 'managed-dispatch', attempt: attempt(openTarget), invocation: open });
    assert.deepEqual(lastBrowserTarget, { tabId: null });
    service.browser.state = async () => { throw new Error('session_not_found: Open the browser session first.'); };
    const firstOpen = await resolve(open);
    assert.deepEqual(firstOpen.targetBinding, { kind: 'session-management', operation: 'open', sessionId: 's' });
    await rpc(service, { type: 'managed-dispatch', attempt: attempt(firstOpen), invocation: open });
    const firstAuthorize = await resolve({ surface: 'browser', sessionId: 's', operation: 'authorize', payload: { url: 'https://first.test' } });
    assert.deepEqual(firstAuthorize.targetBinding, { kind: 'browser-origin', origin: 'https://first.test', tabId: 'no-active-tab' });
    await assert.rejects(resolve(), /session_not_found/);
    service.browser.state = async () => { throw new Error('Browser sidecar disconnected.'); };
    await assert.rejects(resolve(open), /disconnected/);
    const click = { surface: 'computer', sessionId: 's', tool: 'click', arguments: { target: { window_id: 7 }, name: 'ignored label' } };
    const clickTarget = await resolve(click);
    const inspectComputer = service.cua.call;
    service.cua.call = async (tool, args, signal) => {
      if (tool === 'start_session') return { ok: true };
      if (tool === 'click') {
        const { session, ...target } = args;
        assert.match(String(session), /^gajae-/);
        lastComputerArgs = target;
        return {};
      }
      return inspectComputer(tool, args, signal);
    };
    await rpc(service, { type: 'managed-dispatch', attempt: attempt(clickTarget), invocation: click });
    assert.deepEqual(lastComputerArgs, { pid: 42, window_id: 7, target: { pid: 42, window_id: 7 } });
    const computer = await resolve({ surface: 'computer', sessionId: 's', operation: 'authorize', tool: 'click', arguments: { window_id: 7 }, payload: { application: 'forged.app', scope: 'session' } });
    assert.deepEqual(computer.targetBinding, { kind: 'cua-application', pid: 42, windowId: 7, bundleId: 'real.app' });
    assert.equal(service.grants.list('s').session.length, 0);
    service.cua.call = async tool => tool === 'list_windows' ? { windows: [{ window_id: 7, pid: 99 }] } : { apps: [{ pid: 99, bundle_id: 'other.app' }] };
    await assert.rejects(rpc(service, {
      type: 'managed-dispatch', attempt: attempt(computer),
      invocation: { surface: 'computer', sessionId: 's', operation: 'authorize', tool: 'click', arguments: { window_id: 7 }, payload: { application: 'forged.app', scope: 'session' } },
    }), /target changed/);
    await assert.rejects(resolve({ surface: 'computer', sessionId: 's', tool: 'move_cursor', arguments: {} }), /unresolved/);
  } finally {
    await service!.shutdown();
    if (oldSocket === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET;
    else process.env.GAJAE_AUTOMATION_SOCKET = oldSocket;
    await rm(root, { recursive: true, force: true });
  }
});

test('managed ledger rejects unsafe permissions and symlink storage', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'managed-ledger-')));
  try {
    const ledger = new ManagedBridgeLedger(root);
    ledger.close();
    await chmod(join(root, 'managed-bridge', 'attempts.sqlite'), 0o644);
    assert.throws(() => new ManagedBridgeLedger(root), /Unsafe/);
    await chmod(join(root, 'managed-bridge', 'attempts.sqlite'), 0o600);
    await symlink(join(root, 'managed-bridge'), join(root, 'linked'));
    assert.throws(() => new ManagedBridgeLedger(join(root, 'linked')), /Unsafe/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
