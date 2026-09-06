import assert from 'node:assert/strict';
import test from 'node:test';

import { applyHerdrManagedEvent, createHerdrManagedState, pageHerdrManagedState, parseHerdrManagedState, serializeHerdrManagedState, type HerdrManagedState } from './herdr-managed-state.js';
import { herdrManagedAttachResponseSchema, herdrManagedAttachFrameSchema, managedJsonBytes, type HerdrManagedEvent } from './herdr-managed-protocol.js';
import { parseManagedChildRequest } from './herdr-managed-child-protocol.js';

const identity = { appSessionId: 'session', ownerGeneration: 'generation' };
const initial = () => createHerdrManagedState(identity);
function event(state: HerdrManagedState, kind: string, payload: unknown): HerdrManagedEvent {
  return { protocolVersion: 1, ...identity, seq: state.watermark + 1, kind, payload, createdAt: '2026-09-06T00:00:00Z' };
}
function apply(state: HerdrManagedState, kind: string, payload: unknown) {
  return applyHerdrManagedEvent(state, event(state, kind, payload));
}
function entry(actionId: string, text = 'queued') {
  const payload = { text };
  return { command: { protocolVersion: 1, ...identity, actionId, kind: 'followup', payloadHash: 'a'.repeat(64), payload }, inputBytes: managedJsonBytes(payload), admittedSeq: 1, configuration: null };
}

test('pure sequence application dedupes and refuses gaps and foreign owners', () => {
  const state = initial();
  const e = event(state, 'stream_delta', { content: 'hello' });
  const next = applyHerdrManagedEvent(state, e);
  assert.equal(state.messages.length, 0);
  assert.equal(next.messages[0].content, 'hello');
  assert.equal(applyHerdrManagedEvent(next, e), next);
  assert.throws(() => applyHerdrManagedEvent(state, { ...e, seq: 3 }), /gap/);
  assert.throws(() => applyHerdrManagedEvent(next, { ...e, ownerGeneration: 'foreign' }), /identity/);
});

test('complete rich state survives UTF8-safe paged snapshot without journal embedding', () => {
  let state = apply(initial(), 'managed.session', { providerSessionId: 'provider', activeTurnId: 'turn', configuration: { model: 'model', profile: 'profile' } });
  state = apply(state, 'stream_delta', { content: '안녕😀'.repeat(40000) });
  state = apply(state, 'thinking', { content: 'reasoning' });
  state = apply(state, 'tool_use', { toolId: 'tool', toolInput: { path: '/file' } });
  state = apply(state, 'tool_result', { toolId: 'tool', isFinal: false, content: 'partial', details: { nested: [1, 2] } });
  state = apply(state, 'tool_result', { toolId: 'tool', isFinal: true, content: 'final', toolUseResult: { image: 'full-data' } });
  state = apply(state, 'status', { tokenBudget: { used: 77 } });
  state = apply(state, 'managed.request', { requestId: 'ask', generation: 'generation', appSessionId: 'session', providerSessionId: 'provider', turnId: 'turn', kind: 'ask', policyRevision: 7, scope: { project: 'project' }, schema: { options: ['one', 'two'] }, createdAt: 'now' });
  const pages = pageHerdrManagedState(state);
  assert.ok(pages.length > 1);
  assert.deepEqual(parseHerdrManagedState(pages.join('')), state);
  assert.equal(pages.join(''), serializeHerdrManagedState(state));
  for (const [page, chunk] of pages.entries()) {
    assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(new TextEncoder().encode(chunk)), chunk);
    assert.ok(herdrManagedAttachResponseSchema.safeParse({ type: 'snapshot-page', id: 'id', snapshotId: 'snapshot', page, chunk, leaseExpiresAt: 60000 }).success);
  }
  assert.equal(state.tools.tool.partial?.content, 'partial');
  assert.deepEqual(state.tools.tool.final?.toolUseResult, { image: 'full-data' });
  assert.equal(state.requests.ask.policyRevision, 7);
});

test('FIFO admission rejects overflow and paused abort retains every queued action', () => {
  let state = initial();
  for (let i = 0; i < 16; i++) state = apply(state, 'managed.queue', { action: 'enqueue', entry: entry(`a${i}`) });
  assert.throws(() => apply(state, 'managed.queue', { action: 'enqueue', entry: entry('overflow') }), /full/);
  assert.throws(() => apply(state, 'managed.queue', { action: 'dequeue', actionId: 'a1' }), /FIFO/);
  state = apply(state, 'managed.queue', { action: 'pause' });
  assert.throws(() => apply(state, 'managed.queue', { action: 'dequeue', actionId: 'a0' }), /paused/);
  assert.equal(state.queue.entries.length, 16);
  state = apply(state, 'managed.queue', { action: 'resume' });
  state = apply(state, 'managed.queue', { action: 'dequeue', actionId: 'a0' });
  assert.equal(state.queue.entries[0].command.actionId, 'a1');
  assert.throws(() => apply(initial(), 'managed.queue', { action: 'enqueue', entry: entry('large', 'x'.repeat(1024 * 1024)) }), /full/);
});

