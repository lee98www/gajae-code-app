import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import i18n from '../../../i18n/config.js';
import { herdrRoutePaths } from '../../app/appRoutes';
import { HERDR_QUERY_KEY } from '../../../hooks/useHerdrQueries';

import HerdrPage from './HerdrPage';

const jsonResponse = (data: unknown, status = 200) => new Response(JSON.stringify({ success: true, data }), { status, headers: { 'content-type': 'application/json' } });
const session = { name: 'default', label: 'Default', status: 'available', generation: 1 };
const pane = { paneId: 'p1', terminalId: 'term1', workspaceId: 'w1', tabId: 't1', focused: true, cwd: '/repo', agent: 'gjc', agentStatus: 'idle', observationToken: 'tok1' };
const snapshot = {
  session,
  workspaces: [
    { workspaceId: 'w2', number: 2, label: 'Second workspace', focused: false, tabCount: 1, paneCount: 1, agentStatus: 'idle' },
    { workspaceId: 'w1', number: 1, label: 'First workspace', focused: true, tabCount: 1, paneCount: 1, agentStatus: 'idle' },
  ],
  tabs: [
    { tabId: 't2', workspaceId: 'w2', number: 2, label: 'Second tab', focused: false, paneCount: 1, agentStatus: 'idle' },
    { tabId: 't1', workspaceId: 'w1', number: 1, label: 'First tab', focused: true, paneCount: 1, agentStatus: 'idle' },
  ],
  panes: [{ ...pane, paneId: 'p2', terminalId: 'term2', workspaceId: 'w2', tabId: 't2', observationToken: 'tok2' }, pane],
  observedAt: new Date().toISOString(),
};
const output = { sessionName: 'default', paneId: 'p1', terminalId: 'term1', observationToken: 'tok1', text: '<script>alert(1)</script> 한국어', truncated: false, observedAt: new Date().toISOString() };

function renderPage(route = '/herdr') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <MemoryRouter basename="/studio" initialEntries={[`/studio${route}`]}>
          <Routes>{herdrRoutePaths.map((path) => <Route key={path} path={path} element={<HerdrPage />} />)}</Routes>
        </MemoryRouter>
      </QueryClientProvider>
    </I18nextProvider>,
  );
  return { ...view, client };
}

function fixtureFetch(url: string) {
  if (url === '/api/herdr/sessions') return jsonResponse({ sessions: [session] });
  if (url.endsWith('/snapshot')) return jsonResponse(snapshot);
  if (url.endsWith('/output')) return jsonResponse(output);
  throw new Error(`unexpected URL ${url}`);
}

