import { z } from 'zod';

export const herdrManagedSelectionSchema = z.object({
  selectedSessionName: z.string().regex(/^[A-Za-z0-9._-]{1,80}$/),
}).strict();
export type HerdrManagedSelection = z.infer<typeof herdrManagedSelectionSchema>;

// Browser-safe projection: never include endpoint paths, argv, environment or credentials.
export type HerdrManagedPublicInstance = Readonly<{
  name: string;
  label: string;
  status: 'available' | 'unavailable' | 'unknown';
}>;
export type HerdrManagedPlacement = Readonly<{
  sessionName: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
  terminalId: string;
}>;
export type HerdrManagedProvisionStatus = 'selection_required' | 'unavailable' | 'provisioning' | 'unknown' | 'ready';
export type HerdrManagedPublicSelection = Readonly<{
  selectedSessionName: string | null;
  instances: readonly HerdrManagedPublicInstance[];
  status: HerdrManagedProvisionStatus;
}>;
export type EnsureManagedConversationResult =
  | Readonly<{ status: 'ready'; appSessionId: string; providerSessionId: string; ownerGeneration: string; placement: HerdrManagedPlacement }>
  | Readonly<{ status: Exclude<HerdrManagedProvisionStatus, 'ready'>; appSessionId: string; providerSessionId: string | null; ownerGeneration: string | null; selectedSessionName: string | null }>;

// Internal durable records; do not serialize these as public selection responses.
// Private credentials/config belong to the server-side owner, not this contract.
export type HerdrManagedEndpointIdentity = Readonly<{
  name: string;
  canonicalPath: string;
  dev: number;
  inode: number;
}>;
export type HerdrManagedProvisionIntent = Readonly<{
  appSessionId: string;
  ownerGeneration: string;
  selectedSessionName: string;
  endpoint: HerdrManagedEndpointIdentity;
  phase: 'reserved' | 'workspace_requested' | 'workspace_created' | 'layout_requested' | 'layout_created' | 'ready' | 'unknown';
  workspaceId: string | null;
  placement: HerdrManagedPlacement | null;
  providerSessionId: string | null;
  updatedAt: string;
}>;
