import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseManagedChildOutput,
  parseManagedChildRequest,
  type ManagedChildOutput,
  type ManagedChildEvent,
  type ManagedChildResponse,
} from '../shared/herdr-managed-child-protocol.js';

import { MANAGED_CHILD_TOOL_ORIGIN_LIMIT } from './gjc-herdr-managed-child.js';

/** This script is test-owned and imported, never a production bootstrap option. */
function launcherSource(disposalFile: string, titleDelayMs = 0) {
  return `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runManagedChild } from ${JSON.stringify(fileURLToPath(new URL('./gjc-herdr-managed-child.ts', import.meta.url)))};
import { GjcBunSdkAdapter } from ${JSON.stringify(fileURLToPath(new URL('./gjc-bun-sdk-adapter.ts', import.meta.url)))};
const configuredTitleDelayMs = ${JSON.stringify(titleDelayMs)};
let creations = 0;
const authStorage = {
  exportSnapshot: () => ({ credentials: [] }),
  setRuntimeApiKey() {}, removeRuntimeApiKey() {},
};
const model = { id: 'managed-model', provider: 'managed-provider' };
const modelRegistry = { authStorage, getAll: () => [model], getAvailable: () => [model] };
const settings = { cloneForCwd: async () => ({ override() {} }) };
const createSessionFactory = async (input) => {
  assert.equal(++creations, 1, 'one retained SDK object');
  assert.equal(input.sdkHostModeSupported, false);
  assert.equal(input.notificationHostModeSupported, false);
  let ui;
  let turns = 0;
  let steers = 0;
  let thrown = 0;
  let resolveAbort;
  let permissionMode = 'allow';
  let permissionProvider;
  let permissionRegistrations = 0;
  const listeners = new Set();
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const session = {
    isStreaming: false,
    model,
    thinkingLevel: 'high',
    setSdkPermissionMode(mode) { permissionMode = mode; },
    setSdkPermissionProvider(provider) { permissionProvider = provider; permissionRegistrations++; },
    getContextUsage: () => ({ tokens: 15, contextWindow: 100, source: 'exact' }),
    setModelTemporary: async () => {},
    setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text, options) {
      if (options?.streamingBehavior === 'steer') {
        assert.equal(this.isStreaming, true);
        emit({ type: 'notice', level: 'info', message: 'steer:' + (++steers) + ':' + text });
        return;
      }
      assert.equal(this.isStreaming, false);
      if (text === 'throw') { thrown += 1; throw new Error('provider rejected the turn: quota exhausted'); }
      this.isStreaming = true;
      turns += 1;
      assert.equal(permissionRegistrations, turns + thrown + 1, 'permission cache resets at every retained turn boundary');
      assert.equal(permissionMode, 'prompt', 'managed gate is mandatory without config.permissions');
      assert.equal(typeof permissionProvider, 'function');
      if (text === 'permissions') {
        const permissionOptions = [
          { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'always', kind: 'allow_always', name: 'Always allow' },
          { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
          { optionId: 'deny-rest', kind: 'reject_always', name: 'Deny remaining' },
        ];
        for (let gate = 1; gate <= 2; gate += 1) {
          const outcome = await permissionProvider({ toolCallId: 'gate:' + gate, toolName: 'bash', title: 'command', rawInput: { command: 'pwd' } }, permissionOptions);
          assert.equal(outcome.kind, gate === 1 ? 'allow_once' : 'reject_always');
          emit({ type: 'notice', level: 'info', message: 'gate:' + gate + ':' + outcome.kind });
        }
        this.isStreaming = false;
        return;
      }
      if (text === 'overflow') {
        for (let index = 0; index < 129; index += 1) emit({ type: 'thinking_end', content: 'burst:' + index });
      }
      // A runtime that starts more tools than the origin bound without finishing any.
      if (text.startsWith('tool-flood:')) {
        const count = Number(text.slice('tool-flood:'.length));
        for (let index = 0; index < count; index += 1) {
          emit({ type: 'tool_execution_start', toolCallId: 'flood:' + index, toolName: 'bash', args: { command: 'sleep' } });
          if (index % 64 === 63) await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      emit({ type: 'thinking_end', content: 'thinking:' + turns });
      // A background tool started by this turn whose completion arrives later.
      if (text === 'late-tool') emit({ type: 'tool_execution_start', toolCallId: 'background:' + turns, toolName: 'bash', args: { command: 'sleep' } });
      emit({ type: 'tool_execution_start', toolCallId: 'tool:' + turns, toolName: 'read', args: { path: 'file' } });
      emit({ type: 'tool_execution_update', toolCallId: 'tool:' + turns, partialResult: { content: [{ type: 'text', text: 'partial' }] } });
      const aborted = new Promise((resolve) => { resolveAbort = resolve; });
      const answer = await Promise.race([ui.select('Continue turn ' + turns, ['yes', 'no']), aborted]);
      emit({ type: 'tool_execution_end', toolCallId: 'tool:' + turns, toolName: 'read', result: { content: [{ type: 'text', text: String(answer) }], details: { turn: turns } }, isError: false });
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'answer:' + turns }], stopReason: text === 'fail' ? 'error' : 'stop', ...(text === 'fail' ? { errorMessage: 'first failure' } : {}), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } } });
      this.isStreaming = false;
      // Real runtimes keep reporting background state after a turn (late tool
      // updates, notices, bookkeeping). No turn owns it once the prompt settles.
      if (text === 'idle-after') setTimeout(() => { for (let index = 0; index < 20; index += 1) emit({ type: 'notice', level: 'info', message: 'idle:late-bookkeeping:' + index }); }, 150);
      if (text === 'late-tool') { const started = turns; setTimeout(() => emit({ type: 'tool_execution_end', toolCallId: 'background:' + started, toolName: 'bash', result: { content: [{ type: 'text', text: 'late:' + started }], details: {} }, isError: false }), 400); }
    },
    async abort() { resolveAbort?.('aborted'); },
    async dispose() { resolveAbort?.('disposed'); await writeFile(${JSON.stringify(disposalFile)}, JSON.stringify({ creations, turns, steers })); },
  };
  return { session, setToolUIContext(value) { ui = value; } };
};
await runManagedChild({ createAdapter: async () => new GjcBunSdkAdapter(authStorage, modelRegistry, {
  settings,
  createSessionFactory,
  generateSessionTitle: async () => {
    if (configuredTitleDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, configuredTitleDelayMs));
    return configuredTitleDelayMs > 0 ? 'Delayed native title' : null;
  },
}) });
`;
}

