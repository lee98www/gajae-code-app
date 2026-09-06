import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import type { PermissionPanelProps } from '../../configs/permissionPanelRegistry';

import { AskUserQuestionPanel } from './AskUserQuestionPanel';

afterEach(cleanup);

const request: PermissionPanelProps['request'] = {
  requestId: 'ask-1',
  toolName: 'ask',
  input: { questions: [{ question: 'Choose access', options: [{ label: 'Allow once' }, { label: 'Deny' }] }] },
};

test('question submit sends answers without reasserting the request schema', () => {
  const decisions: unknown[] = [];
  render(<AskUserQuestionPanel request={request} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  fireEvent.click(screen.getByRole('button', { name: /Allow once/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  assert.deepEqual(decisions, [{ id: 'ask-1', decision: { allow: true, updatedInput: { answers: { 'Choose access': 'Allow once' } } } }]);
});

test('question text is treated as a literal answer key', () => {
  const decisions: unknown[] = [];
  const keyed = { ...request, input: { questions: [{ question: '__proto__', options: [{ label: 'Allow once' }] }] } };
  render(<AskUserQuestionPanel request={keyed} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  fireEvent.click(screen.getByRole('button', { name: /Allow once/ }));
  fireEvent.click(screen.getByRole('button', { name: /^Submit/ }));
  assert.deepEqual(decisions, [{ id: 'ask-1', decision: { allow: true, updatedInput: { answers: { ['__proto__']: 'Allow once' } } } }]);
});

test('an uncertain inline question cannot be answered again', () => {
  render(<AskUserQuestionPanel request={{ ...request, status: 'unknown' }} onDecision={() => assert.fail('Unknown requests are read-only.')} />);
  assert.ok(screen.getByRole('status'));
  assert.deepEqual(screen.queryAllByRole('button'), []);
});

test('unsupported no-echo requests never expose an answer-entry surface', () => {
  const decisions: unknown[] = [];
  render(<AskUserQuestionPanel request={{ ...request, context: { inputMode: 'non-echo', answerRetention: 'live-only' } }} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  assert.ok(screen.getByRole('status'));
  assert.equal(screen.queryByRole('radiogroup'), null);
  assert.equal(screen.queryByRole('textbox'), null);
  assert.equal(screen.queryByText('Choose access'), null);
  fireEvent.click(screen.getByRole('button'));
  assert.deepEqual(decisions, [{ id: 'ask-1', decision: { allow: false, message: 'User skipped the question' } }]);
});

test('question skip preserves its explicit refusal reason without answer payload', () => {
  const decisions: unknown[] = [];
  render(<AskUserQuestionPanel request={request} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  fireEvent.click(screen.getByRole('button', { name: /^Skip/ }));
  assert.deepEqual(decisions, [{ id: 'ask-1', decision: { allow: false, message: 'User skipped the question' } }]);
});
