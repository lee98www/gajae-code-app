import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor, cleanup, fireEvent } from '@testing-library/react';

import { useHerdrInput, useHerdrOutput, useHerdrSessions, useHerdrSnapshot } from './useHerdrQueries';

const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function Harness({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(() => new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('useHerdrQueries', () => {
  it('rejects malformed snapshot and output DTOs rather than exposing cast data', async () => {
    (globalThis as any).fetch = async (url: string) => jsonResponse({
      success: true,
      data: url.endsWith('/snapshot')
        ? { session: { name: 'default' }, workspaces: [], tabs: [], panes: [] }
        : { sessionName: 'default', paneId: 'p1', terminalId: 't', observationToken: 'o', text: { html: '<b>unsafe</b>' }, truncated: false, observedAt: new Date().toISOString() },
    });
    function Probe() {
      const snapshot = useHerdrSnapshot('default');
      const output = useHerdrOutput('default', 'p1');
      return <output>{snapshot.isError && output.isError ? 'invalid' : 'pending'}</output>;
    }
    const view = render(<Harness><Probe /></Harness>);
    await waitFor(() => assert.equal(view.container.textContent, 'invalid'));
  });

  for (const data of [{}, { sessions: 'invalid' }, { sessions: [{ name: 'default' }] }, { sessions: [], unexpected: true }]) {
    it(`rejects malformed sessions rather than presenting an empty success: ${JSON.stringify(data)}`, async () => {
      (globalThis as any).fetch = async () => jsonResponse({ success: true, data });
      function Probe() {
        const query = useHerdrSessions();
        return <output>{query.isError ? 'invalid' : query.isSuccess ? 'success' : 'pending'}</output>;
      }
      const view = render(<Harness><Probe /></Harness>);
      await waitFor(() => assert.equal(view.container.textContent, 'invalid'));
    });
  }

  it('aborts pending input on target switch and unmount without accepting a late response', async () => {
    const signals: AbortSignal[] = [];
    const replies: Array<(response: Response) => void> = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise<Response>((resolve) => replies.push(resolve));
    };
    function Probe({ paneId }: { paneId: string }) {
      const mutation = useHerdrInput('default', paneId);
      return <button onClick={() => mutation.mutate({ action: 'enter', text: '', terminalId: 't', observationToken: 'o' })}>
        {mutation.isSuccess ? 'accepted' : mutation.isError ? 'failed' : 'send'}
      </button>;
    }
    const view = render(<Harness><Probe paneId="p1" /></Harness>);
    fireEvent.click(view.getByRole('button'));
    await waitFor(() => assert.equal(signals.length, 1));
    view.rerender(<Harness><Probe paneId="p2" /></Harness>);
    assert.equal(signals[0].aborted, true);
    replies[0](jsonResponse({ success: true, data: { ok: true, sessionName: 'default', paneId: 'p1', outcome: 'accepted_not_delivered', message: 'accepted', observedAt: new Date().toISOString() } }));
    await waitFor(() => assert.equal(view.container.textContent, 'failed'));
    fireEvent.click(view.getByRole('button'));
    await waitFor(() => assert.equal(signals.length, 2));
    view.unmount();
    assert.equal(signals[1].aborted, true);
    replies[1](jsonResponse({}));
  });

  it('cancels a mutation queued by React Query before its transport starts', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => { calls++; return jsonResponse({}); };
    const client = new QueryClient();
    function Probe() {
      const mutation = useHerdrInput('default', 'p1');
      return <button onClick={() => mutation.mutate({ action: 'enter', text: '', terminalId: 't', observationToken: 'o' })}>send</button>;
    }
    const view = render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
    fireEvent.click(view.getByRole('button'));
    view.unmount();
    await waitFor(() => assert.equal(client.getMutationCache().getAll()[0]?.state.status, 'error'));
    assert.equal(calls, 0);
  });

  it('rejects malformed input acknowledgments without retry', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      return jsonResponse({ success: true, data: { ok: true } });
    };
    function Probe() {
      const mutation = useHerdrInput('default', 'p1');
      return <button onClick={() => mutation.mutate({ action: 'enter', text: '', terminalId: 't', observationToken: 'o' })}>{mutation.isError ? 'invalid' : 'send'}</button>;
    }
    const view = render(<Harness><Probe /></Harness>);
    fireEvent.click(view.getByRole('button'));
    await waitFor(() => assert.equal(view.container.textContent, 'invalid'));
    assert.equal(calls, 1);
  });

  it('fetches sessions through the protected API envelope', async () => {
    (globalThis as any).fetch = async (url: string) => {
      assert.equal(url, '/api/herdr/sessions');
      return jsonResponse({ success: true, data: { sessions: [{ name: 'default', label: 'Default', status: 'unknown', generation: 1 }] } });
    };
    function Probe() {
      const query = useHerdrSessions();
      return <output>{query.data?.[0]?.name ?? 'loading'}</output>;
    }
    const view = render(<Harness><Probe /></Harness>);
    await waitFor(() => assert.equal(view.container.textContent, 'default'));
  });

  it('does not reuse output placeholder data across pane targets', async () => {
    const urls: string[] = [];
    (globalThis as any).fetch = async (url: string) => {
      urls.push(url);
      return jsonResponse({ success: true, data: { sessionName: 'default', paneId: url.includes('p2') ? 'p2' : 'p1', terminalId: 't', observationToken: 'o', text: url.includes('p2') ? 'two' : 'one', truncated: false, observedAt: new Date(0).toISOString() } });
    };
    function Probe({ paneId }: { paneId: string }) {
      const query = useHerdrOutput('default', paneId);
      return <output>{query.data?.text ?? 'none'}</output>;
    }
    const view = render(<Harness><Probe paneId="p1" /></Harness>);
    await waitFor(() => assert.equal(view.container.textContent, 'one'));
    view.rerender(<Harness><Probe paneId="p2" /></Harness>);
    assert.notEqual(view.container.textContent, 'one');
    await waitFor(() => assert.equal(view.container.textContent, 'two'));
    assert.ok(urls.some((url) => url.includes('/p1/output')));
    assert.ok(urls.some((url) => url.includes('/p2/output')));
  });

  it('sends explicit input without retry', async () => {
    const bodies: unknown[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ success: true, data: { ok: true, sessionName: 'default', paneId: 'p1', outcome: 'accepted_not_delivered', message: 'Accepted by Herdr; delivery is not confirmed.', observedAt: new Date(0).toISOString() } });
    };
    function Probe() {
      const mutation = useHerdrInput('default', 'p1');
      const { mutate } = mutation;
      React.useEffect(() => {
        mutate({ action: 'text-enter', text: 'hi', terminalId: 'term1', observationToken: 'tok1' });
      }, [mutate]);
      return <output>{mutation.data?.outcome ?? 'pending'}</output>;
    }
    const view = render(<Harness><Probe /></Harness>);
    await waitFor(() => assert.equal(view.container.textContent, 'accepted_not_delivered'));
    assert.deepEqual(bodies, [{ action: 'text-enter', text: 'hi', terminalId: 'term1', observationToken: 'tok1' }]);
  });
});