afterEach(() => {
  cleanup();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('HerdrPage', () => {
  it('renders sessions, workspace/tab hierarchy in snapshot order, and inert visible output', async () => {
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => { urls.push(url); return fixtureFetch(url); };
    const view = renderPage();
    await waitFor(() => view.getByText('Default'));
    fireEvent.click(view.getByText('Default'));
    await waitFor(() => view.getByText('p1 · Idle'));
    assert.deepEqual(Array.from(view.container.querySelectorAll('h2, h3')).map((node) => node.textContent).filter((text) => text?.includes('workspace') || text?.includes('tab')), ['Second workspace', 'Second tab', 'First workspace', 'First tab']);
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.match(view.container.textContent ?? '', /<script>alert\(1\)<\/script> 한국어/));
    assert.equal(view.container.querySelector('script'), null);
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    assert.ok(urls.some((url) => url.includes('/api/herdr/sessions/default/panes/p1/output')));
    assert.equal(view.getByRole('link', { name: 'Back to chats' }).getAttribute('href'), '/studio');
  });

  it('deep links display the requested output but never authorize input without explicit selection', async () => {
    (globalThis as any).fetch = async (url: string) => fixtureFetch(url);
    const view = renderPage('/herdr/default/panes/p1');
    await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
  });

  for (const status of [401, 502]) {
    it(`revokes input after output ${status} and keeps it revoked after recovery until reselection`, async () => {
      let fail = false;
      (globalThis as any).fetch = async (url: string) => url.endsWith('/output') && fail ? jsonResponse({}, status) : fixtureFetch(url);
      const view = renderPage('/herdr/default/panes/p1');
      await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
      fireEvent.click(view.getByText('p1 · Idle'));
      await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
      fail = true;
      await view.client.invalidateQueries({ queryKey: [...HERDR_QUERY_KEY, 'output'] });
      await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true));
      fail = false;
      await view.client.invalidateQueries({ queryKey: [...HERDR_QUERY_KEY, 'output'] });
      await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
      assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
      fireEvent.click(view.getByText('p1 · Idle'));
      await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    });
  }

  it('requires explicit reselection after an uncertain mutation and clears the prior draft', async () => {
    let sends = 0;
    (globalThis as any).fetch = async (url: string) => {
      if (url.endsWith('/input')) { sends++; return jsonResponse({}, 502); }
      return fixtureFetch(url);
    };
    const view = renderPage('/herdr/default/panes/p1');
    await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'hello' } });
    fireEvent.click(view.getByRole('button', { name: 'Send text' }));
    await waitFor(() => assert.match(view.container.textContent ?? '', /delivery may be unknown/));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value, '');
    assert.equal(sends, 1);
  });

  it('revokes a stale local read even when cached data later becomes fresh again', async () => {
    (globalThis as any).fetch = async (url: string) => fixtureFetch(url);
    const view = renderPage('/herdr/default/panes/p1');
    await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    const key = [...HERDR_QUERY_KEY, 'output', 'default', 'p1'];
    view.client.setQueryData(key, output, { updatedAt: Date.now() - 30_000 });
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true));
    view.client.setQueryData(key, output, { updatedAt: Date.now() });
    await waitFor(() => assert.match(view.container.textContent ?? '', /explicit reselection/));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
  });

  it('does not reuse eligibility when the observed terminal token changes', async () => {
    (globalThis as any).fetch = async (url: string) => fixtureFetch(url);
    const view = renderPage('/herdr/default/panes/p1');
    await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'old draft' } });
    view.client.setQueryData([...HERDR_QUERY_KEY, 'snapshot', 'default'], {
      ...snapshot, panes: snapshot.panes.map((item) => ({ ...item, observationToken: 'new-token' })),
    });
    view.client.setQueryData([...HERDR_QUERY_KEY, 'output', 'default', 'p1'], { ...output, observationToken: 'new-token' });
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value, '');
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
  });

  it('clears draft and output across named sessions that share a pane id', async () => {
    const other = { ...session, name: 'other', label: 'Other' };
    (globalThis as any).fetch = async (url: string) => {
      if (url === '/api/herdr/sessions') return jsonResponse({ sessions: [session, other] });
      if (url.includes('/sessions/other/')) {
        if (url.endsWith('/snapshot')) return jsonResponse({
          ...snapshot, session: other, panes: [{ ...pane, terminalId: 'other-terminal', observationToken: 'other-token' }],
        });
        if (url.endsWith('/output')) return jsonResponse({
          ...output, sessionName: 'other', terminalId: 'other-terminal', observationToken: 'other-token', text: 'Other session output',
        });
      }
      return fixtureFetch(url);
    };
    const view = renderPage('/herdr/default/panes/p1');
    await waitFor(() => assert.match(view.container.textContent ?? '', /한국어/));
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    fireEvent.change(view.getByRole('textbox'), { target: { value: 'old session draft' } });
    fireEvent.click(view.getByText('Other'));
    await waitFor(() => view.getByText('p1 · Idle'));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value, '');
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, true);
    assert.doesNotMatch(view.container.textContent ?? '', /한국어/);
    fireEvent.click(view.getByText('p1 · Idle'));
    await waitFor(() => view.getByText('Other session output'));
    await waitFor(() => assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).disabled, false));
    assert.equal((view.getByRole('textbox') as HTMLTextAreaElement).value, '');
  });
});
