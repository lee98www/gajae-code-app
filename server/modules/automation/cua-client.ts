import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import readline from 'node:readline';

export const CUA_SAFE_TOOLS = [
  'start_session',
  'end_session',
  'list_apps',
  'list_windows',
  'get_window_state',
  'get_accessibility_tree',
  'launch_app',
  'set_window_frame',
  'move_cursor',
  'click',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'invoke_menu',
] as const;

export type CuaSafeTool = (typeof CUA_SAFE_TOOLS)[number];

export type CuaStatus = {
  installed: boolean;
  version?: string;
  daemon: 'running' | 'stopped' | 'unknown';
  accessibility?: boolean;
  screenRecording?: boolean;
  error?: string;
};

type JsonRpcResponse = {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export type CuaTransportDispatchState = 'not_sent' | 'possibly_dispatched';

/**
 * The driver transport failed before a verified tool result arrived. Once the
 * request write starts, the caller cannot infer whether the driver performed
 * the action, so the operation must remain unresolved.
 */
export class CuaTransportError extends Error {
  readonly kind = 'transport-failure' as const;

  constructor(
    message: string,
    readonly dispatchState: CuaTransportDispatchState,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'CuaTransportError';
  }
}

/** The driver returned a structured JSON-RPC failure, which is a known result. */
export class CuaKnownResultError extends Error {
  readonly kind = 'known-result' as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CuaKnownResultError';
  }
}

/** JSON-RPC errors are known driver responses rather than transport loss. */
export class CuaDriverResponseError extends CuaKnownResultError {
  readonly code?: number;
  readonly data?: unknown;

  constructor(message: string, code?: number, data?: unknown) {
    super(message);
    this.name = 'CuaDriverResponseError';
    this.code = code;
    this.data = data;
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  dispatchState: CuaTransportDispatchState;
};

function executableCandidates(): string[] {
  if (process.env.CUA_DRIVER_PATH) return [process.env.CUA_DRIVER_PATH];
  return [
    join(homedir(), '.local', 'bin', 'cua-driver'),
    '/opt/homebrew/bin/cua-driver',
    '/usr/local/bin/cua-driver',
  ];
}

async function findExecutable(): Promise<string | null> {
  for (const candidate of executableCandidates()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue through the small, explicit set of supported install paths.
    }
  }
  return null;
}

async function runInspection(executable: string, args: string[], timeoutMs = 3_000): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let settled = false;
    const finish = (result: { ok: boolean; output: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ ok: false, output: output.trim() });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.on('error', () => {
      finish({ ok: false, output: output.trim() });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, output: output.trim() });
    });
  });
}

function permissionValue(output: string, names: string[]): boolean | undefined {
  const line = output.split(/\r?\n/u).find((entry) => names.some((name) => entry.toLowerCase().includes(name)));
  if (!line) return undefined;
  if (/\b(?:denied|not granted|disabled|unauthorized|no|false)\b|❌/iu.test(line)) return false;
  if (/\b(?:granted|authorized|enabled|yes|true)\b|✅/iu.test(line)) return true;
  return undefined;
}

export class CuaDriverClient {
  private child?: ChildProcessWithoutNullStreams;
  private starting?: Promise<void>;
  private sequence = 0;
  private readonly pending = new Map<string | number, Pending>();

  async status(): Promise<CuaStatus> {
    const executable = await findExecutable();
    if (!executable) return { installed: false, daemon: 'unknown' };
    const [version, daemon, permissions] = await Promise.all([
      runInspection(executable, ['--version']),
      runInspection(executable, ['status']),
      process.platform === 'darwin'
        ? runInspection(executable, ['permissions', 'status'])
        : Promise.resolve({ ok: true, output: '' }),
    ]);
    return {
      installed: true,
      version: version.output.split(/\r?\n/u)[0]?.slice(0, 120),
      daemon: daemon.ok ? 'running' : /not running|stopped|unavailable/iu.test(daemon.output) ? 'stopped' : 'unknown',
      accessibility: permissionValue(permissions.output, ['accessibility']),
      screenRecording: permissionValue(permissions.output, ['screen recording', 'screen capture']),
      ...(!version.ok ? { error: version.output || 'Unable to inspect CUA Driver.' } : {}),
    };
  }

