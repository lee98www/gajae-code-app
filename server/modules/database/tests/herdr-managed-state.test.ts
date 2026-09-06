import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { closeConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { herdrManagedDb as managed } from '@/modules/database/repositories/herdr-managed.db.js';
import { createHerdrManagedSnapshotsDb } from '@/modules/database/repositories/herdr-managed-snapshots.db.js';

import { assembleHerdrManagedSnapshot } from '../../../../shared/herdr-managed-state.js';
import { managedJsonBytes, type HerdrManagedCommand } from '../../../../shared/herdr-managed-protocol.js';
const owner = { appSessionId: 'state-test', ownerGeneration: 'owner-one' };
async function store(run: () => void) {
  const previous = process.env.DATABASE_PATH; const directory = await mkdtemp(join(tmpdir(), 'managed-state-'));
  closeConnection(); process.env.DATABASE_PATH = join(directory, 'test.sqlite');
  try {
    await initializeDatabase(); managed.reserve({ ...owner, projectPath: '/workspace/state', herdrInstanceId: 'herdr' });
    managed.beginClaim(owner.appSessionId, owner.ownerGeneration);
    managed.claim({ ...owner, protocolVersion: 1, providerSessionId: 'sdk' }); run();
  } finally {
    closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
function command(actionId: string, text = actionId): HerdrManagedCommand {
  const payload = { text }; return { ...owner, protocolVersion: 1, actionId, kind: 'prompt', payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}
function sdk(kind: string, payload: Record<string, unknown>) { return managed.appendEvent({ ...owner, kind: 'sdk.event', payload: { kind, ...payload } }); }
test('durable rich state is complete beyond replay tail and retains original SDK envelopes', async () => store(() => {
  managed.beginTurn(owner.appSessionId, owner.ownerGeneration, 'turn');
  for (let i = 0; i < 5001; i++) sdk('stream_delta', { content: '가' });
  sdk('thinking', { content: 'reasoning' });
  sdk('tool_use', { toolId: 'tool', input: { command: 'pwd' }, details: { complete: true } });
  sdk('tool_result', { toolId: 'tool', isFinal: false, content: 'partial', details: { rich: [1, 2] } });
  sdk('status', { tokenBudget: { used: 21 }, sessionState: { model: 'model' } });
  const state = managed.getState(owner.appSessionId, owner.ownerGeneration);
  assert.equal(state.messages[0].content, '가'.repeat(5001)); assert.deepEqual(state.messages[0].reasoning, ['reasoning']);
  assert.deepEqual(state.tools.tool.partial?.details, { rich: [1, 2] }); assert.deepEqual(state.usage, { used: 21 });
  assert.equal(managed.eventsSince(owner.appSessionId, owner.ownerGeneration, 0).length, 256);
  const last = managed.eventsSince(owner.appSessionId, owner.ownerGeneration, state.watermark - 1)[0];
  assert.equal(last.kind, 'sdk.event'); assert.equal((last.payload as { kind: string }).kind, 'status');
  closeConnection(); assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration), state);
}));
test('immutable Unicode pages renew only on progress, enforce identity and expire', async () => store(() => {
  sdk('stream_delta', { content: '한😀\\\"'.repeat(180000) });
  let now = 100; const snapshots = createHerdrManagedSnapshotsDb(() => now);
  const descriptor = snapshots.create(owner.appSessionId, owner.ownerGeneration);
  const viewer = snapshots.create(owner.appSessionId, owner.ownerGeneration);
  assert.notEqual(viewer.snapshotId, descriptor.snapshotId);
  assert.equal(snapshots.page(owner.appSessionId, owner.ownerGeneration, viewer.snapshotId, 0).type, 'snapshot-page');
  assert.ok(descriptor.byteLength > 1024 * 1024);
  sdk('stream_delta', { content: 'later' });
  const chunks: string[] = [];
  for (let page = 0; page < descriptor.pageCount; page++) {
    now += 30000; const frame = snapshots.page(owner.appSessionId, owner.ownerGeneration, descriptor.snapshotId, page);
    assert.equal(frame.type, 'snapshot-page'); if (frame.type !== 'snapshot-page') throw new Error('Page missing');
    assert.ok(managedJsonBytes(frame) <= 1024 * 1024); chunks.push(frame.chunk);
  }
  const state = assembleHerdrManagedSnapshot(descriptor, chunks); assert.equal(state.watermark, descriptor.watermark);
  assert.ok(!state.messages[0].content.endsWith('later'));
  assert.throws(() => snapshots.page(owner.appSessionId, 'wrong', descriptor.snapshotId, 0));
  now += 60000; assert.equal(snapshots.page(owner.appSessionId, owner.ownerGeneration, descriptor.snapshotId, 0).type, 'snapshot-required');
  assert.notEqual(snapshots.create(owner.appSessionId, owner.ownerGeneration).snapshotId, descriptor.snapshotId);
  const replay = snapshots.replayPage(owner.appSessionId, owner.ownerGeneration, 2, descriptor.watermark);
  assert.equal(replay.type, 'snapshot-required');
}));
test('FIFO admission is atomic, bounded, paused and never drains on abort or reload', async () => store(() => {
  for (let i = 0; i < 16; i++) managed.enqueue(command(`a${i}`));
  const watermark = managed.getState(owner.appSessionId, owner.ownerGeneration).watermark;
  assert.throws(() => managed.enqueue(command('overflow')));
  assert.equal(managed.getCommand(owner.appSessionId, owner.ownerGeneration, 'overflow'), null);
  assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).watermark, watermark);
  managed.pauseQueue(owner.appSessionId, owner.ownerGeneration);
  assert.equal(managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'turn'), null);
  managed.resumeQueue(owner.appSessionId, owner.ownerGeneration);
  assert.equal(managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'turn')?.command.actionId, 'a0');
  assert.equal(managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'second'), null);
  managed.finishTurn(owner.appSessionId, owner.ownerGeneration, 'turn', { aborted: true });
  assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).turns.turn.aborted, true);
  closeConnection(); assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).queue.entries.length, 15);
  managed.setLifecycle(owner.appSessionId, owner.ownerGeneration, 'interrupted');
  assert.equal(managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'second'), null);
}));
test('queued user text is durable and idempotent but becomes visible only with atomic turn start', async () => store(() => {
  const payload = { text: 'SDK prompt', displayText: 'Visible prompt', images: [{ data: 'image-data', mimeType: 'image/png' }] };
  const rich = { ...command('rich'), payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
  const receipt = managed.enqueue(rich);
  const admitted = managed.getState(owner.appSessionId, owner.ownerGeneration);
  assert.equal(managed.enqueue(rich).seq, receipt.seq);
  assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).watermark, admitted.watermark);
  assert.equal(admitted.extensions.some(event => event.kind === 'text'), false);
  closeConnection();
  assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration).queue.entries[0].command, rich);
  assert.throws(() => managed.dequeue(owner.appSessionId, owner.ownerGeneration, ''));
  assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration), admitted);
  managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'actual-turn');
  const started = managed.getState(owner.appSessionId, owner.ownerGeneration);
  assert.equal(started.activeTurnId, 'actual-turn');
  assert.equal(started.queue.entries.length, 0);
  const events = managed.eventsSince(owner.appSessionId, owner.ownerGeneration, admitted.watermark);
  const users = events.filter(event => event.kind === 'text');
  assert.equal(users.length, 1);
  const user = users[0].payload as Record<string, unknown>;
  assert.deepEqual(user, { role: 'user', actionId: 'rich', turnId: 'actual-turn', content: 'Visible prompt', images: payload.images, timestamp: user.timestamp });
  assert.equal(typeof user.timestamp, 'string');
  assert.ok(Number.isFinite(Date.parse(user.timestamp as string)));
  assert.equal(managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'duplicate'), null);
  assert.equal(managed.enqueue(rich).state, 'executing');
  assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).watermark, started.watermark);
  closeConnection();
  assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration), started);
  managed.finishTurn(owner.appSessionId, owner.ownerGeneration, 'actual-turn');
  managed.enqueue(command('plain', 'Fallback text'));
  managed.dequeue(owner.appSessionId, owner.ownerGeneration, 'plain-turn');
  const plain = managed.getState(owner.appSessionId, owner.ownerGeneration).extensions.filter(event => event.kind === 'text').at(-1)?.payload as Record<string, unknown>;
  assert.equal(plain.content, 'Fallback text');
  assert.equal('images' in plain, false);
}));
test('queue byte overflow rolls back command and replay remains contiguous and bounded', async () => store(() => {
  assert.throws(() => managed.enqueue(command('huge', '한'.repeat(400000))));
  assert.equal(managed.getCommand(owner.appSessionId, owner.ownerGeneration, 'huge'), null);
  for (let i = 0; i < 260; i++) sdk('stream_delta', { content: 'x' });
  const snapshots = createHerdrManagedSnapshotsDb(); const watermark = managed.getState(owner.appSessionId, owner.ownerGeneration).watermark;
  const page = snapshots.replayPage(owner.appSessionId, owner.ownerGeneration, 0, watermark);
  assert.equal(page.type, 'replay'); if (page.type !== 'replay') throw new Error('Replay missing');
  assert.equal(page.events.length, 256); assert.equal(page.complete, false);
  assert.ok(managedJsonBytes(page) + 1 <= 1024 * 1024);
  const end = snapshots.replayPage(owner.appSessionId, owner.ownerGeneration, page.nextSeq, watermark);
  assert.equal(end.type, 'replay'); if (end.type === 'replay') assert.equal(end.complete, true);
}));

