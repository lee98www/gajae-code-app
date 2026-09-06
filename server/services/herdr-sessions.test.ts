import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import net from 'node:net';
import { once } from 'node:events';

import { HERDR_INPUT_MAX_BYTES, herdrInputRequestSchema } from '../../shared/herdr-protocol.js';
import { HerdrSessionsService } from '../modules/herdr/index.js';

type Reply = (request: any) => unknown;

class FakeSocket extends Duplex {
  constructor(private readonly replyFor: Reply, private readonly calls: any[]) { super(); }
  _read() {}
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
    const request = JSON.parse(chunk.toString('utf8').trim());
    this.calls.push(request);
    const reply = this.replyFor(request);
    if (reply !== null) this.push(`${JSON.stringify({ id: request.id, result: reply })}\n`);
    callback();
  }
}

const snapshot = (terminalId = 'term1') => ({ type: 'session_snapshot', snapshot: {
  version: 'test', protocol: 1, layouts: [], agents: [],
  workspaces: [{ workspace_id: 'w1', number: 1, label: 'Main', focused: true, pane_count: 1, tab_count: 1, active_tab_id: 't1', agent_status: 'idle' }],
  tabs: [{ tab_id: 't1', workspace_id: 'w1', number: 1, label: '1', focused: true, pane_count: 1, agent_status: 'idle' }],
  panes: [{ pane_id: 'p1', terminal_id: terminalId, workspace_id: 'w1', tab_id: 't1', focused: true, cwd: '/tmp/project', agent: 'gjc', agent_status: 'idle' }],
} });

