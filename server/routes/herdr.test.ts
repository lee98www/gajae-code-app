import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';

import { HerdrError, HerdrRpcError } from '../services/herdr-client.js';
import { HerdrSessionsService } from '../services/herdr-sessions.js';

import { createHerdrRouter } from './herdr.js';

const serve = async (service: any, beforeRoute?: express.RequestHandler) => {
  const app = express();
  app.use(express.json());
  if (beforeRoute) app.use(beforeRoute);
  app.use('/api/herdr', createHerdrRouter(service));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as { port: number };
  return {
    request: (pathname: string, options?: RequestInit) => fetch(`http://127.0.0.1:${port}${pathname}`, options),
    close: async () => {
      server.close();
      await once(server, 'close');
    },
  };
};

test('Herdr route lists sessions and emits no-store protected payloads', async () => {
  const service = { listSessions: async () => [{ name: 'default', label: 'Default', status: 'unknown', generation: 1 }] };
  const server = await serve(service);
  try {
    const response = await server.request('/api/herdr/sessions');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as any;
    assert.equal(body.data.sessions[0].name, 'default');
  } finally {
    await server.close();
  }
});

test('Herdr route forwards only narrow input bodies to the service', async () => {
  const calls: any[] = [];
  const service = {
    input: async (...args: any[]) => {
      calls.push(args);
      return { ok: true, sessionName: 'default', paneId: 'p1', outcome: 'accepted_not_delivered', message: 'Accepted by Herdr; delivery is not confirmed.', observedAt: new Date(0).toISOString() };
    },
  };
  const server = await serve(service);
  try {
    const response = await server.request('/api/herdr/sessions/default/panes/p1/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'text-enter', text: 'hi', terminalId: 'term1', observationToken: 'token1' }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(calls[0].slice(0, 3), ['default', 'p1', { action: 'text-enter', text: 'hi', terminalId: 'term1', observationToken: 'token1' }]);
    assert.ok(calls[0][3] instanceof AbortSignal);
  } finally {
    await server.close();
  }
});

test('Herdr route rejects extra input fields before service dispatch', async () => {
  let calls = 0;
  const service = { input: async () => { calls++; return {}; } };
  const server = await serve(service);
  try {
    const response = await server.request('/api/herdr/sessions/default/panes/p1/input', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'text-enter', text: 'hi', terminalId: 'term1', observationToken: 'token1', ignored: '/tmp/socket' }),
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('Herdr HTTP input rejects controls, empty text actions and multibyte overflow before service dispatch', async () => {
  let calls = 0;
  const server = await serve({ input: async () => { calls++; return {}; } });
  try {
    for (const text of ['', '\t', '\u0085', '\u2028', '\u2029', '한'.repeat(5462)]) {
      const response = await server.request('/api/herdr/sessions/default/panes/p1/input', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'text-enter', text, terminalId: 'term1', observationToken: 'token1' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json() as any).error.code, 'HERDR_INVALID_REQUEST');
    }
    assert.equal(calls, 0);
  } finally { await server.close(); }
});

test('Herdr routes do not call service after upstream auth rejects', async () => {
  let calls = 0;
  const service = { listSessions: async () => { calls++; return []; } };
  const server = await serve(service, (_req, res) => { res.status(403).json({ error: 'Forbidden origin' }); });
  try {
    const response = await server.request('/api/herdr/sessions');
    assert.equal(response.status, 403);
    assert.equal(calls, 0);
  } finally {
    await server.close();
  }
});

test('Herdr route maps stale pane observations to conflict', async () => {
  const service = { output: async () => { throw new HerdrError('HERDR_STALE_OBSERVATION', 409, 'Herdr pane changed; reselect the target.'); } };
  const server = await serve(service);
  try {
    const response = await server.request('/api/herdr/sessions/default/panes/p1/output');
    assert.equal(response.status, 409);
  } finally {
    await server.close();
  }
});

test('Herdr route uses typed safe errors, never upstream message substrings', async () => {
  for (const [error, status, code] of [
    [new Error('Unknown Herdr required changed stale private/path'), 502, 'HERDR_UNAVAILABLE'],
    [new HerdrRpcError('pane_not_found', 'private/path changed'), 404, 'HERDR_NOT_FOUND'],
    [new HerdrRpcError('unknown_method', 'private/path'), 501, 'HERDR_UNSUPPORTED'],
    [new HerdrError('HERDR_TIMEOUT', 504, 'Herdr request timed out; delivery is unknown.'), 504, 'HERDR_TIMEOUT'],
  ] as const) {
    const server = await serve({ output: async () => { throw error; } });
    try {
      const response = await server.request('/api/herdr/sessions/default/panes/p1/output');
      assert.equal(response.status, status);
      const body = await response.json() as any;
      assert.equal(body.error.code, code);
      assert.ok(!body.error.message.includes('private/path'));
    } finally { await server.close(); }
  }
});

test('Herdr route propagates a disconnected HTTP request to the service', async () => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let aborted!: () => void;
  const cancelled = new Promise<void>((resolve) => { aborted = resolve; });
  const server = await serve({ input: async (_name: string, _pane: string, _body: unknown, signal: AbortSignal) => {
    started();
    await new Promise<void>((resolve) => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    throw new HerdrError('HERDR_CANCELLED', 499, 'Cancelled.');
  } });
  try {
    const controller = new AbortController();
    const request = server.request('/api/herdr/sessions/default/panes/p1/input', {
      method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'text', text: 'hello', terminalId: 'term1', observationToken: 'token1' }),
    });
    const rejected = assert.rejects(request);
    await ready;
    controller.abort();
    await rejected;
    await cancelled;
  } finally { await server.close(); }
});

