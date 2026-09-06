import { createHash, randomUUID } from 'node:crypto';

import { MANAGED_CHAT_MAX_FRAME_BYTES, pageTransfer, projectManagedEvent, projectManagedState } from '../../../../shared/herdr-managed-chat.js';
import type { HerdrManagedBridgeTransport, HerdrManagedCommand, HerdrManagedCommandReceipt } from '../../../../shared/herdr-managed-protocol.js';
import { herdrManagedActionIdSchema } from '../../../../shared/herdr-managed-protocol.js';
import type { HerdrManagedState } from '../../../../shared/herdr-managed-state.js';
import { herdrManagedProvisionDb, herdrManagedDb, getConnection } from '../../database/index.js';
import { appendImagesInputTag, filterImagesToUploadStore } from '../../../shared/image-attachments.js';
import { automationService } from '../../automation/index.js';

import type { HerdrManagedAttachClient } from './herdr-managed-client.js';
import { getProductionHerdrManagedWorkspacesService, type HerdrManagedWorkspacesService, type HerdrManagedTrustedOptions } from './herdr-managed-workspaces.js';

export interface ManagedChatConnection { readyState: number; bufferedAmount?: number; send(data: string): void; close?(code?: number, reason?: string): void }
export type ManagedChatResult = { ok: boolean; receipt?: HerdrManagedCommandReceipt; error?: string; status?: string };
export type ManagedChatSend = { sessionId: string; content: string; actionId: string; options?: Record<string, unknown>; userId?: string | number };
export type ManagedChatControl = { sessionId: string; actionId: string; content?: string; turnId?: string };
export type ManagedChatPermissionResponse = { sessionId: string; actionId: string; requestId: string; allow: boolean; always?: boolean; message?: string; updatedInput?: unknown };
type Client = Pick<HerdrManagedAttachClient, 'state' | 'recover' | 'subscribe' | 'subscribeState' | 'command' | 'automationControl' | 'close' | 'connected'>;
type Binding = { client: Client; viewers: Set<ManagedChatConnection>; off: (() => void)[]; renewing?: boolean };
export type HerdrManagedChatOptions = {
  workspaces?: Pick<HerdrManagedWorkspacesService, 'isManaged' | 'ensure' | 'attach'>;
  db?: Pick<typeof herdrManagedProvisionDb, 'get' | 'projectState'>;
  automationTransport?: () => Promise<HerdrManagedBridgeTransport | null>;
};
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const validActionId = (value: unknown): value is string => herdrManagedActionIdSchema.safeParse(value).success;

