import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { parseGjcRunPermissions } from '../gjc-engine.js';
import { closeConnection, getConnection } from '../modules/database/connection.js';
import { INIT_SCHEMA_SQL } from '../modules/database/schema.js';
import { sessionsDb } from '../modules/database/repositories/sessions.db.js';
import { herdrManagedDb } from '../modules/database/repositories/herdr-managed.db.js';
import { herdrManagedProvisionDb as db } from '../modules/database/repositories/herdr-managed-provision.db.js';
import type { HerdrManagedPublicSelection } from '../../shared/herdr-managed-provision-protocol.js';
import { HerdrTaskHost, type HerdrTaskHostBootstrap } from '../gjc-herdr-task-host.js';
import { parseConsoleLine } from '../gjc-herdr-task-console.js';
import { HerdrError, HerdrManagedWorkspacesService, HerdrManagedAttachClient } from '../modules/herdr/index.js';
import { HerdrManagedChatService } from '../modules/herdr/services/herdr-managed-chat.js';
import { processStartToken } from '../modules/herdr/services/herdr-owner-liveness.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-provision-')));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
  try { getConnection().exec(INIT_SCHEMA_SQL); await run(root); }
  finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await fs.rm(root, { recursive: true, force: true }); }
}
const endpoint = { name: 'chosen', canonicalPath: '/owned/herdr.sock', dev: 1, inode: 2 };
/** macOS's per-user tmpdir plus a UUID directory exceeds sun_path; real sockets need a short base. */
async function socketRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'mp-')));
}
function selection(names: string[], selected: string | null): HerdrManagedPublicSelection {
  const name = selected ?? (names.length === 1 ? names[0]! : null);
  return { selectedSessionName: name, status: name ? names.includes(name) ? 'unknown' : 'unavailable' : 'selection_required', instances: names.map(name => ({ name, label: name, status: 'available' })) };
}

test('managed admission blocks ambiguity and unavailable selection without any RPC', async () => fixture(async root => {
  let opens = 0;
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'), sessions: {
    provisioningSelection: async selected => selection(['chosen', 'other'], selected),
    openProvisioningHandle: async () => { opens++; throw new Error('must not open'); },
  } });
  sessionsDb.createAppSession('app', 'gjc', '/project'); service.registerNewSession('app', '/project');
  assert.equal((await service.ensure('app', {})).status, 'selection_required');
  assert.equal((await service.select('absent')).status, 'unavailable');
  db.select('absent'); assert.equal((await service.ensure('app', {})).status, 'unavailable');
  assert.equal(opens, 0); assert.equal(db.get('app'), null);
  await assert.rejects(service.ensure('app', { credential: { kind: 'env' } } as never), /Untrusted/);
}));