async function harness(titleDelayMs = 0) {
  const root = await mkdtemp(join(tmpdir(), 'herdr-child-'));
  const script = join(root, 'launcher.ts');
  const disposalFile = join(root, 'disposed.json');
  await writeFile(script, launcherSource(disposalFile, titleDelayMs));
  const child = spawn(process.execPath, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GJC_RUNTIME_API_KEY: 'test-only-not-a-provider-key' },
  });
  const frames: ManagedChildOutput[] = [];
  let stderr = '';
  let buffer = '';
  let parseError: unknown;
  child.stdin.on('error', (error: NodeJS.ErrnoException) => {
    // Fail-closed child shutdown may race automatic acks already queued by stdout.
    if (error.code !== 'EPIPE') parseError = error;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const send = (frame: Record<string, unknown>) => child.stdin.write(`${JSON.stringify({ version: 1, generation: 'generation:1', runId: 'owner', ...frame })}\n`);
  let ackCounter = 0;
  const ack = (frame: ManagedChildEvent) => send({ type: 'ack', requestId: `ack:${++ackCounter}`, runId: frame.runId, eventSeq: frame.eventSeq });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      try {
        const frame = parseManagedChildOutput(line);
        frames.push(frame);
        // Withhold only terminal acks to prove the prompt response is not early.
        if (frame.type === 'event' && frame.event.kind !== 'complete') ack(frame);
      } catch (error) { parseError = error; }
    }
  });
  const exited = new Promise<number | null>((resolve) => { child.once('exit', resolve); });
  async function wait<T>(read: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (parseError) throw parseError;
      const value = read();
      if (value !== undefined) return value;
      if (child.exitCode !== null) throw new Error(`Child exited ${child.exitCode}: ${stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Child frame timed out: ${stderr}`);
  }
  const response = (requestId: string) => wait(() => frames.find((f): f is ManagedChildResponse => f.type === 'response' && f.requestId === requestId));
  const event = (runId: string, kind: string) => wait(() => frames.find((f): f is ManagedChildEvent => f.type === 'event' && f.runId === runId && f.event.kind === kind));
  async function init() {
    send({ type: 'init', requestId: 'init', agentDir: root, appSessionId: 'app:1', runConfig: {
      cwd: root, sessionRoot: root, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'managed-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] },
    } });
    assert.equal((await response('init')).ok, true);
    assert.equal(frames.some((f) => f.type === 'event' && f.event.kind === 'thinking'), false, 'initialize never prompts');
  }
  async function cleanup() {
    if (child.exitCode === null) child.kill('SIGKILL');
    await exited;
    await rm(root, { recursive: true, force: true });
  }
  return { child, frames, send, ack, response, event, init, cleanup, disposalFile, exited };
}

