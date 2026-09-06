import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import type { Writable } from 'node:stream';

import { initializeDatabase } from '@/modules/database/init-db.js';
import { closeConnection, getConnection, getDatabasePath } from '@/modules/database/connection.js';
import { herdrManagedDb } from '@/modules/database/repositories/herdr-managed.db.js';
import { herdrManagedProvisionDb } from '@/modules/database/repositories/herdr-managed-provision.db.js';
import { herdrManagedSnapshotsDb } from '@/modules/database/repositories/herdr-managed-snapshots.db.js';
import { HerdrAgentReporter, type HerdrAgentReporterStatus } from '@/modules/herdr/index.js';

import { verifyManagedBridgeReceipt, verifyManagedBridgeTarget, type HerdrManagedBridgeResolveRequest } from '../shared/herdr-managed-bridge.js';
import type { HerdrManagedChildAutomationControl, ManagedChildEvent, ManagedChildRequest, ManagedChildTurnOptions } from '../shared/herdr-managed-child-protocol.js';
import {
  HERDR_MANAGED_PROTOCOL_VERSION,
  publicManagedTargetContext,
  herdrManagedAttachFrameSchema,
  herdrManagedCommandSchema,
  herdrManagedAutomationOperationSchema,
  HERDR_MANAGED_MAX_FRAME_BYTES,
  type HerdrManagedAutomationControl,
  type HerdrManagedCapability,
  type HerdrManagedCommand,
  type HerdrManagedCommandReceipt,
  type HerdrManagedEvent,
  type HerdrManagedHostHello,
} from '../shared/herdr-managed-protocol.js';

import { gjcAutoApprovalReason, managedBridgeRequest, type SdkRunConfig } from './gjc-engine.js';
import { ManagedAutomationStore, automationCanonical } from './gjc-herdr-automation-store.js';
import { ManagedChildTransport } from './gjc-herdr-child-client.js';
import { acquireConsoleTerminal, ConsoleInputDecoder, ConsoleOutputWriter, parseConsoleLine, renderConsoleReceipt, renderConsoleReject, renderRequest, renderEvent } from './gjc-herdr-task-console.js';


export type ManagedSdkSession = {
  providerSessionId: string;
  prompt(message: string, actionId: string, turnOptions?: ManagedChildTurnOptions): Promise<unknown>;
  steer?(message: string, actionId: string, runId: string): Promise<boolean>;
  abort?(actionId: string, runId: string): Promise<boolean>;
  resolveApproval?(requestId: string, decision: Record<string, unknown>, actionId: string, runId: string): boolean | Promise<boolean>;
  validateApproval?(requestId: string, decision: Record<string, unknown>, actionId: string, runId: string): boolean | Promise<boolean>;
  automationControl?(control: HerdrManagedChildAutomationControl): Promise<boolean>;
  operationStatus?(operationId: string): Promise<'in_flight' | 'completed' | 'not_found'>;
  dispose?(): Promise<void> | void;
};

export type ManagedSdkSessionFactory = (input: {
  appSessionId: string;
  ownerGeneration: string;
  cwd: string;
  sessionRoot: string;
  onEvent: (event: ManagedChildEvent) => void | Promise<void>;
}) => Promise<ManagedSdkSession> | ManagedSdkSession;

export type HerdrTaskHostBootstrap = {
  appSessionId: string;
  ownerGeneration: string;
  herdrInstanceId: string;
  projectPath: string;
  sessionRoot: string;
  agentDir?: string;
  runConfig?: SdkRunConfig;
  attachSocketPath?: string;
  attachSecret?: string;
  databasePath?: string;
  claimNonce?: string;
};

export type HerdrTaskHostOptions = {
  bootstrap: HerdrTaskHostBootstrap;
  createSession?: ManagedSdkSessionFactory;
};

export class HerdrTaskHost {
  readonly #bootstrap: HerdrTaskHostBootstrap;
  readonly #createSession: ManagedSdkSessionFactory;
  #session: ManagedSdkSession | null = null;
  #attachServer: net.Server | null = null;
  #clients = new Map<net.Socket, { connectionId: string; cursor: number | null; snapshotId: string | null; blocked: boolean }>();
  #connections = new Set<net.Socket>();
  #closed = false;
  #closeTask: Promise<void> | null = null;
  readonly #closeResources = new Set<() => void>();
  readonly #turnTasks = new Set<Promise<HerdrManagedCommandReceipt>>();
  #abortFence = 0;
  #abortOutcomes = new Map<string, Promise<boolean>>();
  #policyTimer: ReturnType<typeof setInterval> | null = null;
  #policyChecking = false;
  #store: ManagedAutomationStore | null = null;
  #capability: HerdrManagedCapability | null = null;
  #operationCapabilities = new Map<string, HerdrManagedCapability>();
  #fenceQueries = new Set<string>();
  #capabilityControls: Promise<unknown> = Promise.resolve();
  #pumpScheduled = false;
  #providerSessionId = '';
  #agentReporter: HerdrAgentReporter | null = null;
  #listeners = new Set<(event: HerdrManagedEvent) => void>();
  #broadcastSeq = 0;
  #dispatching = new Map<string, { command: HerdrManagedCommand; result: Promise<HerdrManagedCommandReceipt> }>();

  constructor(options: HerdrTaskHostOptions) {
    this.#bootstrap = options.bootstrap;
    this.#createSession = options.createSession ?? createManagedGjcSdkSessionFactory(options.bootstrap);
  }

