import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { discoverAuthStorage } from '@gajae-code/coding-agent/sdk/session';
import { Settings } from '@gajae-code/coding-agent/config/settings';
import { ModelRegistry } from '@gajae-code/coding-agent/config/model-registry';

import type { ManagedChildOutput } from '../shared/herdr-managed-child-protocol.js';

async function until(read: () => boolean, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (!read()) {
    assert.ok(Date.now() < deadline, 'Private default child observation deadline');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

test('actual private child initializes its default SDK offline from stored credentials without prompting and closes cleanly', { timeout: 60_000 }, async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'managed-offline-')));
  const agentDir = path.join(root, 'agent');
  const cwd = path.join(root, 'project');
  const sessionRoot = path.join(root, 'sessions');
  let child: ReturnType<typeof spawn> | undefined;
  try {
    for (const dir of [agentDir, cwd, sessionRoot]) await mkdir(dir, { mode: 0o700 });
    const settings = await Settings.init({ agentDir });
    const modelId = 'anthropic/claude-sonnet-4-20250514';
    settings.setGlobalModelRole('default', modelId);
    await settings.flushOrThrow();
    const auth = await discoverAuthStorage(agentDir);
    const registry = new ModelRegistry(auth, path.join(agentDir, 'models.yml'), settings, { agentDir, automaticRefresh: false });
    try {
      await auth.set('anthropic', { type: 'api_key', key: 'fixture-only-never-send' });
      await registry.refresh('offline');
      assert.ok(registry.getAll().some(model => `${model.provider}/${model.id}` === modelId), 'Fixture model must exist in the installed offline catalog');
    } finally { await registry.dispose(); auth.close(); }
    // No adapter/session factory seam and no provider credential environment.
    child = spawn(fileURLToPath(new URL('../dist-native/bun', import.meta.url)), [fileURLToPath(new URL('./gjc-herdr-managed-child.ts', import.meta.url))], {
      cwd,
      env: { HOME: root, PATH: '/usr/bin:/bin', TMPDIR: root, LANG: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const owned = child;
    let error: Error | undefined;
    owned.on('error', value => { error = value; });
    owned.stderr!.resume();
    const frames: ManagedChildOutput[] = [];
    let buffer = '';
    owned.stdout!.on('data', data => {
      buffer += data.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const frame = JSON.parse(buffer.slice(0, end)) as ManagedChildOutput;
        buffer = buffer.slice(end + 1);
        frames.push(frame);
        if (frame.type === 'event') owned.stdin!.write(JSON.stringify({ version: 1, generation: 'offline-owner', requestId: `ack-${frame.eventSeq}`, runId: frame.runId, type: 'ack', eventSeq: frame.eventSeq }) + '\n');
      }
    });
    const identity = { version: 1, generation: 'offline-owner', requestId: 'init', runId: 'init' };
    owned.stdin!.write(JSON.stringify({ ...identity, type: 'init', appSessionId: 'app-not-sdk-id', agentDir, runConfig: { cwd, sessionRoot, credential: { kind: 'stored', providerId: 'anthropic' }, modelId, toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } } }) + '\n');
    await until(() => {
      if (error) throw error;
      assert.equal(owned.exitCode, null, 'Child exited before initialization');
      return frames.some(frame => frame.type === 'response' && frame.requestId === 'init');
    });
    const ready = frames.find(frame => frame.type === 'response' && frame.requestId === 'init');
    assert.ok(ready?.type === 'response' && ready.ok && ready.providerSessionId);
    assert.notEqual(ready.providerSessionId, 'app-not-sdk-id');
    assert.match(ready.providerSessionId, /^[a-f0-9-]{36}$/i, 'SessionManager native UUID, not App identity');
    const promptCount = frames.filter(frame => frame.type === 'event' && ['agent_start', 'message_start', 'tool_execution_start'].includes(String(frame.event.kind))).length;
    assert.equal(promptCount, 0);
    owned.stdin!.write(JSON.stringify({ ...identity, requestId: 'close', runId: 'close', type: 'close', actionId: 'offline-close' }) + '\n');
    await until(() => owned.exitCode !== null || owned.signalCode !== null, 15000);
    assert.ok(frames.some(frame => frame.type === 'response' && frame.requestId === 'close' && frame.ok), 'Close acknowledges native disposal');
    assert.equal(owned.exitCode, 0);
    assert.equal(owned.signalCode, null, 'Successful disposal must not need process termination');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.end();
      try { await until(() => child!.exitCode !== null || child!.signalCode !== null, 10000); }
      catch { child.kill('SIGKILL'); await until(() => child!.exitCode !== null || child!.signalCode !== null, 5000); }
    }
    await rm(root, { recursive: true, force: true });
  }
});
