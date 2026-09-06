import assert from 'node:assert/strict';
import test from 'node:test';

import { GjcBunAskController, redactSecretValue, selectPermissionOption } from './gjc-bun-ask-controller.js';

/** The selected arm of the runtime's outcome union. */
const kindOf = (outcome: { outcome: string; kind?: string }): string | undefined =>
  outcome.outcome === 'selected' ? outcome.kind : undefined;

/*
 * The browser's answer reaches the runtime as one of its own offered options.
 * "Always" pairs with both answers now: allow_always and reject_always - the
 * runtime keeps the memory for the rest of the run, so the card's Always deny
 * means "stop asking me about this tool", never a persisted project rule.
 */

type Writer = { sent: Array<Record<string, unknown>>; send(frame: Record<string, unknown>): void };
const writer = (): Writer => {
  const sent: Array<Record<string, unknown>> = [];
  return { sent, send: (frame) => { sent.push(frame); } };
};

const options = (kinds: string[]) => kinds.map((kind, index) => ({ optionId: `o-${index}`, kind, name: kind }) as never);

test('selectPermissionOption answers reject_always only when the runtime offered it', () => {
  const offered = options(['allow_once', 'reject_once', 'reject_always']);
  assert.equal(kindOf(selectPermissionOption(offered, 'reject_always') as never), 'reject_always');
  // Not offered: falls back to a plain rejection rather than an invalid answer.
  const plain = options(['allow_once', 'allow_always', 'reject_once']);
  assert.equal(kindOf(selectPermissionOption(plain, 'reject_always') as never), 'reject_once');
  assert.equal(kindOf(selectPermissionOption(plain, 'allow_always') as never), 'allow_always');
});

test('a denial with always resolves to the runtime\'s reject_always option', async () => {
  const out = writer();
  const controller = new GjcBunAskController(out as never);
  const decided = controller.requestPermission(
    { toolCallId: 'c1', toolName: 'bash', title: 'bash', rawInput: { command: 'rm -rf /' } } as never,
    options(['allow_once', 'reject_once', 'reject_always']),
  );
  const request = out.sent.find((frame) => frame.kind === 'permission_request') as { requestId: string; context: { options: string[] } };
  assert.deepEqual(request.context.options, ['allow_once', 'reject_once', 'reject_always']);

  assert.equal(controller.resolve(request.requestId, { allow: false, always: true }), true);
  assert.deepEqual(await decided, { outcome: 'selected', optionId: 'o-2', kind: 'reject_always' });
});

test('a denial without always stays a single rejection; an unoffered reject_always degrades', async () => {
  const out = writer();
  const controller = new GjcBunAskController(out as never);
  const decided = controller.requestPermission(
    { toolCallId: 'c1', toolName: 'bash', title: 'bash', rawInput: {} } as never,
    options(['allow_once', 'reject_once']),
  );
  const request = out.sent.find((frame) => frame.kind === 'permission_request') as { requestId: string };

  assert.equal(controller.resolve(request.requestId, { allow: false }), true);
  assert.equal(kindOf(await decided as never), 'reject_once');

  const second = controller.requestPermission(
    { toolCallId: 'c2', toolName: 'eval', title: 'eval', rawInput: {} } as never,
    options(['allow_once', 'reject_once']),
  );
  const secondRequest = out.sent.filter((frame) => frame.kind === 'permission_request')[1] as { requestId: string };
  controller.resolve(secondRequest.requestId, { allow: false, always: true });
  assert.equal(kindOf(await second as never), 'reject_once');
});

test('ask selector resolves one label per SDK select loop callback', async () => {
  const out = writer();
  const controller = new GjcBunAskController(out as never);
  // AskTool 0.15.6 owns the multi-select loop: after each choice it calls the
  // UI selector again with the updated checkbox labels, then calls it once
  // more for "Done selecting". The managed bridge must not collapse those
  // callbacks into one invented array answer.
  const first = controller.uiContext.select('Access', ['☐ Read', '☐ Write', 'Done selecting']);
  const firstRequest = out.sent.find((frame) => frame.kind === 'permission_request') as {
    requestId: string;
    input: { questions: [{ multiSelect: boolean; options: Array<{ label: string }> }] };
  };
  assert.equal(firstRequest.input.questions[0].multiSelect, false);
  assert.deepEqual(firstRequest.input.questions[0].options.map(option => option.label), ['☐ Read', '☐ Write', 'Done selecting']);
  assert.equal(controller.resolve(firstRequest.requestId, { allow: true, message: '☐ Read' }), true);
  assert.equal(await first, '☐ Read');

  const second = controller.uiContext.select('Access', ['☑ Read', '☐ Write', 'Done selecting']);
  const secondRequest = out.sent.filter((frame) => frame.kind === 'permission_request')[1] as { requestId: string };
  assert.equal(controller.resolve(secondRequest.requestId, { allow: true, message: '☐ Write' }), true);
  assert.equal(await second, '☐ Write');

  const done = controller.uiContext.select('Access', ['☑ Read', '☑ Write', 'Done selecting']);
  const doneRequest = out.sent.filter((frame) => frame.kind === 'permission_request')[2] as { requestId: string };
  assert.equal(controller.resolve(doneRequest.requestId, { allow: true, message: 'Done selecting' }), true);
  assert.equal(await done, 'Done selecting');
});

test('tagged permission input is reduced to a safe descriptor before publication', async () => {
  const out = writer();
  const controller = new GjcBunAskController(out as never);
  const decision = controller.requestPermission(
    { toolCallId: 'secret', toolName: 'login', title: 'Sign in', rawInput: { username: 'alice', password: { secret: true, value: 'private-value' } } } as never,
    options(['allow_once', 'reject_once']),
  );
  const request = out.sent.find((frame) => frame.kind === 'permission_request') as { input: Record<string, unknown>; context: { inputMode: string; answerRetention: string } };
  assert.deepEqual(request.input, { username: 'alice', password: { secret: true, redacted: true } });
  assert.equal(request.context.inputMode, 'non-echo');
  assert.equal(request.context.answerRetention, 'live-only');
  const requestId = (out.sent.find((frame) => frame.kind === 'permission_request') as { requestId: string }).requestId;
  assert.equal(controller.resolve(requestId, { allow: true }), true);
  assert.deepEqual(await decision, { outcome: 'selected', optionId: 'o-0', kind: 'allow_once' });
  assert.deepEqual(redactSecretValue({ token: { sensitive: true, value: 'private-value' } }), { token: { secret: true, redacted: true } });
});
