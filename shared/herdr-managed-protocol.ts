import { z } from 'zod';

import type { HerdrManagedBridgeAttempt, HerdrManagedBridgeReceipt } from './herdr-managed-bridge.js';

export const HERDR_MANAGED_PROTOCOL_VERSION = 1;
export const HERDR_MANAGED_MAX_CONSOLE_BYTES = 64 * 1024;
export const HERDR_MANAGED_MAX_FRAME_BYTES = 1024 * 1024;
export const HERDR_MANAGED_MAX_PENDING_REQUESTS = 128;
export const HERDR_MANAGED_MAX_QUEUE_COMMANDS = 16;
export const HERDR_MANAGED_MAX_QUEUE_BYTES = 1024 * 1024;
export const HERDR_MANAGED_MAX_REPLAY_EVENTS = 256;
export const HERDR_MANAGED_SNAPSHOT_LEASE_MS = 60_000;
export const HERDR_MANAGED_STATE_VERSION = 1;

export const herdrManagedIdentitySchema = z.object({
  appSessionId: z.string().min(1),
  ownerGeneration: z.string().min(1),
}).strict();
export type HerdrManagedIdentity = z.infer<typeof herdrManagedIdentitySchema>;

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
export const herdrManagedGenerationSchema = idSchema;
export const herdrManagedActionIdSchema = idSchema;

export const herdrManagedLifecycleSchema = z.enum([
  'reserved',
  'claiming',
  'ready',
  'idle',
  'running',
  'awaiting_input',
  'waiting_attachment',
  'awaiting_reattach_approval',
  'unknown',
  'interrupted',
  'closed',
]);
export type HerdrManagedLifecycle = z.infer<typeof herdrManagedLifecycleSchema>;

export const herdrManagedCommandKindSchema = z.enum([
  'prompt',
  'followup',
  'steer',
  'abort',
  'answer',
  'permission',
  'resume',
  'status',
  'ack',
]);
export type HerdrManagedCommandKind = z.infer<typeof herdrManagedCommandKindSchema>;
export const herdrManagedPermissionDecisionSchema = z.enum(['allow-once', 'deny-once', 'allow-always', 'deny-remaining']);
export type HerdrManagedPermissionDecision = z.infer<typeof herdrManagedPermissionDecisionSchema>;

export const herdrManagedCommandStateSchema = z.enum(['admitted', 'executing', 'settled', 'unknown', 'rejected']);
export type HerdrManagedCommandState = z.infer<typeof herdrManagedCommandStateSchema>;

export const herdrManagedBindingSchema = z.object({
  appSessionId: idSchema,
  providerSessionId: z.string().min(1).nullable(),
  ownerGeneration: herdrManagedGenerationSchema,
  herdrInstanceId: z.string().min(1),
  workspaceId: z.string().min(1).nullable(),
  tabId: z.string().min(1).nullable(),
  paneId: z.string().min(1).nullable(),
  terminalId: z.string().min(1).nullable(),
  lifecycle: herdrManagedLifecycleSchema,
  lastSeq: z.number().int().nonnegative(),
  updatedAt: z.string().min(1),
}).strict();
export type HerdrManagedBinding = z.infer<typeof herdrManagedBindingSchema>;

export const herdrManagedHostHelloSchema = z.object({
  protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  appSessionId: idSchema,
  ownerGeneration: herdrManagedGenerationSchema,
  providerSessionId: z.string().min(1),
}).strict();
export type HerdrManagedHostHello = z.infer<typeof herdrManagedHostHelloSchema>;

export const herdrManagedEventSchema = z.object({
  protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  appSessionId: idSchema,
  ownerGeneration: herdrManagedGenerationSchema,
  seq: z.number().int().positive(),
  kind: z.string().min(1),
  payload: z.unknown(),
  createdAt: z.string().min(1),
}).strict();
export type HerdrManagedEvent = z.infer<typeof herdrManagedEventSchema>;

export const herdrManagedCommandSchema = z.object({
  protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  appSessionId: idSchema,
  ownerGeneration: herdrManagedGenerationSchema,
  actionId: herdrManagedActionIdSchema,
  kind: herdrManagedCommandKindSchema,
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  payload: z.unknown(),
}).strict();
export type HerdrManagedCommand = z.infer<typeof herdrManagedCommandSchema>;

