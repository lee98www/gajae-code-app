import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { closeConnection, getConnection } from '@/modules/database/connection.js';
import { initializeDatabase } from '@/modules/database/init-db.js';
import { herdrManagedDb as managed, type ManagedRequestIdentity } from '@/modules/database/repositories/herdr-managed.db.js';
import { projectPermissionsDb as permissions } from '@/modules/database/repositories/project-permissions.db.js';

const owner = { appSessionId: 'managed-test', ownerGeneration: 'generation-one', providerSessionId: 'sdk-session', turnId: 'turn-one' };
const projectPath = '/workspaces/managed-decisions';
async function store(run: () => void) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(join(tmpdir(), 'managed-decisions-'));
  closeConnection(); process.env.DATABASE_PATH = join(directory, 'test.sqlite');
  try {
    await initializeDatabase();
    managed.reserve({ ...owner, projectPath, herdrInstanceId: 'herdr' });
    assert.throws(() => managed.claim({ ...owner, protocolVersion: 1 }));
    managed.beginClaim(owner.appSessionId, owner.ownerGeneration);
    managed.claim({ ...owner, protocolVersion: 1 });
    run();
  } finally {
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}
function register(): ManagedRequestIdentity {
  managed.appendSdkEvent({ ...owner, kind: 'sdk.event', payload: { kind: 'permission_request', payload: { requestId: 'sdk-request', policyRevision: 999 } }, request: {
    requestId: 'sdk-request', requestKind: 'permission', schema: { rawInput: { command: 'pwd' } }, toolName: 'bash',
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'no', kind: 'reject_once' }],
  } });
  return { ...owner, requestId: Object.keys(managed.getState(owner.appSessionId, owner.ownerGeneration).requests)[0] };
}
function decide(identity: ManagedRequestIdentity, allow: boolean, always = false, actionId = 'decision') {
  return managed.decideRequest({ ...identity, actionId, policyRevision: managed.getRequest(identity)?.policyRevision ?? 0, resolution: { allow, always } });
}
test('public identities are namespaced and genuine schema/revision are authoritative', async () => store(() => {
  const identity = register();
  assert.notEqual(identity.requestId, 'sdk-request');
  assert.equal(managed.getRequest(identity)?.sdkRequestId, 'sdk-request');
  assert.equal(managed.getRequest(identity)?.policyRevision, 0);
  assert.equal(managed.getPending({ ...identity, turnId: 'wrong' }), null);
  assert.equal(managed.getPending({ ...identity, providerSessionId: 'wrong' }), null);
  assert.equal(managed.getPending({ ...identity, ownerGeneration: 'wrong' }), null);
  assert.throws(register);
  assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration).requests[identity.requestId].schema, { rawInput: { command: 'pwd' } });
}));
test('policy renewal supersedes old answer without cancelling the SDK callback', async () => store(() => {
  const old = register(); const schema = managed.getRequest(old)?.schema;
  permissions.setMode(projectPath, 'auto_edits'); permissions.reset(projectPath);
  const renewed = managed.renewPendingPermissions(owner.appSessionId, owner.ownerGeneration)[0];
  assert.notEqual(renewed.requestId, old.requestId);
  assert.equal(renewed.sdkRequestId, 'sdk-request'); assert.deepEqual(renewed.schema, schema);
  assert.equal(decide(old, true, true), null);
  assert.deepEqual(permissions.get(projectPath).allow_always, []);
  assert.equal(decide(renewed, false)?.status, 'decided');
  assert.equal(decide(renewed, true, true, 'loser'), null);
  assert.equal(managed.settleDecision({ ...renewed, actionId: 'decision', accepted: false })?.status, 'unknown');
}));
test('Always CAS writes grant and settled request disappears from current state', async () => store(() => {
  const identity = register();
  assert.equal(decide(identity, true, true)?.status, 'decided');
  assert.deepEqual(permissions.get(projectPath).allow_always, ['bash']);
  assert.equal(decide(identity, false, false, 'loser'), null);
  assert.equal(managed.settleDecision({ ...identity, actionId: 'decision', accepted: true })?.status, 'settled');
  assert.equal(managed.getState(owner.appSessionId, owner.ownerGeneration).requests[identity.requestId], undefined);
}));
test('SDK cancellation prevents decisions and trusted policy uses existing auto approval rules', async () => store(() => {
  const identity = register();
  assert.equal(managed.decideByPolicy({ ...identity, actionId: 'auto' }), null);
  permissions.addAllowAlways(projectPath, 'bash');
  const renewed = managed.renewPendingPermissions(owner.appSessionId, owner.ownerGeneration)[0];
  managed.appendSdkEvent({ ...owner, kind: 'permission_cancelled', payload: {}, cancelRequestId: 'sdk-request' });
  assert.equal(decide(renewed, true), null);
  assert.deepEqual(managed.getState(owner.appSessionId, owner.ownerGeneration).requests, {});
}));

