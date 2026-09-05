import net from 'node:net';

import { HERDR_OUTPUT_LINES, herdrPaneIdSchema, herdrTerminalIdSchema, type HerdrAgentStatus } from '../../shared/herdr-protocol.js';

export const HERDR_RPC_TIMEOUT_MS = 5_000;
export const HERDR_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const HERDR_MAX_OUTPUT_BYTES = 256 * 1024;

export type HerdrConnector = (socketPath: string) => NodeJS.ReadWriteStream;
export type HerdrDispatchGuard = { admit: () => Promise<void>; check: () => void };

export type HerdrWireWorkspace = {
  workspace_id: string;
  number: number;
  label?: string;
  focused?: boolean;
  pane_count?: number;
  tab_count?: number;
  active_tab_id?: string | null;
  agent_status?: HerdrAgentStatus;
};

export type HerdrWireTab = {
  tab_id: string;
  workspace_id: string;
  number: number;
  label?: string;
  focused?: boolean;
  pane_count?: number;
  agent_status?: HerdrAgentStatus;
};

export type HerdrWirePane = {
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  focused?: boolean;
  cwd?: string;
  foreground_cwd?: string;
  agent?: string | null;
  agent_status?: HerdrAgentStatus;
  label?: string | null;
};

export type HerdrWireSnapshot = {
  version?: string;
  protocol?: number;
  workspaces: HerdrWireWorkspace[];
  tabs: HerdrWireTab[];
  panes: HerdrWirePane[];
};

export type HerdrPaneRead = {
  pane_id: string;
  text: string;
  truncated: boolean;
  revision?: number;
};

const defaultConnector: HerdrConnector = (socketPath) => net.createConnection(socketPath);

const isObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

function status(value: unknown): HerdrAgentStatus {
  if (value === 'idle' || value === 'working' || value === 'blocked' || value === 'done' || value === 'unknown') return value;
  throw new Error('Invalid Herdr agent status.');
}

const unsigned = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function assertSnapshot(value: unknown): HerdrWireSnapshot {
  if (!isObject(value) || value.type !== 'session_snapshot') throw new Error('herdr session.snapshot: invalid result type');
  const snapshot = value.snapshot;
  if (!isObject(snapshot)) throw new Error('herdr session.snapshot: snapshot is not an object');
  const { workspaces, tabs, panes } = snapshot;
  if (typeof snapshot.version !== 'string' || !unsigned(snapshot.protocol) || !Array.isArray(snapshot.layouts) || !Array.isArray(snapshot.agents) || !Array.isArray(workspaces) || !Array.isArray(tabs) || !Array.isArray(panes)) {
    throw new Error('herdr session.snapshot: missing arrays');
  }
  return {
    version: typeof snapshot.version === 'string' ? snapshot.version : undefined,
    protocol: typeof snapshot.protocol === 'number' ? snapshot.protocol : undefined,
    workspaces: workspaces.map((raw) => {
      if (!isObject(raw) || typeof raw.workspace_id !== 'string' || typeof raw.number !== 'number' || !unsigned(raw.number) || typeof raw.label !== 'string' || typeof raw.focused !== 'boolean' || !unsigned(raw.pane_count) || !unsigned(raw.tab_count) || typeof raw.active_tab_id !== 'string') {
        throw new Error('herdr session.snapshot: invalid workspace');
      }
      return {
        workspace_id: raw.workspace_id,
        number: raw.number,
        label: typeof raw.label === 'string' ? raw.label : raw.workspace_id,
        focused: raw.focused === true,
        pane_count: typeof raw.pane_count === 'number' ? raw.pane_count : 0,
        tab_count: typeof raw.tab_count === 'number' ? raw.tab_count : 0,
        active_tab_id: typeof raw.active_tab_id === 'string' ? raw.active_tab_id : null,
        agent_status: status(raw.agent_status),
      };
    }),
    tabs: tabs.map((raw) => {
      if (!isObject(raw) || typeof raw.tab_id !== 'string' || typeof raw.workspace_id !== 'string' || typeof raw.number !== 'number' || !unsigned(raw.number) || typeof raw.label !== 'string' || typeof raw.focused !== 'boolean' || !unsigned(raw.pane_count)) {
        throw new Error('herdr session.snapshot: invalid tab');
      }
      return {
        tab_id: raw.tab_id,
        workspace_id: raw.workspace_id,
        number: raw.number,
        label: typeof raw.label === 'string' ? raw.label : String(raw.number),
        focused: raw.focused === true,
        pane_count: typeof raw.pane_count === 'number' ? raw.pane_count : 0,
        agent_status: status(raw.agent_status),
      };
    }),
    panes: panes.map((raw) => {
      if (!isObject(raw) || typeof raw.pane_id !== 'string' || typeof raw.terminal_id !== 'string' || typeof raw.workspace_id !== 'string' || typeof raw.tab_id !== 'string' || typeof raw.focused !== 'boolean') {
        throw new Error('herdr session.snapshot: invalid pane');
      }
      return {
        pane_id: herdrPaneIdSchema.parse(raw.pane_id),
        terminal_id: herdrTerminalIdSchema.parse(raw.terminal_id),
        workspace_id: raw.workspace_id,
        tab_id: raw.tab_id,
        focused: raw.focused === true,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        foreground_cwd: typeof raw.foreground_cwd === 'string' ? raw.foreground_cwd : undefined,
        agent: typeof raw.agent === 'string' ? raw.agent : null,
        agent_status: status(raw.agent_status),
        label: typeof raw.label === 'string' ? raw.label : undefined,
      };
    }),
  };
}