test('one layout per intent, shared workspace, protected bootstrap and provider mapping before return', async () => fixture(async root => {
  let creates = 0; let layouts = 0;
  const bootstraps: Record<string, unknown>[] = [];
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'), readinessTimeoutMs: 20,
    enrich: async options => ({ ...options, modelId: 'test', toolNames: [], spawns: '*', bashPolicy: { allowedPrefixes: [] } }),
    sessions: {
      provisioningSelection: async selected => selection(['chosen'], selected),
      openProvisioningHandle: async () => ({ identity: endpoint, inspectWorkspace: async () => 'present' as const,
        createWorkspace: async () => { creates++; return { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'terminal-1' }; },
        applyLayout: async (workspaceId, argv) => {
          const layout = ++layouts;
          const file = argv[argv.length - 1]!;
          const bootstrap = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>; bootstraps.push(bootstrap);
          const permissions = (bootstrap.runConfig as Record<string, unknown>).permissions;
          assert.deepEqual(Object.keys(permissions as object).sort(), ['allowAlways', 'mode']);
          assert.deepEqual(parseGjcRunPermissions(permissions), permissions);
          assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
          assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
          assert.equal(argv[0], process.execPath); assert.ok(!argv.join(' ').includes(String(bootstrap.attachSecret)));
          assert.ok(path.isAbsolute(argv[1]!));
          const tsconfig = argv.indexOf('--tsconfig');
          assert.ok(tsconfig > 0, 'source launcher pins App aliases outside the App cwd');
          assert.equal(path.resolve(argv[tsconfig + 1]!), path.resolve('server/tsconfig.json'));
          assert.equal(bootstrap.databasePath, getConnection().name);
          const id = bootstrap.appSessionId as string; const generation = bootstrap.ownerGeneration as string;
          db.claimLaunch(id, generation, bootstrap.claimNonce as string);
          assert.throws(() => db.claimLaunch(id, generation, bootstrap.claimNonce as string));
          herdrManagedDb.beginClaim(id, generation);
          herdrManagedDb.claim({ protocolVersion: 1, appSessionId: id, ownerGeneration: generation, providerSessionId: `provider-${id}` });
          return { workspaceId, tabId: `w1:t${layout}`, paneId: `w1:p${layout}`, terminalId: `terminal-${layout}` };
        },
      }),
    },
    createClient: options => {
      class FakeClient extends HerdrManagedAttachClient {
        override async connect() { return { type: 'ready' } as never; }
        override async recover() { return herdrManagedDb.getState(options.appSessionId, options.ownerGeneration); }
      }
      return new FakeClient(options);
    },
  });
  for (const id of ['a', 'b']) { sessionsDb.createAppSession(id, 'gjc', '/project'); service.registerNewSession(id, '/project'); }
  const [a, duplicate, b] = await Promise.all([service.ensure('a', {}), service.ensure('a', {}), service.ensure('b', {})]);
  assert.equal(a.status, 'ready'); assert.deepEqual(a, duplicate); assert.equal(layouts, 2);
  assert.equal(b.status, 'ready');
  assert.equal(sessionsDb.getSessionById('a')?.provider_session_id, 'provider-a');
  assert.equal((await service.ensure('b', {})).status, 'ready'); assert.equal(creates, 1); assert.equal(layouts, 2);
  const old = db.get('a')!; db.cas('a', old.ownerGeneration, 'ready', 'unknown');
  await service.attach('a'); assert.equal(db.get('a')?.phase, 'ready'); assert.equal(layouts, 2);
  assert.ok(!JSON.stringify(a).includes(String(bootstraps[0]!.attachSecret)));
  service.close();
}));

for (const lost of ['create', 'layout']) test(`lost ${lost} response never replays provisioning`, async () => fixture(async root => {
  let creates = 0; let layouts = 0;
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'),
    enrich: async options => options,
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint, inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => { creates++; if (lost === 'create') throw new Error('response lost'); return { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }; },
      applyLayout: async () => { layouts++; throw new Error('response lost'); },
    }) },
  });
  sessionsDb.createAppSession('a', 'gjc', '/project'); service.registerNewSession('a', '/project');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal(creates, 1); assert.equal(layouts, lost === 'layout' ? 1 : 0);
}));

