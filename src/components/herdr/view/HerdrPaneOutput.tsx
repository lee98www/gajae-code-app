import { useTranslation } from 'react-i18next';

import { ScrollArea } from '../../../shared/view/ui';
import type { HerdrOutputResponse } from '../../../../shared/herdr-protocol';

type HerdrPaneOutputProps = {
  output: HerdrOutputResponse | undefined;
  isLoading: boolean;
  error: Error | null;
};

export default function HerdrPaneOutput({ output, isLoading, error }: HerdrPaneOutputProps) {
  const { t } = useTranslation('common');
  if (error) {
    return <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive" role="alert">{t('herdr.readFailed')}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-xl border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-2 text-xs text-muted-foreground">
        <span>{t('herdr.visibleOutput')}</span>
        <span>{isLoading ? t('herdr.refreshing') : output?.observedAt ? new Date(output.observedAt).toLocaleTimeString() : t('herdr.notLoaded')}</span>
      </div>
      <ScrollArea className="min-h-0 flex-1 overflow-auto">
        <pre className="min-h-72 p-4 font-mono text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">
          {output?.text ?? t('herdr.selectPane')}
        </pre>
      </ScrollArea>
      {output?.truncated && <p className="border-t px-3 py-2 text-xs text-muted-foreground">{t('herdr.outputCapped')}</p>}
    </div>
  );
}
