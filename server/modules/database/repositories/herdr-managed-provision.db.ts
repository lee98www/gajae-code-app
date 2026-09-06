import { randomBytes, randomUUID } from 'node:crypto';

import { getConnection } from '../connection.js';
import { createHerdrManagedState, serializeHerdrManagedState } from '../../../../shared/herdr-managed-state.js';
import type { HerdrManagedEndpointIdentity, HerdrManagedPlacement, HerdrManagedProvisionIntent } from '../../../../shared/herdr-managed-provision-protocol.js';

import { appConfigDb } from './app-config.js';
import { sessionsDb } from './sessions.db.js';
import { herdrManagedDb } from './herdr-managed.db.js';

export type ProvisionRecord = HerdrManagedProvisionIntent & { privateDirectory: string; claimNonce: string };
type Row = { app_session_id: string; owner_generation: string; claim_nonce: string; endpoint_json: string; phase: ProvisionRecord['phase']; workspace_id: string | null; placement_json: string | null; provider_session_id: string | null; private_directory: string; updated_at: string };
export const herdrManagedProvisionDb = {
  installId(): string {
    return getConnection().transaction(() => {
      const existing = appConfigDb.get('herdr.managed.installId');
      if (existing) return existing;
      const id = randomUUID(); appConfigDb.set('herdr.managed.installId', id); return id;
    }).immediate();
  },
  selected(): string | null { return appConfigDb.get('herdr.managed.selectedSessionName'); },
  select(name: string): void { appConfigDb.set('herdr.managed.selectedSessionName', name); },
  registerNewSession(id: string, projectPath: string): void {
    const session = sessionsDb.getSessionById(id);
    if (!session || session.provider !== 'gjc' || session.provider_session_id || session.project_path !== projectPath) throw new Error('Managed registration requires a new App GJC session.');
    getConnection().prepare('INSERT OR IGNORE INTO herdr_managed_registrations VALUES (?, ?)').run(id, projectPath);
  },
  projectPath(id: string): string | null {
    return (getConnection().prepare('SELECT project_path FROM herdr_managed_registrations WHERE app_session_id = ?').get(id) as { project_path: string } | undefined)?.project_path ?? null;
  },
  get(id: string): ProvisionRecord | null {
    const row = getConnection().prepare('SELECT * FROM herdr_managed_provisions WHERE app_session_id = ?').get(id) as Row | undefined;
    if (!row) return null;
    const endpoint = JSON.parse(row.endpoint_json) as HerdrManagedEndpointIdentity;
    return { appSessionId: id, ownerGeneration: row.owner_generation, claimNonce: row.claim_nonce, endpoint, selectedSessionName: endpoint.name, phase: row.phase, workspaceId: row.workspace_id, placement: row.placement_json ? JSON.parse(row.placement_json) as HerdrManagedPlacement : null, providerSessionId: row.provider_session_id, privateDirectory: row.private_directory, updatedAt: row.updated_at };
  },
  reserve(id: string, endpoint: HerdrManagedEndpointIdentity, directory: string): ProvisionRecord {
    return getConnection().transaction(() => {
      const old = this.get(id); if (old) return old;
      if (!this.projectPath(id)) throw new Error('Session is not registered as managed.');
      const generation = randomUUID();
      getConnection().prepare(`INSERT INTO herdr_managed_provisions (app_session_id, owner_generation, claim_nonce, endpoint_json, phase, private_directory) VALUES (?, ?, ?, ?, 'reserved', ?)`).run(id, generation, randomBytes(32).toString('hex'), JSON.stringify(endpoint), directory);
      getConnection().prepare(`INSERT INTO herdr_managed_bindings (app_session_id, owner_generation, herdr_instance_id, lifecycle) VALUES (?, ?, ?, 'reserved')`).run(id, generation, endpoint.name);
      getConnection().prepare('INSERT INTO herdr_managed_state VALUES (?, ?, ?)').run(id, generation, serializeHerdrManagedState(createHerdrManagedState({ appSessionId: id, ownerGeneration: generation })));
      return this.get(id)!;
    }).immediate();
  },
  cas(id: string, generation: string, from: ProvisionRecord['phase'], to: ProvisionRecord['phase'], workspaceId: string | null = null, placement: HerdrManagedPlacement | null = null): boolean {
    return getConnection().prepare(`UPDATE herdr_managed_provisions SET phase = ?, workspace_id = COALESCE(?, workspace_id), placement_json = COALESCE(?, placement_json), updated_at = CURRENT_TIMESTAMP WHERE app_session_id = ? AND owner_generation = ? AND phase = ?`).run(to, workspaceId, placement ? JSON.stringify(placement) : null, id, generation, from).changes === 1;
  },
  workspace(key: string): { phase: string; workspace_id: string | null } | null {
    return getConnection().prepare('SELECT phase, workspace_id FROM herdr_managed_workspaces WHERE endpoint_key = ?').get(key) as { phase: string; workspace_id: string | null } | undefined ?? null;
  },
  requestWorkspace(key: string): boolean { return getConnection().prepare(`INSERT OR IGNORE INTO herdr_managed_workspaces VALUES (?, 'requested', NULL)`).run(key).changes === 1; },
  finishWorkspace(key: string, workspaceId: string): void {
    if (getConnection().prepare(`UPDATE herdr_managed_workspaces SET phase = 'ready', workspace_id = ? WHERE endpoint_key = ? AND phase = 'requested'`).run(workspaceId, key).changes !== 1) throw new Error('Workspace receipt conflict.');
  },
  claimLaunch(id: string, generation: string, nonce: string): void {
    if (getConnection().prepare(`UPDATE herdr_managed_provisions SET launch_claimed = 1 WHERE app_session_id = ? AND owner_generation = ? AND claim_nonce = ? AND launch_claimed = 0 AND phase IN ('layout_requested', 'layout_created', 'unknown')`).run(id, generation, nonce).changes !== 1) throw new Error('Managed launch already claimed or invalid.');
  },
  assertReadyProjection(id: string, generation: string): void {
    const record = this.get(id);
    const binding = herdrManagedDb.get(id, generation);
    if (!record || record.ownerGeneration !== generation || record.phase !== 'ready' || !record.placement || !record.providerSessionId
      || binding?.providerSessionId !== record.providerSessionId || sessionsDb.getSessionById(id)?.provider_session_id !== record.providerSessionId) throw new Error('Managed ready projection is required.');
  },
  projectReady(id: string, generation: string, providerId: string): ProvisionRecord {
    return getConnection().transaction(() => {
      const record = this.get(id);
      const binding = herdrManagedDb.get(id, generation);
      if (!record || record.ownerGeneration !== generation || !record.placement || !providerId || providerId === id || binding?.providerSessionId !== providerId || ['reserved', 'claiming', 'unknown', 'interrupted', 'closed'].includes(binding.lifecycle) || !['layout_created', 'unknown', 'ready'].includes(record.phase)) throw new Error('Managed readiness identity mismatch.');
      const claimed = getConnection().prepare('SELECT launch_claimed FROM herdr_managed_provisions WHERE app_session_id = ? AND owner_generation = ?').get(id, generation) as { launch_claimed: number };
      if (claimed.launch_claimed !== 1) throw new Error('Managed launch was not claimed.');
      const session = sessionsDb.getSessionById(id);
      if (session?.provider_session_id && session.provider_session_id !== providerId) throw new Error('Managed provider mapping conflict.');
      if (!session?.provider_session_id) sessionsDb.assignProviderSessionId(id, 'gjc', providerId);
      const p = record.placement;
      getConnection().prepare('UPDATE herdr_managed_bindings SET workspace_id = ?, tab_id = ?, pane_id = ?, terminal_id = ? WHERE app_session_id = ? AND owner_generation = ?').run(p.workspaceId, p.tabId, p.paneId, p.terminalId, id, generation);
      if (getConnection().prepare(`UPDATE herdr_managed_provisions SET phase = 'ready', provider_session_id = ?, updated_at = CURRENT_TIMESTAMP WHERE app_session_id = ? AND owner_generation = ? AND phase = ?`).run(providerId, id, generation, record.phase).changes !== 1) throw new Error('Managed readiness projection conflict.');
      return this.get(id)!;
    }).immediate();
  },
  projectState(id: string, generation: string, watermark: number, projection: { providerSessionId: string; title: string | null; jsonlPath?: string }): boolean {
    return getConnection().transaction(() => {
      const record = this.get(id);
      if (!record || record.ownerGeneration !== generation || record.phase !== 'ready' || record.providerSessionId !== projection.providerSessionId) throw new Error('Managed projection identity mismatch.');
      if (!Number.isSafeInteger(watermark) || watermark < 0) throw new Error('Invalid managed projection cursor.');
      const key = `herdr.managed.projection.${id}`;
      const raw = appConfigDb.get(key);
      const cursor = raw ? JSON.parse(raw) as { generation: string; watermark: number } : null;
      if (cursor?.generation === generation && cursor.watermark >= watermark) return false;
      const session = sessionsDb.getSessionById(id);
      if (session?.provider_session_id !== projection.providerSessionId) throw new Error('Managed provider mapping conflict.');
      if (projection.title) sessionsDb.applyGeneratedSessionName(id, projection.title);
      if (projection.jsonlPath) getConnection().prepare('UPDATE sessions SET jsonl_path = ? WHERE session_id = ? AND provider_session_id = ?').run(projection.jsonlPath, id, projection.providerSessionId);
      appConfigDb.set(key, JSON.stringify({ generation, watermark }));
      return true;
    }).immediate();
  },
};
