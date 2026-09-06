import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { WebSocket } from 'ws';

import { HerdrManagedAttachClient } from '../modules/herdr/index.js';
import { acceptManagedSequence, assembleManagedTransfer, projectManagedState, type ManagedChatProjection, type ManagedSnapshotFrame } from '../../shared/herdr-managed-chat.js';
import type { HerdrTaskHostBootstrap } from '../gjc-herdr-task-host.js';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}.ts`, import.meta.url));
const tsconfig = path.join(repo, 'server/tsconfig.json');
const require = createRequire(import.meta.url);
const node = process.env.HERDR_LIFETIME_NODE ?? process.execPath;
const bun = process.env.HERDR_LIFETIME_BUN ?? path.join(repo, 'dist-native/bun');
const tsx = require.resolve('tsx');
// Direct Node import, not the tsx CLI (which would add a supervisor PID).
const launch = (entry: string, ...args: string[]) => ['--import', tsx, entry, ...args];
async function json(file: string): Promise<any> { return JSON.parse(await readFile(file, 'utf8')); }
async function until<T>(description: string, observe: () => T | Promise<T>, timeout = 30_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await observe();
    if (value) return value as NonNullable<T>;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Deadline: ${description}`);
}
async function receipt(file: string, child?: ChildProcess) {
  return until(`fixture receipt ${path.basename(file)}`, async () => {
    assert.ok(!child || (child.exitCode === null && child.signalCode === null), 'App exited before ready');
    try { return await json(file); } catch (error: any) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  });
}
async function exit(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await until(`owned App ${signal} exit`, () => child.exitCode !== null || child.signalCode !== null, 10_000);
}