/** Owns App projections and attach leases, never the retained SDK owner. */
export class HerdrManagedChatService {
  readonly #workspaces;
  readonly #db;
  readonly #capability;
  readonly #bindings = new Map<string, Binding>();
  readonly #attaching = new Map<string, Promise<Binding>>();
  readonly #detached = new WeakSet<ManagedChatConnection>();
  #closed = false;
  constructor(options: HerdrManagedChatOptions = {}) {
    this.#workspaces = options.workspaces ?? getProductionHerdrManagedWorkspacesService();
    this.#db = options.db ?? herdrManagedProvisionDb;
    this.#capability = options.automationTransport ?? (async () => {
      const transport = automationService.managedBridgeCapability();
      return transport ? { ownerConnectionId: randomUUID(), bridgeInstanceId: transport.bridgeInstanceId, transportLocator: transport.socketPath, transportToken: transport.token } : null;
    });
  }
  isManaged(id: string): boolean { return this.#workspaces.isManaged(id); }
  async #renew(binding: Binding, state: HerdrManagedState): Promise<void> {
    const disconnected = () => binding.client.connected === false;
    if (this.#closed || disconnected() || binding.renewing) return;
    binding.renewing = true;
    try {
      const currentTransport = await this.#capability();
      if (this.#closed || !currentTransport || disconnected()) return;
      for (const operation of Object.values(state.automation)) {
        if (this.#closed || disconnected()) return;
        if (operation.phase === 'outcome_unknown' && operation.capabilityGeneration) {
          await binding.client.automationControl({ type: 'reconcile', actionId: randomUUID(), identity: operation.identity, originalCapabilityGeneration: operation.capabilityGeneration, currentTransport });
        } else if (['waiting_attachment', 'awaiting_reattach_approval'].includes(operation.phase)) {
          await binding.client.automationControl({ type: 'bind-capability', actionId: randomUUID(), identity: operation.identity, currentTransport });
        }
      }
    } catch { /* Absence leaves the durable operation waiting, not failed. */ }
    finally { binding.renewing = false; }
  }
  #emit(connection: ManagedChatConnection, value: unknown): boolean {
    if (this.#closed || this.#detached.has(connection) || connection.readyState !== 1) { this.detach(connection); return false; }
    const encoded = JSON.stringify(value);
    if ((connection.bufferedAmount ?? 0) + Buffer.byteLength(encoded) > MANAGED_CHAT_MAX_FRAME_BYTES * 4) {
      this.detach(connection);
      try { connection.close?.(1013, 'Managed projection consumer is too slow; reconnect.'); } catch { /* Already detached; a failed close cannot restore projection delivery. */ }
      return false;
    }
    try { connection.send(encoded); return true; } catch { this.detach(connection); return false; }
  }
  #snapshot(connection: ManagedChatConnection, state: HerdrManagedState): void {
    for (const frame of pageTransfer(projectManagedState(state), randomUUID())) if (!this.#emit(connection, frame)) break;
  }
  #project(state: HerdrManagedState): void {
    if (!state.providerSessionId) throw new Error('Managed provider identity is not ready.');
    const history = state.extensions.filter(e => e.kind === 'managed.nativehistory').at(-1);
    const metadata = object(history?.payload);
    this.#db.projectState(state.identity.appSessionId, state.identity.ownerGeneration, state.watermark, {
      providerSessionId: state.providerSessionId, title: state.title,
      ...(metadata.providerSessionId === state.providerSessionId && typeof metadata.jsonlPath === 'string' ? { jsonlPath: metadata.jsonlPath } : {}),
    });
  }
  #attach(id: string): Promise<Binding> {
    if (this.#closed) return Promise.reject(new Error('Managed chat is closed.'));
    const live = this.#bindings.get(id);
    if (live?.client.state && live.client.connected) return Promise.resolve(live);
    const pending = this.#attaching.get(id); if (pending) return pending;
    const task = (async () => {
      const client = await this.#workspaces.attach(id);
      if (this.#closed || client.connected === false) { client.close(); throw new Error('Managed attach unavailable.'); }
      let binding = this.#bindings.get(id);
      if (binding?.client !== client) {
        const viewers = binding?.viewers ?? new Set<ManagedChatConnection>();
        binding?.off.forEach(off => off());
        binding = { client, viewers, off: [] };
        this.#bindings.set(id, binding);
        const current = binding;
        const renewal = setInterval(() => { if (client.state) void this.#renew(current, client.state); }, 2000);
        renewal.unref();
        current.off.push(() => clearInterval(renewal));
        let liveWatermark = -1;
        current.off.push(client.subscribeState(state => {
          void this.#renew(current, state);
          try { this.#project(state); } catch { for (const viewer of current.viewers) this.#emit(viewer, { kind: 'managed_ui_status', sessionId: id, status: 'projection_unavailable' }); return; }
          // Live callbacks immediately follow state callbacks. Only recovery needs replacement.
          queueMicrotask(() => {
            if (this.#closed || this.#bindings.get(id) !== current || client.state !== state || liveWatermark === state.watermark) return;
            for (const viewer of current.viewers) this.#snapshot(viewer, state);
          });
        }));
        current.off.push(client.subscribe(event => {
          const state = client.state; if (!state || state.watermark !== event.seq) return;
          liveWatermark = event.seq;
          const frame = projectManagedEvent(event, state);
          for (const viewer of current.viewers) {
            if (Buffer.byteLength(JSON.stringify(frame)) <= MANAGED_CHAT_MAX_FRAME_BYTES) this.#emit(viewer, frame);
            else this.#snapshot(viewer, state);
          }
        }));
        if (client.state) this.#project(client.state);
        if (client.state) await this.#renew(current, client.state);
      }
      return binding;
    })().finally(() => this.#attaching.delete(id));
    this.#attaching.set(id, task); return task;
  }
  async subscribe(sessionId: string, connection: ManagedChatConnection, _lastSeq?: number): Promise<ManagedChatResult> {
    if (!this.isManaged(sessionId)) return { ok: false, error: 'Session is not managed.' };
    try {
      const binding = await this.#attach(sessionId);
      const state = binding.client.state ?? await binding.client.recover();
      if (this.#closed || this.#detached.has(connection) || connection.readyState !== 1) return { ok: false, status: 'unknown', error: 'Managed viewer disconnected.' };
      if (!binding.viewers.has(connection)) this.#snapshot(connection, state);
      if (this.#detached.has(connection)) return { ok: false, status: 'unknown', error: 'Managed projection disconnected; reconnect.' };
      binding.viewers.add(connection);
      return { ok: true };
    } catch { return this.#unavailable(sessionId, connection); }
  }
  #unavailable(sessionId: string, connection: ManagedChatConnection, status = 'unknown'): ManagedChatResult {
    this.#emit(connection, { kind: 'managed_ui_status', sessionId, status, context: 'Managed owner unavailable; no local run was started.' });
    return { ok: false, status, error: 'Managed owner unavailable; reconnect to recover its actual state.' };
  }
  async send(input: ManagedChatSend, connection: ManagedChatConnection): Promise<ManagedChatResult> {
    if (this.#closed) return { ok: false, status: 'unknown', error: 'Managed chat is closed.' };
    if (!this.isManaged(input.sessionId)) return { ok: false, error: 'Session is not managed.' };
    if (!validActionId(input.actionId)) return { ok: false, error: 'Managed command requires a stable actionId.' };
    const options = input.options ?? {};
    const trusted: HerdrManagedTrustedOptions = {};
    for (const key of ['model', 'modelId', 'modelProfile', 'effort'] as const) {
      if (options[key] !== undefined && typeof options[key] !== 'string') return { ok: false, error: `Invalid managed ${key}.` };
      if (typeof options[key] === 'string') trusted[key] = options[key];
    }
    const images = filterImagesToUploadStore(options.images);
    if (!input.content.trim() && !images.length) return { ok: false, error: 'Managed send requires content or an uploaded image.' };
    try {
      const ready = await this.#workspaces.ensure(input.sessionId, trusted);
      if (ready.status !== 'ready') return this.#unavailable(input.sessionId, connection, ready.status);
      const subscribed = await this.subscribe(input.sessionId, connection);
      if (!subscribed.ok) return subscribed;
      const state = this.#bindings.get(input.sessionId)?.client.state;
      const modelId = trusted.modelId ?? trusted.model;
      const profile = trusted.modelProfile ?? (modelId?.startsWith('profile:') ? modelId.slice(8) : undefined);
      const turnOptions = { ...(modelId && !profile ? { modelId } : {}), ...(profile ? { modelProfile: profile } : {}), ...(trusted.effort ? { effort: trusted.effort } : {}) };
      const prior = state ? herdrManagedDb.getCommand(input.sessionId, state.identity.ownerGeneration, input.actionId) : null;
      return await this.#command(input.sessionId, input.actionId, prior?.kind === 'prompt' || prior?.kind === 'followup' ? prior.kind : state?.activeTurnId || state?.queue.entries.length ? 'followup' : 'prompt',
        { text: appendImagesInputTag(input.content, images), displayText: input.content, images, turnOptions });
    } catch { return this.#unavailable(input.sessionId, connection); }
  }
  async #command(id: string, actionId: string, kind: HerdrManagedCommand['kind'], payload: unknown): Promise<ManagedChatResult> {
    if (!validActionId(actionId)) return { ok: false, error: 'Managed command requires a stable actionId.' };
    try {
      const binding = await this.#attach(id);
      const state = binding.client.state;
      if (!state?.providerSessionId) return { ok: false, error: 'Managed provider identity is not ready.' };
      this.#project(state);
      const response = await binding.client.command({ protocolVersion: 1, ...state.identity, actionId, kind, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'), payload });
      if (response.type !== 'receipt') return { ok: false, error: 'Managed command outcome unknown; query action status before retrying.' };
      return { ok: response.receipt.state !== 'rejected' && response.receipt.state !== 'unknown', receipt: response.receipt };
    } catch { return { ok: false, error: 'Managed command outcome unknown; reconnect and query action status.' }; }
  }
  async steer(input: ManagedChatControl): Promise<ManagedChatResult> {
    return this.#control(input, 'steer');
  }
  async abort(input: ManagedChatControl): Promise<ManagedChatResult> { return this.#control(input, 'abort'); }
  async status(sessionId: string, actionId: string, targetActionId?: string): Promise<ManagedChatResult> {
    return this.#command(sessionId, actionId, targetActionId ? 'ack' : 'status', targetActionId ? { actionId: targetActionId } : {});
  }
  async #control(input: ManagedChatControl, kind: 'steer' | 'abort'): Promise<ManagedChatResult> {
    if (!validActionId(input.actionId)) return { ok: false, error: 'Managed command requires a stable actionId.' };
    if (kind === 'steer' && !input.content?.trim()) return { ok: false, error: 'Managed steer requires content.' };
    try {
      const state = (await this.#attach(input.sessionId)).client.state;
      return await this.#command(input.sessionId, input.actionId, kind, { turnId: input.turnId ?? state?.activeTurnId, ...(kind === 'steer' ? { text: input.content ?? '' } : {}) });
    } catch { return { ok: false, error: 'Managed owner unavailable.' }; }
  }
  async permissionResponse(input: ManagedChatPermissionResponse): Promise<ManagedChatResult> {
    if (!validActionId(input.actionId)) return { ok: false, error: 'Managed command requires a stable actionId.' };
    try {
      const state = (await this.#attach(input.sessionId)).client.state;
      if (!state) return { ok: false, error: 'Managed state unavailable.' };
      const operation = Object.values(state.automation).find(op => op.approvalRequestId === input.requestId);
      if (operation) return this.#command(input.sessionId, input.actionId, 'resume', { identity: operation.identity, capabilityGeneration: operation.capabilityGeneration, approvalRequestId: operation.approvalRequestId, decision: input.allow ? 'approve' : 'deny' });
      const request = Object.values(state.requests).find(r => r.requestId === input.requestId);
      if (!request) return { ok: false, error: 'Managed request is stale or already resolved.' };
      return await this.#command(input.sessionId, input.actionId, request.kind === 'ask' ? 'answer' : 'permission', {
        requestId: request.requestId, providerSessionId: request.providerSessionId, turnId: request.turnId, policyRevision: request.policyRevision,
        allow: input.allow, always: input.always, message: input.message, updatedInput: input.updatedInput,
      });
    } catch { return { ok: false, error: 'Managed decision outcome unknown; recover pending requests.' }; }
  }
  async handle(connection: ManagedChatConnection, data: Record<string, unknown>, userId?: string | number | null): Promise<boolean> {
    const type = data.type;
    if (typeof type !== 'string' || !type.startsWith('chat.')) return false;
    if (type === 'chat.subscribe' && Array.isArray(data.sessions)) {
      let consumed = true;
      for (const entry of data.sessions) {
        const subscription = object(entry);
        const id = typeof subscription.sessionId === 'string' ? subscription.sessionId : '';
        if (!id || !this.isManaged(id)) { consumed = false; continue; }
        await this.subscribe(id, connection, typeof subscription.lastSeq === 'number' ? subscription.lastSeq : undefined);
      }
      return consumed && data.sessions.length > 0;
    }
    let sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (type === 'chat.permission-response' && requestId) {
      const owner = getConnection().prepare(`SELECT app_session_id FROM herdr_managed_decisions WHERE request_id = ?
        UNION ALL SELECT state.app_session_id FROM herdr_managed_state AS state, json_each(state.state_json, '$.automation') AS operation
        WHERE json_extract(operation.value, '$.approvalRequestId') = ? LIMIT 1`).get(requestId, requestId) as { app_session_id: string } | undefined;
      if (owner) {
        if (sessionId && sessionId !== owner.app_session_id) {
          this.#emit(connection, { kind: 'managed_command_result', sessionId, actionId: validActionId(data.actionId) ? data.actionId : null, requestId, result: { ok: false, error: 'Managed request owner mismatch.' } });
          return true;
        }
        sessionId = owner.app_session_id;
      }
    }
    if (!sessionId || !this.isManaged(sessionId)) return false;
    const query = type === 'chat.subscribe' || type === 'chat.status';
    if (!query && !validActionId(data.actionId)) {
      this.#emit(connection, { kind: 'managed_command_result', sessionId, actionId: null, requestId: requestId || null, result: { ok: false, error: 'Managed command requires a stable actionId.' } });
      return true;
    }
    const actionId = validActionId(data.actionId) ? data.actionId : randomUUID();
    const content = typeof data.content === 'string' ? data.content : typeof data.message === 'string' ? data.message : '';
    let result: ManagedChatResult;
    switch (type) {
      case 'chat.send': result = await this.send({ sessionId, actionId, content, options: object(data.options), ...(userId == null ? {} : { userId }) }, connection); break;
      case 'chat.subscribe': result = await this.subscribe(sessionId, connection, typeof data.lastSeq === 'number' ? data.lastSeq : undefined); break;
      case 'chat.steer': result = await this.steer({ sessionId, actionId, content, ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}) }); break;
      case 'chat.abort': result = await this.abort({ sessionId, actionId, ...(typeof data.turnId === 'string' ? { turnId: data.turnId } : {}) }); break;
      case 'chat.permission-response': result = typeof data.allow !== 'boolean' ? { ok: false, error: 'Managed decision requires allow.' }
        : await this.permissionResponse({ sessionId, actionId, requestId, allow: data.allow, always: data.always === true, ...(typeof data.message === 'string' ? { message: data.message } : {}), ...(data.updatedInput === undefined ? {} : { updatedInput: data.updatedInput }) }); break;
      case 'chat.status': result = await this.status(sessionId, actionId, typeof data.targetActionId === 'string' ? data.targetActionId : undefined); break;
      default: result = { ok: false, error: 'Unsupported managed chat command.' };
    }
    this.#emit(connection, { kind: 'managed_command_result', sessionId, actionId, requestId: requestId || null, result });
    return true;
  }
  detach(connection: ManagedChatConnection): void { this.#detached.add(connection); for (const binding of this.#bindings.values()) binding.viewers.delete(connection); }
  close(): void { this.#closed = true; for (const binding of this.#bindings.values()) { binding.off.forEach(off => off()); binding.client.close(); } this.#bindings.clear(); }
}
let productionService: HerdrManagedChatService | null = null;
export function getProductionHerdrManagedChatService(): HerdrManagedChatService { return productionService ??= new HerdrManagedChatService(); }
