import type { HerdrManagedEvent, HerdrManagedIdentity, HerdrManagedLifecycle } from './herdr-managed-protocol.js';
import { managedJsonBytes, publicManagedTargetContext } from './herdr-managed-protocol.js';
import type { HerdrManagedState } from './herdr-managed-state.js';

export const MANAGED_CHAT_MAX_FRAME_BYTES = 1024 * 1024;
export const MANAGED_CHAT_MAX_PAGE_RECORDS = 256;
type Data = Record<string, unknown>;
export type ManagedChatKind = 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'error' | 'complete' | 'status' | 'permission_request' | 'permission_cancelled' | 'interactive_prompt' | 'task_notification' | 'system_notice';
/** Structural NormalizedMessage contract, independent of server and React imports. */
export interface ManagedChatRecord extends Data {
  id: string; sessionId: string; provider: 'gjc'; timestamp: string; kind: ManagedChatKind;
  ownerGeneration: string; providerSessionId: string | null; turnId: string | null; seq?: number;
  content?: string; role?: 'user' | 'assistant'; toolId?: string; toolName?: string;
}
export interface ManagedPendingPermission extends Data {
  requestId: string; sessionId: string; toolName: string; input: unknown; context: unknown;
  generation: string; providerSessionId: string; turnId: string; policyRevision: number; createdAt: string;
}
export interface ManagedUIStatus {
  kind: 'managed_ui_status'; sessionId: string; ownerGeneration: string; providerSessionId: string | null;
  watermark: number; lifecycle: HerdrManagedLifecycle; activeTurnId: string | null; title: string | null;
  isProcessing: boolean; terminal: boolean; usage: unknown; configuration: unknown; status: unknown;
  turns: Data; queue: { paused: boolean; count: number; actionIds: string[] }; automation: Data[];
}
export interface ManagedChatProjection { records: ManagedChatRecord[]; pendingPermissions: ManagedPendingPermission[]; metadata: ManagedUIStatus }
export interface ManagedLiveEvent {
  kind: 'managed_live_event'; id: string; sessionId: string; ownerGeneration: string; seq: number;
  /** Replace, never append this projection. Oversized envelopes use pageTransfer instead. */
  projection: ManagedChatProjection;
}

const object = (v: unknown): Data => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Data : {};
// Protected automation records/control and tagged answers are not chat content.
const privateKey = /^(capability|privateCapability|transportToken|transportLocator|ownerConnectionId|chunks|protectedRecord|protectedRecords|secret|secrets|bearerToken|authorization|apiKey|accessToken|refreshToken|answers|answer|taggedAnswers|argumentsRef|resultRef|evidenceRef)$/i;
function publicValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicValue);
  if (value !== null && typeof value === 'object') {
    const p = object(value);
    if (p.type === 'attach-capability' || p.kind === 'managed.answer' || p.type === 'secret') return null;
    return Object.fromEntries(Object.entries(p).filter(([key]) => !privateKey.test(key)).map(([key, v]) => [key, publicValue(v)]));
  }
  return value;
}
const publicData = (v: unknown): Data => object(publicValue(v));
const visibleKinds = new Set<ManagedChatKind>(['text', 'thinking', 'tool_use', 'tool_result', 'error', 'complete', 'status', 'interactive_prompt', 'task_notification', 'system_notice']);

