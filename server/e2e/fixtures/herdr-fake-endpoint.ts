import { lstat, chmod } from 'node:fs/promises';
import net from 'node:net';

/**
 * Test-owned Herdr API endpoint. It answers `session.snapshot` with exactly
 * one workspace/tab/pane so a detached host can prove its launch placement.
 * Every other method is reported unsupported, which is a real Herdr outcome
 * the host already tolerates. Nothing here is a Herdr, an SDK or an owner.
 */
export type FakeHerdrPlacement = { workspaceId: string; tabId: string; paneId: string; terminalId: string; label: string };
export type FakeHerdrEndpoint = {
  endpoint: { name: string; canonicalPath: string; dev: number; inode: number };
  readonly requests: string[];
  close(): Promise<void>;
};

export const FAKE_HERDR_PLACEMENT: FakeHerdrPlacement = { workspaceId: 'w1', tabId: 'w1:t1', paneId: 'w1:p1', terminalId: 'term-1', label: 'owned' };

export function fakeHerdrSnapshot(placement: FakeHerdrPlacement): Record<string, unknown> {
  return { type: 'session_snapshot', snapshot: {
    version: 'fixture-19', protocol: 19, layouts: [], agents: [],
    workspaces: [{ workspace_id: placement.workspaceId, number: 1, label: placement.label, focused: false, pane_count: 1, tab_count: 1, active_tab_id: placement.tabId, agent_status: 'idle' }],
    tabs: [{ workspace_id: placement.workspaceId, tab_id: placement.tabId, number: 1, label: placement.label, focused: false, pane_count: 1, agent_status: 'idle' }],
    panes: [{ workspace_id: placement.workspaceId, tab_id: placement.tabId, pane_id: placement.paneId, terminal_id: placement.terminalId, focused: false, agent: null, agent_status: 'idle', tokens: {} }],
  } };
}

/** `socketPath` must be short enough for a Unix socket and must not exist. */
export async function startFakeHerdrEndpoint(name: string, socketPath: string, placement: FakeHerdrPlacement = FAKE_HERDR_PLACEMENT): Promise<FakeHerdrEndpoint> {
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) return;
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        let request: { id?: unknown; method?: unknown };
        try { request = JSON.parse(line) as { id?: unknown; method?: unknown }; } catch { socket.destroy(); return; }
        if (typeof request.method === 'string') requests.push(request.method);
        const reply = request.method === 'session.snapshot'
          ? { id: request.id, result: fakeHerdrSnapshot(placement) }
          : { id: request.id, error: { code: 'unknown_method', message: 'Fixture endpoint supports session.snapshot only.' } };
        socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => resolve());
  });
  await chmod(socketPath, 0o600);
  const stat = await lstat(socketPath);
  if (!stat.isSocket()) throw new Error('Fake Herdr endpoint was not created as a socket; the path may be too long.');
  return {
    endpoint: { name, canonicalPath: socketPath, dev: stat.dev, inode: stat.ino },
    requests,
    close: () => new Promise<void>(resolve => {
      for (const socket of sockets) socket.destroy();
      server.close(() => resolve());
    }),
  };
}
