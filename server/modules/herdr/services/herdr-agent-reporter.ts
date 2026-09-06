import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { getConnection, herdrManagedDb, herdrManagedProvisionDb, type ProvisionRecord } from '../../database/index.js';
import type { HerdrManagedBinding } from '../../../../shared/herdr-managed-protocol.js';
import type { HerdrManagedState } from '../../../../shared/herdr-managed-state.js';

import {
  HerdrClient,
  HerdrError,
  type HerdrDispatchGuard,
  type HerdrReportAgentInput,
  type HerdrWirePane,
  type HerdrWireSnapshot,
} from './herdr-client.js';

type DisplayState = HerdrReportAgentInput['state'];
export type HerdrAgentReporterStatus = Readonly<{
  status: 'pending' | 'published' | 'unavailable' | 'stale' | 'quiesced' | 'released' | 'not_present' | 'not_closed';
  source: string;
  seq: number;
}>;
export type HerdrAgentReporterTarget = { record: ProvisionRecord | null; binding: HerdrManagedBinding | null };
/** Exact owner proof used to release native metadata before the DB lifecycle closes. */
export type HerdrAgentReporterClosureProof = Readonly<{
  appSessionId: string;
  ownerGeneration: string;
  providerSessionId: string;
  childClosed: true;
}>;
export type HerdrAgentReporterOptions = {
  appSessionId: string;
  ownerGeneration: string;
  providerSessionId: string;
  onStatus?: (status: HerdrAgentReporterStatus) => void;
  readTarget?: () => HerdrAgentReporterTarget;
  readState?: () => HerdrManagedState;
  createClient?: (path: string) => HerdrClient;
};

const OWNED_TOKEN_NAMES = [
  'gajae_native_session_id',
  'gajae_owner_generation',
  'gajae_app_session_id',
] as const;

type OwnedTokenName = typeof OWNED_TOKEN_NAMES[number];
type NamespaceKind = 'empty' | 'ours' | 'foreign';
type TokenNamespace = Readonly<{
  kind: NamespaceKind;
  foreign: Readonly<Record<string, string>>;
}>;

export function herdrAgentDisplayState(state: HerdrManagedState): DisplayState {
  if (['unknown', 'interrupted', 'closed', 'reserved', 'claiming'].includes(state.lifecycle)) return 'unknown';
  const pending = Object.values(state.requests).some(request =>
    request.appSessionId === state.identity.appSessionId && request.generation === state.identity.ownerGeneration && request.providerSessionId === state.providerSessionId &&
    (request.scope.status === undefined || request.scope.status === 'pending'));
  if (pending || Object.values(state.automation).some(operation =>
    operation.identity.generation === state.identity.ownerGeneration && operation.identity.provider === state.providerSessionId &&
    ['waiting_attachment', 'awaiting_reattach_approval'].includes(operation.phase)) ||
    (state.queue.paused && state.queue.entries.length > 0) ||
    ['awaiting_input', 'waiting_attachment', 'awaiting_reattach_approval'].includes(state.lifecycle)) return 'blocked';
  if (Object.values(state.requests).some(request => request.scope.status === 'unknown') ||
    Object.values(state.automation).some(operation => operation.phase === 'outcome_unknown')) return 'unknown';
  if (state.activeTurnId) return 'working';
  return ['idle', 'ready'].includes(state.lifecycle) ? 'idle' : 'unknown';
}

function sameTokens(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): boolean {
  return Object.keys(left).length === Object.keys(right).length
    && Object.entries(left).every(([key, value]) => Object.prototype.hasOwnProperty.call(right, key) && right[key] === value);
}

/** Owner-local metadata only: never changes execution state or uses an App connection. */
export class HerdrAgentReporter {
  private readonly source: string;
  private receipt: HerdrAgentReporterStatus;
  private desired: DisplayState = 'unknown';
  private attempted: DisplayState | undefined;
  private pinned: ProvisionRecord | undefined;
  private endpointIdentity: string | undefined;
  private endpointMode: number | undefined;
  private client: HerdrClient | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | undefined;
  private stopped = false;
  private stale = false;
  private released = false;
  private seq = 0;
  private metadataAttempted = false;
  private metadataEstablished = false;
  private agentAttempted = false;
  private cleanupAttempted = false;

  constructor(private readonly options: HerdrAgentReporterOptions) {
    this.source = `gajae-owner:${createHash('sha256').update(options.ownerGeneration).digest('hex')}`;
    this.receipt = Object.freeze({ status: 'pending', source: this.source, seq: 0 });
  }

  status(): HerdrAgentReporterStatus { return this.receipt; }