test('real app factory rejects hostile origin, API key and desktop auth before any Herdr connector call', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'herdr-factory-'));
  const names = ['DATABASE_PATH', 'API_KEY', 'GJC_DESKTOP', 'GJC_DESKTOP_API_KEY', 'GJC_DESKTOP_BOOTSTRAP_NONCE', 'ALLOWED_HOSTS'] as const;
  const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.DATABASE_PATH = path.join(tmp, 'auth.db');
  process.env.API_KEY = 'fixture-api-key';
  delete process.env.GJC_DESKTOP;
  delete process.env.ALLOWED_HOSTS;
  let cleanupRuntime: (() => void) | undefined;
  try {
    const { createGjcAppFactory } = await import('../app-factory.js');
    const { validateApiKey, authenticateToken, authenticateWebSocket } = await import('../middleware/auth.js');
    const { getProductionJobOrchestrator } = await import('../services/gjc-job-orchestrator.js');
    const { closeConnection } = await import('../modules/database/index.js');
    cleanupRuntime = () => { getProductionJobOrchestrator().close(); closeConnection(); };
    await fs.mkdir(path.join(tmp, 'herdr'));
    await fs.writeFile(path.join(tmp, 'herdr', 'herdr.sock'), '');
    let connects = 0;
    const herdr = new HerdrSessionsService({ configHome: tmp, envSocketPath: '', allowNonSocketForTests: true, connector: () => { connects++; throw new Error('auth must short circuit'); } });
    for (const desktop of [false, true]) {
      if (desktop) {
        process.env.GJC_DESKTOP = '1';
        process.env.GJC_DESKTOP_API_KEY = 'fixture-desktop-key';
        process.env.GJC_DESKTOP_BOOTSTRAP_NONCE = 'fixture-bootstrap-nonce';
      }
      const factory = createGjcAppFactory({
        authority: {}, orchestrator: { deps: {} }, gitService: {}, projection: { publish() {} },
        authenticateWebSocket, authenticateGjcRoute: authenticateToken, validateApiKey,
        chat: {}, shell: {}, herdr,
      } as any);
      factory.server.listen(0, '127.0.0.1');
      await once(factory.server, 'listening');
      const { port } = factory.server.address() as { port: number };
      try {
        for (const [method, suffix] of [['GET', 'snapshot'], ['GET', 'panes/p1/output'], ['POST', 'panes/p1/input']] as const) {
          const url = `http://127.0.0.1:${port}/api/herdr/sessions/default/${suffix}`;
          const options = { method, ...(method === 'POST' ? { body: JSON.stringify({ action: 'text', text: 'hello', terminalId: 'term1', observationToken: 'token1' }) } : {}) };
          const hostile = await fetch(url, { ...options, headers: { origin: 'https://hostile.invalid', 'x-api-key': 'fixture-api-key', cookie: 'gajae_desktop_api_key=fixture-desktop-key', 'content-type': 'application/json' } });
          assert.equal(hostile.status, 403);
          await hostile.arrayBuffer();
          const unauthenticated = await fetch(url, { ...options, headers: { 'content-type': 'application/json' } });
          assert.equal(unauthenticated.status, 401);
          await unauthenticated.arrayBuffer();
          const wrongCredentials = await fetch(url, { ...options, headers: { 'content-type': 'application/json', 'x-api-key': 'wrong-key', cookie: 'gajae_desktop_api_key=wrong-key' } });
          assert.equal(wrongCredentials.status, 401);
          await wrongCredentials.arrayBuffer();
          const nullOrigin = await fetch(url, { ...options, headers: { origin: 'null', 'x-api-key': 'fixture-api-key', cookie: 'gajae_desktop_api_key=fixture-desktop-key', 'content-type': 'application/json' } });
          assert.equal(nullOrigin.status, 403);
          await nullOrigin.arrayBuffer();
          assert.equal(connects, 0);
        }
      } finally {
        await new Promise<void>((resolve) => factory.wss.close(() => resolve()));
        await new Promise<void>((resolve, reject) => factory.server.close((error?: Error) => error ? reject(error) : resolve()));
      }
    }
  } finally {
    cleanupRuntime?.();
    for (const name of names) {
      if (original[name] === undefined) delete process.env[name];
      else process.env[name] = original[name];
    }
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
