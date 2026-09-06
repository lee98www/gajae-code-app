import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import type { HerdrManagedPublicSelection } from '../../../../shared/herdr-managed-provision-protocol';
import { useChatComposerState } from '../hooks/useChatComposerState';

import ManagedHerdrSelection from './ManagedHerdrSelection';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; localStorage.clear(); });

function mount(initial: HerdrManagedPublicSelection) {
  let selection = initial;
  const calls: string[] = [];
  const sent: unknown[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    let body: unknown = [];
    if (path.endsWith('/api/herdr/managed/selection')) {
      if (init?.method === 'PUT') selection = { ...selection, selectedSessionName: JSON.parse(String(init.body)).selectedSessionName, status: 'ready' };
      body = { data: selection };
    } else if (path.endsWith('/api/providers/sessions')) body = { data: { sessionId: 'fresh-app-id' } };
    else if (path.endsWith('/api/assets/images')) body = { images: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  function Harness() {
    const [currentSessionId, setSessionId] = useState<string | null>(null);
    const composer = useChatComposerState({
      selectedProject: { projectId: 'project', displayName: 'Project', fullPath: '/repo', origin: 'explicit' },
      selectedSession: null, currentSessionId, gjcModel: 'default', isLoading: false, canAbortSession: false,
      tokenBudget: null, sendMessage: (message) => sent.push(message), scrollToBottom: () => {}, addMessage: () => {},
      setIsUserScrolledUp: () => {}, setPendingPermissionRequests: () => {}, onSessionEstablished: setSessionId,
    });
    return <><ManagedHerdrSelection state={composer.managedSelection} /><form onSubmit={composer.handleSubmit}>
      <textarea aria-label="Draft" value={composer.input} onChange={composer.handleInputChange} />
      <button type="button" onClick={() => composer.setAttachedImages([new File(['image'], 'draft.png', { type: 'image/png' })])}>Attach</button>
      <span data-testid="attachments">{composer.attachedImages.length}</span>
      <button type="submit">Send</button>
    </form></>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  return { calls, sent };
}

const instances = [{ name: 'work', label: 'Work', status: 'available' as const }];
test('selection required preserves draft and attachments, choosing then retrying allocates and sends', async () => {
  const { calls, sent } = mount({ selectedSessionName: null, status: 'selection_required', instances });
  await screen.findByText('Choose a Herdr instance before sending a new chat.');
  fireEvent.change(screen.getByRole('textbox', { name: 'Draft' }), { target: { value: 'keep this draft' } });
  fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'keep this draft');
  assert.equal(screen.getByTestId('attachments').textContent, '1');
  assert.equal(calls.some((call) => /providers\/sessions|assets\/images/.test(call)), false);
  assert.equal(sent.length, 0);
  fireEvent.change(screen.getByRole('combobox', { name: 'Herdr' }), { target: { value: 'work' } });
  await screen.findByText('New chats run in the selected Herdr instance.');
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal(sent.length, 1));
  assert.equal((sent[0] as { content: string }).content, 'keep this draft');
  assert.match((sent[0] as { actionId: string }).actionId, /^[0-9a-f-]{36}$/);
  assert.equal(calls.filter((call) => call === 'POST /api/providers/sessions').length, 1);
});

test('unavailable selected target remains selected and cannot allocate, upload or send', async () => {
  const { calls, sent } = mount({ selectedSessionName: 'missing', status: 'unavailable', instances });
  await screen.findByText('The selected Herdr instance is not ready. Your draft is preserved.');
  assert.equal((screen.getByRole('combobox') as HTMLSelectElement).value, 'missing');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'do not lose this' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await waitFor(() => assert.equal(screen.getByRole('combobox').hasAttribute('disabled'), false));
  assert.equal((screen.getByRole('textbox') as HTMLTextAreaElement).value, 'do not lose this');
  assert.equal(calls.some((call) => /providers\/sessions|assets\/images/.test(call)), false);
  assert.equal(sent.length, 0);
  assert.ok(screen.getByRole('combobox').getAttribute('aria-describedby'));
});