test('a registered parent workspace that vanished or was relabelled is superseded from a fresh snapshot, never adopted or assumed', async () => fixture(async root => {
  let creates = 0; const layouts: string[] = []; let inspection: 'present' | 'absent' | 'foreign' | 'unreadable' = 'present';
  const inspected: string[] = [];
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'),
    enrich: async options => options,
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint,
      inspectWorkspace: async (workspaceId: string, label: string) => { inspected.push(`${workspaceId}:${label}`); if (inspection === 'unreadable') throw new Error('snapshot unavailable'); return inspection; },
      createWorkspace: async () => ({ workspaceId: `w${++creates}`, tabId: `w${creates}:t1`, paneId: `w${creates}:p1`, terminalId: `term-${creates}` }),
      applyLayout: async (workspaceId: string) => { layouts.push(workspaceId); throw new Error('response lost'); },
    }) },
  });
  const start = async (id: string) => { sessionsDb.createAppSession(id, 'gjc', '/project'); service.registerNewSession(id, '/project'); return service.ensure(id, {}); };
  assert.equal((await start('a')).status, 'unknown');
  assert.deepEqual({ creates, layouts, inspected }, { creates: 1, layouts: ['w1'], inspected: [] }, 'first use creates the parent without inspection');
  const key = getConnection().prepare('SELECT endpoint_key, workspace_id FROM herdr_managed_workspaces').get() as { endpoint_key: string; workspace_id: string };
  assert.equal(key.workspace_id, 'w1');
  inspection = 'unreadable';
  assert.equal((await start('b')).status, 'unknown');
  assert.equal(creates, 1, 'an unreadable snapshot neither reuses nor replaces the parent');
  assert.equal(db.workspace(key.endpoint_key)?.workspace_id, 'w1');
  inspection = 'absent';
  assert.equal((await start('c')).status, 'unknown');
  assert.deepEqual({ creates, last: layouts.at(-1) }, { creates: 2, last: 'w2' }, 'a vanished parent is replaced by a fresh owned workspace');
  assert.equal(db.workspace(key.endpoint_key)?.workspace_id, 'w2');
  inspection = 'foreign';
  assert.equal((await start('d')).status, 'unknown');
  assert.deepEqual({ creates, last: layouts.at(-1) }, { creates: 3, last: 'w3' }, 'a relabelled workspace under the old id is not ours');
  inspection = 'present';
  assert.equal((await start('e')).status, 'unknown');
  assert.deepEqual({ creates, last: layouts.at(-1) }, { creates: 3, last: 'w3' });
  assert.ok(inspected.every(entry => /^w\d:Gajae [0-9a-f-]{36}$/.test(entry)), 'inspection is by exact id and the owned label');
  service.close();
}));

test('a layout Herdr provably never dispatched releases the generation for a fresh reservation', async () => fixture(async root => {
  let layouts = 0;
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'),
    enrich: async options => options,
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint, inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => ({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }),
      applyLayout: async () => { layouts++; if (layouts === 1) throw new HerdrError('HERDR_LAYOUT_NOT_DISPATCHED', 409, 'Herdr rejected the layout; no pane was created.'); throw new Error('response lost'); },
    }) },
  });
  sessionsDb.createAppSession('a', 'gjc', '/project'); service.registerNewSession('a', '/project');
  const first = await service.ensure('a', {});
  assert.equal(first.status, 'unavailable');
  assert.equal(first.ownerGeneration, null);
  assert.equal(db.get('a'), null, 'nothing was launched, so nothing is fenced');
  assert.deepEqual(getConnection().prepare('SELECT owner_generation FROM herdr_managed_bindings WHERE app_session_id = ?').all('a'), [], 'an empty, undispatched generation leaves no history');
  assert.deepEqual(await fs.readdir(path.join(root, 'private')), [], 'the unused private directory is removed');
  const second = await service.ensure('a', {});
  assert.equal(second.status, 'unknown', 'a lost reply on the fresh generation is still unknown');
  assert.ok(second.ownerGeneration);
  assert.equal(layouts, 2);
  assert.equal(db.get('a')?.phase, 'unknown');
  service.close();
}));

test('keeps a dropped create unknown when a foreign same-cwd workspace is concurrently present', async () => fixture(async root => {
  let creates = 0; let layouts = 0;
  let foreignWorkspace: { workspaceId: string; cwd: string } | null = null;
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'),
    enrich: async options => options,
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint, inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => {
        creates++; foreignWorkspace = { workspaceId: 'foreign', cwd: '/project' };
        throw new Error('workspace.create reply lost');
      },
      applyLayout: async () => { layouts++; throw new Error('must not adopt foreign workspace'); },
    }) },
  });
  sessionsDb.createAppSession('a', 'gjc', '/project'); service.registerNewSession('a', '/project');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.deepEqual(foreignWorkspace, { workspaceId: 'foreign', cwd: '/project' });
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal(creates, 1); assert.equal(layouts, 0);
}));

