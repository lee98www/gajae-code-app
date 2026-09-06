import { randomBytes, randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { herdrManagedSelectionSchema, type HerdrManagedPublicSelection, type EnsureManagedConversationResult } from '../../../../shared/herdr-managed-provision-protocol.js';
import { herdrManagedProvisionDb, getConnection, herdrManagedDb, type ProvisionRecord } from '../../database/index.js';
import { enrichGjcSdkRunOptions } from '../../../gjc-worker-client.js';

import { HerdrError } from './herdr-client.js';
import { HerdrManagedAttachClient } from './herdr-managed-client.js';
import { confirmOwnerDeath, type OwnerLiveness } from './herdr-owner-liveness.js';
import { getProductionHerdrSessionsService, type HerdrSessionsService, type HerdrProvisioningHandle } from './herdr-sessions.js';

export type HerdrManagedTrustedOptions = { modelId?: string; model?: string; modelProfile?: string; effort?: string };
export type HerdrManagedWorkspacesOptions = {
  sessions?: Pick<HerdrSessionsService, 'provisioningSelection' | 'openProvisioningHandle'>;
  db?: typeof herdrManagedProvisionDb;
  privateRoot?: string;
  enrich?: typeof enrichGjcSdkRunOptions;
  createClient?: (options: ConstructorParameters<typeof HerdrManagedAttachClient>[0]) => HerdrManagedAttachClient;
  readinessTimeoutMs?: number;
};

async function privateDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const parent = path.dirname(resolved);
  if (parent !== resolved) {
    try { await fs.lstat(parent); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await privateDirectory(parent);
    }
  }
  if (await fs.realpath(parent) !== parent) throw new Error('Managed private path contains a symlink.');
  await fs.mkdir(resolved, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const stat = await fs.lstat(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw new Error('Unsafe managed private directory.');
}
async function privateJson(file: string): Promise<Record<string, unknown>> {
  await privateDirectory(path.dirname(file));
  if (await fs.realpath(path.dirname(file)) !== path.dirname(file)) throw new Error('Unsafe managed bootstrap parent.');
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error('Unsafe managed bootstrap.');
    return JSON.parse(await handle.readFile('utf8')) as Record<string, unknown>;
  } finally { await handle.close(); }
}
function hostArgv(bootstrap: string): string[] {
  const source = import.meta.url.endsWith('.ts');
  const host = fileURLToPath(new URL(source ? '../../../gjc-herdr-task-host.ts' : '../../../gjc-herdr-task-host.js', import.meta.url));
  return source
    ? [process.execPath, fileURLToPath(import.meta.resolve('tsx/cli')), '--tsconfig', fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)), '--', host, bootstrap]
    : [process.execPath, '--', host, bootstrap];
}

