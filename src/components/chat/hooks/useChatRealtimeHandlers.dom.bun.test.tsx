import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, render } from '@testing-library/react';
import { createElement, useRef } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import type { SessionStore } from '../../../stores/useSessionStore';
import { pageTransfer, type ManagedChatProjection } from '../../../../shared/herdr-managed-chat';

import { useChatRealtimeHandlers } from './useChatRealtimeHandlers';

/*
 * The stream frames as the transcript sees them. `stream_delta` accumulates
 * (debounced into one streaming row), `stream_end` finalizes it. The whole
 * answer rides on `stream_end`, so a viewer that received no deltas - the
 * SDK did not stream, or the tab joined the turn late - still ends the turn
 * with the answer on screen rather than waiting for a reload.
 */

afterEach(cleanup);

type Call = [string, ...unknown[]];

function fakeStore(calls: Call[]): SessionStore {
  const record = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); };
  return {
    updateStreaming: record('updateStreaming'),
    finalizeStreaming: record('finalizeStreaming'),
    appendRealtime: record('appendRealtime'),
    replaceManagedProjection: record('replaceManagedProjection'),
    refreshFromServer: async (...args: unknown[]) => { calls.push(['refreshFromServer', ...args]); },
  } as unknown as SessionStore;
}

function Probe({ emit, store, calls }: { emit: { current: ((event: ServerEvent) => void) | null }; store: SessionStore; calls: Call[] }) {
  const streamTimerRef = useRef<number | null>(null);
  const accumulatedStreamRef = useRef('');
  const lastSeqRef = useRef(new Map<string, number>());
  const statusCheckSentAtRef = useRef(new Map<string, number>());
  useChatRealtimeHandlers({
    subscribe: (listener) => { emit.current = listener; return () => { emit.current = null; }; },
    provider: 'gjc',
    selectedSession: { id: 'visible' } as never,
    currentSessionId: 'visible',
    setTokenBudget: (budget) => { calls.push(['usage', budget]); },
    setSessionState: (update) => { calls.push(['config', update(null)]); },
    onSessionProcessing: (id, options) => { calls.push(['processing', id, options]); },
    onSessionIdle: (id) => { calls.push(['idle', id]); },
    onWebSocketReconnect: () => { calls.push(['resubscribe']); },
    onManagedActionResult: (actionId, accepted) => { calls.push(['managedAction', actionId, accepted]); },
    pendingPermissionRequests: [],
    setPendingPermissionRequests: (requests) => { calls.push(['permissions', requests]); },
    streamTimerRef,
    accumulatedStreamRef,
    lastSeqRef,
    statusCheckSentAtRef,
    sessionStore: store,
  });
  return null;
}

function mount() {
  const calls: Call[] = [];
  const emit: { current: ((event: ServerEvent) => void) | null } = { current: null };
  render(createElement(Probe, { emit, store: fakeStore(calls), calls }));
  assert.ok(emit.current, 'the hook subscribed');
  return { calls, send: (event: ServerEvent) => act(() => { emit.current?.(event); }) };
}

test('an answer that arrives whole on stream_end is shown without any delta', () => {
  const { calls, send } = mount();
  send({ kind: 'stream_end', sessionId: 'visible', content: 'The moon is far.' } as ServerEvent);

  assert.deepEqual(calls, [
    ['updateStreaming', 'visible', 'The moon is far.', 'gjc'],
    ['finalizeStreaming', 'visible'],
  ]);
});

test('stream_end outranks the deltas a late viewer accumulated', async () => {
  const { calls, send } = mount();
  send({ kind: 'stream_delta', sessionId: 'visible', content: 'is far.' } as ServerEvent);
  await new Promise((resolve) => setTimeout(resolve, 150));
  send({ kind: 'stream_end', sessionId: 'visible', content: 'The moon is far.' } as ServerEvent);

  assert.deepEqual(calls, [
    ['updateStreaming', 'visible', 'is far.', 'gjc'],
    ['updateStreaming', 'visible', 'The moon is far.', 'gjc'],
    ['finalizeStreaming', 'visible'],
  ]);
});

