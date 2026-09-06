import { createHash } from 'node:crypto';
import { writeSync } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

import { HERDR_MANAGED_MAX_CONSOLE_BYTES, HERDR_MANAGED_PROTOCOL_VERSION, type HerdrManagedCommand, type HerdrManagedCommandKind } from '../shared/herdr-managed-protocol.js';

const ACTION = /^[A-Za-z0-9_-]{1,64}$/;
const ID = /^[A-Za-z0-9_-]{1,160}$/;
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
const MAX = HERDR_MANAGED_MAX_CONSOLE_BYTES;
/** Own only the physical input terminal; attach sockets never acquire this lease. */
export function acquireConsoleTerminal(
  input: NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (mode: boolean) => unknown },
  output: NodeJS.WritableStream & { isTTY?: boolean; fd?: number },
): { active: boolean; restore: () => void } {
  if (input.isTTY !== true || typeof input.setRawMode !== 'function') return { active: false, restore() {} };
  const initialRaw = input.isRaw === true;
  let restored = false;
  let paste = false;
  const restore = (exiting = false) => {
    if (restored) return;
    restored = true;
    process.off('exit', onExit);
    try { input.setRawMode!(initialRaw); } catch { /* Exit cleanup must not mask the original failure. */ }
    if (paste) {
      try {
        if (exiting) {
          if (typeof output.fd === 'number') writeSync(output.fd, '\x1b[?2004l');
        } else output.write('\x1b[?2004l');
      } catch { /* A disconnected terminal cannot receive restoration. */ }
    }
  };
  const onExit = () => restore(true);
  process.once('exit', onExit);
  try {
    input.setRawMode(true);
    if (output.isTTY === true) {
      paste = true;
      output.write('\x1b[?2004h');
    }
  } catch (error) { restore(); throw error; }
  return { active: true, restore: () => restore() };
}
export type ConsoleParseContext = {
  appSessionId: string; ownerGeneration: string; stateRevision: number;
  /** Host-only exact pending lookup supplies operation identity/hash/policy. No newest fallback. */
  resolveResume?: (fullIdentity: string, capability: string, decision: 'approve' | 'deny') => Record<string, unknown> | null;
};
export type ConsoleParseResult =
  | { ok: true; type: 'command'; command: HerdrManagedCommand; safeEcho: string }
  | { ok: true; type: 'query'; query: 'status' | 'ack' | 'help'; actionId?: string; safeEcho: string }
  | { ok: false; message: string };
