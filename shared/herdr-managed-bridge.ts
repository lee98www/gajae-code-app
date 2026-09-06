import { z } from 'zod';

import { HERDR_MANAGED_MAX_FRAME_BYTES, herdrManagedAutomationIdentitySchema, herdrManagedTargetBindingSchema, managedJsonBytes } from './herdr-managed-protocol.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,96}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
/** JSON normalization is shared by Node and Bun; object keys use code-unit ordering. */
export function canonicalManagedInvocation(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const encode = (v: unknown): string => Array.isArray(v) ? `[${v.map(encode).join(',')}]`
    : v !== null && typeof v === 'object' ? `{${Object.keys(v).sort().map(key => `${JSON.stringify(key)}:${encode((v as Record<string, unknown>)[key])}`).join(',')}}`
      : JSON.stringify(v);
  return encode(normalized);
}
export async function hashManagedInvocation(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalManagedInvocation(value));
  if (bytes.byteLength > HERDR_MANAGED_MAX_FRAME_BYTES) throw new Error('Managed invocation too large.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
export const herdrManagedBridgeAttemptSchema = z.object({
  identity: herdrManagedAutomationIdentitySchema,
  originalCapabilityGeneration: id,
  requestId: id,
  bridgeInstanceId: id,
  sourceOperationId: id,
  targetBinding: herdrManagedTargetBindingSchema,
}).strict();
export type HerdrManagedBridgeAttempt = z.infer<typeof herdrManagedBridgeAttemptSchema>;
export const herdrManagedBridgeResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }).strict().refine(v => Object.prototype.hasOwnProperty.call(v, 'result')),
  z.object({ ok: z.literal(false), error: z.string().min(1).max(131072) }).strict(),
]);
export type HerdrManagedBridgeResponse = z.infer<typeof herdrManagedBridgeResponseSchema>;
/** Only the authenticated durable ledger creates receipts. Missing rows are unknown, never fences. */
export const herdrManagedBridgeReceiptSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), attempt: herdrManagedBridgeAttemptSchema, response: herdrManagedBridgeResponseSchema, completedAt: z.string().datetime(), receiptId: id }).strict(),
  z.object({ status: z.literal('not_dispatched'), attempt: herdrManagedBridgeAttemptSchema, fenceId: id, fencedAt: z.string().datetime() }).strict(),
  z.object({ status: z.literal('unknown'), attempt: herdrManagedBridgeAttemptSchema }).strict(),
]).refine(v => managedJsonBytes(v) <= HERDR_MANAGED_MAX_FRAME_BYTES);
export type HerdrManagedBridgeReceipt = z.infer<typeof herdrManagedBridgeReceiptSchema>;
export const herdrManagedBridgeResolveRequestSchema = z.object({
  type: z.literal('managed-resolve-target'), requestId: id, identity: herdrManagedAutomationIdentitySchema,
  sourceOperationId: id, bridgeInstanceId: id, invocation: z.unknown(),
}).strict().refine(v => Object.prototype.hasOwnProperty.call(v, 'invocation') && managedJsonBytes(v) <= HERDR_MANAGED_MAX_FRAME_BYTES);
export type HerdrManagedBridgeResolveRequest = z.infer<typeof herdrManagedBridgeResolveRequestSchema>;
export const herdrManagedBridgeResolveResponseSchema = z.object({
  type: z.literal('managed-target'), requestId: id, identity: herdrManagedAutomationIdentitySchema,
  sourceOperationId: id, bridgeInstanceId: id, invocationHash: hash, targetBinding: herdrManagedTargetBindingSchema,
}).strict();
export type HerdrManagedBridgeResolveResponse = z.infer<typeof herdrManagedBridgeResolveResponseSchema>;
export const herdrManagedBridgeRequestSchema = z.union([
  herdrManagedBridgeResolveRequestSchema,
  z.object({ type: z.literal('managed-dispatch'), attempt: herdrManagedBridgeAttemptSchema, invocation: z.unknown() }).strict().refine(v => Object.prototype.hasOwnProperty.call(v, 'invocation')),
  z.object({ type: z.literal('managed-lookup'), attempt: herdrManagedBridgeAttemptSchema }).strict(),
  z.object({ type: z.literal('managed-fence'), attempt: herdrManagedBridgeAttemptSchema }).strict(),
]).refine(v => managedJsonBytes(v) <= HERDR_MANAGED_MAX_FRAME_BYTES);
export type HerdrManagedBridgeRequest = z.infer<typeof herdrManagedBridgeRequestSchema>;
/** A reserve result grants execution once; duplicate reservations return a receipt instead. */
export const herdrManagedBridgeReservationSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('reserved'), attempt: herdrManagedBridgeAttemptSchema, reservationId: id }).strict(),
  z.object({ status: z.literal('existing'), receipt: herdrManagedBridgeReceiptSchema }).strict(),
]);
export type HerdrManagedBridgeReservation = z.infer<typeof herdrManagedBridgeReservationSchema>;
export interface HerdrManagedBridgeLedger {
  reserveDispatch(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReservation;
  completeDispatch(attempt: HerdrManagedBridgeAttempt, reservationId: string, response: HerdrManagedBridgeResponse): HerdrManagedBridgeReceipt;
  lookupOutcome(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReceipt;
  fenceUndispatched(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReceipt;
}
export function verifyManagedBridgeReceipt(value: unknown, expected: HerdrManagedBridgeAttempt): HerdrManagedBridgeReceipt {
  const receipt = herdrManagedBridgeReceiptSchema.parse(value);
  if (canonicalManagedInvocation(receipt.attempt) !== canonicalManagedInvocation(herdrManagedBridgeAttemptSchema.parse(expected))) throw new Error('Managed bridge receipt attempt mismatch.');
  return receipt;
}
export async function verifyManagedBridgeInvocation(identity: z.infer<typeof herdrManagedAutomationIdentitySchema>, invocation: unknown): Promise<void> {
  if (herdrManagedAutomationIdentitySchema.parse(identity).argumentsHash !== await hashManagedInvocation(invocation)) throw new Error('Managed invocation hash mismatch.');
}
export async function verifyManagedBridgeTarget(value: unknown, request: HerdrManagedBridgeResolveRequest): Promise<HerdrManagedBridgeResolveResponse> {
  const expected = herdrManagedBridgeResolveRequestSchema.parse(request);
  await verifyManagedBridgeInvocation(expected.identity, expected.invocation);
  const target = herdrManagedBridgeResolveResponseSchema.parse(value);
  if (target.requestId !== expected.requestId || target.sourceOperationId !== expected.sourceOperationId || target.bridgeInstanceId !== expected.bridgeInstanceId
    || target.invocationHash !== expected.identity.argumentsHash || canonicalManagedInvocation(target.identity) !== canonicalManagedInvocation(expected.identity)) throw new Error('Managed target binding mismatch.');
  return target;
}
export function parseManagedBridgeRequest(line: string): HerdrManagedBridgeRequest {
  if (new TextEncoder().encode(line).byteLength > HERDR_MANAGED_MAX_FRAME_BYTES) throw new Error('Managed bridge frame too large.');
  return herdrManagedBridgeRequestSchema.parse(JSON.parse(line));
}

/** Error code the App attaches to a managed target resolution it definitively refused. */
export const HERDR_MANAGED_TARGET_REJECTED = 'target_rejected' as const;