test('keeps a dropped layout unknown despite a live claimed owner and an unlinked pane', async () => fixture(async root => {
  let creates = 0; let layouts = 0;
  let liveClaimedOwner = false; let unlinkedPane: { workspaceId: string; paneId: string; cwd: string } | null = null;
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'),
    enrich: async options => options,
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint, inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => { creates++; return { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }; },
      applyLayout: async (_workspaceId, argv) => {
        layouts++; liveClaimedOwner = true; unlinkedPane = { workspaceId: 'w1', paneId: 'w1:p9', cwd: '/project' };
        const bootstrap = JSON.parse(await fs.readFile(argv[argv.length - 1]!, 'utf8')) as Record<string, unknown>;
        const id = bootstrap.appSessionId as string; const generation = bootstrap.ownerGeneration as string;
        db.claimLaunch(id, generation, bootstrap.claimNonce as string);
        herdrManagedDb.beginClaim(id, generation);
        herdrManagedDb.claim({ protocolVersion: 1, appSessionId: id, ownerGeneration: generation, providerSessionId: 'provider-a' });
        throw new Error('layout.apply reply lost after owner claim');
      },
    }) },
  });
  sessionsDb.createAppSession('a', 'gjc', '/project'); service.registerNewSession('a', '/project');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal(liveClaimedOwner, true);
  assert.deepEqual(unlinkedPane, { workspaceId: 'w1', paneId: 'w1:p9', cwd: '/project' });
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal(creates, 1); assert.equal(layouts, 1);
}));

