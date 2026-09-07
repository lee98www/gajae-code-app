import assert from 'node:assert/strict';
import test from 'node:test';

import { createHerdrManagedState, applyHerdrManagedEvent } from './herdr-managed-state.js';
import { managedJsonBytes, type HerdrManagedEvent } from './herdr-managed-protocol.js';
import { projectManagedState, projectManagedEvent, pageTransfer, assembleManagedTransfer, acceptManagedSequence, MANAGED_AUTOMATION_UNKNOWN_STATUS, MANAGED_CHAT_MAX_FRAME_BYTES } from './herdr-managed-chat.js';

const initial = () => ({ ...createHerdrManagedState({ appSessionId: 'app', ownerGeneration: 'gen' }), providerSessionId: 'native' });
test('tool pairing keeps partial and rich final details without duplicate tool cards', () => {
  const state = initial();
  state.tools.call = { input: { toolId: 'call', toolName: 'read', toolInput: { path: 'file' }, turnId: 'turn' },
    partial: { content: 'partial', details: { progress: 1 } }, final: { content: 'done', toolUseResult: { diff: '+text' }, details: { images: [{ data: 'image' }] } } };
  const p = projectManagedState(state);
  assert.deepEqual(p.records.map(r => [r.kind, r.toolId]), [['tool_use', 'call'], ['tool_result', 'call']]);
  assert.deepEqual(p.records[1].toolUseResult, { diff: '+text' });
  assert.deepEqual(p.records[1].partial, state.tools.call.partial);
  assert.ok(state.tools.call.final);
  assert.deepEqual(p.records[1].details, state.tools.call.final.details);
});
test('two turns retain separate stable answer and reasoning identities', () => {
  const state = initial();
  state.messages = ['a', 'b'].map((turnId, i) => ({ id: `message-${i + 1}`, turnId, content: 'same answer', reasoning: ['think'], final: true, metadata: {} }));
  const a = projectManagedState(state); const b = projectManagedState(state);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.records.map(r => r.id)).size, 4);
  assert.deepEqual(a.records.map(r => r.turnId), ['a', 'a', 'b', 'b']);
});
test('Unicode and oversized single messages roundtrip through bounded JSON fragment pages', () => {
  const state = initial();
  state.messages.push({ id: 'huge', turnId: 'turn', content: '가😀"\\'.repeat(150000), reasoning: [], final: true, metadata: {} });
  const projection = projectManagedState(state); const frames = pageTransfer(projection);
  assert.ok(frames.length > 3);
  assert.ok(frames.every(f => managedJsonBytes(f) <= MANAGED_CHAT_MAX_FRAME_BYTES));
  assert.deepEqual(assembleManagedTransfer(frames), projection);
  const shuffled = [...frames]; [shuffled[1], shuffled[2]] = [shuffled[2], shuffled[1]];
  assert.throws(() => assembleManagedTransfer(shuffled), /out-of-order/);
  assert.throws(() => assembleManagedTransfer(frames.slice(0, -1)), /Incomplete/);
});
test('request resolution projects current pending state instead of stale journal cards', () => {
  const state = initial();
  state.watermark = 1;
  state.requests.req = { requestId: 'req', generation: 'gen', appSessionId: 'app', providerSessionId: 'native', turnId: 'turn', kind: 'ask', policyRevision: 1, scope: {}, schema: { questions: ['which?'] }, createdAt: '2026-01-01T00:00:00Z' };
  assert.equal(projectManagedState(state).pendingPermissions.length, 1);
  state.requests.req.scope = { status: 'unknown' };
  assert.equal(projectManagedState(state).pendingPermissions[0].status, 'unknown');
  const event: HerdrManagedEvent = { protocolVersion: 1, appSessionId: 'app', ownerGeneration: 'gen', seq: 2, kind: 'managed.request-resolved', payload: { requestId: 'req' }, createdAt: '2026-01-01T00:00:01Z' };
  const live = projectManagedEvent(event, applyHerdrManagedEvent(state, event));
  assert.equal(live.id, 'gen:2'); assert.deepEqual(live.projection.pendingPermissions, []);
});
test('wait, unknown and queue admission are not terminal completion', () => {
  const state = initial();
  for (const lifecycle of ['waiting_attachment', 'awaiting_reattach_approval', 'unknown', 'reserved', 'running'] as const) {
    state.lifecycle = lifecycle;
    const p = projectManagedState(state);
    assert.equal(p.metadata.terminal, false); assert.equal(p.metadata.isProcessing, true);
    assert.ok(!p.records.some(r => r.kind === 'complete'));
  }
  state.lifecycle = 'idle'; assert.equal(projectManagedState(state).metadata.terminal, true);
});
test('automation resume exposes approval binding without protected records or capability bearer', () => {
  const state = initial();
  state.configuration = { model: 'model', capability: { transportToken: 'PRIVATE' }, taggedAnswers: ['PRIVATE'] };
  state.extensions.push({ seq: 1, kind: 'managed.automation.protected', payload: { arguments: 'PRIVATE' } });
  state.automation.op = { identity: { generation: 'gen', provider: 'native', turn: 'turn', toolCallId: 'call', operationId: 'op', index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 2, targetContext: 'browser' }, phase: 'awaiting_reattach_approval', capabilityGeneration: 'cap', approvalRequestId: 'approval', dispatchCount: 0, argumentsRef: 'PRIVATE', resultRef: null, evidenceRef: null };
  const p = projectManagedState(state);
  assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  assert.equal(p.pendingPermissions[0].requestId, 'approval');
  assert.equal((p.pendingPermissions[0].input as { capabilityGeneration: string }).capabilityGeneration, 'cap');
  assert.deepEqual((p.pendingPermissions[0].input as { identity: unknown }).identity, state.automation.op.identity);
});
test('an automation step whose outcome is unknown replaces the runtime activity text and stays interruptible', () => {
  const state = initial();
  state.lifecycle = 'running'; state.activeTurnId = 'turn';
  state.status = { text: 'Using Browser…', tokenBudget: null };
  const identity = { generation: 'gen', provider: 'native', turn: 'turn', toolCallId: 'call', operationId: 'op', index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 0, targetContext: 'browser' };
  state.automation.op = { identity, phase: 'dispatching', capabilityGeneration: 'cap', approvalRequestId: 'approval', dispatchCount: 1, argumentsRef: 'args', resultRef: null, evidenceRef: null };
  assert.equal((projectManagedState(state).metadata.status as { text: string }).text, 'Using Browser…');
  state.automation.op = { ...state.automation.op, phase: 'outcome_unknown', approvalRequestId: null };
  const p = projectManagedState(state);
  assert.equal((p.metadata.status as { text: string }).text, MANAGED_AUTOMATION_UNKNOWN_STATUS);
  assert.equal((p.metadata.status as { automationUnknown?: boolean }).automationUnknown, true);
  assert.equal(p.metadata.terminal, false);
  assert.equal(p.metadata.activeTurnId, 'turn', 'the turn stays interruptible');
  assert.equal(p.pendingPermissions.length, 0, 'nothing is offered for approval: the step is never retried on its own');
  // Once the owner has settled the turn the notice is gone with it.
  state.lifecycle = 'idle'; state.activeTurnId = null;
  assert.equal((projectManagedState(state).metadata.status as { text: string }).text, 'Using Browser…');
});
test('sequence guard rejects stale generations and gaps, ignores duplicates', () => {
  const cursor = { sessionId: 'app', ownerGeneration: 'gen', watermark: 5 };
  assert.equal(acceptManagedSequence(cursor, { appSessionId: 'app', ownerGeneration: 'other' }, 6), 'stale');
  assert.equal(acceptManagedSequence(cursor, { appSessionId: 'app', ownerGeneration: 'gen' }, 5), 'duplicate');
  assert.equal(acceptManagedSequence(cursor, { appSessionId: 'app', ownerGeneration: 'gen' }, 7), 'gap');
  assert.equal(acceptManagedSequence(cursor, { appSessionId: 'app', ownerGeneration: 'gen' }, 6), 'apply');
});

test('installed launch approval shows exact bundle and fingerprint without private installation paths', () => {
  const state = initial();
  const targetContext = JSON.stringify({ kind: 'cua-installed-application', bundleId: 'com.example.App',
    canonicalPath: '/Users/private-owner/Applications/Example.app', identity: 'b'.repeat(64) });
  state.automation.launch = {
    identity: { generation: 'gen', provider: 'native', turn: 'turn', toolCallId: 'call', operationId: 'launch',
      index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 2, targetContext },
    phase: 'awaiting_reattach_approval', capabilityGeneration: 'cap', approvalRequestId: 'launch-approval',
    dispatchCount: 0, argumentsRef: 'private-record', resultRef: null, evidenceRef: null,
  };
  const projection = projectManagedState(state);
  const serialized = JSON.stringify(projection);
  assert.doesNotMatch(serialized, /private-owner|canonicalPath|private-record/);
  assert.match(serialized, /com\.example\.App/);
  assert.ok(serialized.includes('b'.repeat(64)));
  assert.equal(projection.pendingPermissions[0].requestId, 'launch-approval');
  assert.equal(state.automation.launch.identity.targetContext, targetContext, 'host identity is not mutated for display');
});
