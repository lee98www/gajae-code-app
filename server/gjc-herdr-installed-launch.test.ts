import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { herdrManagedDb } from '@/modules/database/repositories/herdr-managed.db.js';

import type { ManagedInstalledApplication } from '../shared/herdr-managed-protocol.js';

import { HerdrTaskHost, commandHash } from './gjc-herdr-task-host.js';
import { GjcHerdrAutomationBroker } from './gjc-herdr-automation-broker.js';
import { HerdrManagedAttachClient } from './modules/herdr/index.js';
import { AutomationService } from './modules/automation/automation.service.js';
import { AutomationGrantStore } from './modules/automation/automation-grants.js';

const wait = async (predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'observation deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
};

for (const changed of [false, true]) test(`installed launch host retains original continuation; identity changed=${changed}`, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'installed-host-')));
  const priorDb = process.env.DATABASE_PATH; const priorSocket = process.env.GAJAE_AUTOMATION_SOCKET;
  closeConnection(); process.env.DATABASE_PATH = path.join(root, 'app.sqlite'); process.env.GAJAE_AUTOMATION_SOCKET = path.join(root, 'bridge.sock');
  const identity = { appSessionId: 'installed-session', ownerGeneration: 'installed-owner' };
  let binding: ManagedInstalledApplication = { kind: 'cua-installed-application', bundleId: 'test.app', canonicalPath: '/Applications/Private App.app', identity: 'a'.repeat(64) };
  let launches = 0; let settled = false; let result: unknown;
  const service = new AutomationService(root, {
    async resolve(bundleId) { assert.equal(bundleId, 'test.app'); return { ...binding }; },
    async revalidate(expected) { if (expected.identity !== binding.identity) throw new Error('Installed application binding changed.'); },
  });
  Object.defineProperty(service, 'supported', { value: true });
  Object.defineProperty(service, 'grants', { value: new AutomationGrantStore({ get: () => null, set: () => {} }) });
  service.browser.shutdown = async () => {}; service.cua.shutdown = async () => {};
  service.cua.call = async (tool, args, signal) => {
    signal?.throwIfAborted();
    assert.match(String(args.session), /^gajae-/);
    if (tool === 'start_session') return { ok: true };
    assert.equal(tool, 'launch_app');
    assert.equal(args.bundle_id, binding.bundleId);
    launches++;
    return { bundle_id: binding.bundleId, pid: 1234 };
  };
  // Existing application permission does not replace managed capability approval.
  service.grant({ kind: 'application', value: 'test.app', scope: 'session', sessionId: identity.appSessionId });
  let host: HerdrTaskHost | undefined; let owner: HerdrManagedAttachClient | undefined; let running: Promise<unknown> | undefined;
  try {
    await initializeDatabase(); herdrManagedDb.reserve({ ...identity, projectPath: root, herdrInstanceId: 'test' }); await service.startBridge();
    host = new HerdrTaskHost({ bootstrap: { ...identity, projectPath: root, sessionRoot: root, herdrInstanceId: 'test', attachSocketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }, createSession: input => {
      let pending = Promise.resolve(); let seq = 0;
      const broker = new GjcHerdrAutomationBroker({ generation: identity.ownerGeneration, provider: 'provider', policyRevision: 0,
        emit: event => { pending = pending.then(() => input.onEvent({ version: 1, generation: identity.ownerGeneration, requestId: 'turn', runId: 'turn', type: 'event', eventSeq: ++seq, event })); }, flush: () => pending });
      return { providerSessionId: 'provider', prompt: async () => { broker.setTurn('turn'); result = await broker.dispatch({ toolCallId: 'tool', index: 0, request: { surface: 'computer', sessionId: identity.appSessionId, tool: 'launch_app', arguments: { bundle_id: 'test.app' } } }); settled = true; return result; }, automationControl: control => broker.control(control), dispose: () => broker.abort() };
    } });
    await host.initialize(); await host.startPrivateAttachServer();
    const payload = { text: 'launch exact app' };
    running = host.dispatch({ protocolVersion: 1, ...identity, actionId: 'turn', kind: 'prompt', payload, payloadHash: commandHash(payload) }); void running.catch(() => {});
    await wait(() => Object.values(host!.snapshot().automation).some(op => op.phase === 'waiting_attachment'));
    owner = new HerdrManagedAttachClient({ ...identity, socketPath: path.join(root, 'attach.sock'), attachSecret: 's'.repeat(32) }); await owner.connect();
    const cap = service.managedBridgeCapability()!;
    const currentTransport = { transportLocator: cap.socketPath, transportToken: cap.token, bridgeInstanceId: cap.bridgeInstanceId, ownerConnectionId: 'caller-claim' };
    const bind = async () => {
      const waiting = Object.values(host!.snapshot().automation).find(op => op.phase === 'waiting_attachment')!;
      await owner!.automationControl({ type: 'bind-capability', actionId: randomUUID(), identity: waiting.identity, currentTransport });
      await wait(() => Object.values(host!.snapshot().automation).some(op => op.phase === 'awaiting_reattach_approval'));
      return Object.values(host!.snapshot().automation).find(op => op.phase === 'awaiting_reattach_approval')!;
    };
    const approve = async (offered: Awaited<ReturnType<typeof bind>>) => {
      const approval = { identity: offered.identity, capabilityGeneration: offered.capabilityGeneration, approvalRequestId: offered.approvalRequestId, decision: 'approve' };
      await host!.dispatch({ protocolVersion: 1, ...identity, actionId: randomUUID(), kind: 'resume', payload: approval, payloadHash: commandHash(approval) });
    };
    const offered = await bind(); assert.equal(settled, false); assert.equal(launches, 0);
    if (changed) binding = { ...binding, identity: 'b'.repeat(64) };
    await approve(offered);
    if (changed) {
      await wait(() => host!.snapshot().automation[offered.identity.operationId].phase === 'outcome_unknown');
      assert.equal(settled, false); assert.equal(launches, 0);
      await owner.automationControl({ type: 'reconcile', actionId: randomUUID(), identity: offered.identity, originalCapabilityGeneration: offered.capabilityGeneration!, currentTransport });
      await wait(() => Object.values(host!.snapshot().automation).some(op => op.phase === 'waiting_attachment'));
      assert.equal(settled, false); assert.equal(launches, 0);
      const fresh = await bind(); assert.notEqual(fresh.approvalRequestId, offered.approvalRequestId); assert.notEqual(fresh.identity.targetContext, offered.identity.targetContext);
      assert.equal(settled, false); assert.equal(launches, 0); await approve(fresh);
    }
    await running; assert.equal(settled, true); assert.equal(launches, 1);
    assert.deepEqual(result, { bundleId: 'test.app', launchRequested: true });
  } finally {
    owner?.close(); await host?.close(); await running?.catch(() => {}); await service.shutdown(); closeConnection();
    if (priorDb === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = priorDb;
    if (priorSocket === undefined) delete process.env.GAJAE_AUTOMATION_SOCKET; else process.env.GAJAE_AUTOMATION_SOCKET = priorSocket;
    await fs.rm(root, { recursive: true, force: true });
  }
});
