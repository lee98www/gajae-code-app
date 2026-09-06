import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';

import { GjcBunSdkAdapter } from '../../gjc-bun-sdk-adapter.js';
import { runManagedChild } from '../../gjc-herdr-managed-child.js';

// Only model transport is deterministic. The adapter, native manager, ask and
// permission controllers, event translation and private child protocol are real.
const model = { id: 'lifetime-model', provider: 'lifetime-provider' };
const authStorage: any = { exportSnapshot: () => ({ credentials: [] }), setRuntimeApiKey() {}, removeRuntimeApiKey() {} };
const registry: any = { authStorage, getAll: () => [model], getAvailable: () => [model] };
let creations = 0;
let flushEvents: (() => Promise<void>) | undefined;
class LifetimeAdapter extends GjcBunSdkAdapter {
  override initializeManagedGjcSession(...args: Parameters<GjcBunSdkAdapter['initializeManagedGjcSession']>) {
    assert.ok(args[3]?.flush, 'real private child supplies its durable ACK barrier');
    flushEvents = args[3].flush;
    return super.initializeManagedGjcSession(...args);
  }
}
await runManagedChild({ createAdapter: async () => new LifetimeAdapter(authStorage, registry, {
  settings: { cloneForCwd: async () => ({ override() {} }) } as any,
  generateSessionTitle: async () => 'Lifetime native title',
  createSessionFactory: (async (input: any) => {
    assert.equal(++creations, 1);
    const stats = { creations, pid: process.pid, providerSessionId: input.sessionManager.getSessionId(), prompts: [] as string[], answers: [] as string[], permissions: [] as string[], disposed: false };
    const save = () => writeFile(process.argv[2]!, JSON.stringify(stats), { mode: 0o600 });
    await save();
    let ui: any;
    let permission: any;
    let release: (() => void) | undefined;
    const listeners = new Set<(event: any) => void>();
    const emit = (event: any) => { for (const listener of listeners) listener(event); };
    const session: any = {
      model, thinkingLevel: 'high', isStreaming: false,
      setSdkPermissionMode() {}, setSdkPermissionProvider(value: any) { permission = value; },
      setModelTemporary: async () => {}, setConfiguredModelChain() {}, seedDefaultFallbackResolution() {},
      getContextUsage: () => ({ tokens: 15, contextWindow: 100, source: 'exact' }),
      subscribe(listener: (event: any) => void) { listeners.add(listener); return () => listeners.delete(listener); },
      async prompt(text: string) {
        assert.equal(this.isStreaming, false);
        this.isStreaming = true;
        stats.prompts.push(text);
        input.sessionManager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
        await save();
        if (text === 'history') {
          // Pace through the actual durable ACK barrier, not wall-clock sleeps.
          for (let index = 0; index < 5101; index++) {
            emit({ type: 'thinking_end', content: `history-${index}` });
            await flushEvents!();
          }
          // Cross the real chat projection's 256-record page boundary as well
          // as its event-tail boundary; repeated thinking updates alone coalesce.
          for (let index = 0; index < 130; index++) {
            const historyToolId = `history-tool-${index}`;
            emit({ type: 'tool_execution_start', toolCallId: historyToolId, toolName: 'read', args: { path: `history-${index}.txt` } });
            emit({ type: 'tool_execution_end', toolCallId: historyToolId, toolName: 'read', result: { content: [{ type: 'text', text: `history result ${index}` }], details: { lifetime: true } }, isError: false });
            await flushEvents!();
          }
        }
        const toolCallId = `tool-${stats.prompts.length}`;
        emit({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: { path: 'fixture.txt' } });
        emit({ type: 'tool_execution_update', toolCallId, partialResult: { content: [{ type: 'text', text: 'native-partial' }] } });
        if (text !== 'followup') {
          const aborted = new Promise<string>(resolve => { release = () => resolve('aborted'); });
          const answering = Promise.race([ui.select('Lifetime question', ['yes', 'no']), aborted]);
          const permitting = permission({ toolCallId: `permission-${stats.prompts.length}`, toolName: 'bash', title: 'fixture permission', rawInput: { command: 'pwd' } }, [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'deny', kind: 'reject_once', name: 'Reject' },
          ]);
          const answer = await answering;
          stats.answers.push(String(answer)); await save();
          const decision = await permitting;
          stats.permissions.push(decision.kind); await save();
        }
        emit({ type: 'tool_execution_end', toolCallId, toolName: 'read', result: { content: [{ type: 'text', text: 'native-result' }], details: { lifetime: true } }, isError: false });
        const message = { role: 'assistant', content: [{ type: 'text', text: `finished:${text}` }], stopReason: 'stop', timestamp: Date.now(), usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 } };
        input.sessionManager.appendMessage(message);
        await input.sessionManager.flush();
        emit({ type: 'message_end', message });
        this.isStreaming = false;
      },
      async abort() { release?.(); },
      async dispose() {
        const closed = await input.sessionManager.flushAndCloseStrict();
        assert.equal(closed.kind, 'closed', 'native persistent writer closed');
        stats.disposed = true; await save();
      },
    };
    return { session, setToolUIContext(value: any) { ui = value; } };
  }) as any,
}) });
