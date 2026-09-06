import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { canonicalManagedInvocation, herdrManagedBridgeAttemptSchema, verifyManagedBridgeReceipt } from '../shared/herdr-managed-bridge.js';
import { herdrManagedAutomationIdentitySchema, type HerdrManagedAutomationOperation, type HerdrManagedAutomationProtectedRecord, type HerdrManagedCapability } from '../shared/herdr-managed-protocol.js';

export const AUTOMATION_STORE_MAX_BYTES = 64 * 1024 * 1024;
export const AUTOMATION_STORE_MAX_CHUNKS = 8192;
const MAX_RECORD_BYTES = 8 * 1024 * 1024;
export const automationCanonical = canonicalManagedInvocation;
const hash = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');

/** Private owner-only SQLite; chunks and bearer capabilities never enter the public journal. */
export class ManagedAutomationStore {
  readonly #db: Database.Database;
  constructor(root: string, readonly generation: string) {
    const directory = path.join(root, 'managed-private');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe automation directory.');
    const file = path.join(directory, `${hash(generation)}.sqlite`);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const fileStat = fs.fstatSync(fd);
      if (!fileStat.isFile() || (fileStat.mode & 0o077) || (process.getuid && fileStat.uid !== process.getuid())) throw new Error('Unsafe automation store.');
    } finally { fs.closeSync(fd); }
    this.#db = new Database(file);
    this.#db.pragma('journal_mode = DELETE');
    this.#db.pragma('synchronous = FULL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS chunks (record_id TEXT NOT NULL, operation_id TEXT NOT NULL, idx INTEGER NOT NULL, total INTEGER NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(record_id, idx));
      CREATE TABLE IF NOT EXISTS capability (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operation_capabilities (generation TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  }
  putChunk(raw: Record<string, unknown>, expected?: { provider: string; turn: string }): void {
    const { recordId, operationId, index, total, encoding, data, sha256 } = raw;
    if (Object.keys(raw).some(k => !['kind', 'recordId', 'operationId', 'index', 'total', 'encoding', 'data', 'sha256'].includes(k)) || ![recordId, operationId].every(v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(v)) || !Number.isSafeInteger(index) || !Number.isSafeInteger(total) || Number(index) < 0 || Number(index) >= Number(total) || Number(total) > Math.ceil(MAX_RECORD_BYTES / (48 * 1024)) || encoding !== 'base64' || typeof data !== 'string' || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid automation chunk.');
    const bytes = Buffer.from(data, 'base64');
    if (bytes.toString('base64') !== data || bytes.length === 0 || bytes.length > 48 * 1024 || (Number(index) + 1 < Number(total) && bytes.length !== 48 * 1024)) throw new Error('Invalid automation chunk bytes.');
    this.#db.transaction(() => {
      const prior = this.#db.prepare('SELECT operation_id, total, sha256 FROM chunks WHERE record_id = ? ORDER BY idx').all(recordId) as { operation_id: string; total: number; sha256: string }[];
      if (prior.length !== index || prior.some(v => v.operation_id !== operationId || v.total !== total || v.sha256 !== sha256)) throw new Error('Automation chunk order or identity mismatch.');
      const usage = this.#db.prepare('SELECT COALESCE(SUM(length(bytes)), 0) AS size, COUNT(*) AS count FROM chunks').get() as { size: number; count: number };
      if (usage.size + bytes.length > AUTOMATION_STORE_MAX_BYTES || usage.count >= AUTOMATION_STORE_MAX_CHUNKS) throw new Error('Automation storage safety bound exceeded.');
      this.#db.prepare('INSERT INTO chunks VALUES (?, ?, ?, ?, ?, ?)').run(recordId, operationId, index, total, sha256, bytes);
      if (Number(index) + 1 === total) {
        const record = this.read(String(recordId), String(operationId));
        if (expected && (record.identity.provider !== expected.provider || record.identity.turn !== expected.turn)) throw new Error('Automation chunk owner mismatch.');
      }
    })();
  }
  read(recordId: string, operationId: string): HerdrManagedAutomationProtectedRecord {
    const rows = this.#db.prepare('SELECT * FROM chunks WHERE record_id = ? ORDER BY idx').all(recordId) as { operation_id: string; idx: number; total: number; sha256: string; bytes: Buffer }[];
    if (!rows.length || rows.length !== rows[0].total || rows.some((v, i) => v.idx !== i || v.operation_id !== operationId || v.total !== rows.length || v.sha256 !== rows[0].sha256)) throw new Error('Incomplete automation record.');
    const bytes = Buffer.concat(rows.map(v => v.bytes));
    if (bytes.length > MAX_RECORD_BYTES || hash(bytes) !== rows[0].sha256) throw new Error('Automation record hash mismatch.');
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as HerdrManagedAutomationProtectedRecord;
    const identity = herdrManagedAutomationIdentitySchema.parse(value.identity);
    if (identity.generation !== this.generation || identity.operationId !== operationId || !Object.hasOwn(value, 'arguments') || hash(automationCanonical(value.arguments)) !== identity.argumentsHash) throw new Error('Automation record identity mismatch.');
    return value;
  }
  verify(operation: HerdrManagedAutomationOperation): void {
    const argumentsRecord = this.read(operation.argumentsRef, operation.identity.operationId);
    const attempt = argumentsRecord.attempt && herdrManagedBridgeAttemptSchema.parse(argumentsRecord.attempt);
    if (attempt && (automationCanonical(attempt.identity) !== automationCanonical(operation.identity) || attempt.originalCapabilityGeneration !== operation.capabilityGeneration)) throw new Error('Automation attempt mismatch.');
    if (attempt) {
      const row = this.#db.prepare('SELECT value FROM operation_capabilities WHERE generation = ?').get(attempt.originalCapabilityGeneration) as { value: string } | undefined;
      if (!row) throw new Error('Automation attempt capability missing.');
      const capability = JSON.parse(row.value) as HerdrManagedCapability;
      if (automationCanonical(capability.operationIdentity) !== automationCanonical(attempt.identity) || capability.bridgeInstanceId !== attempt.bridgeInstanceId || capability.sourceOperationId !== attempt.sourceOperationId || automationCanonical(capability.targetBinding) !== automationCanonical(attempt.targetBinding)) throw new Error('Automation attempt capability mismatch.');
    }
    let completedResult: unknown;
    let completed = false;
    for (const ref of [operation.argumentsRef, operation.resultRef, operation.evidenceRef]) {
      if (!ref) continue;
      const record = this.read(ref, operation.identity.operationId);
      if (automationCanonical(record.identity) !== automationCanonical(operation.identity)) throw new Error('Automation reference identity mismatch.');
      if (ref === operation.resultRef && !Object.hasOwn(record, 'result')) throw new Error('Automation result missing.');
      if (ref === operation.evidenceRef) {
        const evidence = record.evidence;
        if (!attempt || !evidence || evidence.verifier !== 'managed-bridge-ledger-v1' || !Number.isFinite(Date.parse(evidence.observedAt))) throw new Error('Unverifiable automation evidence.');
        const receipt = verifyManagedBridgeReceipt(evidence.content, attempt);
        if (receipt.status === 'completed') {
          completed = true;
          completedResult = receipt.response.ok ? receipt.response.result : { error: receipt.response.error };
          if (automationCanonical(record.result) !== automationCanonical(completedResult)) throw new Error('Automation evidence result mismatch.');
        } else if (Object.hasOwn(record, 'result') || operation.resultRef) throw new Error('Non-completed receipt has result.');
      }
    }
    if (operation.resultRef && (!completed || automationCanonical(this.read(operation.resultRef, operation.identity.operationId).result) !== automationCanonical(completedResult))) throw new Error('Automation result is not receipt-backed.');
    if (operation.phase === 'completed' && !completed) throw new Error('Completed automation lacks receipt.');
  }
  persist(record: HerdrManagedAutomationProtectedRecord): string {
    const recordId = randomUUID();
    const bytes = Buffer.from(JSON.stringify(record));
    const total = Math.ceil(bytes.length / (48 * 1024));
    this.#db.transaction(() => {
      for (let index = 0; index < total; index++) this.putChunk({ recordId, operationId: record.identity.operationId, index, total, encoding: 'base64', data: bytes.subarray(index * 48 * 1024, (index + 1) * 48 * 1024).toString('base64'), sha256: hash(bytes) });
    })();
    return recordId;
  }
  capability(value: HerdrManagedCapability | null): void {
    if (value) this.#db.transaction(() => {
      const existing = this.#db.prepare('SELECT value FROM operation_capabilities WHERE generation = ?').get(value.capabilityGeneration) as { value: string } | undefined;
      if (existing && existing.value !== JSON.stringify(value)) throw new Error('Automation capability generation collision.');
      const count = this.#db.prepare('SELECT COUNT(*) AS count FROM operation_capabilities').get() as { count: number };
      if (!existing && count.count >= AUTOMATION_STORE_MAX_CHUNKS) throw new Error('Automation capability storage bound exceeded.');
      this.#db.prepare('INSERT OR IGNORE INTO operation_capabilities VALUES (?, ?)').run(value.capabilityGeneration, JSON.stringify(value));
      this.#db.prepare('INSERT INTO capability VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET value = excluded.value').run(JSON.stringify(value));
    })();
    else this.#db.prepare('DELETE FROM capability').run();
  }
  close(): void { this.#db.close(); }
}
