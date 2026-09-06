import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import test from 'node:test';

import { closeConnection, initializeDatabase, sessionsDb, herdrManagedProvisionDb } from '@/modules/database/index.js';
import { herdrManagedDb } from '@/modules/database/repositories/herdr-managed.db.js';

import { HERDR_MANAGED_PROTOCOL_VERSION, type HerdrManagedCommand, type HerdrManagedCommandReceipt } from '../shared/herdr-managed-protocol.js';
import { type HerdrManagedBridgeRequest } from '../shared/herdr-managed-bridge.js';
import { projectManagedState } from '../shared/herdr-managed-chat.js';

import { commandHash, confirmChildExit, HerdrTaskHost, initializeManagedChildSession, runHerdrTaskHostStdio, type ManagedSdkSessionFactory } from './gjc-herdr-task-host.js';
import { GjcHerdrAutomationBroker } from './gjc-herdr-automation-broker.js';
import { parseConsoleLine, sanitizeConsoleText } from './gjc-herdr-task-console.js';
import { ManagedBridgeLedger } from './modules/automation/managed-bridge-ledger.js';
import { HerdrManagedAttachClient } from './modules/herdr/index.js';
import { HerdrAgentReporter } from './modules/herdr/services/herdr-agent-reporter.js';

async function withManagedDatabase(action: (tmp: string) => void | Promise<void>): Promise<void> {
  const previous = process.env.DATABASE_PATH;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'gajae-herdr-managed-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(tmp, 'app.sqlite');
  try {
    await initializeDatabase();
    await action(tmp);
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previous;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function promptCommand(actionId: string, text: string): HerdrManagedCommand {
  const payload = { text };
  return {
    protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
    appSessionId: 'managed-session',
    ownerGeneration: 'owner-gen-1',
    actionId,
    kind: 'prompt',
    payloadHash: commandHash(payload),
    payload,
  };
}

test('managed Herdr database reserves, claims and snapshots one durable owner generation', async () => {
  await withManagedDatabase(() => {
    const reserved = herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    assert.equal(reserved.lifecycle, 'reserved');
    assert.equal(reserved.providerSessionId, null);

    herdrManagedDb.beginClaim('managed-session', 'owner-gen-1');
    const claimed = herdrManagedDb.claim({ protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION, appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', providerSessionId: 'provider-session-1' });
    assert.equal(claimed.lifecycle, 'ready');
    assert.equal(claimed.providerSessionId, 'provider-session-1');

    const receipt = herdrManagedDb.recordCommand({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', actionId: 'a1', kind: 'prompt', payloadHash: commandHash({ text: 'hello' }), state: 'admitted', message: 'Prompt admitted.' });
    assert.equal(receipt.seq, claimed.lastSeq + 1);
    assert.equal(herdrManagedDb.recordCommand({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', actionId: 'a1', kind: 'prompt', payloadHash: commandHash({ text: 'hello' }), state: 'admitted', message: 'Prompt admitted.' }).seq, receipt.seq);
    assert.throws(() => herdrManagedDb.recordCommand({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', actionId: 'a1', kind: 'prompt', payloadHash: commandHash({ text: 'different' }), state: 'admitted', message: 'Prompt admitted.' }));

    const snapshot = herdrManagedDb.snapshot('managed-session', 'owner-gen-1');
    assert.equal(snapshot.watermark, receipt.seq);
    assert.equal(herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', claimed.lastSeq)[0]?.kind, 'managed.command');
    assert.equal(snapshot.commands.a1?.actionId, 'a1');
  });
});

test('independent host publishes actual native ownership through the real database and guarded Herdr RPC', { timeout: 20_000 }, async () => {
  await withManagedDatabase(async tmp => {
    const directory = await fs.realpath(tmp);
    const socketPath = path.join(directory, 'herdr.sock');
    const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
    let disposed = false;
    let publication: Record<string, unknown> | null = null;
    const tokens: Record<string, string> = { foreign_key: 'preserve' };
    const peers = new Set<net.Socket>();
    const server = net.createServer(socket => {
      peers.add(socket);
      socket.once('close', () => peers.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as { id: string; method: string; params: Record<string, unknown> };
        if (request.method === 'session.snapshot') {
          socket.end(JSON.stringify({ id: request.id, result: { type: 'session_snapshot', snapshot: {
            version: 'fixture-19', protocol: 19, layouts: [], agents: [],
            workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
            tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: 'Owned', focused: false, pane_count: 1, agent_status: 'idle' }],
            panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: 'terminal-1', focused: false,
              agent: publication ? 'gjc' : null, agent_status: publication?.state ?? 'idle',
              tokens: { ...tokens } }],
          } } }) + '\n');
        } else {
          assert.ok(['pane.report_agent', 'pane.report_metadata', 'pane.release_agent'].includes(request.method));
          if (request.method === 'pane.release_agent') assert.equal(disposed, true, 'release follows native owner closure');
          calls.push({ method: request.method, params: request.params });
          if (request.method === 'pane.report_metadata') {
            for (const [key, value] of Object.entries(request.params.tokens as Record<string, string | null>)) {
              if (value === null) { assert.equal(disposed, true); delete tokens[key]; }
              else tokens[key] = value;
            }
          } else publication = request.method === 'pane.report_agent' ? request.params : null;
          socket.end(JSON.stringify({ id: request.id, result: { type: 'ok' } }) + '\n');
        }
      });
    });
    let host: HerdrTaskHost | undefined;
    let viewer: HerdrManagedAttachClient | undefined;
    let finishTurn: (() => void) | undefined;
    let promptTask: Promise<HerdrManagedCommandReceipt> | undefined;
    let publishAsk: (() => Promise<void>) | undefined;
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        assert.ok(Date.now() < deadline, 'Native publication deadline');
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    };
    try {
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      // Existing Herdr admission checks UID/socket identity, not a new mandatory mode.
      await fs.chmod(socketPath, 0o700);
      const socketStat = await fs.lstat(socketPath);
      sessionsDb.createAppSession('reported-app', 'gjc', directory);
      herdrManagedProvisionDb.registerNewSession('reported-app', directory);
      const provision = herdrManagedProvisionDb.reserve('reported-app', {
        name: 'selected', canonicalPath: socketPath, dev: socketStat.dev, inode: socketStat.ino,
      }, directory);
      assert.equal(herdrManagedProvisionDb.cas('reported-app', provision.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
      assert.equal(herdrManagedProvisionDb.cas('reported-app', provision.ownerGeneration, 'workspace_requested', 'workspace_created', 'w1'), true);
      assert.equal(herdrManagedProvisionDb.cas('reported-app', provision.ownerGeneration, 'workspace_created', 'layout_requested', 'w1'), true);
      let started = false;
      host = new HerdrTaskHost({
        bootstrap: { appSessionId: 'reported-app', ownerGeneration: provision.ownerGeneration, herdrInstanceId: 'selected',
          projectPath: directory, sessionRoot: directory, databasePath: path.join(tmp, 'app.sqlite'), claimNonce: provision.claimNonce,
          attachSocketPath: path.join(directory, 'attach.sock'), attachSecret: 's'.repeat(32) },
        launchEnvironment: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1' },
        createSession: ({ onEvent }) => ({
          providerSessionId: 'actual-native-id',
          async prompt(_text, actionId) {
            started = true;
            publishAsk = () => Promise.resolve(onEvent({
              version: 1, generation: provision.ownerGeneration, requestId: 'private-prompt', runId: actionId, type: 'event', eventSeq: 1,
              event: { kind: 'permission_request', requestId: 'sdk-ask:owned', toolName: 'ask',
                input: { questions: [{ question: 'Continue?', options: [{ label: 'yes' }], multiSelect: false }] } },
            }));
            await new Promise<void>(resolve => { finishTurn = resolve; });
          },
          validateApproval: () => true,
          resolveApproval: () => { finishTurn?.(); return true; },
          dispose: () => { disposed = true; finishTurn?.(); },
        }),
      });
      await host.initialize();
      assert.ok(['pending', 'published'].includes(host.agentPublication?.status ?? ''));
      assert.equal(herdrManagedProvisionDb.get('reported-app')?.placement?.paneId, 'w1:p1');
      assert.equal(herdrManagedProvisionDb.get('reported-app')?.phase, 'ready');
      await host.startPrivateAttachServer();
      await wait(() => calls.some(call => call.params.state === 'idle'));
      viewer = new HerdrManagedAttachClient({ appSessionId: 'reported-app', ownerGeneration: provision.ownerGeneration,
        socketPath: path.join(directory, 'attach.sock'), attachSecret: 's'.repeat(32) });
      await viewer.connect();
      viewer.close();
      const payload = { text: 'owned task' };
      promptTask = host.dispatch({ protocolVersion: 1, appSessionId: 'reported-app', ownerGeneration: provision.ownerGeneration,
        actionId: 'owned-turn', kind: 'prompt', payload, payloadHash: commandHash(payload) });
      await wait(() => started && calls.some(call => call.params.state === 'working'));
      assert.ok(publishAsk);
      await publishAsk();
      await wait(() => calls.some(call => call.params.state === 'blocked'));
      const pending = Object.values(host.snapshot().requests)[0];
      assert.ok(pending);
      const answer = { providerSessionId: pending.providerSessionId, turnId: pending.turnId,
        requestId: pending.requestId, policyRevision: pending.policyRevision, answer: 'yes' };
      const result = await host.dispatch({ protocolVersion: 1, appSessionId: 'reported-app', ownerGeneration: provision.ownerGeneration,
        actionId: 'answer-owned', kind: 'answer', payload: answer, payloadHash: commandHash(answer) });
      assert.equal(result.state, 'settled');
      await promptTask;
      await wait(() => calls.filter(call => call.params.state === 'idle').length === 2);
      assert.equal(tokens.gajae_native_session_id, 'actual-native-id');
      assert.equal(tokens.gajae_owner_generation, provision.ownerGeneration);
      assert.equal(tokens.gajae_app_session_id, 'reported-app');
      for (const call of calls.filter(call => call.method === 'pane.report_agent')) {
        assert.equal(call.params.agent, 'gjc');
        assert.equal('agent_session_id' in call.params, false);
        assert.equal(call.params.pane_id, 'w1:p1');
        assert.equal('agent_session_path' in call.params, false);
      }
      assert.equal(new Set(calls.map(call => call.params.source)).size, 1);
      await host.close();
      assert.equal(calls.at(-1)?.method, 'pane.release_agent');
      assert.equal(host.agentPublication?.status, 'released');
      assert.deepEqual(tokens, { foreign_key: 'preserve' });
      const sequences = calls.map(call => Number(call.params.seq));
      assert.ok(sequences.every((seq, index) => index === 0 || seq > sequences[index - 1]));
      assert.doesNotMatch(JSON.stringify(calls), /owned task|Continue\?|claimNonce|attachSecret|session_path/);
    } finally {
      viewer?.close();
      finishTurn?.();
      await host?.close();
      await promptTask?.catch(() => {});
      for (const socket of peers) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

test('production host rejects inherited identity before constructing the SDK', async () => {
  await withManagedDatabase(async tmp => {
    sessionsDb.createAppSession('host-identity', 'gjc', tmp);
    herdrManagedProvisionDb.registerNewSession('host-identity', tmp);
    const provision = herdrManagedProvisionDb.reserve('host-identity', {
      name: 'selected', canonicalPath: path.join(tmp, 'missing.sock'), dev: 1, inode: 1,
    }, tmp);
    assert.equal(herdrManagedProvisionDb.cas('host-identity', provision.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
    assert.equal(herdrManagedProvisionDb.cas('host-identity', provision.ownerGeneration, 'workspace_requested', 'layout_requested', 'w1'), true);
    let sdkCalls = 0;
    const host = new HerdrTaskHost({
      bootstrap: {
        appSessionId: 'host-identity',
        ownerGeneration: provision.ownerGeneration,
        herdrInstanceId: 'selected',
        projectPath: tmp,
        sessionRoot: tmp,
        databasePath: path.join(tmp, 'app.sqlite'),
        claimNonce: provision.claimNonce,
      },
      launchEnvironment: { HERDR_WORKSPACE_ID: 'w2', HERDR_TAB_ID: 'w2:t1', HERDR_PANE_ID: 'w2:p1' },
      createSession: () => { sdkCalls++; return { providerSessionId: 'must-not-start', async prompt() {} }; },
    });
    await assert.rejects(host.initialize(), /workspace intent mismatch/);
    assert.equal(sdkCalls, 0);
  });
});

test('production host rejects an inherited tab or pane that disagrees with the durable receipt', async () => {
  await withManagedDatabase(async tmp => {
    for (const [suffix, launchEnvironment] of [
      ['tab', { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t2', HERDR_PANE_ID: 'w1:p1' }],
      ['pane', { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p2' }],
    ] as const) {
      const id = `host-identity-${suffix}`;
      sessionsDb.createAppSession(id, 'gjc', tmp);
      herdrManagedProvisionDb.registerNewSession(id, tmp);
      const provision = herdrManagedProvisionDb.reserve(id, { name: 'selected', canonicalPath: path.join(tmp, `${suffix}.sock`), dev: 1, inode: 1 }, tmp);
      assert.equal(herdrManagedProvisionDb.cas(id, provision.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
      assert.equal(herdrManagedProvisionDb.cas(id, provision.ownerGeneration, 'workspace_requested', 'layout_requested', 'w1'), true);
      herdrManagedProvisionDb.recordLayoutReceipt(id, provision.ownerGeneration, {
        sessionName: 'selected', workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1',
      });
      let sdkCalls = 0;
      const host = new HerdrTaskHost({
        bootstrap: { appSessionId: id, ownerGeneration: provision.ownerGeneration, herdrInstanceId: 'selected', projectPath: tmp, sessionRoot: tmp, databasePath: path.join(tmp, 'app.sqlite'), claimNonce: provision.claimNonce },
        launchEnvironment: { ...launchEnvironment },
        createSession: () => { sdkCalls++; return { providerSessionId: 'must-not-start', async prompt() {} }; },
      });
      await assert.rejects(host.initialize(), /placement intent mismatch/);
      assert.equal(sdkCalls, 0);
    }
  });
});

test('production host fences readiness when the terminal is replaced after SDK initialization', async () => {
  await withManagedDatabase(async tmp => {
    const directory = await fs.realpath(tmp);
    // macOS's per-user tmpdir leaves too little of sun_path for a descriptive socket name.
    const socketDirectory = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'hs-')));
    const socketPath = path.join(socketDirectory, 'herdr.sock');
    let snapshots = 0;
    const server = net.createServer(socket => {
      socket.on('data', chunk => {
        const request = JSON.parse(String(chunk)) as { id: string; method: string };
        if (request.method !== 'session.snapshot') return;
        snapshots++;
        const terminalId = snapshots === 1 ? 'term-1' : 'term-2';
        socket.end(JSON.stringify({ id: request.id, result: { type: 'session_snapshot', snapshot: {
          version: 'fixture-19', protocol: 19, layouts: [], agents: [],
          workspaces: [{ workspace_id: 'w1', number: 1, label: 'Owned', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w1:t1', agent_status: 'idle' }],
          tabs: [{ workspace_id: 'w1', tab_id: 'w1:t1', number: 1, label: 'Owned', focused: false, pane_count: 1, agent_status: 'idle' }],
          panes: [{ workspace_id: 'w1', tab_id: 'w1:t1', pane_id: 'w1:p1', terminal_id: terminalId, focused: false, agent: null, agent_status: 'idle', tokens: {} }],
        } } }) + '\n');
      });
    });
    try {
      await new Promise<void>(resolve => server.listen(socketPath, resolve));
      const socketStat = await fs.lstat(socketPath);
      sessionsDb.createAppSession('terminal-replaced', 'gjc', directory);
      herdrManagedProvisionDb.registerNewSession('terminal-replaced', directory);
      const provision = herdrManagedProvisionDb.reserve('terminal-replaced', { name: 'selected', canonicalPath: socketPath, dev: socketStat.dev, inode: socketStat.ino }, directory);
      assert.equal(herdrManagedProvisionDb.cas('terminal-replaced', provision.ownerGeneration, 'reserved', 'workspace_requested', 'w1'), true);
      assert.equal(herdrManagedProvisionDb.cas('terminal-replaced', provision.ownerGeneration, 'workspace_requested', 'layout_requested', 'w1'), true);
      let sdkCalls = 0;
      const host = new HerdrTaskHost({
        bootstrap: { appSessionId: 'terminal-replaced', ownerGeneration: provision.ownerGeneration, herdrInstanceId: 'selected', projectPath: directory, sessionRoot: directory, databasePath: path.join(tmp, 'app.sqlite'), claimNonce: provision.claimNonce },
        launchEnvironment: { HERDR_WORKSPACE_ID: 'w1', HERDR_TAB_ID: 'w1:t1', HERDR_PANE_ID: 'w1:p1' },
        createSession: () => { sdkCalls++; return { providerSessionId: 'provider-replaced', async prompt() {} }; },
      });
      await assert.rejects(host.initialize(), /placement changed/);
      assert.equal(sdkCalls, 1);
      assert.notEqual(herdrManagedProvisionDb.get('terminal-replaced')?.phase, 'ready');
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
      await fs.rm(socketDirectory, { recursive: true, force: true });
    }
  });
});

test('console parser accepts bounded grammar, rejects controls and leaves revisions to the host', () => {
  const context = { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', stateRevision: 7 };
  const prompt = parseConsoleLine(':prompt a1 7 "parser"', context);
  assert.equal(prompt.ok, true);
  if (prompt.ok && prompt.type === 'command') {
    assert.equal(prompt.command.kind, 'prompt');
    assert.deepEqual(prompt.command.payload, { text: 'parser', expectedStateRevision: 7 });
    assert.doesNotMatch(prompt.safeEcho, /\u001b/);
  }
  assert.deepEqual(parseConsoleLine('plain prompt', context), { ok: false, message: 'command_required' });
  assert.equal(parseConsoleLine(':prompt a2 6 "stale"', context).ok, true);
  assert.equal(parseConsoleLine(':prompt a2 7 "\\u001b[31mparser"', context).ok, false);
  assert.deepEqual(parseConsoleLine(':prompt a3 7 "bad\u0000"', context), { ok: false, message: 'unsupported_control_character' });
  assert.equal(sanitizeConsoleText('authorization=BearerSecret \u001b[31mred', 8192, ['BearerSecret']), 'authorization=[redacted] red');
});

test('task host initializes once, keeps the SDK session idle, and dispatches one deterministic prompt', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const prompts: string[] = [];
    let disposed = 0;
    const factory: ManagedSdkSessionFactory = () => ({
      providerSessionId: 'provider-session-1',
      async prompt(message: string) {
        prompts.push(message);
        return { role: 'assistant', content: `result:${message}` };
      },
      async dispose() { disposed++; },
    });
    const host = new HerdrTaskHost({ bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' }, createSession: factory });

    const hello = await host.initialize();
    assert.equal(hello.providerSessionId, 'provider-session-1');
    assert.equal(host.session?.providerSessionId, 'provider-session-1');
    assert.equal(herdrManagedDb.snapshot('managed-session', 'owner-gen-1').lifecycle, 'idle');
    assert.deepEqual(prompts, []);

    const receipt = await host.dispatch(promptCommand('a1', 'hello'));
    assert.equal(receipt.state, 'settled');
    assert.deepEqual(prompts, ['hello']);
    const snapshot = host.snapshot();
    assert.equal(snapshot.lifecycle, 'idle');
    assert.equal(herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', 0).some((event) => event.kind === 'sdk.event'), false);

    const replayed = await host.dispatch(promptCommand('a1', 'hello'));
    assert.equal(replayed.seq, receipt.seq);
    assert.deepEqual(prompts, ['hello']);
    await assert.rejects(host.dispatch({ ...promptCommand('a1', 'hello'), payloadHash: commandHash({ text: 'tampered' }) }));
    const second = await host.dispatch(promptCommand('a2', 'hello'));
    assert.equal(second.state, 'settled');
    assert.deepEqual(prompts, ['hello', 'hello']);
    await host.close();
    assert.equal(disposed, 1);
    assert.equal(herdrManagedDb.snapshot('managed-session', 'owner-gen-1').lifecycle, 'closed');
  });
});

test('task host claims the owner generation before constructing the SDK session', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const factory: ManagedSdkSessionFactory = ({ appSessionId, ownerGeneration }) => {
      assert.equal(herdrManagedDb.snapshot(appSessionId, ownerGeneration).lifecycle, 'claiming');
      return { providerSessionId: 'provider-session-1', async prompt() {} };
    };
    const host = new HerdrTaskHost({ bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' }, createSession: factory });
    await host.initialize();
    assert.equal(herdrManagedDb.snapshot('managed-session', 'owner-gen-1').providerSessionId, 'provider-session-1');
    await host.close();
  });
});

test('task-host stdio launcher uses protected bootstrap and fixture factory without raw protocol frames or duplicate SDK owners', async () => {
  await withManagedDatabase(async (tmp) => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const bootstrapPath = path.join(tmp, 'bootstrap.json');
    await fs.writeFile(bootstrapPath, JSON.stringify({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp }), { mode: 0o600 });
    await fs.chmod(bootstrapPath, 0o600);
    const bootstrap = await (await import('./gjc-herdr-task-host.js')).readBootstrap(bootstrapPath);
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let stdout = '';
    output.on('data', (chunk) => { stdout += String(chunk); });
    const prompts: string[] = [];
    const host = await runHerdrTaskHostStdio({
      bootstrap,
      input,
      output,
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        async prompt(message) {
          prompts.push(message);
          return { content: 'ok' };
        },
      }),
    });
    assert.equal(stdout, 'READY\n');
    input.write(`:prompt a1 ${host.snapshot().watermark} "from-entrypoint"\n`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write(':ack a1\n');
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(prompts, ['from-entrypoint']);
    const receipt = host.snapshot().commands.a1;
    assert.equal(stdout, `READY\nACK a1 settled ${receipt.seq}\nACK a1 settled ${receipt.seq}\n`);
    assert.equal(host.snapshot().commands['ack-a1'], undefined);
    assert.doesNotMatch(stdout, /"snapshot"|"events"|"providerSessionId"|\{/);
    assert.equal(herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', 0).some((event) => event.kind === 'sdk.event'), false);
    await host.close();
  });
});

test('a failed factory confirms the owned child exit before fencing, escalating to SIGKILL and reporting a survivor', async () => {
  const fake = (behaviour: 'term' | 'kill-only' | 'immortal' | 'already-exited') => {
    const emitter = new EventEmitter();
    const child: Parameters<typeof confirmChildExit>[0] & { signals: string[]; signalCode: NodeJS.Signals | null } = Object.assign(emitter, {
      exitCode: behaviour === 'already-exited' ? 0 : null as number | null,
      signalCode: null as NodeJS.Signals | null,
      signals: [] as string[],
      kill(signal: NodeJS.Signals | number = 'SIGTERM') {
        child.signals.push(String(signal));
        const dies = behaviour === 'term' || (behaviour === 'kill-only' && signal === 'SIGKILL');
        if (dies) setTimeout(() => { child.signalCode = signal as NodeJS.Signals; emitter.emit('exit', null, signal); }, 5);
        return true;
      },
    }) as never;
    return child;
  };
  const delays = { escalateMs: 30, deadlineMs: 120 };
  const term = fake('term');
  assert.equal(await confirmChildExit(term, delays), true);
  assert.deepEqual(term.signals, ['SIGTERM']);
  const stubborn = fake('kill-only');
  assert.equal(await confirmChildExit(stubborn, delays), true);
  assert.deepEqual(stubborn.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(stubborn.signalCode, 'SIGKILL');
  const immortal = fake('immortal');
  assert.equal(await confirmChildExit(immortal, delays), false, 'signal dispatch alone is never reported as exit');
  assert.deepEqual(immortal.signals, ['SIGTERM', 'SIGKILL']);
  const gone = fake('already-exited');
  assert.equal(await confirmChildExit(gone, delays), true);
  assert.deepEqual(gone.signals, []);
});

test('console status exposes safe session, active-turn, queue and request identities', async () => {
  await withManagedDatabase(async tmp => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let stdout = '';
    output.on('data', chunk => { stdout += String(chunk); });
    const host = await runHerdrTaskHostStdio({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp },
      input,
      output,
      createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() {} }),
    });
    const start = stdout.length;
    input.write(':status\n');
    for (let index = 0; index < 100 && !stdout.slice(start).includes('activeTurnId='); index++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.match(stdout.slice(start), /STATUS idle \d+ appSessionId=managed-session ownerGeneration=owner-gen-1 providerSessionId=provider-session-1 activeTurnId=- queue=- requests=-/);
    await host.close();
  });
});

test('an App-started turn that ends unknown is announced on the console with its reason', async () => {
  await withManagedDatabase(async tmp => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let stdout = '';
    output.on('data', chunk => { stdout += String(chunk); });
    const host = await runHerdrTaskHostStdio({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp, attachSocketPath: path.join(tmp, 'attach.sock'), attachSecret: 'k'.repeat(32) },
      input,
      output,
      createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() { throw new Error(`Managed child prompt failed: provider quota exhausted (token ${'k'.repeat(32)})`); } }),
    });
    const command = promptCommand('app-turn', 'from the App');
    await assert.rejects(host.dispatch(command), /provider quota exhausted/);
    for (let i = 0; i < 100 && !stdout.includes('ERROR Prompt outcome is unknown'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    const receipt = host.snapshot().commands['app-turn'];
    assert.equal(receipt.state, 'unknown');
    assert.equal(receipt.message, 'Prompt outcome is unknown. Managed child prompt failed: provider quota exhausted (token [redacted])');
    assert.match(stdout, new RegExp(`ACK app-turn unknown ${receipt.seq}\n`));
    // The bounded reason is rendered for the terminal user, never a known token.
    assert.match(stdout, /ERROR Prompt outcome is unknown\. Managed child prompt failed: provider quota exhausted \(token \[redacted\]\)\n/);
    assert.doesNotMatch(stdout, /k{32}/);
    assert.equal(host.snapshot().lifecycle, 'unknown');
    // A later :ack query answers the reason as well.
    input.write(':ack app-turn\n');
    for (let i = 0; i < 100 && stdout.split('ERROR Prompt outcome is unknown').length < 3; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(stdout.split(`ACK app-turn unknown ${receipt.seq}\n`).length, 3);
    assert.equal(stdout.split('ERROR Prompt outcome is unknown').length, 3);
    assert.doesNotMatch(stdout, /REJECT/);
    await host.close();
  });
});

test('a console-entered turn that ends unknown is announced once and never as a rejected command', async () => {
  await withManagedDatabase(async tmp => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let stdout = '';
    output.on('data', chunk => { stdout += String(chunk); });
    const host = await runHerdrTaskHostStdio({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp },
      input,
      output,
      createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() { throw new Error('Managed child prompt failed: provider quota exhausted'); } }),
    });
    input.write(`:prompt console-turn ${host.snapshot().watermark} "from the console"\n`);
    for (let i = 0; i < 200 && !stdout.includes('ERROR Prompt outcome is unknown'); i++) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 50));
    const receipt = host.snapshot().commands['console-turn'];
    assert.equal(receipt.state, 'unknown');
    assert.equal(stdout.split(`ACK console-turn unknown ${receipt.seq}\n`).length, 2, 'exactly one unknown acknowledgement');
    assert.equal(stdout.split('ERROR Prompt outcome is unknown. Managed child prompt failed: provider quota exhausted\n').length, 2, 'exactly one reason');
    assert.doesNotMatch(stdout, /REJECT/, 'an unknown outcome is never presented as a rejected command');
    assert.doesNotMatch(stdout, /ACK console-turn (admitted|settled|rejected)/);
    assert.equal(host.snapshot().lifecycle, 'unknown');
    await host.close().catch(() => {});
  });
});

test('a terminal user controls an App-started turn from rendered console identity alone', async () => {
  await withManagedDatabase(async tmp => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const input = new PassThrough();
    const output = new PassThrough();
    output.setEncoding('utf8');
    let stdout = '';
    output.on('data', chunk => { stdout += String(chunk); });
    const controls: string[] = [];
    let release!: () => void;
    const host = await runHerdrTaskHostStdio({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp },
      input,
      output,
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        prompt: () => new Promise<void>(resolve => { release = resolve; }),
        async steer(text, _actionId, runId) { controls.push(`steer:${runId}:${text}`); return true; },
        async abort(_actionId, runId) { controls.push(`abort:${runId}`); release(); return true; },
      }),
    });
    const until = async (predicate: () => boolean) => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(resolve => setTimeout(resolve, 5)); assert.ok(predicate()); };
    // The App starts the turn; the terminal learns about it only from what the console prints.
    const started = host.dispatch(promptCommand(crypto.randomUUID(), 'from the App'));
    void started.catch(() => {});
    await until(() => host.snapshot().activeTurnId !== null);
    const statusStart = stdout.length;
    input.write(':status\n');
    await until(() => stdout.slice(statusStart).includes('activeTurnId='));
    const rendered = /STATUS \S+ \d+ appSessionId=(\S+) ownerGeneration=(\S+) providerSessionId=\S+ activeTurnId=(\S+) queue=/.exec(stdout.slice(statusStart));
    assert.ok(rendered);
    const [, appSessionId, ownerGeneration, turn] = rendered;
    assert.equal(appSessionId, 'managed-session'); assert.equal(ownerGeneration, 'owner-gen-1');
    assert.notEqual(turn, '-');
    input.write(`:steer console-steer ${turn} "keep going"\n`);
    await until(() => stdout.includes('ACK console-steer settled'));
    input.write(`:abort console-abort ${turn}\n`);
    await until(() => stdout.includes('ACK console-abort settled'));
    assert.equal((await started).state, 'settled');
    assert.deepEqual(controls, [`steer:${turn}:keep going`, `abort:${turn}`]);
    assert.equal(host.snapshot().activeTurnId, null);
    await host.close();
  });
});

test('private attach clients authenticate, share one host, and EOF leaves owner alive', async () => {
  await withManagedDatabase(async (tmp) => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const prompts: string[] = [];
    const host = new HerdrTaskHost({
      bootstrap: {
        appSessionId: 'managed-session',
        ownerGeneration: 'owner-gen-1',
        herdrInstanceId: 'herdr-main',
        projectPath: '/tmp/project',
        sessionRoot: tmp,
        attachSocketPath: path.join(tmp, 'attach.sock'),
        attachSecret: 's'.repeat(32),
      },
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        async prompt(message) {
          prompts.push(message);
          return { content: `ok:${message}` };
        },
      }),
    });
    await host.initialize();
    await host.startPrivateAttachServer();
    const first = new HerdrManagedAttachClient({ socketPath: path.join(tmp, 'attach.sock'), appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', attachSecret: 's'.repeat(32) });
    const second = new HerdrManagedAttachClient({ socketPath: path.join(tmp, 'attach.sock'), appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', attachSecret: 's'.repeat(32) });
    assert.equal((await first.connect()).type, 'ready');
    assert.equal((await second.connect()).type, 'ready');
    first.close();
    const response = await second.command(promptCommand('a1', 'after-eof'));
    assert.equal(response.type, 'receipt');
    if (response.type === 'receipt') assert.equal(response.receipt.state, 'settled');
    assert.deepEqual(prompts, ['after-eof']);
    assert.equal(host.snapshot().lifecycle, 'idle');
    second.close();
    await host.close();
  });
});

test('SDK-origin ask is durable before acknowledgement and answers race without duplicate resolution', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const resolutions: unknown[] = [];
    let finish!: () => void;
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
      createSession: ({ onEvent }) => ({
        providerSessionId: 'provider-session-1',
        async prompt(_text, actionId) {
          if (actionId === 'queued') {
            assert.equal(projectManagedState(herdrManagedDb.getState('managed-session', 'owner-gen-1')).records.filter(record => record.role === 'user').at(-1)?.content, 'next');
            onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 1, event: { kind: 'tool_use', toolId: 'queued-tool', toolName: 'read', input: { path: 'file' } } });
            onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 2, event: { kind: 'tool_result', toolId: 'queued-tool', content: 'read result', isFinal: true } });
            return;
          }
          onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 1, event: { kind: 'permission_request', requestId: 'sdk-ask:one', toolName: 'ask', input: { questions: [{ question: 'Pick', options: [{ label: 'yes' }] }] } } });
          const request = Object.values(herdrManagedDb.snapshot('managed-session', 'owner-gen-1').requests)[0];
          assert.ok(request);
          assert.notEqual(request.requestId, 'sdk-ask:one');
          assert.ok(herdrManagedDb.getPending({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', providerSessionId: 'provider-session-1', turnId: actionId, requestId: request.requestId }));
          await new Promise<void>((resolve) => { finish = resolve; });
          onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 2, event: { kind: 'stream_end', content: 'current answer' } });
          onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 3, event: { kind: 'complete' } });
        },
        validateApproval() { return true; },
        resolveApproval(_requestId, decision) {
          assert.equal(_requestId, 'sdk-ask:one');
          resolutions.push(decision);
          return true;
        },
      }),
    });
    await host.initialize();
    const running = host.dispatch(promptCommand('turn-1', 'hello'));
    const queued = { ...promptCommand('queued', 'next'), kind: 'followup' as const };
    const admitted = await host.dispatch(queued);
    assert.equal(admitted.state, 'admitted');
    assert.equal((await host.dispatch(queued)).seq, admitted.seq);
    assert.deepEqual(projectManagedState(host.snapshot()).records.filter(record => record.role === 'user').map(record => record.content), ['hello']);
    assert.equal(host.snapshot().queue.entries.length, 1);
    assert.equal((await host.dispatch(promptCommand('busy', 'hello'))).state, 'rejected');
    const unknownPayload = { providerSessionId: 'provider-session-1', turnId: 'turn-1', requestId: 'unknown', answer: 'yes' };
    assert.equal((await host.dispatch({ ...promptCommand('unknown', ''), kind: 'answer', payload: unknownPayload, payloadHash: commandHash(unknownPayload) })).state, 'rejected');
    assert.equal(herdrManagedDb.getRequest({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', providerSessionId: 'provider-session-1', turnId: 'turn-1', requestId: 'unknown' }), null);
    const publicId = Object.keys(host.snapshot().requests)[0];
    const payload = { requestId: `managed-session/owner-gen-1/provider-session-1/turn-1/${publicId}`, answer: 'yes' };
    const first: HerdrManagedCommand = { protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION, appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', actionId: 'p1', kind: 'answer', payload, payloadHash: commandHash(payload) };
    const [firstReceipt] = await Promise.all([host.dispatch(first), host.dispatch(first)]);
    assert.equal(firstReceipt.state, 'settled');
    const second = await host.dispatch({ ...first, actionId: 'p2' });
    assert.equal(second.state, 'rejected');
    assert.equal(resolutions.length, 1);
    assert.deepEqual(resolutions[0], { allow: true, message: 'yes' });
    finish();
    await running;
    const records = projectManagedState(host.snapshot()).records;
    const answerIndex = records.findIndex(record => record.content === 'current answer');
    const completeIndex = records.findIndex(record => record.kind === 'complete');
    const queuedIndex = records.findIndex(record => record.role === 'user' && record.content === 'next');
    const useIndex = records.findIndex(record => record.kind === 'tool_use' && record.toolId === 'queued-tool');
    const resultIndex = records.findIndex(record => record.kind === 'tool_result' && record.toolId === 'queued-tool');
    assert.ok(answerIndex >= 0 && answerIndex < completeIndex && completeIndex < queuedIndex);
    assert.ok(queuedIndex < useIndex && useIndex < resultIndex);
    assert.equal(records[useIndex].turnId, 'queued');
    assert.equal(records[resultIndex].turnId, 'queued');
    await host.close();
  });
});