function validText(text: string): boolean {
  return !CONTROL.test(text) && !/[\uD800-\uDFFF]/u.test(text) && text.split('\n').length <= 256 && Buffer.byteLength(text) <= MAX;
}
export function parseConsoleLine(line: string, context: ConsoleParseContext): ConsoleParseResult {
  const reject = (message = 'invalid_arguments'): ConsoleParseResult => ({ ok: false, message });
  if (Buffer.byteLength(line) > MAX) return reject('input_too_large');
  if (!validText(line) || /[\r\n]/.test(line)) return reject('unsupported_control_character');
  if (!line.startsWith(':')) return reject('command_required');
  const match = /^:([a-z]+)(?:[ \t]+(.*))?$/.exec(line);
  if (!match) return reject();
  const verb = match[1]; let rest = match[2] ?? '';
  const token = (): string => {
    const found = /^([^ \t]+)(?:[ \t]+|$)/.exec(rest);
    if (!found) return '';
    rest = rest.slice(found[0].length); return found[1];
  };
  if (verb === 'status' || verb === 'help') return rest ? reject() : { ok: true, type: 'query', query: verb, safeEcho: `:${verb}` };
  const actionId = token();
  if (!ACTION.test(actionId)) return reject('invalid_action_id');
  if (verb === 'ack') return rest ? reject() : { ok: true, type: 'query', query: 'ack', actionId, safeEcho: `:ack ${actionId}` };
  const revision = (): number | null => {
    const value = token(); const n = Number(value);
    return /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(n) ? n : null;
  };
  const json = (): unknown => {
    const value: unknown = JSON.parse(rest); rest = '';
    if (typeof value === 'string' && validText(value)) return value;
    if (Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === 'string' && ID.test(v))) return value;
    throw new Error('invalid_argument');
  };
  const identity = (): string => {
    const value = token(); const parts = value.split('/');
    if (parts.length !== 5 || parts.some(p => !ID.test(p)) || parts[0] !== context.appSessionId || parts[1] !== context.ownerGeneration) throw new Error('invalid_identity');
    return value;
  };
  let payload: Record<string, unknown>;
  try {
    switch (verb) {
      case 'prompt': {
        const expectedStateRevision = revision(); const text = json();
        if (expectedStateRevision === null || typeof text !== 'string' || !text) return reject();
        payload = { text, expectedStateRevision }; break;
      }
      case 'followup': {
        const text = json(); if (typeof text !== 'string' || !text) return reject();
        payload = { text }; break;
      }
      case 'steer': {
        const turnId = token(); const text = json();
        if (!ID.test(turnId) || typeof text !== 'string' || !text) return reject();
        payload = { turnId, text }; break;
      }
      case 'abort': {
        const turnId = token(); if (!ID.test(turnId)) return reject(); payload = { turnId }; break;
      }
      case 'answer': payload = { requestId: identity(), answer: json() }; break;
      case 'permission': {
        const requestId = identity(); const policyRevision = revision(); const decision = token();
        if (policyRevision === null || !['allow-once', 'deny-once', 'allow-always', 'deny-remaining'].includes(decision)) return reject();
        payload = { requestId, policyRevision, decision }; break;
      }
      case 'resume': {
        const requestId = identity(); const capability = token(); const decision = token();
        if (!ID.test(capability) || (decision !== 'approve' && decision !== 'deny') || rest) return reject();
        const bound = context.resolveResume?.(requestId, capability, decision);
        if (!bound) return reject('resume_target_unavailable');
        payload = bound; break;
      }
      default: return reject('unknown_command');
    }
  } catch { return reject(); }
  if (rest) return reject();
  return { ok: true, type: 'command', safeEcho: `:${verb} ${actionId}`, command: {
    protocolVersion: HERDR_MANAGED_PROTOCOL_VERSION, appSessionId: context.appSessionId,
    ownerGeneration: context.ownerGeneration, actionId, kind: verb as HerdrManagedCommandKind,
    payload, payloadHash: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
  } };
}