  private publish(status: HerdrAgentReporterStatus['status']): void {
    if (this.receipt.status === status && this.receipt.seq === this.seq) return;
    this.receipt = Object.freeze({ status, source: this.source, seq: this.seq });
    try { this.options.onStatus?.(this.receipt); } catch { /* Publication cannot affect execution. */ }
  }

  private refuse(): never {
    this.stale = true;
    this.stopped = true;
    clearInterval(this.timer);
    this.publish('stale');
    throw new HerdrError('HERDR_STALE_TARGET', 409, 'Herdr agent target changed.');
  }

  private readTarget(): HerdrAgentReporterTarget {
    if (this.options.readTarget) return this.options.readTarget();
    return getConnection().transaction(() => ({
      record: herdrManagedProvisionDb.get(this.options.appSessionId),
      binding: herdrManagedDb.get(this.options.appSessionId, this.options.ownerGeneration),
    }))();
  }

  private target(): HerdrAgentReporterTarget | null {
    const target = this.readTarget();
    const { record, binding } = target;
    if (!record) { if (this.pinned) this.refuse(); return null; }
    if (record.appSessionId !== this.options.appSessionId || record.ownerGeneration !== this.options.ownerGeneration ||
      this.options.providerSessionId === this.options.appSessionId) this.refuse();
    const endpointIdentity = JSON.stringify(record.endpoint);
    if (this.endpointIdentity !== undefined && this.endpointIdentity !== endpointIdentity) this.refuse();
    this.endpointIdentity = endpointIdentity;
    if (this.pinned && JSON.stringify(record.endpoint) !== JSON.stringify(this.pinned.endpoint)) this.refuse();
    if (record.phase !== 'ready' || !record.placement || !record.providerSessionId || !binding?.paneId) {
      if (this.pinned) this.refuse();
      return null;
    }
    const p = record.placement;
    if (!binding || binding.appSessionId !== record.appSessionId || binding.ownerGeneration !== record.ownerGeneration ||
      record.providerSessionId !== this.options.providerSessionId || binding.providerSessionId !== this.options.providerSessionId ||
      record.endpoint.name !== record.selectedSessionName || p.sessionName !== record.selectedSessionName ||
      binding.herdrInstanceId !== record.selectedSessionName || record.workspaceId !== p.workspaceId ||
      binding.workspaceId !== p.workspaceId || binding.tabId !== p.tabId || binding.paneId !== p.paneId || binding.terminalId !== p.terminalId ||
      (this.pinned && JSON.stringify(p) !== JSON.stringify(this.pinned.placement))) this.refuse();
    if (!this.pinned) {
      this.pinned = structuredClone(record);
      this.checkEndpoint();
      this.client = this.options.createClient?.(record.endpoint.canonicalPath) ?? new HerdrClient(record.endpoint.canonicalPath);
    }
    return target;
  }

  private checkEndpoint(): void {
    const endpoint = this.pinned!.endpoint;
    try {
      const stat = lstatSync(endpoint.canonicalPath);
      const mode = stat.mode & 0o777;
      if (!isAbsolute(endpoint.canonicalPath) || realpathSync(endpoint.canonicalPath) !== endpoint.canonicalPath ||
        !stat.isSocket() || stat.uid !== process.getuid?.() ||
        (this.endpointMode !== undefined && mode !== this.endpointMode) ||
        stat.dev !== endpoint.dev || stat.ino !== endpoint.inode) this.refuse();
      // Match the established current-user endpoint admission, rather than
      // requiring a new socket mode from an already admitted Herdr instance.
      this.endpointMode ??= mode;
    } catch { this.refuse(); }
  }

  private nextSeq(): number {
    if (this.seq >= Number.MAX_SAFE_INTEGER) this.refuse();
    this.seq += 1;
    return this.seq;
  }

  private classifyNamespace(pane: HerdrWirePane): TokenNamespace {
    const tokens = pane.tokens ?? {};
    const owned = OWNED_TOKEN_NAMES.filter(name => Object.prototype.hasOwnProperty.call(tokens, name));
    const foreign = Object.fromEntries(Object.entries(tokens).filter(([name]) => !OWNED_TOKEN_NAMES.includes(name as OwnedTokenName)));
    if (owned.length === 0) return { kind: 'empty', foreign };
    if (owned.length === OWNED_TOKEN_NAMES.length &&
      tokens.gajae_native_session_id === this.options.providerSessionId &&
      tokens.gajae_owner_generation === this.options.ownerGeneration &&
      tokens.gajae_app_session_id === this.options.appSessionId) {
      return { kind: 'ours', foreign };
    }
    return { kind: 'foreign', foreign };
  }

  private endpointGuard(): HerdrDispatchGuard {
    return { admit: async () => { this.checkEndpoint(); }, check: () => { this.checkEndpoint(); } };
  }