test('false SDK approval becomes unknown; stale controls never reach the SDK', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    let finish!: () => void;
    let resolutions = 0;
    let controls = 0;
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
      createSession: ({ onEvent }) => ({
        providerSessionId: 'provider-session-1',
        async prompt(_text, actionId) {
          onEvent({ version: 1, generation: 'owner-gen-1', requestId: `action:${actionId}`, runId: actionId, type: 'event', eventSeq: 1, event: { kind: 'permission_request', requestId: 'ask-1', toolName: 'ask', input: { questions: [{ question: 'Answer', options: [], multiSelect: false }] } } });
          await new Promise<void>((resolve) => { finish = resolve; });
        },
        validateApproval() { return true; },
        resolveApproval() { resolutions++; return false; },
        async abort() { controls++; return false; },
      }),
    });
    await host.initialize();
    const running = host.dispatch(promptCommand('turn', 'same'));
    const identity = { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', providerSessionId: 'provider-session-1', turnId: 'turn', requestId: Object.keys(host.snapshot().requests)[0] };
    const payload = { ...identity, message: 'answer' };
    const answer = { ...promptCommand('answer', ''), kind: 'answer' as const, payload, payloadHash: commandHash(payload) };
    assert.equal((await host.dispatch(answer)).state, 'unknown');
    assert.equal(herdrManagedDb.getRequest(identity)?.status, 'unknown');
    assert.equal((await host.dispatch({ ...answer, actionId: 'late' })).state, 'rejected');
    const stale = { turnId: 'old' };
    assert.equal((await host.dispatch({ ...promptCommand('abort', ''), kind: 'abort', payload: stale, payloadHash: commandHash(stale) })).state, 'rejected');
    assert.equal(controls, 0);
    const live = { turnId: 'turn' };
    assert.equal((await host.dispatch({ ...promptCommand('abort-live', ''), kind: 'abort', payload: live, payloadHash: commandHash(live) })).state, 'unknown');
    assert.equal(controls, 1);
    assert.equal(resolutions, 1);
    finish();
    await running;
    await host.close();
  });
});