export function projectManagedState(state: HerdrManagedState): ManagedChatProjection {
  const { appSessionId: sessionId, ownerGeneration } = state.identity;
  const records: ManagedChatRecord[] = [];
  const row = (key: string, kind: ManagedChatKind, payload: unknown, turnId: string | null, seq?: number): ManagedChatRecord => {
    const p = publicData(payload);
    return { ...p, id: `${ownerGeneration}:${key}`, sessionId, provider: 'gjc',
      timestamp: typeof p.timestamp === 'string' ? p.timestamp : typeof p.createdAt === 'string' ? p.createdAt : '', kind, ownerGeneration,
      providerSessionId: state.providerSessionId, turnId, ...(seq === undefined ? {} : { seq }) } as ManagedChatRecord;
  };
  for (const message of state.messages) {
    const seq = /^message-(\d+)$/.exec(message.id)?.[1];
    if (message.reasoning.length) records.push(row(`${message.id}:reasoning`, 'thinking', { content: message.reasoning.join(''), isFinal: message.final }, message.turnId, seq ? Number(seq) : undefined));
    if (message.content || message.metadata.images) records.push(row(message.id, 'text', { ...message.metadata, content: message.content, role: 'assistant', isFinal: message.final }, message.turnId, seq ? Number(seq) : undefined));
  }
  for (const [toolId, tool] of Object.entries(state.tools)) {
    const input = tool.input;
    const turnId = typeof input?.turnId === 'string' ? input.turnId : null;
    if (input) records.push(row(`tool:${toolId}:use`, 'tool_use', { ...input, toolId }, turnId, typeof input.seq === 'number' ? input.seq : undefined));
    const result = tool.final ?? tool.partial;
    if (result) records.push(row(`tool:${toolId}:result`, 'tool_result', { ...result, toolId, isFinal: Boolean(tool.final), partial: tool.partial, final: tool.final }, turnId, typeof result.seq === 'number' ? result.seq : undefined));
  }
  for (const extension of state.extensions) {
    const p = object(extension.payload);
    const kind = extension.kind as ManagedChatKind;
    if (!visibleKinds.has(kind)) continue;
    // Stream-end state already owns the assistant answer. Never echo it as a second card.
    if (kind === 'text' && p.role !== 'user' && state.messages.some(m => m.content === p.content && m.turnId === (p.turnId ?? null))) continue;
    records.push(row(String(extension.seq), kind, p, typeof p.turnId === 'string' ? p.turnId : null, extension.seq));
  }
  records.sort((a, b) => (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER));
  const pendingPermissions: ManagedPendingPermission[] = Object.values(state.requests).map(request => ({
    requestId: request.requestId, sessionId, generation: request.generation, providerSessionId: request.providerSessionId,
    turnId: request.turnId, policyRevision: request.policyRevision, createdAt: request.createdAt,
    toolName: typeof request.scope.toolName === 'string' ? request.scope.toolName : request.kind === 'ask' ? 'AskUserQuestion' : 'Permission',
    input: publicValue(request.schema), context: {
      ...publicData(request.scope),
      ...(Array.isArray(request.scope.options) ? { options: request.scope.options.map(option => typeof option === 'string' ? option : object(option).kind).filter((kind): kind is string => typeof kind === 'string') } : {}),
    }, requestKind: request.kind,
  }));
  const automation = Object.values(state.automation).map(operation => ({
    identity: { ...operation.identity, targetContext: publicManagedTargetContext(operation.identity.targetContext) }, phase: operation.phase, capabilityGeneration: operation.capabilityGeneration,
    approvalRequestId: operation.approvalRequestId, dispatchCount: operation.dispatchCount,
  }));
  for (const operation of automation) {
    if (operation.phase !== 'awaiting_reattach_approval' || !operation.approvalRequestId) continue;
    const request = pendingPermissions.find(r => r.requestId === operation.approvalRequestId);
    const fields = { toolName: 'AutomationResume', input: operation, context: { ...operation, title: `Resume ${operation.identity.targetContext}`, options: ['allow_once', 'reject_once'] } };
    if (request) Object.assign(request, fields);
    else pendingPermissions.push({ ...fields, requestId: operation.approvalRequestId, sessionId, generation: ownerGeneration,
      providerSessionId: operation.identity.provider, turnId: operation.identity.turn, policyRevision: operation.identity.policyRevision, createdAt: '' });
  }
  const terminal = ['idle', 'interrupted', 'closed'].includes(state.lifecycle);
  return { records, pendingPermissions, metadata: {
    kind: 'managed_ui_status', sessionId, ownerGeneration, providerSessionId: state.providerSessionId,
    watermark: state.watermark, lifecycle: state.lifecycle, activeTurnId: state.activeTurnId, title: state.title,
    terminal, isProcessing: !terminal, usage: publicValue(state.usage), configuration: publicValue(state.configuration),
    status: publicValue(state.status), turns: publicData(state.turns),
    queue: { paused: state.queue.paused, count: state.queue.entries.length, actionIds: state.queue.entries.map(e => e.command.actionId) }, automation,
  } };
}

/** state is the authoritative state AFTER reducing event. Original unmanaged SDK events are never mutated. */
export function projectManagedEvent(event: HerdrManagedEvent, state: HerdrManagedState): ManagedLiveEvent {
  if (event.appSessionId !== state.identity.appSessionId || event.ownerGeneration !== state.identity.ownerGeneration || event.seq !== state.watermark) throw new Error('Managed projection identity/watermark mismatch.');
  return { kind: 'managed_live_event', id: `${event.ownerGeneration}:${event.seq}`, sessionId: event.appSessionId,
    ownerGeneration: event.ownerGeneration, seq: event.seq, projection: projectManagedState(state) };
}

export interface ManagedChatCursor { sessionId: string; ownerGeneration: string; watermark: number }
/** A new generation is accepted ONLY through an explicitly selected snapshot, never a live frame. */
export function acceptManagedSequence(cursor: ManagedChatCursor, identity: HerdrManagedIdentity, seq: number): 'apply' | 'duplicate' | 'stale' | 'gap' {
  if (cursor.sessionId !== identity.appSessionId || cursor.ownerGeneration !== identity.ownerGeneration) return 'stale';
  if (!Number.isSafeInteger(seq) || seq < 0) return 'gap';
  if (seq <= cursor.watermark) return 'duplicate';
  return seq === cursor.watermark + 1 ? 'apply' : 'gap';
}

