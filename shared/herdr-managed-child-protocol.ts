import { z } from 'zod';

import { herdrManagedAutomationControlSchema, herdrManagedCapabilitySchema, herdrManagedActionIdSchema, herdrManagedAutomationIdentitySchema } from './herdr-managed-protocol.js';
import { herdrManagedBridgeReceiptSchema } from './herdr-managed-bridge.js';

/** Host-authenticated receipt delivery is never an external attach control. */
export const herdrManagedChildAutomationControlSchema = z.union([
  herdrManagedAutomationControlSchema,
  z.object({ type: z.literal('attach-capability'), actionId: herdrManagedActionIdSchema, capability: herdrManagedCapabilitySchema }).strict(),
  z.object({ type: z.literal('reconcile-verified'), actionId: herdrManagedActionIdSchema, identity: herdrManagedAutomationIdentitySchema, receipt: herdrManagedBridgeReceiptSchema }).strict()
    .refine(v => Object.keys(v.identity).every(key => v.identity[key as keyof typeof v.identity] === v.receipt.attempt.identity[key as keyof typeof v.identity])),
]);
export type HerdrManagedChildAutomationControl = z.infer<typeof herdrManagedChildAutomationControlSchema>;

/** Private, newline-delimited JSON protocol. Acks mean durable host persistence, not receipt. */
export const HERDR_MANAGED_CHILD_VERSION = 1 as const;
export const HERDR_MANAGED_CHILD_LIMITS = {
  frameBytes: 262_144,
  pendingEvents: 128,
  pendingBytes: 4_194_304,
  operations: 4096,
  idLength: 160,
  textLength: 131_072,
} as const;
export type ManagedChildIdentity = {
  version: typeof HERDR_MANAGED_CHILD_VERSION;
  generation: string;
  requestId: string;
  runId: string;
};
export type ManagedChildTurnOptions = { modelId?: string; modelProfile?: string; effort?: string };
export type ManagedChildRequest = ManagedChildIdentity & (
  | { type: 'init'; agentDir: string; appSessionId: string; runConfig: Record<string, unknown> }
  | { type: 'prompt'; actionId: string; text: string; turnOptions?: ManagedChildTurnOptions }
  | { type: 'steer'; actionId: string; text: string }
  | { type: 'abort' | 'close'; actionId: string }
  | { type: 'approval' | 'validate-approval'; actionId: string; askId: string; decision: Record<string, unknown> }
  | { type: 'ack'; eventSeq: number }
  | { type: 'automation-control'; control: HerdrManagedChildAutomationControl }
  | { type: 'operation-status'; actionId: string; operationId: string }
);
export type ManagedChildResponse = ManagedChildIdentity & {
  type: 'response';
  ok: boolean;
  providerSessionId?: string;
  error?: 'invalid_request' | 'conflict' | 'not_ready' | 'busy' | 'operation_limit' | 'operation_failed';
  /** Bounded, secret-free reason for `operation_failed`; diagnostics only, never an outcome. */
  detail?: string;
  operationId?: string;
  operationState?: 'in_flight' | 'completed' | 'not_found';
};
export type ManagedChildEvent = ManagedChildIdentity & {
  type: 'event';
  eventSeq: number;
  event: Record<string, unknown>;
};
export type ManagedChildOutput = ManagedChildResponse | ManagedChildEvent;
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_.:-]+$/.test(v) && v.length <= HERDR_MANAGED_CHILD_LIMITS.idLength;
const bounded = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max;
const keys = (v: Record<string, unknown>, extra: string[]) => Object.keys(v).every((k) => ['version', 'generation', 'requestId', 'runId', 'type', ...extra].includes(k));
const identity = (v: Record<string, unknown>) => v.version === HERDR_MANAGED_CHILD_VERSION && id(v.generation) && id(v.requestId) && id(v.runId);
export function parseManagedChildRequest(line: string): ManagedChildRequest {
  if (new TextEncoder().encode(line).byteLength > HERDR_MANAGED_CHILD_LIMITS.frameBytes) throw new Error('Invalid managed child frame.');
  const v: unknown = JSON.parse(line);
  if (!record(v) || !identity(v)) throw new Error('Invalid managed child identity.');
  let valid = false;
  switch (v.type) {
    case 'init': valid = keys(v, ['agentDir', 'appSessionId', 'runConfig']) && bounded(v.agentDir, 4096) && id(v.appSessionId) && record(v.runConfig); break;
    case 'prompt': valid = keys(v, ['actionId', 'text', 'turnOptions']) && id(v.actionId) && bounded(v.text, HERDR_MANAGED_CHILD_LIMITS.textLength)
      && (v.turnOptions === undefined || (record(v.turnOptions) && Object.keys(v.turnOptions).every(key => ['modelId', 'modelProfile', 'effort'].includes(key))
        && Object.values(v.turnOptions).every(value => bounded(value, 256)))); break;
    case 'steer': valid = keys(v, ['actionId', 'text']) && id(v.actionId) && bounded(v.text, HERDR_MANAGED_CHILD_LIMITS.textLength); break;
    case 'abort': case 'close': valid = keys(v, ['actionId']) && id(v.actionId); break;
    case 'approval': case 'validate-approval': valid = keys(v, ['actionId', 'askId', 'decision']) && id(v.actionId) && id(v.askId) && record(v.decision); break;
    case 'ack': valid = keys(v, ['eventSeq']) && Number.isSafeInteger(v.eventSeq) && Number(v.eventSeq) > 0; break;
    case 'automation-control': {
      const control = herdrManagedChildAutomationControlSchema.safeParse(v.control);
      valid = keys(v, ['control']) && control.success;
      if (control.success) {
        const c = control.data;
        const generation = c.type === 'attach-capability' ? c.capability.generation
          : c.type === 'detach-capability' ? c.generation : c.identity.generation;
        valid = valid && generation === v.generation;
      }
      break;
    }
    case 'operation-status': valid = keys(v, ['actionId', 'operationId']) && id(v.actionId) && id(v.operationId); break;
  }
  if (!valid) throw new Error('Invalid managed child request.');
  return v as ManagedChildRequest;
}
export function parseManagedChildOutput(line: string): ManagedChildOutput {
  if (new TextEncoder().encode(line).byteLength > HERDR_MANAGED_CHILD_LIMITS.frameBytes) throw new Error('Invalid managed child frame.');
  const v: unknown = JSON.parse(line);
  if (!record(v) || !identity(v)) throw new Error('Invalid managed child identity.');
  if (v.type === 'event' && keys(v, ['eventSeq', 'event']) && Number.isSafeInteger(v.eventSeq) && Number(v.eventSeq) > 0 && record(v.event)) return v as ManagedChildEvent;
  if (v.type === 'response' && keys(v, ['ok', 'providerSessionId', 'error', 'detail', 'operationId', 'operationState']) && typeof v.ok === 'boolean'
    && (v.detail === undefined || (typeof v.detail === 'string' && v.detail.length <= 300))
    && (v.operationId === undefined || id(v.operationId))
    && (v.operationState === undefined || (id(v.operationId) && ['in_flight', 'completed', 'not_found'].includes(String(v.operationState))))
    && (v.providerSessionId === undefined || id(v.providerSessionId))
    && (v.error === undefined || ['invalid_request', 'conflict', 'not_ready', 'busy', 'operation_limit', 'operation_failed'].includes(String(v.error)))) return v as ManagedChildResponse;
  throw new Error('Invalid managed child output.');
}