test('prompt failure commits unknown command, unknown turn and lifecycle fence atomically', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        async prompt() { throw new Error('private child lost'); },
      }),
    });
    await host.initialize();
    await assert.rejects(host.dispatch(promptCommand('unknown-turn', 'ambiguous')));
    const snapshot = host.snapshot();
    assert.equal(snapshot.lifecycle, 'unknown');
    assert.equal(snapshot.activeTurnId, null);
    assert.equal(snapshot.commands['unknown-turn']?.state, 'unknown');
    assert.equal(snapshot.turns['unknown-turn']?.status, 'unknown');
    assert.equal(snapshot.turns['unknown-turn']?.outcome, 'unknown');
    assert.equal(snapshot.queue.paused, true);
    assert.equal(herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', 0).some(event =>
      event.kind === 'command.unknown' && (event.payload as { actionId?: string }).actionId === 'unknown-turn'), true);
    await host.close();
  });
});

test('deny-first resume consumes the old approval across authenticated clients and requires a fresh approval', async () => {
  await withManagedDatabase(async tmp => {
    const identity = { appSessionId: 'resume-session', ownerGeneration: 'resume-owner' };
    const bridgePath = path.join(tmp, 'resume-bridge.sock');
    const bridgeToken = 'a'.repeat(64);
    const invocation = { surface: 'browser', payload: { url: 'https://resume.test', command: 'observe' } };
    const targetBinding = { kind: 'browser-origin' as const, origin: 'https://resume.test', tabId: 'resume-tab' };
    // The ledger rejects symlinked ancestors such as macOS's /var; use the canonical path.
    const ledger = new ManagedBridgeLedger(await fs.realpath(tmp));
    const sockets = new Set<net.Socket>();
    let dispatches = 0;
    const bridge = net.createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString('utf8');
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const request = JSON.parse(buffer.slice(0, newline)) as HerdrManagedBridgeRequest & { id: string; token: string };
        assert.equal(request.token, bridgeToken);
        const send = (result: unknown) => socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
        if (request.type === 'managed-resolve-target') {
          send({
            type: 'managed-target',
            requestId: request.requestId,
            identity: request.identity,
            sourceOperationId: request.sourceOperationId,
            bridgeInstanceId: request.bridgeInstanceId,
            invocationHash: request.identity.argumentsHash,
            targetBinding,
          });
        } else if (request.type === 'managed-dispatch') {
          dispatches++;
          const reservation = ledger.reserveDispatch(request.attempt);
          send(reservation.status === 'reserved'
            ? ledger.completeDispatch(request.attempt, reservation.reservationId, { ok: true, result: { resumed: true } })
            : reservation.receipt);
        } else {
          send(ledger.lookupOutcome(request.attempt));
        }
      });
    });
    await new Promise<void>(resolve => bridge.listen(bridgePath, resolve));
    const clients: HerdrManagedAttachClient[] = [];
    let releaseDenial!: () => void;
    let denialEntered = false;
    let callbackSettled = false;
    let callbackResult: unknown;
    let callbackPromise: Promise<unknown> | undefined;
    herdrManagedDb.reserve({ ...identity, projectPath: tmp, herdrInstanceId: 'resume-herdr' });
    const host = new HerdrTaskHost({
      bootstrap: {
        ...identity,
        herdrInstanceId: 'resume-herdr',
        projectPath: tmp,
        sessionRoot: tmp,
        attachSocketPath: path.join(tmp, 'resume-attach.sock'),
        attachSecret: 's'.repeat(32),
      },
      createSession: ({ onEvent }) => {
        let eventSeq = 0;
        let events = Promise.resolve();
        const broker = new GjcHerdrAutomationBroker({
          generation: identity.ownerGeneration,
          provider: 'resume-provider',
          policyRevision: 0,
          emit: event => {
            events = events.then(() => onEvent({
              version: 1,
              generation: identity.ownerGeneration,
              requestId: 'resume-turn',
              runId: 'resume-turn',
              type: 'event',
              eventSeq: ++eventSeq,
              event,
            }));
          },
          flush: () => events,
        });
        broker.setTurn('resume-turn');
        const denialGate = new Promise<void>(resolve => { releaseDenial = resolve; });
        return {
          providerSessionId: 'resume-provider',
          async prompt() {
            callbackPromise = broker.dispatch({ toolCallId: 'resume-tool', index: 0, request: invocation })
              .then(value => { callbackResult = value; return value; });
            await callbackPromise;
            callbackSettled = true;
          },
          async automationControl(control) {
            if (control.type === 'resume-denied') {
              denialEntered = true;
              await denialGate;
            }
            return broker.control(control);
          },
          async dispose() { broker.abort(); },
        };
      },
    });
    try {
      await host.initialize();
      await host.startPrivateAttachServer();
      const connect = async () => {
        const client = new HerdrManagedAttachClient({
          ...identity,
          socketPath: path.join(tmp, 'resume-attach.sock'),
          attachSecret: 's'.repeat(32),
        });
        clients.push(client);
        await client.connect();
        return client;
      };
      const owner = await connect();
      const observer = await connect();
      const payload = { text: 'resume task' };
      const running = host.dispatch({
        protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
        ...identity,
        actionId: 'resume-turn',
        kind: 'prompt',
        payload,
        payloadHash: commandHash(payload),
      });
      const waitFor = async (predicate: () => boolean) => {
        for (let index = 0; index < 2_000 && !predicate(); index++) await new Promise(resolve => setTimeout(resolve, 2));
        assert.equal(predicate(), true, 'resume host observation deadline');
      };
      await waitFor(() => Object.values(host.snapshot().automation).some(operation => operation.phase === 'waiting_attachment'));
      const waiting = Object.values(host.snapshot().automation).find(operation => operation.phase === 'waiting_attachment')!;
      const currentTransport = {
        transportLocator: bridgePath,
        transportToken: bridgeToken,
        ownerConnectionId: 'caller',
        bridgeInstanceId: 'resume-bridge',
      };
      const bind = await owner.automationControl({
        type: 'bind-capability',
        actionId: 'resume-bind',
        identity: waiting.identity,
        currentTransport,
      });
      assert.equal(bind.type, 'automation-control');
      assert.equal(bind.accepted, true);
      await waitFor(() => Object.values(host.snapshot().automation).some(operation => operation.phase === 'awaiting_reattach_approval'));
      const offered = Object.values(host.snapshot().automation).find(operation => operation.phase === 'awaiting_reattach_approval')!;
      const oldApproval = {
        identity: offered.identity,
        capabilityGeneration: offered.capabilityGeneration,
        approvalRequestId: offered.approvalRequestId,
        decision: 'deny' as const,
      };
      const command = (actionId: string, approval: Omit<typeof oldApproval, 'decision'> & { decision: 'approve' | 'deny' }): HerdrManagedCommand => ({
        protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
        ...identity,
        actionId,
        kind: 'resume',
        payload: approval,
        payloadHash: commandHash(approval),
      });
      const deny = owner.command(command('deny-old', oldApproval));
      await waitFor(() => denialEntered && host.snapshot().commands['deny-old']?.state === 'executing');
      const approveOld = observer.command(command('approve-old', { ...oldApproval, decision: 'approve' }));
      releaseDenial();
      const [denied, staleApproval] = await Promise.all([deny, approveOld]);
      assert.equal(denied.type, 'receipt');
      assert.equal(staleApproval.type, 'receipt');
      if (denied.type === 'receipt') assert.equal(denied.receipt.state, 'settled');
      if (staleApproval.type === 'receipt') assert.equal(staleApproval.receipt.state, 'rejected');
      assert.equal(dispatches, 0);
      assert.equal(callbackSettled, false);
      assert.equal(callbackResult, undefined);
      const renewed = Object.values(host.snapshot().automation).find(operation => operation.identity.operationId === offered.identity.operationId)!;
      assert.equal(renewed.phase, 'awaiting_reattach_approval');
      assert.notEqual(renewed.approvalRequestId, oldApproval.approvalRequestId);
      const freshApproval = {
        identity: renewed.identity,
        capabilityGeneration: renewed.capabilityGeneration,
        approvalRequestId: renewed.approvalRequestId,
        decision: 'approve' as const,
      };
      const fresh = await owner.command(command('approve-fresh', freshApproval));
      assert.equal(fresh.type, 'receipt');
      if (fresh.type === 'receipt') assert.equal(fresh.receipt.state, 'settled');
      await running;
      assert.equal(dispatches, 1);
      assert.equal(callbackSettled, true);
      assert.deepEqual(callbackResult, { resumed: true });
    } finally {
      for (const client of clients) client.close();
      await host.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => bridge.close(() => resolve()));
      ledger.close();
    }
  });
});

