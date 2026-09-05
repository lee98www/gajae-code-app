import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';

import i18n from '../../../i18n/config.js';

import HerdrInput from './HerdrInput';

const pane = { paneId: 'p1', terminalId: 'term1', workspaceId: 'w1', tabId: 't1', focused: true, cwd: '/tmp', agentStatus: 'idle' as const, observationToken: 'tok1' };
const jsonResponse = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function renderInput() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={client}>
        <HerdrInput sessionName="default" pane={pane} enabled />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

afterEach(() => {
  cleanup();
  delete (globalThis as { fetch?: unknown }).fetch;
});

describe('HerdrInput', () => {
  it('sends text plus Enter as one explicit action', async () => {
    const bodies: unknown[] = [];
    (globalThis as any).fetch = async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse({ success: true, data: { ok: true, sessionName: 'default', paneId: 'p1', outcome: 'accepted_not_delivered', message: 'Accepted by Herdr; delivery is not confirmed.', observedAt: new Date(0).toISOString() } });
    };
    const view = renderInput();
    fireEvent.change(view.getByLabelText('Explicit input'), { target: { value: 'hello' } });
    fireEvent.click(view.getByText('Send + Enter'));
    await waitFor(() => assert.match(view.container.textContent ?? '', /Accepted by Herdr/));
    assert.deepEqual(bodies, [{ action: 'text-enter', text: 'hello', terminalId: 'term1', observationToken: 'tok1' }]);
  });

  it('rejects multiline text before fetch', () => {
    let fetches = 0;
    (globalThis as any).fetch = async () => { fetches++; return jsonResponse({}); };
    const view = renderInput();
    fireEvent.change(view.getByLabelText('Explicit input'), { target: { value: 'bad\ninput' } });
    assert.match(view.container.textContent ?? '', /one line/);
    assert.equal((view.getByText('Send text') as HTMLButtonElement).disabled, true);
    assert.equal(fetches, 0);
  });

  for (const text of ['bad\u0000input', 'bad\u0085input', 'bad\u2028input', 'bad\u2029input', '한'.repeat(5462)]) {
    it(`rejects unsafe text or UTF-8 overflow (${JSON.stringify(text.slice(0, 12))}) without sending`, () => {
      let calls = 0;
      (globalThis as any).fetch = async () => { calls++; return jsonResponse({}); };
      const view = renderInput();
      fireEvent.change(view.getByRole('textbox'), { target: { value: text } });
      fireEvent.click(view.getByText('Send text'));
      assert.equal((view.getByText('Send text') as HTMLButtonElement).disabled, true);
      assert.equal(calls, 0);
    });
  }

  it('does not send on Enter or composition keys and revokes after an uncertain explicit send', async () => {
    let calls = 0;
    (globalThis as any).fetch = async () => {
      calls++;
      throw new Error('timeout after write');
    };
    const view = renderInput();
    const input = view.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.compositionEnd(input);
    assert.equal(calls, 0);
    fireEvent.click(view.getByText('Send text'));
    await waitFor(() => assert.match(view.container.textContent ?? '', /delivery may be unknown/));
    assert.equal((input as HTMLTextAreaElement).disabled, true);
    fireEvent.click(view.getByText('Send text'));
    assert.equal(calls, 1);
  });
});
