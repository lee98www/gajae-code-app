import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { herdrInputRequestSchema, type HerdrInputAction, type HerdrPane } from '../../../../shared/herdr-protocol';
import { Button } from '../../../shared/view/ui';
import { useHerdrInput } from '../../../hooks/useHerdrQueries';

type HerdrInputProps = {
  sessionName: string | null;
  pane: HerdrPane | null;
  enabled: boolean;
  onRevoke?: () => void;
};

export default function HerdrInput({ sessionName, pane, enabled, onRevoke }: HerdrInputProps) {
  const { t } = useTranslation('common');
  const [text, setText] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [revoked, setRevoked] = useState(false);
  const sending = useRef(false);
  const mutation = useHerdrInput(sessionName, pane?.paneId ?? null);
  const { reset, cancel } = mutation;
  const disabled = !enabled || !pane || revoked || mutation.isPending;
  const textInvalid = Boolean(text) && !herdrInputRequestSchema.safeParse({
    action: 'text', text, terminalId: pane?.terminalId ?? 'unselected', observationToken: pane?.observationToken ?? 'unselected',
  }).success;

  useEffect(() => {
    setText('');
    setMessage(null);
    setRevoked(false);
    sending.current = false;
    reset();
    return cancel;
  }, [sessionName, pane?.paneId, pane?.terminalId, pane?.observationToken, reset, cancel]);

  useEffect(() => {
    if (!enabled && mutation.isPending) cancel();
  }, [enabled, mutation.isPending, cancel]);

  const send = (action: HerdrInputAction) => {
    if (!pane || disabled || sending.current) return;
    const payloadText = action === 'text' || action === 'text-enter' ? text : '';
    if ((action === 'text' || action === 'text-enter') && (!payloadText || textInvalid)) return;
    setMessage(null);
    sending.current = true;
    mutation.mutate({ action, text: payloadText, terminalId: pane.terminalId, observationToken: pane.observationToken }, {
      onSuccess: () => {
        setMessage(t('herdr.accepted'));
        if (action === 'text' || action === 'text-enter') setText('');
      },
      onError: () => {
        setRevoked(true);
        onRevoke?.();
      },
      onSettled: () => {
        sending.current = false;
      },
    });
  };

  return (
    <section className="rounded-xl border bg-card p-3">
      <label className="mb-2 block text-sm font-medium text-foreground" htmlFor="herdr-input">{t('herdr.inputLabel')}</label>
      <textarea
        id="herdr-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
        disabled={disabled}
        rows={1}
        aria-invalid={textInvalid}
        autoComplete="off"
        spellCheck={false}
        className="min-h-20 w-full resize-y rounded-lg border bg-background px-3 py-2 text-sm outline-hidden focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
        placeholder={t('herdr.inputPlaceholder')}
      />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={disabled || !text || textInvalid} onClick={() => send('text')}>{t('herdr.sendText')}</Button>
        <Button type="button" size="sm" disabled={disabled || !text || textInvalid} onClick={() => send('text-enter')}>{t('herdr.sendEnter')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => send('enter')}>{t('herdr.enter')}</Button>
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => send('escape')}>{t('herdr.escape')}</Button>
      </div>
      {textInvalid && <p className="mt-2 text-xs text-destructive">{t('herdr.inputInvalid')}</p>}
      {mutation.error && <p className="mt-2 text-xs text-destructive" role="alert">{t('herdr.inputFailed')}</p>}
      {message && <p className="mt-2 text-xs text-muted-foreground" role="status">{message}</p>}
      <p className="mt-2 text-xs text-muted-foreground">{t('herdr.residualRisk')}</p>
    </section>
  );
}
