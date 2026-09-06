import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';

import {
  HERDR_MANAGED_CHILD_LIMITS as limits,
  parseManagedChildRequest,
  type ManagedChildIdentity,
  type ManagedChildRequest,
  type ManagedChildResponse,
  type ManagedChildOutput,
} from '../shared/herdr-managed-child-protocol.js';

import { createManagedGjcBunSdkAdapter, type GjcBunSdkAdapter } from './gjc-bun-sdk-adapter.js';

type ManagedOwner = Awaited<ReturnType<GjcBunSdkAdapter['initializeManagedGjcSession']>>;
export type RunManagedChildOptions = {
  input?: Readable;
  output?: Writable;
  /** Import-only injection. Production never accepts module paths or code in IPC. */
  createAdapter?: (agentDir: string) => Promise<GjcBunSdkAdapter>;
};
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};
const identity = (frame: ManagedChildIdentity): ManagedChildIdentity => ({ version: frame.version, generation: frame.generation, requestId: frame.requestId, runId: frame.runId });

/** Resolves only after close/owner-pipe death and SDK disposal. Input is never serialized behind a prompt. */
export async function runManagedChild(options: RunManagedChildOptions = {}): Promise<void> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  let owner: ManagedOwner | undefined;
  let initializing: Promise<void> | undefined;
  let generation: string | undefined;
  let eventIdentity: ManagedChildIdentity | undefined;
  let activePrompt: ManagedChildIdentity | undefined;
  let sequence = 0;
  let acknowledged = 0;
  let pendingBytes = 0;
  let stopped = false;
  let inFlight = 0;
  let buffer: Buffer = Buffer.alloc(0);
  const pending = new Map<number, number>();
  const barriers = new Set<{ seq: number; resolve(): void; reject(error: Error): void }>();
  type Result = Omit<ManagedChildResponse, keyof ManagedChildIdentity | 'type'>;
  const operations = new Map<string, { payload: string; result: Promise<Result> }>();
  const requests = new Map<string, string>();
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    input.off('data', onData);
    input.pause();
    for (const barrier of barriers) barrier.reject(new Error('Owner IPC closed.'));
    barriers.clear();
    try {
      await initializing?.catch(() => {});
      await owner?.dispose();
    } finally {
      input.off('end', onDeath);
      input.off('close', onDeath);
      input.off('error', onDeath);
      output.off('error', onDeath);
      output.off('close', onDeath);
      input.destroy();
      finish();
    }
  };
  const onDeath = () => { void stop().catch(() => {}); };
  const send = (value: ManagedChildOutput) => {
    if (stopped) throw new Error('Owner IPC closed.');
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > limits.frameBytes || output.writableLength + Buffer.byteLength(line) > limits.pendingBytes) {
      onDeath();
      throw new Error('Managed child output limit.');
    }
    output.write(line);
  };
  const emit = (event: Record<string, unknown>) => {
    if (!eventIdentity || stopped) return;
    const frame = { ...eventIdentity, type: 'event' as const, eventSeq: sequence + 1, event };
    const bytes = Buffer.byteLength(JSON.stringify(frame)) + 1;
    if (!Number.isSafeInteger(frame.eventSeq) || pending.size >= limits.pendingEvents || pendingBytes + bytes > limits.pendingBytes || bytes > limits.frameBytes) {
      onDeath();
      throw new Error('Managed child acknowledgement window exhausted.');
    }
    sequence += 1;
    pending.set(sequence, bytes);
    pendingBytes += bytes;
    send(frame);
  };
  const flushed = () => stopped ? Promise.reject(new Error('Owner IPC closed.')) : acknowledged >= sequence ? Promise.resolve() : new Promise<void>((resolve, reject) => {
    barriers.add({ seq: sequence, resolve, reject });
  });
  const execute = async (frame: ManagedChildRequest): Promise<Result> => {
    if (frame.type === 'init') {
      if (generation) return { ok: false, error: 'conflict' };
      generation = frame.generation;
      eventIdentity = identity(frame);
      initializing = (async () => {
        const adapter = await (options.createAdapter ?? createManagedGjcBunSdkAdapter)(frame.agentDir);
        owner = await adapter.initializeManagedGjcSession(`${frame.generation}:managed`, { ...frame.runConfig, appSessionId: frame.appSessionId }, {
          send: (event) => emit(event as Record<string, unknown>),
          setSessionId: (providerSessionId) => emit({ kind: 'session', providerSessionId }),
          setCredential: () => {},
          setModel: (modelId) => emit({ kind: 'model', modelId }),
        }, { generation: frame.generation, flush: flushed });
      })();
      await initializing;
      await flushed();
      return { ok: true, providerSessionId: owner!.providerSessionId };
    }
    if (!owner) return { ok: false, error: 'not_ready' };
    if (frame.type === 'prompt') {
      if (activePrompt) return { ok: false, error: 'busy' };
      activePrompt = identity(frame);
      eventIdentity = activePrompt;
      owner.setAutomationTurn(frame.actionId);
      let ok = true;
      try {
        try { await owner.prompt(frame.text, frame.turnOptions); } catch { ok = false; }
        await flushed();
        return ok ? { ok: true } : { ok: false, error: 'operation_failed' };
      } finally { activePrompt = undefined; }
    }
    if (frame.type === 'automation-control') return { ok: await owner.automationControl(frame.control) };
    if (frame.type === 'operation-status') return { ok: true, operationId: frame.operationId, operationState: owner.operationStatus(frame.operationId) };
    if (frame.type === 'close') {
      await owner.dispose();
      await flushed();
      return { ok: true };
    }
    if (!activePrompt || frame.runId !== activePrompt.runId) return { ok: false, error: 'not_ready' };
    if (frame.type === 'steer') return { ok: await owner.steer(frame.text) };
    if (frame.type === 'abort') return { ok: await owner.abort() };
    if (frame.type === 'validate-approval') return { ok: owner.validateApproval(frame.askId, frame.decision) };
    if (frame.type === 'approval') return { ok: owner.resolveApproval(frame.askId, frame.decision) };
    return { ok: false, error: 'invalid_request' };
  };
  const handle = async (frame: ManagedChildRequest) => {
    if (generation && frame.generation !== generation) {
      send({ ...identity(frame), type: 'response', ok: false, error: 'conflict' });
      return;
    }
    if (frame.type === 'ack') {
      // Cumulative contiguous watermark, emitted only after the host's durable transaction.
      if (!generation || frame.eventSeq > sequence) { onDeath(); return; }
      if (frame.eventSeq <= acknowledged) return;
      acknowledged = frame.eventSeq;
      for (const [seq, bytes] of pending) if (seq <= acknowledged) { pending.delete(seq); pendingBytes -= bytes; }
      for (const barrier of barriers) if (barrier.seq <= acknowledged) { barriers.delete(barrier); barrier.resolve(); }
      return;
    }
    const payload = createHash('sha256').update(canonical({ ...frame, requestId: undefined })).digest('hex');
    const priorRequest = requests.get(frame.requestId);
    const key = frame.type === 'init' ? 'initialize-owner' : `action:${frame.type === 'automation-control' ? frame.control.actionId : frame.actionId}`;
    const prior = operations.get(key);
    let result: Result;
    if ((priorRequest !== undefined && priorRequest !== payload) || (prior && prior.payload !== payload)) {
      result = { ok: false, error: 'conflict' };
    } else if ((requests.size >= limits.operations && !priorRequest) || (operations.size >= limits.operations && !prior)) {
      result = { ok: false, error: 'operation_limit' };
    } else {
      requests.set(frame.requestId, payload);
      const operation = prior ?? { payload, result: execute(frame).catch((): Result => ({ ok: false, error: 'operation_failed' })) };
      if (!prior) operations.set(key, operation);
      result = await operation.result;
    }
    if (!stopped) send({ ...identity(frame), type: 'response', ...result });
    if (frame.type === 'close' && result.ok) await stop();
  };
  function onData(chunk: string | Buffer) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline < 0 ? bytes.length : newline + 1;
      const segment = bytes.subarray(offset, end);
      if (buffer.length + segment.length > limits.frameBytes) { onDeath(); return; }
      buffer = Buffer.concat([buffer, segment]);
      offset = end;
      if (newline < 0) break;
      try {
        const line = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        buffer = Buffer.alloc(0);
        const frame = parseManagedChildRequest(line);
        if (frame.type === 'ack') {
          void handle(frame).catch(onDeath);
        } else {
          if (inFlight >= limits.pendingEvents) { onDeath(); return; }
          inFlight += 1;
          void handle(frame).catch(onDeath).finally(() => { inFlight -= 1; });
        }
      } catch { onDeath(); return; }
      if (stopped) return;
    }
  }
  input.on('data', onData);
  input.on('end', onDeath);
  input.on('close', onDeath);
  input.on('error', onDeath);
  output.on('error', onDeath);
  output.on('close', onDeath);
  await finished;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runManagedChild().catch(() => {
    process.stderr.write('Managed Herdr child failed.\n');
    process.exitCode = 1;
  });
}