test('an empty stream_end after no deltas finalizes nothing', () => {
  const { calls, send } = mount();
  send({ kind: 'stream_end', sessionId: 'visible', content: '' } as ServerEvent);

  assert.deepEqual(calls, [['finalizeStreaming', 'visible']]);
});

test('managed receipts resolve action IDs without declaring a waiting turn complete', () => {
  const { calls, send } = mount();
  send({ kind: 'managed_command_result', sessionId: 'visible', actionId: 'accepted',
    result: { ok: true, receipt: { state: 'admitted' } } });
  send({ kind: 'managed_command_result', sessionId: 'visible', actionId: 'uncertain',
    result: { ok: false, receipt: { state: 'unknown' }, error: 'Outcome unknown' } });
  send({ kind: 'managed_command_result', sessionId: 'visible', actionId: 'malformed',
    result: { ok: true, receipt: {} } });
  assert.deepEqual(calls.filter(call => call[0] === 'managedAction'), [['managedAction', 'accepted', true]]);
  assert.equal(calls.some(call => call[0] === 'idle'), false);
  assert.equal(calls.some(call => call[0] === 'permissions'), false);
});

function projection(sessionId = 'visible', generation = 'g1', watermark = 1): ManagedChatProjection {
  return {
    records: [{ id: `${generation}:tool`, sessionId, ownerGeneration: generation, providerSessionId: 'p', turnId: 't',
      provider: 'gjc', timestamp: '', kind: 'tool_result', toolId: 'tool', isFinal: false,
      toolResult: { content: 'partial', isError: false, toolUseResult: { diff: 'rich' } } }],
    pendingPermissions: [{ requestId: 'r', sessionId, generation, providerSessionId: 'p', turnId: 't',
      policyRevision: 7, createdAt: '', status: 'pending', toolName: 'ExitPlanMode', input: {}, context: {}, requestKind: 'permission' }],
    metadata: { kind: 'managed_ui_status', sessionId, ownerGeneration: generation, providerSessionId: 'p', watermark,
      lifecycle: 'waiting_attachment', activeTurnId: 't', title: null, isProcessing: true, terminal: false,
      usage: { tokens: watermark }, configuration: { model: sessionId }, status: null, turns: {},
      queue: { paused: false, count: 0, actionIds: [] }, automation: [] },
  };
}

test('a same-watermark managed_ui_status frame replaces the status text of an active viewer without a new snapshot', () => {
  const { calls, send } = mount();
  pageTransfer(projection()).forEach(frame => send(frame));
  const before = calls.filter(call => call[0] === 'processing').length;
  const waiting = { ...projection().metadata, status: { text: 'Automation step waiting for its target: the browser session for this conversation is not open in the app yet; open it in the Browser panel or with an open step.', automationWaiting: true } };
  send(waiting as unknown as ServerEvent);
  const shown = calls.filter(call => call[0] === 'processing').slice(before).at(-1)?.[2] as { statusText?: string } | undefined;
  assert.equal(shown?.statusText, waiting.status.text, 'the exact reason is shown at the unchanged watermark');
  assert.equal(calls.filter(c => c[0] === 'replaceManagedProjection').length, 1, 'no second projection replacement');
  // Cleared the same way once the step is bound.
  send({ ...projection().metadata, status: { text: 'Using Browser…' } } as unknown as ServerEvent);
  assert.equal((calls.filter(call => call[0] === 'processing').at(-1)?.[2] as { statusText?: string }).statusText, 'Using Browser…');
  // A frame for another generation or watermark is ignored.
  send({ ...projection('visible', 'g1', 2).metadata, status: { text: 'stale', automationWaiting: true } } as unknown as ServerEvent);
  send({ ...projection('visible', 'g2', 1).metadata, status: { text: 'stale', automationWaiting: true } } as unknown as ServerEvent);
  assert.equal((calls.filter(call => call[0] === 'processing').at(-1)?.[2] as { statusText?: string }).statusText, 'Using Browser…');
});

