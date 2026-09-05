import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Duplex } from 'node:stream';

import { HerdrClient, HERDR_MAX_OUTPUT_BYTES, HerdrRpcError } from './herdr-client.js';

class FakeSocket extends Duplex {
  writes: string[] = [];
  constructor(private readonly onWriteLine: (line: string, socket: FakeSocket) => void) { super(); }
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    this.writes.push(chunk.toString('utf8'));
    this.onWriteLine(chunk.toString('utf8').trim(), this);
    callback();
  }
  reply(value: unknown) { this.push(`${JSON.stringify(value)}\n`); }
}

describe('HerdrClient', () => {
  it('uses one string-id JSON RPC and decodes session snapshots', async () => {
    let socket!: FakeSocket;
    const client = new HerdrClient('/tmp/herdr.sock', () => {
      socket = new FakeSocket((line, current) => {
        const request = JSON.parse(line);
        assert.equal(request.method, 'session.snapshot');
        assert.equal(typeof request.id, 'string');
        current.reply({ id: request.id, result: { type: 'session_snapshot', snapshot: {
          version: 'test', protocol: 1, layouts: [], agents: [],
          workspaces: [{ workspace_id: 'w1', number: 1, label: 'Main', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }],
          tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'idle' }],
          panes: [{ pane_id: 'p1', terminal_id: 'term1', workspace_id: 'w1', tab_id: 't1', focused: true, cwd: '/repo', agent: 'gjc', agent_status: 'idle' }],
        } } });
      });
      return socket;
    });

    const snapshot = await client.snapshot();
    assert.equal(snapshot.panes[0]?.pane_id, 'p1');
    assert.equal(snapshot.panes[0]?.terminal_id, 'term1');
    assert.match(socket.writes[0]!, /"method":"session.snapshot"/);
  });

  it('reads visible plain text, never recent scrollback', async () => {
    const client = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      assert.equal(request.method, 'pane.read');
      assert.deepEqual(request.params, { pane_id: 'p1', source: 'visible', lines: 400, format: 'text' });
      current.reply({ id: request.id, result: { type: 'pane_read', read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', text: '<script>nope</script>', truncated: false, revision: 0 } } });
    }));

    const read = await client.readPane('p1', 400);
    assert.equal(read.text, '<script>nope</script>');
    assert.equal(read.truncated, false);
  });

  it('sends explicit input with only pane_id, text and keys', async () => {
    const calls: unknown[] = [];
    const client = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      calls.push(request);
      current.reply({ id: request.id, result: { type: 'ok' } });
    }));

    await client.sendInput('p1', 'hello', ['Enter']);
    assert.deepEqual((calls[0] as any).params, { pane_id: 'p1', text: 'hello', keys: ['Enter'] });
  });

  it('rejects Herdr error frames and mismatched ids', async () => {
    const errorClient = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((line, current) => {
      const request = JSON.parse(line);
      current.reply({ id: request.id, error: { code: 'invalid_request', message: 'bad' } });
    }));
    await assert.rejects(errorClient.snapshot(), (error: unknown) => error instanceof HerdrRpcError && error.rpcCode === 'invalid_request' && error.rpcMessage === 'bad' && error.status === 502);

    const mismatchClient = new HerdrClient('/tmp/herdr.sock', () => new FakeSocket((_line, current) => {
      current.reply({ id: 'other', result: { snapshot: { workspaces: [], tabs: [], panes: [] } } });
    }));
    await assert.rejects(mismatchClient.snapshot(), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
  });

  it('rejects malformed matching-id acknowledgements and untagged method results', async () => {
    for (const result of [null, {}, { type: 'pane_read' }, { type: 'ok', snapshot: {} }]) {
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, result })));
      if (result && 'type' in result && result.type === 'ok') {
        await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
      } else {
        await assert.rejects(client.sendInput('p1', 'hello', []), { code: 'HERDR_INVALID_RESPONSE' });
      }
    }
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, result: { snapshot: { workspaces: [], tabs: [], panes: [] } } })));
    await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE' });
  });

  it('caps multibyte output at a complete UTF-8 boundary', async () => {
    const text = '한😀'.repeat(80_000);
    const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({
      id: JSON.parse(line).id,
      result: { type: 'pane_read', read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', revision: 1, truncated: false, text } },
    })));
    const read = await client.readPane('p1', 400);
    assert.ok(Buffer.byteLength(read.text) <= HERDR_MAX_OUTPUT_BYTES);
    assert.ok(text.endsWith(read.text));
    assert.ok(!read.text.includes('�'));
    assert.equal(read.truncated, true);
  });

  it('rejects missing required wire fields and malformed error frames as upstream failures', async () => {
    const malformed = [
      { result: { type: 'session_snapshot', snapshot: { workspaces: [], tabs: [], panes: [] } } },
      { result: { type: 'pane_read', read: { pane_id: 'p1', text: 'looks valid', truncated: false } } },
      { error: { code: 'pane_not_found' } },
      { error: { code: 'pane_not_found', message: 'secret' }, result: { type: 'ok' } },
    ];
    for (const response of malformed) {
      const client = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, ...response })));
      await assert.rejects(client.snapshot(), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
    }
    const readClient = new HerdrClient('/unused', () => new FakeSocket((line, socket) => socket.reply({ id: JSON.parse(line).id, ...malformed[1] })));
    await assert.rejects(readClient.readPane('p1', 400), { code: 'HERDR_INVALID_RESPONSE', status: 502 });
  });

  it('checks cancellation both before connecting and immediately before writing', async () => {
    const controller = new AbortController();
    controller.abort();
    let connects = 0;
    const client = new HerdrClient('/unused', () => { connects++; throw new Error('must not connect'); });
    await assert.rejects(client.snapshot(controller.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(connects, 0);
    const duringConnect = new AbortController();
    const socket = new FakeSocket(() => { throw new Error('must not write'); });
    const cancelled = new HerdrClient('/unused', () => { duringConnect.abort(); return socket; });
    await assert.rejects(cancelled.sendInput('p1', 'hello', [], duringConnect.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(socket.writes.length, 0);
    assert.equal(socket.destroyed, true);
  });

  it('aborts pending transport and reports timeout without retrying input', async () => {
    const controller = new AbortController();
    let socket!: FakeSocket;
    const client = new HerdrClient('/unused', () => (socket = new FakeSocket(() => controller.abort())));
    await assert.rejects(client.snapshot(controller.signal), { code: 'HERDR_CANCELLED' });
    assert.equal(socket.writes.length, 1);
    const timeout = new HerdrClient('/unused', () => (socket = new FakeSocket(() => {})), 1);
    await assert.rejects(timeout.sendInput('p1', 'hello', []), { code: 'HERDR_TIMEOUT', status: 504 });
    assert.equal(socket.writes.length, 1);
    assert.equal(socket.destroyed, true);
  });
});