test('private Bun child streams real adapter mapping, accepts concurrent controls, retains two turns and waits for durable terminal ack', { timeout: 30_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    for (const [turn, text, exitCode] of [[1, 'fail', 1], [2, 'success', 0]] as const) {
      const runId = `turn:${turn}`;
      const requestId = `prompt:${turn}`;
      h.send({ type: 'prompt', runId, requestId, actionId: requestId, text });
      const ask = await h.event(runId, 'permission_request');
      assert.equal(ask.requestId, requestId);
      assert.equal(h.frames.some((f) => f.type === 'response' && f.requestId === requestId), false);
      assert.equal((await h.event(runId, 'thinking')).event.content, `thinking:${turn}`);
      assert.equal((await h.event(runId, 'tool_use')).event.toolId, `tool:${turn}`);
      if (turn === 1) {
        h.send({ type: 'steer', runId, requestId: 'steer:1', actionId: 'steer-action:1', text: 'same text' });
        assert.equal((await h.response('steer:1')).ok, true);
        h.send({ type: 'steer', runId, requestId: 'steer:retry', actionId: 'steer-action:1', text: 'same text' });
        assert.equal((await h.response('steer:retry')).ok, true);
        h.send({ type: 'steer', runId, requestId: 'steer:conflict', actionId: 'steer-action:1', text: 'different' });
        assert.equal((await h.response('steer:conflict')).error, 'conflict');
        h.send({ type: 'steer', runId, requestId: 'steer:2', actionId: 'steer-action:2', text: 'same text' });
        assert.equal((await h.response('steer:2')).ok, true);
      }
      h.send({ type: 'approval', runId, requestId: `bad:${turn}`, actionId: `bad:${turn}`, askId: ask.event.requestId, decision: { allow: true } });
      assert.equal((await h.response(`bad:${turn}`)).ok, false, 'invalid answer must not consume genuine pending ask');
      for (const [index, decision] of [
        { allow: true, message: 'not-an-option' },
        { allow: true, message: 'yes', extra: true },
        { allow: true, updatedInput: { answers: { first: 'yes', second: 'no' } } },
      ].entries()) {
        const invalidId = `invalid:${turn}:${index}`;
        h.send({ type: 'validate-approval', runId, requestId: invalidId, actionId: invalidId, askId: ask.event.requestId, decision });
        assert.equal((await h.response(invalidId)).ok, false);
      }
      h.send({ type: 'validate-approval', runId, requestId: `validate:${turn}`, actionId: `validate:${turn}`, askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
      assert.equal((await h.response(`validate:${turn}`)).ok, true);
      assert.equal(h.frames.some((f) => f.type === 'event' && f.runId === runId && f.event.kind === 'complete'), false, 'validation does not consume the pending ask');
      h.send({ type: 'approval', runId, requestId: `answer:${turn}`, actionId: `answer:${turn}`, askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
      assert.equal((await h.response(`answer:${turn}`)).ok, true);
      const terminal = await h.event(runId, 'complete');
      assert.equal(terminal.event.exitCode, exitCode);
      // A separate correlated response proves input is still serviced while the terminal is unacked.
      h.send({ type: 'prompt', runId: 'busy-turn', requestId: `barrier:${turn}`, actionId: `barrier:${turn}`, text: 'must not start' });
      assert.equal((await h.response(`barrier:${turn}`)).error, 'busy');
      assert.equal(h.frames.some((f) => f.type === 'response' && f.requestId === requestId), false);
      h.ack(terminal);
      await h.response(requestId);
      const finalTool = h.frames.find((f) => f.type === 'event' && f.runId === runId && f.event.kind === 'tool_result' && f.event.isFinal === true) as ManagedChildEvent;
      assert.deepEqual(finalTool.event.toolUseResult, { turn });
      if (turn === 2) {
        assert.equal((await h.event(runId, 'stream_end')).event.content, 'answer:2');
        assert.ok(h.frames.some((f) => f.type === 'event' && f.runId === runId && f.event.text === 'session_state'));
      }
    }
    const sequences = h.frames.filter((f): f is ManagedChildEvent => f.type === 'event').map((f) => f.eventSeq);
    assert.deepEqual(sequences, sequences.map((_, index) => index + 1));
    h.send({ type: 'close', requestId: 'close', actionId: 'close' });
    assert.equal((await h.response('close')).ok, true);
    assert.equal(await h.exited, 0);
    assert.deepEqual(JSON.parse(await readFile(h.disposalFile, 'utf8')), { creations: 1, turns: 2, steers: 2 });
  } finally { await h.cleanup(); }
});

test('a delayed native title survives prompt settlement and a later retained turn through private IPC', { timeout: 40_000 }, async () => {
  const h = await harness(10_200);
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'late:1', requestId: 'late:1', actionId: 'late:1', text: 'success' });
    const firstAsk = await h.event('late:1', 'permission_request');
    h.send({ type: 'approval', runId: 'late:1', requestId: 'late:answer', actionId: 'late:answer', askId: firstAsk.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('late:answer')).ok, true);
    const firstTerminal = await h.event('late:1', 'complete');
    h.ack(firstTerminal);
    assert.equal((await h.response('late:1')).ok, true);

    // Start another turn before the first title completion. The title must
    // retain its first prompt identity instead of attaching to this stream.
    h.send({ type: 'prompt', runId: 'late:2', requestId: 'late:2', actionId: 'late:2', text: 'success' });
    const secondAsk = await h.event('late:2', 'permission_request');
    const title = await h.event('late:1', 'session_title');
    assert.equal(title.event.title, 'Delayed native title');
    assert.equal(title.requestId, 'late:1');
    assert.equal(title.runId, 'late:1');
    assert.equal(h.frames.filter((frame) => frame.type === 'event' && frame.event.kind === 'session_title').length, 1);

    h.send({ type: 'approval', runId: 'late:2', requestId: 'late:answer:2', actionId: 'late:answer:2', askId: secondAsk.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('late:answer:2')).ok, true);
    const secondTerminal = await h.event('late:2', 'complete');
    h.ack(secondTerminal);
    assert.equal((await h.response('late:2')).ok, true);
    h.send({ type: 'close', requestId: 'late:close', actionId: 'late:close' });
    assert.equal((await h.response('late:close')).ok, true);
    assert.equal(await h.exited, 0);
    assert.deepEqual(JSON.parse(await readFile(h.disposalFile, 'utf8')), { creations: 1, turns: 2, steers: 0 });
  } finally { await h.cleanup(); }
});