for (const signal of ['SIGTERM', 'SIGKILL'] as const) test(`real PTY owner outlives App ${signal}, native callbacks and two normal-chat viewers recover`, { timeout: 180_000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'managed lifetime '));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/(TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)/i.test(key))) as Record<string, string>;
  Object.assign(env, { TSX_TSCONFIG_PATH: tsconfig, DATABASE_PATH: path.join(root, 'app.sqlite') });
  const apps: ChildProcess[] = [];
  const viewers: WebSocket[] = [];
  let host: import('node-pty').IPty | undefined;
  let hostExited = false;
  let observer: HerdrManagedAttachClient | undefined;
  let hostReceipt: any;
  let diagnosticBytes = 0;
  let terminal = '';
  let failedStage = '';
  let primaryFailure: Error | undefined;
  const cleanupFailures: unknown[] = [];
  const cleanupStep = async (action: () => void | Promise<void>) => {
    try { await action(); } catch (error) { cleanupFailures.push(error); }
  };
  async function app(index: number) {
    const ready = path.join(root, `app-${index}.json`);
    const child = spawn(node, launch(fixture('herdr-managed-test-app'), root, ready), { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    apps.push(child);
    child.stdout!.on('data', chunk => { diagnosticBytes += chunk.length; });
    child.stderr!.on('data', chunk => { diagnosticBytes += chunk.length; });
    const info = await receipt(ready, child);
    assert.equal(info.pid, child.pid);
    return { child, port: info.port as number };
  }
  function command(value: string) { assert.ok(host && !hostExited); host.write(value + '\r'); }
  try {
    const first = await app(1);
    const bootstrap: HerdrTaskHostBootstrap = await json(path.join(root, 'bootstrap.json'));
    const pty = require(process.env.HERDR_LIFETIME_PTY ?? 'node-pty') as typeof import('node-pty');
    host = pty.spawn(node, launch(fixture('herdr-managed-test-host'), path.join(root, 'bootstrap.json'), bun, path.join(root, 'sdk.json'), path.join(root, 'host.json')), { cwd: root, env, name: 'xterm-256color', cols: 160, rows: 40 });
    host.onExit(() => { hostExited = true; });
    host.onData(data => { terminal = (terminal + data).slice(-64_000); });
    hostReceipt = await receipt(path.join(root, 'host.json'));
    assert.equal(hostReceipt.hostPid, host.pid);
    observer = new HerdrManagedAttachClient({ appSessionId: bootstrap.appSessionId, ownerGeneration: bootstrap.ownerGeneration, socketPath: bootstrap.attachSocketPath!, attachSecret: bootstrap.attachSecret! });
    await observer.connect(); await observer.recover();
    const state = () => observer!.state!;
    const pending = (kind: string) => Object.values(state().requests).find(request => request.kind === kind && request.scope.status === 'pending');
    const identity = (request: NonNullable<ReturnType<typeof pending>>) => [bootstrap.appSessionId, bootstrap.ownerGeneration, request.providerSessionId, request.turnId, request.requestId].join('/');
    async function viewer(port: number, onBegin?: () => void) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`); viewers.push(ws);
      let projection: ManagedChatProjection | undefined;
      let frames: ManagedSnapshotFrame[] = [];
      let beginCount = 0;
      let largestPages = 0;
      let error: Error | undefined;
      ws.on('message', bytes => {
        try {
          const frame = JSON.parse(bytes.toString());
          if (frame.kind === 'protocol_error' || frame.status === 'projection_unavailable') throw new Error('Normal chat routing failed');
          if (frame.kind === 'managed_command_result' && frame.result?.ok === false) {
            throw new Error(`Managed command rejected: ${String(frame.result.error)}`);
          }
          if (frame.kind === 'managed_snapshot_begin') { frames = [frame]; largestPages = Math.max(largestPages, frame.pageCount); if (++beginCount === 1) onBegin?.(); }
          else if (frame.kind === 'managed_snapshot_page') frames.push(frame);
          else if (frame.kind === 'managed_snapshot_end') { frames.push(frame); projection = assembleManagedTransfer(frames); }
          else if (frame.kind === 'managed_live_event') {
            assert.ok(projection, 'live cannot precede snapshot');
            const accepted = acceptManagedSequence({ sessionId: bootstrap.appSessionId, ownerGeneration: projection.metadata.ownerGeneration, watermark: projection.metadata.watermark }, { appSessionId: frame.sessionId, ownerGeneration: frame.ownerGeneration }, frame.seq);
            assert.notEqual(accepted, 'gap'); assert.notEqual(accepted, 'stale');
            if (accepted === 'apply') projection = frame.projection;
          }
        } catch (caught) { error = caught as Error; }
      });
      await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.send(JSON.stringify({ type: 'chat.subscribe', sessions: [{ sessionId: bootstrap.appSessionId, lastSeq: 0 }] }));
      return { ws, get projection() { if (error) throw error; return projection; }, get pages() { return largestPages; } };
    }
    const original = await viewer(first.port);
    await until('original normal chat subscription', () => original.projection);
    original.ws.send(JSON.stringify({ type: 'chat.send', sessionId: bootstrap.appSessionId, actionId: 'app-turn', content: 'initial' }));
    await until('native ask before App exit', () => { void original.projection; return pending('ask'); });
    const permission = await until('native permission before App exit', () => pending('permission'));
    const initialAsk = pending('ask')!;
    const before = await json(path.join(root, 'sdk.json'));
    await exit(first.child, signal);
    assert.ok(first.child.exitCode !== null || first.child.signalCode !== null);
    process.kill(hostReceipt.hostPid, 0); process.kill(before.pid, 0);
    assert.equal(hostExited, false);
    command(`:answer initial-answer ${identity(initialAsk)} "yes"`);
    command(':followup queued-followup "followup"');
    await until('PTY followup admission', () => state().commands['queued-followup']?.state === 'admitted');
    command(`:permission first-permission ${identity(permission)} ${permission.policyRevision} allow-once`);
    await until('native FIFO completion while App dead', () => state().commands['queued-followup']?.state === 'settled' && state().activeTurnId === null && state().lifecycle === 'idle');
    command(`:prompt history-turn ${state().watermark} "history"`);
    await until('over-tail history and native pending ask', () => {
      assert.notEqual(state().commands['history-turn']?.state, 'rejected', 'history prompt admitted after idle');
      return pending('ask');
    }, 60_000);
    assert.ok(state().watermark > 5000);
    assert.match(JSON.stringify(state()), /native-partial/);
    assert.match(JSON.stringify(state()), /"lifetime":true/);
    const second = await app(2);
    const ask = pending('ask')!;
    // A real console decision races delivery of the first immutable page transfer.
    const one = await viewer(second.port, () => command(`:answer racing-answer ${identity(ask)} "yes"`));
    const two = await viewer(second.port);
    const nextPermission = await until('native permission after snapshot race', () => pending('permission'));
    await until('racing console answer durably settled', () => state().commands['racing-answer']?.state === 'settled');
    await until('both viewers converge on exact owner cursor', () => one.projection?.metadata.watermark === state().watermark && two.projection?.metadata.watermark === state().watermark);
    assert.ok(one.pages > 1 && two.pages > 1);
    assert.deepEqual(one.projection, projectManagedState(state()));
    assert.deepEqual(two.projection, projectManagedState(state()));
    assert.ok(one.projection!.pendingPermissions.length > 0);
    // Kill a restarted App while both its native prompt and permission remain pending.
    await exit(second.child, signal);
    process.kill(hostReceipt.hostPid, 0);
    command(`:permission final-permission ${identity(nextPermission)} ${nextPermission.policyRevision} allow-once`);
    await until('final prompt settles without App', () => state().commands['history-turn']?.state === 'settled');
    const third = await app(3);
    const finalOne = await viewer(third.port); const finalTwo = await viewer(third.port);
    await until('final two snapshots', () => finalOne.projection?.metadata.watermark === state().watermark && finalTwo.projection?.metadata.watermark === state().watermark);
    assert.deepEqual(finalOne.projection, projectManagedState(state())); assert.deepEqual(finalTwo.projection, projectManagedState(state()));
    const after = await json(path.join(root, 'sdk.json'));
    assert.equal(after.creations, 1); assert.equal(after.pid, before.pid); assert.equal(after.providerSessionId, before.providerSessionId);
    assert.equal(state().identity.ownerGeneration, hostReceipt.ownerGeneration);
    assert.equal(state().providerSessionId, hostReceipt.providerSessionId);
    assert.deepEqual(after.prompts, ['initial', 'followup', 'history']);
    assert.deepEqual(after.answers, ['yes', 'yes']); assert.deepEqual(after.permissions, ['allow_once', 'allow_once']);
    const history = state().extensions.filter(event => event.kind === 'managed.nativehistory').at(-1)!.payload as { jsonlPath: string };
    assert.match(await readFile(history.jsonlPath, 'utf8'), /Lifetime native title/);
    assert.match(await readFile(history.jsonlPath, 'utf8'), /finished:history/);
    assert.doesNotMatch(terminal, /test-only-no-provider/);
  } catch (error) {
    failedStage = error instanceof Error && (error.message.startsWith('Deadline:') || error.message.startsWith('Managed command rejected:')) ? error.message : 'lifetime assertion';
    // Never dump private bootstrap, SDK output, request bodies or inherited env.
    primaryFailure = new Error(`Lifetime harness failed (App diagnostic bytes=${diagnosticBytes}, PTY exited=${hostExited})`, { cause: error });
  }
    for (const ws of viewers) await cleanupStep(() => ws.terminate());
    await cleanupStep(() => observer?.close());
    for (const child of apps) {
      await cleanupStep(async () => {
        try { await exit(child, 'SIGTERM'); } catch { await exit(child, 'SIGKILL'); }
      });
    }
    if (host && !hostExited) {
      const ownedHost = host;
      await cleanupStep(async () => {
        ownedHost.kill('SIGTERM');
        try { await until('owned host writer close', () => hostExited, 12_000); }
        catch { ownedHost.kill('SIGKILL'); await until('owned host forced exit', () => hostExited, 5000); }
      });
    }
    if (hostReceipt) {
      await cleanupStep(async () => {
      const childGone = () => {
        try { process.kill(hostReceipt.childPid, 0); return false; } catch (error: any) { if (error.code === 'ESRCH') return true; throw error; }
      };
      try { await until('owned SDK process exit', childGone, 10_000); }
      catch { process.kill(hostReceipt.childPid, 'SIGKILL'); await until('owned SDK forced exit', childGone, 5000); }
      });
      await cleanupStep(async () => {
      const disposed = await json(path.join(root, 'sdk.json'));
      assert.equal(disposed.disposed, true, `SDK dispose and native writer close completed${failedStage ? `; prior failure: ${failedStage}` : ''}`);
      });
    } else {
      await cleanupStep(async () => {
      try {
        const owned = await json(path.join(root, 'host.json.owned'));
        if (owned.hostPid === host?.pid && Number.isSafeInteger(owned.childPid)) process.kill(owned.childPid, 'SIGKILL');
      } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
      });
    }
    await cleanupStep(() => rm(root, { recursive: true, force: true }));
  if (cleanupFailures.length) {
    throw new AggregateError(
      [...(primaryFailure ? [primaryFailure] : []), ...cleanupFailures],
      `Lifetime cleanup failed${failedStage ? `; prior failure: ${failedStage}` : ''}`,
      primaryFailure ? { cause: primaryFailure } : undefined,
    );
  }
  if (primaryFailure) throw primaryFailure;
});
