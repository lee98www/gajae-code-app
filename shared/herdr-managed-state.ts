import { z } from 'zod';

import {
  HERDR_MANAGED_STATE_VERSION, HERDR_MANAGED_PROTOCOL_VERSION, HERDR_MANAGED_MAX_QUEUE_BYTES,
  HERDR_MANAGED_MAX_QUEUE_COMMANDS, herdrManagedIdentitySchema, herdrManagedLifecycleSchema,
  herdrManagedCommandSchema, herdrManagedCommandReceiptSchema, herdrManagedAutomationOperationSchema,
  managedJsonBytes, type HerdrManagedEvent, type HerdrManagedIdentity, type HerdrManagedSnapshotDescriptor,
} from './herdr-managed-protocol.js';

const data = z.record(z.string(), z.unknown());
const request = z.object({
  requestId: z.string().min(1), generation: z.string().min(1), appSessionId: z.string().min(1),
  providerSessionId: z.string().min(1), turnId: z.string().min(1), kind: z.enum(['ask', 'permission', 'automation']),
  policyRevision: z.number().int().nonnegative(), scope: data, schema: data, createdAt: z.string().min(1),
}).strict();
export const herdrManagedQueueEntrySchema = z.object({
  command: herdrManagedCommandSchema, admittedSeq: z.number().int().positive(),
  inputBytes: z.number().int().nonnegative(), configuration: data.nullable(),
}).strict();
export type HerdrManagedQueueEntry = z.infer<typeof herdrManagedQueueEntrySchema>;
export const herdrManagedStateSchema = z.object({
  schemaVersion: z.literal(HERDR_MANAGED_STATE_VERSION), protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  identity: herdrManagedIdentitySchema, watermark: z.number().int().nonnegative(),
  lifecycle: herdrManagedLifecycleSchema, providerSessionId: z.string().nullable(), title: z.string().nullable(),
  activeTurnId: z.string().nullable(), turns: z.record(z.string(), data),
  messages: z.array(z.object({ id: z.string(), turnId: z.string().nullable(), content: z.string(), reasoning: z.array(z.string()), final: z.boolean(), metadata: data }).strict()),
  tools: z.record(z.string(), z.object({ input: data.nullable(), partial: data.nullable(), final: data.nullable() }).strict()),
  usage: data.nullable(), configuration: data.nullable(), status: data.nullable(),
  requests: z.record(z.string(), request), commands: z.record(z.string(), herdrManagedCommandReceiptSchema),
  queue: z.object({ paused: z.boolean(), entries: z.array(herdrManagedQueueEntrySchema).max(HERDR_MANAGED_MAX_QUEUE_COMMANDS), bytes: z.number().int().nonnegative().max(HERDR_MANAGED_MAX_QUEUE_BYTES) }).strict(),
  automation: z.record(z.string(), herdrManagedAutomationOperationSchema),
  transcriptPages: z.array(z.string()),
  // Unrecognized authoritative events remain complete rather than silently disappearing.
  extensions: z.array(z.object({ seq: z.number().int().positive(), kind: z.string(), payload: z.unknown() }).strict()),
}).strict();
export type HerdrManagedState = z.infer<typeof herdrManagedStateSchema>;
export type HerdrManagedPendingRequest = z.infer<typeof request>;
export type HerdrManagedStateMutation =
  | { kind: 'managed.session'; payload: Partial<Pick<HerdrManagedState, 'lifecycle' | 'providerSessionId' | 'title' | 'activeTurnId' | 'usage' | 'configuration' | 'transcriptPages'>> }
  | { kind: 'managed.turn'; payload: { turnId: string; state: Record<string, unknown> } }
  | { kind: 'managed.request'; payload: HerdrManagedPendingRequest }
  | { kind: 'managed.request-resolved'; payload: { requestId: string } }
  | { kind: 'managed.command'; payload: HerdrManagedState['commands'][string] }
  | { kind: 'managed.queue'; payload: { action: 'enqueue'; entry: HerdrManagedQueueEntry } | { action: 'dequeue'; actionId: string } | { action: 'pause' | 'resume' } }
  | { kind: 'managed.automation'; payload: HerdrManagedState['automation'][string] };

