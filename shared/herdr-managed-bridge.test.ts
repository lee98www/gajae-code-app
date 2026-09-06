import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalManagedInvocation, hashManagedInvocation, verifyManagedBridgeInvocation, verifyManagedBridgeReceipt, verifyManagedBridgeTarget, parseManagedBridgeRequest, herdrManagedBridgeReceiptSchema, type HerdrManagedBridgeAttempt } from './herdr-managed-bridge.js';
import { HERDR_MANAGED_MAX_FRAME_BYTES, herdrManagedAutomationControlSchema } from './herdr-managed-protocol.js';
import { herdrManagedChildAutomationControlSchema } from './herdr-managed-child-protocol.js';

const invocation = { tool: 'browser_click', args: { selector: '#submit', nested: { z: 2, a: 1 } } };
async function attempt(): Promise<HerdrManagedBridgeAttempt> {
  return { identity: { generation: 'generation', provider: 'gjc', turn: 'turn', toolCallId: 'call', operationId: 'operation', index: 0, argumentsHash: await hashManagedInvocation(invocation), policyRevision: 1, targetContext: 'https://example.com' }, originalCapabilityGeneration: 'capability', requestId: 'fixed', bridgeInstanceId: 'bridge', sourceOperationId: 'source', targetBinding: { kind: 'browser-origin', origin: 'https://example.com', tabId: 'tab' } };
}
test('canonical invocation normalizes JSON and sorts recursively without locale dependence', async () => {
  assert.equal(canonicalManagedInvocation({ z: undefined, b: [undefined, { z: 1, A: 2, a: 3 }], a: 1 }), '{"a":1,"b":[null,{"A":2,"a":3,"z":1}]}');
  assert.equal(await hashManagedInvocation({ a: 1, b: 2 }), await hashManagedInvocation({ b: 2, a: 1 }));
  const a = await attempt();
  await verifyManagedBridgeInvocation(a.identity, invocation);
  await assert.rejects(verifyManagedBridgeInvocation(a.identity, { ...invocation, tool: 'browser_Click' }));
  await assert.rejects(verifyManagedBridgeInvocation({ ...a.identity, argumentsHash: a.identity.argumentsHash.toUpperCase() }, invocation));
});
test('receipts validate the entire original dispatch tuple, including case and target selector', async () => {
  const a = await attempt();
  const receipt = { status: 'completed', attempt: a, response: { ok: false, error: 'Denied' }, completedAt: '2026-09-06T00:00:00Z', receiptId: 'receipt' };
  assert.deepEqual(verifyManagedBridgeReceipt(receipt, a), receipt);
  for (const key of ['originalCapabilityGeneration', 'requestId', 'bridgeInstanceId', 'sourceOperationId'] as const) assert.throws(() => verifyManagedBridgeReceipt(receipt, { ...a, [key]: `${a[key]}X` }));
  for (const key of Object.keys(a.identity) as (keyof typeof a.identity)[]) {
    const value = a.identity[key];
    assert.throws(() => verifyManagedBridgeReceipt(receipt, { ...a, identity: { ...a.identity, [key]: typeof value === 'number' ? value + 1 : `${value}X` } }));
  }
  assert.throws(() => verifyManagedBridgeReceipt(receipt, { ...a, targetBinding: { ...a.targetBinding, tabId: 'other' } } as HerdrManagedBridgeAttempt));
});
test('unknown cannot claim completion and non-dispatch requires a durable fence tuple', async () => {
  const a = await attempt();
  assert.equal(verifyManagedBridgeReceipt({ status: 'unknown', attempt: a }, a).status, 'unknown');
  assert.equal(herdrManagedBridgeReceiptSchema.safeParse({ status: 'unknown', attempt: a, response: { ok: true, result: null } }).success, false);
  assert.equal(herdrManagedBridgeReceiptSchema.safeParse({ status: 'completed', attempt: a }).success, false);
  assert.equal(herdrManagedBridgeReceiptSchema.safeParse({ status: 'not_dispatched', attempt: a }).success, false);
  assert.equal(verifyManagedBridgeReceipt({ status: 'not_dispatched', attempt: a, fenceId: 'fence', fencedAt: '2026-09-06T00:00:00Z' }, a).status, 'not_dispatched');
});
test('external controls cannot upload proofs or private verified receipts', async () => {
  const a = await attempt();
  const currentTransport = { transportLocator: '/private/socket', transportToken: 's'.repeat(32), ownerConnectionId: 'owner', bridgeInstanceId: 'current' };
  const trigger = { type: 'reconcile', actionId: 'action', identity: a.identity, originalCapabilityGeneration: a.originalCapabilityGeneration, currentTransport };
  assert.equal(herdrManagedAutomationControlSchema.safeParse(trigger).success, true);
  for (const extra of [{ evidenceRef: 'proof' }, { resultRef: 'result' }, { outcome: 'completed' }]) assert.equal(herdrManagedAutomationControlSchema.safeParse({ ...trigger, ...extra }).success, false);
  const privateControl = { type: 'reconcile-verified', actionId: 'action', identity: a.identity, receipt: { status: 'unknown', attempt: a } };
  assert.equal(herdrManagedAutomationControlSchema.safeParse(privateControl).success, false);
  assert.equal(herdrManagedChildAutomationControlSchema.safeParse(privateControl).success, true);
  assert.equal(herdrManagedChildAutomationControlSchema.safeParse({ ...privateControl, identity: { ...a.identity, operationId: 'other' } }).success, false);
  assert.equal(herdrManagedAutomationControlSchema.safeParse({ type: 'bind-capability', actionId: 'action', identity: a.identity, currentTransport, targetContext: 'claimed' }).success, false);
});
test('target resolution binds protected invocation, exact identity and current instance; framing is bounded', async () => {
  const a = await attempt();
  const request = { type: 'managed-resolve-target' as const, requestId: a.requestId, identity: a.identity, sourceOperationId: a.sourceOperationId, bridgeInstanceId: a.bridgeInstanceId, invocation };
  const response = { type: 'managed-target', requestId: a.requestId, identity: a.identity, sourceOperationId: a.sourceOperationId, bridgeInstanceId: a.bridgeInstanceId, invocationHash: a.identity.argumentsHash, targetBinding: a.targetBinding };
  assert.deepEqual(await verifyManagedBridgeTarget(response, request), response);
  await assert.rejects(verifyManagedBridgeTarget({ ...response, bridgeInstanceId: 'other' }, request));
  await assert.rejects(verifyManagedBridgeTarget(response, { ...request, invocation: { tool: 'other' } }));
  assert.throws(() => parseManagedBridgeRequest(JSON.stringify({ ...request, extra: true })));
  assert.throws(() => parseManagedBridgeRequest(' '.repeat(HERDR_MANAGED_MAX_FRAME_BYTES + 1)));
});
