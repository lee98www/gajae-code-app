import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonicalManagedInvocation, hashManagedInvocation, type HerdrManagedBridgeAttempt } from '../../../shared/herdr-managed-bridge.js';
import type { ManagedInstalledApplication } from '../../../shared/herdr-managed-protocol.js';

import { AutomationService } from './automation.service.js';
import { AutomationGrantStore } from './automation-grants.js';
import { ManagedBridgeLedger } from './managed-bridge-ledger.js';

function rpc(service: AutomationService, body: any): Promise<any> {
  const transport = service.managedBridgeCapability()!;
  const id = body.requestId ?? body.attempt.requestId;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(transport.socketPath);
    let buffer = '';
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('RPC timeout')); });
    socket.on('error', reject);
    socket.on('connect', () => socket.write(JSON.stringify({ ...body, id, token: transport.token }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\n')) return;
      socket.destroy(); const response = JSON.parse(buffer.split('\n')[0]);
      if (response.ok) resolve(response.result); else reject(new Error(response.error));
    });
  });
}

test('installed launch binds exact identity, rejects overrides, fences stale attempts and dispatches once', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'installed-launch-')));
  const prior = process.env.GAJAE_AUTOMATION_SOCKET;
  process.env.GAJAE_AUTOMATION_SOCKET = join(root, 'bridge.sock');
  let binding: ManagedInstalledApplication = { kind: 'cua-installed-application', bundleId: 'test.app', canonicalPath: '/Applications/Private App.app', identity: 'a'.repeat(64) };
  let failure = ''; let launches = 0; let checks = 0; let validationAtLaunch = 0;
  let driverFailure = '';
  let replaceOnSessionStart = false;
  const sessionLabels: string[] = [];
  const service = new AutomationService(root, {
    async resolve(bundleId) { assert.equal(bundleId, binding.bundleId); if (failure) throw new Error(failure); return { ...binding }; },
    async revalidate(expected) { checks++; if (failure) throw new Error(failure); assert.deepEqual(expected, binding, 'Installed application binding changed.'); },
  });
  Object.defineProperty(service, 'supported', { value: true });
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore({ get: () => null, set: () => {} }) });
  service.browser.shutdown = async () => {}; service.cua.shutdown = async () => {};
  service.cua.call = async (tool, args, signal) => {
    signal?.throwIfAborted();
    assert.match(String(args.session), /^gajae-/);
    if (tool === 'start_session') {
      sessionLabels.push(String(args.session));
      if (replaceOnSessionStart) {
        replaceOnSessionStart = false;
        binding = { ...binding, identity: 'c'.repeat(64) };
      }
      return driverFailure ? { isError: true, content: [{ type: 'text', text: driverFailure }] } : { ok: true };
    }
    assert.equal(tool, 'launch_app');
    assert.equal(args.bundle_id, binding.bundleId);
    assert.deepEqual(Object.keys(args).sort(), ['bundle_id', 'session']);
    validationAtLaunch = checks;
    launches++;
    return { bundle_id: binding.bundleId, pid: 1234 };
  };
  const invocation = { surface: 'computer', sessionId: 's', tool: 'launch_app', arguments: { bundle_id: 'test.app' } };
  let sequence = 0;
  const resolve = async (value: unknown = invocation) => {
    const sourceOperationId = `source-${++sequence}`;
    const identity = { generation: 'g', provider: 'p', turn: 't', toolCallId: 'tool', index: 0, operationId: sourceOperationId, argumentsHash: await hashManagedInvocation(value), policyRevision: 1, targetContext: 'unresolved' };
    const target = await rpc(service, { type: 'managed-resolve-target', requestId: `resolve-${sequence}`, identity, sourceOperationId, bridgeInstanceId: service.managedBridgeCapability()!.bridgeInstanceId, invocation: value });
    return { identity: { ...identity, operationId: `bound-${sequence}`, targetContext: canonicalManagedInvocation(target.targetBinding) }, sourceOperationId, requestId: `dispatch-${sequence}`, originalCapabilityGeneration: 'cap', bridgeInstanceId: target.bridgeInstanceId, targetBinding: target.targetBinding } as HerdrManagedBridgeAttempt;
  };
  const dispatch = (attempt: HerdrManagedBridgeAttempt, value: unknown = invocation) => rpc(service, { type: 'managed-dispatch', attempt, invocation: value });
  try {
    await service.startBridge();
    for (const args of [{}, { name: 'App' }, { bundle_id: 'bad' }, ...['name', 'path', 'target', 'pid', 'window_id', 'args', 'session'].map(key => ({ bundle_id: 'test.app', [key]: key === 'pid' || key === 'window_id' ? 42 : 'override' }))]) {
      await assert.rejects(resolve({ ...invocation, arguments: args }));
    }
    for (const message of ['Installed application is ambiguous.', 'Installed application not found.']) { failure = message; await assert.rejects(resolve(), new RegExp(message)); }
    failure = '';
    const first = await resolve(); assert.equal(launches, 0); assert.equal(service.grants.has('application', 'test.app', 's'), false);
    binding = { ...binding, identity: 'b'.repeat(64) };
    await assert.rejects(dispatch(first));
    assert.equal((await rpc(service, { type: 'managed-lookup', attempt: first })).status, 'unknown');
    assert.equal((await rpc(service, { type: 'managed-fence', attempt: first })).status, 'not_dispatched');
    assert.equal((await dispatch(first)).status, 'not_dispatched'); assert.equal(launches, 0);
    await assert.rejects(resolve({ ...invocation, operation: 'authorize', payload: { application: 'different.app', scope: 'session' } }));
    // This is the exact grant request produced by ensureComputerAccess after
    // the readonly check returns the resolved bundle identity.
    const authorize = { ...invocation, operation: 'authorize', payload: { application: 'test.app', scope: 'session' } };
    const auth = await resolve(authorize);
    assert.equal(service.grants.has('application', 'test.app', 's'), false);
    assert.equal((await dispatch(auth, authorize)).response.result.granted, true);
    const fresh = await resolve(); assert.notEqual(fresh.identity.targetContext, first.identity.targetContext); assert.equal(launches, 0);
    await assert.rejects(dispatch({ ...fresh, bridgeInstanceId: 'stale' }));
    const checksBeforeLaunch = checks;
    await Promise.all([dispatch(fresh), dispatch(fresh)]);
    assert.equal(launches, 1); assert.ok(validationAtLaunch > checksBeforeLaunch, 'current binding is revalidated before the single launch');
    const completed = await rpc(service, { type: 'managed-lookup', attempt: fresh });
    assert.deepEqual(completed.response, { ok: true, result: { bundleId: 'test.app', launchRequested: true } });
    assert.equal(JSON.stringify(completed.response).includes(binding.canonicalPath), false);
    const changedDuringAdmission = await resolve();
    replaceOnSessionStart = true;
    await assert.rejects(dispatch(changedDuringAdmission), /binding/);
    assert.equal((await rpc(service, { type: 'managed-fence', attempt: changedDuringAdmission })).status, 'not_dispatched');
    assert.equal(launches, 1, 'target changes while driver admission waits cannot launch');
    const admittedLabel = sessionLabels[0];
    const labelsBeforeDenial = sessionLabels.length;
    for (const reason of ['session_revoked', 'session_suspended']) {
      driverFailure = reason;
      const attempt = await resolve();
      await assert.rejects(dispatch(attempt), new RegExp(reason));
      assert.equal((await rpc(service, { type: 'managed-fence', attempt })).status, 'not_dispatched');
      assert.equal(launches, 1, 'driver denial must not fall back to direct OS launch');
    }
    assert.equal(sessionLabels.length, labelsBeforeDenial + 2, 'denied sessions are not silently retried');
    assert.ok(sessionLabels.every(label => label === admittedLabel), 'denied sessions are not silently renamed');
    driverFailure = '';
    const pending = await resolve(); const ledger = new ManagedBridgeLedger(root);
    try { assert.equal(ledger.reserveDispatch(pending).status, 'reserved'); } finally { ledger.close(); }
    assert.equal((await rpc(service, { type: 'managed-lookup', attempt: pending })).status, 'unknown');
    assert.equal((await rpc(service, { type: 'managed-fence', attempt: pending })).status, 'unknown');
    assert.equal((await dispatch(pending)).status, 'unknown'); assert.equal(launches, 1);
  } finally {
    await service.shutdown();
    if (prior === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET; else process.env.GAJAE_AUTOMATION_SOCKET = prior;
    await rm(root, { recursive: true, force: true });
  }
});
