import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { acquireConsoleTerminal, bindConsoleInput } from './gjc-herdr-task-console.js';

const require = createRequire(import.meta.url);
const source = (name: string) => fileURLToPath(new URL(name, import.meta.url));
async function until<T>(label: string, observe: () => T | Promise<T>): Promise<NonNullable<T>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Deadline: ${label}`);
}

test('terminal lease preserves prior raw state, ignores pipes, and EOF resets input without owner shutdown', () => {
  for (const initial of [false, true]) {
    const calls: boolean[] = [];
    const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: initial, setRawMode(value: boolean) { calls.push(value); } });
    const output = Object.assign(new PassThrough(), { isTTY: true });
    let bytes = '';
    output.on('data', chunk => { bytes += String(chunk); });
    const lease = acquireConsoleTerminal(input, output);
    const events: unknown[] = [];
    const detach = bindConsoleInput(input, event => events.push(event), lease.restore);
    input.write(':prompt unfinished');
    input.emit('end');
    detach(); lease.restore();
    assert.deepEqual(calls, [true, initial]);
    assert.deepEqual(events, [{ type: 'reject', reason: 'incomplete_input' }]);
    assert.equal(bytes, '\x1b[?2004h\x1b[?2004l');
    assert.equal(input.listenerCount('data'), 0);
    assert.equal(input.listenerCount('close'), 0);
  }
  const pipe = Object.assign(new PassThrough(), { setRawMode() { assert.fail('pipe must not become raw'); } });
  const output = new PassThrough();
  assert.equal(acquireConsoleTerminal(pipe, output).active, false);
  const calls: boolean[] = [];
  const tty = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(value: boolean) { calls.push(value); } });
  const lease = acquireConsoleTerminal(tty, output);
  lease.restore();
  assert.deepEqual(calls, [true, false]);
  assert.equal(output.readableLength, 0, 'redirected output receives no terminal mode codes');
  const failedCalls: boolean[] = [];
  const failing = Object.assign(new PassThrough(), {
    isTTY: true, isRaw: true,
    setRawMode(value: boolean) { failedCalls.push(value); if (failedCalls.length === 1) throw new Error('raw setup failed'); },
  });
  const exitListeners = process.listenerCount('exit');
  assert.throws(() => acquireConsoleTerminal(failing, output), /raw setup failed/);
  assert.deepEqual(failedCalls, [true, true], 'failed acquisition restores an initially raw terminal');
  assert.equal(process.listenerCount('exit'), exitListeners);
});

test('physical PTY draft cancellation, no kernel echo, paste rejection and SIGHUP preserve one private SDK until graceful close', { timeout: 90_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owned-console-pty-'));
  const statsFile = path.join(root, 'stats.json');
  const ownedFile = path.join(root, 'owned.json');
  const childScript = path.join(root, 'child.ts');
  const hostScript = path.join(root, 'host.mts');
  const stats = async () => JSON.parse(await readFile(statsFile, 'utf8'));
  let terminal = '';
  let exited = false;
  let exitCode: number | undefined;
  let host: import('node-pty').IPty | undefined;
  let childPid: number | undefined;
  let failed = false;
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const cleanup = async (operation: () => Promise<void>) => {
    try { await operation(); } catch (error) { cleanupErrors.push(error); }
  };
  const gone = (pid: number) => {
    try { process.kill(pid, 0); return false; }
    catch (error: any) { if (error.code === 'ESRCH') return true; throw error; }
  };
  try {
    await writeFile(childScript, `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runManagedChild } from ${JSON.stringify(source('./gjc-herdr-managed-child.ts'))};
