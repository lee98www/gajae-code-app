import { randomUUID } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';

import { pageHerdrManagedState } from '../../../../shared/herdr-managed-state.js';
import { HERDR_MANAGED_MAX_FRAME_BYTES, HERDR_MANAGED_SNAPSHOT_LEASE_MS, managedJsonBytes, herdrManagedAttachResponseSchema, type HerdrManagedSnapshotDescriptor, type HerdrManagedAttachResponse, type HerdrManagedEvent } from '../../../../shared/herdr-managed-protocol.js';

import { herdrManagedDb } from './herdr-managed.db.js';

type SnapshotRow = { snapshot_id: string; app_session_id: string; owner_generation: string; watermark: number; byte_length: number; pages_json: string; lease_expires_at: number; progress_page: number };

export function createHerdrManagedSnapshotsDb(clock: () => number = Date.now) {
  return {
    create(appSessionId: string, ownerGeneration: string): HerdrManagedSnapshotDescriptor {
      return getConnection().transaction(() => {
        const db = getConnection();
        const now = clock();
        db.prepare('DELETE FROM herdr_managed_snapshots WHERE snapshot_id IN (SELECT snapshot_id FROM herdr_managed_snapshots WHERE lease_expires_at <= ? LIMIT 128)').run(now);
        const state = herdrManagedDb.getState(appSessionId, ownerGeneration);
        const pages = pageHerdrManagedState(state);
        const descriptor = { snapshotId: randomUUID(), watermark: state.watermark, byteLength: Buffer.byteLength(pages.join('')), pageCount: pages.length, leaseExpiresAt: now + HERDR_MANAGED_SNAPSHOT_LEASE_MS, identity: state.identity };
        const active = db.prepare('SELECT COUNT(*) AS count FROM herdr_managed_snapshots WHERE app_session_id = ? AND owner_generation = ? AND lease_expires_at > ?')
          .get(appSessionId, ownerGeneration, now) as { count: number };
        if (active.count >= 128) throw new Error('Managed snapshot lease limit reached.');
        db.prepare(`INSERT INTO herdr_managed_snapshots (snapshot_id, app_session_id, owner_generation, watermark, byte_length, pages_json, lease_expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(descriptor.snapshotId, appSessionId, ownerGeneration, state.watermark, descriptor.byteLength, JSON.stringify(pages), descriptor.leaseExpiresAt);
        return descriptor;
      }).immediate();
    },
    page(appSessionId: string, ownerGeneration: string, snapshotId: string, page: number, id = 'page'): HerdrManagedAttachResponse {
      return getConnection().transaction((): HerdrManagedAttachResponse => {
        if (!Number.isSafeInteger(page) || page < 0) throw new Error('Invalid snapshot page.');
        if (!herdrManagedDb.get(appSessionId, ownerGeneration)) throw new Error('Managed owner mismatch.');
        const db = getConnection();
        const row = db.prepare('SELECT * FROM herdr_managed_snapshots WHERE snapshot_id = ? AND app_session_id = ? AND owner_generation = ?').get(snapshotId, appSessionId, ownerGeneration) as SnapshotRow | undefined;
        if (!row) throw new Error('Snapshot identity mismatch.');
        const now = clock();
        if (row.lease_expires_at <= now) return { type: 'snapshot-required', id, reason: 'lease_expired' };
        const pages = JSON.parse(row.pages_json) as string[];
        if (page >= pages.length) throw new Error('Snapshot page out of range.');
        if (page === row.progress_page + 1) {
          row.lease_expires_at = now + HERDR_MANAGED_SNAPSHOT_LEASE_MS;
          db.prepare('UPDATE herdr_managed_snapshots SET progress_page = ?, lease_expires_at = ? WHERE snapshot_id = ?').run(page, row.lease_expires_at, snapshotId);
        }
        return herdrManagedAttachResponseSchema.parse({ type: 'snapshot-page', id, snapshotId, page, chunk: pages[page], leaseExpiresAt: row.lease_expires_at });
      }).immediate();
    },
    replayPage(appSessionId: string, ownerGeneration: string, afterSeq: number, watermark: number, id = 'replay'): HerdrManagedAttachResponse {
      return getConnection().transaction((): HerdrManagedAttachResponse => {
        const binding = herdrManagedDb.get(appSessionId, ownerGeneration);
        if (!binding) throw new Error('Managed owner mismatch.');
        if (!Number.isSafeInteger(afterSeq) || !Number.isSafeInteger(watermark) || afterSeq < 0 || watermark < afterSeq || watermark > binding.lastSeq) throw new Error('Invalid replay range.');
        const events: HerdrManagedEvent[] = [];
        const response = () => ({ type: 'replay' as const, id, afterSeq, watermark, nextSeq: afterSeq + events.length, events, complete: afterSeq + events.length === watermark });
        for (const event of herdrManagedDb.eventsSince(appSessionId, ownerGeneration, afterSeq)) {
          if (event.seq > watermark) break;
          if (event.seq !== afterSeq + events.length + 1) return { type: 'snapshot-required', id, reason: 'gap' };
          events.push(event);
          if (managedJsonBytes(response()) + 1 > HERDR_MANAGED_MAX_FRAME_BYTES) {
            events.pop();
            if (!events.length) return { type: 'snapshot-required', id, reason: 'gap' };
            break;
          }
        }
        if (!events.length && afterSeq !== watermark) return { type: 'snapshot-required', id, reason: 'gap' };
        return herdrManagedAttachResponseSchema.parse(response());
      })();
    },
  };
}
export const herdrManagedSnapshotsDb = createHerdrManagedSnapshotsDb();