  private async snapshot(releasing = false): Promise<HerdrWireSnapshot | null> {
    const snapshot = await this.client!.snapshot(undefined, this.endpointGuard());
    this.checkEndpoint();
    this.target();
    const p = this.pinned!.placement!;
    const panes = snapshot.panes.filter(pane => pane.pane_id === p.paneId);
    if (releasing && panes.length === 0) return null;
    if (panes.length !== 1 || panes[0]!.terminal_id !== p.terminalId || panes[0]!.workspace_id !== p.workspaceId || panes[0]!.tab_id !== p.tabId ||
      snapshot.workspaces.filter(w => w.workspace_id === p.workspaceId).length !== 1 ||
      snapshot.tabs.filter(t => t.tab_id === p.tabId && t.workspace_id === p.workspaceId).length !== 1) this.refuse();
    return snapshot;
  }

  private async inspect(releasing = false): Promise<{ snapshot: HerdrWireSnapshot; pane: HerdrWirePane; namespace: TokenNamespace } | null> {
    const snapshot = await this.snapshot(releasing);
    if (!snapshot) return null;
    const pane = snapshot.panes.find(candidate => candidate.pane_id === this.pinned!.placement!.paneId);
    if (!pane) return null;
    return { snapshot, pane, namespace: this.classifyNamespace(pane) };
  }

  private namespaceFailure(namespace: TokenNamespace, expected: NamespaceKind | 'publish'): void {
    if (namespace.kind === 'foreign') this.refuse();
    if (expected === namespace.kind || (expected === 'publish' && namespace.kind === 'empty')) return;
    throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent metadata is unconfirmed.');
  }

  private closureProofMatches(proof: HerdrAgentReporterClosureProof | undefined): boolean {
    return proof !== undefined
      && proof.appSessionId === this.options.appSessionId
      && proof.ownerGeneration === this.options.ownerGeneration
      && proof.providerSessionId === this.options.providerSessionId
      && proof.childClosed === true;
  }

  private guard(releasing = false, expectedNamespace: NamespaceKind | 'publish' = 'empty', closureProof?: HerdrAgentReporterClosureProof): HerdrDispatchGuard {
    return {
      admit: async () => {
        const target = this.target();
        if (!target || (releasing
          ? target.binding?.lifecycle !== 'closed' && !this.closureProofMatches(closureProof)
          : target.binding?.lifecycle === 'closed')) this.refuse();
        const observed = await this.inspect(releasing);
        if (!observed) throw new HerdrError('HERDR_NOT_PRESENT', 404, 'Herdr pane is absent.');
        this.namespaceFailure(observed.namespace, expectedNamespace);
      },
      check: () => {
        this.target();
        this.checkEndpoint();
      },
    };
  }

  update(state: HerdrManagedState): void {
    if (this.stopped) return;
    if (state.identity.appSessionId !== this.options.appSessionId || state.identity.ownerGeneration !== this.options.ownerGeneration ||
      (state.providerSessionId !== null && state.providerSessionId !== this.options.providerSessionId)) {
      try { this.refuse(); } catch { return; }
    }
    this.desired = herdrAgentDisplayState(state);
    this.pump();
  }

  start(): void {
    if (this.stopped || this.timer) return;
    try { this.update(this.options.readState?.() ?? herdrManagedDb.getState(this.options.appSessionId, this.options.ownerGeneration)); }
    catch { this.publish('unavailable'); }
    this.timer = setInterval(() => { if (!this.pinned) this.pump(); }, 250);
    this.timer.unref();
  }

  private pump(): void {
    if (this.stopped || this.flight || this.attempted === this.desired) return;
    this.flight = Promise.resolve().then(async () => {
      while (!this.stopped && this.attempted !== this.desired) {
        if (!this.target()) { this.publish('pending'); return; }
        const state = this.desired;
        this.attempted = state;
        if (this.seq === Number.MAX_SAFE_INTEGER) this.refuse();
        try {
          await this.publishState(state);
          this.target();
          const confirmed = await this.inspect();
          if (!confirmed || confirmed.namespace.kind !== 'ours') {
            if (confirmed?.namespace.kind === 'foreign') this.refuse();
            throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent publication is unconfirmed.');
          }
          if (confirmed.pane.agent !== 'gjc' || confirmed.pane.agent_status !== state) {
            throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent publication is unconfirmed.');
          }
          this.publish('published');
        } catch { if (!this.stale) this.publish('unavailable'); }
      }
    }).catch(() => {
      if (!this.stale) {
        if (this.pinned) this.attempted = this.desired;
        this.publish('unavailable');
      }
    }).finally(() => {
      this.flight = undefined;
      // Drain a status change that arrived at the settlement boundary; never
      // retry the same attempted state simply because tokens keep arriving.
      if (this.pinned && !this.stopped && this.attempted !== this.desired) this.pump();
    });
  }