test('dropped layout reply recovers through the actual host-owned placement and private attach', { timeout: 20_000 }, async () => fixture(async () => {
  const root = await socketRoot();
  const herdrSocket = path.join(root, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  let snapshotRequested = false;
  let resolveSnapshotRequested!: () => void;
  const snapshotObserved = new Promise<void>(resolve => { resolveSnapshotRequested = resolve; });
  let agentState: string | null = null;
  const tokens: Record<string, string> = {};
  const herdr = net.createServer(socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    const respond = (id: string, result: unknown) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ id, result })}\n`);
    };
    const snapshot = () => ({
      type: 'session_snapshot',
      snapshot: {
        version: 'fixture-19',
        protocol: 19,
        layouts: [],
        agents: [],
        workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: agentState ?? 'idle' }],
        tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: 'Owned', focused: false, pane_count: 1, agent_status: agentState ?? 'idle' }],
        panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term-1', focused: false, agent: agentState ? 'gjc' : null, agent_status: agentState ?? 'idle', tokens: { ...tokens } }],
      },
    });
    const handle = async (request: { id: string; method: string; params?: Record<string, unknown> }) => {
      if (request.method === 'session.snapshot') {
        if (!snapshotRequested) {
          snapshotRequested = true;
          resolveSnapshotRequested();
        }
        await snapshotGate;
        respond(request.id, snapshot());
        return;
      }
      if (request.method === 'pane.report_metadata') {
        for (const [key, value] of Object.entries((request.params?.tokens ?? {}) as Record<string, string | null>)) {
          if (value === null) delete tokens[key];
          else tokens[key] = value;
        }
      } else if (request.method === 'pane.report_agent') {
        agentState = String(request.params?.state ?? 'unknown');
      } else if (request.method === 'pane.release_agent') {
        agentState = null;
      } else {
        throw new Error(`Unexpected Herdr RPC ${request.method}`);
      }
      respond(request.id, { type: 'ok' });
    };
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handle(JSON.parse(line) as { id: string; method: string; params?: Record<string, unknown> }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise<void>(resolve => herdr.listen(herdrSocket, resolve));
  let host: HerdrTaskHost | undefined;
  let hostReady: Promise<void> | undefined;
  let sdkStarts = 0;
  let prompts = 0;
  let layouts = 0;
  const socketStat = await fs.lstat(herdrSocket);
  const endpointForTest = { name: 'chosen', canonicalPath: herdrSocket, dev: socketStat.dev, inode: socketStat.ino };
  const service = new HerdrManagedWorkspacesService({
    privateRoot: path.join(root, 'private'),
    readinessTimeoutMs: 5_000,
    enrich: async options => ({ ...options, credential: { kind: 'stored' }, modelId: 'test', toolNames: [], spawns: '*', bashPolicy: { allowedPrefixes: [] } }),
    sessions: {
      provisioningSelection: async selected => selection(['chosen'], selected),
      openProvisioningHandle: async () => ({
        identity: endpointForTest,
        inspectWorkspace: async () => 'present' as const,
        createWorkspace: async () => ({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }),
        applyLayout: async (_workspaceId, argv) => {
          layouts++;
          const bootstrap = JSON.parse(await fs.readFile(argv[argv.length - 1]!, 'utf8')) as HerdrTaskHostBootstrap;
          host = new HerdrTaskHost({
            bootstrap,
            launchEnvironment: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1' },
            createSession: () => {
              sdkStarts++;
              return { providerSessionId: 'actual-provider', async prompt() { prompts++; }, async dispose() {} };
            },
          });
          hostReady = host.initialize().then(async () => { await host!.startPrivateAttachServer(); });
          await snapshotObserved;
          throw new Error('layout reply dropped after host launch');
        },
      }),
    },
  });
  sessionsDb.createAppSession('dropped-layout-host', 'gjc', '/project');
  service.registerNewSession('dropped-layout-host', '/project');
  try {
    const first = await service.ensure('dropped-layout-host', {});
    assert.equal(first.status, 'unknown');
    assert.equal(first.providerSessionId, null);
    assert.equal(snapshotRequested, true);
    const pending = db.get('dropped-layout-host')!;
    assert.equal(pending.phase, 'unknown');
    assert.equal(pending.placement, null);
    assert.equal((getConnection().prepare('SELECT launch_claimed FROM herdr_managed_provisions WHERE app_session_id = ?').get('dropped-layout-host') as { launch_claimed: number }).launch_claimed, 1);
    assert.equal(sdkStarts, 0);
    releaseSnapshot();
    await hostReady;
    const recovered = db.get('dropped-layout-host')!;
    assert.equal(recovered.ownerGeneration, pending.ownerGeneration);
    assert.equal(recovered.providerSessionId, 'actual-provider');
    assert.equal(recovered.phase, 'ready');
    assert.deepEqual(recovered.placement, { sessionName: 'chosen', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' });
    assert.equal(sdkStarts, 1);
    // No App attach or normal layout response has acknowledged readiness.
    // The same host's in-process console can nevertheless admit its own turn.
    const parsed = parseConsoleLine(':followup offline-bootstrap "continue"', {
      appSessionId: recovered.appSessionId, ownerGeneration: recovered.ownerGeneration,
      stateRevision: host!.snapshot().watermark,
    });
    assert.ok(parsed.ok && parsed.type === 'command');
    assert.equal((await host!.dispatch(parsed.command)).state, 'settled');
    assert.equal(prompts, 1);
    const second = await service.ensure('dropped-layout-host', {});
    assert.equal(second.status, 'ready');
    assert.equal(second.ownerGeneration, pending.ownerGeneration);
    assert.equal(second.providerSessionId, 'actual-provider');
    assert.equal(layouts, 1);
    assert.deepEqual(db.recordLayoutReceipt('dropped-layout-host', pending.ownerGeneration, recovered.placement!).placement, recovered.placement);
    assert.equal(sdkStarts, 1);
    await host!.close();
    assert.equal(herdrManagedDb.get(recovered.appSessionId, recovered.ownerGeneration)?.lifecycle, 'closed');
  } finally {
    releaseSnapshot();
    if (hostReady) await hostReady.catch(() => {});
    if (host) await host.close().catch(() => {});
    service.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => herdr.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}));

test('a reopened App recovers an owner fenced unknown read-only, without promotion or replay', { timeout: 20_000 }, async () => fixture(async () => {
  const root = await socketRoot();
  const herdrSocket = path.join(root, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  const herdr = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
        buffer = buffer.slice(newline + 1);
        const result = request.method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: {
          version: 'fixture-19', protocol: 19, layouts: [], agents: [],
          workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
          tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: 'Owned', focused: false, pane_count: 1, agent_status: 'idle' }],
          panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term-1', focused: false, agent: null, agent_status: 'idle', tokens: {} }],
        } } : { type: 'ok' };
        if (!socket.destroyed) socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => herdr.listen(herdrSocket, resolve));
  const socketStat = await fs.lstat(herdrSocket);
  const endpointForTest = { name: 'chosen', canonicalPath: herdrSocket, dev: socketStat.dev, inode: socketStat.ino };
  let host: HerdrTaskHost | undefined;
  let prompts = 0;
  const sessions = {
    provisioningSelection: async (selected: string | null) => selection(['chosen'], selected),
    openProvisioningHandle: async () => ({
      identity: endpointForTest,
      inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => ({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }),
      applyLayout: async (_workspaceId: string, argv: readonly string[]) => {
        const bootstrap = JSON.parse(await fs.readFile(argv[argv.length - 1]!, 'utf8')) as HerdrTaskHostBootstrap;
        host = new HerdrTaskHost({
          bootstrap,
          launchEnvironment: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1' },
          createSession: () => ({ providerSessionId: 'actual-provider', async prompt() { prompts++; throw new Error(`private child failed mid-turn (token ${bootstrap.attachSecret})`); }, async dispose() {} }),
        });
        await host.initialize(); await host.startPrivateAttachServer();
        return { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' };
      },
    }),
  };
  const options = { privateRoot: path.join(root, 'private'), readinessTimeoutMs: 5_000, sessions,
    enrich: async (o: Record<string, unknown>) => ({ ...o, credential: { kind: 'stored' }, modelId: 'test', toolNames: [], spawns: '*', bashPolicy: { allowedPrefixes: [] } }) };
  const first = new HerdrManagedWorkspacesService(options as never);
  const firstChat = new HerdrManagedChatService({ workspaces: first });
  const frames: string[] = [];
  const viewer = { readyState: 1, send: (encoded: string) => { frames.push(encoded); } };
  sessionsDb.createAppSession('unknown-owner', 'gjc', '/project');
  first.registerNewSession('unknown-owner', '/project');
  let second: HerdrManagedWorkspacesService | undefined;
  let secondChat: HerdrManagedChatService | undefined;
  try {
    assert.equal((await first.ensure('unknown-owner', {})).status, 'ready');
    const generation = db.get('unknown-owner')!.ownerGeneration;
    const sent = await firstChat.send({ sessionId: 'unknown-owner', actionId: 'turn-1', content: 'run' }, viewer as never);
    // The owner answers an unconfirmed turn with uncertainty, never a receipt that looks settled.
    assert.equal(sent.ok, false);
    assert.match(sent.error ?? '', /outcome unknown/);
    const acked = await firstChat.status('unknown-owner', 'status-1', 'turn-1');
    assert.equal(acked.receipt?.state, 'settled');
    assert.match(acked.receipt?.message ?? '', /^turn-1 unknown \d+$/);
    assert.equal(prompts, 1);
    assert.equal(herdrManagedDb.get('unknown-owner', generation)?.lifecycle, 'unknown');
    // The App goes away; its authenticated client and chat binding are gone.
    firstChat.close(); first.close();
    second = new HerdrManagedWorkspacesService(options as never);
    secondChat = new HerdrManagedChatService({ workspaces: second });
    const client = await second.attach('unknown-owner');
    assert.equal(client.state?.lifecycle, 'unknown');
    assert.equal(client.state?.commands['turn-1']?.state, 'unknown');
    assert.equal(client.state?.commands['turn-1']?.message, 'Prompt outcome is unknown. private child failed mid-turn (token [redacted])', 'the reason is durable and secret-free');
    assert.equal(client.state?.identity.ownerGeneration, generation);
    assert.equal(client.state?.providerSessionId, 'actual-provider');
    assert.equal(herdrManagedDb.get('unknown-owner', generation)?.lifecycle, 'unknown', 'recovery never promotes the fenced lifecycle');
    assert.equal(db.get('unknown-owner')!.phase, 'ready');
    const reopened = await second.ensure('unknown-owner', {});
    assert.equal(reopened.status, 'ready');
    assert.equal(reopened.ownerGeneration, generation);
    assert.equal((await secondChat.subscribe('unknown-owner', viewer as never)).ok, true);
    assert.ok(frames.some(frame => frame.includes('"lifecycle":"unknown"')), 'the reopened viewer sees the fenced owner');
    // Neither the unknown turn nor a fresh prompt is replayed into the fenced owner.
    const again = await secondChat.send({ sessionId: 'unknown-owner', actionId: 'turn-1', content: 'run' }, viewer as never);
    assert.equal(again.ok, false); assert.equal(again.receipt?.state, 'unknown');
    const fresh = await secondChat.send({ sessionId: 'unknown-owner', actionId: 'turn-2', content: 'again' }, viewer as never);
    assert.equal(fresh.ok, false); assert.equal(fresh.receipt?.state, 'rejected');
    assert.equal(prompts, 1);
  } finally {
    firstChat.close(); first.close(); secondChat?.close(); second?.close();
    if (host) await host.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => herdr.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}));

test('a failed attach fences the generation only on exact confirmed owner death', { timeout: 20_000 }, async () => fixture(async () => {
  const root = await socketRoot();
  const herdrSocket = path.join(root, 'herdr.sock');
  const sockets = new Set<net.Socket>();
  const herdr = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string };
        buffer = buffer.slice(newline + 1);
        const result = request.method === 'session.snapshot' ? { type: 'session_snapshot', snapshot: {
          version: 'fixture-19', protocol: 19, layouts: [], agents: [],
          workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
          tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: 'Owned', focused: false, pane_count: 1, agent_status: 'idle' }],
          panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'term-1', focused: false, agent: null, agent_status: 'idle', tokens: {} }],
        } } : { type: 'ok' };
        if (!socket.destroyed) socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
      }
    });
  });
  await new Promise<void>(resolve => herdr.listen(herdrSocket, resolve));
  const socketStat = await fs.lstat(herdrSocket);
  const endpointForTest = { name: 'chosen', canonicalPath: herdrSocket, dev: socketStat.dev, inode: socketStat.ino };
  let host: HerdrTaskHost | undefined;
  const sessions = {
    provisioningSelection: async (selected: string | null) => selection(['chosen'], selected),
    openProvisioningHandle: async () => ({
      identity: endpointForTest,
      inspectWorkspace: async () => 'present' as const,
      createWorkspace: async () => ({ workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' }),
      applyLayout: async (_workspaceId: string, argv: readonly string[]) => {
        const bootstrap = JSON.parse(await fs.readFile(argv[argv.length - 1]!, 'utf8')) as HerdrTaskHostBootstrap;
        host = new HerdrTaskHost({ bootstrap, launchEnvironment: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1' },
          createSession: () => ({ providerSessionId: 'actual-provider', async prompt() {}, async dispose() {} }) });
        await host.initialize(); await host.startPrivateAttachServer();
        return { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' };
      },
    }),
  };
  const service = new HerdrManagedWorkspacesService({ privateRoot: path.join(root, 'private'), readinessTimeoutMs: 5_000, sessions,
    enrich: async (o: Record<string, unknown>) => ({ ...o, credential: { kind: 'stored' }, modelId: 'test', toolNames: [], spawns: '*', bashPolicy: { allowedPrefixes: [] } }) } as never);
  sessionsDb.createAppSession('dead-owner', 'gjc', '/project');
  service.registerNewSession('dead-owner', '/project');
  const stand = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
  const exited = new Promise<void>(resolve => stand.once('exit', () => resolve()));
  try {
    assert.equal((await service.ensure('dead-owner', {})).status, 'ready');
    const record = db.get('dead-owner')!;
    const ownerFile = path.join(record.privateDirectory, 'owner.json');
    const recorded = JSON.parse(await fs.readFile(ownerFile, 'utf8')) as { ownerGeneration: string; pid: number; startedAt: string };
    assert.equal(recorded.ownerGeneration, record.ownerGeneration);
    assert.equal(recorded.pid, process.pid);
    assert.equal(recorded.startedAt, processStartToken(process.pid));
    assert.equal((await fs.stat(ownerFile)).mode & 0o077, 0);
    // The private socket stops answering while the App is away.
    service.close();
    await fs.rm(path.join(record.privateDirectory, 'attach.sock'), { force: true });
    // A live process with the recorded start time is not death, even unreachable.
    const standToken = processStartToken(stand.pid!);
    assert.ok(standToken);
    await fs.writeFile(ownerFile, JSON.stringify({ ownerGeneration: record.ownerGeneration, pid: stand.pid, startedAt: standToken }), { mode: 0o600 });
    assert.equal((await service.ensure('dead-owner', {})).status, 'unknown');
    assert.equal(herdrManagedDb.get('dead-owner', record.ownerGeneration)?.lifecycle, 'idle');
    // A different generation's record proves nothing about this one.
    await fs.writeFile(ownerFile, JSON.stringify({ ownerGeneration: 'other-generation', pid: stand.pid, startedAt: standToken }), { mode: 0o600 });
    stand.kill('SIGKILL'); await exited;
    assert.equal((await service.ensure('dead-owner', {})).status, 'unknown');
    assert.equal(herdrManagedDb.get('dead-owner', record.ownerGeneration)?.lifecycle, 'idle');
    // The exact recorded process is gone: this generation is fenced, nothing replaced.
    await fs.writeFile(ownerFile, JSON.stringify({ ownerGeneration: record.ownerGeneration, pid: stand.pid, startedAt: standToken }), { mode: 0o600 });
    const fenced = await service.ensure('dead-owner', {});
    assert.equal(fenced.status, 'unknown');
    assert.equal(fenced.ownerGeneration, record.ownerGeneration);
    assert.equal(herdrManagedDb.get('dead-owner', record.ownerGeneration)?.lifecycle, 'interrupted');
    assert.equal(db.get('dead-owner')!.phase, 'ready');
    assert.deepEqual(db.get('dead-owner')!.placement, record.placement);
    assert.equal(db.get('dead-owner')!.ownerGeneration, record.ownerGeneration, 'no replacement owner is provisioned');
    assert.ok(await fs.stat(path.join(record.privateDirectory, 'bootstrap.json')), 'private files are retained');
  } finally {
    if (stand.exitCode === null && stand.signalCode === null) stand.kill('SIGKILL');
    service.close();
    if (host) await host.close().catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => herdr.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}));

test('host placement and the normal layout receipt converge idempotently without snapshot adoption', async () => fixture(async root => {
  sessionsDb.createAppSession('converge', 'gjc', '/project'); db.registerNewSession('converge', '/project');
  const record = db.reserve('converge', endpoint, path.join(root, 'private'));
  assert.equal(db.cas('converge', record.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
  assert.equal(db.cas('converge', record.ownerGeneration, 'workspace_requested', 'workspace_created', 'w1'), true);
  assert.equal(db.cas('converge', record.ownerGeneration, 'workspace_created', 'layout_requested', 'w1'), true);
  db.claimLaunch('converge', record.ownerGeneration, record.claimNonce);
  herdrManagedDb.beginClaim('converge', record.ownerGeneration);
  const placement = { sessionName: endpoint.name, workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1' };
  const hostRecord = db.recordHostPlacement('converge', record.ownerGeneration, placement);
  assert.equal(hostRecord.phase, 'layout_created');
  assert.deepEqual(db.recordLayoutReceipt('converge', record.ownerGeneration, placement).placement, placement);
  assert.throws(() => db.recordLayoutReceipt('converge', record.ownerGeneration, { ...placement, paneId: 'w1:p2' }), /conflict/);
  assert.throws(() => db.recordHostPlacement('converge', record.ownerGeneration, { ...placement, terminalId: 'term-2' }), /conflict/);
}));

test('the original nonce remains claimable after a lost layout reply is fenced unknown', async () => fixture(async root => {
  sessionsDb.createAppSession('late-host', 'gjc', '/project'); db.registerNewSession('late-host', '/project');
  const record = db.reserve('late-host', endpoint, path.join(root, 'private'));
  assert.equal(db.cas('late-host', record.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
  assert.equal(db.cas('late-host', record.ownerGeneration, 'workspace_requested', 'layout_requested', 'w1'), true);
  assert.equal(db.cas('late-host', record.ownerGeneration, 'layout_requested', 'unknown'), true);
  assert.doesNotThrow(() => db.claimLaunch('late-host', record.ownerGeneration, record.claimNonce));
}));

