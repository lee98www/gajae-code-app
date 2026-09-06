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

test('question skip preserves its explicit refusal reason without answer payload', () => {
  const decisions: unknown[] = [];
  render(<AskUserQuestionPanel request={request} onDecision={(id, decision) => decisions.push({ id, decision })} />);
  fireEvent.click(screen.getByRole('button', { name: /^Skip/ }));
  assert.deepEqual(decisions, [{ id: 'ask-1', decision: { allow: false, message: 'User skipped the question' } }]);
});
