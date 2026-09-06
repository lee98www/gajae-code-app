import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { requiredManagedSmokePaths, requireOfflineDefaultFactoryReadiness, validateManagedRuntimeRoot, validateManagedSmokeEvidence } from './managed-host-smoke.mjs';

async function closure() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-closure-test-')));
  for (const relative of [...requiredManagedSmokePaths, 'node_modules/node-pty/index.js']) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), relative === 'package.json' ? '{"type":"module"}' : '');
  }
  return root;
}
test('compiled closure requires private SDK fixture, child and shared modules', async () => {
  const root = await closure();
  try {
    assert.equal(await validateManagedRuntimeRoot(root), root);
    for (const relative of requiredManagedSmokePaths.filter(value => value !== 'package.json')) {
      await fs.rename(path.join(root, relative), path.join(root, relative + '.held'));
      await assert.rejects(validateManagedRuntimeRoot(root));
      await fs.rename(path.join(root, relative + '.held'), path.join(root, relative));
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('copied closure rejects checkout symlinks and relative roots', async () => {
  const root = await closure();
  const external = await closure();
  try {
    await assert.rejects(validateManagedRuntimeRoot('.'), /absolute/);
    const relative = 'dist-server/server/gjc-herdr-task-host.js';
    await fs.rm(path.join(root, relative));
    await fs.symlink(path.join(external, relative), path.join(root, relative));
    await assert.rejects(validateManagedRuntimeRoot(root), /escapes copied root/);
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(external, { recursive: true, force: true }); }
});
test('evidence rejects missing proofs and never equates deterministic SDK with default SDK', () => {
  const value = { schemaVersion: 1, deterministicSdk: { verified: true }, defaultSdk: { attempted: true, verified: true, productionEntrypoint: true, closed: true, promptCount: 0 }, app: { healthBefore: true, exitObserved: true, healthAfter: true, ownsAttach: false }, host: { sameIdentity: true, ptyReady: true, settlements: 1 }, cleanupComplete: true };
  assert.equal(validateManagedSmokeEvidence(value), value);
  for (const change of [{ cleanupComplete: false }, { host: { ...value.host, settlements: 2 } }, { app: { ...value.app, ownsAttach: true } }, { defaultSdk: { verified: true } }, { defaultSdk: { attempted: true, verified: false } }]) {
    assert.throws(() => validateManagedSmokeEvidence({ ...value, ...change }));
  }
  for (const malformed of [null, {}, [], 'READY']) assert.throws(() => validateManagedSmokeEvidence(malformed));
  assert.throws(() => validateManagedSmokeEvidence({ ...value, defaultSdk: { attempted: true, verified: false, reason: 'Missing stored credentials' } }), /Release requires verified/);
  assert.throws(() => validateManagedSmokeEvidence({ ...value, defaultSdk: { attempted: false, verified: false, reason: 'Offline readiness blocked' } }));
  for (const change of [{ productionEntrypoint: false }, { closed: false }, { promptCount: 1 }]) {
    assert.throws(() => validateManagedSmokeEvidence({ ...value, defaultSdk: { ...value.defaultSdk, ...change } }));
  }
});
test('builders expose import-safe entrypoints', async () => {
  const mac = await import('./build-macos-server-payload.mjs');
  const linux = await import('./build-server-bundle.js');
  assert.equal(typeof mac.buildMacosServerPayload, 'function');
  assert.equal(typeof mac.smokeMacosServerPayload, 'function');
  assert.equal(typeof linux.buildServerBundle, 'function');
  assert.equal(typeof linux.smokeServerBundle, 'function');
});
test('default readiness setup failure overwrites sanitized negative evidence and rejects', async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-negative-'));
  try {
    await assert.rejects(requireOfflineDefaultFactoryReadiness(path.join(scratch, 'missing-runtime'), scratch), /Offline default SDK readiness or owned shutdown failed/);
    const evidence = JSON.parse(await fs.readFile(path.join(scratch, 'default-probe.json'), 'utf8'));
    assert.deepEqual(evidence, { attempted: true, verified: false, promptCount: 0, reason: 'Offline default SDK readiness or owned shutdown failed.' });
    assert.equal(JSON.stringify(evidence).includes(scratch), false);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
});
