import { useCallback } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';

import type { HerdrManagedPublicSelection } from '../../../../shared/herdr-managed-provision-protocol';
import { authenticatedFetch } from '../../../utils/api';

const queryKey = ['herdr', 'managed', 'selection'] as const;
const selectionSchema = z.object({
  selectedSessionName: z.string().nullable(),
  instances: z.array(z.object({ name: z.string(), label: z.string(), status: z.enum(['available', 'unavailable', 'unknown']) })),
  status: z.enum(['selection_required', 'unavailable', 'provisioning', 'unknown', 'ready']),
});
async function readSelection(response: Response): Promise<HerdrManagedPublicSelection> {
  if (!response.ok) throw new Error(`Unable to load Herdr selection (${response.status})`);
  return selectionSchema.parse((await response.json()).data);
}

export function useManagedHerdrSelection() {
  const client = useQueryClient();
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }) => readSelection(await authenticatedFetch('/api/herdr/managed/selection', { signal })),
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async (selectedSessionName: string) => {
      await client.cancelQueries({ queryKey });
      return readSelection(await authenticatedFetch('/api/herdr/managed/selection', {
        method: 'PUT', body: JSON.stringify({ selectedSessionName }),
      }));
    },
    onSuccess: (selection) => client.setQueryData(queryKey, selection),
    retry: false,
  });
  const { reset, mutateAsync, isPending } = mutation;
  const { refetch } = query;
  const refresh = useCallback(async () => { reset(); await refetch(); }, [reset, refetch]);
  const select = useCallback(async (name: string) => {
    try { await mutateAsync(name); } catch { /* Error is rendered inline; retain the prior selection. */ }
  }, [mutateAsync]);
  const ensureReady = useCallback(async () => {
    if (isPending) return false;
    const result = await refetch();
    return !result.error && result.data?.status === 'ready' && Boolean(result.data.selectedSessionName);
  }, [isPending, refetch]);
  return { selection: query.data, busy: query.isFetching || mutation.isPending, error: mutation.error ?? query.error, refresh, select, ensureReady };
}
