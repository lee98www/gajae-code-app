#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

let stopDefaultProbe;
export const requiredManagedSmokePaths = [
  'package.json', 'dist-native/bun', 'dist-server/server/index.js',
  'dist-server/server/gjc-herdr-task-host.js', 'dist-server/server/gjc-herdr-managed-child.js',
  'dist-server/server/gjc-bun-sdk-adapter.js',
  'dist-server/server/e2e/fixtures/herdr-managed-sdk-child.js',
  'dist-server/server/modules/database/index.js',
  'dist-server/server/modules/database/repositories/herdr-managed-provision.db.js',
  'dist-server/server/modules/herdr/index.js',
  'dist-server/shared/herdr-managed-state.js',
];
export async function validateManagedRuntimeRoot(runtimeRoot) {
  assert.ok(path.isAbsolute(runtimeRoot), 'runtimeRoot must be absolute');
  const root = await fs.realpath(runtimeRoot);
  for (let parent = path.dirname(root); parent !== path.dirname(parent); parent = path.dirname(parent)) {
    const hasModules = await fs.stat(path.join(parent, 'node_modules')).then(stat => stat.isDirectory(), () => false);
    assert.equal(hasModules, false, 'Runtime root has an ancestor node_modules fallback');
  }
  for (const relative of requiredManagedSmokePaths) {
    const resolved = await fs.realpath(path.join(root, relative));
    assert.ok(resolved.startsWith(root + path.sep), `Runtime closure escapes copied root: ${relative}`);
    assert.ok((await fs.stat(resolved)).isFile(), `Missing runtime file: ${relative}`);
  }
  const require = createRequire(path.join(root, 'package.json'));
  const pty = await fs.realpath(require.resolve('node-pty'));
  assert.ok(pty.startsWith(root + path.sep), 'node-pty escaped copied root');
  return root;
}
export function validateManagedSmokeEvidence(value) {
  assert.equal(value?.schemaVersion, 1);
  assert.equal(value.deterministicSdk?.verified, true);
  assert.equal(value.app?.healthBefore, true);
  assert.equal(value.app?.exitObserved, true);
  assert.equal(value.app?.healthAfter, true);
  assert.equal(value.app?.ownsAttach, false);
  assert.equal(value.host?.sameIdentity, true);
  assert.equal(value.host?.ptyReady, true);
  assert.equal(value.host?.settlements, 1);
  assert.equal(value.cleanupComplete, true);
  assert.equal(value.defaultSdk?.attempted, true);
  assert.equal(value.defaultSdk?.verified, true, 'Release requires verified installed default SDK initialization');
  assert.equal(value.defaultSdk?.productionEntrypoint, true);
  assert.equal(value.defaultSdk?.closed, true);
  assert.equal(value.defaultSdk?.promptCount, 0);
  return value;
}
async function until(label, observe, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await observe();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Managed smoke deadline: ${label}`);
}
async function stop(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try { await until('owned process exit', () => child.exitCode !== null || child.signalCode !== null, 10000); }
  catch { child.kill('SIGKILL'); await until('owned process kill', () => child.exitCode !== null || child.signalCode !== null, 5000); }
}
export async function requireOfflineDefaultFactoryReadiness(root, scratch) {
  const receipt = path.join(scratch, 'default-probe.json');
  const evidence = { attempted: true, verified: false, promptCount: 0 };
  await fs.writeFile(receipt, JSON.stringify(evidence), { mode: 0o600 });
  try {
  const agentDir = path.join(scratch, 'default-agent');
  const cwd = path.join(scratch, 'default-project');
  const sessionRoot = path.join(scratch, 'default-sessions');
  for (const dir of [agentDir, cwd, sessionRoot]) await fs.mkdir(dir, { mode: 0o700 });
  const setup = path.join(scratch, 'default-setup.mjs');
  await fs.writeFile(setup, `
import {realpath} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
const load=async subpath=>{
  const resolved=await realpath(Bun.resolveSync('@gajae-code/coding-agent/'+subpath,${JSON.stringify(root)}));
  if(!resolved.startsWith(${JSON.stringify(root + path.sep)}))throw Error('SDK escaped copied root');
  return import(pathToFileURL(resolved).href);
};
const {discoverAuthStorage}=await load('sdk/session');
const {Settings}=await load('config/settings');
const agentDir=${JSON.stringify(agentDir)};
const settings=await Settings.init({agentDir});
settings.setGlobalModelRole('default','anthropic/claude-sonnet-4-20250514');
await settings.flushOrThrow();
const auth=await discoverAuthStorage(agentDir);
await auth.set('anthropic',{type:'api_key',key:'fixture-only-never-send'});
auth.close();
`, { mode: 0o600 });
  const setupChild = spawn(path.join(root, 'dist-native/bun'), [setup], { cwd, env: process.env, stdio: 'ignore' });
  stopDefaultProbe = () => stop(setupChild);
  let setupError;
  setupChild.on('error', error => { setupError = error; });
  try {
    await until('persistent SDK fixture setup', () => { if (setupError) throw setupError; return setupChild.exitCode !== null || setupChild.signalCode !== null; });
    assert.equal(setupChild.exitCode, 0, 'SDK persistent fixture setup failed');
  } finally { await stop(setupChild); stopDefaultProbe = undefined; }
  const { createManagedGjcSdkSessionFactory } = await import(pathToFileURL(path.join(root, 'dist-server/server/gjc-herdr-task-host.js')).href);
  const bootstrap = {
    appSessionId: 'default-sdk-probe', ownerGeneration: 'default-sdk-generation', herdrInstanceId: 'probe',
    projectPath: cwd, sessionRoot, agentDir,
    runConfig: { cwd, sessionRoot, credential: { kind: 'stored', providerId: 'anthropic' }, modelId: 'anthropic/claude-sonnet-4-20250514', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } },
  };
  const events = [];
  const session = await createManagedGjcSdkSessionFactory(bootstrap)({
    appSessionId: bootstrap.appSessionId, ownerGeneration: bootstrap.ownerGeneration, cwd, sessionRoot,
    onEvent: event => { events.push(event); },
  });
  stopDefaultProbe = () => session.dispose();
  try {
    assert.ok(typeof session.providerSessionId === 'string' && session.providerSessionId.length > 0, 'Default SDK must return its native session ID');
    assert.notEqual(session.providerSessionId, bootstrap.appSessionId);
    assert.equal(events.some(frame => ['agent_start', 'message_start', 'tool_execution_start'].includes(frame.event?.kind)), false);
    evidence.providerSessionId = session.providerSessionId;
  } finally { await session.dispose(); stopDefaultProbe = undefined; }
  evidence.productionHost = await requireProductionDefaultEntrypoint(root, scratch, bootstrap, evidence.providerSessionId);
  evidence.productionEntrypoint = true;
  evidence.verified = true;
  evidence.closed = true;
  await fs.writeFile(receipt, JSON.stringify(evidence), { mode: 0o600 });
  return evidence;
  } catch {
    evidence.verified = false;
    evidence.reason = 'Offline default SDK readiness or owned shutdown failed.';
    await fs.writeFile(receipt, JSON.stringify(evidence), { mode: 0o600 });
    const error = new Error(evidence.reason);
    error.defaultSdk = evidence;
    throw error;
  }
}
async function requireProductionDefaultEntrypoint(root, scratch, fixture, factoryProviderId) {
  const load = relative => import(pathToFileURL(path.join(root, 'dist-server', relative)).href);
  const { initializeDatabase } = await load('server/modules/database/index.js');
  const { closeConnection } = await load('server/modules/database/connection.js');
  const { sessionsDb } = await load('server/modules/database/repositories/sessions.db.js');
  const { herdrManagedProvisionDb: db } = await load('server/modules/database/repositories/herdr-managed-provision.db.js');
  const { HerdrManagedAttachClient } = await load('server/modules/herdr/index.js');
  const id = 'production-default-probe';
  let bootstrap;
  try {
    await initializeDatabase();
    sessionsDb.createAppSession(id, 'gjc', fixture.projectPath);
    db.registerNewSession(id, fixture.projectPath);
    const record = db.reserve(id, { name: 'default-probe', canonicalPath: path.join(scratch, 'default-herdr.sock'), dev: 1, inode: 1 }, fixture.projectPath);
    db.cas(id, record.ownerGeneration, 'reserved', 'layout_requested');
    db.cas(id, record.ownerGeneration, 'layout_requested', 'layout_created', 'workspace', { sessionName: 'default-probe', workspaceId: 'workspace', tabId: 'tab', paneId: 'pane', terminalId: 'terminal' });
    bootstrap = { ...fixture, appSessionId: id, ownerGeneration: record.ownerGeneration, claimNonce: record.claimNonce, herdrInstanceId: 'default-probe', databasePath: process.env.DATABASE_PATH, attachSocketPath: path.join(scratch, 'default-attach.sock'), attachSecret: randomBytes(32).toString('hex') };
  } finally { closeConnection(); }
  const bootstrapPath = path.join(scratch, 'default-bootstrap.json');
  await fs.writeFile(bootstrapPath, JSON.stringify(bootstrap), { mode: 0o600 });
  const pty = createRequire(path.join(root, 'package.json'))('node-pty');
  const terminal = pty.spawn(process.execPath, [path.join(root, 'dist-server/server/gjc-herdr-task-host.js'), bootstrapPath], { cwd: fixture.projectPath, env: process.env, name: 'xterm-256color', cols: 160, rows: 40 });
  let exited = false, exitCode, output = '', client, projection;
  terminal.onExit(event => { exited = true; exitCode = event.exitCode; });
  terminal.onData(data => { output = (output + data).slice(-64000); });
  const close = async () => {
    if (!exited) terminal.kill('SIGTERM');
    try { await until('production default graceful exit', () => exited, 15000); }
    catch { terminal.kill('SIGKILL'); await until('production default forced exit', () => exited, 5000); throw new Error('Production default graceful close failed'); }
  };
  stopDefaultProbe = close;
  try {
    await until('production default READY', () => { assert.equal(exited, false, 'Production host exited before readiness'); return output.includes('READY'); });
    client = new HerdrManagedAttachClient({ appSessionId: id, ownerGeneration: bootstrap.ownerGeneration, socketPath: bootstrap.attachSocketPath, attachSecret: bootstrap.attachSecret });
    await client.connect(); await client.recover();
    assert.equal(client.state.lifecycle, 'idle');
    assert.equal(client.state.identity.ownerGeneration, bootstrap.ownerGeneration);
    assert.ok(client.state.watermark > 0, 'Production readiness must be durably projected');
    assert.ok(client.state.providerSessionId);
    assert.notEqual(client.state.providerSessionId, id);
    assert.notEqual(client.state.providerSessionId, factoryProviderId);
    assert.equal(Object.keys(client.state.commands).length, 0);
    assert.equal(Object.keys(client.state.requests).length, 0);
    projection = { pid: terminal.pid, providerSessionId: client.state.providerSessionId, ownerGeneration: bootstrap.ownerGeneration, watermark: client.state.watermark };
  } finally {
    client?.close();
    try { await close(); } finally { stopDefaultProbe = undefined; }
  }
  assert.equal(exitCode, 0, 'Production host must await native SDK closure');
  return { ...projection, closed: true, exitCode };
}
export async function runManagedHostSmoke({ runtimeRoot, nodePath }) {
  const root = await validateManagedRuntimeRoot(runtimeRoot);
  assert.ok(path.isAbsolute(nodePath), 'Explicit absolute Node runtime required');
  const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hm-')));
  await fs.chmod(scratch, 0o700);
  let child;
  try {
    await fs.mkdir(path.join(scratch, 'home'), { mode: 0o700 });
    await fs.mkdir(path.join(scratch, 'bin'), { mode: 0o700 });
    await fs.writeFile(path.join(scratch, 'bin/gjc'), '#!/bin/sh\nexit 97\n', { mode: 0o700 });
    const script = path.join(scratch, 'supervisor.mjs');
    await fs.copyFile(fileURLToPath(import.meta.url), script);
    const env = { HOME: path.join(scratch, 'home'), PATH: path.join(scratch, 'bin') + ':/usr/bin:/bin', TMPDIR: scratch, LANG: 'en_US.UTF-8', DATABASE_PATH: path.join(scratch, 'app.sqlite'), GJC_WORKER_AGENT_DIR: path.join(scratch, 'agent') };
    child = spawn(nodePath, [script, '--managed-supervisor', root, scratch], { cwd: root, env, stdio: ['ignore', 'ignore', 'pipe'] });
    let diagnosticBytes = 0;
    let diagnostic = '';
    child.stderr.on('data', data => {
      diagnosticBytes += data.length;
      if (Buffer.byteLength(diagnostic) < 8192) diagnostic += data.toString().slice(0, 8192 - diagnostic.length);
    });
    let launchError;
    child.on('error', error => { launchError = error; });
    await until('supervisor', () => { if (launchError) throw launchError; return child.exitCode !== null || child.signalCode !== null; }, 150000);
    const defaultSdk = await fs.readFile(path.join(scratch, 'default-probe.json'), 'utf8').then(JSON.parse, () => null);
    if (defaultSdk?.verified !== true && defaultSdk) {
      const error = new Error(defaultSdk.reason);
      error.defaultSdk = defaultSdk;
      throw error;
    }
    const safeDiagnostic = diagnostic.replaceAll(root, '<runtime>').replaceAll(scratch, '<scratch>')
      .replaceAll('fixture-only-never-send', '<fixture-credential>').replaceAll('test-only-no-provider', '<fixture-credential>');
    assert.equal(child.exitCode, 0, `Managed supervisor failed (${diagnosticBytes} diagnostic bytes): ${safeDiagnostic}`);
    return validateManagedSmokeEvidence(JSON.parse(await fs.readFile(path.join(scratch, 'evidence.json'), 'utf8')));
  } finally {
    if (child) await stop(child);
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

async function scenario(root, scratch) {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  assert.ok(major === 22 && (minor > 22 || (minor === 22 && patch >= 2)), 'Supported Node >=22.22.2 <23 required');
  if (process.platform === 'darwin') {
    assert.equal(path.basename(process.execPath), 'gajae-app-server-aarch64-apple-darwin');
    assert.ok(process.execPath.startsWith(root + path.sep), 'macOS must execute copied shipped sidecar');
  }
  const load = relative => import(pathToFileURL(path.join(root, 'dist-server', relative)).href);
  const { initializeDatabase } = await load('server/modules/database/index.js');
  const { closeConnection } = await load('server/modules/database/connection.js');
  const { sessionsDb } = await load('server/modules/database/repositories/sessions.db.js');
  const { herdrManagedProvisionDb: db } = await load('server/modules/database/repositories/herdr-managed-provision.db.js');
  const { HerdrManagedAttachClient } = await load('server/modules/herdr/index.js');
  await initializeDatabase();
  const project = path.join(scratch, 'project');
  await fs.mkdir(project, { mode: 0o700 });
  const id = 'packaged-smoke';
  sessionsDb.createAppSession(id, 'gjc', project); db.registerNewSession(id, project);
  const record = db.reserve(id, { name: 'smoke-owned', canonicalPath: path.join(scratch, 'unused.sock'), dev: 1, inode: 1 }, project);
  db.cas(id, record.ownerGeneration, 'reserved', 'layout_requested');
  db.cas(id, record.ownerGeneration, 'layout_requested', 'layout_created', 'workspace', { sessionName: 'smoke-owned', workspaceId: 'workspace', tabId: 'tab', paneId: 'pane', terminalId: 'terminal' });
  const bootstrap = { appSessionId: id, ownerGeneration: record.ownerGeneration, claimNonce: record.claimNonce, herdrInstanceId: 'smoke-owned', projectPath: project, sessionRoot: path.join(scratch, 'native'), agentDir: path.join(scratch, 'agent'), databasePath: process.env.DATABASE_PATH, attachSocketPath: path.join(scratch, 'attach.sock'), attachSecret: randomBytes(32).toString('hex'), runConfig: { cwd: project, sessionRoot: path.join(scratch, 'native'), credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'lifetime-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } } };
  await fs.mkdir(bootstrap.sessionRoot); await fs.mkdir(bootstrap.agentDir, { recursive: true });
  closeConnection();
  const moduleUrl = relative => JSON.stringify(pathToFileURL(path.join(root, 'dist-server/server', relative)).href);
  const hostScript = path.join(scratch, 'host.mjs');
  await fs.writeFile(hostScript, `
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {initializeManagedChildSession,runHerdrTaskHostStdio} from ${moduleUrl('gjc-herdr-task-host.js')};
const bootstrap=${JSON.stringify(bootstrap)};
let child;
let closing=false;
const close=async()=>{if(closing)return;closing=true;const timer=setTimeout(()=>{child.kill('SIGKILL');process.exit(2)},8000);try{await host.close()}finally{clearTimeout(timer);process.exit(0)}};
const host=await runHerdrTaskHostStdio({bootstrap,createSession:async input=>{
 child=spawn(${JSON.stringify(path.join(root, 'dist-native/bun'))},[${JSON.stringify(path.join(root, 'dist-server/server/e2e/fixtures/herdr-managed-sdk-child.js'))},${JSON.stringify(path.join(scratch, 'sdk.json'))}],{cwd:bootstrap.projectPath,env:{...process.env,GJC_RUNTIME_API_KEY:'test-only-no-provider'},stdio:['pipe','pipe','pipe']});
 child.stderr.resume();
 await writeFile(${JSON.stringify(path.join(scratch, 'owned.json'))},JSON.stringify({hostPid:process.pid,childPid:child.pid}));
 return initializeManagedChildSession(child,{...input,agentDir:bootstrap.agentDir,runConfig:bootstrap.runConfig});
}});
process.on('SIGTERM',close);process.on('SIGINT',close);
child.on('exit',()=>{if(!closing)process.exit(1)});
`, { mode: 0o600 });
  const apps = [];
  let terminal, exited = false, output = '', client;
  let owned;
  // Supervisor termination must not strand either the PTY owner or its child.
  process.once('SIGTERM', () => {
    void (async () => {
      await stopDefaultProbe?.().catch(() => {});
      for (const child of apps) await stop(child);
      if (terminal && !exited) terminal.kill('SIGKILL');
      const receipt = await fs.readFile(path.join(scratch, 'owned.json'), 'utf8').then(JSON.parse, () => null);
      if (receipt?.hostPid === terminal?.pid) {
        try { process.kill(receipt.childPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
      process.exit(143);
    })();
  });
  const evidence = { schemaVersion: 1, nodeVersion: process.version, nodeOwnership: process.platform === 'darwin' ? 'copied-shipped-sidecar' : 'explicit-system-prerequisite', deterministicSdk: { verified: false }, defaultSdk: { verified: false, reason: 'Offline default factory initialization not verified; deterministic provider fixture is not production SDK authentication evidence.' }, app: { ownsAttach: false }, host: {}, cleanupComplete: false };
  const bunVersion = spawnSync(path.join(root, 'dist-native/bun'), ['--version'], { env: process.env, encoding: 'utf8', timeout: 5000 });
  assert.equal(bunVersion.status, 0, 'Copied Bun version probe failed');
  evidence.bunVersion = bunVersion.stdout.trim();
  async function app() {
    const listener = net.createServer();
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    const child = spawn(process.execPath, [path.join(root, 'dist-server/server/index.js')], { cwd: root, env: { ...process.env, SERVER_PORT: String(port), HOST: '127.0.0.1' }, stdio: 'ignore' });
    apps.push(child);
    child.on('error', () => {});
    await until('actual App health', async () => {
      assert.equal(child.exitCode, null);
      try { return (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    });
    return child;
  }
  const connect = async () => {
    const next = new HerdrManagedAttachClient({ appSessionId: id, ownerGeneration: bootstrap.ownerGeneration, socketPath: bootstrap.attachSocketPath, attachSecret: bootstrap.attachSecret });
    await next.connect(); await next.recover(); return next;
  };
  try {
    evidence.defaultSdk = await requireOfflineDefaultFactoryReadiness(root, scratch);
    const first = await app(); evidence.app.healthBefore = true;
    const pty = createRequire(path.join(root, 'package.json'))('node-pty');
    terminal = pty.spawn(process.execPath, [hostScript], { cwd: project, env: process.env, name: 'xterm-256color', cols: 160, rows: 40 });
    terminal.onExit(() => { exited = true; }); terminal.onData(data => { output = (output + data).slice(-64000); });
    await until('PTY READY', () => output.includes('READY'));
    owned = JSON.parse(await fs.readFile(path.join(scratch, 'owned.json'), 'utf8'));
    assert.equal(owned.hostPid, terminal.pid);
    client = await connect();
    const before = client.state;
    // Provisioning was constructed by this isolated harness, so perform the
    // normal attach's provider mapping acknowledgement before the first turn.
    db.projectReady(id, bootstrap.ownerGeneration, before.providerSessionId);
    closeConnection();
    terminal.write(`:prompt smoke-turn ${before.watermark} "initial"\r`);
    const pending = kind => Object.values(client.state.requests).find(request => request.kind === kind && request.scope.status === 'pending');
    await until('pending ask', () => pending('ask')); await until('pending permission', () => pending('permission'));
    const identity = request => [id, bootstrap.ownerGeneration, request.providerSessionId, request.turnId, request.requestId].join('/');
    client.close(); client = undefined;
    await stop(first); evidence.app.exitObserved = true;
    assert.equal(exited, false); process.kill(terminal.pid, 0);
    const cursor = output.length; terminal.write(':status\r');
    await until('PTY status after App exit', () => output.slice(cursor).includes('STATUS'));
    client = await connect();
    assert.equal(client.state.identity.ownerGeneration, before.identity.ownerGeneration);
    assert.equal(client.state.providerSessionId, before.providerSessionId);
    const ask = pending('ask'), permission = pending('permission'); assert.ok(ask && permission);
    await app(); evidence.app.healthAfter = true;
    terminal.write(`:answer smoke-answer ${identity(ask)} "yes"\r`);
    terminal.write(`:permission smoke-permission ${identity(permission)} ${permission.policyRevision} allow-once\r`);
    await until('settled prompt', () => client.state.commands['smoke-turn']?.state === 'settled');
    const stats = JSON.parse(await fs.readFile(path.join(scratch, 'sdk.json'), 'utf8'));
    assert.equal(stats.creations, 1); assert.deepEqual(stats.prompts, ['initial']); assert.deepEqual(stats.answers, ['yes']); assert.deepEqual(stats.permissions, ['allow_once']);
    evidence.deterministicSdk = { verified: true, creations: stats.creations, childPid: stats.pid };
    evidence.host = { sameIdentity: true, ptyReady: true, settlements: 1, pid: terminal.pid, ownerGeneration: bootstrap.ownerGeneration, providerSessionId: before.providerSessionId, watermark: client.state.watermark };
  } finally {
    client?.close();
    for (const child of apps) await stop(child);
    if (terminal && !exited) {
      terminal.kill('SIGTERM');
      try { await until('PTY exit', () => exited, 12000); } catch { terminal.kill('SIGKILL'); await until('PTY forced exit', () => exited, 5000); }
    }
    owned ??= await fs.readFile(path.join(scratch, 'owned.json'), 'utf8').then(JSON.parse, () => null);
    if (owned && owned.hostPid === terminal?.pid) {
      const gone = () => { try { process.kill(owned.childPid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
      try { await until('SDK exit', gone, 10000); } catch { process.kill(owned.childPid, 'SIGKILL'); await until('SDK forced exit', gone, 5000); }
    }
  }
  const disposed = JSON.parse(await fs.readFile(path.join(scratch, 'sdk.json'), 'utf8'));
  assert.equal(disposed.disposed, true, 'Deterministic SDK native writer must close');
  evidence.cleanupComplete = true;
  await fs.writeFile(path.join(scratch, 'evidence.json'), JSON.stringify(evidence), { mode: 0o600 });
}
if (process.argv[2] === '--managed-supervisor' && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await scenario(process.argv[3], process.argv[4]);
}
