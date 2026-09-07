import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import net, { type Server as NetServer, type Socket } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { canonicalManagedInvocation, HERDR_MANAGED_TARGET_REJECTED, herdrManagedBridgeRequestSchema, verifyManagedBridgeInvocation, type HerdrManagedBridgeRequest, type HerdrManagedBridgeResponse } from '../../../shared/herdr-managed-bridge.js';
import { herdrManagedTargetBindingSchema, managedInstalledBundleIdSchema, type HerdrManagedAutomationIdentity, type HerdrManagedTargetBinding } from '../../../shared/herdr-managed-protocol.js';

import { ManagedBridgeLedger } from './managed-bridge-ledger.js';
import { InstalledAppResolver } from './installed-app-resolver.js';
import { AutomationGrantStore, type AutomationGrant } from './automation-grants.js';
import { BrowserSidecarClient, type BrowserEventListener } from './browser-sidecar-client.js';
import type { BrowserCommand, BrowserInput, BrowserSessionState } from './browser-protocol.js';
import { automationOrigin } from './automation-url.js';
import {
  CuaDriverClient,
  CuaKnownResultError,
  CuaTransportError,
  isCuaSafeTool,
  type CuaSafeTool,
} from './cua-client.js';

type BridgeRequest = {
  id: string;
  token: string;
  surface: 'browser' | 'computer';
  sessionId: string;
  operation?: 'open' | 'close' | 'command' | 'authorize';
  payload?: Record<string, unknown>;
  tool?: string;
  arguments?: Record<string, unknown>;
};

type CuaApplication = {
  bundle_id?: unknown;
  name?: unknown;
  pid?: unknown;
};

type CuaWindow = {
  pid?: unknown;
  window_id?: unknown;
};

type CuaApplicationAuthorization = {
  granted: boolean;
  application: string | null;
  label: string | null;
};

type ManagedExecutionResult =
  | { kind: 'known'; result: unknown }
  | { kind: 'known-negative'; error: string };

const MAX_BRIDGE_LINE = 2 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeBridgeId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}

function structuredObject(value: unknown): Record<string, unknown> {
  const record = object(value);
  return object(record.structuredContent ?? record.result ?? record);
}

function applicationRecords(value: unknown): CuaApplication[] {
  const apps = structuredObject(value).apps;
  return Array.isArray(apps)
    ? apps.filter((app): app is CuaApplication => Boolean(app && typeof app === 'object' && !Array.isArray(app)))
    : [];
}

function windowRecords(value: unknown): CuaWindow[] {
  const windows = structuredObject(value).windows;
  return Array.isArray(windows)
    ? windows.filter((window): window is CuaWindow => Boolean(window && typeof window === 'object' && !Array.isArray(window)))
    : [];
}

function cuaToolError(value: unknown): string | null {
  const record = object(value);
  if (record.isError !== true) return null;
  const content = Array.isArray(record.content) ? record.content : [];
  const message = content
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object' && !Array.isArray(item)))
    .map((item) => typeof item.text === 'string' ? item.text : '')
    .filter(Boolean)
    .join('\n');
  return message || 'CUA Driver rejected the session request.';
}

function requestedPid(args: Record<string, unknown>): number | undefined {
  if (typeof args.pid === 'number' && Number.isSafeInteger(args.pid) && args.pid > 0) return args.pid;
  const target = object(args.target);
  return typeof target.pid === 'number' && Number.isSafeInteger(target.pid) && target.pid > 0
    ? target.pid
    : undefined;
}

function requestedWindowId(args: Record<string, unknown>): number | undefined {
  if (typeof args.window_id === 'number' && Number.isSafeInteger(args.window_id) && args.window_id > 0) {
    return args.window_id;
  }
  const target = object(args.target);
  return typeof target.window_id === 'number' && Number.isSafeInteger(target.window_id) && target.window_id > 0
    ? target.window_id
    : undefined;
}

const COMPUTER_DISCOVERY_TOOLS = new Set<CuaSafeTool>([
  'start_session', 'end_session', 'list_apps', 'get_accessibility_tree', 'move_cursor',
]);

