import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { herdrInputRequestSchema, HERDR_OUTPUT_LINES, type HerdrInputRequest, type HerdrInputResponse, type HerdrOutputResponse, type HerdrPane, type HerdrSessionSummary, type HerdrSnapshotResponse } from '../../../../shared/herdr-protocol.js';
import type { HerdrManagedEndpointIdentity, HerdrManagedPublicSelection } from '../../../../shared/herdr-managed-provision-protocol.js';

import { checkHerdrAbort, HerdrClient, HerdrError, type HerdrConnector, type HerdrOwnedWorkspace, type HerdrProvisionReceipt, type HerdrWirePane } from './herdr-client.js';

const SESSION_NAME = /^[A-Za-z0-9._-]{1,80}$/;
export type HerdrProvisioningHandle = Readonly<{
  identity: HerdrManagedEndpointIdentity;
  createWorkspace(cwd: string, label: string, signal?: AbortSignal): Promise<HerdrProvisionReceipt>;
  inspectWorkspace(workspaceId: string, label: string, signal?: AbortSignal): Promise<'present' | 'absent' | 'foreign'>;
  applyLayout(target: HerdrOwnedWorkspace, argv: readonly string[], cwd: string, signal?: AbortSignal): Promise<HerdrProvisionReceipt>;
}>;
const SEND_KEYS = { text: [], 'text-enter': ['Enter'], enter: ['Enter'], escape: ['Escape'] };
export type HerdrSessionEntry = {
  name: string; label: string; socketPath: string; generation: number;
  device: number | null; inode: number | null;
  status: HerdrSessionSummary['status']; error?: string;
};
export type HerdrSessionsOptions = {
  configHome?: string; envSocketPath?: string; connector?: HerdrConnector;
  bootId?: string; allowNonSocketForTests?: boolean;
};
type Observation = { token: string; terminalId: string; sequence: number };
const stale = () => new HerdrError('HERDR_STALE_OBSERVATION', 409, 'Herdr observation changed or is stale; reselect the target.');

export class HerdrSessionsService {
  readonly #connector?: HerdrConnector;
  readonly #bootId: string;
  readonly #configHome: string;
  readonly #envSocketPath?: string;
  readonly #allowNonSocketForTests: boolean;
  readonly #entries = new Map<string, HerdrSessionEntry>();
  readonly #observations = new Map<string, Observation>();
  readonly #locks = new Set<string>();
  readonly #committedSnapshot = new Map<string, number>();
  readonly #snapshotResults = new Map<string, { wire: string; response: HerdrSnapshotResponse }>();
  #generation = 0;
  #sequence = 0;
  #refresh: Promise<void> = Promise.resolve();

  constructor(options: HerdrSessionsOptions = {}) {
    this.#connector = options.connector;
    this.#bootId = options.bootId ?? randomUUID();
    this.#configHome = options.configHome ?? process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
    this.#envSocketPath = (options.envSocketPath ?? process.env.HERDR_SOCKET_PATH) || undefined;
    this.#allowNonSocketForTests = options.allowNonSocketForTests === true;
  }