test('asks survive unrelated grants and answers do not enter public state', async () => store(() => {
  const event = managed.appendSdkEvent({ ...owner, kind: 'sdk.event', payload: { kind: 'ask', requestId: 'private-callback' }, request: {
    requestId: 'private-callback', requestKind: 'ask',
    schema: { questions: [{ question: 'Enter value', options: [] }] },
  } });
  assert.equal(event.kind, 'managed.request');
  const requestId = Object.keys(managed.getState(owner.appSessionId, owner.ownerGeneration).requests)[0];
  const identity = { ...owner, requestId };
  permissions.addAllowAlways(projectPath, 'unrelated');
  assert.equal(managed.decideRequest({ ...identity, actionId: 'answer', policyRevision: 0, resolution: { allow: true, message: 'private-answer' } })?.status, 'decided');
  const publicData = JSON.stringify({ state: managed.getState(owner.appSessionId, owner.ownerGeneration), events: managed.eventsSince(owner.appSessionId, owner.ownerGeneration, 0) });
  for (const secret of ['private-callback', 'private-value', 'private-answer']) assert.equal(publicData.includes(secret), false);
  assert.deepEqual(permissions.get(projectPath).allow_always, ['unrelated']);
}));

test('rendered question answers and explicit skip reasons retain host schema authority', async () => store(() => {
  for (const [index, resolution] of [
    { allow: true, updatedInput: { answers: { 'Choose access': 'Allow once' } } },
    { allow: false, message: 'User skipped the question' },
  ].entries()) {
    const event = managed.appendSdkEvent({ ...owner, kind: 'sdk.event', payload: {}, request: {
      requestId: `ui-ask-${index}`, requestKind: 'ask',
      schema: { questions: [{ question: 'Choose access', options: [{ label: 'Allow once' }, { label: 'Deny' }] }] },
    } });
    const requestId = (event.payload as { requestId: string }).requestId;
    const identity = { ...owner, requestId };
    assert.equal(managed.decideRequest({ ...identity, actionId: `tampered-${index}`, policyRevision: 0,
      resolution: { allow: true, updatedInput: { questions: [], answers: { 'Choose access': 'Allow once' } } } }), null);
    assert.equal(managed.decideRequest({ ...identity, actionId: `ui-answer-${index}`, policyRevision: 0, resolution })?.status, 'decided');
    assert.deepEqual(permissions.get(projectPath).allow_always, []);
  }
}));

test('managed callback rejects SDK batch/multi shapes and fails closed for tagged ask answers', async () => store(() => {
  const batch = managed.appendSdkEvent({ ...owner, kind: 'sdk.event', payload: {}, request: {
    requestId: 'sdk-multi', requestKind: 'ask',
    schema: {
      questions: [
        { id: 'access', question: 'Access', options: [{ label: 'Read' }, { label: 'Write' }], multi: true },
        { id: 'scope', question: 'Scope', options: [{ label: 'Project' }, { label: 'Global' }], multi: false },
      ],
    },
  } });
  const batchIdentity = { ...owner, requestId: (batch.payload as { requestId: string }).requestId };
  assert.equal(managed.decideRequest({
    ...batchIdentity,
    actionId: 'sdk-multi-answer',
    policyRevision: 0,
    resolution: { allow: true, updatedInput: { answers: { access: ['Read', 'Write'], scope: 'Project' } } },
  }), null);
  assert.equal(managed.getRequest(batchIdentity)?.resolution, null);

  const secret = managed.appendSdkEvent({ ...owner, kind: 'sdk.event', payload: {}, request: {
    requestId: 'sdk-secret', requestKind: 'ask',
    schema: {
      questions: [{ question: 'Password', options: [] }],
      credential: { secret: true, value: 'do-not-store' },
    },
  } });
  const secretIdentity = { ...owner, requestId: (secret.payload as { requestId: string }).requestId };
  assert.equal(managed.decideRequest({
    ...secretIdentity,
    actionId: 'sdk-secret-answer',
    policyRevision: 0,
    resolution: { allow: true, message: 'private-answer' },
  }), null);
  const stored = getConnection().prepare('SELECT request_json, resolution_json FROM herdr_managed_decisions WHERE request_id = ?')
    .get(secretIdentity.requestId) as { request_json: string; resolution_json: string | null };
  assert.equal(stored.request_json.includes('do-not-store'), false);
  assert.equal(stored.resolution_json, null);
  const publicData = JSON.stringify({ state: managed.getState(owner.appSessionId, owner.ownerGeneration), events: managed.eventsSince(owner.appSessionId, owner.ownerGeneration, 0) });
  assert.equal(publicData.includes('do-not-store'), false);
  assert.match(publicData, /"inputMode":"non-echo"/);
  assert.match(publicData, /"answerRetention":"live-only"/);
}));
