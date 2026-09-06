import { randomUUID } from 'node:crypto';
import net from 'node:net';

import {
  HERDR_MANAGED_PROTOCOL_VERSION,
  HERDR_MANAGED_MAX_FRAME_BYTES,
  HERDR_MANAGED_MAX_PENDING_REQUESTS,
  herdrManagedAttachResponseSchema,
  type HerdrManagedAttachResponse,
  type HerdrManagedCommand,
  type HerdrManagedEvent,
  type HerdrManagedSnapshotDescriptor,
  type HerdrManagedAutomationControl,
} from '../../../../shared/herdr-managed-protocol.js';
import {
  applyHerdrManagedEvent, assembleHerdrManagedSnapshot, type HerdrManagedState,
} from '../../../../shared/herdr-managed-state.js';

type Pending = {
  resolve: (value: HerdrManagedAttachResponse) => void;
  reject: (reason: Error) => void;
};

/** App connection lifetime never owns the managed SDK child lifetime. */
export class HerdrManagedAttachClient {
  #socket: net.Socket | null = null;
  #buffer: Buffer = Buffer.alloc(0);
  #pending = new Map<string, Pending>();
  #listeners = new Set<(event: HerdrManagedEvent) => void>();
  #authenticated = false;
  #state: HerdrManagedState | null = null;
  #descriptor: HerdrManagedSnapshotDescriptor | null = null;
  #recovery: Promise<HerdrManagedState> | null = null;
  #buildingSnapshot = false;
  #liveGap = false;
  #stateListeners = new Set<(state: HerdrManagedState) => void>();

  constructor(private readonly options: { socketPath: string; appSessionId: string; ownerGeneration: string; attachSecret: string }) {}