export type ConsoleInputEvent = { type: 'line'; line: string } | { type: 'reject'; reason: string };
/** Byte-oriented, no echo/history/process ownership. Raw paste newlines poison the entire draft. */
export class ConsoleInputDecoder {
  #utf8 = new TextDecoder('utf-8', { fatal: true });
  #draft = ''; #bytes = 0; #escape = ''; #paste = false; #invalid = false; #cr = false;
  reset(): void {
    this.#utf8 = new TextDecoder('utf-8', { fatal: true });
    this.#draft = ''; this.#bytes = 0; this.#escape = ''; this.#paste = false; this.#invalid = false; this.#cr = false;
  }
  feed(bytes: Uint8Array): ConsoleInputEvent[] {
    const events: ConsoleInputEvent[] = [];
    for (const byte of bytes) {
      let text: string;
      try { text = this.#utf8.decode(Uint8Array.of(byte), { stream: true }); }
      catch { this.#invalid = true; this.#utf8 = new TextDecoder('utf-8', { fatal: true }); continue; }
      for (const char of text) {
        if (this.#escape) {
          if (this.#escape === '\x1b' && char !== '[' && !this.#paste) {
            this.#escape = ''; this.#invalid = false;
          } else {
          this.#escape += char;
          if (this.#escape === '\x1b[200~') {
            if (this.#paste) this.#invalid = true;
            this.#paste = true; this.#escape = ''; continue;
          }
          if (this.#escape === '\x1b[201~' && this.#paste) { this.#paste = false; this.#escape = ''; continue; }
          if ('\x1b[200~'.startsWith(this.#escape) || '\x1b[201~'.startsWith(this.#escape)) continue;
          this.#escape = ''; this.#invalid = true;
          if (char !== '\r' && char !== '\n') continue;
          }
        }
        if (char === '\x1b') {
          // Escape cancels ordinary draft immediately; retain poison inside paste.
          if (!this.#paste) { this.#draft = ''; this.#bytes = 0; }
          this.#escape = char; continue;
        }
        if (char === '\x03' && !this.#paste) { this.reset(); continue; }
        if (char === '\x04' && !this.#paste) { this.#invalid = true; continue; }
        if (char === '\r' || char === '\n') {
          if (this.#paste) { this.#invalid = true; continue; }
          if (char === '\n' && this.#cr) { this.#cr = false; continue; }
          this.#cr = char === '\r';
          if (this.#invalid) events.push({ type: 'reject', reason: 'invalid_input' });
          else if (this.#draft) events.push({ type: 'line', line: this.#draft });
          this.#draft = ''; this.#bytes = 0; this.#invalid = false; continue;
        }
        this.#cr = false;
        this.#bytes += Buffer.byteLength(char);
        if (this.#bytes > MAX || CONTROL.test(char)) this.#invalid = true;
        if (!this.#invalid) this.#draft += char;
      }
    }
    return events;
  }
  end(): ConsoleInputEvent[] {
    let malformed = false;
    try { this.#utf8.decode(); } catch { malformed = true; }
    const pending = malformed || this.#invalid || !!this.#draft || !!this.#escape || this.#paste;
    this.reset();
    return pending ? [{ type: 'reject', reason: 'incomplete_input' }] : [];
  }
}

/** EOF/error detach input only. The callback must not dispose the SDK owner. */
export function bindConsoleInput(input: Readable, onEvent: (event: ConsoleInputEvent) => void, onDetach: () => void): () => void {
  const decoder = new ConsoleInputDecoder(); let detached = false;
  const data = (chunk: Buffer) => {
    if (!(chunk instanceof Uint8Array)) { onEvent({ type: 'reject', reason: 'byte_input_required' }); detach(); return; }
    for (const event of decoder.feed(chunk)) onEvent(event);
  };
  const detach = () => {
    if (detached) return; detached = true;
    input.off('data', data); input.off('end', detach); input.off('error', detach); input.off('close', detach);
    for (const event of decoder.end()) onEvent(event);
    onDetach();
  };
  input.on('data', data); input.once('end', detach); input.once('error', detach); input.once('close', detach);
  return detach;
}

/** Known literal secrets are supplied by the host. This does not discover arbitrary secrets in prose. */
export function sanitizeConsoleText(value: string, limit = 8192, secrets: readonly string[] = []): string {
  for (const secret of secrets) if (secret) value = value.split(secret).join('[redacted]');
  // Unterminated control strings consume the remainder rather than leaking their payload.
  value = value.replace(/(?:\x1b\]|\u009D)[\s\S]*?(?:\x07|\x1b\\|\u009C|$)/g, '')
    .replace(/(?:\x1b[P_X^]|[\u0090\u0098\u009E\u009F])[\s\S]*?(?:\x1b\\|\u009C|$)/g, '')
    .replace(/(?:\x1b\[|\u009B)[0-?]*[ -/]*(?:[@-~]|$)/g, '')
    .replace(/\x1b(?:[ -/]*[@-~]|$)/g, '')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
  const cap = Math.max(0, Math.min(8192, Math.floor(limit)));
  let result = ''; let bytes = 0;
  for (const char of value) { const size = Buffer.byteLength(char); if (bytes + size > cap) break; result += char; bytes += size; }
  return result;
}
const label = (value: string) => ID.test(value) ? value : '-';
export function renderReceipt(receipt: { actionId: string; state: string; seq: number }): string {
  const state = ['admitted', 'executing', 'settled', 'unknown', 'rejected'].includes(receipt.state) ? receipt.state : 'unknown';
  return `ACK ${label(receipt.actionId)} ${state} ${Number.isSafeInteger(receipt.seq) && receipt.seq >= 0 ? receipt.seq : 0}`;
}
export function renderConsoleReceipt(actionId: string, state: string, seq: number): string { return renderReceipt({ actionId, state, seq }); }
export function renderConsoleReject(actionId: string | null, reason: string): string {
  return `REJECT ${actionId ? label(actionId) : '-'} ${/^[a-z_]{1,80}$/.test(reason) ? reason : 'command_rejected'}`;
}
export type ConsoleRequestView = {
  identity: string; kind: 'ask' | 'permission' | 'resume'; policyRevision: number;
  secret?: boolean; question?: string; options?: readonly { id: string; label: string; secret?: boolean }[];
  /** Schema is accepted only to honor its secret tag; it is NEVER serialized. */
  schema?: { secret?: boolean; sensitive?: boolean; format?: string; [key: string]: unknown };
};
function hasSecretTag(schema: unknown, seen = new Set<object>()): boolean {
  if (!schema || typeof schema !== 'object') return false;
  if (seen.has(schema) || seen.size >= 256) return true;
  seen.add(schema);
  const record = schema as Record<string, unknown>;
  if (record.secret === true || record.sensitive === true || record.format === 'password' || record.type === 'password') return true;
  return Object.values(record).some(value => hasSecretTag(value, seen));
}
export function renderRequest(request: ConsoleRequestView, secrets: readonly string[] = []): string {
  const target = request.identity.split('/');
  if (target.length !== 5 || target.some(p => !ID.test(p))) return 'REQUEST invalid_identity';
  const secret = request.secret || hasSecretTag(request.schema);
  const kind = ['ask', 'permission', 'resume'].includes(request.kind) ? request.kind : 'ask';
  const revision = Number.isSafeInteger(request.policyRevision) && request.policyRevision >= 0 ? request.policyRevision : 0;
  const header = `REQUEST ${kind} ${request.identity} ${revision}`;
  if (secret) return `${header}\n[secret request: non-echo input required]`;
  const lines = [header, sanitizeConsoleText(request.question ?? '', 4096, secrets)];
  for (const option of (request.options ?? []).slice(0, 64)) {
    if (ID.test(option.id)) lines.push(`${option.id}: ${option.secret ? '[redacted]' : sanitizeConsoleText(option.label, 256, secrets)}`);
  }
  return sanitizeConsoleText(lines.join('\n'), 8192, secrets);
}
export type ConsoleEventView = { kind: string; text?: string; secret?: boolean };
/** Host projects approved conversational content explicitly; sdk.event/raw payloads are not accepted. */
export function renderEvent(event: ConsoleEventView, secrets: readonly string[] = []): string | null {
  if (!['conversation', 'tool_summary', 'question', 'error'].includes(event.kind)) return null;
  const text = event.secret ? '[redacted]' : sanitizeConsoleText(event.text ?? '', 8192, secrets);
  return event.kind === 'error' ? `ERROR ${text}` : text;
}

/**
 * Bounded outstanding bytes. Display output is lossy: blocks that do not fit
 * are dropped behind exactly one visible omission marker. Critical records
 * (ACK/REQUEST/REJECT/STATUS) are never dropped; critical overflow disconnects
 * visibly via callback instead of losing receipts.
 */
export class ConsoleOutputWriter {
  #queue: string[] = []; #bytes = 0; #blocked = false; #closed = false;
  #omitted = 0;
  constructor(private readonly output: Writable, private readonly onDisconnect: (reason: string) => void) {
    output.on('drain', this.#drain); output.on('error', this.#error); output.on('close', this.#close);
  }
  write(block: string, priority: 'display' | 'critical' = 'display'): boolean {
    if (this.#closed) return false;
    if (Buffer.byteLength(block) > 8191 && priority === 'critical') {
      this.close('critical_block_overflow'); return false;
    }
    const line = `${sanitizeConsoleText(block, 8191)}\n`; const bytes = Buffer.byteLength(line);
    if (priority === 'display' && (this.#omitted > 0 || !this.#fits(bytes))) {
      // Once display output falls behind, later display blocks stay behind the
      // pending marker so a stalled console never reorders what it shows.
      this.#omitted++; return false;
    }
    if (!this.#fits(bytes)) { this.close('critical_output_overflow'); return false; }
    this.#queue.push(line); this.#bytes += bytes; this.#flush(); return !this.#closed;
  }
  #fits(bytes: number): boolean { return this.#bytes + this.output.writableLength + bytes <= MAX; }
  #flush(): void {
    while (!this.#closed && !this.#blocked && this.#queue.length) {
      const line = this.#queue.shift()!; this.#bytes -= Buffer.byteLength(line);
      try { this.#blocked = !this.output.write(line); } catch { this.close('output_error'); }
    }
    if (!this.#closed && !this.#blocked && this.#omitted > 0) {
      const marker = `OMITTED ${this.#omitted} display blocks\n`;
      if (this.#fits(Buffer.byteLength(marker))) {
        this.#omitted = 0;
        try { this.#blocked = !this.output.write(marker); } catch { this.close('output_error'); }
      }
    }
  }
  #drain = () => { this.#blocked = false; this.#flush(); };
  #error = () => this.close('output_error');
  #close = () => this.close('output_closed');
  close(reason = 'console_detached'): void {
    if (this.#closed) return; this.#closed = true; this.#queue = []; this.#bytes = 0;
    this.output.off('drain', this.#drain); this.output.off('error', this.#error); this.output.off('close', this.#close);
    this.onDisconnect(reason);
  }
}