test('failed attach bootstrap fences only the claimed generation and disposes its SDK owner', async () => {
  await withManagedDatabase(async tmp => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    let disposed = 0;
    const host = new HerdrTaskHost({
      bootstrap: {
        appSessionId: 'managed-session',
        ownerGeneration: 'owner-gen-1',
        herdrInstanceId: 'herdr-main',
        projectPath: '/tmp/project',
        sessionRoot: tmp,
        attachSocketPath: path.join(tmp, 'already-owned.sock'),
        attachSecret: 's'.repeat(32),
      },
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        async prompt() {},
        async dispose() { disposed++; },
      }),
    });
    await host.initialize();
    await fs.writeFile(path.join(tmp, 'already-owned.sock'), 'foreign');
    await assert.rejects(host.startPrivateAttachServer(), /already exists/);
    assert.equal(disposed, 1);
    assert.equal(host.snapshot().lifecycle, 'interrupted');
    assert.equal(host.snapshot().identity.ownerGeneration, 'owner-gen-1');
    await host.close();
  });
});

test('createSession initialization failure fences the claimed generation without a live owner', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    let attempts = 0;
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
      createSession: async () => {
        attempts++;
        throw new Error('SDK initialization failed');
      },
    });
    await assert.rejects(host.initialize(), /SDK initialization failed/);
    assert.equal(attempts, 1);
    assert.equal(host.snapshot().lifecycle, 'interrupted');
    assert.equal(host.session, null);
    await host.close();
  });
});