/**
 * Synthetic identity for the app-owned Chrome-for-Testing sidecar. It runs
 * outside any installed app bundle, so the CUA inventory cannot resolve its
 * windows to a bundle id — without this identity every computer action against
 * the Workspace Browser window fails as "unresolvable" even though the target
 * is the app's own browser.
 */
const WORKSPACE_BROWSER_APPLICATION_ID = 'app.gajae.workspace-browser';
const WORKSPACE_BROWSER_LABEL = 'Workspace Browser';

/** An invocation the App can never bind to a managed target; nothing was dispatched. */
export class ManagedTargetRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'ManagedTargetRejectedError'; }
}

export class AutomationService {
  readonly browser = new BrowserSidecarClient();
  readonly cua = new CuaDriverClient();
  readonly grants = new AutomationGrantStore();
  readonly supported = (process.env.GJC_DESKTOP === '1' && process.platform === 'darwin' && process.arch === 'arm64')
    || process.env.GAJAE_AUTOMATION === '1';
  private readonly bridgeToken = randomBytes(32).toString('hex');
  private readonly bridgePath = process.env.GAJAE_AUTOMATION_SOCKET
    ?? join(tmpdir(), `gajae-automation-${process.pid}.sock`);
  private bridge?: NetServer;
  private readonly cuaSessionLabels = new Map<string, string>();
  private readonly bridgeInstanceId = randomUUID();
  private managedLedger?: ManagedBridgeLedger;
  private readonly managedBindings = new Map<string, HerdrManagedTargetBinding>();

  constructor(
    private readonly managedHome = process.env.DATABASE_PATH ? dirname(process.env.DATABASE_PATH) : join(homedir(), '.gajae-app'),
    private readonly installedApps: Pick<InstalledAppResolver, 'resolve' | 'revalidate'> = new InstalledAppResolver(),
  ) {}

  async status() {
    const [browser, cua] = await Promise.all([
      this.supported
        ? this.browser.status().catch((error) => ({ state: 'error', installed: false, buildId: 'unknown', error: error instanceof Error ? error.message : String(error) }))
        : Promise.resolve({ state: 'idle', installed: false, buildId: 'unsupported' }),
      this.cua.status(),
    ]);
    return {
      supported: this.supported,
      platform: process.platform,
      architecture: process.arch,
      browser,
      cua,
    };
  }

  subscribeBrowser(listener: BrowserEventListener): () => void {
    return this.browser.subscribe(listener);
  }

  async openBrowser(
    sessionId: string,
    payload: { url?: string; allowDownload?: boolean; waitUntil?: string },
    signal?: AbortSignal,
  ): Promise<unknown> {
    this.requireSupported();
    return this.browser.open(sessionId, payload, signal);
  }

  commandBrowser(sessionId: string, command: BrowserCommand, signal?: AbortSignal): Promise<unknown> {
    this.requireSupported();
    return this.browser.command(sessionId, command, signal);
  }

  inputBrowser(sessionId: string, input: BrowserInput): Promise<unknown> {
    this.requireSupported();
    return this.browser.input(sessionId, input);
  }

  async stopSession(sessionId: string): Promise<unknown> {
    this.grants.clearSession(sessionId);
    const signal = AbortSignal.timeout(2_500);
    const [browser] = await Promise.allSettled([
      this.browser.close(sessionId, signal),
      this.endComputerSession(sessionId, signal),
    ]);
    return browser.status === 'fulfilled' ? browser.value : { closed: false };
  }

  private async stopManagedSession(sessionId: string, signal: AbortSignal): Promise<unknown> {
    this.grants.clearSession(sessionId);
    const [browser, computer] = await Promise.allSettled([
      this.browser.close(sessionId, signal),
      this.endComputerSession(sessionId, signal),
    ]);
    if (browser.status === 'rejected') throw browser.reason;
    if (computer.status === 'rejected') throw computer.reason;
    const computerError = cuaToolError(computer.value);
    if (computerError) throw new CuaKnownResultError(computerError);
    return browser.value;
  }

  grant(grant: AutomationGrant): void {
    const value = grant.kind === 'origin' ? automationOrigin(grant.value) : grant.value.trim();
    if (!value) throw new Error('A web origin is required for this grant.');
    this.grants.grant({ ...grant, value });
  }

