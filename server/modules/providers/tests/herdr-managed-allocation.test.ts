import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase, sessionsDb } from '@/modules/database/index.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';

import { getProductionHerdrManagedWorkspacesService } from '../../herdr/index.js';

async function isolated(run: (directory: string) => Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-allocation-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  await initializeDatabase();
  try { await run(directory); } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

test('new normal allocation registers canonical ownership without provisioning or adopting imported sessions', async () => {
  await isolated(async (directory) => {
    const managed = getProductionHerdrManagedWorkspacesService();
    sessionsDb.createSession('imported', 'gjc', directory, 'Imported');
    sessionsDb.createAppSession('existing-local', 'gjc', directory);
    const allocated = sessionsService.createAppSession('gjc', directory);
    assert.equal(allocated.managed, true);
    assert.equal(managed.isManaged(allocated.sessionId), true);
    assert.equal(managed.isManaged('imported'), false);
    assert.equal(managed.isManaged('existing-local'), false);
    const registration = getConnection().prepare('SELECT project_path FROM herdr_managed_registrations WHERE app_session_id = ?').get(allocated.sessionId) as { project_path: string };
    assert.equal(registration.project_path, sessionsDb.getSessionById(allocated.sessionId)?.project_path);
    assert.equal(getConnection().prepare('SELECT 1 FROM herdr_managed_provisions WHERE app_session_id = ?').get(allocated.sessionId), undefined);
    assert.equal(sessionsDb.getSessionById(allocated.sessionId)?.provider_session_id, null);
    await sessionsService.deleteOrArchiveSessionById(allocated.sessionId, { force: true });
    assert.equal(managed.isManaged(allocated.sessionId), false);
  });
});

test('failed registration rolls back the App allocation', async () => {
  await isolated(async (directory) => {
    const before = sessionsDb.getAllSessions().length;
    getConnection().exec(`CREATE TRIGGER reject_managed_registration BEFORE INSERT ON herdr_managed_registrations BEGIN SELECT RAISE(ABORT, 'registration failed'); END`);
    assert.throws(() => sessionsService.createAppSession('gjc', directory), /registration failed/);
    assert.equal(sessionsDb.getAllSessions().length, before);
    assert.equal(getConnection().prepare('SELECT 1 FROM herdr_managed_registrations').get(), undefined);
  });
});

test('force removal fences live and uncertain owners before native unlink; archive remains safe', async () => {
  await isolated(async (directory) => {
    const db = getConnection();
    const allocated = sessionsService.createAppSession('gjc', directory);
    const transcript = path.join(directory, 'native.jsonl');
    await writeFile(transcript, 'native history');
    db.prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(transcript, allocated.sessionId);
    db.prepare(`INSERT INTO herdr_managed_bindings (app_session_id, owner_generation, herdr_instance_id, lifecycle) VALUES (?, 'generation', 'default', 'reserved')`).run(allocated.sessionId);
    for (const lifecycle of ['reserved', 'claiming', 'ready', 'running', 'idle', 'unknown', 'interrupted']) {
      db.prepare('UPDATE herdr_managed_bindings SET lifecycle = ? WHERE app_session_id = ?').run(lifecycle, allocated.sessionId);
      await assert.rejects(sessionsService.deleteOrArchiveSessionById(allocated.sessionId, { force: true, deletedFromDisk: true }), { code: 'MANAGED_SESSION_NOT_CLOSED', statusCode: 409 });
      assert.equal(await readFile(transcript, 'utf8'), 'native history');
      assert.ok(sessionsDb.getSessionById(allocated.sessionId));
    }
    assert.equal((await sessionsService.deleteOrArchiveSessionById(allocated.sessionId)).action, 'archived');
    db.prepare(`UPDATE herdr_managed_bindings SET lifecycle = 'closed' WHERE app_session_id = ?`).run(allocated.sessionId);
    db.prepare(`INSERT INTO herdr_managed_provisions (app_session_id, owner_generation, claim_nonce, endpoint_json, phase, private_directory) VALUES (?, 'other-generation', 'nonce', '{}', 'unknown', ?)`).run(allocated.sessionId, directory);
    await assert.rejects(sessionsService.deleteOrArchiveSessionById(allocated.sessionId, { force: true, deletedFromDisk: true }), { code: 'MANAGED_SESSION_NOT_CLOSED' });
    assert.equal(await readFile(transcript, 'utf8'), 'native history');
    db.prepare(`UPDATE herdr_managed_provisions SET owner_generation = 'generation' WHERE app_session_id = ?`).run(allocated.sessionId);
    assert.equal((await sessionsService.deleteOrArchiveSessionById(allocated.sessionId, { force: true, deletedFromDisk: true })).deletedFromDisk, true);
    await assert.rejects(readFile(transcript), { code: 'ENOENT' });
  });
});

test('nonmanaged native history removal is unchanged', async () => {
  await isolated(async (directory) => {
    for (const provider of ['gjc', 'claude']) {
      const id = `imported-${provider}`;
      const transcript = path.join(directory, `${id}.jsonl`);
      await writeFile(transcript, 'history');
      sessionsDb.createSession(id, provider, directory, 'Imported');
      getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ?').run(transcript, id);
      assert.deepEqual(await sessionsService.deleteOrArchiveSessionById(id, { force: true, deletedFromDisk: true }), { sessionId: id, action: 'deleted', deletedFromDisk: true });
      await assert.rejects(readFile(transcript), { code: 'ENOENT' });
    }
  });
});