test('close rejects with sanitized unconfirmed closure when the owned child cannot close', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    let disposeCalls = 0;
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
      createSession: () => ({
        providerSessionId: 'provider-session-1',
        async prompt() {},
        async dispose() { disposeCalls++; throw new Error('native child close detail'); },
      }),
    });
    await host.initialize();
    const first = host.close();
    assert.strictEqual(first, host.close(), 'close callers share the rejected closure promise');
    await assert.rejects(first, error => {
      assert.equal((error as Error).message, 'Managed owner closure unconfirmed.');
      assert.doesNotMatch((error as Error).message, /native child close detail/);
      return true;
    });
    assert.equal(disposeCalls, 1);
    assert.equal(host.snapshot().lifecycle, 'interrupted');
    await assert.rejects(host.close(), /Managed owner closure unconfirmed/);
  });
});

test('close rejects and fences when reporter cleanup is lost', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const originalRelease = HerdrAgentReporter.prototype.release;
    let releaseCalls = 0;
    HerdrAgentReporter.prototype.release = async function() {
      releaseCalls++;
      return false;
    };
    try {
      const host = new HerdrTaskHost({
        bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
        createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() {} }),
      });
      await host.initialize();
      await assert.rejects(host.close(), error => {
        assert.equal((error as Error).message, 'Managed owner closure unconfirmed.');
        assert.doesNotMatch((error as Error).message, /reporter/);
        return true;
      });
      assert.equal(releaseCalls, 1);
      assert.equal(host.snapshot().lifecycle, 'interrupted');
    } finally {
      HerdrAgentReporter.prototype.release = originalRelease;
    }
  });
});