  async authorizeBrowser(
    sessionId: string,
    payload: { url?: unknown; scope?: unknown },
    signal?: AbortSignal,
  ): Promise<{ granted: boolean; origin: string | null }> {
    this.requireSupported();
    let rawUrl = typeof payload.url === 'string' ? payload.url : undefined;
    if (!rawUrl) {
      const state = await this.browser.state(sessionId, signal) as BrowserSessionState;
      rawUrl = state.tabs.find((tab) => tab.id === state.activeTabId)?.url;
    }
    if (!rawUrl) throw new Error('Open a browser tab before requesting browser access.');
    const origin = automationOrigin(rawUrl);
    if (!origin) return { granted: true, origin: null };
    if (payload.scope === 'session' || payload.scope === 'always') {
      this.grant({
        kind: 'origin',
        value: origin,
        scope: payload.scope,
        ...(payload.scope === 'session' ? { sessionId } : {}),
      });
    }
    return { granted: this.grants.has('origin', origin, sessionId), origin };
  }

  async authorizeComputer(
    sessionId: string,
    payload: { tool?: unknown; arguments?: unknown; scope?: unknown; application?: unknown },
    signal?: AbortSignal,
  ): Promise<CuaApplicationAuthorization> {
    this.requireSupported();
    if (!isCuaSafeTool(payload.tool)) throw new Error('Unsupported CUA Driver tool.');
    const args = object(payload.arguments);
    let application = typeof payload.application === 'string' ? payload.application.trim() : '';
    let label: string | null = null;

    if (!application && payload.tool === 'launch_app') {
      application = typeof args.bundle_id === 'string' ? args.bundle_id.trim() : '';
      label = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null;
    }

    let pid = requestedPid(args);
    const windowId = requestedWindowId(args);
    const sidecarPid = this.browser.browserPid;
    const needsApplication = payload.tool === 'launch_app'
      || pid !== undefined
      || windowId !== undefined
      || (payload.tool === 'list_windows' && args.pid !== undefined);
    if (!application && needsApplication && !(pid !== undefined && pid === sidecarPid)) {
      const inventory = await this.cua.call(
        pid === undefined && windowId !== undefined ? 'list_windows' : 'list_apps',
        {},
        signal,
      );
      if (pid === undefined && windowId !== undefined) {
        const window = windowRecords(inventory).find((candidate) => candidate.window_id === windowId);
        if (window && typeof window.pid === 'number' && Number.isSafeInteger(window.pid) && window.pid > 0) {
          pid = window.pid;
        }
      }
      let apps = applicationRecords(inventory);
      if (pid !== undefined && apps.length === 0) {
        apps = applicationRecords(await this.cua.call('list_apps', {}, signal));
      }
      const requestedName = typeof args.name === 'string' ? args.name.trim().toLocaleLowerCase() : '';
      const match = apps.find((app) => (
        (pid !== undefined && app.pid === pid)
        || (requestedName && typeof app.name === 'string' && app.name.trim().toLocaleLowerCase() === requestedName)
      ));
      if (match && typeof match.bundle_id === 'string') application = match.bundle_id.trim();
      if (match && typeof match.name === 'string' && match.name.trim()) label = match.name.trim();
    }

    if (!application && pid !== undefined && pid === sidecarPid) {
      application = WORKSPACE_BROWSER_APPLICATION_ID;
      label = WORKSPACE_BROWSER_LABEL;
    }

    if (!application) {
      if (COMPUTER_DISCOVERY_TOOLS.has(payload.tool) || (payload.tool === 'list_windows' && !needsApplication)) {
        return { granted: true, application: null, label: null };
      }
      throw new Error('Computer action requires a resolvable application identity.');
    }
    if (!label) label = application;
    if (payload.scope === 'session' || payload.scope === 'always') {
      this.grant({
        kind: 'application',
        value: application,
        scope: payload.scope,
        ...(payload.scope === 'session' ? { sessionId } : {}),
      });
    }
    return {
      granted: this.grants.has('application', application, sessionId),
      application,
      label,
    };
  }

