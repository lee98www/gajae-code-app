import net from 'node:net';

import { HERDR_OUTPUT_LINES, herdrPaneIdSchema, herdrTerminalIdSchema, type HerdrAgentStatus } from '../../../../shared/herdr-protocol.js';

export const HERDR_RPC_TIMEOUT_MS = 5_000;
export const HERDR_MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const HERDR_MAX_OUTPUT_BYTES = 256 * 1024;

export type HerdrConnector = (socketPath: string) => NodeJS.ReadWriteStream;
export type HerdrDispatchGuard = { admit: () => Promise<void>; check: () => void };
export type HerdrProvisionReceipt = Readonly<{ workspaceId: string; tabId: string; paneId: string; terminalId: string }>;
export type HerdrReportAgentInput = Readonly<{
  paneId: string;
  source: string;
  state: 'idle' | 'working' | 'blocked' | 'unknown';
  seq: number;
}>;
export type HerdrReleaseAgentInput = Readonly<{ paneId: string; source: string; seq: number }>;
export type HerdrReportMetadataTokenName =
  | 'gajae_native_session_id'
  | 'gajae_owner_generation'
  | 'gajae_app_session_id';
export type HerdrReportMetadataTokens = Readonly<Partial<Record<HerdrReportMetadataTokenName, string | null>>>;
export type HerdrReportMetadataInput = Readonly<{
  paneId: string;
  source: string;
  seq: number;
  tokens: HerdrReportMetadataTokens;
}>;

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
  agent_session?: { source: string; agent: string; kind: 'id'; value: string };
  agent_status?: HerdrAgentStatus;
  tokens?: Record<string, string>;
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

function assertAgentInput(input: unknown, report: boolean): asserts input is HerdrReleaseAgentInput {
  const fields = report ? ['paneId', 'source', 'state', 'seq'] : ['paneId', 'source', 'seq'];
  if (!isObject(input) || Reflect.ownKeys(input).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(input, field)) ||
    !herdrPaneIdSchema.safeParse(input.paneId).success ||
    typeof input.source !== 'string' || input.source.length > 80 || !/^[A-Za-z0-9]/.test(input.source) || /[^A-Za-z0-9._:-]/.test(input.source) ||
    !unsigned(input.seq) ||
    (report && (typeof input.state !== 'string' || !['idle', 'working', 'blocked', 'unknown'].includes(input.state)))) {
    throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr agent metadata.');
  }
}

const HERDR_METADATA_TOKEN_NAMES = new Set<HerdrReportMetadataTokenName>([
  'gajae_native_session_id',
  'gajae_owner_generation',
  'gajae_app_session_id',
]);
const HERDR_METADATA_TOKEN_KEY = /^[A-Za-z0-9_-]{1,32}$/;

function assertReportMetadataInput(input: unknown): asserts input is HerdrReportMetadataInput {
  const fields = ['paneId', 'source', 'seq', 'tokens'];
  if (!isObject(input) || Reflect.ownKeys(input).length !== fields.length ||
    !fields.every((field) => Object.prototype.hasOwnProperty.call(input, field)) ||
    !herdrPaneIdSchema.safeParse(input.paneId).success ||
    typeof input.source !== 'string' || input.source.length > 80 || !/^[A-Za-z0-9]/.test(input.source) || /[^A-Za-z0-9._:-]/.test(input.source) ||
    !unsigned(input.seq) || !isObject(input.tokens)) {
    throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr pane metadata.');
  }

  const tokenKeys = Reflect.ownKeys(input.tokens);
  if (tokenKeys.length < 1 || tokenKeys.length > HERDR_METADATA_TOKEN_NAMES.size ||
    tokenKeys.some((key) => typeof key !== 'string' || !HERDR_METADATA_TOKEN_KEY.test(key) || !HERDR_METADATA_TOKEN_NAMES.has(key as HerdrReportMetadataTokenName))) {
    throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr pane metadata tokens.');
  }
  for (const key of tokenKeys) {
    const token = input.tokens[key as keyof typeof input.tokens];
    if (token !== null && (typeof token !== 'string' || token.length < 1 || [...token].length > 80
      || token.trim() !== token || /[\u0000-\u001f\u007f-\u009f]/.test(token))) {
      throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr pane metadata token value.');
    }
  }

  const hasNativeId = Object.prototype.hasOwnProperty.call(input.tokens, 'gajae_native_session_id');
  const hasGeneration = Object.prototype.hasOwnProperty.call(input.tokens, 'gajae_owner_generation');
  const hasAppSessionId = Object.prototype.hasOwnProperty.call(input.tokens, 'gajae_app_session_id');
  if (hasNativeId !== hasGeneration) {
    throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Native session identity requires an owner generation.');
  }
  if (!hasNativeId && hasAppSessionId) {
    throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Application session identity requires a native session identity.');
  }
  if (hasNativeId) {
    const nativeId = input.tokens.gajae_native_session_id;
    const generation = input.tokens.gajae_owner_generation;
    if ((nativeId === null) !== (generation === null)) {
      throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Native session identity must be published or removed together.');
    }
    if (hasAppSessionId && (input.tokens.gajae_app_session_id === null) !== (nativeId === null)) {
      throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Application correlation must share the identity patch operation.');
    }
  }
}

