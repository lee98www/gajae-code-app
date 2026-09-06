import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { closeConnection } from '../../modules/database/connection.js';
import { initializeManagedChildSession, runHerdrTaskHostStdio, type HerdrTaskHostBootstrap } from '../../gjc-herdr-task-host.js';

const bootstrap: HerdrTaskHostBootstrap = JSON.parse(await readFile(process.argv[2]!, 'utf8'));
process.env.DATABASE_PATH = bootstrap.databasePath;
// No schema initialization here: only the separate App process owns migration.
let child!: ChildProcessWithoutNullStreams;
let stderrBytes = 0;
const host = await runHerdrTaskHostStdio({ bootstrap, createSession: async input => {
  // The production host has already consumed its nonce and exclusive claim.
  child = spawn(process.argv[3]!, ['--tsconfig-override', fileURLToPath(new URL('../../tsconfig.json', import.meta.url)), fileURLToPath(new URL('./herdr-managed-sdk-child.ts', import.meta.url)), process.argv[4]!], {
    cwd: bootstrap.projectPath, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GJC_RUNTIME_API_KEY: 'test-only-no-provider' },
  });
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
  await writeFile(process.argv[5]! + '.owned', JSON.stringify({ hostPid: process.pid, childPid: child.pid }), { mode: 0o600 });
  return initializeManagedChildSession(child, { ...input, agentDir: bootstrap.agentDir!, runConfig: bootstrap.runConfig! });
} });
await writeFile(process.argv[5]!, JSON.stringify({ hostPid: process.pid, childPid: child.pid, ownerGeneration: bootstrap.ownerGeneration, providerSessionId: host.snapshot().providerSessionId }), { mode: 0o600 });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  const deadline = setTimeout(() => { child.kill('SIGKILL'); process.exit(2); }, 8000);
  try { await host.close(); closeConnection(); }
  finally { clearTimeout(deadline); process.exit(0); }
}
process.once('SIGTERM', () => { void close(); });
process.once('SIGINT', () => { void close(); });
child.once('exit', (code, signal) => {
  if (!closing) { console.error(`Owned SDK child exited: code=${code} signal=${signal} stderrBytes=${stderrBytes}`); process.exit(1); }
});