  async callComputer(sessionId: string, tool: CuaSafeTool, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    this.requireSupported();
    const { session: _ignoredSession, ...scopedArgs } = args;
    if (tool === 'end_session') return this.endComputerSession(sessionId, signal);
    const { label, result } = await this.ensureComputerSession(
      sessionId,
      tool === 'start_session' ? scopedArgs : {},
      signal,
    );
    if (tool === 'start_session') return result;
    return this.cua.call(tool, { ...scopedArgs, session: label }, signal);
  }

  async startBridge(): Promise<void> {
    if (!this.supported) return;
    if (this.bridge) return;
    if (process.platform !== 'win32') await rm(this.bridgePath, { force: true }).catch(() => {});
    await mkdir(join(tmpdir()), { recursive: true });
    const bridge = net.createServer((socket) => this.handleBridgeSocket(socket));
    await new Promise<void>((resolve, reject) => {
      bridge.once('error', reject);
      bridge.listen(this.bridgePath, () => {
        bridge.off('error', reject);
        resolve();
      });
    });
    if (process.platform !== 'win32') await chmod(this.bridgePath, 0o600);
    this.bridge = bridge;
    process.env.GJC_AUTOMATION_SOCKET = this.bridgePath;
    process.env.GJC_AUTOMATION_TOKEN = this.bridgeToken;
  }

  /** Server-only capability. Never include it in HTTP/WebSocket status responses. */
  managedBridgeCapability(): { socketPath: string; token: string; bridgeInstanceId: string } | null {
    if (!this.supported || !this.bridge?.listening) return null;
    return { socketPath: this.bridgePath, token: this.bridgeToken, bridgeInstanceId: this.bridgeInstanceId };
  }

  async shutdown(): Promise<void> {
    const computerSessions = [...this.cuaSessionLabels.keys()];
    await Promise.allSettled([
      this.browser.shutdown(),
      ...computerSessions.map((sessionId) => this.endComputerSession(sessionId, AbortSignal.timeout(2_000))),
    ]);
    await this.cua.shutdown();
    const bridge = this.bridge;
    this.bridge = undefined;
    if (bridge) await new Promise<void>((resolve) => bridge.close(() => resolve()));
    this.managedLedger?.close();
    this.managedLedger = undefined;
    this.managedBindings.clear();
    if (process.platform !== 'win32') await rm(this.bridgePath, { force: true }).catch(() => {});
    delete process.env.GJC_AUTOMATION_SOCKET;
    delete process.env.GJC_AUTOMATION_TOKEN;
  }

  private newComputerSessionLabel(): string {
    return `gajae-${randomUUID()}`;
  }

  private async ensureComputerSession(
    sessionId: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ label: string; result: unknown }> {
    let label = this.cuaSessionLabels.get(sessionId);
    if (!label) {
      label = this.newComputerSessionLabel();
      this.cuaSessionLabels.set(sessionId, label);
    }
    const result = await this.cua.call('start_session', { ...args, session: label }, signal);
    const error = cuaToolError(result);
    if (error) {
      // Retain this identity. A revocation or suspension must not be converted
      // into a newly named session with fresh authority on the next call.
      throw new CuaKnownResultError(error);
    }
    return { label, result };
  }

  private async endComputerSession(sessionId: string, signal?: AbortSignal): Promise<unknown> {
    const label = this.cuaSessionLabels.get(sessionId);
    this.cuaSessionLabels.delete(sessionId);
    if (!label) return { ended: false };
    return this.cua.call('end_session', { session: label }, signal);
  }

  private requireSupported(): void {
    if (!this.supported) throw new Error('Automation is available on Apple Silicon macOS in this preview.');
  }

  private managedInvocation(value: unknown): BridgeRequest {
    const request = object(value);
    if (!safeBridgeId(request.sessionId) || !['browser', 'computer'].includes(String(request.surface))
      || Object.keys(request).some(key => !['surface', 'sessionId', 'operation', 'payload', 'tool', 'arguments'].includes(key))) {
      throw new Error('Invalid managed invocation.');
    }
    if (request.surface === 'computer') {
      if (request.operation !== undefined && request.operation !== 'authorize') throw new Error('Unsupported managed computer operation.');
      const args = object(request.arguments);
      const target = object(args.target);
      for (const key of ['pid', 'window_id']) {
        if ((args[key] !== undefined && (!Number.isSafeInteger(args[key]) || Number(args[key]) <= 0))
          || (target[key] !== undefined && (!Number.isSafeInteger(target[key]) || Number(target[key]) <= 0))
          || (args[key] !== undefined && target[key] !== undefined && args[key] !== target[key])) throw new Error('Ambiguous managed computer selector.');
      }
    }
    return request as BridgeRequest;
  }

