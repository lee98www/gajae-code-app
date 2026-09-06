import { randomUUID } from 'node:crypto';

import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@gajae-code/coding-agent/extensibility/extensions/types';
import type {
  ClientBridgePermissionOption,
  ClientBridgePermissionOptionKind,
  ClientBridgePermissionOutcome,
  ClientBridgePermissionToolCall,
} from '@gajae-code/coding-agent/session/client-bridge';

import type { GjcWorkerWriter } from './gjc-worker.js';

type PendingAsk = {
  kind: 'ask';
  resolve: (answer: string | undefined) => void;
  reject: (reason: Error) => void;
  cancel: () => void;
};

type PendingPermission = {
  kind: 'permission';
  options: ClientBridgePermissionOption[];
  resolve: (outcome: ClientBridgePermissionOutcome) => void;
  cancel: () => void;
};

type Pending = PendingAsk | PendingPermission;

type Decision = { allow?: unknown; always?: unknown; updatedInput?: unknown; message?: unknown };

/** Preserve the shape of a tagged value while removing its content. */
export function redactSecretValue(value: unknown, seen = new Set<object>()): unknown {
  if (Array.isArray(value)) return value.map(item => redactSecretValue(item, seen));
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return { secret: true, redacted: true };
  seen.add(value);
  const record = value as Record<string, unknown>;
  if (record.secret === true || record.sensitive === true || record.format === 'password' || record.type === 'password') {
    return { secret: true, redacted: true };
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, redactSecretValue(child, seen)]));
}

function hasSecretTag(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some(item => hasSecretTag(item, seen));
  const record = value as Record<string, unknown>;
  if (record.secret === true || record.sensitive === true || record.format === 'password' || record.type === 'password') return true;
  return Object.values(record).some(item => hasSecretTag(item, seen));
}

function decisionText(decision: Decision): string | undefined {
  if (typeof decision.message === 'string' && decision.message.trim()) return decision.message.trim();
  if (decision.updatedInput !== null && typeof decision.updatedInput === 'object') {
    const answers = (decision.updatedInput as Record<string, unknown>).answers;
    if (answers !== null && typeof answers === 'object') {
      const first = Object.values(answers as Record<string, unknown>).find((value) => typeof value === 'string' && value.trim());
      if (typeof first === 'string') return first.trim();
    }
  }
  return undefined;
}

/**
 * Picks the runtime's option for a decision. The runtime hands over its own
 * option list on every call and validates the returned id against it, so the
 * answer is chosen from that list rather than assumed.
 */
export function selectPermissionOption(
  options: readonly ClientBridgePermissionOption[],
  kind: ClientBridgePermissionOptionKind,
): ClientBridgePermissionOutcome | undefined {
  const fallback: ClientBridgePermissionOptionKind = kind === 'allow_always' ? 'allow_once' : kind === 'reject_always' ? 'reject_once' : kind;
  const option = options.find((candidate) => candidate.kind === kind) ?? options.find((candidate) => candidate.kind === fallback);
  return option ? { outcome: 'selected', optionId: option.optionId, kind: option.kind } : undefined;
}

/** Bridges the SDK ask extension UI and tool permission gate to Protocol v1 permission messages. */
export class GjcBunAskController {
  readonly #pending = new Map<string, Pending>();
  #disposed = false;

  constructor(private readonly writer: GjcWorkerWriter) {}

  get uiContext(): ExtensionUIContext {
    return {
      select: (title, options, dialogOptions) => this.#present(title, options, undefined, dialogOptions),
      editor: (title, prefill, dialogOptions) => this.#present(title, [], prefill, dialogOptions),
    } as ExtensionUIContext;
  }

  resolve(requestId: string, value: unknown): boolean {
    const pending = this.#pending.get(requestId);
    if (!pending || this.#disposed) return false;
    const decision = value !== null && typeof value === 'object' ? value as Decision : {};
    if (pending.kind === 'permission') return this.#resolvePermission(requestId, pending, decision);
    const answer = decisionText(decision);
    if (decision.allow === true && !answer) return false;
    this.#pending.delete(requestId);
    pending.cancel();
    pending.resolve(decision.allow === true ? answer : undefined);
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const [requestId, pending] of this.#pending) {
      this.#pending.delete(requestId);
      pending.cancel();
      if (pending.kind === 'permission') pending.resolve({ outcome: 'cancelled' });
      else pending.reject(new Error('GJC ask request cancelled.'));
      this.writer.send({ kind: 'permission_cancelled', requestId });
    }
  }

