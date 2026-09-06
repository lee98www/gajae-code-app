import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { ManagedChildTransport } from './gjc-herdr-child-client.js';

function fixture(onEvent: ConstructorParameters<typeof ManagedChildTransport>[2]) {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() {} });
  const writes: Record<string, unknown>[] = [];
  child.stdin.on('data', (line) => writes.push(JSON.parse(String(line))));
  const transport = new ManagedChildTransport(child as unknown as ChildProcessWithoutNullStreams, 'g', onEvent);
  const emit = (frame: object) => child.stdout.write(`${JSON.stringify({ version: 1, generation: 'g', ...frame })}\n`);
  return { child, writes, transport, emit };
}
const prompt = { version: 1 as const, generation: 'g', requestId: 'p', runId: 'p', type: 'prompt' as const, actionId: 'p', text: 'same' };

test('correlated control completes before prompt; event persistence precedes cumulative ack', async () => {
  let persist!: () => void;
  const f = fixture(() => new Promise<void>((resolve) => { persist = resolve; }));
  const p = f.transport.request(prompt);
  const control = f.transport.request({ ...prompt, requestId: 's', type: 'steer', actionId: 's' });
  f.emit({ type: 'event', requestId: 'p', runId: 'p', eventSeq: 1, event: { kind: 'text', text: 'live' } });
  f.emit({ type: 'response', requestId: 's', runId: 'p', ok: true });
  assert.equal((await control).ok, true);
  await Promise.resolve();
  assert.equal(f.writes.some((frame) => frame.type === 'ack'), false);
  persist();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.writes.at(-1)?.eventSeq, 1);
  f.emit({ type: 'response', requestId: 'p', runId: 'p', ok: true });
  assert.equal((await p).ok, true);
});

test('waiter exists before synchronous response during write', async () => {
  const f = fixture(() => {});
  f.child.stdin.on('data', () => f.emit({ type: 'response', requestId: 'p', runId: 'p', ok: true }));
  assert.equal((await f.transport.request(prompt)).ok, true);
});

test('EOF rejects all correlated pending requests', async () => {
  const f = fixture(() => {});
  const p = f.transport.request(prompt);
  const s = f.transport.request({ ...prompt, type: 'steer', requestId: 's', actionId: 's' });
  f.child.stdout.end();
  await Promise.all([assert.rejects(p), assert.rejects(s)]);
  await assert.rejects(f.transport.request({ ...prompt, requestId: 'other' }));
});

test('wrong generation and wrong run reject instead of settling another request', async () => {
  for (const mismatch of [{ generation: 'old' }, { runId: 'old' }]) {
    const f = fixture(() => {});
    const p = f.transport.request(prompt);
    f.emit({ type: 'response', requestId: 'p', runId: 'p', ok: true, ...mismatch });
    await assert.rejects(p);
  }
});

test('close waits both correlated response and process exit', async () => {
  const f = fixture(() => {});
  let done = false;
  const closing = f.transport.close({ version: 1, generation: 'g', requestId: 'c', runId: 'c', type: 'close', actionId: 'c' }).then(() => { done = true; });
  f.emit({ type: 'response', requestId: 'c', runId: 'c', ok: true });
  await Promise.resolve();
  assert.equal(done, false);
  f.child.emit('exit', 0, null);
  await closing;
  assert.equal(done, true);
});

test('persistence rejection never acknowledges and rejects active operations', async () => {
  const f = fixture(() => { throw new Error('disk failure'); });
  const p = f.transport.request(prompt);
  f.emit({ type: 'event', requestId: 'p', runId: 'p', eventSeq: 1, event: { kind: 'permission_request', requestId: 'ask' } });
  await assert.rejects(p);
  assert.equal(f.writes.some((frame) => frame.type === 'ack'), false);
});

test('oversized unfinished frames and process errors clean pending requests', async () => {
  const oversized = fixture(() => {});
  const first = oversized.transport.request(prompt);
  oversized.child.stdout.write('x'.repeat(262_145));
  await assert.rejects(first);
  const failed = fixture(() => {});
  const second = failed.transport.request(prompt);
  failed.child.emit('error', new Error('private details'));
  await assert.rejects(second, /Managed child process failed/);
});

test('parallel prompt cannot poison active stream and early terminal waits for persistence', async () => {
  let persist!: () => void;
  const f = fixture(() => new Promise<void>((resolve) => { persist = resolve; }));
  let completed = false;
  const p = f.transport.request(prompt).then(() => { completed = true; });
  await assert.rejects(f.transport.request({ ...prompt, requestId: 'busy', runId: 'busy', actionId: 'busy' }), /active event stream/);
  f.emit({ type: 'event', requestId: 'p', runId: 'p', eventSeq: 1, event: { kind: 'complete' } });
  f.emit({ type: 'response', requestId: 'p', runId: 'p', ok: true });
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(f.writes.some((frame) => frame.type === 'ack'), false);
  persist();
  await p;
  assert.equal(f.writes.at(-1)?.type, 'ack');
});

test('oversized complete multibyte frame rejects every waiter', async () => {
  const f = fixture(() => {});
  const p = f.transport.request(prompt);
  const s = f.transport.request({ ...prompt, type: 'steer', requestId: 's', actionId: 's' });
  f.emit({ type: 'event', requestId: 'p', runId: 'p', eventSeq: 1, event: { text: '界'.repeat(90_000) } });
  await Promise.all([assert.rejects(p), assert.rejects(s)]);
});