  private managedBindingKey(identity: HerdrManagedAutomationIdentity, sourceOperationId: string): string {
    const { operationId: _operationId, targetContext: _targetContext, ...owner } = identity;
    return canonicalManagedInvocation({ ...owner, sourceOperationId });
  }

  private async resolveManagedTarget(request: BridgeRequest, signal: AbortSignal): Promise<HerdrManagedTargetBinding> {
    if (request.surface === 'browser') {
      if (!['open', 'close', 'authorize', 'command'].includes(String(request.operation))) throw new ManagedTargetRejectedError('Unsupported managed browser operation.');
      if (request.operation === 'close') return { kind: 'session-management', operation: 'close', sessionId: request.sessionId };
      const payload = object(request.payload);
      const command = object(payload.command);
      if (['selectTab', 'newTab', 'closeTab'].includes(String(command.action))) throw new ManagedTargetRejectedError('Managed tab management requires a new target binding.');
      const rawUrl = request.operation === 'command' ? command.url : payload.url;
      let state: BrowserSessionState;
      try { state = await this.browser.state(request.sessionId, signal) as BrowserSessionState; }
      catch (error) {
        // A new session has no tab yet. Only the exact sidecar absence result
        // authorizes that narrow binding; transport failures are not absence.
        if (!(error instanceof Error) || !error.message.startsWith('session_not_found:')) throw error;
        // A command against a session this App instance does not have (it was
        // opened by an instance that has since quit) can never bind: the agent
        // must open the session again, which is a different invocation.
        if (request.operation !== 'open' && !(request.operation === 'authorize' && typeof rawUrl === 'string')) throw new ManagedTargetRejectedError('Managed browser session is not open in this app instance: open the browser session first.');
        state = { sessionId: request.sessionId, activeTabId: null, tabs: [] };
      }
      const tab = state.tabs.find(candidate => candidate.id === state.activeTabId);
      if (rawUrl !== undefined) {
        const origin = typeof rawUrl === 'string' ? automationOrigin(rawUrl) : null;
        if (!origin) throw new ManagedTargetRejectedError(`Managed browser target requires a concrete http(s) origin; ${typeof rawUrl === 'string' ? JSON.stringify(rawUrl.slice(0, 200)) : 'the url'} has none.`);
        return { kind: 'browser-origin', origin, tabId: tab?.id ?? 'no-active-tab' };
      }
      if (!tab && request.operation === 'open') return { kind: 'session-management', operation: 'open', sessionId: request.sessionId };
      const origin = tab && automationOrigin(tab.url);
      if (!tab || !origin) throw new ManagedTargetRejectedError('Managed browser target is unresolved: open a page with a concrete http(s) origin first.');
      return { kind: 'browser-origin', origin, tabId: tab.id };
    }
    if (!isCuaSafeTool(request.tool)) throw new ManagedTargetRejectedError('Unsupported managed computer operation.');
    const args = object(request.arguments);
    if (request.tool === 'launch_app') {
      const payload = object(request.payload);
      // Managed launch accepts only an exact bundle identifier, never display names or overrides.
      if (!managedInstalledBundleIdSchema.safeParse(args.bundle_id).success
        || Object.keys(args).some(key => key !== 'bundle_id')
        || Object.keys(payload).some(key => key !== 'scope' && key !== 'application')
        || (payload.application !== undefined && payload.application !== args.bundle_id)
        || (payload.scope !== undefined && !['session', 'always'].includes(String(payload.scope)))
        || (request.operation !== 'authorize' && Object.keys(payload).length > 0)) {
        throw new ManagedTargetRejectedError('Managed launch requires only an exact bundle_id selector.');
      }
      return this.installedApps.resolve(args.bundle_id as string, signal);
    }
    let pid = requestedPid(args);
    const windowId = requestedWindowId(args);
    if (windowId !== undefined) {
      const window = windowRecords(await this.cua.call('list_windows', {}, signal)).find(candidate => candidate.window_id === windowId);
      if (!window || typeof window.pid !== 'number' || (pid !== undefined && pid !== window.pid)) throw new Error('Managed window target is unresolved.');
      pid = window.pid;
    }
    if (pid === undefined && windowId === undefined && ['start_session', 'end_session'].includes(request.tool)) {
      return { kind: 'session-management', operation: request.tool, sessionId: request.sessionId };
    }
    if (pid === undefined && windowId === undefined && ['list_apps', 'list_windows'].includes(request.tool)) return { kind: 'discovery', operation: request.tool };
    const apps = applicationRecords(await this.cua.call('list_apps', {}, signal));
    const match = apps.find(app => pid !== undefined ? app.pid === pid
      : (typeof args.bundle_id === 'string' && app.bundle_id === args.bundle_id)
        || (typeof args.name === 'string' && typeof app.name === 'string' && app.name.toLocaleLowerCase() === args.name.toLocaleLowerCase()));
    if (pid === undefined && typeof match?.pid === 'number') pid = match.pid;
    const bundleId = pid !== undefined && pid === this.browser.browserPid ? WORKSPACE_BROWSER_APPLICATION_ID
      : typeof match?.bundle_id === 'string' ? match.bundle_id.trim() : '';
    if (!pid || !Number.isSafeInteger(pid) || !bundleId) throw new Error('Managed computer target is unresolved.');
    return { kind: 'cua-application', pid, windowId: windowId ?? null, bundleId };
  }

