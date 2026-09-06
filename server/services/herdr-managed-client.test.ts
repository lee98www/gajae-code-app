import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { HERDR_MANAGED_PROTOCOL_VERSION, type HerdrManagedCommand, type HerdrManagedSnapshotDescriptor, type HerdrManagedEvent } from '../../shared/herdr-managed-protocol.js';
import { createHerdrManagedState, pageHerdrManagedState, serializeHerdrManagedState } from '../../shared/herdr-managed-state.js';
import { HerdrManagedAttachClient } from '../modules/herdr/index.js';

const identity = { appSessionId: 'app-1', ownerGeneration: 'generation-1' };
const snapshot: HerdrManagedSnapshotDescriptor = { identity, snapshotId: 'snapshot-1', watermark: 0, byteLength: 0, pageCount: 1, leaseExpiresAt: Date.now() + 60_000 };

test('attach response ids correlate out-of-order commands around unsolicited events', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-client-'));
  const socketPath = path.join(directory, 'socket');
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    let buffer = '';
    const commands: Array<{ id: string; value: { actionId: string } }> = [];
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; id: string; value: { actionId: string } };
        buffer = buffer.slice(newline + 1);
        if (frame.type === 'hello') {
          socket.write(`${JSON.stringify({ type: 'ready', id: frame.id, snapshot })}\n`);
        } else if (frame.type === 'command') {
          commands.push(frame);
          if (commands.length === 2) {
            socket.write(`${JSON.stringify({ type: 'event', event: { protocolVersion: 1, ...identity, seq: 1, kind: 'sdk.event', payload: { kind: 'text', content: 'streaming' }, createdAt: '2026-09-06T00:00:00Z' } })}\n`);
            for (const command of commands.reverse()) {
              socket.write(`${JSON.stringify({ type: 'receipt', id: command.id, receipt: { protocolVersion: 1, ...identity, actionId: command.value.actionId, state: 'settled', seq: 2, message: 'settled' } })}\n`);
            }
          }
        }
      }
    });
  });
  const client = new HerdrManagedAttachClient({ socketPath, ...identity, attachSecret: 'x'.repeat(32) });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await client.connect();
    const events: unknown[] = [];
    client.subscribe((event) => events.push(event.payload));
    const makeCommand = (actionId: string): HerdrManagedCommand => ({ protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION, ...identity, actionId, kind: 'prompt', payload: { text: actionId }, payloadHash: 'a'.repeat(64) });
    const first = client.command(makeCommand('first'));
    const second = client.command(makeCommand('second'));
    const replies = await Promise.all([first, second]);
    assert.deepEqual(replies.map((reply) => reply.type === 'receipt' ? reply.receipt.actionId : reply.type), ['first', 'second']);
    assert.deepEqual(events, [{ kind: 'text', content: 'streaming' }]);
  } finally {
    client.close();
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('attach EOF rejects unresolved commands instead of leaving FIFO waiters hung', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-client-'));
  const socketPath = path.join(directory, 'socket');
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; id: string };
      buffer = buffer.slice(newline + 1);
      if (frame.type === 'hello') socket.write(`${JSON.stringify({ type: 'ready', id: frame.id, snapshot })}\n`);
      else socket.destroy();
    });
  });
  const client = new HerdrManagedAttachClient({ socketPath, ...identity, attachSecret: randomUUID() });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    await client.connect();
    await assert.rejects(client.snapshot(), /disconnected/);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('paged replacement remains atomic and streams from the captured watermark after lease renewal', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-pages-'));
  const socketPath = path.join(directory, 'socket');
  const state = createHerdrManagedState(identity);
  state.providerSessionId = 'native-real-session';
  state.lifecycle = 'running';
  state.watermark = 5001;
  state.activeTurnId = 'turn-1';
  state.messages = [{ id: 'message-1', turnId: 'turn-1', content: '전체 내용\n'.repeat(50_000), reasoning: ['reasoning'], final: false, metadata: {} }];
  state.tools = { 'tool-1': { input: { path: 'file.ts' }, partial: { content: 'partial' }, final: null } };
  state.requests['ask-1'] = {
    appSessionId: identity.appSessionId, generation: identity.ownerGeneration,
    providerSessionId: 'native-real-session', turnId: 'turn-1', requestId: 'ask-1',
    kind: 'ask', policyRevision: 2, scope: {}, schema: { questions: [{ question: 'Proceed?', options: [] }] },
    createdAt: '2026-09-06T00:00:00Z',
  };
  const pages = pageHerdrManagedState(state);
  const descriptor: HerdrManagedSnapshotDescriptor = {
    ...snapshot, snapshotId: 'new-snapshot', watermark: state.watermark,
    byteLength: Buffer.byteLength(serializeHerdrManagedState(state)), pageCount: pages.length,
  };
  const late: HerdrManagedEvent = {
    protocolVersion: 1, ...identity, seq: 5002, kind: 'managed.request-resolved',
    payload: { requestId: 'ask-1' }, createdAt: '2026-09-06T00:00:01Z',
  };
  let snapshots = 0;
  let fetched = 0;
  const clients = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    clients.add(socket);
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; id: string; page?: number; snapshotId?: string; watermark?: number };
        buffer = buffer.slice(newline + 1);
        const send = (value: object) => socket.write(`${JSON.stringify(value)}\n`);
        if (frame.type === 'hello') {
          send({ type: 'ready', id: frame.id, snapshot: { ...descriptor, snapshotId: 'expired-snapshot' } });
        } else if (frame.type === 'snapshot') {
          snapshots++;
          send({ type: 'ready', id: frame.id, snapshot: descriptor });
        } else if (frame.type === 'snapshot-page') {
          if (frame.snapshotId === 'expired-snapshot') {
            send({ type: 'snapshot-required', id: frame.id, reason: 'lease_expired' });
          } else {
            fetched++;
            send({ type: 'snapshot-page', id: frame.id, snapshotId: descriptor.snapshotId, page: frame.page, chunk: pages[frame.page!], leaseExpiresAt: Date.now() + 60_000 });
          }
        } else if (frame.type === 'subscribe') {
          assert.equal(frame.watermark, 5001);
          send({ type: 'subscribed', id: frame.id, watermark: 5001 });
          send({ type: 'event', event: late });
        }
      }
    });
  });
  const client = new HerdrManagedAttachClient({ socketPath, ...identity, attachSecret: 'x'.repeat(32) });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    const projections: Array<{ seq: number; hasAsk: boolean; content: string }> = [];
    let received!: () => void;
    const live = new Promise<void>((resolve) => { received = resolve; });
    client.subscribeState((current) => {
      projections.push({ seq: current.watermark, hasAsk: !!current.requests['ask-1'], content: current.messages[0].content });
      if (current.watermark === 5002) received();
    });
    await client.connect();
    const initialState = client.state;
    assert.equal(initialState, null);
    await client.recover();
    await live;
    assert.equal(snapshots, 1);
    assert.equal(fetched, pages.length);
    assert.deepEqual(projections.map(({ seq, hasAsk }) => ({ seq, hasAsk })), [{ seq: 5001, hasAsk: true }, { seq: 5002, hasAsk: false }]);
    assert.ok(projections.every((projection) => projection.content === state.messages[0].content));
    assert.deepEqual(client.state?.tools['tool-1'].partial, { content: 'partial' });
  } finally {
    client.close();
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('unsolicited replay overflow recovers on the same socket without restarting the owner', { timeout: 10_000 }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-gap-'));
  const socketPath = path.join(directory, 'socket');
  const clients = new Set<net.Socket>();
  let connections = 0;
  let latest = createHerdrManagedState(identity);
  latest.providerSessionId = 'same-provider';
  let completed!: () => void;
  const recovered = new Promise<void>((resolve) => { completed = resolve; });
  const server = net.createServer((socket) => {
    connections++;
    clients.add(socket);
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const frame = JSON.parse(buffer.slice(0, newline)) as { type: string; id: string; page: number; watermark: number };
        buffer = buffer.slice(newline + 1);
        const send = (value: object) => socket.write(`${JSON.stringify(value)}\n`);
        const pages = pageHerdrManagedState(latest);
        if (frame.type === 'hello' || frame.type === 'snapshot') {
          send({ type: 'ready', id: frame.id, snapshot: {
            identity, snapshotId: `snapshot-${latest.watermark}`, watermark: latest.watermark,
            byteLength: Buffer.byteLength(serializeHerdrManagedState(latest)),
            pageCount: pages.length, leaseExpiresAt: Date.now() + 60_000,
          } });
        } else if (frame.type === 'snapshot-page') {
          send({ type: 'snapshot-page', id: frame.id, snapshotId: `snapshot-${latest.watermark}`,
            page: frame.page, chunk: pages[frame.page], leaseExpiresAt: Date.now() + 60_000 });
        } else if (frame.type === 'subscribe') {
          send({ type: 'subscribed', id: frame.id, watermark: frame.watermark });
          if (frame.watermark === 0) {
            latest = { ...latest, watermark: 5003, status: { text: 'same owner recovered' } };
            send({ type: 'snapshot-required', id: 'live', reason: 'gap' });
          } else assert.equal(frame.watermark, 5003);
        }
      }
    });
  });
  const client = new HerdrManagedAttachClient({ socketPath, ...identity, attachSecret: 'x'.repeat(32) });
  try {
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    client.subscribeState((state) => { if (state.watermark === 5003) completed(); });
    await client.connect();
    await client.recover();
    await recovered;
    assert.equal(connections, 1);
    assert.equal(client.state?.providerSessionId, 'same-provider');
    assert.equal(client.state?.status?.text, 'same owner recovered');
  } finally {
    client.close();
    for (const socket of clients) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