  get session(): ManagedSdkSession | null { return this.#session; }
  get agentPublication(): HerdrAgentReporterStatus | null { return this.#agentReporter?.status() ?? null; }

  async initialize(): Promise<HerdrManagedHostHello> {
    if (this.#session) throw new Error('Managed Herdr task host already initialized.');
    if (this.#bootstrap.databasePath) {
      if (path.resolve(getDatabasePath()) !== this.#bootstrap.databasePath) throw new Error('Managed database identity mismatch.');
      // Normal App startup owns migrations. A detached host checks the existing
      // schema and claim only; it must never migrate storage while App is absent.
      const database = getConnection({ existingOnly: true });
      for (const sql of [
        'SELECT owner_generation, provider_session_id, lifecycle, last_seq FROM herdr_managed_bindings LIMIT 0',
        'SELECT owner_generation, state_json FROM herdr_managed_state LIMIT 0',
        'SELECT claim_nonce, launch_claimed, phase FROM herdr_managed_provisions LIMIT 0',
        'SELECT owner_generation, request_json, policy_revision, status FROM herdr_managed_decisions LIMIT 0',
        'SELECT owner_generation, action_id, payload_hash, state FROM herdr_managed_commands LIMIT 0',
        'SELECT owner_generation, seq, payload_json FROM herdr_managed_events LIMIT 0',
        'SELECT snapshot_id, pages_json, lease_expires_at FROM herdr_managed_snapshots LIMIT 0',
        'SELECT project_path, revision FROM project_permission_revisions LIMIT 0',
      ]) database.prepare(sql).all();
      if (!this.#bootstrap.claimNonce) throw new Error('Managed launch nonce is required.');
      herdrManagedProvisionDb.claimLaunch(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, this.#bootstrap.claimNonce);
    } else {
      await initializeDatabase();
    }
    herdrManagedDb.beginClaim(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration);
    const session = await this.#createSession({
      appSessionId: this.#bootstrap.appSessionId,
      ownerGeneration: this.#bootstrap.ownerGeneration,
      cwd: this.#bootstrap.projectPath,
      sessionRoot: this.#bootstrap.sessionRoot,
      onEvent: (event) => this.#journalEvent(event),
    });
    this.#session = session;
    this.#providerSessionId = session.providerSessionId;
    const hello = {
      protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
      appSessionId: this.#bootstrap.appSessionId,
      ownerGeneration: this.#bootstrap.ownerGeneration,
      providerSessionId: session.providerSessionId,
    } satisfies HerdrManagedHostHello;
    herdrManagedDb.claim(hello);
    herdrManagedDb.appendEvent({ appSessionId: hello.appSessionId, ownerGeneration: hello.ownerGeneration, kind: 'host.ready', payload: { providerSessionId: hello.providerSessionId } });
    herdrManagedDb.setLifecycle(hello.appSessionId, hello.ownerGeneration, 'idle');
    this.#agentReporter = new HerdrAgentReporter({
      appSessionId: hello.appSessionId,
      ownerGeneration: hello.ownerGeneration,
      providerSessionId: hello.providerSessionId,
    });
    this.#agentReporter.start();
    this.#broadcast();
    this.#policyTimer = setInterval(() => { void this.#refreshPolicy(); }, 1000);
    this.#policyTimer.unref();
    return hello;
  }

  async startPrivateAttachServer(): Promise<string> {
    if (!this.#bootstrap.attachSocketPath || !this.#bootstrap.attachSecret) throw new Error('Managed Herdr attach socket is not configured.');
    if (this.#attachServer) return this.#bootstrap.attachSocketPath;
    const parent = path.dirname(this.#bootstrap.attachSocketPath);
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe attach directory.');
    try {
      await fs.lstat(this.#bootstrap.attachSocketPath);
      throw new Error('Attach target already exists.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.#attachServer = net.createServer((socket) => this.#handleAttach(socket));
    await new Promise<void>((resolve, reject) => {
      this.#attachServer?.once('error', reject);
      this.#attachServer?.listen(this.#bootstrap.attachSocketPath, () => resolve());
    });
    await fs.chmod(this.#bootstrap.attachSocketPath, 0o600);
    return this.#bootstrap.attachSocketPath;
  }

  async dispatch(command: HerdrManagedCommand): Promise<HerdrManagedCommandReceipt> {
    const current = this.#dispatching.get(command.actionId);
    if (current) {
      if (JSON.stringify(current.command) !== JSON.stringify(command)) throw new Error('Managed Herdr command action id conflict.');
      return current.result;
    }
    const result = this.#dispatch(command);
    this.#dispatching.set(command.actionId, { command, result });
    try { return await result; }
    finally { this.#dispatching.delete(command.actionId); this.#broadcast(); }
  }

  async #dispatch(command: HerdrManagedCommand): Promise<HerdrManagedCommandReceipt> {
    const parsed = herdrManagedCommandSchema.parse(command);
    if (!this.#session || this.#closed) throw new Error('Managed Herdr task host is not ready.');
    if (parsed.appSessionId !== this.#bootstrap.appSessionId || parsed.ownerGeneration !== this.#bootstrap.ownerGeneration) throw new Error('Managed Herdr command target mismatch.');
    if (commandHash(parsed.payload) !== parsed.payloadHash) throw new Error('Managed Herdr command payload hash mismatch.');
    void this.#refreshPolicy();
    const existing = herdrManagedDb.getCommand(parsed.appSessionId, parsed.ownerGeneration, parsed.actionId);
    if (existing) {
      if (existing.kind !== parsed.kind || existing.payloadHash !== parsed.payloadHash) throw new Error('Managed Herdr command action id conflict.');
      return existing;
    }
    if (parsed.kind === 'status') {
      return herdrManagedDb.recordCommand({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, actionId: parsed.actionId, kind: parsed.kind, payloadHash: parsed.payloadHash, state: 'settled', message: `Status ${this.snapshot().lifecycle} seq ${this.snapshot().watermark}.` });
    }
    if (parsed.kind === 'ack') {
      const target = isObject(parsed.payload) && typeof parsed.payload.actionId === 'string' ? herdrManagedDb.getCommand(parsed.appSessionId, parsed.ownerGeneration, parsed.payload.actionId) : null;
      return herdrManagedDb.recordCommand({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, actionId: parsed.actionId, kind: parsed.kind, payloadHash: parsed.payloadHash, state: 'settled', message: target ? `${target.actionId} ${target.state} ${target.seq}` : 'No receipt for action.' });
    }
    if (parsed.kind === 'steer') return this.#control(parsed, 'steer');
    if (parsed.kind === 'abort') return this.#control(parsed, 'abort');
    if (parsed.kind === 'answer' || parsed.kind === 'permission') return this.#decision(parsed);
    if (parsed.kind === 'resume') return this.#resume(parsed);
    if (parsed.kind !== 'prompt' && parsed.kind !== 'followup') {
      return herdrManagedDb.recordCommand({
        appSessionId: parsed.appSessionId,
        ownerGeneration: parsed.ownerGeneration,
        actionId: parsed.actionId,
        kind: parsed.kind,
        payloadHash: parsed.payloadHash,
        state: 'rejected',
        message: `Command ${parsed.kind} is not supported by this managed task host.`,
      });
    }
    if (this.#bootstrap.databasePath) {
      herdrManagedProvisionDb.assertReadyProjection(parsed.appSessionId, parsed.ownerGeneration);
    }
    const text = isObject(parsed.payload) && typeof parsed.payload.text === 'string' ? parsed.payload.text : '';
    const binding = herdrManagedDb.get(parsed.appSessionId, parsed.ownerGeneration);
    if (!binding || ['unknown', 'interrupted', 'closed'].includes(binding.lifecycle) || (parsed.kind === 'prompt' && (this.snapshot().activeTurnId || (isObject(parsed.payload) && parsed.payload.expectedStateRevision !== undefined && parsed.payload.expectedStateRevision !== binding.lastSeq)))) {
      return herdrManagedDb.recordCommand({ ...parsed, state: 'rejected', message: 'Owner busy or stale state revision.' });
    }
    if (!text || Buffer.byteLength(text) > 131_072) {
      return herdrManagedDb.recordCommand({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, actionId: parsed.actionId, kind: parsed.kind, payloadHash: parsed.payloadHash, state: 'rejected', message: 'Prompt text is required.' });
    }
    let admitted: HerdrManagedCommandReceipt;
    try {
      admitted = herdrManagedDb.enqueue(parsed, this.snapshot().configuration);
    } catch { return herdrManagedDb.recordCommand({ ...parsed, state: 'rejected', message: 'Queue admission rejected.' }); }
    if (this.snapshot().queue.paused && !this.#abortFence) herdrManagedDb.resumeQueue(parsed.appSessionId, parsed.ownerGeneration);
    const running = this.#drain();
    if (running && this.snapshot().activeTurnId === parsed.actionId) return running;
    if (running) void running.catch(() => {});
    return admitted;
  }

  #drain(): Promise<HerdrManagedCommandReceipt> | null {
    if (this.#closed || this.#abortFence || !this.#session) return null;
    const state = this.snapshot();
    const next = state.queue.entries[0];
    if (!next) return null;
    const entry = herdrManagedDb.dequeue(state.identity.appSessionId, state.identity.ownerGeneration, next.command.actionId, { providerSessionId: this.#providerSessionId });
    if (!entry) return null;
    const task = this.#run(entry.command);
    this.#turnTasks.add(task);
    void task.then(() => this.#turnTasks.delete(task), () => this.#turnTasks.delete(task));
    return task;
  }

  async #run(parsed: HerdrManagedCommand): Promise<HerdrManagedCommandReceipt> {
    try {
      this.#broadcast();
      const payload = parsed.payload as { text: string; turnOptions?: ManagedChildTurnOptions };
      await this.#session!.prompt(payload.text, parsed.actionId, payload.turnOptions);
      const settled = herdrManagedDb.transitionCommand({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, actionId: parsed.actionId, state: 'settled', message: `${parsed.kind} settled.` });
      herdrManagedDb.finishTurn(parsed.appSessionId, parsed.ownerGeneration, parsed.actionId);
      return settled;
    } catch (error) {
      const abort = this.#abortOutcomes.get(parsed.actionId);
      if (abort) await abort;
      if (this.snapshot().turns[parsed.actionId]?.abortConfirmed === true) {
        const settled = herdrManagedDb.transitionCommand({ ...parsed, state: 'settled', message: 'Turn aborted after SDK confirmation.' });
        herdrManagedDb.finishTurn(parsed.appSessionId, parsed.ownerGeneration, parsed.actionId, { aborted: true });
        return settled;
      }
      herdrManagedDb.setLifecycle(parsed.appSessionId, parsed.ownerGeneration, 'unknown');
      herdrManagedDb.transitionCommand({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, actionId: parsed.actionId, state: 'unknown', message: 'Prompt outcome is unknown.' });
      herdrManagedDb.appendEvent({ appSessionId: parsed.appSessionId, ownerGeneration: parsed.ownerGeneration, kind: 'command.unknown', payload: { actionId: parsed.actionId } });
      throw error;
    } finally {
      this.#broadcast();
      const next = this.#drain();
      if (next) void next.catch(() => {});
    }
  }

  #journalEvent(frame: ManagedChildEvent): void {
    if (frame.generation !== this.#bootstrap.ownerGeneration) throw new Error('SDK event generation mismatch.');
    let event = frame.event;
    if (event.kind === 'managed.automation-record-chunk') { this.#privateStore().putChunk(event, { provider: this.#providerSessionId, turn: frame.runId }); return; }
    if (event.kind === 'managed.automation') {
      const operation = herdrManagedAutomationOperationSchema.parse(event.payload);
      if (operation.identity.turn !== frame.runId || operation.identity.provider !== this.#providerSessionId) throw new Error('Automation owner mismatch.');
      this.#privateStore().verify(operation);
      herdrManagedDb.setAutomation(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, operation);
      const state = this.snapshot();
      if (state.activeTurnId) {
        const operations = Object.values(state.automation).filter(value => value.identity.turn === state.activeTurnId);
        const lifecycle = operations.some(value => value.phase === 'awaiting_reattach_approval') ? 'awaiting_reattach_approval'
          : operations.some(value => value.phase === 'waiting_attachment') ? 'waiting_attachment' : 'running';
        if (state.lifecycle !== lifecycle) herdrManagedDb.setLifecycle(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, lifecycle);
      }
      this.#broadcast();
      return;
    }
    const automationTool = event.toolName === 'browser' || event.toolName === 'computer'
      || (typeof event.toolId === 'string' && this.#session && ['browser', 'computer'].includes(String(this.snapshot().tools[event.toolId]?.input?.toolName)));
    if (automationTool && event.kind === 'tool_use') event = { kind: 'tool_use', toolId: event.toolId, toolName: event.toolName, toolInput: {}, protected: true };
    else if (automationTool && event.kind === 'tool_result') event = { kind: 'tool_result', toolId: event.toolId, content: '[Protected automation result]', isError: event.isError === true, isFinal: event.isFinal !== false };
    else if (automationTool && event.kind === 'permission_request') {
      const context = isObject(event.context) ? event.context : {};
      event = { kind: event.kind, toolName: event.toolName, requestId: event.requestId, input: {}, context: { source: context.source, options: context.options } };
    }
    const secrets = [this.#bootstrap.attachSecret, ...[...this.#operationCapabilities.values()].map(capability => capability.transportToken)]
      .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0);
    if (secrets.length) event = JSON.parse(JSON.stringify(event, (_key, value: unknown) => typeof value === 'string' ? secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value) : value)) as Record<string, unknown>;
    if (event.kind === 'session' && typeof event.providerSessionId === 'string') this.#providerSessionId = event.providerSessionId;
    const context = isObject(event.context) ? event.context : {};
    const requestKind = context.source === 'sdk-permission' ? 'permission' : event.toolName === 'ask' ? 'ask' : null;
    if (!this.#session) {
      if (event.kind === 'permission_request' || event.kind === 'permission_cancelled') throw new Error('SDK request before ready.');
      herdrManagedDb.appendEvent({ appSessionId: this.#bootstrap.appSessionId, ownerGeneration: this.#bootstrap.ownerGeneration, kind: 'sdk.event', payload: event });
      this.#broadcast();
      return;
    }
    // The SDK exposes kinds here, not its private option IDs. These identifiers
    // are journal metadata only; approval IPC carries the normalized decision.
    const options = Array.isArray(context.options) ? context.options
      .filter((kind): kind is string => typeof kind === 'string')
      .map((kind) => ({ optionId: kind, kind })) : undefined;
    herdrManagedDb.appendSdkEvent({
      appSessionId: this.#bootstrap.appSessionId, ownerGeneration: this.#bootstrap.ownerGeneration,
      providerSessionId: this.#providerSessionId, turnId: frame.runId, kind: 'sdk.event', payload: { ...event, turnId: frame.runId, providerSessionId: this.#providerSessionId },
      ...(event.kind === 'permission_request' && typeof event.requestId === 'string' && requestKind ? { request: { requestId: event.requestId, requestKind, schema: event.input, toolName: typeof event.toolName === 'string' ? event.toolName : undefined, options } } : {}),
      ...(event.kind === 'permission_cancelled' && typeof event.requestId === 'string' ? { cancelRequestId: event.requestId } : {}),
    });
    this.#broadcast();
    if (event.kind === 'permission_request') queueMicrotask(() => { void this.#refreshPolicy(); });
  }

  subscribe(listener: (event: HerdrManagedEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #broadcast(): void {
    if (!this.#closed) this.#agentReporter?.update(this.snapshot());
    if (!this.#pumpScheduled && !this.#closed) {
      this.#pumpScheduled = true;
      setImmediate(() => { this.#pumpScheduled = false; this.#pump(); });
    }
    {
      const events = herdrManagedDb.eventsSince(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, this.#broadcastSeq, 256);
      if (!events.length) return;
      for (const event of events) {
        this.#broadcastSeq = event.seq;
        for (const listener of this.#listeners) {
          try { listener(event); } catch { this.#listeners.delete(listener); }
        }
      }
      if (events.length === 256) setImmediate(() => { if (!this.#closed) this.#broadcast(); });
    }
  }

  #pump(): void {
    let more = false;
    for (const [socket, client] of this.#clients) {
      if (client.cursor === null || client.blocked || socket.destroyed) continue;
      let bytes = 0;
      for (const event of herdrManagedDb.eventsSince(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, client.cursor, 256)) {
        const line = `${JSON.stringify({ type: 'event', event })}\n`;
        const size = Buffer.byteLength(line);
        if (size > HERDR_MANAGED_MAX_FRAME_BYTES || event.seq !== client.cursor + 1) { client.cursor = null; this.#send(socket, { type: 'snapshot-required', id: 'live', reason: 'gap' }); break; }
        if (bytes + size > HERDR_MANAGED_MAX_FRAME_BYTES) { more = true; break; }
        bytes += size;
        client.cursor = event.seq;
        if (!this.#send(socket, { type: 'event', event })) { client.blocked = true; break; }
      }
      if (client.cursor !== null && client.cursor < this.snapshot().watermark && !client.blocked) more = true;
    }
    if (more && !this.#closed) this.#broadcast();
  }

  #send(socket: net.Socket, value: unknown): boolean {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > HERDR_MANAGED_MAX_FRAME_BYTES || socket.writableLength + Buffer.byteLength(line) > 2 * HERDR_MANAGED_MAX_FRAME_BYTES) { socket.destroy(); return false; }
    const writable = socket.write(line);
    const client = this.#clients.get(socket);
    if (!writable && client) client.blocked = true;
    return writable;
  }

  async #control(command: HerdrManagedCommand, operation: 'steer' | 'abort'): Promise<HerdrManagedCommandReceipt> {
    const payload = isObject(command.payload) ? command.payload : {};
    const turnId = this.snapshot().activeTurnId;
    if (!turnId || payload.turnId !== turnId) return herdrManagedDb.recordCommand({ ...command, state: 'rejected', message: 'Control turn mismatch.' });
    if (operation === 'abort' && this.#abortOutcomes.has(turnId)) return herdrManagedDb.recordCommand({ ...command, state: 'rejected', message: 'Abort is already pending.' });
    if (!this.#session?.[operation]) return herdrManagedDb.recordCommand({ appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, actionId: command.actionId, kind: command.kind, payloadHash: command.payloadHash, state: 'rejected', message: `${operation} is not supported by this managed SDK owner.` });
    herdrManagedDb.recordCommand({ appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, actionId: command.actionId, kind: command.kind, payloadHash: command.payloadHash, state: 'admitted', message: `${operation} admitted.` });
    herdrManagedDb.transitionCommand({ appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, actionId: command.actionId, state: 'executing', message: `${operation} dispatched.` });
    let ok: boolean;
    let confirmAbort: ((value: boolean) => void) | undefined;
    if (operation === 'abort') {
      this.#abortFence++;
      herdrManagedDb.pauseQueue(command.appSessionId, command.ownerGeneration);
      this.#abortOutcomes.set(turnId, new Promise<boolean>(resolve => { confirmAbort = resolve; }));
    }
    try {
      ok = operation === 'steer'
        ? await this.#session.steer!(String(payload.text ?? ''), command.actionId, turnId)
        : await this.#session.abort!(command.actionId, turnId);
      if (operation === 'abort' && ok) {
        herdrManagedDb.pauseQueue(command.appSessionId, command.ownerGeneration);
        herdrManagedDb.appendEvent({ ...command, kind: 'managed.turn', payload: { turnId, state: { ...this.snapshot().turns[turnId], abortConfirmed: true } } });
      }
      confirmAbort?.(ok);
    } catch {
      return herdrManagedDb.transitionCommand({ ...command, state: 'unknown', message: 'Control outcome unknown.' });
    } finally {
      confirmAbort?.(false);
      if (operation === 'abort') { this.#abortFence--; this.#abortOutcomes.delete(turnId); }
    }
    return herdrManagedDb.transitionCommand({ appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, actionId: command.actionId, state: ok ? 'settled' : 'unknown', message: ok ? `${operation} settled.` : 'Control outcome unknown.' });
  }

  async #decision(command: HerdrManagedCommand): Promise<HerdrManagedCommandReceipt> {
    if (!this.#session?.resolveApproval || !this.#session.validateApproval) return herdrManagedDb.recordCommand({ appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, actionId: command.actionId, kind: command.kind, payloadHash: command.payloadHash, state: 'rejected', message: 'Decision resolution is not supported by this managed SDK owner.' });
    const payload = isObject(command.payload) ? command.payload : {};
    let requestId = typeof payload.requestId === 'string' ? payload.requestId : '';
    let providerSessionId = payload.providerSessionId;
    let turnId = payload.turnId;
    const parts = requestId.split('/');
    if (parts.length === 5 && parts[0] === command.appSessionId && parts[1] === command.ownerGeneration) {
      [, , providerSessionId, turnId, requestId] = parts;
    }
    const reject = () => herdrManagedDb.recordCommand({ ...command, state: 'rejected' as const, message: 'Decision target invalid or stale.' });
    if (typeof providerSessionId !== 'string' || typeof turnId !== 'string' || turnId !== this.snapshot().activeTurnId) return reject();
    const identity = { appSessionId: command.appSessionId, ownerGeneration: command.ownerGeneration, providerSessionId, turnId, requestId };
    const pending = herdrManagedDb.getPending(identity);
    if (!pending || pending.requestKind !== (command.kind === 'answer' ? 'ask' : 'permission')) return reject();
    const decision = payload.decision;
    const resolution = command.kind === 'answer'
      ? { allow: typeof payload.allow === 'boolean' ? payload.allow : true, ...(typeof payload.answer === 'string' ? { message: payload.answer } : typeof payload.message === 'string' ? { message: payload.message } : {}), ...(payload.updatedInput !== undefined ? { updatedInput: payload.updatedInput } : {}) }
      : typeof payload.allow === 'boolean' ? { allow: payload.allow, always: payload.always === true }
      : decision === 'allow-once' ? { allow: true, always: false }
      : decision === 'allow-always' ? { allow: true, always: true }
      : decision === 'deny-once' ? { allow: false, always: false }
      : decision === 'deny-remaining' ? { allow: false, always: true } : null;
    if (!resolution || (payload.policyRevision !== undefined && payload.policyRevision !== pending.policyRevision)) return reject();
    try {
      if (!await this.#session.validateApproval(pending.sdkRequestId!, resolution, command.actionId, turnId)) return reject();
    } catch { return reject(); }
    if (turnId !== this.snapshot().activeTurnId) return reject();
    const won = herdrManagedDb.decideRequest({ ...identity, actionId: command.actionId, policyRevision: pending.policyRevision, resolution });
    if (!won) return reject();
    herdrManagedDb.recordCommand({ ...command, state: 'executing', message: 'Decision dispatched.' });
    this.#broadcast();
    let accepted = false;
    try { accepted = await this.#session.resolveApproval(pending.sdkRequestId!, resolution, command.actionId, turnId); } catch {
      // Lost child acknowledgement is not a decision success; persist unknown below.
    }
    herdrManagedDb.settleDecision({ ...identity, actionId: command.actionId, accepted });
    return herdrManagedDb.transitionCommand({ ...command, state: accepted ? 'settled' : 'unknown', message: accepted ? 'Decision settled.' : 'Decision outcome unknown.' });
  }

  #privateStore(): ManagedAutomationStore {
    return this.#store ??= new ManagedAutomationStore(this.#bootstrap.sessionRoot, this.#bootstrap.ownerGeneration);
  }

  async #refreshPolicy(): Promise<void> {
    if (this.#policyChecking || this.#closed || !this.#session) return;
    this.#policyChecking = true;
    try {
      if (['unknown', 'interrupted', 'closed'].includes(this.snapshot().lifecycle)) return;
      herdrManagedDb.renewPendingPermissions(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration);
      const policy = herdrManagedDb.currentPolicy(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration);
      for (const request of Object.values(this.snapshot().requests)) {
        if (request.kind !== 'permission' || request.turnId !== this.snapshot().activeTurnId) continue;
        const identity = { appSessionId: request.appSessionId, ownerGeneration: request.generation, providerSessionId: request.providerSessionId, turnId: request.turnId, requestId: request.requestId };
        const pending = herdrManagedDb.getPending(identity);
        if (!pending?.toolName || !pending.sdkRequestId || !gjcAutoApprovalReason(policy.permissions, pending.toolName) || !this.#session.validateApproval || !this.#session.resolveApproval) continue;
        const actionId = crypto.randomUUID();
        if (!await this.#session.validateApproval(pending.sdkRequestId, { allow: true }, actionId, request.turnId)) continue;
        if (request.turnId !== this.snapshot().activeTurnId) continue;
        const won = herdrManagedDb.decideByPolicy({ ...identity, actionId });
        if (!won) continue;
        let accepted = false;
        try { accepted = await this.#session.resolveApproval(pending.sdkRequestId, { allow: true }, actionId, request.turnId); } catch {
          // Keep the durable winner but mark its unconfirmed callback outcome unknown.
        }
        herdrManagedDb.settleDecision({ ...identity, actionId, accepted });
      }
    } catch {
      // A failed preflight cannot grant permission; the durable request remains visible.
    } finally { this.#policyChecking = false; this.#broadcast(); }
  }

  resolveResume(fullIdentity: string, capability: string, decision: 'approve' | 'deny'): Record<string, unknown> | null {
    const operation = Object.values(this.snapshot().automation).find(op =>
      [this.#bootstrap.appSessionId, op.identity.generation, op.identity.provider, op.identity.turn, op.approvalRequestId].join('/') === fullIdentity);
    if (!operation || operation.phase !== 'awaiting_reattach_approval' || operation.capabilityGeneration !== capability) return null;
    return { identity: operation.identity, capabilityGeneration: capability, approvalRequestId: operation.approvalRequestId, decision };
  }

  async #resume(command: HerdrManagedCommand): Promise<HerdrManagedCommandReceipt> {
    await this.#capabilityControls;
    const payload = isObject(command.payload) ? command.payload : {};
    const identity = isObject(payload.identity) ? payload.identity : {};
    const operation = this.snapshot().automation[String(identity.operationId)];
    const reject = () => herdrManagedDb.recordCommand({ ...command, state: 'rejected' as const, message: 'Resume target invalid or stale.' });
    if (!operation || operation.phase !== 'awaiting_reattach_approval' || automationCanonical(operation.identity) !== automationCanonical(identity) || payload.approvalRequestId !== operation.approvalRequestId || payload.capabilityGeneration !== operation.capabilityGeneration || operation.identity.policyRevision !== herdrManagedDb.currentPolicy(command.appSessionId, command.ownerGeneration).revision) return reject();
    if (payload.decision === 'deny') return herdrManagedDb.recordCommand({ ...command, state: 'settled', message: 'Resume denied; operation remains waiting.' });
    const capability = this.#operationCapabilities.get(operation.identity.operationId);
    if (payload.decision !== 'approve' || !capability || !this.#session?.automationControl || capability.capabilityGeneration !== operation.capabilityGeneration) return reject();
    herdrManagedDb.recordCommand({ ...command, state: 'executing', message: 'Resume dispatched.' });
    let accepted = false;
    try { accepted = await this.#session.automationControl({ type: 'resume-approved', actionId: command.actionId, identity: operation.identity, capabilityGeneration: operation.capabilityGeneration!, approvalRequestId: operation.approvalRequestId! }); } catch {
      // A possibly dispatched automation operation must not be retried or called settled.
    }
    return herdrManagedDb.transitionCommand({ ...command, state: accepted ? 'settled' : 'unknown', message: accepted ? 'Resume accepted.' : 'Resume outcome unknown.' });
  }

  #automationControl(control: HerdrManagedAutomationControl, connectionId: string): Promise<boolean> {
    const result = this.#capabilityControls.then(() => this.#applyAutomationControl(control, connectionId));
    this.#capabilityControls = result.catch(() => {});
    return result;
  }

  async #applyAutomationControl(control: HerdrManagedAutomationControl, connectionId: string): Promise<boolean> {
    if (!this.#session?.automationControl) return false;
    const connected = () => [...this.#clients.entries()].some(([socket, client]) => client.connectionId === connectionId && !socket.destroyed);
    if (control.type === 'bind-capability' || control.type === 'reconcile') {
      if (!connected() || (this.#capability && this.#capability.ownerConnectionId !== connectionId)) return false;
      const operation = this.snapshot().automation[control.identity.operationId];
      if (!operation || automationCanonical(operation.identity) !== automationCanonical(control.identity)) return false;
      const store = this.#privateStore();
      store.verify(operation);
      const record = store.read(operation.argumentsRef, operation.identity.operationId);
      const transport = { ...control.currentTransport, ownerConnectionId: connectionId };
      const bridgeTransport = { socketPath: transport.transportLocator, token: transport.transportToken };
      if (control.type === 'reconcile') {
        if (operation.phase !== 'outcome_unknown' || !record.attempt || record.attempt.originalCapabilityGeneration !== control.originalCapabilityGeneration) return false;
        let receipt = verifyManagedBridgeReceipt(await managedBridgeRequest(bridgeTransport, { type: 'managed-lookup', attempt: record.attempt }), record.attempt);
        // The ledger atomically fences absence; an existing reservation stays unknown.
        const fenceKey = automationCanonical(record.attempt);
        if (receipt.status === 'unknown' && !this.#fenceQueries.has(fenceKey)) {
          receipt = verifyManagedBridgeReceipt(await managedBridgeRequest(bridgeTransport, { type: 'managed-fence', attempt: record.attempt }), record.attempt);
          this.#fenceQueries.add(fenceKey);
        }
        if (!connected()) return false;
        if (receipt.status === 'unknown') return true;
        store.persist({ ...record, receipt, evidence: { verifier: 'managed-bridge-ledger-v1', observedAt: new Date().toISOString(), content: receipt },
          ...(receipt.status === 'completed' ? { result: receipt.response.ok ? receipt.response.result : { error: receipt.response.error } } : {}) });
        return this.#session.automationControl({ type: 'reconcile-verified', actionId: control.actionId, identity: operation.identity, receipt });
      }
      if (!['waiting_attachment', 'awaiting_reattach_approval'].includes(operation.phase)) return false;
      const policyRevision = herdrManagedDb.currentPolicy(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration).revision;
      const sourceOperationId = record.sourceOperationId ?? operation.identity.operationId;
      const request: HerdrManagedBridgeResolveRequest = { type: 'managed-resolve-target', requestId: crypto.randomUUID(), identity: { ...operation.identity, policyRevision }, sourceOperationId, bridgeInstanceId: transport.bridgeInstanceId, invocation: record.arguments };
      const target = await verifyManagedBridgeTarget(await managedBridgeRequest(bridgeTransport, request), request);
      if (!connected() || herdrManagedDb.currentPolicy(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration).revision !== policyRevision
        || automationCanonical(this.snapshot().automation[operation.identity.operationId]) !== automationCanonical(operation)) return false;
      const targetContext = automationCanonical(target.targetBinding);
      const existing = this.#operationCapabilities.get(operation.identity.operationId);
      if (existing && existing.ownerConnectionId === connectionId && existing.operationIdentity.operationId === operation.identity.operationId && existing.policyRevision === policyRevision && existing.bridgeInstanceId === transport.bridgeInstanceId && existing.transportLocator === transport.transportLocator && existing.transportToken === transport.transportToken && automationCanonical(existing.targetBinding) === targetContext) return true;
      const operationIdentity = { ...operation.identity, targetContext, policyRevision, ...(targetContext !== operation.identity.targetContext || policyRevision !== operation.identity.policyRevision ? { operationId: crypto.randomUUID() } : {}) };
      const capability: HerdrManagedCapability = { ...transport, generation: operation.identity.generation, capabilityGeneration: crypto.randomUUID(), targetContext, policyRevision, operationIdentity, sourceOperationId, targetBinding: target.targetBinding };
      this.#privateStore().capability(capability);
      this.#capability = capability;
      this.#operationCapabilities.set(operationIdentity.operationId, capability);
      const accepted = await this.#session.automationControl({ type: 'attach-capability', actionId: control.actionId, capability });
      if (!accepted) {
        this.#operationCapabilities.delete(operationIdentity.operationId);
        if (this.#capability === capability) { this.#capability = null; this.#privateStore().capability(null); }
      }
      return accepted;
    }
    if (control.type === 'detach-capability') {
      const capability = [...this.#operationCapabilities.values()].find(value => value.ownerConnectionId === connectionId && value.capabilityGeneration === control.capabilityGeneration);
      if (!capability) return false;
      this.#operationCapabilities.delete(capability.operationIdentity.operationId);
      this.#privateStore().capability(null);
      if (this.#capability === capability) this.#capability = [...this.#operationCapabilities.values()].at(-1) ?? null;
      return this.#session.automationControl({ ...control, ownerConnectionId: connectionId });
    }
    // Approval is a host ledger command, never a caller-supplied control. External
    // evidence needs a trusted verifier; a claimed reference alone is not proof.
    return false;
  }

  #handleAttach(socket: net.Socket): void {
    if (this.#connections.size >= 128) { socket.destroy(); return; }
    this.#connections.add(socket);
    const client = { connectionId: crypto.randomUUID(), cursor: null as number | null, snapshotId: null as string | null, blocked: false };
    let authed = false;
    let buffer = '';
    let inflight = 0;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 262_144) { socket.destroy(); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (++inflight > 128) { socket.destroy(); return; }
        void (async () => {
          const frame = herdrManagedAttachFrameSchema.parse(JSON.parse(line) as unknown);
          if (frame.type === 'hello') {
            if (frame.value.appSessionId !== this.#bootstrap.appSessionId || frame.value.ownerGeneration !== this.#bootstrap.ownerGeneration || frame.value.attachSecret !== this.#bootstrap.attachSecret) {
              socket.write(`${JSON.stringify({ type: 'error', id: frame.id, message: 'unauthorized' })}\n`);
              socket.end();
              return;
            }
            authed = true;
            this.#clients.set(socket, client);
            client.cursor = null;
            const snapshot = herdrManagedSnapshotsDb.create(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration);
            client.snapshotId = snapshot.snapshotId;
            this.#send(socket, { type: 'ready', id: frame.id, snapshot });
            return;
          }
          if (!authed) {
            socket.end(`${JSON.stringify({ type: 'error', id: frame.id, message: 'unauthorized' })}\n`);
            return;
          }
          try {
            const { appSessionId, ownerGeneration } = this.#bootstrap;
            if (frame.type === 'command') this.#send(socket, { type: 'receipt', id: frame.id, receipt: await this.dispatch(frame.value) });
            else if (frame.type === 'snapshot') {
              client.cursor = null;
              const snapshot = herdrManagedSnapshotsDb.create(appSessionId, ownerGeneration);
              client.snapshotId = snapshot.snapshotId;
              this.#send(socket, { type: 'ready', id: frame.id, snapshot });
            } else if (frame.type === 'snapshot-page') {
              if (frame.snapshotId !== client.snapshotId) throw new Error('Snapshot connection mismatch.');
              this.#send(socket, herdrManagedSnapshotsDb.page(appSessionId, ownerGeneration, frame.snapshotId, frame.page, frame.id));
            } else if (frame.type === 'replay') this.#send(socket, herdrManagedSnapshotsDb.replayPage(appSessionId, ownerGeneration, frame.afterSeq, frame.watermark, frame.id));
            else if (frame.type === 'subscribe') {
              if (frame.watermark > this.snapshot().watermark) throw new Error('Invalid cursor.');
              client.cursor = frame.watermark;
              this.#send(socket, { type: 'subscribed', id: frame.id, watermark: frame.watermark });
              this.#broadcast();
            } else if (frame.type === 'automation-control') this.#send(socket, { type: 'automation-control', id: frame.id, accepted: await this.#automationControl(frame.control, client.connectionId) });
          } catch { socket.write(`${JSON.stringify({ type: 'error', id: frame.id, message: 'command rejected' })}\n`); }
        })().catch(() => socket.destroy()).finally(() => { inflight--; });
      }
    });
    socket.on('drain', () => { client.blocked = false; this.#broadcast(); });
    socket.on('close', () => {
      this.#clients.delete(socket); this.#connections.delete(socket);
      for (const capability of this.#operationCapabilities.values()) {
        if (capability.ownerConnectionId === client.connectionId && !this.#closed) void this.#automationControl({ type: 'detach-capability', actionId: crypto.randomUUID(), generation: capability.generation, capabilityGeneration: capability.capabilityGeneration, ownerConnectionId: client.connectionId }, client.connectionId).catch(() => {});
      }
    });
    socket.on('error', () => socket.destroy());
  }

  snapshot() {
    return herdrManagedDb.snapshot(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration);
  }

  close(): Promise<void> {
    return this.#closeTask ??= this.#close();
  }

  registerCloseResource(dispose: () => void): () => void {
    if (this.#closed) dispose();
    else this.#closeResources.add(dispose);
    return () => { this.#closeResources.delete(dispose); };
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const dispose of this.#closeResources) {
      try { dispose(); } catch { /* Resource cleanup cannot replace the owner close result. */ }
    }
    this.#closeResources.clear();
    if (this.#policyTimer) clearInterval(this.#policyTimer);
    await this.#agentReporter?.quiesce();
    for (const client of this.#connections) client.destroy();
    await new Promise<void>((resolve) => this.#attachServer?.close(() => resolve()) ?? resolve());
    await this.#capabilityControls;
    await this.#session?.dispose?.();
    await Promise.allSettled([...this.#turnTasks, ...[...this.#dispatching.values()].map(value => value.result)]);
    this.#store?.capability(null);
    this.#store?.close();
    herdrManagedDb.setLifecycle(this.#bootstrap.appSessionId, this.#bootstrap.ownerGeneration, 'closed');
    // Native writer and private child closure are confirmed before releasing
    // only this generation's source. A replaced/missing pane is never touched.
    await this.#agentReporter?.release();
  }
}

export function commandHash(payload: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export async function readBootstrap(file: string): Promise<HerdrTaskHostBootstrap> {
  const resolved = path.resolve(file);
  const parent = path.dirname(resolved);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid())) throw new Error('Unsafe managed bootstrap directory.');
  const stat = await fs.lstat(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw new Error('Managed Herdr bootstrap is not a bounded file.');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Managed Herdr bootstrap owner mismatch.');
  if ((stat.mode & 0o077) !== 0) throw new Error('Managed Herdr bootstrap must be owner-only.');
  const parsed: unknown = JSON.parse(await fs.readFile(resolved, 'utf8'));
  const keys = ['appSessionId', 'ownerGeneration', 'herdrInstanceId', 'projectPath', 'sessionRoot', 'agentDir', 'runConfig', 'attachSocketPath', 'attachSecret', 'databasePath', 'claimNonce'];
  if (!isObject(parsed) || Object.keys(parsed).some(key => !keys.includes(key))
    || ['appSessionId', 'ownerGeneration', 'herdrInstanceId', 'projectPath', 'sessionRoot'].some(key => typeof parsed[key] !== 'string' || !parsed[key])) throw new Error('Managed Herdr bootstrap is incomplete.');
  for (const key of ['projectPath', 'sessionRoot', 'databasePath', 'agentDir', 'attachSocketPath']) {
    if (parsed[key] !== undefined && (typeof parsed[key] !== 'string' || !path.isAbsolute(parsed[key] as string))) throw new Error('Managed bootstrap requires absolute paths.');
  }
  if (parsed.databasePath !== undefined) {
    if (typeof parsed.claimNonce !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.claimNonce)
      || typeof parsed.attachSecret !== 'string' || !/^[a-f0-9]{64}$/.test(parsed.attachSecret)
      || !isObject(parsed.runConfig) || parsed.runConfig.cwd !== parsed.projectPath || parsed.runConfig.sessionRoot !== parsed.sessionRoot
      || !isObject(parsed.runConfig.credential) || parsed.runConfig.credential.kind !== 'stored') throw new Error('Invalid managed production bootstrap.');
    const project = await fs.realpath(parsed.projectPath as string);
    const canonicalParent = await fs.realpath(parent);
    const relative = path.relative(project, canonicalParent);
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) throw new Error('Managed bootstrap must stay outside the project.');
  }
  return parsed as HerdrTaskHostBootstrap;
}

export function createManagedGjcSdkSessionFactory(bootstrap: HerdrTaskHostBootstrap): ManagedSdkSessionFactory {
  return async ({ appSessionId, ownerGeneration, onEvent }) => {
    if (!bootstrap.agentDir || !bootstrap.runConfig) throw new Error('Managed Herdr bootstrap is missing installed SDK configuration.');
    const compiled = !import.meta.url.endsWith('.ts');
    const bunPath = fileURLToPath(new URL(compiled ? '../../dist-native/bun' : '../dist-native/bun', import.meta.url));
    const childPath = fileURLToPath(new URL(compiled ? './gjc-herdr-managed-child.js' : './gjc-herdr-managed-child.ts', import.meta.url));
    const child = spawn(bunPath, [childPath], { stdio: ['pipe', 'pipe', 'pipe'], env: managedChildEnvironment(process.env) });
    return initializeManagedChildSession(child, { appSessionId, ownerGeneration, onEvent, agentDir: bootstrap.agentDir, runConfig: bootstrap.runConfig });
  };
}

/** Stored credentials are resolved privately by the SDK, never inherited from a terminal. */
export function managedChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['HOME', 'PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'USER', 'LOGNAME', 'SYSTEMROOT', 'WINDIR']) {
    if (source[name] !== undefined) result[name] = source[name];
  }
  return result;
}

/** Import-only seam: production owns the pinned launcher; tests own their child. */
export async function initializeManagedChildSession(child: ChildProcessWithoutNullStreams, input: {
  appSessionId: string;
  ownerGeneration: string;
  agentDir: string;
  runConfig: SdkRunConfig;
  onEvent: (event: ManagedChildEvent) => void | Promise<void>;
}): Promise<ManagedSdkSession> {
    const { appSessionId, ownerGeneration, onEvent } = input;
    const transport = new ManagedChildTransport(child, ownerGeneration, onEvent);
    const identity = (requestId: string, runId: string) => ({ version: 1 as const, generation: ownerGeneration, requestId, runId });
    const ready = await transport.request({ ...identity('init', 'init'), type: 'init', agentDir: input.agentDir, appSessionId, runConfig: input.runConfig as unknown as Record<string, unknown> });
    if (!ready.ok || !ready.providerSessionId) { child.kill(); throw new Error('Managed Herdr child did not initialize.'); }
    const call = async (request: ManagedChildRequest) => (await transport.request(request)).ok;
    return {
      providerSessionId: ready.providerSessionId,
      async prompt(message, actionId, turnOptions) {
        if (!await call({ ...identity(commandHash(['action', actionId]), actionId), type: 'prompt', actionId, text: message, ...(turnOptions ? { turnOptions } : {}) })) throw new Error('Managed child prompt failed.');
      },
      steer: (text, actionId, runId) => call({ ...identity(commandHash(['action', actionId]), runId), type: 'steer', actionId, text }),
      abort: (actionId, runId) => call({ ...identity(commandHash(['action', actionId]), runId), type: 'abort', actionId }),
      validateApproval: (askId, decision, actionId, runId) => {
        const validationId = `validate:${commandHash(actionId)}`;
        return call({ ...identity(validationId, runId), type: 'validate-approval', actionId: validationId, askId, decision });
      },
      resolveApproval: (askId, decision, actionId, runId) => call({ ...identity(commandHash(['action', actionId]), runId), type: 'approval', actionId, askId, decision }),
      automationControl: control => call({ ...identity(commandHash(['automation', control.actionId]), 'automation'), type: 'automation-control', control }),
      async operationStatus(operationId) {
        const actionId = crypto.randomUUID();
        const response = await transport.request({ ...identity(actionId, 'automation'), type: 'operation-status', actionId, operationId });
        if (!response.ok || response.operationId !== operationId || !response.operationState) throw new Error('Managed child operation status rejected.');
        return response.operationState;
      },
      async dispose() {
        await transport.close({ ...identity('close', 'close'), type: 'close', actionId: 'owner:close' });
      },
    };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function runHerdrTaskHostStdio(options: { bootstrap: HerdrTaskHostBootstrap; createSession?: ManagedSdkSessionFactory; input?: NodeJS.ReadableStream & { setEncoding?: (encoding: BufferEncoding) => void }; output?: NodeJS.WritableStream; error?: NodeJS.WritableStream }): Promise<HerdrTaskHost> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const terminal = acquireConsoleTerminal(input, output);
  const host = new HerdrTaskHost({ bootstrap: options.bootstrap, createSession: options.createSession ?? createManagedGjcSdkSessionFactory(options.bootstrap) });
  host.registerCloseResource(terminal.restore);
  let hello: Awaited<ReturnType<HerdrTaskHost['initialize']>>;
  try {
    hello = await host.initialize();
    if (options.bootstrap.attachSocketPath && options.bootstrap.attachSecret) await host.startPrivateAttachServer();
  } catch (error) { terminal.restore(); throw error; }
  const decoder = new ConsoleInputDecoder();
  let detached = false;
  const writer = new ConsoleOutputWriter(output as Writable, () => { detach(); });
  const secrets = [options.bootstrap.attachSecret ?? ''];
  writer.write('READY', 'critical');
  if (terminal.active) writer.write('Input is not echoed; Ctrl-C or Escape cancels the draft. Ctrl-D does not close the owner.');
  const unsubscribe = host.subscribe((event) => {
    if (event.kind === 'managed.request' && isObject(event.payload)) {
      const request = host.snapshot().requests[String(event.payload.requestId)];
      if (!request || request.scope.status !== 'pending' || request.kind === 'automation') return;
      const questions = Array.isArray(request.schema.questions) ? request.schema.questions : [];
      const question = isObject(questions[0]) ? questions[0] : {};
      const options = Array.isArray(question.options) ? question.options : [];
      writer.write(renderRequest({
        identity: [hello.appSessionId, hello.ownerGeneration, request.providerSessionId, request.turnId, request.requestId].join('/'),
        kind: request.kind, policyRevision: request.policyRevision, schema: request.schema,
        question: typeof question.question === 'string' ? question.question : typeof request.scope.toolName === 'string' ? request.scope.toolName : '',
        options: options.filter(isObject).map((option, index) => ({ id: String(index), label: String(option.label ?? '') })),
      }, secrets), 'critical');
    } else if (event.kind === 'managed.automation' && isObject(event.payload)) {
      const operation = herdrManagedAutomationOperationSchema.parse(event.payload);
      if (operation.phase === 'awaiting_reattach_approval') writer.write(renderRequest({
        identity: [hello.appSessionId, hello.ownerGeneration, operation.identity.provider, operation.identity.turn, operation.approvalRequestId].join('/'),
        kind: 'resume', policyRevision: operation.identity.policyRevision,
        question: `Resume ${publicManagedTargetContext(operation.identity.targetContext)}; capability ${operation.capabilityGeneration}`,
      }, secrets), 'critical');
    } else if (event.kind === 'sdk.event' && isObject(event.payload) && event.payload.kind === 'stream_end' && typeof event.payload.content === 'string') {
      const display = renderEvent({ kind: 'conversation', text: event.payload.content }, secrets);
      if (display) writer.write(display);
    }
  });
  function onData(chunk: Buffer | string) {
    if (!(chunk instanceof Uint8Array)) { writer.write(renderConsoleReject(null, 'byte_input_required'), 'critical'); return; }
    for (const event of decoder.feed(chunk)) {
      if (event.type === 'reject') { writer.write(renderConsoleReject(null, event.reason), 'critical'); continue; }
      void (async () => {
        const parsed = parseConsoleLine(event.line, { appSessionId: hello.appSessionId, ownerGeneration: hello.ownerGeneration, stateRevision: host.snapshot().watermark, resolveResume: (identity, capability, decision) => host.resolveResume(identity, capability, decision) });
        if (!parsed.ok) {
          writer.write(renderConsoleReject(null, parsed.message), 'critical');
          return;
        }
        if (parsed.type === 'query') {
          if (parsed.query === 'status') {
            writer.write(`STATUS ${host.snapshot().lifecycle} ${host.snapshot().watermark}`, 'critical');
            if (terminal.active && host.agentPublication) writer.write(`HERDR_PUBLICATION ${host.agentPublication.status} ${host.agentPublication.seq}`, 'critical');
          }
          else if (parsed.query === 'help') writer.write('COMMANDS prompt followup steer abort answer permission resume status ack', 'critical');
          else {
            const receipt = herdrManagedDb.getCommand(hello.appSessionId, hello.ownerGeneration, parsed.actionId!);
            writer.write(receipt ? renderConsoleReceipt(receipt.actionId, receipt.state, receipt.seq) : renderConsoleReject(parsed.actionId!, 'receipt_not_found'), 'critical');
          }
          return;
        }
        const receipt = await host.dispatch(parsed.command);
        writer.write(renderConsoleReceipt(receipt.actionId, receipt.state, receipt.seq), 'critical');
      })().catch(() => {
        writer.write(renderConsoleReject(null, 'command_rejected'), 'critical');
      });
    }
  }
  function detach() {
    if (detached) return;
    detached = true;
    input.off('data', onData); input.off('end', detach); input.off('error', detach); input.off('close', detach);
    terminal.restore();
    for (const event of decoder.end()) if (event.type === 'reject') writer.write(renderConsoleReject(null, event.reason), 'critical');
  }
  if (!detached) {
    input.on('data', onData);
    input.once('end', detach); input.once('error', detach); input.once('close', detach);
  }
  host.registerCloseResource(() => { detach(); unsubscribe(); writer.close(); });
  return host;
}

/** Shared with import-only fixtures so signals exercise production shutdown. */
export function installHerdrTaskHostShutdown(host: HerdrTaskHost): () => void {
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    // This signal targets the independent owner, not an App viewer. Mark closed
    // only after the private child confirms disposal and actually exits.
    const deadline = setTimeout(() => process.exit(1), 15_000);
    void host.close().then(() => {
      clearTimeout(deadline);
      closeConnection();
      process.exit(0);
    }, () => {
      clearTimeout(deadline);
      process.stderr.write('ERROR managed owner shutdown unconfirmed\n');
      process.exit(1);
    });
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.once('SIGHUP', stop);
  return () => {
    process.off('SIGTERM', stop); process.off('SIGINT', stop); process.off('SIGHUP', stop);
  };
}

async function main() {
  const bootstrapPath = process.argv[2];
  if (!bootstrapPath) throw new Error('Usage: gjc-herdr-task-host <bootstrap.json>');
  const bootstrap = await readBootstrap(bootstrapPath);
  if (!bootstrap.databasePath || !bootstrap.claimNonce || !bootstrap.runConfig || !bootstrap.agentDir || !bootstrap.attachSocketPath || !bootstrap.attachSecret) throw new Error('Incomplete managed production bootstrap.');
  process.env.DATABASE_PATH = bootstrap.databasePath;
  const host = await runHerdrTaskHostStdio({ bootstrap });
  installHerdrTaskHostShutdown(host);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  void main().catch(() => {
    process.stderr.write('ERROR managed host failed\n');
    process.exitCode = 1;
  });
}