  private async executeManaged(
    request: BridgeRequest,
    binding: HerdrManagedTargetBinding,
    signal: AbortSignal,
    computerSessionLabel?: string,
  ): Promise<ManagedExecutionResult> {
    if (request.surface === 'browser') {
      if (request.operation === 'open') return {
        kind: 'known',
        result: await this.browser.open(request.sessionId, object(request.payload), signal, {
          tabId: binding.kind === 'browser-origin' && binding.tabId !== 'no-active-tab' ? binding.tabId : null,
          ...(binding.kind === 'browser-origin' ? { origin: binding.origin } : {}),
        }),
      };
      if (request.operation === 'close') return {
        kind: 'known',
        result: await this.stopManagedSession(request.sessionId, signal),
      };
      if (request.operation === 'authorize') return {
        kind: 'known',
        result: await this.authorizeBrowser(request.sessionId, {
          ...object(request.payload),
          ...(binding.kind === 'browser-origin' ? { url: binding.origin } : {}),
        }, signal),
      };
      if (binding.kind !== 'browser-origin' || binding.tabId === 'no-active-tab') {
        throw new Error('Managed browser command requires a bound tab.');
      }
      return {
        kind: 'known',
        result: await this.browser.command(request.sessionId, object(request.payload?.command) as BrowserCommand, signal, {
          tabId: binding.tabId, origin: binding.origin,
        }),
      };
    }
    if (!isCuaSafeTool(request.tool)) throw new Error('Unsupported CUA tool.');
    if (request.operation === 'authorize') {
      return {
        kind: 'known',
        result: await this.authorizeComputer(request.sessionId, {
          tool: request.tool, arguments: request.arguments,
          scope: object(request.payload).scope,
          ...(binding.kind === 'cua-application' || binding.kind === 'cua-installed-application' ? { application: binding.bundleId } : {}),
        }, signal),
      };
    }
    if (binding.kind === 'cua-installed-application') {
      if (request.tool !== 'launch_app') throw new Error('Invalid installed application operation.');
      if (!this.grants.has('application', binding.bundleId, request.sessionId)) {
        throw new Error('Installed application access requires approval.');
      }
      // handleManaged revalidates immediately before its synchronous durable
      // reservation. Do not add an awaited lookup after reservation: a changed
      // identity must still be fenceable as not-dispatched and require renewal.
      signal.throwIfAborted();
      if (!computerSessionLabel) throw new Error('Managed computer session is unavailable.');
      const result = await this.cua.call('launch_app', { bundle_id: binding.bundleId, session: computerSessionLabel }, signal);
      const error = cuaToolError(result);
      if (error) return { kind: 'known-negative', error };
      return { kind: 'known', result: { bundleId: binding.bundleId, launchRequested: true } };
    }
    const args = { ...object(request.arguments) };
    if (binding.kind === 'cua-application') {
      // Never execute through a caller name or an ambient selector after inventory resolution.
      delete args.name;
      delete args.bundle_id;
      args.pid = binding.pid;
      if (binding.windowId !== null) args.window_id = binding.windowId;
      if (args.target !== undefined) {
        args.target = { ...object(args.target), pid: binding.pid, ...(binding.windowId !== null ? { window_id: binding.windowId } : {}) };
      }

    }
    if (binding.kind === 'cua-application' && !computerSessionLabel) throw new Error('Managed computer session is unavailable.');
    const result = binding.kind === 'cua-application'
      ? await this.cua.call(request.tool, { ...args, session: computerSessionLabel! }, signal)
      : await this.callComputer(request.sessionId, request.tool, args, signal);
    const error = cuaToolError(result);
    if (error) return { kind: 'known-negative', error };
    return { kind: 'known', result };
  }