test('managed Always remains host-owned and a later changed policy is consulted through another SDK gate', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'permissions', requestId: 'permissions', actionId: 'permissions', text: 'permissions' });
    const first = await h.event('permissions', 'permission_request');
    h.send({ type: 'approval', runId: 'permissions', requestId: 'grant', actionId: 'grant', askId: first.event.requestId, decision: { allow: true, always: true } });
    assert.equal((await h.response('grant')).ok, true);
    // The simulated trusted host changes its policy after the first durable grant.
    // A cached SDK Always would bypass this second request entirely.
    const deadline = Date.now() + 10_000;
    let second: ManagedChildEvent | undefined;
    while (!second && Date.now() < deadline) {
      second = h.frames.find((f): f is ManagedChildEvent => f.type === 'event' && f.runId === 'permissions'
        && f.event.kind === 'permission_request' && f.event.requestId !== first.event.requestId);
      if (!second) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(second, 'changed host policy must receive a fresh gate after Always');
    h.send({ type: 'approval', runId: 'permissions', requestId: 'deny', actionId: 'deny', askId: second.event.requestId, decision: { allow: false, always: true } });
    assert.equal((await h.response('deny')).ok, true);
    const terminal = await h.event('permissions', 'complete');
    assert.equal(terminal.event.exitCode, 0, 'SDK observed allow_once then turn-scoped reject_always');
    h.ack(terminal);
    await h.response('permissions');
    h.child.stdin.end();
    assert.equal(await h.exited, 0);
  } finally { await h.cleanup(); }
});

