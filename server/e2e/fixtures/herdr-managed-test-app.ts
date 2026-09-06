import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { WebSocketServer } from 'ws';

import { initializeDatabase } from '../../modules/database/index.js';
import { closeConnection } from '../../modules/database/connection.js';
import { sessionsDb } from '../../modules/database/repositories/sessions.db.js';
import { herdrManagedProvisionDb as db } from '../../modules/database/repositories/herdr-managed-provision.db.js';
import { HerdrManagedAttachClient, HerdrManagedChatService } from '../../modules/herdr/index.js';
import { handleChatConnection } from '../../modules/websocket/services/chat-websocket.service.js';
import type { HerdrTaskHostBootstrap } from '../../gjc-herdr-task-host.js';

const root = process.argv[2]!;
const appSessionId = 'lifetime-session';
process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
await initializeDatabase();
const bootstrapFile = path.join(root, 'bootstrap.json');
if (!db.get(appSessionId)) {
  sessionsDb.createAppSession(appSessionId, 'gjc', root);
  db.registerNewSession(appSessionId, root);
  const record = db.reserve(appSessionId, { name: 'test-owned', canonicalPath: path.join(root, 'unused-herdr.sock'), dev: 1, inode: 1 }, root);
  db.cas(appSessionId, record.ownerGeneration, 'reserved', 'layout_requested');
  const bootstrap: HerdrTaskHostBootstrap = {
    appSessionId, ownerGeneration: record.ownerGeneration, claimNonce: record.claimNonce,
    herdrInstanceId: 'test-owned', projectPath: root, sessionRoot: path.join(root, 'native'), agentDir: path.join(root, 'agent'),
    databasePath: process.env.DATABASE_PATH, attachSocketPath: path.join(root, 'attach.sock'), attachSecret: randomBytes(32).toString('hex'),
    runConfig: { cwd: root, sessionRoot: path.join(root, 'native'), credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'lifetime-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } },
  };
  await mkdir(bootstrap.sessionRoot, { recursive: true });
  await mkdir(bootstrap.agentDir!, { recursive: true });
  await writeFile(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  // Test-owned placement receipt only; no Herdr RPC or fake SDK owner.
  db.cas(appSessionId, record.ownerGeneration, 'layout_requested', 'layout_created', 'workspace', { sessionName: 'test-owned', workspaceId: 'workspace', tabId: 'tab', paneId: 'pane', terminalId: 'terminal' });
}
const bootstrap: HerdrTaskHostBootstrap = JSON.parse(await readFile(bootstrapFile, 'utf8'));
const clients = new Set<HerdrManagedAttachClient>();
async function attach(id: string) {
  if (id !== appSessionId) throw new Error('Unowned session');
  const client = new HerdrManagedAttachClient({ appSessionId, ownerGeneration: bootstrap.ownerGeneration, socketPath: bootstrap.attachSocketPath!, attachSecret: bootstrap.attachSecret! });
  clients.add(client);
  await client.connect();
  const state = await client.recover();
  db.projectReady(id, bootstrap.ownerGeneration, state.providerSessionId!);
  return client;
}
const managedChat = new HerdrManagedChatService({ workspaces: {
  isManaged: id => id === appSessionId,
  attach,
  ensure: async id => {
    const client = await attach(id); client.close(); clients.delete(client);
    return { status: 'ready', ...db.get(id)! } as any;
  },
}, automationTransport: async () => null });
const server = createServer((_request, response) => { response.writeHead(200); response.end('ready'); });
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, request) => handleChatConnection(ws, request as any, {
  managedChat, spawnFns: { gjc: async () => { throw new Error('Local SDK spawn forbidden'); } } as any,
  abortFns: {} as any, resolveToolApproval() { throw new Error('Unmanaged approval forbidden'); }, getPendingApprovalsForSession: () => [],
}));
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
await writeFile(process.argv[3]!, JSON.stringify({ pid: process.pid, port: (server.address() as { port: number }).port }), { mode: 0o600 });
process.once('SIGTERM', () => {
  managedChat.close();
  for (const client of clients) client.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.close(() => { closeConnection(); process.exit(0); });
});
