import assert from 'node:assert/strict';
import { mkdtemp, chmod, writeFile, symlink, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { closeConnection, getConnection } from './modules/database/connection.js';
import { HerdrTaskHost, managedChildEnvironment, readBootstrap } from './gjc-herdr-task-host.js';

test('managed child excludes inherited credential and runtime injection environment', () => {
  const env = managedChildEnvironment({ HOME: '/home/owner', PATH: '/usr/bin', TMPDIR: '/tmp', OPENAI_API_KEY: 'not-forwarded', GJC_RUNTIME_API_KEY: 'not-forwarded', GJC_MANAGED_CHILD_PATH: '/attacker/child.ts', NODE_OPTIONS: '--import /attacker', DATABASE_PATH: '/other.db', GJC_AUTOMATION_TOKEN: 'not-forwarded' });
  assert.deepEqual(env, { HOME: '/home/owner', PATH: '/usr/bin', TMPDIR: '/tmp' });
});

test('bootstrap rejects code injection, symlinks and public file permissions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-bootstrap-'));
  const filename = path.join(directory, 'bootstrap.json');
  const value = { appSessionId: 'app-session', ownerGeneration: 'generation', herdrInstanceId: 'default', projectPath: '/tmp/project', sessionRoot: directory };
  try {
    await writeFile(filename, JSON.stringify({ ...value, factoryModule: '/tmp/inject.ts' }), { mode: 0o600 });
    await assert.rejects(readBootstrap(filename), /incomplete/);
    await writeFile(filename, JSON.stringify(value));
    const alias = path.join(directory, 'alias');
    await symlink(filename, alias);
    await assert.rejects(readBootstrap(alias), /bounded file/);
    await chmod(filename, 0o644);
    await assert.rejects(readBootstrap(filename), /owner-only/);
    await chmod(filename, 0o600);
    assert.deepEqual(await readBootstrap(filename), value);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('production bootstrap rejects environment credentials and mismatched project configuration', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-bootstrap-'));
  const filename = path.join(directory, 'bootstrap.json');
  const value = { appSessionId: 'app-session', ownerGeneration: 'generation', herdrInstanceId: 'default', projectPath: '/tmp/project', sessionRoot: directory, databasePath: path.join(directory, 'app.db'), claimNonce: 'a'.repeat(64), attachSecret: 'b'.repeat(64) };
  try {
    await writeFile(filename, JSON.stringify({ ...value, runConfig: { cwd: value.projectPath, sessionRoot: directory, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' } } }), { mode: 0o600 });
    await assert.rejects(readBootstrap(filename), /production bootstrap/);
    await writeFile(filename, JSON.stringify({ ...value, runConfig: { cwd: '/elsewhere', sessionRoot: directory, credential: { kind: 'stored' } } }));
    await assert.rejects(readBootstrap(filename), /production bootstrap/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('detached production startup refuses incompatible schema without running DDL or constructing an SDK', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'managed-schema-check-'));
  const filename = path.join(directory, 'existing.sqlite');
  const previous = process.env.DATABASE_PATH;
  closeConnection();
  const setup = new Database(filename);
  setup.exec('CREATE TABLE existing_user_work (id INTEGER)');
  setup.close();
  process.env.DATABASE_PATH = filename;
  let constructions = 0;
  try {
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'app', ownerGeneration: 'generation', herdrInstanceId: 'default',
        projectPath: directory, sessionRoot: directory, databasePath: filename, claimNonce: 'a'.repeat(64) },
      createSession: () => { constructions++; throw new Error('must not construct'); },
    });
    await assert.rejects(host.initialize(), /herdr_managed_bindings/);
    assert.equal(constructions, 0);
    const tables = getConnection().prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    assert.deepEqual(tables, [{ name: 'existing_user_work' }]);
    closeConnection();
    process.env.DATABASE_PATH = path.join(directory, 'missing.sqlite');
    assert.throws(() => getConnection({ existingOnly: true }));
    await assert.rejects(stat(process.env.DATABASE_PATH), { code: 'ENOENT' });
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