  private async handleManaged(request: HerdrManagedBridgeRequest, signal: AbortSignal): Promise<unknown> {
    this.requireSupported();
    if (!this.managedLedger) {
      try { this.managedLedger = new ManagedBridgeLedger(this.managedHome); }
      catch { throw new Error('Managed bridge protected ledger is unavailable.'); }
    }
    const ledger = this.managedLedger;
    if (request.type === 'managed-lookup') return ledger.lookupOutcome(request.attempt);
    if (request.type === 'managed-fence') return ledger.fenceUndispatched(request.attempt);
    const identity = request.type === 'managed-resolve-target' ? request.identity : request.attempt.identity;
    await verifyManagedBridgeInvocation(identity, request.invocation);
    const invocation = this.managedInvocation(request.invocation);
    if (request.type === 'managed-resolve-target') {
      if (request.bridgeInstanceId !== this.bridgeInstanceId) throw new Error('Managed bridge instance changed.');
      const targetBinding = herdrManagedTargetBindingSchema.parse(await this.resolveManagedTarget(invocation, signal));
      const key = this.managedBindingKey(identity, request.sourceOperationId);
      if (!this.managedBindings.has(key) && this.managedBindings.size >= 8192) throw new Error('Managed target binding limit exceeded.');
      this.managedBindings.set(key, targetBinding);
      return { type: 'managed-target', requestId: request.requestId, identity, sourceOperationId: request.sourceOperationId, bridgeInstanceId: this.bridgeInstanceId, invocationHash: identity.argumentsHash, targetBinding };
    }
    const attempt = request.attempt;
    // Lookup old instances before demanding a live binding: completed responses survive restart.
    const existing = ledger.lookupOutcome(attempt);
    if (existing.status !== 'unknown') return existing;
    const binding = this.managedBindings.get(this.managedBindingKey(identity, attempt.sourceOperationId));
    if (attempt.bridgeInstanceId !== this.bridgeInstanceId || !binding
      || identity.targetContext !== canonicalManagedInvocation(binding)
      || canonicalManagedInvocation(binding) !== canonicalManagedInvocation(attempt.targetBinding)) throw new Error('Managed target binding mismatch.');
    // Session admission can await driver permission. Complete it before the
    // final target check, never after reserving an externally visible action.
    const computerSessionLabel = invocation.surface === 'computer' && invocation.operation !== 'authorize'
      && (binding.kind === 'cua-application' || binding.kind === 'cua-installed-application')
      ? (await this.ensureComputerSession(invocation.sessionId, {}, signal)).label : undefined;
    if (binding.kind === 'cua-installed-application') {
      try { await this.installedApps.revalidate(binding, signal); }
      catch { throw new Error('Installed application binding unavailable or changed; new approval required.'); }
    } else {
      const current = await this.resolveManagedTarget(invocation, signal);
      if (canonicalManagedInvocation(current) !== canonicalManagedInvocation(binding)) throw new Error('Managed target changed; new approval required.');
    }
    signal.throwIfAborted();
    const reservation = ledger.reserveDispatch(attempt);
    if (reservation.status === 'existing') return reservation.receipt;
    let execution: ManagedExecutionResult;
    try {
      execution = await this.executeManaged(invocation, binding, signal, computerSessionLabel);
    } catch (error) {
      if (error instanceof CuaKnownResultError
        || error instanceof CuaTransportError && error.dispatchState === 'not_sent') {
        const message = error instanceof Error ? error.message.slice(0, 1000) : 'Managed automation failed.';
        return ledger.completeDispatch(attempt, reservation.reservationId, { ok: false, error: message });
      }
      // A browser-sidecar failure, a possible-dispatch CUA failure, and any
      // untyped executor failure leave the reservation unresolved. The
      // reservation itself prevents a later lookup/fence/dispatch from replaying
      // a side effect whose result was lost.
      return ledger.lookupOutcome(attempt);
    }
    const response: HerdrManagedBridgeResponse = execution.kind === 'known-negative'
      ? { ok: false, error: execution.error.slice(0, 1000) }
      : { ok: true, result: execution.result ?? null };
    return ledger.completeDispatch(attempt, reservation.reservationId, response);
  }