test('close rejects and fences when the closed lifecycle write fails', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const originalSetLifecycle = herdrManagedDb.setLifecycle;
    herdrManagedDb.setLifecycle = ((appSessionId, ownerGeneration, lifecycle) => {
      if (lifecycle === 'closed') throw new Error('sqlite closure detail');
      return originalSetLifecycle.call(herdrManagedDb, appSessionId, ownerGeneration, lifecycle);
    }) as typeof originalSetLifecycle;
    try {
      const host = new HerdrTaskHost({
        bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc' },
        createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() {} }),
      });
      await host.initialize();
      await assert.rejects(host.close(), error => {
        assert.equal((error as Error).message, 'Managed owner closure unconfirmed.');
        assert.doesNotMatch((error as Error).message, /sqlite closure detail/);
        return true;
      });
      assert.equal(host.snapshot().lifecycle, 'interrupted');
    } finally {
      herdrManagedDb.setLifecycle = originalSetLifecycle;
    }
  });
});

test('attach refuses an existing target without unlinking it', async () => {
  await withManagedDatabase(async (tmp) => {
    const target = path.join(tmp, 'attach.sock');
    await fs.writeFile(target, 'user-owned');
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: tmp, attachSocketPath: target, attachSecret: 's'.repeat(32) },
      createSession: () => ({ providerSessionId: 'provider-session-1', async prompt() {} }),
    });
    await assert.rejects(host.startPrivateAttachServer(), /already exists/);
    assert.equal(await fs.readFile(target, 'utf8'), 'user-owned');
  });
});