test('execution mode is explicitly hydrated and bound to the visible conversation', () => {
  const { calls, send } = mount();
  send({ kind: 'chat_subscribed', sessionId: 'other', isProcessing: false } as ServerEvent);
  assert.equal(calls.some(call => call[0] === 'config'), false);
  send({ kind: 'chat_subscribed', sessionId: 'visible', isProcessing: false } as ServerEvent);
  assert.deepEqual(calls.find(call => call[0] === 'config')?.[1], { sessionId: 'visible', managed: false });
  pageTransfer(projection()).forEach(frame => send(frame));
  const configured = calls.filter(call => call[0] === 'config').at(-1)?.[1] as Record<string, unknown>;
  assert.equal(configured.sessionId, 'visible');
  assert.equal(configured.managed, true);
});

test('managed transfers replace atomically, isolate usage, retain rich results and recover sequence gaps', () => {
  const { calls, send } = mount();
  const emit = (frame: unknown) => send(frame as ServerEvent);
  const first = pageTransfer(projection());
  emit(first[0]); emit(first[1]); emit(first[1]);
  assert.equal(calls.length, 0);
  emit(first.at(-1));
  assert.equal(calls.filter(c => c[0] === 'replaceManagedProjection').length, 1);
  assert.equal(calls.some(c => c[0] === 'idle'), false);
  assert.deepEqual(calls.find(c => c[0] === 'permissions')?.[1], [{ ...projection().pendingPermissions[0], receivedAt: (calls.find(c => c[0] === 'permissions')?.[1] as Array<{ receivedAt: Date }>)[0].receivedAt }]);
  pageTransfer(projection('other')).forEach(emit);
  assert.deepEqual(calls.filter(c => c[0] === 'usage'), [['usage', { tokens: 1 }]]);
  const final = projection('visible', 'g1', 2);
  final.records[0].isFinal = true;
  final.records[0].toolResult = { content: 'final', isError: false, toolUseResult: { diff: 'complete' } };
  final.pendingPermissions = [];
  const live = { kind: 'managed_live_event', id: 'g1:2', sessionId: 'visible', ownerGeneration: 'g1', seq: 2, projection: final };
  emit(live); emit(live);
  assert.deepEqual(calls.filter(c => c[0] === 'replaceManagedProjection').at(-1)?.[2], final.records);
  assert.deepEqual(calls.filter(c => c[0] === 'permissions').at(-1)?.[1], []);
  emit({ ...live, seq: 4 }); emit({ ...live, seq: 5 });
  assert.equal(calls.filter(c => c[0] === 'resubscribe').length, 1);
  pageTransfer(projection('visible', 'g2')).forEach(emit);
  emit(live);
  assert.equal((calls.filter(c => c[0] === 'replaceManagedProjection').at(-1)?.[3] as { ownerGeneration: string }).ownerGeneration, 'g2');
});

test('out of order and mismatched transfer frames cannot expose partial history', () => {
  const { calls, send } = mount();
  const frames = pageTransfer(projection());
  const emit = (frame: unknown) => send(frame as ServerEvent);
  emit(frames[0]);
  emit({ ...frames[1], ownerGeneration: 'wrong' });
  assert.equal(calls.length, 0);
  emit({ ...frames[1], page: 1 });
  assert.deepEqual(calls, [['resubscribe']]);
  emit(frames.at(-1));
  assert.equal(calls.some(c => c[0] === 'replaceManagedProjection'), false);
  frames.forEach(emit);
  assert.equal(calls.filter(c => c[0] === 'replaceManagedProjection').length, 1);
});