function assertRead(value: unknown): HerdrPaneRead {
  if (!isObject(value) || value.type !== 'pane_read') throw new Error('herdr pane.read: invalid result type');
  const read = value.read;
  if (!isObject(read) || typeof read.pane_id !== 'string' || typeof read.workspace_id !== 'string' || typeof read.tab_id !== 'string' || read.source !== 'visible' || read.format !== 'text' || !unsigned(read.revision) || typeof read.text !== 'string' || typeof read.truncated !== 'boolean') {
    throw new Error('herdr pane.read: invalid read result');
  }
  const bytes = Buffer.from(read.text, 'utf8');
  let start = Math.max(0, bytes.length - HERDR_MAX_OUTPUT_BYTES);
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
  return {
    pane_id: read.pane_id,
    text: bytes.subarray(start).toString('utf8'),
    truncated: read.truncated || start > 0,
    revision: typeof read.revision === 'number' ? read.revision : undefined,
  };
}

export class HerdrError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'HerdrError';
  }
}

export function checkHerdrAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new HerdrError('HERDR_CANCELLED', 499, 'Herdr request cancelled.');
}

export class HerdrRpcError extends HerdrError {
  constructor(code: string, message: string) {
    const failure = code === 'pane_not_found'
      ? { code: 'HERDR_NOT_FOUND', status: 404, message: 'Herdr pane was not found.' }
      : code === 'unknown_method' || code === 'unsupported_method'
        ? { code: 'HERDR_UNSUPPORTED', status: 501, message: 'Herdr does not support this operation.' }
        : { code: 'HERDR_RPC_ERROR', status: 502, message: 'Herdr rejected the request.' };
    super(failure.code, failure.status, failure.message);
    this.name = 'HerdrRpcError';
    this.rpcCode = code;
    this.rpcMessage = message;
  }
  readonly rpcCode: string;
  readonly rpcMessage: string;
}

export class HerdrClient {
  #nextId = 0;

  constructor(
    private readonly socketPath: string,
    private readonly connector: HerdrConnector = defaultConnector,
    private readonly timeoutMs = HERDR_RPC_TIMEOUT_MS,
  ) {}

