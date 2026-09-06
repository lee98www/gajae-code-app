import { randomUUID, createHash } from 'node:crypto';

import { getConnection } from '@/modules/database/connection.js';
import { sessionsDb } from '@/modules/database/repositories/sessions.db.js';
import { projectPermissionsDb } from '@/modules/database/repositories/project-permissions.db.js';

import { gjcAutoApprovalReason } from '../../../gjc-engine.js';
import { applyHerdrManagedEvent, createHerdrManagedState, parseHerdrManagedState, serializeHerdrManagedState, type HerdrManagedState, type HerdrManagedQueueEntry } from '../../../../shared/herdr-managed-state.js';
import {
  HERDR_MANAGED_PROTOCOL_VERSION,
  herdrManagedBindingSchema,
  herdrManagedCommandKindSchema,
  herdrManagedCommandStateSchema,
  herdrManagedLifecycleSchema,
  type HerdrManagedBinding,
  type HerdrManagedCommandKind,
  type HerdrManagedCommandReceipt,
  type HerdrManagedCommandState,
  type HerdrManagedEvent,
  type HerdrManagedHostHello,
  type HerdrManagedLifecycle,
  herdrManagedCommandSchema,
  managedJsonBytes,
  type HerdrManagedCommand,
  type HerdrManagedAutomationOperation,
} from '../../../../shared/herdr-managed-protocol.js';

type BindingRow = {
  app_session_id: string;
  provider_session_id: string | null;
  owner_generation: string;
  herdr_instance_id: string;
  workspace_id: string | null;
  tab_id: string | null;
  pane_id: string | null;
  terminal_id: string | null;
  lifecycle: HerdrManagedLifecycle;
  last_seq: number;
  updated_at: string;
};

type CommandRow = {
  app_session_id: string;
  owner_generation: string;
  action_id: string;
  kind: HerdrManagedCommandKind;
  payload_hash: string;
  state: HerdrManagedCommandState;
  seq: number;
  message: string;
};

type EventRow = { app_session_id: string; owner_generation: string; seq: number; kind: string; payload_json: string; created_at: string };

export type ManagedRequestIdentity = {
  appSessionId: string;
  ownerGeneration: string;
  providerSessionId: string;
  turnId: string;
  requestId: string;
};
export type ManagedSdkRequest = {
  requestId: string;
  sdkRequestId?: string;
  requestKind: 'ask' | 'permission';
  schema: unknown;
  toolName?: string;
  options?: { optionId: string; kind: string }[];
};
export type ManagedDecision = {
  allow: boolean;
  always?: boolean;
  message?: string;
  updatedInput?: unknown;
  /** Durable metadata for a secret-tagged decision; never supplied by a caller. */
  secret?: true;
  secretPayloadHash?: string;
  answerPresent?: boolean;
  winnerActionId?: string;
};
export type ManagedPendingRequest = ManagedRequestIdentity & ManagedSdkRequest & {
  policyRevision: number;
  status: 'pending' | 'decided' | 'settled' | 'unknown' | 'cancelled';
  actionId: string | null;
  resolution: ManagedDecision | null;
};
type DecisionRow = {
  provider_session_id: string; turn_id: string; request_json: string; policy_revision: number;
  status: ManagedPendingRequest['status']; decided_by_action_id: string | null; resolution_json: string | null;
};

function publicRequestSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicRequestSchema);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (record.secret === true || record.sensitive === true || record.format === 'password' || record.type === 'password') {
    return { secret: true, redacted: true };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, publicRequestSchema(child)]));
}

type AskQuestion = { question: string; options: Array<Record<string, unknown>>; multi?: unknown; multiSelect?: unknown };

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Secret tags are an explicit schema boundary, not a best-effort text scan. */
function hasSecretTag(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(child => hasSecretTag(child, seen));
  const record = value as Record<string, unknown>;
  if (record.secret === true || record.sensitive === true || record.format === 'password' || record.type === 'password') return true;
  return Object.values(record).some(child => hasSecretTag(child, seen));
}

/**
 * One managed request corresponds to one ExtensionUIContext callback. The SDK
 * 0.15.6 AskTool performs multi-question sequencing and multi-select toggles
 * itself by calling this callback repeatedly; no batch answer is supported
 * across the managed boundary.
 */
