import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import { bindConsoleInput, ConsoleInputDecoder, ConsoleOutputWriter, parseConsoleLine, renderEvent, renderReceipt, renderRequest, sanitizeConsoleText } from './gjc-herdr-task-console.js';

const context = { appSessionId: 'app', ownerGeneration: 'gen', stateRevision: 9 };
const target = 'app/gen/provider/turn/request';
const parse = (line: string) => parseConsoleLine(line, context);

test('literal grammar consumes every token and requires JSON text', () => {
  for (const line of [':status x', ':help x', ':ack a extra', ':abort a t extra', ':followup a bare', ':followup a "ok" trailing', ':followup a "unterminated', ':followup a "ok""again"', ':followup a {}', ':followup a null', ':followup a ["x"]', ':prompt a 1.0 "x"', ':prompt a -1 "x"', ':prompt a 9007199254740992 "x"', ':prompt a 01 "x"', ':abort "a" turn', ':abort a ../turn', ':steer a turn "x" extra', `:permission a ${target} 1 allow`, `:permission a ${target} 1 deny-once extra`, ':answer a request "x"', `:answer a ${target} [1]`, `:answer a ${target} ["x",]`, ':unknown a', ':followup a "\\u0000"', ':followup a "\\u202e"', ':followup a "\\ud800"']) {
    assert.equal(parse(line).ok, false, line);
  }
  for (const line of [':prompt a 2 "오래된 재시도"', ':followup a "한국어 😀"', ':steer a turn "x"', ':abort a turn', `:answer a ${target} ["opt-1","opt-3"]`, `:permission a ${target} 12 allow-once`]) assert.equal(parse(line).ok, true, line);
});

test('read operations carry no ledger command or synthetic action ID', () => {
  assert.deepEqual(parse(':status'), { ok: true, type: 'query', query: 'status', safeEcho: ':status' });
  const ack = parse(`:ack ${'a'.repeat(64)}`);
  assert.equal(ack.ok && ack.type === 'query' && ack.actionId, 'a'.repeat(64));
  assert.equal('command' in ack, false);
});

test('decoded line and UTF8 byte bounds are enforced with no secret echo', () => {
  assert.equal(parse(`:followup a ${JSON.stringify('한'.repeat(23000))}`).ok, false);
  assert.equal(parse(`:followup a ${JSON.stringify('x\n'.repeat(256))}`).ok, false);
  assert.equal(parse(`:followup a ${JSON.stringify('x\n'.repeat(255))}`).ok, true);
  const answer = parse(`:answer a ${target} "secret answer"`);
  assert.equal(answer.ok && answer.safeEcho, ':answer a');
});

test('resume accepts only a host-resolved exact binding', () => {
  assert.equal(parse(`:resume a ${target} cap approve`).ok, false);
  const binding = { requestId: target, capabilityGeneration: 'cap', operationId: 'op', argumentsHash: 'trusted', decision: 'approve' };
  const result = parseConsoleLine(`:resume a ${target} cap approve`, { ...context, resolveResume(identity, capability, decision) {
    assert.equal(identity, target); assert.equal(capability, 'cap'); assert.equal(decision, 'approve'); return binding;
  } });
  assert.equal(result.ok && result.type === 'command' && result.command.payload, binding);
  assert.equal(parseConsoleLine(`:resume a ${target} cap approve spoof`, { ...context, resolveResume() { throw new Error('must not run'); } }).ok, false);
});

test('strict UTF8 split at every byte, CRLF and repeated Enter submit once', () => {
  const decoder = new ConsoleInputDecoder();
  const events = [...Buffer.from(':followup a "한글 😀"\r\n\n')].flatMap(byte => decoder.feed(Uint8Array.of(byte)));
  assert.deepEqual(events, [{ type: 'line', line: ':followup a "한글 😀"' }]);
  assert.deepEqual(decoder.end(), []);
});

test('split bracketed paste is only a draft and pasted newlines never execute', () => {
  const decoder = new ConsoleInputDecoder();
  const events = [...Buffer.from('\x1b[200~:abort a turn\n:abort b turn\x1b[201~')].flatMap(byte => decoder.feed(Uint8Array.of(byte)));
  assert.deepEqual(events, []);
  assert.deepEqual(decoder.feed(Buffer.from('\n')), [{ type: 'reject', reason: 'invalid_input' }]);
  assert.deepEqual(decoder.feed(Buffer.from('\x1b[200~:followup c "one\\ntwo"\x1b[201~')), []);
  assert.deepEqual(decoder.feed(Buffer.from('\n')), [{ type: 'line', line: ':followup c "one\\ntwo"' }]);
});