  async request<T>(method: string, params: Record<string, unknown>, decode: (value: unknown) => T, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<T> {
    checkHerdrAbort(signal);
    const id = `gajae-${++this.#nextId}`;
    return new Promise<T>((resolve, reject) => {
      let socket: NodeJS.ReadWriteStream;
      try { socket = this.connector(this.socketPath); } catch {
        reject(new HerdrError('HERDR_UNAVAILABLE', 502, 'Herdr is unavailable.'));
        return;
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        socket.removeListener('connect', connected);
        try {
          const destroyable = socket as NodeJS.ReadWriteStream & { destroy?: () => void };
          if (destroyable.destroy) destroyable.destroy();
          else socket.end();
        } catch { /* The request is already settled. */ }
        fn();
      };
      const abort = () => finish(() => reject(new HerdrError('HERDR_CANCELLED', 499, 'Herdr request cancelled.')));
      const dispatch = async () => {
        try {
          if (settled) return;
          if (guard) await guard.admit();
          if (settled) return;
          guard?.check();
          checkHerdrAbort(signal);
          socket.write(`${JSON.stringify({ id, method, params })}\n`);
        } catch (error) {
          finish(() => reject(error instanceof HerdrError ? error : new HerdrError('HERDR_UNAVAILABLE', 502, 'Herdr write failed; delivery is unknown.')));
        }
      };
      const connected = () => { void dispatch(); };
      const timer = setTimeout(() => finish(() => reject(new HerdrError('HERDR_TIMEOUT', 504, 'Herdr request timed out; delivery is unknown.'))), this.timeoutMs);
      signal?.addEventListener('abort', abort, { once: true });

      socket.on('data', (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.byteLength;
        if (bytes > HERDR_MAX_FRAME_BYTES) {
          finish(() => reject(new HerdrError('HERDR_INVALID_RESPONSE', 502, 'Herdr response exceeded the byte limit.')));
          return;
        }
        buffer += decoder.decode(chunk, { stream: true });
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        finish(() => {
          try {
            const decoded = JSON.parse(line) as unknown;
            if (!isObject(decoded)) throw new Error('response is not an object');
            if (decoded.id !== id) throw new Error(`response id mismatch: expected ${id}`);
            if (Object.prototype.hasOwnProperty.call(decoded, 'error')) {
              if (Object.prototype.hasOwnProperty.call(decoded, 'result') || !isObject(decoded.error) || typeof decoded.error.code !== 'string' || typeof decoded.error.message !== 'string') throw new Error('Invalid Herdr error frame.');
              const code = decoded.error.code;
              const message = decoded.error.message;
              throw new HerdrRpcError(code, message);
            }
            if (!Object.prototype.hasOwnProperty.call(decoded, 'result')) throw new Error('response is missing result');
            resolve(decode(decoded.result));
          } catch (error) {
            reject(error instanceof HerdrError ? error : new HerdrError('HERDR_INVALID_RESPONSE', 502, 'Herdr returned an invalid response.'));
          }
        });
      });
      const unavailable = () => finish(() => reject(new HerdrError('HERDR_UNAVAILABLE', 502, 'Herdr connection ended before reply; delivery is unknown.')));
      socket.on('error', unavailable);
      socket.on('end', unavailable);
      socket.on('close', unavailable);
      if (signal?.aborted) abort();
      else if ((socket as NodeJS.ReadWriteStream & { connecting?: boolean }).connecting) socket.once('connect', connected);
      else connected();
    });
  }

  snapshot(signal?: AbortSignal): Promise<HerdrWireSnapshot> {
    return this.request('session.snapshot', {}, assertSnapshot, signal);
  }

  readPane(paneId: string, lines: number, signal?: AbortSignal): Promise<HerdrPaneRead> {
    const boundedLines = Number.isFinite(lines) ? Math.max(1, Math.min(HERDR_OUTPUT_LINES, Math.floor(lines))) : HERDR_OUTPUT_LINES;
    return this.request('pane.read', { pane_id: paneId, source: 'visible', lines: boundedLines, format: 'text' }, assertRead, signal);
  }

  async sendInput(paneId: string, text: string, keys: string[], signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<void> {
    await this.request('pane.send_input', { pane_id: paneId, text, keys }, (value) => {
      if (!isObject(value) || value.type !== 'ok') throw new Error('Invalid Herdr input acknowledgement.');
    }, signal, guard);
  }
}