export class HerdrManagedWorkspacesService {
  readonly #db;
  readonly #sessions;
  readonly #root;
  readonly #enrich;
  readonly #createClient;
  readonly #timeout;
  readonly #pending = new Map<string, Promise<EnsureManagedConversationResult>>();
  readonly #workspacePending = new Map<string, Promise<string>>();
  readonly #clients = new Map<string, HerdrManagedAttachClient>();
  constructor(options: HerdrManagedWorkspacesOptions = {}) {
    this.#db = options.db ?? herdrManagedProvisionDb;
    this.#sessions = options.sessions ?? getProductionHerdrSessionsService();
    this.#root = path.resolve(options.privateRoot ?? path.join(os.homedir(), '.gajae-app', 'managed'));
    this.#enrich = options.enrich ?? enrichGjcSdkRunOptions;
    this.#createClient = options.createClient ?? (value => new HerdrManagedAttachClient(value));
    this.#timeout = options.readinessTimeoutMs ?? 60_000;
  }
  registerNewSession(appSessionId: string, projectPath: string): void { this.#db.registerNewSession(appSessionId, projectPath); }
  isManaged(appSessionId: string): boolean { return this.#db.projectPath(appSessionId) !== null; }
  async selection(): Promise<HerdrManagedPublicSelection> {
    const selection = await this.#sessions.provisioningSelection(this.#db.selected());
    if (selection.selectedSessionName && selection.status !== 'unavailable' && !this.#db.selected()) this.#db.select(selection.selectedSessionName);
    return this.#selectionReady(selection);
  }
  async select(name: string): Promise<HerdrManagedPublicSelection> {
    herdrManagedSelectionSchema.parse({ selectedSessionName: name });
    const selection = await this.#sessions.provisioningSelection(name);
    this.#db.select(name);
    return this.#selectionReady(selection);
  }
  #selectionReady(selection: HerdrManagedPublicSelection): HerdrManagedPublicSelection {
    // This is readiness to provision in the selected admitted instance, not a
    // claim that any task host has initialized.
    return selection.selectedSessionName && selection.instances.some(instance => instance.name === selection.selectedSessionName && instance.status === 'available')
      ? { ...selection, status: 'ready' } : selection;
  }
  ensure(appSessionId: string, trustedOptions: HerdrManagedTrustedOptions): Promise<EnsureManagedConversationResult> {
    const pending = this.#pending.get(appSessionId); if (pending) return pending;
    const promise = this.#ensure(appSessionId, trustedOptions).finally(() => { this.#pending.delete(appSessionId); });
    this.#pending.set(appSessionId, promise); return promise;
  }
  #result(record: ProvisionRecord): EnsureManagedConversationResult {
    if (record.phase === 'ready' && record.providerSessionId && record.placement) return { status: 'ready', appSessionId: record.appSessionId, providerSessionId: record.providerSessionId, ownerGeneration: record.ownerGeneration, placement: record.placement };
    return { status: record.phase === 'unknown' ? 'unknown' : 'provisioning', appSessionId: record.appSessionId, providerSessionId: record.providerSessionId, ownerGeneration: record.ownerGeneration, selectedSessionName: record.selectedSessionName };
  }
  #uncertain(record: ProvisionRecord): EnsureManagedConversationResult {
    return { status: 'unknown', appSessionId: record.appSessionId, providerSessionId: record.providerSessionId, ownerGeneration: record.ownerGeneration, selectedSessionName: record.selectedSessionName };
  }
  /**
   * A failed private attach is reconciled only against exact evidence. When the
   * recorded owner process is confirmed gone, its generation is fenced as
   * interrupted so nothing waits on it; the claimed target, journal and private
   * files are retained and no replacement owner is started here.
   */
  async #reconcileOwner(record: ProvisionRecord): Promise<OwnerLiveness> {
    const liveness = await confirmOwnerDeath(record.privateDirectory, record.ownerGeneration);
    if (liveness === 'confirmed_dead') {
      const binding = herdrManagedDb.get(record.appSessionId, record.ownerGeneration);
      if (binding && !['interrupted', 'closed'].includes(binding.lifecycle)) {
        try { herdrManagedDb.setLifecycle(record.appSessionId, record.ownerGeneration, 'interrupted'); } catch { /* concurrent terminal write wins */ }
      }
    }
    return liveness;
  }
  async #ensure(id: string, options: HerdrManagedTrustedOptions): Promise<EnsureManagedConversationResult> {
    const projectPath = this.#db.projectPath(id);
    if (!projectPath) throw new Error('Session is not registered as managed.');
    if (Object.keys(options).some(key => !['modelId', 'model', 'modelProfile', 'effort'].includes(key)) || Object.values(options).some(value => value !== undefined && typeof value !== 'string')) throw new Error('Untrusted managed configuration override.');
    const old = this.#db.get(id);
    if (old) {
      if (old.placement) {
        try {
          await this.attach(id);
          return this.#result(this.#db.get(id)!);
        } catch {
          // A private attach failure alone does not prove owner death. Preserve
          // the claimed target so the reporter can still clean it up and a later
          // attach can recover the same owner; only exact process evidence fences it.
          const current = this.#db.get(id)!;
          await this.#reconcileOwner(current);
          return this.#uncertain(current);
        }
      }
      // Another process may still be executing the recorded intent, or its
      // reply may have been lost. Neither case permits replaying create/layout.
      // A host that claimed this generation before its placement was captured
      // recorded its exact process identity; when that process is confirmed
      // gone the generation is fenced like a placed owner, nothing replaced.
      await this.#reconcileOwner(old);
      return this.#uncertain(old);
    }
    const selection = await this.selection();
    if (!selection.selectedSessionName || selection.status === 'unavailable') return { status: selection.status === 'selection_required' ? 'selection_required' : 'unavailable', appSessionId: id, providerSessionId: null, ownerGeneration: null, selectedSessionName: selection.selectedSessionName };
    const handle = await this.#sessions.openProvisioningHandle(selection.selectedSessionName);
    const directory = path.join(this.#root, randomUUID());
    const record = this.#db.reserve(id, handle.identity, directory);
    if (record.privateDirectory !== directory) return this.#result(record);
    const generation = record.ownerGeneration;
    try {
      const relative = path.relative(path.resolve(projectPath), directory);
      if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('Managed private files cannot be inside project.');
      await privateDirectory(directory);
      const sessionRoot = path.join(directory, 'sessions'); await privateDirectory(sessionRoot);
      const policy = herdrManagedDb.currentPolicy(id, generation).permissions;
      const config = await this.#enrich({ ...options, cwd: projectPath, sessionRoot, credential: { kind: 'stored' }, appSessionId: id, permissions: { mode: policy.mode, allowAlways: policy.allowAlways } });
      if ((config.credential as { kind?: string })?.kind !== 'stored') throw new Error('Managed credentials require persistent storage.');
      const bootstrapPath = path.join(directory, 'bootstrap.json');
      const bootstrap = { appSessionId: id, ownerGeneration: generation, herdrInstanceId: record.selectedSessionName, claimNonce: record.claimNonce, databasePath: path.resolve(getConnection().name), projectPath, sessionRoot, agentDir: process.env.GJC_WORKER_AGENT_DIR ?? path.join(os.homedir(), '.gjc', 'agent'), runConfig: config, attachSocketPath: path.join(directory, 'attach.sock'), attachSecret: randomBytes(32).toString('hex') };
      await fs.writeFile(bootstrapPath, JSON.stringify(bootstrap), { flag: 'wx', mode: 0o600 });
      const key = createHash('sha256').update(JSON.stringify([this.#db.installId(), handle.identity])).digest('hex');
      if (!this.#db.cas(id, generation, 'reserved', 'workspace_requested')) throw new Error('Provision ownership conflict.');
      const workspaceId = await this.#ownedWorkspace(key, handle, projectPath);
      if (!this.#db.cas(id, generation, 'workspace_requested', 'workspace_created', workspaceId) || !this.#db.cas(id, generation, 'workspace_created', 'layout_requested', workspaceId)) throw new Error('Provision phase conflict.');
      let receipt: Awaited<ReturnType<HerdrProvisioningHandle['applyLayout']>>;
      try {
        receipt = await handle.applyLayout({ workspaceId, label: this.#ownedLabel() }, hostArgv(bootstrapPath), projectPath);
      } catch (error) {
        // A proven non-dispatch is a known outcome: nothing was launched for
        // this generation, so it is released for a fresh reservation rather
        // than fenced as unknown. Its private files carry nothing yet.
        if (error instanceof HerdrError && error.code === 'HERDR_LAYOUT_NOT_DISPATCHED' && this.#db.release(id, generation, 'layout_requested')) {
          await fs.rm(directory, { recursive: true, force: true });
          return { status: 'unavailable', appSessionId: id, providerSessionId: null, ownerGeneration: null, selectedSessionName: record.selectedSessionName };
        }
        throw error;
      }
      if (receipt.workspaceId !== workspaceId || !receipt.tabId || !receipt.paneId || !receipt.terminalId) throw new Error('Managed layout receipt mismatch.');
      this.#db.recordLayoutReceipt(id, generation, { sessionName: record.selectedSessionName, ...receipt });
      const deadline = Date.now() + this.#timeout;
      for (;;) {
        try { await this.attach(id); break; } catch { if (Date.now() >= deadline) throw new Error('Managed readiness unknown.'); await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now())))); }
      }
    } catch {
      const current = this.#db.get(id);
      if (current && !current.placement && current.phase !== 'ready') this.#db.cas(id, generation, current.phase, 'unknown');
    }
    const final = this.#db.get(id)!;
    return this.#result(final);
  }
  #ownedLabel(): string { return `Gajae ${this.#db.installId()}`; }
  #ownedWorkspace(key: string, handle: HerdrProvisioningHandle, projectPath: string): Promise<string> {
    const pending = this.#workspacePending.get(key);
    if (pending) return pending;
    const task = (async () => {
      const label = this.#ownedLabel();
      let existing = this.#db.workspace(key);
      if (existing?.phase === 'ready' && existing.workspace_id) {
        // The registered parent may have been closed in Herdr since. Only a
        // fresh snapshot decides: present under the owned label is reused,
        // definitively absent or relabelled by someone else is superseded
        // (never adopted), and an unreadable snapshot stays unknown.
        const status = await handle.inspectWorkspace(existing.workspace_id, label);
        if (status === 'present') return existing.workspace_id;
        if (!this.#db.supersedeWorkspace(key, existing.workspace_id)) throw new Error('Workspace outcome is unknown.');
        existing = null;
      }
      if (existing || !this.#db.requestWorkspace(key)) throw new Error('Workspace outcome is unknown.');
      const receipt = await handle.createWorkspace(projectPath, label);
      this.#db.finishWorkspace(key, receipt.workspaceId);
      return receipt.workspaceId;
    })().finally(() => { this.#workspacePending.delete(key); });
    this.#workspacePending.set(key, task);
    return task;
  }
  async attach(id: string): Promise<HerdrManagedAttachClient> {
    const record = this.#db.get(id);
    if (!record?.placement) throw new Error('Managed placement is unavailable.');
    const handle = await this.#sessions.openProvisioningHandle(record.selectedSessionName);
    if (JSON.stringify(handle.identity) !== JSON.stringify(record.endpoint)) throw new Error('Managed endpoint identity changed.');
    let client = this.#clients.get(id);
    if (client && !client.connected) {
      client.close();
      this.#clients.delete(id);
      client = undefined;
    }
    const fresh = !client;
    if (!client) {
      const bootstrap = await privateJson(path.join(record.privateDirectory, 'bootstrap.json'));
      if (bootstrap.appSessionId !== id || bootstrap.ownerGeneration !== record.ownerGeneration || typeof bootstrap.attachSecret !== 'string' || bootstrap.attachSocketPath !== path.join(record.privateDirectory, 'attach.sock')) throw new Error('Managed bootstrap identity mismatch.');
      client = this.#createClient({ socketPath: bootstrap.attachSocketPath as string, attachSecret: bootstrap.attachSecret, appSessionId: id, ownerGeneration: record.ownerGeneration });
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const state = await Promise.race([(async () => { if (fresh) await client.connect(); return client.recover(); })(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Managed attach timed out.')), this.#timeout); })]);
      if (state.identity.appSessionId !== id || state.identity.ownerGeneration !== record.ownerGeneration || !state.providerSessionId) throw new Error('Managed host identity mismatch.');
      const current = this.#db.get(id);
      if (!current?.placement || (current.providerSessionId !== null && current.providerSessionId !== state.providerSessionId)) throw new Error('Managed host placement is not published.');
      // An owner that already published readiness is recovered exactly as it
      // is: an unknown or interrupted lifecycle is inspected read-only through
      // the same authenticated client, never re-promoted or replayed.
      const published = current.phase === 'ready' && current.providerSessionId === state.providerSessionId;
      if (!published) this.#db.projectReady(id, record.ownerGeneration, state.providerSessionId);
      this.#clients.set(id, client); return client;
    } catch (error) { client.close(); this.#clients.delete(id); throw error; }
    finally { if (timer) clearTimeout(timer); }
  }
  close(): void { for (const client of this.#clients.values()) client.close(); this.#clients.clear(); }
}
let productionService: HerdrManagedWorkspacesService | null = null;
export function getProductionHerdrManagedWorkspacesService(): HerdrManagedWorkspacesService { return productionService ??= new HerdrManagedWorkspacesService(); }