export function createHerdrManagedState(identity: HerdrManagedIdentity): HerdrManagedState {
  return herdrManagedStateSchema.parse({ schemaVersion: 1, protocolVersion: 1, identity, watermark: 0,
    lifecycle: 'reserved', providerSessionId: null, title: null, activeTurnId: null, turns: {}, messages: [], tools: {},
    usage: null, configuration: null, status: null, requests: {}, commands: {}, queue: { paused: false, entries: [], bytes: 0 },
    automation: {}, transcriptPages: [], extensions: [] });
}

/** Call in the same transaction as journal/ledger writes. No dispatch, clocks or IO. */
export function applyHerdrManagedEvent(state: HerdrManagedState, event: HerdrManagedEvent): HerdrManagedState {
  if (event.appSessionId !== state.identity.appSessionId || event.ownerGeneration !== state.identity.ownerGeneration) throw new Error('Managed identity mismatch.');
  if (event.seq <= state.watermark) return state;
  if (event.seq !== state.watermark + 1) throw new Error('Managed sequence gap; request same-owner snapshot.');
  // Storage and attached clients reduce the same authoritative wire envelope.
  // Preserve its sequence while normalizing the SDK's nested event exactly once.
  if (event.kind === 'sdk.event' && event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)) {
    const sdk = event.payload as Record<string, unknown>;
    if (typeof sdk.kind === 'string' && sdk.kind !== 'sdk.event') {
      event = { ...event, kind: sdk.kind, payload: Object.prototype.hasOwnProperty.call(sdk, 'payload') ? sdk.payload : sdk };
    }
  }
  const next = structuredClone(state);
  const p = event.payload !== null && typeof event.payload === 'object' && !Array.isArray(event.payload)
    ? data.parse(event.payload) : {};
  const key = (name: string) => z.string().min(1).parse(p[name]);
  switch (event.kind) {
    case 'managed.session': {
      const patch = herdrManagedStateSchema.pick({ lifecycle: true, providerSessionId: true, title: true, activeTurnId: true, usage: true, configuration: true, transcriptPages: true }).partial().parse(p);
      Object.assign(next, patch); break;
    }
    case 'managed.turn': next.turns[key('turnId')] = data.parse(p.state); break;
    case 'session_title': next.title = key('title'); break;
    case 'model':
      next.configuration = { ...(next.configuration ?? {}), modelId: key('modelId') };
      break;
    case 'managed.request': {
      const value = request.parse(p);
      if (value.generation !== state.identity.ownerGeneration || value.appSessionId !== state.identity.appSessionId || value.providerSessionId !== state.providerSessionId) throw new Error('Managed request identity mismatch.');
      next.requests[value.requestId] = value; break;
    }
    case 'managed.request-resolved': delete next.requests[key('requestId')]; break;
    case 'managed.command': {
      const value = herdrManagedCommandReceiptSchema.parse(p);
      if (value.ownerGeneration !== state.identity.ownerGeneration || value.appSessionId !== state.identity.appSessionId) throw new Error('Managed command identity mismatch.');
      next.commands[value.actionId] = value; break;
    }
    case 'managed.queue': {
      if (p.action === 'enqueue') {
        const entry = herdrManagedQueueEntrySchema.parse(p.entry);
        if (!['prompt', 'followup'].includes(entry.command.kind) || entry.command.ownerGeneration !== state.identity.ownerGeneration || entry.command.appSessionId !== state.identity.appSessionId) throw new Error('Invalid queued command.');
        if (entry.inputBytes !== managedJsonBytes(entry.command.payload)) throw new Error('Invalid queued byte count.');
        if (next.queue.entries.some(e => e.command.actionId === entry.command.actionId)) throw new Error('Duplicate queued command.');
        if (next.queue.entries.length >= HERDR_MANAGED_MAX_QUEUE_COMMANDS || next.queue.bytes + entry.inputBytes > HERDR_MANAGED_MAX_QUEUE_BYTES) throw new Error('Managed queue full.');
        next.queue.entries.push(entry); next.queue.bytes += entry.inputBytes;
      } else if (p.action === 'dequeue') {
        if (next.queue.paused || next.queue.entries[0]?.command.actionId !== key('actionId')) throw new Error('Managed queue paused or non-FIFO dequeue.');
        next.queue.bytes -= next.queue.entries.shift()!.inputBytes;
      } else if (p.action === 'pause' || p.action === 'resume') next.queue.paused = p.action === 'pause';
      else throw new Error('Invalid queue action.');
      break;
    }
    case 'managed.automation': {
      const value = herdrManagedAutomationOperationSchema.parse(p);
      if (value.identity.generation !== state.identity.ownerGeneration || value.identity.provider !== state.providerSessionId) throw new Error('Managed automation identity mismatch.');
      const previous = next.automation[value.identity.operationId];
      if (!previous && (value.phase !== 'waiting_attachment' || value.dispatchCount !== 0)) throw new Error('Automation must first persist waiting state.');
      if (previous) {
        const a = previous.identity; const b = value.identity;
        if (a.generation !== b.generation || a.provider !== b.provider || a.turn !== b.turn || a.toolCallId !== b.toolCallId || a.index !== b.index || a.argumentsHash !== b.argumentsHash || a.targetContext !== b.targetContext) throw new Error('Automation operation identity changed.');
        const allowed: Record<typeof previous.phase, string[]> = {
          waiting_attachment: ['waiting_attachment', 'awaiting_reattach_approval', 'cancelled'],
          awaiting_reattach_approval: ['waiting_attachment', 'awaiting_reattach_approval', 'dispatching', 'cancelled'],
          dispatching: ['completed', 'outcome_unknown', 'cancelled'],
          outcome_unknown: ['outcome_unknown', 'completed', 'waiting_attachment', 'cancelled'],
          completed: [], cancelled: [],
        };
        if (!allowed[previous.phase].includes(value.phase)) throw new Error('Invalid automation transition.');
        if (value.phase === 'dispatching' && (previous.capabilityGeneration !== value.capabilityGeneration || previous.approvalRequestId !== value.approvalRequestId || a.policyRevision !== b.policyRevision)) throw new Error('Automation approval binding changed before dispatch.');
        if (previous.phase === 'outcome_unknown' && value.phase !== 'outcome_unknown' && value.phase !== 'cancelled' && !value.evidenceRef) throw new Error('Automation reconciliation requires verified evidence.');
        if (value.dispatchCount < previous.dispatchCount && !(previous.phase === 'outcome_unknown' && value.phase === 'waiting_attachment' && value.evidenceRef)) throw new Error('Automation cannot retry an uncertain dispatch.');
      }
      if (value.phase === 'dispatching' && (!value.capabilityGeneration || !value.approvalRequestId || value.dispatchCount !== 1)) throw new Error('Automation dispatch requires capability and approval.');
      if (value.phase === 'completed' && !value.resultRef) throw new Error('Automation completion requires an actual result.');
      if (value.phase === 'awaiting_reattach_approval' && (!value.capabilityGeneration || !value.approvalRequestId || value.dispatchCount !== 0)) throw new Error('Invalid automation approval binding.');
      next.automation[value.identity.operationId] = value; break;
    }
    case 'stream_delta': case 'stream_end': case 'thinking': {
      const last = next.messages[next.messages.length - 1];
      const message = last && last.turnId === next.activeTurnId && !last.final ? last : { id: `message-${event.seq}`, turnId: next.activeTurnId, content: '', reasoning: [], final: false, metadata: {} };
      if (message !== last) next.messages.push(message);
      const content = z.string().parse(p.content);
      if (event.kind === 'thinking') message.reasoning.push(content);
      else if (event.kind === 'stream_delta') message.content += content;
      else { message.content = content; message.final = true; }
      message.metadata = { ...message.metadata, ...p, timestamp: message.metadata.timestamp ?? event.createdAt }; break;
    }
    case 'tool_use': case 'tool_result': {
      const toolId = key('toolId');
      const existing = next.tools[toolId];
      if (event.kind === 'tool_use' && existing?.input && existing.input.turnId !== next.activeTurnId) {
        // Keep the latest tool keyed by its SDK ID for host lookups, but retain
        // historical reused IDs under a stable unique archive key.
        const archiveId = `${toolId}@${existing.input.seq ?? event.seq}`;
        next.tools[archiveId] = existing;
        delete next.tools[toolId];
      }
      const tool = next.tools[toolId] ?? { input: null, partial: null, final: null };
      const record = { ...p, seq: event.seq, turnId: next.activeTurnId, timestamp: event.createdAt };
      if (event.kind === 'tool_use') tool.input = record;
      else if (p.isFinal === false) tool.partial = record;
      else tool.final = record;
      next.tools[toolId] = tool; break;
    }
    case 'status':
      next.status = p;
      if (p.tokenBudget) next.usage = data.parse(p.tokenBudget);
      if (p.sessionState) next.configuration = { ...(next.configuration ?? {}), ...data.parse(p.sessionState) };
      break;
    default: next.extensions.push({ seq: event.seq, kind: event.kind, payload: structuredClone(event.payload) });
  }
  next.watermark = event.seq;
  return next;
}