export const herdrManagedAttachHelloSchema = z.object({
  protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  appSessionId: idSchema,
  ownerGeneration: herdrManagedGenerationSchema,
  attachSecret: z.string().min(32),
  lastAppliedSeq: z.number().int().nonnegative().default(0),
}).strict();
export type HerdrManagedAttachHello = z.infer<typeof herdrManagedAttachHelloSchema>;

export const herdrManagedAttachFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hello'), id: idSchema, value: herdrManagedAttachHelloSchema }).strict(),
  z.object({ type: z.literal('command'), id: idSchema, value: herdrManagedCommandSchema }).strict(),
  z.object({ type: z.literal('snapshot'), id: idSchema }).strict(),
  z.object({ type: z.literal('snapshot-page'), id: idSchema, snapshotId: idSchema, page: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('replay'), id: idSchema, afterSeq: z.number().int().nonnegative(), watermark: z.number().int().nonnegative() }).strict().refine(v => v.afterSeq <= v.watermark),
  z.object({ type: z.literal('subscribe'), id: idSchema, watermark: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('automation-control'), id: idSchema, control: z.lazy(() => herdrManagedAutomationControlSchema) }).strict(),
]);
export type HerdrManagedAttachFrame = z.infer<typeof herdrManagedAttachFrameSchema>;

export const herdrManagedAttachResponseSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), id: idSchema, snapshot: z.lazy(() => herdrManagedSnapshotDescriptorSchema) }).strict(),
  z.object({ type: z.literal('snapshot-page'), id: idSchema, snapshotId: idSchema, page: z.number().int().nonnegative(), chunk: z.string(), leaseExpiresAt: z.number().int().nonnegative() }).strict().refine(v => managedJsonBytes(v) <= HERDR_MANAGED_MAX_FRAME_BYTES),
  z.object({ type: z.literal('replay'), id: idSchema, afterSeq: z.number().int().nonnegative(), watermark: z.number().int().nonnegative(), nextSeq: z.number().int().nonnegative(), events: z.array(herdrManagedEventSchema).max(HERDR_MANAGED_MAX_REPLAY_EVENTS), complete: z.boolean() }).strict().refine(v => managedJsonBytes(v) <= HERDR_MANAGED_MAX_FRAME_BYTES && v.nextSeq <= v.watermark && v.events.every((e, i) => e.seq === v.afterSeq + i + 1) && v.nextSeq === v.afterSeq + v.events.length && v.complete === (v.nextSeq === v.watermark)),
  z.object({ type: z.literal('subscribed'), id: idSchema, watermark: z.number().int().nonnegative() }).strict(),
  z.object({ type: z.literal('automation-control'), id: idSchema, accepted: z.boolean(), reason: z.lazy(() => herdrManagedWaitReasonSchema).optional() }).strict(),
  z.object({ type: z.literal('snapshot-required'), id: idSchema, reason: z.enum(['gap', 'lease_expired']) }).strict(),
  z.object({ type: z.literal('receipt'), id: idSchema, receipt: z.lazy(() => herdrManagedCommandReceiptSchema) }).strict(),
  z.object({ type: z.literal('event'), event: herdrManagedEventSchema }).strict(),
  z.object({ type: z.literal('error'), id: idSchema, message: z.string().min(1) }).strict(),
]);
export type HerdrManagedAttachResponse = z.infer<typeof herdrManagedAttachResponseSchema>;

export const herdrManagedCommandReceiptSchema = z.object({
  protocolVersion: z.literal(HERDR_MANAGED_PROTOCOL_VERSION),
  appSessionId: idSchema,
  ownerGeneration: herdrManagedGenerationSchema,
  actionId: herdrManagedActionIdSchema,
  state: herdrManagedCommandStateSchema,
  seq: z.number().int().nonnegative(),
  message: z.string().min(1),
}).strict();
export type HerdrManagedCommandReceipt = z.infer<typeof herdrManagedCommandReceiptSchema>;

/** Immutable JSON state is fetched separately; ready never embeds journal history. */
export const herdrManagedSnapshotDescriptorSchema = z.object({
  snapshotId: idSchema,
  watermark: z.number().int().nonnegative(),
  byteLength: z.number().int().nonnegative(),
  pageCount: z.number().int().positive(),
  leaseExpiresAt: z.number().int().nonnegative(),
  identity: herdrManagedIdentitySchema,
}).strict();
export type HerdrManagedSnapshotDescriptor = z.infer<typeof herdrManagedSnapshotDescriptorSchema>;