test('a prompt the SDK rejects outright reports operation_failed with the bounded reason', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'thrown', requestId: 'thrown', actionId: 'thrown', text: 'throw' });
    const terminal = await h.event('thrown', 'complete');
    assert.equal(terminal.event.exitCode, 1);
    assert.equal((await h.event('thrown', 'error')).event.content, 'GJC run failed.');
    h.ack(terminal);
    const response = await h.response('thrown');
    assert.equal(response.ok, false);
    assert.equal(response.error, 'operation_failed');
    assert.match(String(response.detail), /provider rejected the turn: quota exhausted/);
    assert.ok(String(response.detail).length <= 300);
    // The child is still usable afterwards: no turn is stuck active.
    h.send({ type: 'prompt', runId: 'after', requestId: 'after', actionId: 'after', text: 'success' });
    const ask = await h.event('after', 'permission_request');
    h.send({ type: 'approval', runId: 'after', requestId: 'answer:after', actionId: 'answer:after', askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('answer:after')).ok, true);
    h.ack(await h.event('after', 'complete'));
    assert.equal((await h.response('after')).ok, true);
    h.send({ type: 'close', requestId: 'close', actionId: 'close' });
    assert.equal((await h.response('close')).ok, true);
    assert.equal(await h.exited, 0);
  } finally { await h.cleanup(); }
});

test('idle runtime events after a settled turn are journaled as bounded idle records and close stays confirmable', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'settled', requestId: 'settled', actionId: 'settled', text: 'idle-after' });
    const ask = await h.event('settled', 'permission_request');
    h.send({ type: 'approval', runId: 'settled', requestId: 'answer', actionId: 'answer', askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('answer')).ok, true);
    h.ack(await h.event('settled', 'complete'));
    await h.response('settled');
    const settledFrames = h.frames.length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const late = h.frames.slice(settledFrames).filter((f): f is ManagedChildEvent => f.type === 'event');
    // Nothing is presented under the settled identity as a live turn event, and
    // nothing vanishes: each idle report is wrapped, bounded, and the bound is recorded once.
    assert.equal(late.length, 17);
    assert.ok(late.every((f) => f.requestId === 'settled' && f.runId === 'settled' && f.event.kind === 'managed.idle' && f.event.afterActionId === 'settled'));
    const wrapped = late.slice(0, 16).map((f) => (f.event.event as { text?: string; content?: string; message?: string }));
    assert.equal(JSON.stringify(wrapped).includes('idle:late-bookkeeping:0'), true);
    assert.equal(JSON.stringify(wrapped).includes('idle:late-bookkeeping:15'), true);
    assert.equal(JSON.stringify(late).includes('idle:late-bookkeeping:16'), false);
    assert.deepEqual(late[16]!.event, { kind: 'managed.idle', afterActionId: 'settled', omittedAfter: 16 });
    h.send({ type: 'close', requestId: 'close', actionId: 'close' });
    assert.equal((await h.response('close')).ok, true);
    assert.equal(await h.exited, 0);
    assert.deepEqual(JSON.parse(await readFile(h.disposalFile, 'utf8')), { creations: 1, turns: 1, steers: 0 });
  } finally { await h.cleanup(); }
});

