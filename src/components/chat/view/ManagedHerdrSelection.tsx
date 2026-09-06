import { useId } from 'react';

import { Button } from '../../../shared/view/ui/Button';
import type { useManagedHerdrSelection } from '../hooks/useManagedHerdrSelection';

export default function ManagedHerdrSelection({ state }: { state: ReturnType<typeof useManagedHerdrSelection> }) {
  const id = useId();
  const { selection, busy, error, select, refresh } = state;
  const message = error ? 'Herdr selection could not be loaded. Retry before starting a new chat.'
    : !selection ? 'Loading Herdr selection…'
      : selection.status === 'ready' ? 'New chats run in the selected Herdr instance.'
        : selection.status === 'selection_required' ? 'Choose a Herdr instance before sending a new chat.'
          : 'The selected Herdr instance is not ready. Your draft is preserved.';
  return (
    <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs text-muted-foreground" aria-busy={busy}>
      <label htmlFor={id}>Herdr</label>
      <select id={id} aria-describedby={`${id}-status`} disabled={busy} value={selection?.selectedSessionName ?? ''}
        onChange={(event) => void select(event.target.value)}
        className="h-9 max-w-full rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50">
        <option value="" disabled>Choose instance</option>
        {selection?.selectedSessionName && !selection.instances.some((instance) => instance.name === selection.selectedSessionName) && (
          <option value={selection.selectedSessionName}>{selection.selectedSessionName} (unavailable)</option>
        )}
        {selection?.instances.map((instance) => <option key={instance.name} value={instance.name}>{instance.label}{instance.status !== 'available' ? ` (${instance.status})` : ''}</option>)}
      </select>
      <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button>
      <span id={`${id}-status`} role={error ? 'alert' : 'status'} className={error ? 'text-destructive' : ''}>{message}</span>
    </div>
  );
}