export function managedJsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const herdrManagedAutomationIdentitySchema = z.object({
  generation: idSchema, provider: z.string().min(1), turn: idSchema, toolCallId: z.string().min(1).max(160),
  operationId: idSchema, index: z.number().int().nonnegative(), argumentsHash: hashSchema,
  policyRevision: z.number().int().nonnegative(), targetContext: z.string().min(1).max(4096),
}).strict();
export type HerdrManagedAutomationIdentity = z.infer<typeof herdrManagedAutomationIdentitySchema>;
export const herdrManagedAutomationPhaseSchema = z.enum(['waiting_attachment', 'awaiting_reattach_approval', 'dispatching', 'outcome_unknown', 'completed', 'cancelled']);
export const herdrManagedAutomationOperationSchema = z.object({
  identity: herdrManagedAutomationIdentitySchema,
  phase: herdrManagedAutomationPhaseSchema,
  capabilityGeneration: idSchema.nullable(),
  approvalRequestId: idSchema.nullable(),
  dispatchCount: z.number().int().min(0).max(1),
  // References point into protected storage, never bearer URLs or arguments.
  argumentsRef: idSchema,
  resultRef: idSchema.nullable(),
  evidenceRef: idSchema.nullable(),
}).strict();
export type HerdrManagedAutomationOperation = z.infer<typeof herdrManagedAutomationOperationSchema>;
/** Protected DB/IPC content; public operation events carry references only. */
export type HerdrManagedAutomationProtectedRecord = {
  identity: HerdrManagedAutomationIdentity;
  sourceOperationId?: string;
  arguments: unknown;
  result?: unknown;
  attempt?: HerdrManagedBridgeAttempt;
  receipt?: HerdrManagedBridgeReceipt;
  evidence?: { verifier: string; observedAt: string; content: unknown };
};
export type HerdrManagedAutomationTransitionEvent = {
  kind: 'managed.automation';
  payload: HerdrManagedAutomationOperation;
};
export const managedInstalledBundleIdSchema = z.string().min(3).max(512).regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/).refine(value => !/\s/.test(value));
/** Private target only: never publish canonical paths in operation summaries. */
export const managedInstalledApplicationSchema = z.object({
  kind: z.literal('cua-installed-application'),
  bundleId: managedInstalledBundleIdSchema,
  canonicalPath: z.string().max(4096).refine(value => value.startsWith('/') && value.endsWith('.app')
    && !value.includes('\0') && !value.slice(1).split('/').some(part => part === '.' || part === '..' || part === '')),
  identity: hashSchema,
}).strict();
export type ManagedInstalledApplication = z.infer<typeof managedInstalledApplicationSchema>;
/** The exact private target remains host-owned; UI replies select its request ID. */
export function publicManagedTargetContext(context: string): string {
  try {
    const binding = managedInstalledApplicationSchema.safeParse(JSON.parse(context));
    if (binding.success) {
      return JSON.stringify({ kind: binding.data.kind, bundleId: binding.data.bundleId, identity: binding.data.identity });
    }
  } catch { /* Non-JSON contexts (for example an origin) are already display values. */ }
  return context;
}
export const herdrManagedTargetBindingSchema = z.discriminatedUnion('kind', [
  managedInstalledApplicationSchema,
  z.object({ kind: z.literal('browser-origin'), origin: z.string().url().refine(value => { try { return new URL(value).origin === value && value !== 'null'; } catch { return false; } }), tabId: z.string().min(1).max(160) }).strict(),
  z.object({ kind: z.literal('cua-application'), pid: z.number().int().positive(), windowId: z.number().int().nonnegative().nullable(), bundleId: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal('discovery'), operation: z.string().min(1).max(160) }).strict(),
  z.object({ kind: z.literal('session-management'), operation: z.string().min(1).max(160), sessionId: z.string().min(1).max(160) }).strict(),
]);
export type HerdrManagedTargetBinding = z.infer<typeof herdrManagedTargetBindingSchema>;
export const herdrManagedTargetContextSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('unresolved') }).strict(),
  z.object({ state: z.literal('resolved'), binding: herdrManagedTargetBindingSchema }).strict(),
]);
export type HerdrManagedTargetContext = z.infer<typeof herdrManagedTargetContextSchema>;
export const herdrManagedBridgeTransportSchema = z.object({
  transportLocator: z.string().min(1).max(4096), transportToken: z.string().min(32).max(4096),
  ownerConnectionId: idSchema, bridgeInstanceId: idSchema,
}).strict();
export type HerdrManagedBridgeTransport = z.infer<typeof herdrManagedBridgeTransportSchema>;
export const herdrManagedCapabilitySchema = z.object({
  generation: idSchema, capabilityGeneration: idSchema, ownerConnectionId: idSchema,
  targetContext: z.string().min(1).max(4096), policyRevision: z.number().int().nonnegative(),
  transportLocator: z.string().min(1).max(4096), transportToken: z.string().min(32).max(4096),
  bridgeInstanceId: idSchema, operationIdentity: herdrManagedAutomationIdentitySchema,
  sourceOperationId: idSchema, targetBinding: herdrManagedTargetBindingSchema,
}).strict().refine(v => v.generation === v.operationIdentity.generation
  && v.policyRevision === v.operationIdentity.policyRevision && v.targetContext === v.operationIdentity.targetContext);
