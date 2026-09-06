import { useEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { ServerEvent } from '../../../contexts/WebSocketContext';
import { showCompletionTitleIndicator } from '../../../utils/pageTitleNotification';
import { playChatCompletionSound, playNotificationSound } from '../../../utils/notificationSound';
import type { MarkSessionIdle, MarkSessionProcessing } from '../../../hooks/useSessionProtection';
import type { PendingPermissionRequest } from '../types/types';
import type { ProjectSession, LLMProvider } from '../../../types/app';
import type { SessionStore, NormalizedMessage } from '../../../stores/useSessionStore';
import { assembleManagedTransfer, acceptManagedSequence, MANAGED_CHAT_MAX_FRAME_BYTES } from '../../../../shared/herdr-managed-chat';
import type { ManagedChatCursor, ManagedChatProjection, ManagedSnapshotFrame, ManagedUIStatus, ManagedLiveEvent } from '../../../../shared/herdr-managed-chat';

const requiresDecision = (request: { toolName?: unknown; status?: unknown } | null | undefined) => Boolean(request) && request?.status !== 'unknown' && request?.toolName !== 'ExitPlanMode' && request?.toolName !== 'exit_plan_mode';
const hasDecision = (requests: Array<{ toolName?: unknown; status?: unknown }> | null | undefined) => Array.isArray(requests) && requests.some(requiresDecision);

interface UseChatRealtimeHandlersArgs {
  subscribe: (listener: (event: ServerEvent) => void) => () => void;
  provider: LLMProvider;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  setTokenBudget: (budget: Record<string, unknown> | null) => void;
  setSessionState?: (update: (previous: Record<string, unknown> | null) => Record<string, unknown>) => void;
  pendingPermissionRequests: PendingPermissionRequest[];
  setPendingPermissionRequests: Dispatch<SetStateAction<PendingPermissionRequest[]>>;
  streamTimerRef: MutableRefObject<number | null>;
  accumulatedStreamRef: MutableRefObject<string>;
  lastSeqRef: MutableRefObject<Map<string, number>>;
  statusCheckSentAtRef: MutableRefObject<Map<string, number>>;
  onSessionProcessing?: MarkSessionProcessing;
  onSessionIdle?: MarkSessionIdle;
  onWebSocketReconnect?: () => void;
  onSteerResult?: (content: string, steered: boolean) => void;
  onManagedActionResult?: (actionId: string, accepted: boolean) => void;
  sessionStore: SessionStore;
}

const skipsStore = new Set(['complete', 'status', 'permission_request', 'permission_cancelled']);

export function useChatRealtimeHandlers({
  subscribe, provider, selectedSession, currentSessionId, setTokenBudget, setSessionState,
  pendingPermissionRequests, setPendingPermissionRequests, streamTimerRef, accumulatedStreamRef,
  lastSeqRef, statusCheckSentAtRef, onSessionProcessing, onSessionIdle, onWebSocketReconnect,
  onSteerResult, onManagedActionResult, sessionStore,
}: UseChatRealtimeHandlersArgs) {
  const displayedSession = useRef<string | null>(selectedSession?.id || currentSessionId || null);
  displayedSession.current = selectedSession?.id || currentSessionId || null;
  const pendingRequests = useRef(pendingPermissionRequests);
  const managedCursors = useRef(new Map<string, ManagedChatCursor>());
  const transfers = useRef(new Map<string, { frames: ManagedSnapshotFrame[]; bytes: number }>());
  const resubscribing = useRef(new Set<string>());

  useEffect(() => { pendingRequests.current = pendingPermissionRequests; }, [pendingPermissionRequests]);

  useEffect(() => {
    const stopStreamTimer = () => {
      if (streamTimerRef.current) {
        cancelAnimationFrame(streamTimerRef.current);
        streamTimerRef.current = null;
      }
    };
    const resolveSession = (event: ServerEvent) => {
      const visible = displayedSession.current;
      const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : visible;
      if (sessionId && typeof event.seq === 'number') {
        const seen = lastSeqRef.current.get(sessionId) ?? 0;
        if (event.seq > seen) lastSeqRef.current.set(sessionId, event.seq);
      }
      return { sessionId, visible };
    };
    const commitPermissions = (next: PendingPermissionRequest[]) => {
      pendingRequests.current = next;
      setPendingPermissionRequests(next);
    };
    const flushStreaming = (sessionId: string | null | undefined, finalizeEmpty: boolean) => {
      stopStreamTimer();
      if (sessionId && (accumulatedStreamRef.current || finalizeEmpty)) {
        if (accumulatedStreamRef.current) {
          sessionStore.updateStreaming(sessionId, accumulatedStreamRef.current, provider);
        }
        sessionStore.finalizeStreaming(sessionId);
      }
      accumulatedStreamRef.current = '';
    };
    const resubscribe = (id: string) => {
      transfers.current.delete(id);
      if (resubscribing.current.has(id)) return;
      resubscribing.current.add(id);
      onWebSocketReconnect?.();
    };
    const applyStatus = (status: ManagedUIStatus) => {
      const id = status.sessionId;
      if (status.terminal) onSessionIdle?.(id);
      else onSessionProcessing?.(id, { statusText: typeof status.status === 'object' && status.status !== null
        && typeof (status.status as { text?: unknown }).text === 'string'
        ? (status.status as { text: string }).text : status.lifecycle, canInterrupt: Boolean(status.activeTurnId) && status.lifecycle !== 'unknown' });
      if (id !== displayedSession.current) return;
      setTokenBudget(status.usage as Record<string, unknown> | null);
      setSessionState?.(() => ({ ...((status.configuration ?? {}) as Record<string, unknown>), sessionId: status.sessionId, managed: true, managedLifecycle: status.lifecycle, managedQueue: status.queue }));
    };
    const applyProjection = (projection: ManagedChatProjection) => {
      const m = projection.metadata;
      sessionStore.replaceManagedProjection(m.sessionId, projection.records, m);
      managedCursors.current.set(m.sessionId, { sessionId: m.sessionId, ownerGeneration: m.ownerGeneration, watermark: m.watermark });
      resubscribing.current.delete(m.sessionId);
      applyStatus(m);
      if (m.sessionId === displayedSession.current) {
        const next = projection.pendingPermissions.map((request) => ({ ...request, receivedAt: new Date(request.createdAt || Date.now()) }));
        const notify = next.some((request) => requiresDecision(request) && !pendingRequests.current.some((prior) =>
          prior.requestId === request.requestId && (prior as unknown as { generation?: string }).generation === request.generation));
        commitPermissions(next);
        if (notify) void playNotificationSound();
      }
    };
    const receiveManaged = (event: ServerEvent) => {
      const frame = event as unknown as ManagedSnapshotFrame;
      const id = frame.sessionId;
      if (!id) return;
      if (event.kind === 'managed_command_result') {
        const result = event.result as { receipt?: { state?: string }; error?: string; ok?: boolean } | undefined;
        if (typeof event.actionId === 'string' && result?.receipt && ['admitted', 'executing', 'settled', 'rejected'].includes(result.receipt.state ?? '')) {
          onManagedActionResult?.(event.actionId, result.receipt.state !== 'rejected');
        }
        if (result?.ok === false && typeof result.error === 'string') {
          onSessionProcessing?.(id, { statusText: result.error, canInterrupt: false });
        }
        return;
      }
      if (event.kind === 'managed_ui_status') {
        const status = event as unknown as ManagedUIStatus;
        if (typeof status.ownerGeneration !== 'string') {
          onSessionProcessing?.(id, { statusText: typeof event.context === 'string' ? event.context : String(event.status ?? 'Managed host unavailable'), canInterrupt: false });
          if (id === displayedSession.current) setSessionState?.(previous => ({ ...previous, sessionId: id, managed: true }));
          return;
        }
        const cursor = managedCursors.current.get(id);
        if (cursor?.ownerGeneration === status.ownerGeneration && cursor.watermark === status.watermark) applyStatus(status);
        return;
      }
      if (event.kind === 'managed_live_event') {
        const live = event as unknown as ManagedLiveEvent;
        const cursor = managedCursors.current.get(id);
        if (!cursor) { resubscribe(id); return; }
        const decision = acceptManagedSequence(cursor, { appSessionId: id, ownerGeneration: live.ownerGeneration }, live.seq);
        if (decision === 'gap') { resubscribe(id); return; }
        if (decision !== 'apply' || resubscribing.current.has(id)) return;
        if (live.projection?.metadata.sessionId !== id || live.projection.metadata.ownerGeneration !== live.ownerGeneration
          || live.projection.metadata.watermark !== live.seq) { resubscribe(id); return; }
        applyProjection(live.projection);
        return;
      }
      const cursor = managedCursors.current.get(id);
      if (frame.kind === 'managed_snapshot_begin') {
        if (cursor?.ownerGeneration === frame.ownerGeneration && frame.watermark <= cursor.watermark) return;
        if (!Number.isSafeInteger(frame.pageCount) || frame.pageCount < 1 || frame.pageCount > 4096
          || !Number.isSafeInteger(frame.byteLength) || frame.byteLength < 0 || frame.byteLength > 64 * 1024 * 1024
          || transfers.current.size >= 50 && !transfers.current.has(id)) { resubscribe(id); return; }
        transfers.current.set(id, { frames: [frame], bytes: 0 });
        return;
      }
      const transfer = transfers.current.get(id);
      if (!transfer) return;
      const begin = transfer.frames[0];
      if (frame.transferId !== begin.transferId || frame.ownerGeneration !== begin.ownerGeneration || frame.watermark !== begin.watermark) return;
      if (frame.kind === 'managed_snapshot_page') {
        if (frame.page < transfer.frames.length - 1) return;
        if (frame.page !== transfer.frames.length - 1 || typeof frame.chunk !== 'string') { resubscribe(id); return; }
        const bytes = new TextEncoder().encode(frame.chunk).byteLength;
        transfer.bytes += bytes;
        if (bytes > MANAGED_CHAT_MAX_FRAME_BYTES || transfer.bytes > 64 * 1024 * 1024) { resubscribe(id); return; }
        transfer.frames.push(frame);
        return;
      }
      if (frame.kind === 'managed_snapshot_end') {
        try { applyProjection(assembleManagedTransfer([...transfer.frames, frame])); }
        catch { resubscribe(id); }
        transfers.current.delete(id);
      }
    };

    const receive = (event: ServerEvent) => {
      if (!event.kind) return;
      if (event.kind.startsWith('managed_')) { receiveManaged(event); return; }
      const { sessionId, visible } = resolveSession(event);

      if (event.kind === 'websocket_reconnected') {
        onWebSocketReconnect?.();
        return;
      }
      if (event.kind === 'chat_subscribed') {
        if (!sessionId) return;
        if (sessionId === visible) setSessionState?.(previous => ({ ...previous, sessionId, managed: false }));
        if (event.isProcessing) {
          onSessionProcessing?.(sessionId);
        } else {
          onSessionIdle?.(sessionId, { ifStartedBefore: statusCheckSentAtRef.current.get(sessionId) });
        }
        if (sessionId === visible && Array.isArray(event.pendingPermissions)) {
          const next = event.pendingPermissions as PendingPermissionRequest[];
          const notify = hasDecision(next) && !hasDecision(pendingRequests.current);
          commitPermissions(next);
          if (notify) void playNotificationSound();
        }
        return;
      }
      if (event.kind === 'chat_steered') {
        const content = typeof event.content === 'string' ? event.content : '';
        if (content) onSteerResult?.(content, event.steered === true);
        return;
      }
      if (event.kind === 'protocol_error') {
        console.error('[Chat] Protocol error:', event.code, event.error);
        if (sessionId) {
          onSessionIdle?.(sessionId);
          sessionStore.appendRealtime(sessionId, {
            id: `protocol_error_${Date.now()}`, sessionId, timestamp: new Date().toISOString(), provider,
            kind: 'error', content: String(event.error || 'Request failed'),
          } as NormalizedMessage);
        }
        return;
      }
      if (event.kind === 'session_upserted' || event.kind === 'loading_progress') return;

      if (event.kind === 'stream_delta') {
        if (sessionId && sessionId !== visible) {
          sessionStore.appendRealtime(sessionId, event as unknown as NormalizedMessage);
          return;
        }
        const content = (event.content as string) || '';
        if (!content) return;
        accumulatedStreamRef.current += content;
        // Deltas land many times a frame; one paint per frame carries them
        // all. A fixed 100 ms timer painted the answer in ten steps a second,
        // which read as stutter, and a hidden tab paints nothing until it
        // is looked at again (`stream_end` flushes regardless).
        if (!streamTimerRef.current) {
          streamTimerRef.current = requestAnimationFrame(() => {
            streamTimerRef.current = null;
            if (sessionId) sessionStore.updateStreaming(sessionId, accumulatedStreamRef.current, provider);
          });
        }
        if (sessionId && sessionId !== visible) sessionStore.appendRealtime(sessionId, event as unknown as NormalizedMessage);
        return;
      }
      if (event.kind === 'stream_end') {
        if (sessionId && sessionId !== visible) {
          sessionStore.appendRealtime(sessionId, { ...event, kind: 'text', role: 'assistant' } as unknown as NormalizedMessage);
          return;
        }
        // The frame carries the whole answer. It outranks the deltas: a viewer
        // that joined mid-turn holds only the tail of them, and a turn the SDK
        // did not stream has none at all - without this the answer stayed on
        // disk until the next full reload.
        const content = typeof event.content === 'string' ? event.content : '';
        if (content) accumulatedStreamRef.current = content;
        flushStreaming(sessionId, true);
        return;
      }

      if (sessionId && !skipsStore.has(event.kind)) sessionStore.appendRealtime(sessionId, event as unknown as NormalizedMessage);

      if (event.kind === 'complete') {
        if (sessionId === visible) flushStreaming(sessionId, false);
        onSessionIdle?.(sessionId);
        if (sessionId === visible) commitPermissions([]);
        if (event.aborted) return;
        if (event.success !== false) {
          showCompletionTitleIndicator();
          void playChatCompletionSound();
        }
        if (sessionId && sessionId === visible) void sessionStore.refreshFromServer(sessionId);
        return;
      }
      if (event.kind === 'permission_request') {
        if (!event.requestId) return;
        if (requiresDecision({ toolName: event.toolName })) void playNotificationSound();
        if (sessionId === visible) {
          const previous = pendingRequests.current;
          if (!previous.some((request) => request.requestId === event.requestId)) {
            commitPermissions([...previous, {
              requestId: event.requestId as string,
              toolName: (event.toolName as string) || 'UnknownTool',
              input: event.input,
              context: event.context,
              sessionId: sessionId || null,
              receivedAt: new Date(),
            }]);
          }
        }
        if (sessionId) onSessionProcessing?.(sessionId);
        return;
      }
      if (event.kind === 'permission_cancelled') {
        if (event.requestId && sessionId === visible) {
          commitPermissions(pendingRequests.current.filter((request) => request.requestId !== event.requestId));
        }
        return;
      }
      if (event.kind === 'status') {
        if (event.text === 'token_budget' && event.tokenBudget && sessionId === visible) {
          setTokenBudget(event.tokenBudget as Record<string, unknown>);
        } else if (event.text === 'session_state' && event.sessionState && sessionId === visible) {
          setSessionState?.((previous) => ({ ...(previous ?? {}), ...(event.sessionState as Record<string, unknown>), sessionId }));
        } else if (typeof event.text === 'string' && sessionId) {
          onSessionProcessing?.(sessionId, { statusText: event.text || null, canInterrupt: event.canInterrupt !== false });
        }
      }
    };

    return subscribe(receive);
  }, [
    subscribe, provider, selectedSession, currentSessionId, setTokenBudget, setSessionState,
    pendingPermissionRequests, setPendingPermissionRequests, streamTimerRef, accumulatedStreamRef,
    lastSeqRef, statusCheckSentAtRef, onSessionProcessing, onSessionIdle, onWebSocketReconnect,
    onSteerResult, onManagedActionResult, sessionStore,
  ]);
}