function askQuestion(schema: unknown): AskQuestion | null {
  if (!object(schema) || !Array.isArray(schema.questions) || schema.questions.length !== 1) return null;
  const question = schema.questions[0];
  if (!object(question)
    || typeof question.question !== 'string'
    || !Array.isArray(question.options)
    || (question.multi !== undefined && typeof question.multi !== 'boolean')
    || (question.multiSelect !== undefined && typeof question.multiSelect !== 'boolean')
    || (question.multi !== undefined && question.multiSelect !== undefined && question.multi !== question.multiSelect)
    || question.multi === true
    || question.multiSelect === true
    || question.options.some(option => !object(option) || typeof option.label !== 'string')) return null;
  return question as AskQuestion;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[cycle]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map(child => canonicalJson(child, seen)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`).join(',')}}`;
}

function secretPayloadHash(decision: ManagedDecision): string {
  const payload = {
    ...(decision.message === undefined ? {} : { message: decision.message }),
    ...(decision.updatedInput === undefined ? {} : { updatedInput: decision.updatedInput }),
  };
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

function persistedDecision(request: ManagedPendingRequest, decision: ManagedDecision, winnerActionId: string): ManagedDecision {
  if (!hasSecretTag(request.schema)) return decision;
  return {
    allow: decision.allow,
    ...(decision.always === undefined ? {} : { always: decision.always }),
    secret: true,
    secretPayloadHash: secretPayloadHash(decision),
    answerPresent: decision.message !== undefined || decision.updatedInput !== undefined,
    winnerActionId,
  };
}

function validDecision(request: ManagedPendingRequest, decision: ManagedDecision): boolean {
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)
    || Object.keys(decision).some((key) => !['allow', 'always', 'message', 'updatedInput'].includes(key))
    || typeof decision.allow !== 'boolean'
    || (decision.message !== undefined && typeof decision.message !== 'string')
    || (decision.always !== undefined && typeof decision.always !== 'boolean')) return false;
  if (request.requestKind === 'permission') {
    if (decision.message !== undefined || decision.updatedInput !== undefined) return false;
    const kind = `${decision.allow ? 'allow' : 'reject'}_${decision.always ? 'always' : 'once'}`;
    const once = `${decision.allow ? 'allow' : 'reject'}_once`;
    return !!request.toolName && !!request.options?.some((option) => option.kind === kind)
      && !!request.options?.some((option) => option.kind === once);
  }
  if (decision.always !== undefined) return false;
  if (!decision.allow) return decision.updatedInput === undefined;
  const question = askQuestion(request.schema);
  // 0.15.6 has no supported no-echo/no-history ask hook and persists the
  // answer-bearing tool result. Never deliver a tagged ask answer live.
  if (!question || hasSecretTag(request.schema)) return false;
  let answer = decision.message?.trim();
  if (decision.updatedInput !== undefined) {
    if (answer !== undefined || !decision.updatedInput || typeof decision.updatedInput !== 'object' || Array.isArray(decision.updatedInput)
      || Object.keys(decision.updatedInput).some((key) => key !== 'answers')) return false;
    const answers = (decision.updatedInput as { answers?: unknown }).answers;
    if (!object(answers) || Object.keys(answers).length !== 1 || !Object.hasOwn(answers, question.question)) return false;
    const value = answers[question.question];
    if (typeof value !== 'string') return false;
    answer = value.trim();
  }
  if (!answer) return false;
  const labels = question.options.map(option => option.label as string);
  return labels.length === 0 || labels.includes(answer.trim());
}

function presentBinding(row: BindingRow | undefined): HerdrManagedBinding | null {
  if (!row) return null;
  return herdrManagedBindingSchema.parse({
    appSessionId: row.app_session_id,
    providerSessionId: row.provider_session_id,
    ownerGeneration: row.owner_generation,
    herdrInstanceId: row.herdr_instance_id,
    workspaceId: row.workspace_id,
    tabId: row.tab_id,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    lifecycle: row.lifecycle,
    lastSeq: row.last_seq,
    updatedAt: row.updated_at,
  });
}

function commandReceipt(row: CommandRow): HerdrManagedCommandReceipt {
  return {
    protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
    appSessionId: row.app_session_id,
    ownerGeneration: row.owner_generation,
    actionId: row.action_id,
    state: row.state,
    seq: row.seq,
    message: row.message,
  };
}

function presentEvent(row: EventRow): HerdrManagedEvent {
  return {
    protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION,
    appSessionId: row.app_session_id,
    ownerGeneration: row.owner_generation,
    seq: row.seq,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as unknown,
    createdAt: row.created_at,
  };
}

