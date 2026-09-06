import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { canonicalManagedInvocation, herdrManagedBridgeAttemptSchema, herdrManagedBridgeReceiptSchema, herdrManagedBridgeResponseSchema, type HerdrManagedBridgeAttempt, type HerdrManagedBridgeLedger, type HerdrManagedBridgeReceipt, type HerdrManagedBridgeReservation, type HerdrManagedBridgeResponse } from '../../../shared/herdr-managed-bridge.js';
import { HERDR_MANAGED_MAX_FRAME_BYTES } from '../../../shared/herdr-managed-protocol.js';

const MAX_ATTEMPTS = 8192;
const MAX_BYTES = 64 * 1024 * 1024;
type Row = { attempt: string; reservation: string | null; receipt: string | null };

/** Durable, owner-only outcome authority. Reservation and fence compete in one transaction. */
export class ManagedBridgeLedger implements HerdrManagedBridgeLedger {
  private readonly db: Database.Database;
  constructor(root: string) {
    const directory = path.resolve(root, 'managed-bridge');
    // Reject symlinks in every existing ancestor, including the configured App home.
    let current = path.parse(directory).root;
    for (const part of directory.slice(current.length).split(path.sep)) {
      current = path.join(current, part);
      if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe managed bridge directory.');
    }
    const stat = fs.lstatSync(directory);
    if ((stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Unsafe managed bridge directory permissions.');
    const file = path.join(directory, 'attempts.sqlite');
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW, 0o600);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw new Error('Unsafe managed bridge ledger.');
    } finally { fs.closeSync(fd); }
    this.db = new Database(file);
    this.db.pragma('journal_mode = DELETE');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('max_page_count = 32768');
    this.db.exec('CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY, attempt TEXT NOT NULL, reservation TEXT, receipt TEXT, budget INTEGER NOT NULL)');
  }
  private key(attempt: HerdrManagedBridgeAttempt): string {
    return createHash('sha256').update(canonicalManagedInvocation(herdrManagedBridgeAttemptSchema.parse(attempt))).digest('hex');
  }
  private row(attempt: HerdrManagedBridgeAttempt): Row | undefined {
    const row = this.db.prepare('SELECT attempt, reservation, receipt FROM attempts WHERE key = ?').get(this.key(attempt)) as Row | undefined;
    if (row && row.attempt !== canonicalManagedInvocation(attempt)) throw new Error('Managed attempt mismatch.');
    return row;
  }
  private insert(attempt: HerdrManagedBridgeAttempt, reservation: string | null, receipt: HerdrManagedBridgeReceipt | null): void {
    const encoded = canonicalManagedInvocation(attempt);
    const budget = Buffer.byteLength(encoded) + (receipt ? Buffer.byteLength(JSON.stringify(receipt)) : HERDR_MANAGED_MAX_FRAME_BYTES);
    const usage = this.db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(budget), 0) AS bytes FROM attempts').get() as { count: number; bytes: number };
    if (usage.count >= MAX_ATTEMPTS || usage.bytes + budget > MAX_BYTES) throw new Error('Managed bridge ledger safety bound exceeded.');
    this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?)').run(this.key(attempt), encoded, reservation, receipt ? JSON.stringify(receipt) : null, budget);
  }
  lookupOutcome(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReceipt {
    const row = this.row(attempt);
    return row?.receipt ? herdrManagedBridgeReceiptSchema.parse(JSON.parse(row.receipt)) : { status: 'unknown', attempt };
  }
  reserveDispatch(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReservation {
    return this.db.transaction((): HerdrManagedBridgeReservation => {
      if (this.row(attempt)) return { status: 'existing', receipt: this.lookupOutcome(attempt) };
      const reservationId = randomUUID();
      this.insert(attempt, reservationId, null);
      return { status: 'reserved', attempt, reservationId };
    }).immediate();
  }
  completeDispatch(attempt: HerdrManagedBridgeAttempt, reservationId: string, response: HerdrManagedBridgeResponse): HerdrManagedBridgeReceipt {
    return this.db.transaction((): HerdrManagedBridgeReceipt => {
      const row = this.row(attempt);
      if (!row || row.reservation !== reservationId) throw new Error('Managed dispatch reservation mismatch.');
      if (row.receipt) return this.lookupOutcome(attempt);
      const receipt = herdrManagedBridgeReceiptSchema.parse({ status: 'completed', attempt, response: herdrManagedBridgeResponseSchema.parse(response), completedAt: new Date().toISOString(), receiptId: randomUUID() });
      const encoded = JSON.stringify(receipt);
      this.db.prepare('UPDATE attempts SET receipt = ?, budget = ? WHERE key = ?')
        .run(encoded, Buffer.byteLength(row.attempt) + Buffer.byteLength(encoded), this.key(attempt));
      return receipt;
    }).immediate();
  }
  fenceUndispatched(attempt: HerdrManagedBridgeAttempt): HerdrManagedBridgeReceipt {
    return this.db.transaction((): HerdrManagedBridgeReceipt => {
      if (this.row(attempt)) return this.lookupOutcome(attempt);
      const receipt = herdrManagedBridgeReceiptSchema.parse({ status: 'not_dispatched', attempt, fenceId: randomUUID(), fencedAt: new Date().toISOString() });
      this.insert(attempt, null, receipt);
      return receipt;
    }).immediate();
  }
  close(): void { this.db.close(); }
}