  private handleBridgeSocket(socket: Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_BRIDGE_LINE) {
        socket.destroy();
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.handleBridgeLine(socket, line);
        newline = buffer.indexOf('\n');
      }
    });
  }

  private async handleBridgeLine(socket: Socket, line: string): Promise<void> {
    let request: BridgeRequest | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort();
    socket.once('close', abort);
    let managedResolve = false;
    try {
      request = JSON.parse(line) as BridgeRequest;
      if (typeof object(request).type === 'string' && String(object(request).type).startsWith('managed-')) {
        const { id, token, ...body } = object(request);
        if (token !== this.bridgeToken || !safeBridgeId(id)) throw new Error('Unauthorized automation bridge request.');
        const managed = herdrManagedBridgeRequestSchema.parse(body);
        managedResolve = managed.type === 'managed-resolve-target';
        if (id !== (managed.type === 'managed-resolve-target' ? managed.requestId : managed.attempt.requestId)) throw new Error('Managed request ID mismatch.');
        const result = await this.handleManaged(managed, controller.signal);
        socket.write(`${JSON.stringify({ id, ok: true, result })}\n`);
        return;
      }
      if (request.token !== this.bridgeToken || !safeBridgeId(request.id) || !safeBridgeId(request.sessionId)) {
        throw new Error('Unauthorized automation bridge request.');
      }
      let result: unknown;
      if (request.surface === 'browser') {
        if (request.operation === 'open') result = await this.openBrowser(request.sessionId, object(request.payload), controller.signal);
        else if (request.operation === 'close') result = await this.stopSession(request.sessionId);
        else if (request.operation === 'authorize') result = await this.authorizeBrowser(request.sessionId, object(request.payload), controller.signal);
        else result = await this.commandBrowser(
          request.sessionId,
          object(request.payload?.command) as BrowserCommand,
          controller.signal,
        );
      } else if (request.surface === 'computer' && request.operation === 'authorize') {
        result = await this.authorizeComputer(request.sessionId, {
          tool: request.tool,
          arguments: request.arguments,
          ...object(request.payload),
        }, controller.signal);
      } else if (request.surface === 'computer' && isCuaSafeTool(request.tool)) {
        result = await this.callComputer(request.sessionId, request.tool, object(request.arguments), controller.signal);
      } else {
        throw new Error('Unsupported automation bridge request.');
      }
      socket.write(`${JSON.stringify({ id: request.id, ok: true, result })}\n`);
    } catch (error) {
      socket.write(`${JSON.stringify({
        id: request && typeof request.id === 'string' ? request.id : 'invalid',
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 1_000) : 'Automation bridge request failed.',
        // Only a target resolution the App definitively refused carries a code;
        // every other failure stays an untyped answer the caller treats as
        // uncertain.
        ...(error instanceof ManagedTargetRejectedError && managedResolve ? { code: HERDR_MANAGED_TARGET_REJECTED } : {}),
      })}\n`);
    } finally {
      socket.off('close', abort);
    }
  }
}

export const automationService = new AutomationService();
