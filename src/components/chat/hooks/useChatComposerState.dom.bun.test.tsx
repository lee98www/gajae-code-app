import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';

import type { Project, ProjectSession } from '../../../types/app';
import { draftInputKey, readQueuedMessages, writeQueuedMessages } from '../utils/chatStorage';

import { useChatComposerState } from './useChatComposerState';

/*
 * Drafts belong to a conversation, and the wiring that makes that true lives
 * in effects: which key is read when the session in view changes, and which
 * key the next keystroke is written under. A static render cannot reach either,
 * which is why the original bug - opening a second conversation and finding the
 * first one's unsent text, then overwriting it - survived a green suite.
 */

const project: Project = {
  projectId: 'proj-1',
  displayName: 'Project one',
  fullPath: '/repos/project-one',
  origin: 'explicit',
};

const session = (id: string): ProjectSession => ({ id, summary: `Session ${id}` } as ProjectSession);

const baseArgs = {
  managedSession: false,
  selectedProject: project,
  selectedSession: null as ProjectSession | null,
  currentSessionId: null as string | null,
  gjcModel: 'gjc/test-model',
  isLoading: false,
  canAbortSession: false,
  tokenBudget: null,
  sendMessage: (_message: unknown): void => undefined,
  scrollToBottom: () => undefined,
  addMessage: (_message: unknown): void => undefined,
  setIsUserScrolledUp: () => undefined,
  setPendingPermissionRequests: () => undefined,
};

const composer = (overrides: Partial<typeof baseArgs> = {}) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderHook(
    (props: Partial<typeof baseArgs>) => useChatComposerState({ ...baseArgs, ...props } as never),
    { initialProps: overrides, wrapper: ({ children }: PropsWithChildren) => <QueryClientProvider client={client}>{children}</QueryClientProvider> },
  );
};

// The composer fetches slash commands and mentionable files on mount. There is
// no server here, and a real socket error is noise that has nothing to do with
// what these tests assert.
globalThis.fetch = (async () => new Response('[]', {
  status: 200,
  headers: { 'content-type': 'application/json' },
})) as typeof fetch;

afterEach(() => {
  cleanup();
  localStorage.clear();
});

test('typing in one session does not reach another session in the same project', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-b') });
  act(() => { view.result.current.setInput('draft for B'); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), 'draft for A');
  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-b')), 'draft for B');
});

test('switching back to a session restores that session own draft', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-b') });
  act(() => { view.result.current.setInput('draft for B'); });
  view.rerender({ selectedSession: session('session-a') });

  assert.equal(view.result.current.input, 'draft for A');
});

test('opening a session with no draft shows an empty composer, not the last one', () => {
  // The regression in its most visible form: the previous conversation's text
  // appearing in a composer that should be blank.
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  view.rerender({ selectedSession: session('session-fresh') });

  assert.equal(view.result.current.input, '');
});

test('a draft typed before any session exists is loaded back into the same chat', () => {
  const view = composer({ selectedSession: null, currentSessionId: null });

  act(() => { view.result.current.setInput('typed before the session existed'); });

  assert.equal(
    localStorage.getItem(draftInputKey('proj-1')),
    'typed before the session existed',
    'a chat with no session yet keeps its text in the project slot',
  );

  view.unmount();
  const reopened = composer({ selectedSession: null, currentSessionId: null });
  assert.equal(reopened.result.current.input, 'typed before the session existed');
});

test('an established session leaves the unstarted chat draft where it is', () => {
  // Both slots exist at once, and they are not the same conversation.
  localStorage.setItem(draftInputKey('proj-1'), 'typed into the new chat');

  const view = composer({ selectedSession: session('session-a') });
  act(() => { view.result.current.setInput('draft for A'); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1')), 'typed into the new chat');
  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), 'draft for A');
});

test('clearing the composer removes the stored draft rather than storing an empty one', () => {
  const view = composer({ selectedSession: session('session-a') });

  act(() => { view.result.current.setInput('draft for A'); });
  act(() => { view.result.current.setInput(''); });

  assert.equal(localStorage.getItem(draftInputKey('proj-1', 'session-a')), null);
});

for (const isLoading of [true, false]) {
  test(`managed submit is host authoritative when loading=${isLoading}`, async () => {
    const sent: unknown[] = [];
    const added: unknown[] = [];
    writeQueuedMessages('managed-a', [{ content: 'stale local queue' }]);
    const props = {
      managedSession: true,
      selectedSession: session('managed-a'),
      isLoading,
      sendMessage: (message: unknown) => { sent.push(message); },
      addMessage: (message: unknown) => { added.push(message); },
    };
    const view = composer(props);
    act(() => { view.result.current.handleVoiceTranscript('host queued prompt'); });
    await act(async () => {
      await Promise.all([
        view.result.current.handleSubmit({ preventDefault() {} } as never),
        view.result.current.handleSubmit({ preventDefault() {} } as never),
      ]);
    });
    view.rerender({ ...props, isLoading: false });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
    assert.equal(sent.length, 1);
    assert.equal((sent[0] as { content: string }).content, 'host queued prompt');
    assert.deepEqual(added, []);
    assert.deepEqual(view.result.current.queuedDrafts, []);
    assert.deepEqual(readQueuedMessages('managed-a'), []);
  });
}

test('managed state arriving and switching sessions discard stale local queues without flushing', async () => {
  const sent: unknown[] = [];
  const props = {
    selectedSession: session('session-a'),
    isLoading: true,
    sendMessage: (message: unknown) => { sent.push(message); },
  };
  writeQueuedMessages('session-a', [{ content: 'old A queue' }]);
  writeQueuedMessages('session-b', [{ content: 'old B queue' }]);
  const view = composer(props);
  assert.equal(view.result.current.queuedDrafts.length, 1);
  view.rerender({ ...props, managedSession: true, isLoading: false });
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('session-a'), []);
  view.rerender({ ...props, selectedSession: session('session-b'), managedSession: true, isLoading: false });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
  assert.deepEqual(view.result.current.queuedDrafts, []);
  assert.deepEqual(readQueuedMessages('session-b'), []);
  assert.deepEqual(sent, []);
});