test('pinned Bun production transport journals real adapter asks and retains the SDK across same-text turns', { timeout: 30_000 }, async () => {
  await withManagedDatabase(async (tmp) => {
    const script = path.join(tmp, 'test-owned-child.ts');
    const statsFile = path.join(tmp, 'sdk-stats.json');
    await fs.writeFile(script, `
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { runManagedChild } from ${JSON.stringify(fileURLToPath(new URL('./gjc-herdr-managed-child.ts', import.meta.url)))};
import { GjcBunSdkAdapter } from ${JSON.stringify(fileURLToPath(new URL('./gjc-bun-sdk-adapter.ts', import.meta.url)))};
const authStorage = { exportSnapshot: () => ({ credentials: [] }), setRuntimeApiKey() {}, removeRuntimeApiKey() {} };
const model = { id: 'managed-model', provider: 'managed-provider' };
const modelRegistry = { authStorage, getAll: () => [model], getAvailable: () => [model] };
const stats = { creations: 0, prompts: 0, steers: 0, disposed: false, providerSessionId: '' };
const save = () => writeFile(${JSON.stringify(statsFile)}, JSON.stringify(stats));
const createSessionFactory = async (input) => {
  assert.equal(++stats.creations, 1);
  stats.providerSessionId = input.sessionManager.getSessionId();
  await save();
  let ui;
  const listeners = new Set();
  const emit = (event) => { for (const listener of listeners) listener(event); };
  const session = {
    isStreaming: false, model, thinkingLevel: 'high',
    setSdkPermissionMode() {}, setSdkPermissionProvider() {},
    getContextUsage: () => ({ tokens: 1, contextWindow: 100, source: 'exact' }),
    setModelTemporary: async () => {}, setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async prompt(text, options) {
      if (options?.streamingBehavior === 'steer') {
        assert.equal(this.isStreaming, true);
        stats.steers++; await save(); return;
      }
      assert.equal(text, 'same text');
      stats.prompts++; this.isStreaming = true; await save();
      emit({ type: 'thinking_end', content: 'before-ask:' + stats.prompts });
      assert.equal(await ui.select('Continue?', ['yes', 'no']), 'yes');
      emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], stopReason: 'stop' } });
      this.isStreaming = false;
    },
    async abort() {},
    async dispose() { stats.disposed = true; await save(); },
  };
  return { session, setToolUIContext(value) { ui = value; } };
};
await runManagedChild({ createAdapter: async () => new GjcBunSdkAdapter(authStorage, modelRegistry, { settings: { cloneForCwd: async () => ({ override() {} }) }, createSessionFactory }) });
`);
    const bundledBun = fileURLToPath(new URL('../dist-native/bun', import.meta.url));
    const env: NodeJS.ProcessEnv = { ...process.env, GJC_RUNTIME_API_KEY: 'test-only' };
    for (const name of ['TMUX', 'TMUX_PANE', 'KITTY_WINDOW_ID', 'TERM_SESSION_ID', 'WT_SESSION']) delete env[name];
    const child = spawn(bundledBun, [script], { stdio: ['pipe', 'pipe', 'pipe'], env });
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = '';
    output.on('data', (chunk) => { stdout += String(chunk); });
    let releaseTerminal: (() => void) | undefined;
    let terminalSeen = false;
    let ask: { requestId: string; turnId: string; providerSessionId: string } | undefined;
    const observed: string[] = [];
    const wait = async (predicate: () => boolean) => {
      const deadline = Date.now() + 10_000;
      while (!predicate()) {
        assert.equal(child.exitCode, null, 'child remains alive');
        assert.ok(Date.now() < deadline, 'subprocess observation deadline');
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    herdrManagedDb.reserve({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: tmp });
    let host: HerdrTaskHost | undefined;
    try {
      host = await runHerdrTaskHostStdio({
        bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: tmp, sessionRoot: tmp },
        input, output,
        createSession: ({ appSessionId, ownerGeneration, onEvent }) => initializeManagedChildSession(child, {
          appSessionId, ownerGeneration, agentDir: tmp,
          runConfig: { cwd: tmp, sessionRoot: tmp, credential: { kind: 'runtime-env', envVar: 'GJC_RUNTIME_API_KEY' }, modelId: 'managed-model', toolNames: [], spawns: 'deny', bashPolicy: { allowedPrefixes: [] } },
          async onEvent(frame) {
            await onEvent(frame);
            observed.push(String(frame.event.kind));
            if (frame.event.kind === 'permission_request') {
              const providerSessionId = herdrManagedDb.get(appSessionId, ownerGeneration)!.providerSessionId!;
              const publicRequest = Object.values(herdrManagedDb.snapshot(appSessionId, ownerGeneration).requests).find(request => request.turnId === frame.runId);
              assert.ok(publicRequest);
              assert.notEqual(publicRequest.requestId, frame.event.requestId);
              ask = { requestId: publicRequest.requestId, turnId: frame.runId, providerSessionId };
              assert.ok(herdrManagedDb.getPending({ appSessionId, ownerGeneration, ...ask }), 'SDK pending is durable before callback returns and ACK is written');
            }
            if (frame.event.kind === 'complete') {
              terminalSeen = true;
              await new Promise<void>((resolve) => { releaseTerminal = resolve; });
            }
          },
        }),
      });
      assert.equal(stdout, 'READY\n');
      const readyStats = JSON.parse(await fs.readFile(statsFile, 'utf8'));
      assert.equal(readyStats.prompts, 0);
      assert.equal(readyStats.providerSessionId, host.session?.providerSessionId);
      assert.ok(readyStats.providerSessionId);
      assert.notEqual(readyStats.providerSessionId, 'managed-session');
      input.end();
      for (const turn of ['init', 'close']) {
        ask = undefined; terminalSeen = false; releaseTerminal = undefined;
        let settled = false;
        const running: Promise<HerdrManagedCommandReceipt> = host.dispatch(promptCommand(turn, 'same text')).then((receipt) => { settled = true; return receipt; });
        await wait(() => !!ask);
        const pendingAsk = ask as { requestId: string; turnId: string; providerSessionId: string } | undefined;
        assert.ok(pendingAsk);
        assert.equal(settled, false);
        assert.ok(observed.indexOf('thinking') < observed.indexOf('permission_request'));
        const send = (actionId: string, kind: HerdrManagedCommand['kind'], payload: object) => host!.dispatch({ ...promptCommand(actionId, ''), kind, payload, payloadHash: commandHash(payload) });
        assert.equal((await send(`fabricated-${turn}`, 'answer', { ...pendingAsk, requestId: 'fabricated', answer: 'yes' })).state, 'rejected');
        assert.equal(herdrManagedDb.getRequest({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', ...pendingAsk, requestId: 'fabricated' }), null);
        assert.equal((await send(`invalid-${turn}`, 'answer', { ...pendingAsk, answer: 'not-an-option' })).state, 'rejected');
        assert.ok(herdrManagedDb.getPending({ appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', ...pendingAsk }));
        assert.equal((await send(`steer-${turn}`, 'steer', { turnId: turn, text: 'guidance' })).state, 'settled');
        const answerPayload = { ...pendingAsk, answer: 'yes' };
        const answers = await Promise.all([send(`answer-${turn}`, 'answer', answerPayload), send(`answer-${turn}`, 'answer', answerPayload)]);
        assert.equal(answers[0].state, 'settled');
        assert.deepEqual(answers[0], answers[1]);
        await wait(() => terminalSeen);
        assert.equal(settled, false, 'terminal response cannot precede durable ACK');
        releaseTerminal!();
        assert.equal((await running).state, 'settled');
      }
      assert.equal(JSON.parse(await fs.readFile(statsFile, 'utf8')).disposed, false, 'console EOF does not dispose owner');
      await host.close();
      const stats = JSON.parse(await fs.readFile(statsFile, 'utf8'));
      assert.equal(stats.creations, 1);
      assert.equal(stats.prompts, 2);
      assert.equal(stats.steers, 2);
      assert.equal(stats.disposed, true);
    } finally {
      releaseTerminal?.();
      if (child.exitCode === null) child.kill('SIGKILL');
      await exited;
    }
  });
});

test('between-turn events cross the publication boundary and a lost idle journal write is not acknowledged', async () => {
  await withManagedDatabase(async () => {
    herdrManagedDb.reserve({ appSessionId: 'managed-session', projectPath: '/tmp/project', herdrInstanceId: 'herdr-main', ownerGeneration: 'owner-gen-1' });
    const secret = 't'.repeat(32);
    let emit!: (event: Record<string, unknown>, seq: number) => void | Promise<void>;
    const host = new HerdrTaskHost({
      bootstrap: { appSessionId: 'managed-session', ownerGeneration: 'owner-gen-1', herdrInstanceId: 'herdr-main', projectPath: '/tmp/project', sessionRoot: '/tmp/gjc', attachSocketPath: '/tmp/unused.sock', attachSecret: secret },
      createSession: ({ onEvent }) => {
        emit = (event, seq) => onEvent({ version: 1, generation: 'owner-gen-1', requestId: 'action:turn-1', runId: 'turn-1', type: 'event', eventSeq: seq, event });
        return {
          providerSessionId: 'provider-session-1',
          async prompt() {
            await emit({ kind: 'tool_use', toolId: 'browser-1', toolName: 'browser', input: { url: 'https://example.test' } }, 1);
            await emit({ kind: 'stream_end', content: 'done' }, 2);
            await emit({ kind: 'complete' }, 3);
          },
        };
      },
    });
    await host.initialize();
    assert.equal((await host.dispatch(promptCommand('turn-1', 'open'))).state, 'settled');
    // Late runtime state for the browser tool and a notice carrying a known token.
    await emit({ kind: 'managed.idle', afterActionId: 'turn-1', event: { kind: 'tool_result', toolId: 'browser-1', content: `page text with ${secret}`, isFinal: true } }, 4);
    await emit({ kind: 'managed.idle', afterActionId: 'turn-1', event: { kind: 'text', text: `notice ${secret}` } }, 5);
    const idle = herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', 0).filter(event => event.kind === 'sdk.idle');
    assert.equal(idle.length, 2);
    const [lateResult, lateNotice] = idle.map(event => event.payload as { event: Record<string, unknown>; turnId: string });
    assert.deepEqual(lateResult.event, { kind: 'tool_result', toolId: 'browser-1', content: '[Protected automation result]', isError: false, isFinal: true });
    assert.equal(lateResult.turnId, 'turn-1');
    assert.deepEqual(lateNotice.event, { kind: 'text', text: 'notice [redacted]' });
    assert.doesNotMatch(JSON.stringify(idle), new RegExp(secret));
    // A writable owner whose journal write fails has lost an event: the failure
    // reaches the transport instead of being acknowledged as fenced.
    const appendEvent = herdrManagedDb.appendEvent;
    herdrManagedDb.appendEvent = () => { throw new Error('SQLITE_FULL: database or disk is full'); };
    try {
      await assert.rejects(Promise.resolve().then(() => emit({ kind: 'managed.idle', afterActionId: 'turn-1', event: { kind: 'text', text: 'lost' } }, 6)), /SQLITE_FULL/);
    } finally { herdrManagedDb.appendEvent = appendEvent; }
    // A fenced owner's journal is not writable by design; that is not a lost event.
    herdrManagedDb.setLifecycle('managed-session', 'owner-gen-1', 'unknown');
    await emit({ kind: 'managed.idle', afterActionId: 'turn-1', event: { kind: 'text', text: 'after fence' } }, 7);
    assert.equal(herdrManagedDb.eventsSince('managed-session', 'owner-gen-1', 0).filter(event => event.kind === 'sdk.idle').length, 2);
    await host.close().catch(() => {});
  });
});

test('project force-delete racing the owner\'s own closure never overtakes an open owner', async () => {
  await withManagedDatabase(async tmp => {
    const { deleteOrArchiveProject } = await import('@/modules/projects/index.js');
    const { projectsDb } = await import('@/modules/database/index.js');
    const outcomes: string[] = [];
    for (let round = 0; round < 4; round++) {
      const projectPath = path.join(tmp, `round-${round}`);
      await fs.mkdir(projectPath, { recursive: true });
      const project = projectsDb.createProjectPath(projectPath, `Owned project ${round}`).project;
      assert.ok(project);
      const appSessionId = `managed-${round}`;
      herdrManagedDb.reserve({ appSessionId, projectPath, herdrInstanceId: 'herdr-main', ownerGeneration: `owner-${round}` });
      const host = new HerdrTaskHost({
        bootstrap: { appSessionId, ownerGeneration: `owner-${round}`, herdrInstanceId: 'herdr-main', projectPath, sessionRoot: path.join(tmp, 'gjc') },
        createSession: () => ({ providerSessionId: `provider-${round}`, async prompt() {} }),
      });
      await host.initialize();
      assert.equal(herdrManagedDb.get(appSessionId, `owner-${round}`)?.lifecycle, 'idle');
      // An open owner refuses the cascade outright.
      await assert.rejects(deleteOrArchiveProject(project.project_id, true), { code: 'MANAGED_SESSION_NOT_CLOSED' });
      assert.ok(sessionsDb.getSessionById(appSessionId));
      // Closure and the cascade race through the same writer lock with varying
      // interleavings: whichever wins, no open owner is ever deleted and the
      // closure always lands.
      const delay = round === 0 ? Promise.resolve() : new Promise<void>(resolve => setTimeout(resolve, round * 3));
      const [outcome] = await Promise.all([
        (round % 2 === 0 ? Promise.resolve() : delay).then(() => deleteOrArchiveProject(project.project_id, true)).then(() => 'deleted', (error: { code?: string }) => String(error.code)),
        (round % 2 === 0 ? delay : Promise.resolve()).then(() => host.close()),
      ]);
      outcomes.push(outcome);
      if (outcome === 'deleted') {
        assert.equal(sessionsDb.getSessionById(appSessionId), null);
        assert.equal(herdrManagedDb.get(appSessionId, `owner-${round}`), null, 'the closed binding cascaded with its session');
      } else {
        assert.equal(outcome, 'MANAGED_SESSION_NOT_CLOSED');
        assert.equal(herdrManagedDb.get(appSessionId, `owner-${round}`)?.lifecycle, 'closed');
        assert.ok(sessionsDb.getSessionById(appSessionId));
        await deleteOrArchiveProject(project.project_id, true);
        assert.equal(sessionsDb.getSessionById(appSessionId), null);
      }
      assert.equal(projectsDb.getProjectById(project.project_id) ?? null, null);
    }
    assert.ok(outcomes.every(outcome => outcome === 'deleted' || outcome === 'MANAGED_SESSION_NOT_CLOSED'), JSON.stringify(outcomes));
  });
});
