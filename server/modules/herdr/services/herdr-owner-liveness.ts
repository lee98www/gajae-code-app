import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Exact owner-process identity for one owner generation. The host records
 * its own pid together with the kernel's process start time; a later App can
 * then distinguish "this exact process is gone" from "a process with that
 * pid exists" (pid reuse) and from "cannot tell". Nothing here signals,
 * adopts, replays or deletes anything.
 */
export type OwnerLiveness = 'confirmed_dead' | 'alive' | 'unknown';

const OWNER_FILE = 'owner.json';
const PS = process.platform === 'win32' ? null : '/bin/ps';

/** Kernel-reported start time for a pid, or null when it cannot be read exactly. */
export function processStartToken(pid: number): string | null {
  if (!PS || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const result = spawnSync(PS, ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' });
  const token = result.status === 0 ? result.stdout.trim() : '';
  return token ? token : null;
}

export async function recordOwnerProcess(directory: string, ownerGeneration: string): Promise<void> {
  const startedAt = processStartToken(process.pid);
  if (!startedAt) return;
  await fs.writeFile(path.join(directory, OWNER_FILE), JSON.stringify({ ownerGeneration, pid: process.pid, startedAt }), { mode: 0o600 });
}

/**
 * Confirms death only from exact evidence: the recorded pid no longer exists,
 * or exists with a different kernel start time (reused pid). A live process
 * with the recorded start time is reported alive even when its socket does
 * not answer; anything unreadable stays unknown.
 */
export async function confirmOwnerDeath(directory: string, ownerGeneration: string): Promise<OwnerLiveness> {
  let record: { ownerGeneration?: unknown; pid?: unknown; startedAt?: unknown };
  try {
    const file = path.join(directory, OWNER_FILE);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) return 'unknown';
    record = JSON.parse(await fs.readFile(file, 'utf8')) as typeof record;
  } catch { return 'unknown'; }
  if (record.ownerGeneration !== ownerGeneration || !Number.isSafeInteger(record.pid) || typeof record.startedAt !== 'string' || !record.startedAt) return 'unknown';
  const pid = record.pid as number;
  if (pid <= 1 || pid === process.pid) return 'unknown';
  try { process.kill(pid, 0); } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'confirmed_dead' : 'unknown';
  }
  const current = processStartToken(pid);
  if (!current) return 'unknown';
  return current === record.startedAt ? 'alive' : 'confirmed_dead';
}