test('a tool finishing after its turn settled is never attributed to the next prompt', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'first', requestId: 'first', actionId: 'first', text: 'late-tool' });
    const ask = await h.event('first', 'permission_request');
    h.send({ type: 'approval', runId: 'first', requestId: 'answer', actionId: 'answer', askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('answer')).ok, true);
    h.ack(await h.event('first', 'complete'));
    await h.response('first');
    const settledFrames = h.frames.length;
    // The next prompt is active (blocked on its own ask) when the background
    // tool of the first turn completes.
    h.send({ type: 'prompt', runId: 'second', requestId: 'second', actionId: 'second', text: 'success' });
    const secondAsk = await h.event('second', 'permission_request');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const during = h.frames.slice(settledFrames).filter((f): f is ManagedChildEvent => f.type === 'event');
    const late = during.filter((f) => f.event.kind === 'managed.idle');
    assert.equal(late.length, 1);
    assert.equal(late[0]!.requestId, 'second');
    assert.equal(late[0]!.event.afterActionId, 'first', 'the record names the turn that started the tool');
    const wrapped = late[0]!.event.event as { kind: string; toolId: string; content?: unknown };
    assert.equal(wrapped.kind, 'tool_result');
    assert.equal(wrapped.toolId, 'background:1');
    assert.ok(JSON.stringify(wrapped).includes('late:1'));
    // Nothing of the first turn's tool is presented as a live event of the second turn.
    assert.ok(during.every((f) => f.event.kind === 'managed.idle' || f.event.toolId !== 'background:1'));
    assert.ok(during.some((f) => f.event.kind === 'tool_use' && f.event.toolId === 'tool:2'), 'the second turn\'s own tool events flow normally');
    h.send({ type: 'approval', runId: 'second', requestId: 'answer:second', actionId: 'answer:second', askId: secondAsk.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('answer:second')).ok, true);
    h.ack(await h.event('second', 'complete'));
    assert.equal((await h.response('second')).ok, true);
    h.send({ type: 'close', requestId: 'close', actionId: 'close' });
    assert.equal((await h.response('close')).ok, true);
    assert.equal(await h.exited, 0);
  } finally { await h.cleanup(); }
});

test('more unresolved tool origins than the bound fail the child closed instead of forgetting an origin', { timeout: 30_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'flood', requestId: 'flood', actionId: 'flood', text: 'tool-flood:' + (MANAGED_CHILD_TOOL_ORIGIN_LIMIT + 1) });
    assert.equal(await h.exited, 0);
    const starts = h.frames.filter((f) => f.type === 'event' && f.runId === 'flood' && f.event.kind === 'tool_use');
    assert.equal(starts.length, MANAGED_CHILD_TOOL_ORIGIN_LIMIT, 'every start up to the bound is journaled; the bound-plus-one start is never emitted');
    assert.ok(!h.frames.some((f) => f.type === 'event' && f.event.kind === 'tool_use' && f.event.toolId === 'flood:' + MANAGED_CHILD_TOOL_ORIGIN_LIMIT));
    assert.ok(!h.frames.some((f) => f.type === 'response' && f.runId === 'flood' && f.ok === true), 'the flooded turn never settles as ok');
    assert.equal(JSON.parse(await readFile(h.disposalFile, 'utf8')).turns, 1);
  } finally { await h.cleanup(); }
});