  async quiesce(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.flight;
    if (!this.stale && !this.released && !this.cleanupAttempted) this.publish('quiesced');
  }

  async release(closureProof?: HerdrAgentReporterClosureProof): Promise<boolean> {
    await this.quiesce();
    if (this.stale || this.released || this.cleanupAttempted) return this.released;
    try {
      const target = this.target();
      if (!target) { this.publish('pending'); return !this.pinned; }
      if (target.binding?.lifecycle !== 'closed' && !this.closureProofMatches(closureProof)) {
        this.publish('not_closed');
        return false;
      }
      if (!this.metadataAttempted && !this.agentAttempted) { this.publish('not_present'); return true; }
      const before = await this.inspect(true);
      if (!before) { this.publish('not_present'); return true; }
      if (before.namespace.kind === 'foreign') this.refuse();
      const foreign = before.namespace.foreign;
      // A lost cleanup reply never permits an automatic second removal.
      this.cleanupAttempted = true;
      if (before.namespace.kind === 'ours') {
        await this.client!.reportMetadata({
          paneId: this.pinned!.placement!.paneId,
          source: this.source,
          seq: this.nextSeq(),
          tokens: {
            gajae_native_session_id: null,
            gajae_owner_generation: null,
            gajae_app_session_id: null,
          },
        }, undefined, this.guard(true, 'ours', closureProof));
        this.target();
        const afterClear = await this.inspect(true);
        if (!afterClear) { this.publish('not_present'); return true; }
        if (afterClear.namespace.kind === 'foreign') this.refuse();
        if (afterClear.namespace.kind !== 'empty' || !sameTokens(afterClear.namespace.foreign, foreign)) {
          throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent metadata cleanup is unconfirmed.');
        }
      }
      if (this.agentAttempted) await this.client!.releaseAgent({
        paneId: this.pinned!.placement!.paneId,
        source: this.source,
        seq: this.nextSeq(),
      }, undefined, this.guard(true, 'empty', closureProof));
      this.target();
      const afterRelease = await this.inspect(true);
      if (!afterRelease) { this.publish('not_present'); return true; }
      if (afterRelease.namespace.kind === 'foreign') this.refuse();
      if (afterRelease.namespace.kind !== 'empty' || !sameTokens(afterRelease.namespace.foreign, foreign)) {
        throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent release is unconfirmed.');
      }
      this.released = true;
      this.publish('released');
      return true;
    } catch (error) {
      if (!this.stale) this.publish(error instanceof HerdrError && error.code === 'HERDR_NOT_PRESENT' ? 'not_present' : 'unavailable');
      return error instanceof HerdrError && error.code === 'HERDR_NOT_PRESENT';
    }
  }

  private async publishState(state: DisplayState): Promise<void> {
    if (!this.metadataAttempted) {
      const observed = await this.inspect();
      if (!observed) throw new HerdrError('HERDR_NOT_PRESENT', 404, 'Herdr pane is absent.');
      if (observed.namespace.kind === 'foreign') this.refuse();
      this.metadataAttempted = true;
      if (observed.namespace.kind === 'ours') {
        this.metadataEstablished = true;
      } else {
        await this.client!.reportMetadata({
          paneId: this.pinned!.placement!.paneId,
          source: this.source,
          seq: this.nextSeq(),
          tokens: {
            gajae_native_session_id: this.options.providerSessionId,
            gajae_owner_generation: this.options.ownerGeneration,
            gajae_app_session_id: this.options.appSessionId,
          },
        }, undefined, this.guard(false, 'publish'));
        this.target();
        const confirmed = await this.inspect();
        if (!confirmed) throw new HerdrError('HERDR_NOT_PRESENT', 404, 'Herdr pane is absent.');
        if (confirmed.namespace.kind === 'foreign') this.refuse();
        if (confirmed.namespace.kind !== 'ours') {
          throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent metadata is unconfirmed.');
        }
        this.metadataEstablished = true;
      }
    }
    if (!this.metadataEstablished) throw new HerdrError('HERDR_PUBLICATION_UNCONFIRMED', 502, 'Herdr native agent metadata is unconfirmed.');
    const identity = await this.inspect();
    if (!identity) throw new HerdrError('HERDR_NOT_PRESENT', 404, 'Herdr pane is absent.');
    this.namespaceFailure(identity.namespace, 'ours');
    this.agentAttempted = true;
    await this.client!.reportAgent({
      paneId: this.pinned!.placement!.paneId,
      source: this.source,
      state,
      seq: this.nextSeq(),
    }, undefined, this.guard(false, 'ours'));
  }
}
