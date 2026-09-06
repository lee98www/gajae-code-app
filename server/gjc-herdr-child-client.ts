import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { HERDR_MANAGED_CHILD_LIMITS as limits, parseManagedChildOutput, parseManagedChildRequest, type ManagedChildEvent, type ManagedChildRequest, type ManagedChildResponse } from '../shared/herdr-managed-child-protocol.js';

const titleScopeKey = (requestId: string, runId: string): string => `${requestId}\u0000${runId}`;

/** Private transport: event persistence completes before the cumulative acknowledgement is written. */
export class ManagedChildTransport {
  #buffer: Buffer = Buffer.alloc(0);
  #pending = new Map<string, { request: ManagedChildRequest; resolve: (v: ManagedChildResponse) => void; reject: (e: Error) => void }>();
  #eventIdentity: { requestId: string; runId: string } | null = null;
  #eventSeq = 0;
  #events = Promise.resolve();
  #eventCount = 0;
  #eventBytes = 0;
  #failure: Error | null = null;
  #exit: Promise<void>;
  #closing = false;
  #responses = new Set<string>();
  #promptScopes = new Map<string, { requestId: string; runId: string }>();
  /** The first title-eligible prompt may publish once after its response settles. */
  #titleScope: { requestId: string; runId: string; published: boolean } | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams, private readonly generation: string, private readonly onEvent: (event: ManagedChildEvent) => void | Promise<void>) {
    this.#exit = new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => {
        if (this.#closing && code === 0 && !signal) resolve();
        else reject(new Error('Managed child exited unexpectedly.'));
        this.#fail(new Error('Managed child exited.'));
      });
      child.once('error', () => { const error = new Error('Managed child process failed.'); this.#fail(error); reject(error); });
    });
    void this.#exit.catch(() => {});
    child.stdout.on('data', (chunk: Buffer) => this.#receive(chunk));
    child.stdout.on('end', () => { if (!this.#closing || this.#pending.size) this.#fail(new Error('Managed child stream ended.')); });
    child.stdout.on('error', () => this.#fail(new Error('Managed child stream failed.')));
    child.stdin.on('error', () => this.#fail(new Error('Managed child input failed.')));
    child.stderr.resume(); // Never forward private diagnostics to the terminal.
  }

  request(request: ManagedChildRequest): Promise<ManagedChildResponse> {
    if (this.#failure) return Promise.reject(this.#failure);
    try {
      parseManagedChildRequest(JSON.stringify(request));
      if (request.generation !== this.generation || request.type === 'ack' || this.#pending.has(request.requestId) || this.#pending.size >= limits.pendingEvents) throw new Error('Managed child request rejected.');
      if (request.type === 'init' || request.type === 'prompt') {
        if ([...this.#pending.values()].some(p => p.request.type === 'init' || p.request.type === 'prompt')) throw new Error('Managed child already has an active event stream.');
        this.#eventIdentity = request;
        if (request.type === 'prompt') this.#promptScopes.set(titleScopeKey(request.requestId, request.runId), { requestId: request.requestId, runId: request.runId });
      }
      return new Promise((resolve, reject) => {
        this.#pending.set(request.requestId, { request, resolve, reject });
        this.#write(request);
      });
    } catch (error) { return Promise.reject(error); }
  }

  async close(request: ManagedChildRequest): Promise<void> {
    if (request.type !== 'close') throw new Error('Invalid close request.');
    this.#closing = true;
    const response = await this.request(request);
    if (!response.ok) throw new Error('Managed child refused close.');
    this.child.stdin.end();
    await this.#exit;
  }

  #write(request: ManagedChildRequest): void {
    const line = `${JSON.stringify(request)}\n`;
    if (Buffer.byteLength(line) > limits.frameBytes || this.child.stdin.writableLength + Buffer.byteLength(line) > limits.pendingBytes) {
      this.#fail(new Error('Managed child write limit exceeded.'));
      return;
    }
    try { this.child.stdin.write(line, (error) => { if (error) this.#fail(new Error('Managed child write failed.')); }); }
    catch { this.#fail(new Error('Managed child write failed.')); }
  }

  #receive(chunk: Buffer): void {
    if (this.#failure) return;
    try {
      let offset = 0;
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset);
        const end = newline < 0 ? chunk.length : newline + 1;
        const segment = chunk.subarray(offset, end);
        if (this.#buffer.length + segment.length > limits.frameBytes) throw new Error('Managed child frame limit exceeded.');
        this.#buffer = Buffer.concat([this.#buffer, segment]);
        offset = end;
        if (newline < 0) break;
        const line = new TextDecoder('utf-8', { fatal: true }).decode(this.#buffer);
        this.#buffer = Buffer.alloc(0);
        const frame = parseManagedChildOutput(line);
        if (frame.generation !== this.generation) throw new Error('Managed child generation mismatch.');
        if (frame.type === 'event') {
          const currentIdentity = frame.requestId === this.#eventIdentity?.requestId && frame.runId === this.#eventIdentity.runId;
          const isTitle = frame.event.kind === 'session_title';
          const promptScope = isTitle ? this.#promptScopes.get(titleScopeKey(frame.requestId, frame.runId)) : undefined;
          const titleIdentity = Boolean(promptScope)
            && (!this.#titleScope
              || (frame.requestId === this.#titleScope.requestId && frame.runId === this.#titleScope.runId));
          if (isTitle && titleIdentity && !this.#titleScope) {
            this.#titleScope = { ...promptScope!, published: false };
          }
          if (this.#responses.has(frame.requestId) && !(isTitle && titleIdentity && !this.#titleScope?.published)) {
            throw new Error('Managed child event followed terminal response.');
          }
          if (frame.eventSeq !== this.#eventSeq + 1
            || (!currentIdentity && !(isTitle && titleIdentity))
            || (isTitle && (!titleIdentity || this.#titleScope?.published))) {
            throw new Error('Managed child event identity mismatch.');
          }
          const lateTitle = isTitle && Boolean(titleIdentity);
          if (!this.#pending.has(frame.requestId) && !lateTitle && !['managed.automation', 'managed.automation-record-chunk'].includes(String(frame.event.kind))) throw new Error('Managed child idle event rejected.');
          if (lateTitle && this.#titleScope) this.#titleScope.published = true;
          this.#eventSeq = frame.eventSeq;
          const bytes = Buffer.byteLength(line);
          if (++this.#eventCount > limits.pendingEvents || (this.#eventBytes += bytes) > limits.pendingBytes) throw new Error('Managed child event limit exceeded.');
          this.#events = this.#events.then(async () => {
            if (this.#failure) return;
            await this.onEvent(frame);
            this.#write({ version: 1, generation: this.generation, requestId: `ack:${frame.eventSeq}`, runId: frame.runId, type: 'ack', eventSeq: frame.eventSeq });
            this.#eventCount--; this.#eventBytes -= bytes;
          }).catch(() => this.#fail(new Error('Managed child event persistence failed.')));
        } else {
          const pending = this.#pending.get(frame.requestId);
          if (!pending || this.#responses.has(frame.requestId) || pending.request.runId !== frame.runId) throw new Error('Managed child response identity mismatch.');
          this.#responses.add(frame.requestId);
          const settle = () => {
            if (this.#failure) return;
            this.#pending.delete(frame.requestId);
            this.#responses.delete(frame.requestId);
            pending.resolve(frame);
          };
          // Controls remain independently correlated; stream completion cannot
          // overtake persistence even if a broken child sends its response early.
          if (pending.request.type === 'init' || pending.request.type === 'prompt' || pending.request.type === 'close') {
            this.#events = this.#events.then(settle);
          } else settle();
        }
      }
    } catch { this.#fail(new Error('Managed child protocol failed.')); }
  }

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    this.#responses.clear();
    this.#eventIdentity = null;
    this.#promptScopes.clear();
    this.#titleScope = null;
    this.#buffer = Buffer.alloc(0);
    if (!this.#closing || this.child.exitCode === null) this.child.kill();
  }
}