function metadataTokens(value: unknown): Record<string, string> {
  // The request limit is 16, but multiple sources may contribute up to 32
  // resource tokens. Preserve foreign keys rather than rejecting valid panes.
  if (!isObject(value) || Reflect.ownKeys(value).length > 32) throw new Error('herdr session.snapshot: invalid pane tokens');
  const tokens = Object.fromEntries(Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string' || !HERDR_METADATA_TOKEN_KEY.test(key) || typeof value[key] !== 'string') {
      throw new Error('herdr session.snapshot: invalid pane tokens');
    }
    return [key, value[key] as string];
  }));
  return tokens;
}

function assertAgentAcknowledgement(value: unknown): void {
  if (!isObject(value) || value.type !== 'ok' || Object.keys(value).length !== 1) {
    throw new Error('Invalid Herdr agent acknowledgement.');
  }
}

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
      const agentSession = raw.agent_session;
      if (agentSession !== undefined && agentSession !== null && (!isObject(agentSession)
        || typeof agentSession.source !== 'string' || typeof agentSession.agent !== 'string'
        || !['id', 'path'].includes(String(agentSession.kind)) || typeof agentSession.value !== 'string')) {
        throw new Error('herdr session.snapshot: invalid agent session');
      }
      const tokens = raw.tokens === undefined ? undefined : metadataTokens(raw.tokens);
      return {
        pane_id: herdrPaneIdSchema.parse(raw.pane_id),
        terminal_id: herdrTerminalIdSchema.parse(raw.terminal_id),
        workspace_id: raw.workspace_id,
        tab_id: raw.tab_id,
        focused: raw.focused === true,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
        foreground_cwd: typeof raw.foreground_cwd === 'string' ? raw.foreground_cwd : undefined,
        agent: typeof raw.agent === 'string' ? raw.agent : null,
        ...(isObject(agentSession) && agentSession.kind === 'id' ? {
          agent_session: { source: agentSession.source as string, agent: agentSession.agent as string, kind: 'id' as const, value: agentSession.value as string },
        } : {}),
        agent_status: status(raw.agent_status),
        ...(tokens === undefined ? {} : { tokens }),
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

  snapshot(signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<HerdrWireSnapshot> {
    return this.request('session.snapshot', {}, assertSnapshot, signal, guard);
  }

  async reportAgent(input: HerdrReportAgentInput, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<void> {
    assertAgentInput(input, true);
    await this.request('pane.report_agent', {
      pane_id: input.paneId, source: input.source, agent: 'gjc', state: input.state,
      seq: input.seq,
    }, assertAgentAcknowledgement, signal, guard);
  }

  async reportMetadata(input: HerdrReportMetadataInput, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<void> {
    assertReportMetadataInput(input);
    await this.request('pane.report_metadata', {
      pane_id: input.paneId, source: input.source, tokens: Object.fromEntries(
        Object.entries(input.tokens),
      ), seq: input.seq,
    }, assertAgentAcknowledgement, signal, guard);
  }

  async releaseAgent(input: HerdrReleaseAgentInput, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<void> {
    assertAgentInput(input, false);
    await this.request('pane.release_agent', {
      pane_id: input.paneId, source: input.source, agent: 'gjc', seq: input.seq,
    }, assertAgentAcknowledgement, signal, guard);
  }

  createWorkspace(cwd: string, label: string, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<HerdrProvisionReceipt> {
    return this.request('workspace.create', { cwd, label, env: {}, focus: false }, (value) => {
      if (!isObject(value) || value.type !== 'workspace_created') throw new Error('Invalid workspace creation receipt.');
      const snapshot = assertSnapshot({ type: 'session_snapshot', snapshot: {
        version: '', protocol: 0, layouts: [], agents: [],
        workspaces: [value.workspace], tabs: [value.tab], panes: [value.root_pane],
      } });
      const workspace = snapshot.workspaces[0]!;
      const tab = snapshot.tabs[0]!;
      const pane = snapshot.panes[0]!;
      const workspaceId = herdrPaneIdSchema.parse(workspace.workspace_id);
      const tabId = herdrPaneIdSchema.parse(tab.tab_id);
      if (tab.workspace_id !== workspaceId || pane.workspace_id !== workspaceId || pane.tab_id !== tabId || workspace.active_tab_id !== tabId ||
        workspace.focused || tab.focused || pane.focused ||
        (pane.cwd !== '' && pane.cwd !== cwd) ||
        !tabId.startsWith(`${workspaceId}:t`) || !pane.pane_id.startsWith(`${workspaceId}:p`)) throw new Error('Workspace receipt mapping mismatch.');
      return Object.freeze({ workspaceId, tabId, paneId: pane.pane_id, terminalId: pane.terminal_id });
    }, signal, guard);
  }

  async applyLayout(workspaceId: string, argv: readonly string[], cwd: string, signal?: AbortSignal, guard?: HerdrDispatchGuard): Promise<HerdrProvisionReceipt> {
    herdrPaneIdSchema.parse(workspaceId);
    if (!argv.length || argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')) || !argv[0]) {
      throw new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid managed host argv.');
    }
    // Focus is verified by before/after comparison: an append with focus:false
    // must leave every focused identity exactly as it was. A parent workspace
    // the user already focused therefore stays focused and remains valid.
    const focusOf = (s: HerdrWireSnapshot) => ({
      workspaces: s.workspaces.filter((w) => w.focused).map((w) => w.workspace_id).sort(),
      tabs: s.tabs.filter((t) => t.focused).map((t) => t.tab_id).sort(),
      panes: s.panes.filter((p) => p.focused).map((p) => p.pane_id).sort(),
    });
    const before = focusOf(await this.snapshot(signal, guard));
    const receipt = await this.request('layout.apply', {
      workspace_id: workspaceId, focus: false, root: { type: 'pane', command: [...argv], cwd, env: {} },
    }, (value) => {
      if (!isObject(value) || value.type !== 'layout_apply' || !isObject(value.layout)) throw new Error('Invalid layout receipt.');
      const layout = value.layout;
      if (layout.workspace_id !== workspaceId || typeof layout.zoomed !== 'boolean' || !isObject(layout.root) || layout.root.type !== 'pane') throw new Error('Invalid layout mapping.');
      const root = layout.root;
      if ((root.command !== undefined && root.command !== null && (!Array.isArray(root.command) || root.command.some((arg) => typeof arg !== 'string'))) ||
        (root.cwd !== undefined && root.cwd !== null && typeof root.cwd !== 'string') ||
        (root.label !== undefined && root.label !== null && typeof root.label !== 'string') ||
        (root.env !== undefined && (!isObject(root.env) || Object.values(root.env).some((value) => typeof value !== 'string')))) throw new Error('Invalid layout node.');
      const tabId = herdrPaneIdSchema.parse(layout.tab_id);
      const paneId = herdrPaneIdSchema.parse(layout.root.pane_id);
      if (!tabId.startsWith(`${workspaceId}:t`) || !paneId.startsWith(`${workspaceId}:p`) || layout.focused_pane_id !== paneId) throw new Error('Invalid layout pane mapping.');
      return { tabId, paneId };
    }, signal, guard);
    // LayoutDescription has no terminal id. Resolve only its exact IDs.
    const snapshot = await this.snapshot(signal, guard);
    const workspaces = snapshot.workspaces.filter((w) => w.workspace_id === workspaceId);
    const tabs = snapshot.tabs.filter((t) => t.tab_id === receipt.tabId);
    const panes = snapshot.panes.filter((p) => p.pane_id === receipt.paneId);
    if (workspaces.length !== 1 || tabs.length !== 1 || tabs[0]!.workspace_id !== workspaceId || panes.length !== 1 ||
      panes[0]!.workspace_id !== workspaceId || panes[0]!.tab_id !== receipt.tabId || tabs[0]!.focused ||
      panes[0]!.focused || (panes[0]!.cwd !== '' && panes[0]!.cwd !== cwd)) {
      throw new HerdrError('HERDR_INVALID_RESPONSE', 502, 'Herdr layout mapping is unknown.');
    }
    if (JSON.stringify(focusOf(snapshot)) !== JSON.stringify(before)) {
      throw new HerdrError('HERDR_INVALID_RESPONSE', 502, 'Herdr layout changed focus.');
    }
    return Object.freeze({ workspaceId, ...receipt, terminalId: panes[0]!.terminal_id });
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