test('128 viewers retain independent immutable leases and expired leases recover', async () => store(() => {
  let now = 0;
  const snapshots = createHerdrManagedSnapshotsDb(() => now);
  const leases = Array.from({ length: 128 }, () => snapshots.create(owner.appSessionId, owner.ownerGeneration));
  assert.throws(() => snapshots.create(owner.appSessionId, owner.ownerGeneration));
  sdk('stream_delta', { content: 'after capture' });
  now = 30000;
  for (const lease of leases) {
    const frame = snapshots.page(owner.appSessionId, owner.ownerGeneration, lease.snapshotId, 0);
    assert.equal(frame.type, 'snapshot-page');
    if (frame.type === 'snapshot-page') assert.equal(frame.leaseExpiresAt, 90000);
  }
  now = 60000;
  const repeated = snapshots.page(owner.appSessionId, owner.ownerGeneration, leases[0].snapshotId, 0);
  if (repeated.type === 'snapshot-page') assert.equal(repeated.leaseExpiresAt, 90000);
  now = 90000;
  assert.equal(snapshots.page(owner.appSessionId, owner.ownerGeneration, leases[0].snapshotId, 0).type, 'snapshot-required');
  assert.ok(snapshots.create(owner.appSessionId, owner.ownerGeneration).watermark > leases[0].watermark);
}));