type TransferIdentity = { transferId: string; sessionId: string; ownerGeneration: string; watermark: number };
export type ManagedSnapshotBegin = TransferIdentity & { kind: 'managed_snapshot_begin'; pageCount: number; byteLength: number; recordCount: number };
export type ManagedSnapshotPage = TransferIdentity & { kind: 'managed_snapshot_page'; page: number; chunk: string };
export type ManagedSnapshotEnd = TransferIdentity & { kind: 'managed_snapshot_end' };
export type ManagedSnapshotFrame = ManagedSnapshotBegin | ManagedSnapshotPage | ManagedSnapshotEnd;

/** JSON fragments are not independently parseable records. Assemble offscreen, then atomically replace. */
export function pageTransfer(projection: ManagedChatProjection, transferId = `${projection.metadata.ownerGeneration}:${projection.metadata.watermark}`): ManagedSnapshotFrame[] {
  const m = projection.metadata;
  const identity: TransferIdentity = { transferId, sessionId: m.sessionId, ownerGeneration: m.ownerGeneration, watermark: m.watermark };
  const segments = ['{"records":[', ...projection.records.map((r, i) => `${i ? ',' : ''}${JSON.stringify(r)}`), `],"pendingPermissions":${JSON.stringify(projection.pendingPermissions)},"metadata":${JSON.stringify(m)}}`];
  const pages: ManagedSnapshotPage[] = [];
  let chunk = ''; let count = 0;
  const flush = () => { if (chunk) pages.push({ ...identity, kind: 'managed_snapshot_page', page: pages.length, chunk }); chunk = ''; count = 0; };
  // Conservative escaped-JSON byte budget, then verify the actual emitted envelope below.
  const budget = MANAGED_CHAT_MAX_FRAME_BYTES - managedJsonBytes({ ...identity, kind: 'managed_snapshot_page', page: Number.MAX_SAFE_INTEGER, chunk: '' });
  if (budget < 12) throw new Error('Snapshot identity exceeds frame bound.');
  let bytes = 0;
  for (let index = 0; index < segments.length; index++) {
    if (count === MANAGED_CHAT_MAX_PAGE_RECORDS) { flush(); bytes = 0; }
    if (index > 0 && index <= projection.records.length) count++;
    for (const character of segments[index]) {
      const size = managedJsonBytes(character) - 2;
      if (bytes + size > budget) { flush(); bytes = 0; count = index > 0 && index <= projection.records.length ? 1 : 0; }
      chunk += character; bytes += size;
    }
  }
  flush();
  const frames: ManagedSnapshotFrame[] = [{ ...identity, kind: 'managed_snapshot_begin', pageCount: pages.length,
    byteLength: new TextEncoder().encode(segments.join('')).byteLength, recordCount: projection.records.length }, ...pages, { ...identity, kind: 'managed_snapshot_end' }];
  if (frames.some(f => managedJsonBytes(f) > MANAGED_CHAT_MAX_FRAME_BYTES)) throw new Error('Snapshot frame exceeds bound.');
  return frames;
}

export function assembleManagedTransfer(frames: readonly ManagedSnapshotFrame[]): ManagedChatProjection {
  const begin = frames[0]; const end = frames.at(-1);
  if (begin?.kind !== 'managed_snapshot_begin' || end?.kind !== 'managed_snapshot_end' || frames.length !== begin.pageCount + 2) throw new Error('Incomplete managed transfer.');
  for (const frame of frames) {
    if (frame.transferId !== begin.transferId || frame.sessionId !== begin.sessionId || frame.ownerGeneration !== begin.ownerGeneration || frame.watermark !== begin.watermark || managedJsonBytes(frame) > MANAGED_CHAT_MAX_FRAME_BYTES) throw new Error('Invalid managed transfer frame.');
  }
  const json = frames.slice(1, -1).map((frame, index) => {
    if (frame.kind !== 'managed_snapshot_page' || frame.page !== index) throw new Error('Duplicate or out-of-order managed page.');
    return frame.chunk;
  }).join('');
  if (new TextEncoder().encode(json).byteLength !== begin.byteLength) throw new Error('Managed transfer byte length mismatch.');
  const projection = JSON.parse(json) as ManagedChatProjection;
  if (!Array.isArray(projection.records) || !Array.isArray(projection.pendingPermissions) || projection.records.length !== begin.recordCount || projection.metadata.sessionId !== begin.sessionId || projection.metadata.ownerGeneration !== begin.ownerGeneration || projection.metadata.watermark !== begin.watermark) throw new Error('Managed transfer projection mismatch.');
  return projection;
}