test('malformed bytes, controls and overflow reject entire draft then recover', () => {
  for (const bad of [Buffer.from([0xff]), Buffer.from('\x00'), Buffer.from('\x1b[999~'), Buffer.alloc(65537, 97)]) {
    const decoder = new ConsoleInputDecoder();
    assert.deepEqual(decoder.feed(bad), []);
    assert.deepEqual(decoder.feed(Buffer.from(':abort a turn\n')), [{ type: 'reject', reason: 'invalid_input' }]);
    assert.deepEqual(decoder.feed(Buffer.from(':status\n')), [{ type: 'line', line: ':status' }]);
  }
  const decoder = new ConsoleInputDecoder();
  decoder.feed(Buffer.from([0xe3]));
  assert.deepEqual(decoder.end(), [{ type: 'reject', reason: 'incomplete_input' }]);
});

test('Escape and Ctrl-C cancel drafts; Ctrl-D cannot submit or shut down', () => {
  const decoder = new ConsoleInputDecoder();
  assert.deepEqual(decoder.feed(Buffer.from(':abort a turn\x03\n')), []);
  assert.deepEqual(decoder.feed(Buffer.from(':abort a turn\x1b\n')), []);
  assert.deepEqual(decoder.feed(Buffer.from(':abort a turn\x04\n')), [{ type: 'reject', reason: 'invalid_input' }]);
});

test('stream EOF and errors detach without executing unfinished drafts', () => {
  for (const error of [false, true]) {
    const input = new PassThrough(); let detaches = 0; const events: unknown[] = [];
    bindConsoleInput(input, event => events.push(event), () => { detaches++; });
    input.write(':abort a turn');
    input.emit(error ? 'error' : 'end', ...(error ? [new Error('private diagnostic')] : []));
    assert.equal(detaches, 1);
    assert.deepEqual(events, [{ type: 'reject', reason: 'incomplete_input' }]);
  }
});

test('allowlist rendering never serializes request schema, answers or raw frames', () => {
  const request = { identity: target, kind: 'ask' as const, policyRevision: 2, question: 'sensitive prompt', schema: { secret: true, answer: 'hidden', token: 'credential' } };
  assert.equal(renderRequest(request), `REQUEST ask ${target} 2\n[secret request: non-echo input required]`);
  assert.equal(renderRequest({ ...request, schema: { properties: { answer: { secret: true } } } }), `REQUEST ask ${target} 2\n[secret request: non-echo input required]`);
  const publicRequest = renderRequest({ ...request, schema: { answer: 'hidden', path: '/private/key' }, question: '한국어 질문', options: [{ id: 'opt', label: 'credential', secret: true }] });
  assert.match(publicRequest, /한국어 질문/);
  for (const value of ['hidden', '/private/key', 'credential']) assert.equal(publicRequest.includes(value), false);
  assert.equal(renderEvent({ kind: 'sdk.event', text: 'raw frame' }), null);
  assert.equal(renderEvent({ kind: 'conversation', text: 'known secret', secret: true }), '[redacted]');
  assert.equal(renderEvent({ kind: 'conversation', text: '한국어 token' }, ['token']), '한국어 [redacted]');
  assert.equal(renderReceipt({ actionId: 'a', state: '\x1b[2J', seq: 1 }), 'ACK a unknown 1');
});

test('sanitizer removes terminated and unterminated terminal control strings with UTF8 bounds', () => {
  for (const sequence of ['\x1b]52;c;clipboard', '\x1bPprivate', '\x1b]8;;url\x07', '\x1b[2J', '\u009Dclipboard\u009C', '\x1b[31']) {
    const text = sanitizeConsoleText(`안녕${sequence}`);
    assert.equal(text, '안녕');
  }
  assert.equal(sanitizeConsoleText('한\u202E글'), '한글');
  assert.equal(Buffer.byteLength(sanitizeConsoleText('한'.repeat(9000))), 8190);
});

test('bounded output disconnects on critical overflow and handles drain', () => {
  const pending: (() => void)[] = []; const blocks: string[] = [];
  const output = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) { blocks.push(chunk.toString()); pending.push(callback); } });
  const reasons: string[] = []; const writer = new ConsoleOutputWriter(output, reason => reasons.push(reason));
  assert.equal(writer.write('ACK a settled 1', 'critical'), true);
  assert.equal(writer.write('ACK b settled 2', 'critical'), true);
  assert.equal(blocks.length, 1);
  pending.shift()!();
  output.emit('drain');
  assert.equal(blocks.length, 2);
  for (let i = 0; i < 10; i++) writer.write('x'.repeat(8000), 'critical');
  assert.deepEqual(reasons, ['critical_output_overflow']);
  assert.equal(writer.write('ACK c settled 3', 'critical'), false);
});
