import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CUA_SAFE_TOOLS,
  CuaDriverClient,
  CuaDriverResponseError,
  CuaTransportError,
  isCuaSafeTool,
} from './cua-client.js';

test('CUA allowlist includes reviewed inspection and action tools only', () => {
  assert.equal(isCuaSafeTool('get_window_state'), true);
  assert.equal(isCuaSafeTool('set_window_frame'), true);
  assert.equal(isCuaSafeTool('kill_app'), false);
  assert.equal(isCuaSafeTool('clipboard_read'), false);
  assert.equal(isCuaSafeTool('start_recording'), false);
  assert.equal(new Set(CUA_SAFE_TOOLS).size, CUA_SAFE_TOOLS.length);
});

async function withDriverFixture(
  source: string,
  callback: (marker: string) => Promise<void>,
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cua-client-')));
  const executable = join(root, 'driver.mjs');
  const previous = process.env.CUA_DRIVER_PATH;
  const previousMarker = process.env.CUA_EFFECT_MARKER;
  await writeFile(executable, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
  await chmod(executable, 0o700);
  process.env.CUA_DRIVER_PATH = executable;
  try {
    const marker = join(root, 'effect');
    process.env.CUA_EFFECT_MARKER = marker;
    await callback(marker);
  } finally {
    if (previous === undefined) delete process.env.CUA_DRIVER_PATH;
    else process.env.CUA_DRIVER_PATH = previous;
    if (previousMarker === undefined) delete process.env.CUA_EFFECT_MARKER;
    else process.env.CUA_EFFECT_MARKER = previousMarker;
    await rm(root, { recursive: true, force: true });
  }
}

test('driver status never reads not-granted or unauthorized as permission', { skip: process.platform !== 'darwin' }, async () => {
  await withDriverFixture(
    `if (process.argv.includes('permissions')) console.log('Accessibility: not granted\\nScreen Recording: unauthorized');
else if (process.argv.includes('--version')) console.log('fixture-driver');
else process.exit(1);`,
    async () => {
      const client = new CuaDriverClient();
      try {
        const status = await client.status();
        assert.equal(status.accessibility, false);
        assert.equal(status.screenRecording, false);
      } finally { await client.shutdown(); }
    },
  );
});

test('CUA client preserves possible dispatch when a side effect outlives its lost reply', async () => {
  await withDriverFixture(
    `import { appendFileSync } from 'node:fs';
import readline from 'node:readline';
const marker = process.env.CUA_EFFECT_MARKER;
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
  if (request.method === 'tools/call') {
    appendFileSync(marker, 'effect\\n');
    process.exit(0);
  }
});`,
    async (marker) => {
      const client = new CuaDriverClient();
      try {
        await assert.rejects(
          client.call('click', {}),
          (error: unknown) => error instanceof CuaTransportError
            && error.dispatchState === 'possibly_dispatched',
        );
        assert.equal(await readFile(marker, 'utf8'), 'effect\n');
      } finally { await client.shutdown(); }
    },
  );
});

test('CUA client exposes structured driver rejection separately from transport loss', async () => {
  await withDriverFixture(
    `import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
  if (request.method === 'tools/call') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32001, message: 'session_suspended' } }) + '\\n');
});`,
    async () => {
      const client = new CuaDriverClient();
      try {
        await assert.rejects(
          client.call('click', {}),
          (error: unknown) => error instanceof CuaDriverResponseError
            && error.kind === 'known-result'
            && error.code === -32001
            && error.message === 'session_suspended',
        );
      } finally { await client.shutdown(); }
    },
  );
});

test('a malformed post-action reply is not treated as a successful outcome', async () => {
  await withDriverFixture(
    `import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
  if (request.method === 'tools/call') {
    writeFileSync(process.env.CUA_EFFECT_MARKER, 'effect');
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id }) + '\\n');
  }
});`,
    async marker => {
      const client = new CuaDriverClient();
      try {
        await assert.rejects(client.call('click', {}), error => error instanceof CuaTransportError && error.dispatchState === 'possibly_dispatched');
        assert.equal(await readFile(marker, 'utf8'), 'effect');
      } finally { await client.shutdown(); }
    },
  );
});

test('CUA client reports an unavailable driver as unsent', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'cua-client-missing-')));
  const previous = process.env.CUA_DRIVER_PATH;
  process.env.CUA_DRIVER_PATH = join(root, 'missing-driver');
  const client = new CuaDriverClient();
  try {
    await assert.rejects(
      client.call('click', {}),
      (error: unknown) => error instanceof CuaTransportError && error.dispatchState === 'not_sent',
    );
  } finally {
    if (previous === undefined) delete process.env.CUA_DRIVER_PATH;
    else process.env.CUA_DRIVER_PATH = previous;
    await client.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test('an already cancelled action does not start the driver', async () => {
  await withDriverFixture(
    `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.CUA_EFFECT_MARKER, 'started');`,
    async marker => {
      const client = new CuaDriverClient();
      const controller = new AbortController();
      controller.abort();
      try {
        await assert.rejects(client.call('click', {}, controller.signal), error => error instanceof CuaTransportError && error.dispatchState === 'not_sent');
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
      } finally { await client.shutdown(); }
    },
  );
});

test('CUA cancellation after write is possible dispatch, not a known rejection', async () => {
  await withDriverFixture(
    `import { writeFileSync } from 'node:fs';
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }) + '\\n');
  if (request.method === 'tools/call') writeFileSync(process.env.CUA_EFFECT_MARKER, 'received');
});`,
    async (marker) => {
      const client = new CuaDriverClient();
      const controller = new AbortController();
      const outcome = client.call('click', {}, controller.signal).then(() => null, error => error);
      try {
        let received = false;
        for (let attempt = 0; attempt < 400 && !received; attempt++) {
          try { received = await readFile(marker, 'utf8') === 'received'; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (!received) await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.equal(received, true, 'the driver must receive the action before cancellation');
        controller.abort();
        const error = await outcome;
        assert.ok(error instanceof CuaTransportError);
        assert.equal(error.dispatchState, 'possibly_dispatched');
      } finally {
        controller.abort();
        await client.shutdown();
      }
    },
  );
});
