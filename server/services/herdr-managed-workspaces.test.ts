import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parseGjcRunPermissions } from '../gjc-engine.js';
import { closeConnection, getConnection } from '../modules/database/connection.js';
import { INIT_SCHEMA_SQL } from '../modules/database/schema.js';
import { sessionsDb } from '../modules/database/repositories/sessions.db.js';
import { herdrManagedDb } from '../modules/database/repositories/herdr-managed.db.js';
import { herdrManagedProvisionDb as db } from '../modules/database/repositories/herdr-managed-provision.db.js';
import type { HerdrManagedPublicSelection } from '../../shared/herdr-managed-provision-protocol.js';
import { HerdrManagedWorkspacesService, HerdrManagedAttachClient } from '../modules/herdr/index.js';

async function fixture(run: (root: string) => Promise<void>) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'managed-provision-')));
  const previous = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
  try { getConnection().exec(INIT_SCHEMA_SQL); await run(root); }
  finally { closeConnection(); if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous; await fs.rm(root, { recursive: true, force: true }); }
}
const endpoint = { name: 'chosen', canonicalPath: '/owned/herdr.sock', dev: 1, inode: 2 };
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
      openProvisioningHandle: async () => ({ identity: endpoint,
        createWorkspace: async () => { creates++; return { workspaceId: 'workspace', tabId: 'initial', paneId: 'initial', terminalId: 'initial' }; },
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
          return { workspaceId, tabId: `tab-${layout}`, paneId: `pane-${layout}`, terminalId: `terminal-${layout}` };
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
    sessions: { provisioningSelection: async selected => selection(['chosen'], selected), openProvisioningHandle: async () => ({ identity: endpoint,
      createWorkspace: async () => { creates++; if (lost === 'create') throw new Error('response lost'); return { workspaceId: 'w', tabId: 't', paneId: 'p', terminalId: 'term' }; },
      applyLayout: async () => { layouts++; throw new Error('response lost'); },
    }) },
  });
  sessionsDb.createAppSession('a', 'gjc', '/project'); service.registerNewSession('a', '/project');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal((await service.ensure('a', {})).status, 'unknown');
  assert.equal(creates, 1); assert.equal(layouts, lost === 'layout' ? 1 : 0);
}));