export const herdrManagedDb = {
  reserve(input: { appSessionId: string; projectPath: string; herdrInstanceId: string; ownerGeneration: string }): HerdrManagedBinding {
    const db = getConnection();
    return db.transaction(() => {
    sessionsDb.createAppSession(input.appSessionId, 'gjc', input.projectPath);
    db.prepare(`INSERT INTO herdr_managed_bindings (app_session_id, owner_generation, herdr_instance_id, lifecycle)
      VALUES (?, ?, ?, 'reserved')`).run(input.appSessionId, input.ownerGeneration, input.herdrInstanceId);
    db.prepare('INSERT INTO herdr_managed_state VALUES (?, ?, ?)').run(input.appSessionId, input.ownerGeneration,
      serializeHerdrManagedState(createHerdrManagedState({ appSessionId: input.appSessionId, ownerGeneration: input.ownerGeneration })));
    const binding = this.get(input.appSessionId, input.ownerGeneration);
    if (!binding) throw new Error('Managed Herdr reservation was not created.');
    return binding;
    }).immediate();
  },

  get(appSessionId: string, ownerGeneration: string): HerdrManagedBinding | null {
    return presentBinding(getConnection().prepare('SELECT * FROM herdr_managed_bindings WHERE app_session_id = ? AND owner_generation = ?')
      .get(appSessionId, ownerGeneration) as BindingRow | undefined);
  },

  claim(hello: HerdrManagedHostHello): HerdrManagedBinding {
    return getConnection().transaction(() => {
    const state = herdrManagedLifecycleSchema.parse('ready');
    const result = getConnection().prepare(`UPDATE herdr_managed_bindings
      SET provider_session_id = ?, lifecycle = ?, updated_at = CURRENT_TIMESTAMP
      WHERE app_session_id = ? AND owner_generation = ? AND lifecycle = 'claiming'`)
      .run(hello.providerSessionId, state, hello.appSessionId, hello.ownerGeneration);
    if (result.changes !== 1) throw new Error('Managed Herdr owner claim was rejected.');
    const binding = this.get(hello.appSessionId, hello.ownerGeneration);
    if (!binding) throw new Error('Managed Herdr owner claim disappeared.');
    this.appendEvent({ ...hello, kind: 'managed.session', payload: { lifecycle: 'ready', providerSessionId: hello.providerSessionId } });
    return this.get(hello.appSessionId, hello.ownerGeneration)!;
    }).immediate();
  },

  beginClaim(appSessionId: string, ownerGeneration: string): HerdrManagedBinding {
    return getConnection().transaction(() => {
    const result = getConnection().prepare(`UPDATE herdr_managed_bindings
      SET lifecycle = 'claiming', updated_at = CURRENT_TIMESTAMP
      WHERE app_session_id = ? AND owner_generation = ? AND lifecycle = 'reserved'`)
      .run(appSessionId, ownerGeneration);
    if (result.changes !== 1) throw new Error('Managed Herdr owner claim was rejected.');
    const binding = this.get(appSessionId, ownerGeneration);
    if (!binding) throw new Error('Managed Herdr owner claim disappeared.');
    this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.session', payload: { lifecycle: 'claiming' } });
    return this.get(appSessionId, ownerGeneration)!;
    }).immediate();
  },

  setLifecycle(appSessionId: string, ownerGeneration: string, lifecycle: HerdrManagedLifecycle): void {
    getConnection().transaction(() => {
    herdrManagedLifecycleSchema.parse(lifecycle);
    const binding = this.get(appSessionId, ownerGeneration);
    // Fenced owners only move toward stronger facts: an unknown owner may be
    // confirmed interrupted, and either may be confirmed closed. Nothing revives.
    if (!binding || (['unknown', 'interrupted', 'closed'].includes(binding.lifecycle) && lifecycle !== binding.lifecycle && lifecycle !== 'closed'
      && !(binding.lifecycle === 'unknown' && lifecycle === 'interrupted'))) {
      throw new Error('Managed owner cannot be resurrected.');
    }
    this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.session', payload: { lifecycle } });
    const result = getConnection().prepare(`UPDATE herdr_managed_bindings SET lifecycle = ?, updated_at = CURRENT_TIMESTAMP
      WHERE app_session_id = ? AND owner_generation = ? AND lifecycle <> 'closed'`)
      .run(lifecycle, appSessionId, ownerGeneration);
    if (result.changes !== 1) throw new Error('Managed Herdr lifecycle update was rejected.');
    }).immediate();
  },

  appendEvent(input: { appSessionId: string; ownerGeneration: string; kind: string; payload: unknown }): HerdrManagedEvent {
    const db = getConnection();
    return db.transaction(() => {
      const binding = this.get(input.appSessionId, input.ownerGeneration);
      if (!binding || binding.lifecycle === 'closed' ||
        (['unknown', 'interrupted'].includes(binding.lifecycle) && input.kind !== 'managed.session')) throw new Error('Managed Herdr owner is not writable.');
      const current = this.getState(input.appSessionId, input.ownerGeneration);
      const seq = binding.lastSeq + 1;
      db.prepare(`INSERT INTO herdr_managed_events (app_session_id, owner_generation, seq, kind, payload_json)
        VALUES (?, ?, ?, ?, ?)`).run(input.appSessionId, input.ownerGeneration, seq, input.kind, JSON.stringify(input.payload));
      db.prepare('UPDATE herdr_managed_bindings SET last_seq = ?, updated_at = CURRENT_TIMESTAMP WHERE app_session_id = ? AND owner_generation = ?')
        .run(seq, input.appSessionId, input.ownerGeneration);
      const event = presentEvent(db.prepare('SELECT * FROM herdr_managed_events WHERE app_session_id = ? AND owner_generation = ? AND seq = ?')
        .get(input.appSessionId, input.ownerGeneration, seq) as EventRow);
      const next = applyHerdrManagedEvent(current, event);
      db.prepare(`INSERT INTO herdr_managed_state VALUES (?, ?, ?) ON CONFLICT(app_session_id, owner_generation)
        DO UPDATE SET state_json = excluded.state_json`).run(input.appSessionId, input.ownerGeneration, serializeHerdrManagedState(next));
      return event;
    }).immediate();
  },

  recordCommand(input: { appSessionId: string; ownerGeneration: string; actionId: string; kind: HerdrManagedCommandKind; payloadHash: string; state: HerdrManagedCommandState; message: string }): HerdrManagedCommandReceipt {
    herdrManagedCommandKindSchema.parse(input.kind);
    herdrManagedCommandStateSchema.parse(input.state);
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM herdr_managed_commands WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?')
        .get(input.appSessionId, input.ownerGeneration, input.actionId) as CommandRow | undefined;
      if (existing) {
        if (existing.payload_hash !== input.payloadHash || existing.kind !== input.kind) throw new Error('Managed Herdr command action id conflict.');
        return commandReceipt(existing);
      }
      const seq = (this.get(input.appSessionId, input.ownerGeneration)?.lastSeq ?? 0) + 1;
      this.appendEvent({ ...input, kind: 'managed.command', payload: {
        protocolVersion: 1, appSessionId: input.appSessionId, ownerGeneration: input.ownerGeneration,
        actionId: input.actionId, state: input.state, seq, message: input.message,
      } });
      db.prepare(`INSERT INTO herdr_managed_commands (app_session_id, owner_generation, action_id, kind, payload_hash, state, seq, message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.appSessionId, input.ownerGeneration, input.actionId, input.kind, input.payloadHash, input.state, seq, input.message);
      return commandReceipt(db.prepare('SELECT * FROM herdr_managed_commands WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?')
        .get(input.appSessionId, input.ownerGeneration, input.actionId) as CommandRow);
    }).immediate();
  },

  getCommand(appSessionId: string, ownerGeneration: string, actionId: string): (HerdrManagedCommandReceipt & { kind: HerdrManagedCommandKind; payloadHash: string }) | null {
    const row = getConnection().prepare('SELECT * FROM herdr_managed_commands WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?')
      .get(appSessionId, ownerGeneration, actionId) as CommandRow | undefined;
    return row ? { ...commandReceipt(row), kind: row.kind, payloadHash: row.payload_hash } : null;
  },

  transitionCommand(input: { appSessionId: string; ownerGeneration: string; actionId: string; state: HerdrManagedCommandState; message: string }): HerdrManagedCommandReceipt {
    herdrManagedCommandStateSchema.parse(input.state);
    const db = getConnection();
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM herdr_managed_commands WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?')
        .get(input.appSessionId, input.ownerGeneration, input.actionId) as CommandRow | undefined;
      if (!existing) throw new Error('Managed Herdr command was not admitted.');
      const allowed: Record<HerdrManagedCommandState, HerdrManagedCommandState[]> = {
        admitted: ['executing', 'rejected', 'unknown'], executing: ['settled', 'unknown', 'rejected'],
        settled: [], rejected: [], unknown: ['settled'],
      };
      if (existing.state === input.state) return commandReceipt(existing);
      if (!allowed[existing.state].includes(input.state)) throw new Error('Invalid command transition.');
      const seq = (this.get(input.appSessionId, input.ownerGeneration)?.lastSeq ?? 0) + 1;
      this.appendEvent({ ...input, kind: 'managed.command', payload: {
        ...commandReceipt(existing), state: input.state, seq, message: input.message,
      } });
      db.prepare(`UPDATE herdr_managed_commands SET state = ?, seq = ?, message = ?, updated_at = CURRENT_TIMESTAMP
        WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?`)
        .run(input.state, seq, input.message, input.appSessionId, input.ownerGeneration, input.actionId);
      return commandReceipt(db.prepare('SELECT * FROM herdr_managed_commands WHERE app_session_id = ? AND owner_generation = ? AND action_id = ?')
        .get(input.appSessionId, input.ownerGeneration, input.actionId) as CommandRow);
    }).immediate();
  },

  eventsSince(appSessionId: string, ownerGeneration: string, afterSeq: number, limit = 256): HerdrManagedEvent[] {
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isInteger(limit) || limit < 1 || limit > 256) {
      throw new Error('Invalid managed journal page.');
    }
    if (!this.get(appSessionId, ownerGeneration)) throw new Error('Managed Herdr binding was not found.');
    return (getConnection().prepare(`SELECT * FROM herdr_managed_events
      WHERE app_session_id = ? AND owner_generation = ? AND seq > ?
      ORDER BY seq ASC LIMIT ?`).all(appSessionId, ownerGeneration, afterSeq, limit) as EventRow[]).map(presentEvent);
  },

  getState(appSessionId: string, ownerGeneration: string): HerdrManagedState {
    const row = getConnection().prepare(`SELECT b.last_seq, s.state_json
      FROM herdr_managed_bindings b LEFT JOIN herdr_managed_state s
      ON s.app_session_id = b.app_session_id AND s.owner_generation = b.owner_generation
      WHERE b.app_session_id = ? AND b.owner_generation = ?`)
      .get(appSessionId, ownerGeneration) as { last_seq: number; state_json: string | null } | undefined;
    if (!row) throw new Error('Managed Herdr binding was not found.');
    if (row.state_json === null) throw new Error('Managed authoritative state missing.');
    const state = parseHerdrManagedState(row.state_json);
    if (state.watermark !== row.last_seq || state.identity.appSessionId !== appSessionId || state.identity.ownerGeneration !== ownerGeneration) throw new Error('Managed authoritative state mismatch.');
    return state;
  },

  snapshot(appSessionId: string, ownerGeneration: string): HerdrManagedState {
    return this.getState(appSessionId, ownerGeneration);
  },

  enqueue(command: HerdrManagedCommand, configuration: Record<string, unknown> | null = null): HerdrManagedCommandReceipt {
    herdrManagedCommandSchema.parse(command);
    if (!['prompt', 'followup'].includes(command.kind)) throw new Error('Only prompt/followup may queue.');
    if (createHash('sha256').update(JSON.stringify(command.payload)).digest('hex') !== command.payloadHash) throw new Error('Command payload hash mismatch.');
    return getConnection().transaction(() => {
      const old = this.getCommand(command.appSessionId, command.ownerGeneration, command.actionId);
      if (old) {
        if (old.payloadHash !== command.payloadHash || old.kind !== command.kind) throw new Error('Managed command conflict.');
        const { kind: _kind, payloadHash: _payloadHash, ...receipt } = old;
        return receipt;
      }
      const receipt = this.recordCommand({ ...command, state: 'admitted', message: 'Queued.' });
      this.appendEvent({ ...command, kind: 'managed.queue', payload: { action: 'enqueue', entry: {
        command, configuration, admittedSeq: receipt.seq, inputBytes: managedJsonBytes(command.payload),
      } } });
      return receipt;
    }).immediate();
  },

  dequeue(appSessionId: string, ownerGeneration: string, turnId: string, metadata: Record<string, unknown> = {}): HerdrManagedQueueEntry | null {
    return getConnection().transaction(() => {
      const state = this.getState(appSessionId, ownerGeneration);
      if (!['ready', 'idle'].includes(state.lifecycle) || state.activeTurnId || state.queue.paused || !state.queue.entries.length) return null;
      const entry = state.queue.entries[0];
      this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.queue', payload: { action: 'dequeue', actionId: entry.command.actionId } });
      this.transitionCommand({ appSessionId, ownerGeneration, actionId: entry.command.actionId, state: 'executing', message: 'Executing queued turn.' });
      this.beginTurn(appSessionId, ownerGeneration, turnId, { ...metadata, actionId: entry.command.actionId });
      if (entry.configuration) this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.session', payload: { configuration: entry.configuration } });
      const payload = entry.command.payload !== null && typeof entry.command.payload === 'object' && !Array.isArray(entry.command.payload)
        ? entry.command.payload as Record<string, unknown> : {};
      this.appendEvent({
        appSessionId, ownerGeneration, kind: 'text',
        payload: {
          role: 'user', actionId: entry.command.actionId, turnId,
          content: typeof payload.displayText === 'string' ? payload.displayText : typeof payload.text === 'string' ? payload.text : '',
          ...(Array.isArray(payload.images) ? { images: payload.images } : {}),
          timestamp: new Date().toISOString(),
        },
      });
      return entry;
    }).immediate();
  },

  pauseQueue(appSessionId: string, ownerGeneration: string): void {
    this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.queue', payload: { action: 'pause' } });
  },
  resumeQueue(appSessionId: string, ownerGeneration: string): void {
    this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.queue', payload: { action: 'resume' } });
  },
  beginTurn(appSessionId: string, ownerGeneration: string, turnId: string, metadata: Record<string, unknown> = {}): void {
    getConnection().transaction(() => {
      const state = this.getState(appSessionId, ownerGeneration);
      if (!turnId || state.activeTurnId || state.turns[turnId] || !['ready', 'idle'].includes(state.lifecycle)) throw new Error('Turn cannot start.');
      this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.turn', payload: { turnId, state: { ...metadata, status: 'running' } } });
      this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.session', payload: { activeTurnId: turnId } });
      this.setLifecycle(appSessionId, ownerGeneration, 'running');
    }).immediate();
  },
  finishTurn(appSessionId: string, ownerGeneration: string, turnId: string, metadata: Record<string, unknown> = {}): void {
    getConnection().transaction(() => {
      const state = this.getState(appSessionId, ownerGeneration);
      if (state.activeTurnId !== turnId) throw new Error('Turn owner mismatch.');
      this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.turn', payload: { turnId, state: { ...state.turns[turnId], ...metadata, status: 'finished' } } });
      this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.session', payload: { activeTurnId: null } });
      this.setLifecycle(appSessionId, ownerGeneration, 'idle');
    }).immediate();
  },
  setAutomation(appSessionId: string, ownerGeneration: string, operation: HerdrManagedAutomationOperation): HerdrManagedEvent {
    return this.appendEvent({ appSessionId, ownerGeneration, kind: 'managed.automation', payload: operation });
  },

  appendSdkEvent(input: Omit<ManagedRequestIdentity, 'requestId'> & {
    kind: string; payload: unknown; request?: ManagedSdkRequest; cancelRequestId?: string;
  }): HerdrManagedEvent {
    const db = getConnection();
    return db.transaction(() => {
      const binding = this.get(input.appSessionId, input.ownerGeneration);
      if (!binding || binding.lifecycle === 'closed' || binding.providerSessionId !== input.providerSessionId) {
        throw new Error('Managed SDK event owner mismatch.');
      }
      const projectPath = sessionsDb.getSessionById(input.appSessionId)?.project_path;
      if (!projectPath || !input.turnId) throw new Error('Managed SDK event identity missing.');
      if (input.request) {
        const request = {
          ...input.request,
          schema: publicRequestSchema(input.request.schema),
          sdkRequestId: input.request.sdkRequestId ?? input.request.requestId,
          requestId: randomUUID(),
        };
        if (!request.requestId || (request.requestKind !== 'ask' && request.requestKind !== 'permission')) throw new Error('Invalid SDK request.');
        const duplicate = db.prepare(`SELECT 1 FROM herdr_managed_decisions WHERE app_session_id = ? AND owner_generation = ? AND turn_id = ? AND json_extract(request_json, '$.sdkRequestId') = ?`)
          .get(input.appSessionId, input.ownerGeneration, input.turnId, request.sdkRequestId);
        if (duplicate) throw new Error('Duplicate SDK request.');
        db.prepare(`INSERT INTO herdr_managed_decisions
          (app_session_id, owner_generation, provider_session_id, turn_id, request_id, request_kind, request_json, policy_revision)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(input.appSessionId, input.ownerGeneration, input.providerSessionId, input.turnId, request.requestId,
            request.requestKind, JSON.stringify(request), projectPermissionsDb.getRevision(projectPath));
        return this.publishRequest({ ...input, requestId: request.requestId });

      }
      if (input.cancelRequestId) {
        const rows = db.prepare(`SELECT request_id, request_json FROM herdr_managed_decisions WHERE app_session_id = ? AND owner_generation = ?
          AND provider_session_id = ? AND turn_id = ? AND status IN ('pending', 'decided', 'unknown')`)
          .all(input.appSessionId, input.ownerGeneration, input.providerSessionId, input.turnId) as { request_id: string; request_json: string }[];
        for (const row of rows) {
          if ((JSON.parse(row.request_json) as ManagedSdkRequest).sdkRequestId !== input.cancelRequestId) continue;
          db.prepare(`UPDATE herdr_managed_decisions SET status = 'cancelled' WHERE app_session_id = ? AND owner_generation = ? AND request_id = ?`)
            .run(input.appSessionId, input.ownerGeneration, row.request_id);
          this.appendEvent({ ...input, kind: 'managed.request-resolved', payload: { requestId: row.request_id } });
        }
      }
      return this.appendEvent(input);
    }).immediate();
  },

  getRequest(identity: ManagedRequestIdentity): ManagedPendingRequest | null {
    const binding = this.get(identity.appSessionId, identity.ownerGeneration);
    if (!binding || binding.providerSessionId !== identity.providerSessionId) return null;
    const row = getConnection().prepare(`SELECT * FROM herdr_managed_decisions
      WHERE app_session_id = ? AND owner_generation = ? AND provider_session_id = ? AND turn_id = ? AND request_id = ?`)
      .get(identity.appSessionId, identity.ownerGeneration, identity.providerSessionId, identity.turnId, identity.requestId) as DecisionRow | undefined;
    return row ? {
      ...JSON.parse(row.request_json) as ManagedSdkRequest, ...identity,
      policyRevision: row.policy_revision, status: row.status, actionId: row.decided_by_action_id,
      resolution: row.resolution_json ? JSON.parse(row.resolution_json) as ManagedDecision : null,
    } : null;
  },

  getPending(identity: ManagedRequestIdentity): ManagedPendingRequest | null {
    const request = this.getRequest(identity);
    return request?.status === 'pending' ? request : null;
  },

  publishRequest(identity: ManagedRequestIdentity): HerdrManagedEvent {
    const request = this.getRequest(identity);
    if (!request) throw new Error('Request missing.');
    return this.appendEvent({ ...identity, kind: 'managed.request', payload: {
      requestId: request.requestId, generation: request.ownerGeneration, appSessionId: request.appSessionId,
      providerSessionId: request.providerSessionId, turnId: request.turnId, kind: request.requestKind,
      policyRevision: request.policyRevision, schema: publicRequestSchema(request.schema),
      scope: {
        toolName: request.toolName ?? null,
        options: request.options ?? [],
        status: request.status,
        actionId: request.actionId,
        ...(hasSecretTag(request.schema) ? { inputMode: 'non-echo', answerRetention: 'live-only' } : {}),
      },
      createdAt: new Date().toISOString(),
    } });
  },

  currentPolicy(appSessionId: string, ownerGeneration: string) {
    if (!this.get(appSessionId, ownerGeneration)) throw new Error('Managed owner mismatch.');
    const path = sessionsDb.getSessionById(appSessionId)?.project_path;
    if (!path) throw new Error('Managed project missing.');
    const policy = projectPermissionsDb.get(path);
    return { revision: projectPermissionsDb.getRevision(path), permissions: { mode: policy.mode, allowAlways: policy.allow_always, bypassAcknowledged: policy.bypass_acknowledged } };
  },

  renewPendingPermissions(appSessionId: string, ownerGeneration: string): ManagedPendingRequest[] {
    return getConnection().transaction(() => {
      const db = getConnection();
      if (['closed', 'unknown', 'interrupted'].includes(this.get(appSessionId, ownerGeneration)?.lifecycle ?? 'closed')) throw new Error('Managed owner is not live.');
      const policy = this.currentPolicy(appSessionId, ownerGeneration);
      const rows = db.prepare(`SELECT request_id, provider_session_id, turn_id, request_json FROM herdr_managed_decisions
        WHERE app_session_id = ? AND owner_generation = ? AND request_kind = 'permission' AND status = 'pending' AND policy_revision <> ?`)
        .all(appSessionId, ownerGeneration, policy.revision) as { request_id: string; provider_session_id: string; turn_id: string; request_json: string }[];
      return rows.map(row => {
        const request = { ...JSON.parse(row.request_json) as ManagedSdkRequest, requestId: randomUUID() };
        db.prepare(`UPDATE herdr_managed_decisions SET status = 'cancelled', resolution_json = ? WHERE app_session_id = ? AND owner_generation = ? AND request_id = ? AND status = 'pending'`)
          .run(JSON.stringify({ supersededBy: request.requestId }), appSessionId, ownerGeneration, row.request_id);
        db.prepare(`INSERT INTO herdr_managed_decisions (app_session_id, owner_generation, provider_session_id, turn_id, request_id, request_kind, request_json, policy_revision)
          VALUES (?, ?, ?, ?, ?, 'permission', ?, ?)`).run(appSessionId, ownerGeneration, row.provider_session_id, row.turn_id, request.requestId, JSON.stringify(request), policy.revision);
        const identity = { appSessionId, ownerGeneration, providerSessionId: row.provider_session_id, turnId: row.turn_id, requestId: request.requestId };
        this.appendEvent({ ...identity, kind: 'managed.request-resolved', payload: { requestId: row.request_id } });
        this.appendEvent({ ...identity, kind: 'decision.superseded', payload: { requestId: row.request_id, supersededBy: request.requestId, policyRevision: policy.revision } });
        this.publishRequest(identity);
        return this.getPending(identity)!;
      });
    }).immediate();
  },

  decideByPolicy(identity: ManagedRequestIdentity & { actionId: string }): ManagedPendingRequest | null {
    return getConnection().transaction(() => {
      const request = this.getPending(identity);
      const policy = this.currentPolicy(identity.appSessionId, identity.ownerGeneration);
      if (!request || request.requestKind !== 'permission' || !request.toolName ||
        (policy.permissions.mode === 'bypass' && !policy.permissions.bypassAcknowledged) ||
        !gjcAutoApprovalReason(policy.permissions, request.toolName)) return null;
      return this.decideRequest({ ...identity, policyRevision: policy.revision, resolution: { allow: true } });
    }).immediate();
  },

  decideRequest(input: ManagedRequestIdentity & { actionId: string; policyRevision: number; resolution: ManagedDecision }): ManagedPendingRequest | null {
    const db = getConnection();
    return db.transaction(() => {
      const request = this.getPending(input);
      const binding = this.get(input.appSessionId, input.ownerGeneration);
      const projectPath = sessionsDb.getSessionById(input.appSessionId)?.project_path;
      if (!request || !binding || ['closed', 'unknown', 'interrupted'].includes(binding.lifecycle) || !projectPath || !input.actionId ||
        request.policyRevision !== input.policyRevision ||
        (request.requestKind === 'permission' && projectPermissionsDb.getRevision(projectPath) !== request.policyRevision) ||
        !validDecision(request, input.resolution)) return null;
      const reused = db.prepare(`SELECT 1 FROM herdr_managed_decisions
        WHERE app_session_id = ? AND owner_generation = ? AND decided_by_action_id = ?`)
        .get(input.appSessionId, input.ownerGeneration, input.actionId);
      if (reused) return null;
      const storedResolution = persistedDecision(request, input.resolution, input.actionId);
      const result = db.prepare(`UPDATE herdr_managed_decisions
        SET status = 'decided', resolution_json = ?, decided_by_action_id = ?, decided_at = CURRENT_TIMESTAMP
        WHERE app_session_id = ? AND owner_generation = ? AND provider_session_id = ? AND turn_id = ? AND request_id = ? AND status = 'pending'`)
        .run(JSON.stringify(storedResolution), input.actionId, input.appSessionId, input.ownerGeneration,
          input.providerSessionId, input.turnId, input.requestId);
      if (result.changes !== 1) return null;
      if (request.requestKind === 'permission' && input.resolution.allow && input.resolution.always && request.toolName) {
        projectPermissionsDb.addAllowAlways(projectPath, request.toolName);
      }
      this.appendEvent({ ...input, kind: 'decision.decided', payload: {
        requestId: input.requestId, turnId: input.turnId, actionId: input.actionId,
      } });
      this.publishRequest(input);
      return this.getRequest(input);
    }).immediate();
  },

  settleDecision(input: ManagedRequestIdentity & { actionId: string; accepted: boolean }): ManagedPendingRequest | null {
    const db = getConnection();
    return db.transaction(() => {
      const request = this.getRequest(input);
      if (!request || request.status !== 'decided' || request.actionId !== input.actionId) return null;
      const status = input.accepted ? 'settled' : 'unknown';
      db.prepare(`UPDATE herdr_managed_decisions SET status = ?
        WHERE app_session_id = ? AND owner_generation = ? AND provider_session_id = ? AND turn_id = ? AND request_id = ?`)
        .run(status, input.appSessionId, input.ownerGeneration, input.providerSessionId, input.turnId, input.requestId);
      this.appendEvent({ ...input, kind: `decision.${status}`, payload: {
        requestId: input.requestId, turnId: input.turnId, actionId: input.actionId,
      } });
      if (input.accepted) this.appendEvent({ ...input, kind: 'managed.request-resolved', payload: { requestId: input.requestId } });
      else this.publishRequest(input);
      return this.getRequest(input);
    }).immediate();
  },
};