import { GjcBunSdkAdapter } from ${JSON.stringify(source('./gjc-bun-sdk-adapter.ts'))};
const model = { id: 'managed-model', provider: 'managed-provider' };
const authStorage = { exportSnapshot: () => ({ credentials: [] }), setRuntimeApiKey() {}, removeRuntimeApiKey() {} };
const registry = { authStorage, getAll: () => [model], getAvailable: () => [model] };
const stats = { pid: process.pid, creations: 0, prompts: [], aborts: 0, disposed: false, providerSessionId: '' };
const save = () => writeFile(${JSON.stringify(statsFile)}, JSON.stringify(stats));
await runManagedChild({ createAdapter: async () => new GjcBunSdkAdapter(authStorage, registry, {
  settings: { cloneForCwd: async () => ({ override() {} }) },
  createSessionFactory: async input => {
    ++stats.creations; stats.providerSessionId = input.sessionManager.getSessionId(); await save();
    const listeners = new Set();
    const session = {
      model, thinkingLevel: 'high', isStreaming: false,
      setSdkPermissionMode() {}, setSdkPermissionProvider() {},
      setModelTemporary: async () => {}, setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
      getContextUsage: () => ({ tokens: 1, contextWindow: 100, source: 'exact' }),
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text) {
        stats.prompts.push(text); await save();
        input.sessionManager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
        const message = { role: 'assistant', content: [{ type: 'text', text: 'pty-completed' }], stopReason: 'stop', timestamp: Date.now() };
        input.sessionManager.appendMessage(message); await input.sessionManager.flush();
        for (const listener of listeners) listener({ type: 'message_end', message });
      },
      async abort() { ++stats.aborts; await save(); },
      async dispose() {
        assert.equal((await input.sessionManager.flushAndCloseStrict()).kind, 'closed');
        stats.disposed = true; await save();
      },
    };
    return { session, setToolUIContext() {} };
  },
}) });
`);
    await writeFile(hostScript, `
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { initializeDatabase } from ${JSON.stringify(source('./modules/database/index.ts'))};
import { herdrManagedDb } from ${JSON.stringify(source('./modules/database/repositories/herdr-managed.db.ts'))};
import { initializeManagedChildSession, runHerdrTaskHostStdio, installHerdrTaskHostShutdown } from ${JSON.stringify(source('./gjc-herdr-task-host.ts'))};
await initializeDatabase();
const bootstrap = { appSessionId: 'pty-session', ownerGeneration: 'pty-owner', herdrInstanceId: 'pty-herdr', projectPath: ${JSON.stringify(root)}, sessionRoot: ${JSON.stringify(root)} };
herdrManagedDb.reserve(bootstrap);
let child;
const host = await runHerdrTaskHostStdio({ bootstrap, createSession: async input => {
  child = spawn(${JSON.stringify(process.env.HERDR_LIFETIME_BUN ?? source('../dist-native/bun'))}, ['--tsconfig-override', ${JSON.stringify(source('./tsconfig.json'))}, ${JSON.stringify(childScript)}], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GJC_RUNTIME_API_KEY: 'test-only' } });
  child.stderr.resume();
  await writeFile(${JSON.stringify(ownedFile)}, JSON.stringify({ hostPid: process.pid, childPid: child.pid }));
  return initializeManagedChildSession(child, { ...input, agentDir: ${JSON.stringify(root)}, runConfig: { cwd: bootstrap.projectPath, sessionRoot: bootstrap.sessionRoot, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'managed-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } } });
} });
installHerdrTaskHostShutdown(host);
`);
    const pty = require(process.env.HERDR_LIFETIME_PTY ?? 'node-pty') as typeof import('node-pty');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key))) as Record<string, string>;
    Object.assign(env, { DATABASE_PATH: path.join(root, 'app.sqlite'), TSX_TSCONFIG_PATH: source('./tsconfig.json') });
    host = pty.spawn(process.env.HERDR_LIFETIME_NODE ?? process.execPath, ['--import', require.resolve('tsx'), hostScript], { cwd: root, env, name: 'xterm-256color', cols: 120, rows: 30 });
    host.onData(data => { terminal += data; assert.ok(terminal.length < 64_000); });
    host.onExit(event => { exited = true; exitCode = event.exitCode; });
    await until('ready on real TTY', () => terminal.includes('Input is not echoed'));
    assert.ok(terminal.includes('\x1b[?2004h'));
    const owned = JSON.parse(await readFile(ownedFile, 'utf8'));
    assert.equal(owned.hostPid, host.pid); childPid = owned.childPid;
    const before = await stats();
    assert.equal(before.pid, childPid);
    const status = async () => {
      const start = terminal.length;
      host!.write(':status\r');
      return until('status barrier', () => /STATUS (\w+) (\d+)/.exec(terminal.slice(start)));
    };
    const initial = await status();
    host.write(`:prompt cancelled ${initial[2]} "draft"\x03\x04\r`);
    await status();
    assert.equal(exited, false); process.kill(host.pid, 0); process.kill(childPid!, 0);
    assert.deepEqual(await stats(), before, 'raw Ctrl-C/Ctrl-D did not prompt, abort, dispose or replace the SDK');
    host.write(`:prompt escaped ${initial[2]} "draft"\x1b`);
    await status();
    assert.deepEqual(await stats(), before, 'Escape cancels the draft without touching the SDK');
    host.write(`\x1b[200~:prompt pasted ${initial[2]} "one"\n:prompt partial ${initial[2]} "two"\x1b[201~\r`);
    await status();
    assert.deepEqual(await stats(), before, 'multiline bracketed paste and Enter cannot dispatch either command');
    const marker = 'unsubmitted-secret-no-kernel-echo';
    // This is a raw no-echo probe, not a claim that the SDK emitted a secret-tagged ask.
    host.write(`:answer secret pty-session/pty-owner/provider/turn/ask "${marker}"`);
    host.write('\x03');
    await status();
    assert.equal(terminal.includes(marker), false, 'unsubmitted JSON-shaped answer is not echoed by the kernel');
    const ready = await status();
    host.write(`:prompt accepted ${ready[2]} "explicit-valid-prompt"\r`);
    await until('one accepted prompt settles', () => /ACK accepted settled \d+/.test(terminal));
    const after = await stats();
    assert.deepEqual(after.prompts, ['explicit-valid-prompt']);
    assert.equal(after.creations, 1); assert.equal(after.pid, before.pid);
    assert.equal(after.providerSessionId, before.providerSessionId);
    assert.equal(after.aborts, 0); assert.equal(after.disposed, false);
    process.kill(host.pid, 'SIGHUP');
    await until('production SIGHUP shutdown helper exits', () => exited);
    assert.equal(exitCode, 0);
    assert.equal((await stats()).disposed, true, 'real native writer closed before successful owner exit');
    await until('private child exited', () => gone(childPid!));
    assert.ok(terminal.includes('\x1b[?2004l'));
  } catch (error) {
    failed = true;
    failure = error;
  }
  await cleanup(async () => {
    if (host && !exited) {
      process.kill(host.pid, 'SIGTERM');
      try { await until('cleanup owner exit', () => exited); }
      catch { if (!exited) process.kill(host.pid, 'SIGKILL'); await until('forced owner exit', () => exited); }
    }
  });
  await cleanup(async () => {
    if (childPid === undefined) {
      try {
        const owned = JSON.parse(await readFile(ownedFile, 'utf8'));
        if (owned.hostPid === host?.pid) childPid = owned.childPid;
      } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    }
  });
  await cleanup(async () => {
    if (childPid !== undefined && !gone(childPid)) {
      process.kill(childPid, 'SIGKILL');
      await until('cleanup exact private child PID', () => gone(childPid!));
    }
  });
  await cleanup(() => rm(root, { recursive: true, force: true }));
  if (cleanupErrors.length) throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], 'Owned terminal cleanup failed.', failed ? { cause: failure } : undefined);
  if (failed) throw failure;
});