export type HerdrManagedCapability = z.infer<typeof herdrManagedCapabilitySchema>;
/** Private authenticated App-server/child control only; never browser attach events/status. */
/**
 * Why a never-dispatched operation could not be bound on the last attempt. A
 * closed set: the host classifies its private failure into one of these and
 * nothing else crosses to the App or its viewers.
 */
export const HERDR_MANAGED_WAIT_REASONS = {
  browser_session_missing: 'the browser session for this conversation is not open in the app yet; open it in the Browser panel or with an open step.',
  browser_page_unresolved: 'no page with a concrete http(s) origin is open yet; navigate to one or use an open step.',
  bridge_unavailable: 'the app did not answer the target request; it retries while the app is attached.',
  bind_failed: 'the app could not bind this step to its target yet; it retries while the app is attached.',
} as const;
export const herdrManagedWaitReasonSchema = z.enum(Object.keys(HERDR_MANAGED_WAIT_REASONS) as [keyof typeof HERDR_MANAGED_WAIT_REASONS, ...(keyof typeof HERDR_MANAGED_WAIT_REASONS)[]]);
export type HerdrManagedWaitReason = z.infer<typeof herdrManagedWaitReasonSchema>;

export const herdrManagedAutomationControlSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bind-capability'), actionId: idSchema, identity: herdrManagedAutomationIdentitySchema, currentTransport: herdrManagedBridgeTransportSchema }).strict(),
  z.object({ type: z.literal('detach-capability'), actionId: idSchema, generation: idSchema, capabilityGeneration: idSchema, ownerConnectionId: idSchema }).strict(),
  z.object({ type: z.literal('resume-approved'), actionId: idSchema, identity: herdrManagedAutomationIdentitySchema, capabilityGeneration: idSchema, approvalRequestId: idSchema }).strict(),
  z.object({ type: z.literal('resume-denied'), actionId: idSchema, identity: herdrManagedAutomationIdentitySchema, capabilityGeneration: idSchema, approvalRequestId: idSchema }).strict(),
  z.object({ type: z.literal('reconcile'), actionId: idSchema, identity: herdrManagedAutomationIdentitySchema, originalCapabilityGeneration: idSchema, currentTransport: herdrManagedBridgeTransportSchema }).strict(),
]);
export type HerdrManagedAutomationControl = z.infer<typeof herdrManagedAutomationControlSchema>;

export function parseHerdrManagedAttachFrame(json: string): HerdrManagedAttachFrame {
  if (new TextEncoder().encode(json).byteLength > HERDR_MANAGED_MAX_FRAME_BYTES) throw new Error('Managed attach frame too large.');
  return herdrManagedAttachFrameSchema.parse(JSON.parse(json));
}

export function parseHerdrManagedAttachResponse(json: string): HerdrManagedAttachResponse {
  if (new TextEncoder().encode(json).byteLength > HERDR_MANAGED_MAX_FRAME_BYTES) throw new Error('Managed attach response too large.');
  return herdrManagedAttachResponseSchema.parse(JSON.parse(json));
}