describe('HerdrSessionsService', () => {
  let tmp = '';
  let calls: any[] = [];
  let originalSocketPath: string | undefined;

  beforeEach(async () => {
    originalSocketPath = process.env.HERDR_SOCKET_PATH;
    delete process.env.HERDR_SOCKET_PATH;
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-herdr-'));
    await fs.mkdir(path.join(tmp, 'herdr', 'sessions', 'work'), { recursive: true });
    await fs.writeFile(path.join(tmp, 'herdr', 'herdr.sock'), '');
    await fs.writeFile(path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock'), '');
    calls = [];
  });

  afterEach(async () => {
    if (originalSocketPath === undefined) delete process.env.HERDR_SOCKET_PATH;
    else process.env.HERDR_SOCKET_PATH = originalSocketPath;
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('discovers default and named current-user sockets without probing lifecycle', async () => {
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => new FakeSocket(() => snapshot(), calls), bootId: 'boot', allowNonSocketForTests: true });
    const sessions = await service.listSessions();
    assert.deepEqual(sessions.map((session) => session.name), ['default', 'work']);
    assert.equal(calls.length, 0);
  });

  it('requires selection for ambiguous admitted instances and exports no endpoint paths', async () => {
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true });
    const ambiguous = await service.provisioningSelection(null);
    assert.equal(ambiguous.status, 'selection_required');
    assert.equal(ambiguous.selectedSessionName, null);
    assert.ok(Object.isFrozen(ambiguous.instances));
    assert.ok(!JSON.stringify(ambiguous).includes(tmp));
    await fs.unlink(path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock'));
    const single = await service.provisioningSelection(null);
    assert.equal(single.selectedSessionName, 'default');
    assert.equal(single.status, 'unknown');
    const selectedMissing = await service.provisioningSelection('work');
    assert.equal(selectedMissing.selectedSessionName, 'work');
    assert.equal(selectedMissing.status, 'unavailable');
  });

  it('freezes provisioning identity and refuses socket replacement immediately before dispatch', async () => {
    let socket: FakeSocket & { connecting?: boolean } | undefined;
    const service = new HerdrSessionsService({
      configHome: tmp, allowNonSocketForTests: true,
      connector: () => {
        socket = new FakeSocket(() => { throw new Error('Must not dispatch'); }, calls);
        socket.connecting = true;
        return socket;
      },
    });
    const handle = await service.openProvisioningHandle('default');
    assert.ok(Object.isFrozen(handle));
    assert.ok(Object.isFrozen(handle.identity));
    assert.equal(handle.identity.canonicalPath, await fs.realpath(path.join(tmp, 'herdr', 'herdr.sock')));
    assert.equal('request' in handle, false);
    const pending = handle.createWorkspace('/repo', 'Owned');
    const rejection = assert.rejects(pending, { code: 'HERDR_STALE_OBSERVATION' });
    while (!socket) await new Promise<void>((resolve) => setImmediate(resolve));
    const socketPath = path.join(tmp, 'herdr', 'herdr.sock');
    await fs.rename(socketPath, `${socketPath}.old`);
    await fs.writeFile(socketPath, '');
    socket.emit('connect');
    await rejection;
    assert.equal(calls.length, 0);
  });

  it('creates stable observation tokens across ordinary one-shot close', async () => {
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => new FakeSocket(() => snapshot('term1'), calls), bootId: 'boot', allowNonSocketForTests: true });
    const first = await service.snapshot('default');
    const second = await service.snapshot('default');
    assert.equal(first.panes[0]?.observationToken, second.panes[0]?.observationToken);
  });

  it('rejects stale terminal observations before input and sends zero input calls', async () => {
    let terminalId = 'term1';
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => new FakeSocket((request) => {
      if (request.method === 'session.snapshot') return snapshot(terminalId);
      if (request.method === 'pane.send_input') return { type: 'ok' };
      throw new Error('unexpected');
    }, calls), bootId: 'boot', allowNonSocketForTests: true });
    const first = await service.snapshot('default');
    terminalId = 'term2';
    await assert.rejects(service.input('default', 'p1', {
      action: 'text-enter',
      text: 'hello',
      terminalId: first.panes[0]!.terminalId,
      observationToken: first.panes[0]!.observationToken,
    }), /changed|stale/);
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 0);
  });

  it('serializes same-target input and rejects control text', async () => {
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => new FakeSocket((request) => {
      if (request.method === 'session.snapshot') return snapshot();
      if (request.method === 'pane.send_input') return { type: 'ok' };
      return null;
    }, calls), bootId: 'boot', allowNonSocketForTests: true });
    const observed = await service.snapshot('default');
    await assert.rejects(service.input('default', 'p1', {
      action: 'text',
      text: 'bad\ninput',
      terminalId: observed.panes[0]!.terminalId,
      observationToken: observed.panes[0]!.observationToken,
    }), /one line/);
    await service.input('default', 'p1', {
      action: 'text-enter',
      text: 'hello',
      terminalId: observed.panes[0]!.terminalId,
      observationToken: observed.panes[0]!.observationToken,
    });
    assert.deepEqual(calls.find((call) => call.method === 'pane.send_input')?.params, { pane_id: 'p1', text: 'hello', keys: ['Enter'] });
  });

  it('shares strict action, controls and UTF-8 validation before connecting', async () => {
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => { throw new Error('must not connect'); }, allowNonSocketForTests: true });
    const base = { terminalId: 'term1', observationToken: 'token1' };
    for (const text of ['\t', '\r', '\n', '\x1b', '\x7f', '\u0085', '\u009f', '\u2028', '\u2029', '한'.repeat(Math.ceil(HERDR_INPUT_MAX_BYTES / 3))]) {
      const request = { ...base, action: 'text' as const, text };
      assert.equal(herdrInputRequestSchema.safeParse(request).success, false);
      await assert.rejects(service.input('default', 'p1', request));
    }
    for (const action of ['text', 'text-enter'] as const) {
      assert.equal(herdrInputRequestSchema.safeParse({ ...base, action, text: '' }).success, false);
    }
    for (const action of ['enter', 'escape'] as const) {
      assert.equal(herdrInputRequestSchema.safeParse({ ...base, action, text: 'discarded?' }).success, false);
    }
    assert.equal(herdrInputRequestSchema.safeParse({ ...base, action: 'text', text: '😀'.repeat(HERDR_INPUT_MAX_BYTES / 4) }).success, true);
  });

  it('uses an explicit socket override as one endpoint and deduplicates hard-link aliases', async () => {
    const options = { configHome: tmp, allowNonSocketForTests: true };
    const explicit = new HerdrSessionsService({ ...options, envSocketPath: path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock') });
    assert.deepEqual((await explicit.listSessions()).map((entry) => entry.name), ['default']);
    await fs.unlink(path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock'));
    await fs.link(path.join(tmp, 'herdr', 'herdr.sock'), path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock'));
    assert.deepEqual((await new HerdrSessionsService(options).listSessions()).map((entry) => entry.name), ['default']);
  });

  it('keeps a physical endpoint input guard when an alias moves from default to named', async () => {
    const defaultSocket = path.join(tmp, 'herdr', 'herdr.sock');
    const namedSocket = path.join(tmp, 'herdr', 'sessions', 'work', 'herdr.sock');
    await fs.unlink(namedSocket);
    await fs.link(defaultSocket, namedSocket);

    let heldInput: FakeSocket | undefined;
    let inputStarted!: () => void;
    const inputReady = new Promise<void>((resolve) => { inputStarted = resolve; });
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new FakeSocket((request) => {
        if (request.method === 'session.snapshot') return snapshot();
        if (request.method === 'pane.send_input') {
          if (heldInput) return { type: 'ok' };
          heldInput = socket;
          inputStarted();
          return null;
        }
        throw new Error(`unexpected ${request.method}`);
      }, calls);
      return socket;
    } });

    assert.deepEqual((await service.listSessions()).map((entry) => entry.name), ['default']);
    const pane = (await service.snapshot('default')).panes[0]!;
    const first = service.input('default', 'p1', { action: 'text', text: 'held', terminalId: pane.terminalId, observationToken: pane.observationToken });
    await inputReady;

    await fs.unlink(defaultSocket);
    const namedPane = (await service.snapshot('work')).panes[0]!;
    await assert.rejects(service.input('work', 'p1', { action: 'text', text: 'blocked', terminalId: namedPane.terminalId, observationToken: namedPane.observationToken }), { code: 'HERDR_INPUT_IN_FLIGHT' });
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 1);

    heldInput!.push(`${JSON.stringify({ id: calls.find((call) => call.method === 'pane.send_input')!.id, result: { type: 'ok' } })}\n`);
    await first;
    await service.input('work', 'p1', { action: 'text', text: 'after', terminalId: namedPane.terminalId, observationToken: namedPane.observationToken });
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 2);
  });

  it('rejects root/session ancestor escapes and final socket symlinks without connecting', async () => {
    const outside = path.join(tmp, 'outside');
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'herdr.sock'), '');
    await fs.rename(path.join(tmp, 'herdr', 'sessions'), path.join(tmp, 'saved-sessions'));
    await fs.symlink(path.join(tmp, 'saved-sessions'), path.join(tmp, 'herdr', 'sessions'));
    let connects = 0;
    const service = new HerdrSessionsService({ configHome: tmp, connector: () => { connects++; throw new Error('not admitted'); }, allowNonSocketForTests: true });
    assert.deepEqual((await service.listSessions()).map((entry) => entry.name), ['default']);
    await fs.unlink(path.join(tmp, 'herdr', 'herdr.sock'));
    await fs.symlink(path.join(outside, 'herdr.sock'), path.join(tmp, 'herdr', 'herdr.sock'));
    await assert.rejects(service.snapshot('default'), { code: 'HERDR_UNAVAILABLE' });
    await fs.rename(path.join(tmp, 'herdr'), path.join(tmp, 'saved-root'));
    await fs.symlink(path.join(tmp, 'saved-root'), path.join(tmp, 'herdr'));
    assert.deepEqual(await service.listSessions(), []);
    assert.equal(connects, 0);
  });

  it('admits a real current-user socket and rejects its replacement by a regular file', async () => {
    const socketPath = path.join(tmp, 'real.sock');
    const server = net.createServer();
    server.listen(socketPath);
    await once(server, 'listening');
    const service = new HerdrSessionsService({ envSocketPath: socketPath });
    try {
      assert.equal((await service.listSessions())[0]?.status, 'unknown');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
    await fs.writeFile(socketPath, '');
    await assert.rejects(service.snapshot('default'), { code: 'HERDR_UNAVAILABLE' });
  });

  it('rejects a socket owned by a different UID before connecting', async (context) => {
    const owner = (await fs.stat(path.join(tmp, 'herdr', 'herdr.sock'))).uid;
    assert.equal(typeof process.getuid, 'function');
    context.mock.method(process as NodeJS.Process & { getuid: () => number }, 'getuid', () => owner + 1);
    let connects = 0;
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => { connects++; throw new Error('must not connect'); } });
    await assert.rejects(service.snapshot('default'), { code: 'HERDR_UNAVAILABLE' });
    assert.equal(connects, 0);
  });

  it('discards out-of-order snapshots and failures without revoking a newer observation', async () => {
    const pending: { request: any; socket: Duplex }[] = [];
    let notify: (() => void) | undefined;
    const waitFor = async (count: number) => {
      while (pending.length < count) await new Promise<void>((resolve) => { notify = resolve; });
    };
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) { pending.push({ request: JSON.parse(chunk.toString()), socket }); notify?.(); callback(); },
      });
      return socket;
    } });
    const first = service.snapshot('default');
    const firstRejected = assert.rejects(first, { code: 'HERDR_STALE_OBSERVATION' });
    await waitFor(1);
    const second = service.snapshot('default');
    await waitFor(2);
    pending[1]!.socket.push(`${JSON.stringify({ id: pending[1]!.request.id, result: snapshot('term2') })}\n`);
    const newer = await second;
    pending[0]!.socket.push(`${JSON.stringify({ id: pending[0]!.request.id, result: snapshot('term1') })}\n`);
    await firstRejected;
    const failing = service.snapshot('default');
    const failureRejected = assert.rejects(failing, { code: 'HERDR_UNAVAILABLE' });
    await waitFor(3);
    const recovered = service.snapshot('default');
    await waitFor(4);
    pending[3]!.socket.push(`${JSON.stringify({ id: pending[3]!.request.id, result: snapshot('term2') })}\n`);
    const recovery = await recovered;
    pending[2]!.socket.destroy(new Error('late failure'));
    await failureRejected;
    assert.equal(recovery.panes[0]?.observationToken, newer.panes[0]?.observationToken);
    const final = service.snapshot('default');
    await waitFor(5);
    pending[4]!.socket.push(`${JSON.stringify({ id: pending[4]!.request.id, result: snapshot('term2') })}\n`);
    assert.equal((await final).panes[0]?.observationToken, recovery.panes[0]?.observationToken);
    assert.equal((await service.listSessions())[0]?.generation, recovery.session.generation);
    for (const failure of [false, true]) {
      const offset = pending.length;
      const obsolete = service.snapshot('default');
      const obsoleteRejected = assert.rejects(obsolete, { code: failure ? 'HERDR_UNAVAILABLE' : 'HERDR_STALE_OBSERVATION' });
      await waitFor(offset + 1);
      const socketPath = path.join(tmp, 'herdr', 'herdr.sock');
      await fs.rename(socketPath, `${socketPath}.${offset}`);
      await fs.writeFile(socketPath, '');
      const current = service.snapshot('default');
      await waitFor(offset + 2);
      pending[offset + 1]!.socket.push(`${JSON.stringify({ id: pending[offset + 1]!.request.id, result: snapshot('term3') })}\n`);
      const committed = await current;
      if (failure) pending[offset]!.socket.destroy(new Error('obsolete generation failed'));
      else pending[offset]!.socket.push(`${JSON.stringify({ id: pending[offset]!.request.id, result: snapshot('term1') })}\n`);
      await obsoleteRejected;
      const listed = (await service.listSessions())[0]!;
      assert.equal(listed.generation, committed.session.generation);
      assert.equal(listed.status, 'available');
    }
  });

  it('cancels pending preflight with zero input dispatches and revokes the old token', async () => {
    let hold = false;
    let started!: () => void;
    const pending = new Promise<void>((resolve) => { started = resolve; });
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => new FakeSocket((request) => {
      if (hold) { started(); return null; }
      return request.method === 'session.snapshot' ? snapshot() : { type: 'ok' };
    }, calls) });
    const pane = (await service.snapshot('default')).panes[0]!;
    hold = true;
    const controller = new AbortController();
    const input = service.input('default', 'p1', { action: 'text', text: 'hello', terminalId: pane.terminalId, observationToken: pane.observationToken }, controller.signal);
    const rejected = assert.rejects(input, { code: 'HERDR_CANCELLED' });
    await pending;
    await assert.rejects(service.input('default', 'p1', { action: 'enter', text: '', terminalId: pane.terminalId, observationToken: pane.observationToken }), { code: 'HERDR_INPUT_IN_FLIGHT' });
    controller.abort();
    await rejected;
    hold = false;
    const recovered = (await service.snapshot('default')).panes[0]!;
    assert.notEqual(recovered.observationToken, pane.observationToken);
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 0);
  });

  it('revokes eligibility after malformed send acknowledgement or output failure', async () => {
    let fail: 'send' | 'read' = 'send';
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => new FakeSocket((request) => {
      if (request.method === 'session.snapshot') return snapshot();
      if (request.method === 'pane.send_input' && fail === 'send') return {};
      if (request.method === 'pane.read' && fail === 'read') return {};
      return { type: 'ok' };
    }, calls) });
    const pane = (await service.snapshot('default')).panes[0]!;
    const request = { action: 'text' as const, text: 'hello', terminalId: pane.terminalId, observationToken: pane.observationToken };
    await assert.rejects(service.input('default', 'p1', request), { code: 'HERDR_INVALID_RESPONSE' });
    await assert.rejects(service.input('default', 'p1', request), { code: 'HERDR_STALE_OBSERVATION' });
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 1);
    const recovered = (await service.snapshot('default')).panes[0]!;
    assert.notEqual(recovered.observationToken, pane.observationToken);
    fail = 'read';
    await assert.rejects(service.output('default', 'p1'), { code: 'HERDR_INVALID_RESPONSE' });
    assert.notEqual((await service.snapshot('default')).panes[0]!.observationToken, recovered.observationToken);
  });

  it('revokes a possibly written input on disconnect and never retries it', async () => {
    let sends = 0;
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new Duplex({
        read() {},
        write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString());
          if (request.method === 'pane.send_input') {
            sends++;
            callback();
            socket.destroy();
          } else {
            socket.push(`${JSON.stringify({ id: request.id, result: snapshot() })}\n`);
            callback();
          }
        },
      });
      return socket;
    } });
    const pane = (await service.snapshot('default')).panes[0]!;
    const request = { action: 'text-enter' as const, text: 'one attempt', terminalId: pane.terminalId, observationToken: pane.observationToken };
    await assert.rejects(service.input('default', 'p1', request), { code: 'HERDR_UNAVAILABLE' });
    await assert.rejects(service.input('default', 'p1', request), { code: 'HERDR_STALE_OBSERVATION' });
    assert.equal(sends, 1);
    assert.notEqual((await service.snapshot('default')).panes[0]!.observationToken, pane.observationToken);
  });

  it('discards an obsolete output failure without revoking the newer snapshot', async () => {
    let held!: FakeSocket;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new FakeSocket((request) => {
        if (request.method === 'pane.read') { held = socket; started(); return null; }
        return snapshot();
      }, calls);
      return socket;
    } });
    const output = service.output('default', 'p1');
    const rejected = assert.rejects(output, { code: 'HERDR_UNAVAILABLE' });
    await ready;
    const newer = await service.snapshot('default');
    held.destroy(new Error('obsolete read failed'));
    await rejected;
    const current = await service.snapshot('default');
    assert.equal(current.session.generation, newer.session.generation);
    assert.equal(current.panes[0]?.observationToken, newer.panes[0]?.observationToken);
  });

  it('allows healthy snapshot polling while output and input preflight are in flight', async () => {
    let heldRead: { request: any; socket: FakeSocket } | undefined;
    let heldSend: { request: any; socket: FakeSocket } | undefined;
    let readStarted!: () => void;
    let sendStarted!: () => void;
    const readReady = new Promise<void>((resolve) => { readStarted = resolve; });
    const sendReady = new Promise<void>((resolve) => { sendStarted = resolve; });
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new FakeSocket((request) => {
        if (request.method === 'session.snapshot') return snapshot();
        if (request.method === 'pane.read') {
          heldRead = { request, socket };
          readStarted();
          return null;
        }
        if (request.method === 'pane.send_input') {
          heldSend = { request, socket };
          sendStarted();
          return null;
        }
        throw new Error(`unexpected ${request.method}`);
      }, calls);
      return socket;
    } });

    const observed = await service.snapshot('default');
    const output = service.output('default', 'p1');
    await readReady;
    const concurrent = await service.snapshot('default');
    assert.equal(concurrent.panes[0]?.observationToken, observed.panes[0]?.observationToken);
    heldRead!.socket.push(`${JSON.stringify({ id: heldRead!.request.id, result: { type: 'pane_read', read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', revision: 1, truncated: false, text: 'visible' } } })}\n`);
    assert.equal((await output).text, 'visible');
    assert.equal((await service.snapshot('default')).panes[0]?.observationToken, observed.panes[0]?.observationToken);

    const input = service.input('default', 'p1', { action: 'text', text: 'hello', terminalId: observed.panes[0]!.terminalId, observationToken: observed.panes[0]!.observationToken });
    await sendReady;
    const poll = await service.snapshot('default');
    assert.equal(poll.panes[0]?.observationToken, observed.panes[0]?.observationToken);
    heldSend!.socket.push(`${JSON.stringify({ id: heldSend!.request.id, result: { type: 'ok' } })}\n`);
    await input;
    assert.equal((await service.snapshot('default')).panes[0]?.observationToken, observed.panes[0]?.observationToken);
  });

  it('allows ordinary snapshot polling while an unchanged input preflight snapshot is in flight', async () => {
    let snapshotCount = 0;
    let heldPreflight: { request: any; socket: FakeSocket } | undefined;
    let preflightStarted!: () => void;
    const preflightReady = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
      const socket = new FakeSocket((request) => {
        if (request.method === 'session.snapshot') {
          snapshotCount++;
          if (snapshotCount === 2) {
            heldPreflight = { request, socket };
            preflightStarted();
            return null;
          }
          return snapshot();
        }
        if (request.method === 'pane.send_input') return { type: 'ok' };
        throw new Error(`unexpected ${request.method}`);
      }, calls);
      return socket;
    } });
    const pane = (await service.snapshot('default')).panes[0]!;
    const input = service.input('default', 'p1', { action: 'text', text: 'hello', terminalId: pane.terminalId, observationToken: pane.observationToken });
    await preflightReady;
    const poll = await service.snapshot('default');
    assert.equal(poll.panes[0]?.observationToken, pane.observationToken);
    heldPreflight!.socket.push(`${JSON.stringify({ id: heldPreflight!.request.id, result: snapshot() })}\n`);
    await input;
    assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 1);
    assert.equal((await service.snapshot('default')).panes[0]?.observationToken, pane.observationToken);
  });

  for (const kind of ['output-validation', 'public-snapshot'] as const) {
    for (const terminalChanged of [false, true]) {
      it(`handles a newer poll during ${kind} with terminalChanged=${terminalChanged}`, async () => {
        let count = 0;
        let terminal = 'term1';
        let held!: { request: any; socket: FakeSocket };
        let ready!: () => void;
        const pending = new Promise<void>((resolve) => { ready = resolve; });
        const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
          const socket = new FakeSocket((request) => {
            if (request.method === 'session.snapshot') {
              count++;
              if (count === (kind === 'output-validation' ? 3 : 2)) {
                held = { request, socket };
                ready();
                return null;
              }
              return snapshot(terminal);
            }
            if (request.method === 'pane.read') return {
              type: 'pane_read',
              read: { pane_id: 'p1', workspace_id: 'w1', tab_id: 't1', source: 'visible', format: 'text', revision: 1, truncated: false, text: 'visible' },
            };
            throw new Error(`unexpected ${request.method}`);
          }, calls);
          return socket;
        } });
        const initial = await service.snapshot('default');
        const request = kind === 'output-validation' ? service.output('default', 'p1') : service.snapshot('default');
        const rejected = terminalChanged ? assert.rejects(request, { code: 'HERDR_STALE_OBSERVATION' }) : null;
        await pending;
        if (terminalChanged) terminal = 'term2';
        const newer = await service.snapshot('default');
        held.socket.push(`${JSON.stringify({ id: held.request.id, result: snapshot('term1') })}\n`);
        if (rejected) await rejected;
        else {
          const response = await request;
          if ('text' in response) assert.equal(response.text, 'visible');
          else assert.equal(response, newer);
        }
        const final = await service.snapshot('default');
        assert.equal(final.panes[0]?.observationToken, newer.panes[0]?.observationToken);
        assert.equal(final.session.generation, newer.session.generation);
        assert.equal(final.panes[0]?.observationToken === initial.panes[0]?.observationToken, !terminalChanged);
      });
    }
  }

  it('rechecks cancellation, observed target and final socket admission after delayed connect', async () => {
    for (const change of ['cancel', 'terminal', 'socket'] as const) {
      let connections = 0;
      let terminal = 'term1';
      let held!: FakeSocket;
      let connecting!: () => void;
      const ready = new Promise<void>((resolve) => { connecting = resolve; });
      const socketPath = path.join(tmp, 'herdr', 'herdr.sock');
      const service = new HerdrSessionsService({ configHome: tmp, allowNonSocketForTests: true, connector: () => {
        connections++;
        const socket = new FakeSocket((request) => request.method === 'session.snapshot' ? snapshot(terminal) : { type: 'ok' }, calls);
        if (connections === 3) {
          held = Object.assign(socket, { connecting: true });
          connecting();
        }
        return socket;
      } });
      const pane = (await service.snapshot('default')).panes[0]!;
      const controller = new AbortController();
      const input = service.input('default', 'p1', { action: 'text', text: 'hello', terminalId: pane.terminalId, observationToken: pane.observationToken }, controller.signal);
      const rejected = assert.rejects(input, { code: change === 'cancel' ? 'HERDR_CANCELLED' : 'HERDR_STALE_OBSERVATION' });
      await ready;
      if (change === 'cancel') controller.abort();
      if (change === 'terminal') {
        terminal = 'term2';
        await service.snapshot('default');
      }
      if (change === 'socket') {
        await fs.rename(socketPath, `${socketPath}.old`);
        await fs.writeFile(socketPath, '');
      }
      held.emit('connect');
      await rejected;
      assert.equal(held.destroyed, true);
      assert.equal(calls.filter((call) => call.method === 'pane.send_input').length, 0);
    }
  });
});
