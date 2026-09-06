import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { herdrManagedDb } from '@/modules/database/repositories/herdr-managed.db.js';

import { canonicalManagedInvocation, type HerdrManagedBridgeRequest } from '../shared/herdr-managed-bridge.js';
import type { HerdrManagedAutomationOperation } from '../shared/herdr-managed-protocol.js';
import { herdrManagedAutomationControlSchema } from '../shared/herdr-managed-protocol.js';

import { HerdrTaskHost, commandHash } from './gjc-herdr-task-host.js';
import { GjcHerdrAutomationBroker } from './gjc-herdr-automation-broker.js';
import { ManagedAutomationStore } from './gjc-herdr-automation-store.js';
import { ManagedBridgeLedger } from './modules/automation/managed-bridge-ledger.js';
import { HerdrManagedAttachClient } from './modules/herdr/index.js';

const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'observation deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

for (const outcome of ['completed', 'missing', 'reserved'] as const) test(`host stored invocation binding and authenticated ${outcome} recovery retain original broker continuation`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'host-evidence-')));
  const prior = process.env.DATABASE_PATH;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite');
  const identity = { appSessionId: 'evidence-session', ownerGeneration: 'evidence-owner' };
  const token = 'a'.repeat(64);
  const bridgePath = path.join(root, 'bridge.sock');
  const ledger = new ManagedBridgeLedger(root);
  const targetBinding = { kind: 'browser-origin' as const, origin: 'https://actual.test', tabId: 'actual-tab' };
  const invocation = { surface: 'browser', payload: { action: 'observe' } };
  let dispatches = 0; let fences = 0; let resolves = 0;
  const sockets = new Set<net.Socket>();
  const bridge = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString(); if (!buffer.includes('\n')) return;
      const request = JSON.parse(buffer.slice(0, buffer.indexOf('\n'))) as HerdrManagedBridgeRequest & { id: string; token: string };
      assert.equal(request.token, token);
      const send = (result: unknown) => socket.end(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
      if (request.type === 'managed-resolve-target') {
        resolves++; assert.deepEqual(request.invocation, invocation);
        send({ type: 'managed-target', requestId: request.requestId, identity: request.identity, sourceOperationId: request.sourceOperationId, bridgeInstanceId: request.bridgeInstanceId, invocationHash: request.identity.argumentsHash, targetBinding });
      } else if (request.type === 'managed-dispatch') {
        dispatches++; assert.deepEqual(request.invocation, invocation);
        if (outcome !== 'missing') {
          const reserved = ledger.reserveDispatch(request.attempt); assert.equal(reserved.status, 'reserved');
          if (outcome === 'completed' && reserved.status === 'reserved') ledger.completeDispatch(request.attempt, reserved.reservationId, { ok: true, result: { recovered: true } });
        }
        socket.destroy(); // The App's response is lost after the ledger decision.
      } else if (request.type === 'managed-lookup') send(ledger.lookupOutcome(request.attempt));
      else { fences++; send(ledger.fenceUndispatched(request.attempt)); }
    });
  });
  let host: HerdrTaskHost | undefined;
  let runOutcome: Promise<unknown> | undefined;
  const clients: HerdrManagedAttachClient[] = [];
  let settled = false;
  try {
    await initializeDatabase(); herdrManagedDb.reserve({ ...identity, projectPath: root, herdrInstanceId: 'test' });
    await new Promise<void>(resolve => bridge.listen(bridgePath, resolve));
    host = new HerdrTaskHost({ bootstrap: { ...identity, projectPath: root, sessionRoot: root, herdrInstanceId: 'test', attachSocketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }, createSession: input => {
      let pending = Promise.resolve(); let seq = 0;
      const broker = new GjcHerdrAutomationBroker({ generation: identity.ownerGeneration, provider: 'provider', policyRevision: 0,
        emit: event => { pending = pending.then(() => input.onEvent({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: ++seq, event })); }, flush: () => pending });
      return { providerSessionId: 'provider', prompt: async () => { broker.setTurn('turn'); const value = await broker.dispatch({ toolCallId: 'tool', index: 0, request: invocation }); settled = true; return value; }, automationControl: control => broker.control(control), dispose: () => broker.abort() };
    } });
    await host.initialize(); await host.startPrivateAttachServer();
    const payload = { text: 'observe' };
    const running = host.dispatch({ protocolVersion: 1, ...identity, actionId: 'turn', kind: 'prompt', payload, payloadHash: commandHash(payload) });
    runOutcome = running.then(() => null, error => error);
    await wait(() => Object.keys(host!.snapshot().automation).length > 0);
    const connect = async () => { const client = new HerdrManagedAttachClient({ ...identity, socketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }); clients.push(client); await client.connect(); return client; };
    const owner = await connect(); const observer = await connect();
    const currentTransport = { transportLocator: bridgePath, transportToken: token, ownerConnectionId: 'caller-claim', bridgeInstanceId: 'app-instance' };
    const waiting = Object.values(host.snapshot().automation)[0]; assert.equal(waiting.identity.targetContext, 'unresolved');
    const bind = { type: 'bind-capability' as const, actionId: randomUUID(), identity: waiting.identity, currentTransport };
    assert.equal((await owner.automationControl(bind)).type, 'automation-control');
    await wait(() => Object.values(host!.snapshot().automation).some(op => op.phase === 'awaiting_reattach_approval'));
    const offered = Object.values(host.snapshot().automation).find(op => op.phase === 'awaiting_reattach_approval')!;
    assert.equal(offered.identity.targetContext, canonicalManagedInvocation(targetBinding));
    const steal = await observer.automationControl({ ...bind, actionId: randomUUID(), identity: offered.identity });
    assert.ok(steal.type === 'automation-control' && !steal.accepted); assert.equal(resolves, 1);
    const approval = { identity: offered.identity, capabilityGeneration: offered.capabilityGeneration, approvalRequestId: offered.approvalRequestId, decision: 'approve' };
    await host.dispatch({ protocolVersion: 1, ...identity, actionId: 'approve', kind: 'resume', payload: approval, payloadHash: commandHash(approval) });
    await wait(() => host!.snapshot().automation[offered.identity.operationId].phase === 'outcome_unknown');
    const reconcile = { type: 'reconcile' as const, actionId: randomUUID(), identity: offered.identity, originalCapabilityGeneration: offered.capabilityGeneration!, currentTransport: { ...currentTransport, bridgeInstanceId: 'new-app-instance' } };
    for (const proof of [{ outcome: 'completed' }, { evidenceRef: 'forged' }, { result: { forged: true } }]) assert.equal(herdrManagedAutomationControlSchema.safeParse({ ...reconcile, ...proof }).success, false);
    await owner.automationControl(reconcile);
    if (outcome === 'completed') { await running; assert.equal(settled, true); assert.equal(host.snapshot().automation[offered.identity.operationId].phase, 'completed'); }
    else if (outcome === 'missing') {
      await wait(() => Object.values(host!.snapshot().automation).some(op => op.phase === 'waiting_attachment'));
      assert.equal(settled, false); assert.equal(host.snapshot().automation[offered.identity.operationId].phase, 'cancelled');
    } else {
      await owner.automationControl({ ...reconcile, actionId: randomUUID() });
      assert.equal(host.snapshot().automation[offered.identity.operationId].phase, 'outcome_unknown'); assert.equal(fences, 1); assert.equal(settled, false);
    }
    assert.equal(dispatches, 1);
    const store = new ManagedAutomationStore(root, identity.ownerGeneration);
    try {
      const operation: HerdrManagedAutomationOperation = host.snapshot().automation[offered.identity.operationId];
      store.verify(operation);
      assert.throws(() => store.verify({ ...operation, evidenceRef: 'caller-forged-ref' }));
      if (outcome === 'completed') {
        const record = store.read(operation.evidenceRef!, operation.identity.operationId);
        const bad = store.persist({ ...record, result: { forged: true } });
        assert.throws(() => store.verify({ ...operation, resultRef: bad }));
        const receipt = record.evidence!.content as { attempt: Record<string, unknown> };
        for (const key of ['requestId', 'bridgeInstanceId', 'originalCapabilityGeneration']) {
          const forged = store.persist({ ...record, evidence: { ...record.evidence!, content: { ...receipt, attempt: { ...receipt.attempt, [key]: 'forged' } } } });
          assert.throws(() => store.verify({ ...operation, evidenceRef: forged }));
        }
      }
    } finally { store.close(); }
  } finally {
    for (const client of clients) client.close();
    await host?.close();
    if (runOutcome && outcome !== 'completed') assert.ok(await runOutcome instanceof Error, 'unresolved callback rejects on explicit owner shutdown');
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => bridge.close(() => resolve())); ledger.close(); closeConnection();
    if (prior === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = prior;
    await fs.rm(root, { recursive: true, force: true });
  }
});
