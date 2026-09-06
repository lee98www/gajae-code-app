import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import '../../../i18n/config';
import type { PermissionDecision } from '../types/types';

import PermissionRequestsBanner from './PermissionRequestsBanner';

afterEach(cleanup);

for (const toolName of ['bash', 'AskUserQuestion']) {
  test(`unknown ${toolName} decision is read-only and explains recovery`, () => {
    const decisions: unknown[] = [];
    render(createElement(PermissionRequestsBanner, {
      pendingPermissionRequests: [{
        requestId: 'uncertain-decision', toolName, status: 'unknown',
        input: { questions: [{ question: 'Choose', options: [{ label: 'yes' }] }] },
      }],
      handlePermissionDecision: (...values) => { decisions.push(values); },
    }));
    assert.match(screen.getByRole('status').textContent ?? '', /Decision outcome unknown/);
    assert.match(screen.getByRole('status').textContent ?? '', /Do not submit this decision again/);
    assert.deepEqual(screen.queryAllByRole('button'), []);
    assert.deepEqual(screen.queryAllByRole('textbox'), []);
    assert.deepEqual(decisions, []);
  });
}

test('permission to call ask is not presented as the question itself', () => {
  const decisions: unknown[] = [];
  render(createElement(PermissionRequestsBanner, {
    pendingPermissionRequests: [{ requestId: 'ask-permission', toolName: 'ask',
      input: { questions: [{ question: 'Not executing yet', options: [{ label: 'yes' }] }] },
      context: { source: 'sdk-permission', options: ['allow_once', 'reject_once'] } }],
    handlePermissionDecision: (id, decision) => { decisions.push({ id, decision }); },
  }));
  assert.equal(screen.queryByRole('radiogroup'), null);
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  assert.deepEqual(decisions, [{ id: 'ask-permission', decision: { allow: false } }]);
});

function mount() {
  const decisions: Array<[string | string[], PermissionDecision]> = [];
  render(createElement(PermissionRequestsBanner, {
    pendingPermissionRequests: [{
      requestId: 'sdk-permission:1',
      toolName: 'bash',
      input: { command: 'npm test' },
      context: { source: 'sdk-permission', title: 'npm test' },
    }],
    handlePermissionDecision: (ids, decision) => { decisions.push([ids, decision]); },
  }));
  return decisions;
}

test('Allow answers once, without remembering anything', () => {
  const decisions = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
  assert.deepEqual(decisions, [['sdk-permission:1', { allow: true }]]);
});

test('Always allow answers with the remembered flag for this tool', () => {
  const decisions = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Always allow bash' }));
  assert.deepEqual(decisions, [['sdk-permission:1', { allow: true, always: true }]]);
});

test('Deny refuses the call', () => {
  const decisions = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0][1].allow, false);
  assert.equal(decisions[0][1].always, undefined);
  assert.deepEqual(decisions[0][1], { allow: false });
});

function mountWithOptions(contextOptions: string[] | null) {
  // One test mounts several variants; the previous container must go or its
  // buttons answer for the wrong one.
  cleanup();
  const decisions: Array<[string | string[], PermissionDecision]> = [];
  render(createElement(PermissionRequestsBanner, {
    pendingPermissionRequests: [{
      requestId: 'sdk-permission:2',
      toolName: 'bash',
      input: { command: 'npm test' },
      ...(contextOptions ? { context: { source: 'sdk-permission', title: 'npm test', options: contextOptions } } : { context: { source: 'sdk-permission', title: 'npm test' } }),
    }],
    handlePermissionDecision: (ids, decision) => { decisions.push([ids, decision]); },
  }));
  return decisions;
}

test('Always deny appears only when the runtime offered reject_always, and refuses with the remembered flag', () => {
  // Offered: the button answers { allow: false, always: true }.
  const decisions = mountWithOptions(['allow_once', 'allow_always', 'reject_once', 'reject_always']);
  fireEvent.click(screen.getByRole('button', { name: 'Always deny bash' }));
  assert.deepEqual(decisions, [['sdk-permission:2', { allow: false, always: true }]]);

  // Not offered: no button, the plain Deny carries no always flag.
  const plain = mountWithOptions(['allow_once', 'allow_always', 'reject_once']);
  assert.equal(screen.queryByRole('button', { name: /Always deny/ }), null);
  fireEvent.click(screen.getByRole('button', { name: 'Deny' }));
  assert.equal(plain[0][1].always, undefined);

  // No options statement at all: the card keeps its historical set - always
  // allow without always deny.
  mountWithOptions(null);
  assert.equal(screen.queryByRole('button', { name: /Always deny/ }), null);
  assert.ok(screen.getByRole('button', { name: 'Always allow bash' }));
});