test('automation cannot dispatch without persisted waiting/approval or blindly retry unknown effect', () => {
  let state = apply(initial(), 'managed.session', { providerSessionId: 'provider' });
  const operation = { identity: { generation: 'generation', provider: 'provider', turn: 'turn', toolCallId: 'tool', operationId: 'operation', index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 1, targetContext: 'origin' }, phase: 'waiting_attachment', capabilityGeneration: null, approvalRequestId: null, dispatchCount: 0, argumentsRef: 'args', resultRef: null, evidenceRef: null };
  assert.throws(() => apply(state, 'managed.automation', { ...operation, phase: 'dispatching', dispatchCount: 1 }), /first persist/);
  state = apply(state, 'managed.automation', operation);
  assert.throws(() => apply(state, 'managed.automation', { ...operation, phase: 'completed', resultRef: 'result' }), /transition/);
  const approved = { ...operation, phase: 'awaiting_reattach_approval', capabilityGeneration: 'cap', approvalRequestId: 'approval' };
  state = apply(state, 'managed.automation', approved);
  state = apply(state, 'managed.automation', { ...approved, phase: 'dispatching', dispatchCount: 1 });
  state = apply(state, 'managed.automation', { ...approved, phase: 'outcome_unknown', dispatchCount: 1 });
  assert.throws(() => apply(state, 'managed.automation', operation), /evidence/);
  state = apply(state, 'managed.automation', { ...operation, evidenceRef: 'verified-not-executed' });
  assert.equal(state.automation.operation.phase, 'waiting_attachment');
});

test('authenticated control requests binding without accepting caller-asserted authority', () => {
  const control = { type: 'bind-capability', actionId: 'action',
    identity: { generation: 'generation', provider: 'provider', turn: 'turn', toolCallId: 'tool', operationId: 'operation', index: 0, argumentsHash: 'a'.repeat(64), policyRevision: 1, targetContext: 'unresolved' },
    currentTransport: { bridgeInstanceId: 'bridge', ownerConnectionId: 'owner', transportLocator: '/private/socket', transportToken: 's'.repeat(32) } };
  assert.equal(herdrManagedAttachFrameSchema.safeParse({ type: 'automation-control', id: 'id', control }).success, true);
  assert.equal(herdrManagedAttachResponseSchema.safeParse({ type: 'automation-control', id: 'id', accepted: true, transport: control.currentTransport }).success, false);
  const frame = { version: 1, generation: 'generation', requestId: 'request', runId: 'run', type: 'automation-control', control };
  assert.deepEqual(parseManagedChildRequest(JSON.stringify(frame)), frame);
  assert.throws(() => parseManagedChildRequest(JSON.stringify({ ...frame, unexpected: true })));
  assert.throws(() => parseManagedChildRequest(JSON.stringify({ ...frame, control: { ...control, extra: true } })));
  assert.equal(herdrManagedAttachResponseSchema.safeParse({ type: 'ready', id: 'id', snapshot: { events: [] } }).success, false);
});

test('SDK wire envelope and canonical journal payload produce identical rich projections', () => {
  const state = apply(initial(), 'managed.session', { providerSessionId: 'provider', activeTurnId: 'turn' });
  const sdk = { kind: 'tool_result', toolId: 'tool', isFinal: false, content: 'partial', toolUseResult: { full: ['one', 'two'] } };
  const envelope = event(state, 'sdk.event', sdk);
  const projected = applyHerdrManagedEvent(state, envelope);
  assert.deepEqual(projected, applyHerdrManagedEvent(state, { ...envelope, kind: sdk.kind, payload: sdk }));
  assert.deepEqual(projected.tools.tool.partial?.toolUseResult, { full: ['one', 'two'] });
  assert.equal(projected.extensions.length, 0);
});

test('reused SDK tool IDs retain prior-turn provenance and current lookup', () => {
  let state = apply(initial(), 'managed.session', { providerSessionId: 'provider', activeTurnId: 'first' });
  state = apply(state, 'tool_use', { toolId: 'reused', toolName: 'read', toolInput: { path: 'first.ts' } });
  const firstSeq = state.watermark;
  state = apply(state, 'tool_result', { toolId: 'reused', isFinal: true, content: 'first result' });
  state = apply(state, 'managed.session', { activeTurnId: 'second' });
  state = apply(state, 'tool_use', { toolId: 'reused', toolName: 'read', toolInput: { path: 'second.ts' } });
  assert.equal(state.tools.reused.input?.turnId, 'second');
  assert.equal(state.tools[`reused@${firstSeq}`].input?.turnId, 'first');
  assert.equal(state.tools[`reused@${firstSeq}`].final?.content, 'first result');
  assert.equal(state.tools[`reused@${firstSeq}`].input?.timestamp, '2026-09-06T00:00:00Z');
});