test('actual owner stdin death disposes the retained SDK during a pending ask', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'pending', requestId: 'pending', actionId: 'pending', text: 'success' });
    await h.event('pending', 'permission_request');
    h.child.stdin.end();
    assert.equal(await h.exited, 0);
    assert.deepEqual(JSON.parse(await readFile(h.disposalFile, 'utf8')), { creations: 1, turns: 1, steers: 0 });
  } finally { await h.cleanup(); }
});

test('concurrent abort preserves the retained session and refreshes ask state for the next turn', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'aborting', requestId: 'prompt-abort', actionId: 'prompt-abort', text: 'success' });
    const oldAsk = await h.event('aborting', 'permission_request');
    h.send({ type: 'validate-approval', runId: 'aborting', requestId: 'validate-old', actionId: 'validate-old', askId: oldAsk.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('validate-old')).ok, true);
    h.send({ type: 'abort', runId: 'aborting', requestId: 'abort', actionId: 'abort' });
    assert.equal((await h.response('abort')).ok, true);
    await h.response('prompt-abort');
    h.send({ type: 'prompt', runId: 'recovered', requestId: 'recovered', actionId: 'recovered', text: 'success' });
    const ask = await h.event('recovered', 'permission_request');
    h.send({ type: 'approval', runId: 'recovered', requestId: 'cancelled-old', actionId: 'cancelled-old', askId: oldAsk.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('cancelled-old')).ok, false, 'prior validation is not a reservation');
    h.send({ type: 'approval', runId: 'recovered', requestId: 'answer', actionId: 'answer', askId: ask.event.requestId, decision: { allow: true, message: 'yes' } });
    assert.equal((await h.response('answer')).ok, true);
    const terminal = await h.event('recovered', 'complete');
    assert.equal(terminal.event.exitCode, 0);
    h.ack(terminal);
    await h.response('recovered');
    h.child.stdin.end();
    assert.equal(await h.exited, 0);
    assert.equal(JSON.parse(await readFile(h.disposalFile, 'utf8')).turns, 2);
  } finally { await h.cleanup(); }
});

test('unacknowledged synchronous SDK event burst fails closed rather than retaining an unbounded backlog', { timeout: 20_000 }, async () => {
  const h = await harness();
  try {
    await h.init();
    h.send({ type: 'prompt', runId: 'overflow', requestId: 'overflow', actionId: 'overflow', text: 'overflow' });
    assert.equal(await h.exited, 0);
    assert.ok(h.frames.filter((f) => f.type === 'event' && f.runId === 'overflow').length <= 128);
    assert.equal(JSON.parse(await readFile(h.disposalFile, 'utf8')).turns, 1);
  } finally { await h.cleanup(); }
});

test('private IPC rejects unknown fields, invalid identity, wrong version and unsafe sequence', () => {
  const base = { version: 1, generation: 'g:1', requestId: 'r:1', runId: 'run:1', type: 'ack', eventSeq: 1 };
  for (const extra of [{ version: 2 }, { generation: '' }, { requestId: 'x'.repeat(161) }, { eventSeq: 1.5 }, { bootstrapModule: '/tmp/code.ts' }]) {
    assert.throws(() => parseManagedChildRequest(JSON.stringify({ ...base, ...extra })));
  }
  assert.throws(() => parseManagedChildRequest(' '.repeat(262_145)));
});