  async call(tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    if (!CUA_SAFE_TOOLS.includes(tool)) throw new Error('CUA Driver tool is not allowed.');
    if (signal?.aborted) throw new CuaTransportError('CUA Driver request was cancelled.', 'not_sent');
    try { await this.ensureStarted(); }
    catch (error) { throw new CuaTransportError('CUA Driver initialization failed.', 'not_sent', { cause: error }); }
    return this.request('tools/call', { name: tool, arguments: args }, 60_000, signal);
  }

  async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.failAll(new Error('CUA Driver is shutting down.'), child);
    child.stdin.end();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 2_000);
      child.once('close', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.child && this.child.exitCode === null) return;
    this.starting = (async () => {
      const executable = await findExecutable();
      if (!executable) throw new CuaTransportError('CUA Driver is not installed.', 'not_sent');
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(executable, ['mcp'], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: process.env,
        });
      } catch (error) {
        throw new CuaTransportError('CUA Driver could not be started.', 'not_sent', { cause: error });
      }
      this.child = child;
      const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => this.handleLine(line, child));
      child.stderr.on('data', () => {});
      child.stdin.on('error', (error) => this.failAll(error, child, true));
      child.on('close', () => this.failAll(new Error('CUA Driver disconnected.'), child));
      child.on('error', (error) => this.failAll(error, child, true));
      await this.request('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gajae-code-app', version: '0.1.0' },
      }, 10_000);
      this.notify('notifications/initialized', {});
    })().catch(async error => {
      await this.shutdown();
      throw error;
    }).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private request(method: string, params: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const child = this.child;
    if (!child || child.exitCode !== null) {
      return Promise.reject(new CuaTransportError('CUA Driver is unavailable.', 'not_sent'));
    }
    const id = `${++this.sequence}-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        this.notify('notifications/cancelled', { requestId: id, reason: 'Client request cancelled.' });
        pending.reject(new CuaTransportError('CUA Driver request was cancelled.', pending.dispatchState));
      };
      const pending: Pending = {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort);
          reject(error);
        },
        timer: setTimeout(() => {
          this.pending.delete(id);
          pending.reject(new CuaTransportError('CUA Driver request timed out.', pending.dispatchState));
        }, timeoutMs),
        dispatchState: 'not_sent',
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, pending);
      try {
        if (signal?.aborted) {
          onAbort();
          return;
        }
        const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
        pending.dispatchState = 'possibly_dispatched';
        child.stdin.write(
          frame,
          (error?: Error | null) => {
            if (!error) return;
            const pending = this.pending.get(id);
            if (!pending) return;
            this.pending.delete(id);
            clearTimeout(pending.timer);
            pending.reject(new CuaTransportError('CUA Driver request could not be written.', pending.dispatchState, { cause: error }));
          },
        );
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(pending.timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new CuaTransportError(
          'CUA Driver request could not be written.',
          pending.dispatchState,
          { cause: error },
        ));
      }
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    } catch {
      // Cancellation is already represented by the typed request failure.
    }
  }

  private handleLine(line: string, source: ChildProcessWithoutNullStreams): void {
    if (source !== this.child) return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message) || message.id === undefined) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (message.jsonrpc !== '2.0' || hasResult === hasError
      || (hasError && (!message.error || !Number.isInteger(message.error.code) || typeof message.error.message !== 'string'))) {
      pending.reject(new CuaTransportError('CUA Driver returned an invalid response.', pending.dispatchState));
      return;
    }
    if (message.error) {
      pending.reject(new CuaDriverResponseError(
        message.error.message || 'CUA Driver request failed.',
        message.error.code,
        message.error.data,
      ));
    }
    else pending.resolve(message.result);
  }

  private failAll(error: Error, source: ChildProcessWithoutNullStreams, terminate = false): void {
    if (source !== this.child) return;
    this.child = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new CuaTransportError(error.message, pending.dispatchState, { cause: error }));
    }
    this.pending.clear();
    if (terminate && source.exitCode === null && !source.killed) source.kill('SIGTERM');
  }
}

export function isCuaSafeTool(value: unknown): value is CuaSafeTool {
  return typeof value === 'string' && (CUA_SAFE_TOOLS as readonly string[]).includes(value);
}