/** JSON is authoritative and complete. DB consumer pages this immutable serialization. */
export function serializeHerdrManagedState(state: HerdrManagedState): string {
  return JSON.stringify(herdrManagedStateSchema.parse(state));
}
export function parseHerdrManagedState(json: string): HerdrManagedState {
  const state = herdrManagedStateSchema.parse(JSON.parse(json));
  if (state.queue.bytes !== state.queue.entries.reduce((n, e) => n + managedJsonBytes(e.command.payload), 0)) throw new Error('Invalid snapshot queue bytes.');
  return state;
}

/** UTF-8 safe pages, conservatively budgeted for JSON escaping and frame metadata. */
export function pageHerdrManagedState(state: HerdrManagedState, maxChunkBytes = 128 * 1024): string[] {
  if (!Number.isSafeInteger(maxChunkBytes) || maxChunkBytes < 4 || maxChunkBytes > 128 * 1024) throw new Error('Invalid snapshot page bound.');
  const pages: string[] = [];
  let chunk = ''; let bytes = 0;
  for (const character of serializeHerdrManagedState(state)) {
    const size = new TextEncoder().encode(character).byteLength;
    if (bytes + size > maxChunkBytes) { pages.push(chunk); chunk = ''; bytes = 0; }
    chunk += character; bytes += size;
  }
  pages.push(chunk);
  return pages;
}

/** Only publish this return value after every indexed page has been collected. */
export function assembleHerdrManagedSnapshot(descriptor: HerdrManagedSnapshotDescriptor, pages: readonly string[]): HerdrManagedState {
  if (pages.length !== descriptor.pageCount) throw new Error('Incomplete managed snapshot.');
  const json = pages.join('');
  if (new TextEncoder().encode(json).byteLength !== descriptor.byteLength) throw new Error('Managed snapshot length mismatch.');
  const state = parseHerdrManagedState(json);
  if (state.watermark !== descriptor.watermark || state.identity.appSessionId !== descriptor.identity.appSessionId || state.identity.ownerGeneration !== descriptor.identity.ownerGeneration) throw new Error('Managed snapshot identity or watermark mismatch.');
  return state;
}
