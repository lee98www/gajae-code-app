import { z } from 'zod';

export const HERDR_SNAPSHOT_REFETCH_MS = 5_000;
export const HERDR_OUTPUT_REFETCH_MS = 2_000;
export const HERDR_OUTPUT_LINES = 400;
export const HERDR_INPUT_MAX_BYTES = 16 * 1024;

export const herdrSessionNameSchema = z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/);
export const herdrPaneIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9:._-]+$/);
export const herdrTerminalIdSchema = z.string().min(1).max(240);
export const herdrObservationTokenSchema = z.string().min(1).max(240);

export const herdrAgentStatusSchema = z.enum(['idle', 'working', 'blocked', 'done', 'unknown']);
export type HerdrAgentStatus = z.infer<typeof herdrAgentStatusSchema>;

export const herdrSessionSummarySchema = z.object({
  name: herdrSessionNameSchema,
  label: z.string(),
  status: z.enum(['available', 'unreachable', 'unsupported', 'unknown']),
  generation: z.number().int().nonnegative(),
  error: z.string().optional(),
});
export type HerdrSessionSummary = z.infer<typeof herdrSessionSummarySchema>;

export const herdrSessionsResponseSchema = z.object({
  sessions: z.array(herdrSessionSummarySchema),
}).strict();
export type HerdrSessionsResponse = z.infer<typeof herdrSessionsResponseSchema>;

export const herdrWorkspaceSchema = z.object({
  workspaceId: z.string(),
  number: z.number(),
  label: z.string(),
  focused: z.boolean(),
  tabCount: z.number(),
  paneCount: z.number(),
  activeTabId: z.string().nullable().optional(),
  agentStatus: herdrAgentStatusSchema,
});
export type HerdrWorkspace = z.infer<typeof herdrWorkspaceSchema>;

export const herdrTabSchema = z.object({
  tabId: z.string(),
  workspaceId: z.string(),
  number: z.number(),
  label: z.string(),
  focused: z.boolean(),
  paneCount: z.number(),
  agentStatus: herdrAgentStatusSchema,
});
export type HerdrTab = z.infer<typeof herdrTabSchema>;

export const herdrPaneSchema = z.object({
  paneId: herdrPaneIdSchema,
  terminalId: herdrTerminalIdSchema,
  workspaceId: z.string(),
  tabId: z.string(),
  focused: z.boolean(),
  cwd: z.string(),
  foregroundCwd: z.string().optional(),
  agent: z.string().nullable().optional(),
  agentStatus: herdrAgentStatusSchema,
  label: z.string().optional(),
  observationToken: herdrObservationTokenSchema,
});
export type HerdrPane = z.infer<typeof herdrPaneSchema>;

export const herdrSnapshotResponseSchema = z.object({
  session: herdrSessionSummarySchema,
  workspaces: z.array(herdrWorkspaceSchema),
  tabs: z.array(herdrTabSchema),
  panes: z.array(herdrPaneSchema),
  observedAt: z.string(),
});
export type HerdrSnapshotResponse = z.infer<typeof herdrSnapshotResponseSchema>;

export const herdrOutputResponseSchema = z.object({
  sessionName: herdrSessionNameSchema,
  paneId: herdrPaneIdSchema,
  terminalId: herdrTerminalIdSchema,
  observationToken: herdrObservationTokenSchema,
  text: z.string(),
  truncated: z.boolean(),
  observedAt: z.string(),
});
export type HerdrOutputResponse = z.infer<typeof herdrOutputResponseSchema>;

export const herdrInputActionSchema = z.enum(['text', 'text-enter', 'enter', 'escape']);
export type HerdrInputAction = z.infer<typeof herdrInputActionSchema>;

export function isAllowedHerdrInput(action: HerdrInputAction, text: string): boolean {
  if (new TextEncoder().encode(text).byteLength > HERDR_INPUT_MAX_BYTES || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(text)) return false;
  return action === 'text' || action === 'text-enter' ? text.length > 0 : text.length === 0;
}

export const herdrInputRequestSchema = z.object({
  action: herdrInputActionSchema,
  text: z.string().max(HERDR_INPUT_MAX_BYTES).default(''),
  observationToken: herdrObservationTokenSchema,
  terminalId: herdrTerminalIdSchema,
}).strict().refine(({ action, text }) => isAllowedHerdrInput(action, text), {
  message: 'Input must be one line, without control characters, and at most 16 KiB; text actions require text and key actions require empty text.',
});
export type HerdrInputRequest = z.infer<typeof herdrInputRequestSchema>;

export const herdrInputResponseSchema = z.object({
  ok: z.literal(true),
  sessionName: herdrSessionNameSchema,
  paneId: herdrPaneIdSchema,
  outcome: z.literal('accepted_not_delivered'),
  message: z.string(),
  observedAt: z.string(),
});
export type HerdrInputResponse = z.infer<typeof herdrInputResponseSchema>;

export type HerdrApiEnvelope<T> = { data: T };