test('managed adapter consumes builtins, contains exports and titles only the first native turn on its retained object', async () => {
  const { GjcBunSdkAdapter } = await import('./gjc-bun-sdk-adapter.js');
  const root = await mkdtemp(join(tmpdir(), 'managed-parity-'));
  const previousKey = process.env.GJC_RUNTIME_API_KEY;
  const previousTitle = process.env.GJC_NO_TITLE;
  const previousPiTitle = process.env.PI_NO_TITLE;
  process.env.GJC_RUNTIME_API_KEY = 'test-only';
  delete process.env.GJC_NO_TITLE;
  delete process.env.PI_NO_TITLE;
  const models = [
    { id: 'first', provider: 'test', reasoning: true, thinking: { minLevel: 'low', maxLevel: 'high', levels: ['low', 'high'] } },
    { id: 'second', provider: 'test', reasoning: true, thinking: { minLevel: 'low', maxLevel: 'high', levels: ['low', 'high'] } },
  ];
  const events: any[] = [];
  const prompts: any[] = [];
  const commands: string[] = [];
  let creations = 0;
  let titles = 0;
  let manager: any;
  let session: any;
  const authStorage: any = { exportSnapshot: () => ({ credentials: [] }), setRuntimeApiKey() {}, removeRuntimeApiKey() {} };
  const registry: any = { authStorage, getAll: () => models };
  const adapter = new GjcBunSdkAdapter(authStorage, registry, {
    settings: { cloneForCwd: async () => ({ override() {} }) } as any,
    generateSessionTitle: async () => { titles++; return 'Generated native title'; },
    executeBuiltinCommand: (async (message: string, context: any) => {
      commands.push(message);
      if (message === '/compact expand') return { prompt: 'expanded command prompt' };
      context.output('local command output');
      return { consumed: true };
    }) as any,
    createSessionFactory: (async (input: any) => {
      creations++;
      manager = input.sessionManager;
      session = {
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        setModelTemporary: async (model: any) => { session.model = model; },
        setThinkingLevel: (effort: any) => { session.thinkingLevel = effort; },
        setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
        setSdkPermissionMode() {}, setSdkPermissionProvider() {},
        subscribe: () => () => {},
        prompt: async (text: string) => {
          prompts.push({ text, model: session.model.id, effort: session.thinkingLevel });
          manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
          manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture response' }], timestamp: Date.now() });
          await manager.flush();
        },
        abort: async () => {}, dispose: async () => { await manager.flushAndCloseStrict(); },
      };
      return { session, setToolUIContext() {} };
    }) as any,
  });
  let retained: Awaited<ReturnType<typeof adapter.initializeManagedGjcSession>> | undefined;
  try {
    retained = await adapter.initializeManagedGjcSession('parity', {
      cwd: root, sessionRoot: root, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' },
      modelId: 'first', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] },
    }, { send: (event: unknown) => events.push(event) } as any);
    assert.equal(prompts.length, 0);
    await retained.prompt('/compact');
    await retained.prompt('/export ../outside.html');
    assert.equal(prompts.length, 0);
    assert.deepEqual(commands, ['/compact'], 'escaped export never reaches the handler');
    assert.equal(titles, 0);
    assert.ok(events.some(event => event.isLocalCommandStdout === true));
    await retained.prompt('/compact expand', { modelId: 'first', effort: 'low' });
    await retained.prompt('second native message', { modelId: 'second', effort: 'high' });
    assert.deepEqual(prompts, [
      { text: 'expanded command prompt', model: 'first', effort: 'low' },
      { text: 'second native message', model: 'second', effort: 'high' },
    ]);
    assert.equal(creations, 1);
    assert.equal(titles, 1);
    assert.equal(manager.getSessionName(), 'Generated native title');
    assert.equal(events.filter(event => event.kind === 'session_title').length, 1);
    const history = events.filter(event => event.kind === 'managed.nativehistory').at(-1);
    assert.equal(history.jsonlPath, manager.getSessionFile());
    assert.match(await readFile(history.jsonlPath, 'utf8'), /Generated native title/);
  } finally {
    await retained?.dispose();
    for (const [key, value] of [['GJC_RUNTIME_API_KEY', previousKey], ['GJC_NO_TITLE', previousTitle], ['PI_NO_TITLE', previousPiTitle]]) {
      if (value === undefined) delete process.env[key!];
      else process.env[key!] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
