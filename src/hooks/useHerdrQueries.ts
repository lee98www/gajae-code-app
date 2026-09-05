import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { z } from 'zod';

import {
  HERDR_OUTPUT_REFETCH_MS,
  HERDR_SNAPSHOT_REFETCH_MS,
  type HerdrInputAction,
  herdrInputResponseSchema,
  herdrOutputResponseSchema,
  herdrSessionsResponseSchema,
  herdrSnapshotResponseSchema,
} from '../../shared/herdr-protocol';
import { api } from '../utils/api';

export const HERDR_QUERY_KEY = ['herdr'] as const;

const readJson = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`herdr_http_${response.status}`);
  const envelope = z.object({ success: z.literal(true), data: z.unknown() }).strict().parse(payload);
  return schema.parse(envelope.data);
};

export function useHerdrSessions() {
  return useQuery({
    queryKey: [...HERDR_QUERY_KEY, 'sessions'],
    queryFn: async ({ signal }) => {
      const data = await readJson(await api.herdr.sessions({ signal }), herdrSessionsResponseSchema);
      return data.sessions;
    },
    refetchInterval: HERDR_SNAPSHOT_REFETCH_MS,
  });
}

export function useHerdrSnapshot(sessionName: string | null) {
  return useQuery({
    queryKey: [...HERDR_QUERY_KEY, 'snapshot', sessionName],
    enabled: Boolean(sessionName),
    queryFn: async ({ signal }) => readJson(
      await api.herdr.snapshot(sessionName!, { signal }),
      herdrSnapshotResponseSchema,
    ),
    refetchInterval: HERDR_SNAPSHOT_REFETCH_MS,
  });
}

export function useHerdrOutput(sessionName: string | null, paneId: string | null) {
  return useQuery({
    queryKey: [...HERDR_QUERY_KEY, 'output', sessionName, paneId],
    enabled: Boolean(sessionName && paneId),
    queryFn: async ({ signal }) => readJson(
      await api.herdr.output(sessionName!, paneId!, { signal }),
      herdrOutputResponseSchema,
    ),
    refetchInterval: HERDR_OUTPUT_REFETCH_MS,
    placeholderData: (previous, previousQuery) => {
      const previousKey = previousQuery?.queryKey ?? [];
      return previousKey[2] === sessionName && previousKey[3] === paneId ? previous : undefined;
    },
  });
}

export function useHerdrInput(sessionName: string | null, paneId: string | null) {
  const client = useQueryClient();
  const controller = useRef<AbortController | null>(null);
  const target = useMemo(() => ({ sessionName, paneId }), [sessionName, paneId]);
  const activeTarget = useRef<typeof target | null>(target);
  const cancel = useCallback(() => {
    activeTarget.current = null;
    controller.current?.abort();
  }, []);
  useEffect(() => {
    activeTarget.current = target;
    return cancel;
  }, [target, cancel]);
  const mutation = useMutation({
    retry: false,
    networkMode: 'always',
    mutationFn: async (input: {
      action: HerdrInputAction;
      text: string;
      terminalId: string;
      observationToken: string;
    }) => {
      if (activeTarget.current !== target) throw new Error('herdr_cancelled');
      if (!sessionName || !paneId) throw new Error('herdr_no_target');
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        throw new Error('herdr_offline');
      }
      controller.current?.abort();
      const active = new AbortController();
      controller.current = active;
      try {
        const result = await readJson(
          await api.herdr.input(sessionName, paneId, input, { signal: active.signal }),
          herdrInputResponseSchema,
        );
        if (active.signal.aborted) throw new Error('herdr_cancelled');
        if (result.sessionName !== sessionName || result.paneId !== paneId) throw new Error('herdr_target_mismatch');
        return result;
      } finally {
        if (controller.current === active) controller.current = null;
      }
    },
    onSuccess: (result) => {
      void client.invalidateQueries({ queryKey: [...HERDR_QUERY_KEY, 'output', result.sessionName, result.paneId] });
      void client.invalidateQueries({ queryKey: [...HERDR_QUERY_KEY, 'snapshot', result.sessionName] });
    },
  });
  return { ...mutation, cancel };
}