  async connect(lastAppliedSeq = 0): Promise<HerdrManagedAttachResponse> {
    if (this.#socket) throw new Error('Managed Herdr attach client is already connected.');
    const socket = net.createConnection(this.options.socketPath);
    this.#socket = socket;
    this.#buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      if (this.#socket !== socket) return;
      try { this.#receive(chunk); } catch { this.#fail(socket); }
    });
    socket.on('error', () => this.#fail(socket));
    socket.on('close', () => this.#fail(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        const disconnected = () => reject(new Error('Managed Herdr attach failed.'));
        socket.once('close', disconnected);
        socket.once('error', disconnected);
        socket.once('connect', () => {
          socket.removeListener('close', disconnected);
          socket.removeListener('error', disconnected);
          resolve();
        });
      });
      const response = await this.#request({
        type: 'hello',
        value: {
          protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
          appSessionId: this.options.appSessionId,
          ownerGeneration: this.options.ownerGeneration,
          attachSecret: this.options.attachSecret,
          lastAppliedSeq,
        },
      });
      if (response.type !== 'ready') throw new Error('Managed Herdr attach rejected.');
      this.#descriptor = response.snapshot;
      this.#authenticated = true;
      return response;
    } catch {
      this.#fail(socket);
      throw new Error('Managed Herdr attach failed.');
    }
  }

  subscribe(listener: (event: HerdrManagedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get state(): HerdrManagedState | null { return this.#state; }
  get connected(): boolean { return this.#authenticated && this.#socket !== null && !this.#socket.destroyed; }

  subscribeState(listener: (state: HerdrManagedState) => void): () => void {
    this.#stateListeners.add(listener);
    return () => { this.#stateListeners.delete(listener); };
  }

  /** Complete immutable pages replace state once, then the durable cursor feeds live events. */
  recover(): Promise<HerdrManagedState> {
    if (this.#recovery) return this.#recovery;
    if (!this.#authenticated) return Promise.reject(new Error('Managed Herdr attach is not authenticated.'));
    const recovery = this.#recoverPages();
    this.#recovery = recovery;
    void recovery.finally(() => {
      if (this.#recovery === recovery) this.#recovery = null;
    }).catch(() => {});
    return recovery;
  }

  async #recoverPages(): Promise<HerdrManagedState> {
    // A lease can expire without invalidating the live SDK owner. Retry against
    // that same authenticated connection; never create/resume an SDK session.
    for (;;) {
      this.#buildingSnapshot = true;
      this.#liveGap = false;
      let descriptor = this.#descriptor;
      this.#descriptor = null;
      if (!descriptor) {
        const response = await this.snapshot();
        if (response.type !== 'ready') throw new Error('Managed snapshot unavailable.');
        descriptor = response.snapshot;
      }
      const pages: string[] = [];
      let expired = false;
      for (let page = 0; page < descriptor.pageCount; page++) {
        const response = await this.#request({ type: 'snapshot-page', snapshotId: descriptor.snapshotId, page });
        if (response.type === 'snapshot-required' && response.reason === 'lease_expired') { expired = true; break; }
        if (response.type !== 'snapshot-page' || response.snapshotId !== descriptor.snapshotId || response.page !== page) {
          throw new Error('Managed snapshot page mismatch.');
        }
        pages.push(response.chunk);
      }
      if (expired) continue;
      const state = assembleHerdrManagedSnapshot(descriptor, pages);
      // Snapshot request has already suspended server push. Install only the
      // fully assembled projection before subscribe can deliver subsequent events.
      this.#state = state;
      this.#buildingSnapshot = false;
      this.#notifyState();
      const subscribed = await this.#request({ type: 'subscribe', watermark: state.watermark });
      if (subscribed.type === 'snapshot-required' || this.#liveGap) continue;
      if (subscribed.type !== 'subscribed' || subscribed.watermark !== state.watermark) throw new Error('Managed subscription watermark mismatch.');
      return this.#state;
    }
  }

  automationControl(control: HerdrManagedAutomationControl): Promise<HerdrManagedAttachResponse> {
    if (!this.#authenticated) return Promise.reject(new Error('Managed Herdr attach is not authenticated.'));
    return this.#request({ type: 'automation-control', control });
  }

  command(command: HerdrManagedCommand): Promise<HerdrManagedAttachResponse> {
    if (!this.#authenticated) return Promise.reject(new Error('Managed Herdr attach is not authenticated.'));
    return this.#request({ type: 'command', value: command });
  }

  snapshot(): Promise<HerdrManagedAttachResponse> {
    if (!this.#authenticated) return Promise.reject(new Error('Managed Herdr attach is not authenticated.'));
    return this.#request({ type: 'snapshot' });
  }

  close(): void {
    if (this.#socket) this.#fail(this.#socket);
  }

  #fail(socket: net.Socket): void {
    if (this.#socket !== socket) return;
    this.#socket = null;
    this.#authenticated = false;
    this.#buffer = Buffer.alloc(0);
    this.#descriptor = null;
    for (const pending of this.#pending.values()) pending.reject(new Error('Managed Herdr attach disconnected; query action status after reconnect.'));
    this.#pending.clear();
    socket.destroy();
  }

  #request(value: Record<string, unknown>): Promise<HerdrManagedAttachResponse> {
    const socket = this.#socket;
    if (!socket) return Promise.reject(new Error('Managed Herdr attach client is not connected.'));
    if (this.#pending.size >= HERDR_MANAGED_MAX_PENDING_REQUESTS) return Promise.reject(new Error('Managed Herdr attach request limit reached.'));
    const id = randomUUID();
    const encoded = Buffer.from(`${JSON.stringify({ ...value, id })}\n`);
    if (encoded.byteLength > HERDR_MANAGED_MAX_FRAME_BYTES) return Promise.reject(new Error('Managed Herdr attach frame too large.'));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      socket.write(encoded, (error) => { if (error) this.#fail(socket); });
    });
  }

  #receive(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline + 1;
      const segment = chunk.subarray(offset, end);
      if (this.#buffer.length + segment.length > HERDR_MANAGED_MAX_FRAME_BYTES) throw new Error('Oversized attach frame.');
      this.#buffer = Buffer.concat([this.#buffer, segment]);
      offset = end;
      if (newline < 0) break;
      const text = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer);
      this.#buffer = Buffer.alloc(0);
      const response = herdrManagedAttachResponseSchema.parse(JSON.parse(text) as unknown);
      if (response.type === 'snapshot-required' && response.id === 'live') {
        this.#liveGap = true;
        void this.recover().catch(() => { if (this.#socket) this.#fail(this.#socket); });
        continue;
      }
      if (response.type === 'event') {
        this.#assertIdentity(response.event);
        if (this.#buildingSnapshot) continue;
        if (this.#state && response.event.seq > this.#state.watermark) {
          if (response.event.seq !== this.#state.watermark + 1) {
            // Pull a new authoritative snapshot instead of permanently refusing
            // a routine replay gap. Do not publish an out-of-order delta.
            this.#liveGap = true;
            void this.recover().catch(() => { if (this.#socket) this.#fail(this.#socket); });
            continue;
          }
          this.#state = applyHerdrManagedEvent(this.#state, response.event);
          this.#notifyState();
        } else if (this.#state) continue;
        for (const listener of this.#listeners) {
          try { listener(response.event); } catch { this.#listeners.delete(listener); }
        }
        continue;
      }
      if (response.type === 'ready') this.#assertIdentity(response.snapshot.identity);
      if (response.type === 'receipt') this.#assertIdentity(response.receipt);
      const pending = this.#pending.get(response.id);
      if (!pending) throw new Error('Unexpected attach response.');
      this.#pending.delete(response.id);
      pending.resolve(response);
    }
  }

  #notifyState(): void {
    if (!this.#state) return;
    for (const listener of this.#stateListeners) {
      try { listener(this.#state); } catch { this.#stateListeners.delete(listener); }
    }
  }

  #assertIdentity(value: { appSessionId: string; ownerGeneration: string }): void {
    if (value.appSessionId !== this.options.appSessionId || value.ownerGeneration !== this.options.ownerGeneration) throw new Error('Managed Herdr attach identity mismatch.');
  }
}
