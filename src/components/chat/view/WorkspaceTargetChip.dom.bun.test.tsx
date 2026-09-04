import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import '../../../i18n/config';
import type { WorkspaceCandidate } from '../hooks/useWorkspaceTarget';

import WorkspaceTargetChip from './WorkspaceTargetChip';

/*
 * The chip is the only visible surface of workspace-quick-task, so its two
 * states - resolved target vs. still-at-root - and the picker it opens are
 * what a user actually interacts with. A static render never opens the
 * picker, so this mounts the real component.
 */

const candidate = (overrides: Partial<WorkspaceCandidate> = {}): WorkspaceCandidate => ({
  path: '/Projects/gajae-code-app',
  name: 'gajae-code-app',
  score: 100,
  reason: 'mention',
  ...overrides,
});

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(globalThis, 'fetch');
});

function installFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

test('no target shows the workspace root name with a choose-repo affordance', () => {
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: () => {},
  }));

  const trigger = screen.getByRole('button');
  assert.match(trigger.textContent ?? '', /Projects/);
  assert.match(trigger.textContent ?? '', /choose repo/);
});

test('a resolved target shows the arrow label instead of the root name', () => {
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: candidate(),
    onPick: () => {},
  }));

  const trigger = screen.getByRole('button');
  assert.match(trigger.textContent ?? '', /→ gajae-code-app/);
  assert.equal(screen.queryByText(/choose repo/), null);
});

test('opening the picker lists every candidate plus keep at root, and choosing one calls back', () => {
  const picks: Array<WorkspaceCandidate | null> = [];
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate(), candidate({ path: '/Projects/other-app', name: 'other-app', score: 40, reason: 'partial' })],
    target: null,
    onPick: (picked) => picks.push(picked),
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  assert.ok(screen.getByRole('option', { name: /gajae-code-app/ }));
  assert.ok(screen.getByRole('option', { name: /other-app/ }));
  assert.ok(screen.getByRole('option', { name: 'Keep at root' }));

  fireEvent.click(screen.getByRole('option', { name: /other-app/ }));
  assert.deepEqual(picks, [candidate({ path: '/Projects/other-app', name: 'other-app', score: 40, reason: 'partial' })]);
  // Picking closes the popup.
  assert.equal(screen.queryByRole('listbox'), null);
});

test('the picker filters by name and Enter picks the first match', () => {
  const picks: Array<WorkspaceCandidate | null> = [];
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [
      candidate({ path: '/Projects/hf-studio', name: 'hf-studio', score: 0, reason: 'recent' }),
      candidate({ path: '/Projects/moss-hq', name: 'moss-hq', score: 0, reason: 'recent' }),
      candidate({ path: '/Projects/moss-companion', name: 'moss-companion', score: 0, reason: 'recent' }),
    ],
    target: null,
    onPick: (picked) => picks.push(picked),
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  const search = screen.getByRole('textbox', { name: /Search repos/ });
  fireEvent.change(search, { target: { value: 'MOSS' } });
  assert.equal(screen.queryByRole('option', { name: /hf-studio/ }), null);
  assert.ok(screen.getByRole('option', { name: /moss-hq/ }));
  assert.ok(screen.getByRole('option', { name: /moss-companion/ }));

  fireEvent.change(search, { target: { value: 'zzz' } });
  assert.ok(screen.getByText('No repo matches'));

  fireEvent.change(search, { target: { value: 'moss-c' } });
  fireEvent.keyDown(search, { key: 'Enter' });
  assert.deepEqual(picks.map((pick) => pick?.name), ['moss-companion']);
});

test('choosing keep at root reports a null target', () => {
  const picks: Array<WorkspaceCandidate | null> = [];
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: candidate(),
    onPick: (picked) => picks.push(picked),
  }));

  fireEvent.click(screen.getByRole('button', { name: /gajae-code-app/ }));
  fireEvent.click(screen.getByRole('option', { name: 'Keep at root' }));

  assert.deepEqual(picks, [null]);
});

test('the picker lists a New repo item', () => {
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: () => {},
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  assert.ok(screen.getByRole('option', { name: /New repo…/ }));
});

test('selecting New repo shows the name input prefilled with a non-matching query', () => {
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: () => {},
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  const search = screen.getByRole('textbox', { name: /Search repos/ });
  fireEvent.change(search, { target: { value: 'brand-new-thing' } });
  fireEvent.click(screen.getByRole('option', { name: /New repo…/ }));

  const nameInput = screen.getByRole('textbox', { name: /Repo name/ }) as HTMLInputElement;
  assert.equal(nameInput.value, 'brand-new-thing');
});

test('Enter in the create input posts to create-child and picks the created repo on success', async () => {
  const calls = installFetch(201, {
    success: true,
    data: { projectId: 'proj-new', fullPath: '/Projects/brand-new-thing', displayName: 'brand-new-thing' },
  });
  const picks: Array<WorkspaceCandidate | null> = [];
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: (picked) => picks.push(picked),
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  fireEvent.click(screen.getByRole('option', { name: /New repo…/ }));
  const nameInput = screen.getByRole('textbox', { name: /Repo name/ });
  fireEvent.change(nameInput, { target: { value: 'brand-new-thing' } });
  fireEvent.keyDown(nameInput, { key: 'Enter' });

  await waitFor(() => assert.equal(calls.length, 1));

  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/api\/projects\/proj-workspace\/create-child$/);
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { name: 'brand-new-thing' });
  assert.deepEqual(picks, [{ path: '/Projects/brand-new-thing', name: 'brand-new-thing', score: 100, reason: 'mention' }]);
  assert.equal(screen.queryByRole('listbox'), null);
});

test('a 409 shows the server message and keeps the input open', async () => {
  installFetch(409, { success: false, error: { code: 'CHILD_EXISTS', message: '"brand-new-thing" already exists' } });
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: () => {},
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  fireEvent.click(screen.getByRole('option', { name: /New repo…/ }));
  const nameInput = screen.getByRole('textbox', { name: /Repo name/ });
  fireEvent.change(nameInput, { target: { value: 'brand-new-thing' } });
  fireEvent.keyDown(nameInput, { key: 'Enter' });

  await waitFor(() => assert.ok(screen.getByText('"brand-new-thing" already exists')));

  assert.ok(screen.getByRole('textbox', { name: /Repo name/ }));
});

test('Escape in the create input returns to the list', () => {
  render(createElement(WorkspaceTargetChip, {
    projectId: 'proj-workspace',
    workspaceRootName: 'Projects',
    candidates: [candidate()],
    target: null,
    onPick: () => {},
  }));

  fireEvent.click(screen.getByRole('button', { name: /choose repo/ }));
  fireEvent.click(screen.getByRole('option', { name: /New repo…/ }));
  const nameInput = screen.getByRole('textbox', { name: /Repo name/ });
  fireEvent.keyDown(nameInput, { key: 'Escape' });

  assert.ok(screen.getByRole('textbox', { name: /Search repos/ }));
  assert.equal(screen.queryByRole('textbox', { name: /Repo name/ }), null);
});