  async listSessions(signal?: AbortSignal): Promise<HerdrSessionSummary[]> {
    checkHerdrAbort(signal);
    await this.#refreshSafely();
    checkHerdrAbort(signal);
    return [...this.#entries.values()].sort((a, b) => a.name.localeCompare(b.name))
      .map(({ name, label, status, generation, error }) => ({ name, label, status, generation, ...(error ? { error } : {}) }));
  }

  async snapshot(name: string, signal?: AbortSignal): Promise<HerdrSnapshotResponse> {
    return this.#snapshot(name, signal, true);
  }

  async provisioningSelection(selectedSessionName: string | null, signal?: AbortSignal): Promise<HerdrManagedPublicSelection> {
    if (selectedSessionName !== null && !SESSION_NAME.test(selectedSessionName)) throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr session name.');
    await this.listSessions(signal);
    const admitted: string[] = [];
    const instances = [];
    for (const entry of this.#entries.values()) {
      const identity = await this.#identity(entry.socketPath);
      const available = identity.exists && !identity.changed(entry);
      if (available) admitted.push(entry.name);
      instances.push(Object.freeze({ name: entry.name, label: entry.label, status: available ? 'available' as const : 'unavailable' as const }));
    }
    checkHerdrAbort(signal);
    const selected = selectedSessionName ?? (admitted.length === 1 ? admitted[0]! : null);
    return Object.freeze({
      selectedSessionName: selected,
      instances: Object.freeze(instances.sort((a, b) => a.name.localeCompare(b.name))),
      status: selected === null ? (admitted.length ? 'selection_required' : 'unavailable') : admitted.includes(selected) ? 'unknown' : 'unavailable',
    });
  }

  async openProvisioningHandle(name: string, signal?: AbortSignal): Promise<HerdrProvisioningHandle> {
    checkHerdrAbort(signal);
    const entry = await this.#entry(name);
    const generation = entry.generation;
    const identity = Object.freeze({ name, canonicalPath: entry.socketPath, dev: entry.device!, inode: entry.inode! });
    const check = () => {
      if (this.#entries.get(name) !== entry || entry.generation !== generation || entry.socketPath !== identity.canonicalPath ||
        entry.device !== identity.dev || entry.inode !== identity.inode) throw stale();
    };
    const admit = async () => {
      check();
      const current = await this.#identity(identity.canonicalPath);
      check();
      if (!current.exists || current.device !== identity.dev || current.inode !== identity.inode) throw stale();
    };
    const client = this.#client(entry);
    const guarded = async <T>(operation: () => Promise<T>, operationSignal?: AbortSignal): Promise<T> => {
      checkHerdrAbort(operationSignal);
      await admit();
      const receipt = await operation();
      await admit();
      checkHerdrAbort(operationSignal);
      return receipt;
    };
    return Object.freeze({
      identity,
      createWorkspace: (cwd: string, label: string, operationSignal?: AbortSignal) =>
        guarded(() => client.createWorkspace(cwd, label, operationSignal, { admit, check }), operationSignal),
      inspectWorkspace: (workspaceId: string, label: string, operationSignal?: AbortSignal) =>
        guarded(() => client.inspectWorkspace(workspaceId, label, operationSignal, { admit, check }), operationSignal),
      applyLayout: (target: HerdrOwnedWorkspace, argv: readonly string[], cwd: string, operationSignal?: AbortSignal) =>
        guarded(() => client.applyLayout(target, argv, cwd, operationSignal, { admit, check }), operationSignal),
    });
  }

  async #snapshot(name: string, signal: AbortSignal | undefined, authoritative: boolean): Promise<HerdrSnapshotResponse> {
    checkHerdrAbort(signal);
    const sequence = ++this.#sequence;
    const entry = await this.#entry(name);
    const generation = entry.generation;
    const current = () => this.#entries.get(name) === entry && entry.generation === generation;
    try {
      if (!current()) throw stale();
      const snapshot = await this.#client(entry).snapshot(signal);
      const identity = await this.#identity(entry.socketPath);
      if (!current()) throw stale();
      checkHerdrAbort(signal);
      if (!identity.exists || identity.changed(entry)) throw stale();
      const obsolete = (this.#committedSnapshot.get(name) ?? 0) > sequence;
      const wire = JSON.stringify(snapshot);
      if (obsolete && authoritative) {
        const committed = this.#snapshotResults.get(name);
        if (committed?.wire === wire) return committed.response;
        throw stale();
      }
      if (!obsolete) {
        const keys = new Set(snapshot.panes.map((pane) => this.#key(name, pane.pane_id)));
        for (const key of this.#observations.keys()) {
          if (key.startsWith(`${name}:`) && !keys.has(key)) this.#observations.delete(key);
        }
        this.#committedSnapshot.set(name, sequence);
      }
      const panes = snapshot.panes.map((pane) => this.#pane(entry, pane, sequence, !obsolete));
      entry.status = 'available';
      entry.error = undefined;
      const response: HerdrSnapshotResponse = {
        session: { name, label: entry.label, status: entry.status, generation },
        workspaces: snapshot.workspaces.map((w) => ({ workspaceId: w.workspace_id, number: w.number, label: w.label ?? w.workspace_id, focused: w.focused === true, tabCount: w.tab_count ?? 0, paneCount: w.pane_count ?? 0, activeTabId: w.active_tab_id ?? null, agentStatus: w.agent_status ?? 'unknown' })),
        tabs: snapshot.tabs.map((t) => ({ tabId: t.tab_id, workspaceId: t.workspace_id, number: t.number, label: t.label ?? String(t.number), focused: t.focused === true, paneCount: t.pane_count ?? 0, agentStatus: t.agent_status ?? 'unknown' })),
        panes, observedAt: new Date().toISOString(),
      };
      if (!obsolete) this.#snapshotResults.set(name, { wire, response });
      return response;
    } catch (error) {
      if (current() && (this.#committedSnapshot.get(name) ?? 0) <= sequence) {
        this.#invalidate(entry, 'snapshot unavailable');
        if (error instanceof HerdrError && error.code === 'HERDR_UNSUPPORTED') entry.status = 'unsupported';
      }
      throw error;
    }
  }

  async output(name: string, paneId: string, signal?: AbortSignal): Promise<HerdrOutputResponse> {
    const pendingSnapshot = this.#snapshot(name, signal, false);
    const snap = await pendingSnapshot;
    const pane = snap.panes.find((item) => item.paneId === paneId);
    if (!pane) throw new HerdrError('HERDR_NOT_FOUND', 404, 'Unknown Herdr pane.');
    const readObservationSequence = this.#observations.get(this.#key(name, paneId))?.sequence ?? 0;
    const entry = await this.#entry(name);
    const generation = entry.generation;
    try {
      if (entry.generation !== snap.session.generation) throw stale();
      const read = await this.#client(entry).readPane(paneId, HERDR_OUTPUT_LINES, signal);
      const identity = await this.#identity(entry.socketPath);
      if (entry.generation !== generation) throw stale();
      checkHerdrAbort(signal);
      if (!identity.exists || identity.changed(entry)) throw stale();
      if (read.pane_id !== paneId) throw new HerdrError('HERDR_INVALID_RESPONSE', 502, 'Herdr output pane mismatch.');
      const after = await this.#snapshot(name, signal, false);
      if (!after.panes.some((item) => item.paneId === paneId && item.terminalId === pane.terminalId && item.observationToken === pane.observationToken)) throw stale();
      return { sessionName: name, paneId, terminalId: pane.terminalId, observationToken: pane.observationToken, text: read.text, truncated: read.truncated, observedAt: new Date().toISOString() };
    } catch (error) {
      // An obsolete read must never revoke a newer snapshot's eligibility.
      const current = this.#observations.get(this.#key(name, paneId));
      if (entry.generation === generation && current?.token === pane.observationToken && current.terminalId === pane.terminalId && current.sequence <= readObservationSequence) this.#invalidate(entry, 'output unavailable');
      throw error;
    }
  }

  async input(name: string, paneId: string, request: HerdrInputRequest, signal?: AbortSignal): Promise<HerdrInputResponse> {
    checkHerdrAbort(signal);
    request = herdrInputRequestSchema.parse(request);
    const key = this.#key(name, paneId);
    const entry = await this.#entry(name);
    const lockKey = this.#physicalKey(entry, paneId);
    if (this.#locks.has(lockKey)) throw new HerdrError('HERDR_INPUT_IN_FLIGHT', 409, 'Input already in flight for this pane.');
    this.#locks.add(lockKey);
    try {
      const current = this.#observations.get(key);
      if (!current || current.token !== request.observationToken || current.terminalId !== request.terminalId) throw stale();
      const pendingSnapshot = this.#snapshot(name, signal, false);
      const snap = await pendingSnapshot;
      if (!snap.panes.some((pane) => pane.paneId === paneId && pane.terminalId === request.terminalId && pane.observationToken === request.observationToken)) throw stale();
      const identity = await this.#identity(entry.socketPath);
      if (!identity.exists || identity.changed(entry) || entry.generation !== snap.session.generation || this.#observations.get(key)?.token !== request.observationToken) throw stale();
      // Local preflight only: public Herdr has no atomic compare-and-send.
      checkHerdrAbort(signal);
      await this.#client(entry).sendInput(paneId, request.text, SEND_KEYS[request.action], signal, {
        admit: async () => {
          const finalIdentity = await this.#identity(entry.socketPath);
          if (!finalIdentity.exists || finalIdentity.changed(entry)) throw stale();
        },
        check: () => {
          checkHerdrAbort(signal);
          if (this.#entries.get(name) !== entry || entry.generation !== snap.session.generation || this.#observations.get(key)?.token !== request.observationToken) throw stale();
        },
      });
      return { ok: true, sessionName: name, paneId, outcome: 'accepted_not_delivered', message: 'Accepted by Herdr; delivery is not confirmed.', observedAt: new Date().toISOString() };
    } catch (error) {
      if (this.#observations.get(key)?.token === request.observationToken) {
        this.#observations.delete(key);
        this.#snapshotResults.delete(name);
      }
      throw error;
    } finally {
      this.#locks.delete(lockKey);
    }
  }

  #refreshSafely() {
    const refresh = this.#refresh.then(() => this.#refreshEntries());
    this.#refresh = refresh.catch(() => {});
    return refresh;
  }

  async #refreshEntries() {
    const discovered = new Map<string, string>();
    const root = path.join(this.#configHome, 'herdr');
    discovered.set('default', this.#envSocketPath ?? path.join(root, 'herdr.sock'));
    if (!this.#envSocketPath) {
      try {
        for (const dirent of await fs.readdir(path.join(root, 'sessions'), { withFileTypes: true })) {
          if (dirent.isDirectory() && SESSION_NAME.test(dirent.name) && dirent.name !== 'default') discovered.set(dirent.name, path.join(root, 'sessions', dirent.name, 'herdr.sock'));
        }
      } catch { /* Missing sessions directory is ordinary. */ }
    }
    const endpoints = new Set<string>();
    for (const [name, candidate] of discovered) {
      const socketPath = await this.#canonicalSocket(candidate);
      if (!socketPath) { discovered.delete(name); continue; }
      const identity = await this.#identity(socketPath);
      const endpoint = identity.exists ? `${identity.device}:${identity.inode}` : socketPath;
      if (endpoints.has(endpoint)) { discovered.delete(name); continue; }
      endpoints.add(endpoint);
      const entry = this.#entries.get(name);
      if (!entry) {
        this.#entries.set(name, { name, label: name === 'default' ? 'Default' : name, socketPath, generation: ++this.#generation, device: identity.device, inode: identity.inode, status: identity.exists ? 'unknown' : 'unreachable', ...(!identity.exists ? { error: 'socket unavailable' } : {}) });
      } else if (entry.socketPath !== socketPath || identity.changed(entry)) {
        this.#invalidate(entry, 'socket identity changed');
        entry.socketPath = socketPath;
        entry.device = identity.device;
        entry.inode = identity.inode;
        entry.status = identity.exists ? 'unknown' : 'unreachable';
      }
    }
    for (const [name, entry] of this.#entries) {
      if (!discovered.has(name)) { this.#invalidate(entry, 'endpoint removed'); this.#entries.delete(name); }
    }
  }

  async #entry(name: string) {
    if (!SESSION_NAME.test(name)) throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr session name.');
    await this.#refreshSafely();
    const entry = this.#entries.get(name);
    if (!entry) throw new HerdrError('HERDR_NOT_FOUND', 404, 'Unknown Herdr session.');
    const generation = entry.generation;
    const identity = await this.#identity(entry.socketPath);
    if (this.#entries.get(name) !== entry || entry.generation !== generation) throw stale();
    if (!identity.exists || identity.changed(entry)) {
      this.#invalidate(entry, 'socket unavailable');
      throw new HerdrError('HERDR_UNAVAILABLE', 502, 'Herdr session unavailable.');
    }
    return entry;
  }

  #client(entry: HerdrSessionEntry) { return new HerdrClient(entry.socketPath, this.#connector); }

  #pane(entry: HerdrSessionEntry, pane: HerdrWirePane, sequence: number, commit: boolean): HerdrPane {
    const key = this.#key(entry.name, pane.pane_id);
    const previous = this.#observations.get(key);
    const terminalId = pane.terminal_id;
    const token = previous?.terminalId === terminalId ? previous.token : `${this.#bootId}:${randomUUID()}`;
    if (commit) this.#observations.set(key, { token, terminalId, sequence });
    return { paneId: pane.pane_id, terminalId, workspaceId: pane.workspace_id, tabId: pane.tab_id, focused: pane.focused === true, cwd: pane.cwd ?? '', ...(pane.foreground_cwd ? { foregroundCwd: pane.foreground_cwd } : {}), ...(pane.agent ? { agent: pane.agent } : {}), agentStatus: pane.agent_status ?? 'unknown', ...(pane.label ? { label: pane.label } : {}), observationToken: token };
  }

  #invalidate(entry: HerdrSessionEntry, error: string) {
    this.#snapshotResults.delete(entry.name);
    entry.generation = ++this.#generation;
    entry.status = 'unreachable';
    entry.error = error;
    for (const key of this.#observations.keys()) if (key.startsWith(`${entry.name}:`)) this.#observations.delete(key);
  }

  async #canonicalSocket(socketPath: string): Promise<string | null> {
    try {
      const parent = await fs.realpath(path.dirname(socketPath));
      if (!this.#envSocketPath) {
        const config = await fs.realpath(this.#configHome);
        const root = await fs.realpath(path.join(this.#configHome, 'herdr'));
        if (root !== path.join(config, 'herdr')) return null;
        const relative = path.relative(root, parent);
        if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
        if (relative) {
          const sessions = await fs.realpath(path.join(root, 'sessions'));
          if (sessions !== path.join(root, 'sessions') || path.dirname(parent) !== sessions) return null;
        }
      }
      return path.join(parent, path.basename(socketPath));
    } catch { return null; }
  }

  async #identity(socketPath: string) {
    try {
      if (await this.#canonicalSocket(socketPath) !== socketPath) throw new Error('Socket ancestors changed.');
      const stat = await fs.lstat(socketPath);
      if (stat.isSymbolicLink() || (!stat.isSocket() && !this.#allowNonSocketForTests) || typeof process.getuid !== 'function' || stat.uid !== process.getuid()) throw new Error('Socket not owned by current user.');
      return { exists: true, device: stat.dev, inode: stat.ino, changed: (entry: HerdrSessionEntry) => entry.device !== stat.dev || entry.inode !== stat.ino };
    } catch {
      return { exists: false, device: null, inode: null, changed: (entry: HerdrSessionEntry) => entry.device !== null || entry.inode !== null };
    }
  }

  #key(name: string, paneId: string) { return `${name}:${paneId}`; }

  #physicalKey(entry: HerdrSessionEntry, paneId: string) {
    return `${entry.device ?? entry.socketPath}:${entry.inode ?? entry.socketPath}:${paneId}`;
  }
}

let productionService: HerdrSessionsService | null = null;
export function getProductionHerdrSessionsService() {
  productionService ??= new HerdrSessionsService();
  return productionService;
}