  /**
   * Raises a tool permission card and waits for the host's decision. The
   * request carries the runtime's own tool name so the browser can offer
   * "Always allow <tool>", and the raw input so the card can show what would run.
   */
  requestPermission(
    toolCall: ClientBridgePermissionToolCall,
    options: ClientBridgePermissionOption[],
    signal?: AbortSignal,
  ): Promise<ClientBridgePermissionOutcome> {
    if (this.#disposed || signal?.aborted) return Promise.resolve({ outcome: 'cancelled' });
    const requestId = `sdk-permission:${randomUUID()}`;
    const rawInput = toolCall.rawInput ?? {};
    const secretInput = hasSecretTag(rawInput);
    return new Promise((resolve) => {
      const abort = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cancel();
        resolve({ outcome: 'cancelled' });
        this.writer.send({ kind: 'permission_cancelled', requestId });
      };
      const cancel = () => signal?.removeEventListener('abort', abort);
      this.#pending.set(requestId, { kind: 'permission', options, resolve, cancel });
      signal?.addEventListener('abort', abort, { once: true });
      this.writer.send({
        kind: 'permission_request',
        requestId,
        toolName: toolCall.toolName,
        input: redactSecretValue(rawInput),
        context: {
          source: 'sdk-permission',
          toolCallId: toolCall.toolCallId,
          title: toolCall.title,
          ...(toolCall.kind ? { kind: toolCall.kind } : {}),
          ...(toolCall.locations ? { locations: toolCall.locations } : {}),
          options: options.map((option) => option.kind),
          ...(secretInput ? { inputMode: 'non-echo', answerRetention: 'live-only' } : {}),
        },
      });
    });
  }

  #resolvePermission(requestId: string, pending: PendingPermission, decision: Decision): boolean {
    if (typeof decision.allow !== 'boolean') return false;
    // "Always" pairs with both answers: allow_always and reject_always. A
    // reject_always the runtime did not offer falls back to reject_once
    // inside selectPermissionOption.
    const kind: ClientBridgePermissionOptionKind = decision.always === true
      ? (decision.allow ? 'allow_always' : 'reject_always')
      : (decision.allow ? 'allow_once' : 'reject_once');
    const outcome = selectPermissionOption(pending.options, kind);
    if (!outcome) return false;
    this.#pending.delete(requestId);
    pending.cancel();
    pending.resolve(outcome);
    return true;
  }

  #present(title: string, options: string[], prefill?: string, dialogOptions?: ExtensionUIDialogOptions): Promise<string | undefined> {
    if (this.#disposed) return Promise.reject(new Error('GJC ask request cancelled.'));
    const requestId = `sdk-ask:${randomUUID()}`;
    // SDK 0.15.6 calls ExtensionUIContext once per visible question and
    // performs its own multi-select toggle loop by invoking select repeatedly.
    // This bridge resolves one offered label per callback; it is not a batch
    // answer resolver and must not infer a multi-select schema from labels.
    return new Promise((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const abort = () => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#pending.delete(requestId);
        pending.cancel();
        if (pending.kind === 'ask') pending.reject(new Error('GJC ask request cancelled.'));
        this.writer.send({ kind: 'permission_cancelled', requestId });
      };
      const cancel = () => {
        if (timeout) clearTimeout(timeout);
        dialogOptions?.signal?.removeEventListener('abort', abort);
      };
      this.#pending.set(requestId, { kind: 'ask', resolve, reject, cancel });
      if (dialogOptions?.signal?.aborted) {
        abort();
        return;
      }
      dialogOptions?.signal?.addEventListener('abort', abort, { once: true });
      if (typeof dialogOptions?.timeout === 'number' && Number.isFinite(dialogOptions.timeout) && dialogOptions.timeout >= 0) {
        timeout = setTimeout(() => {
          try {
            dialogOptions.onTimeout?.();
          } finally {
            abort();
          }
        }, dialogOptions.timeout);
      }
      this.writer.send({
        kind: 'permission_request',
        requestId,
        toolName: 'ask',
        input: {
          questions: [{
            question: title || 'GJC needs your input',
            header: 'GJC',
            options: options.map((label) => ({ label })),
            multiSelect: false,
            ...(prefill ? { prefill } : {}),
          }],
        },
      });
    });
  }
}
