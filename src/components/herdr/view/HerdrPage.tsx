import { startTransition, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Network } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle, ScrollArea, buttonVariants } from '../../../shared/view/ui';
import { cn } from '../../../utils/cn';
import { useHerdrOutput, useHerdrSessions, useHerdrSnapshot } from '../../../hooks/useHerdrQueries';
import type { HerdrPane } from '../../../../shared/herdr-protocol';

import HerdrInput from './HerdrInput';
import HerdrPaneOutput from './HerdrPaneOutput';

const paneTitle = (pane: HerdrPane) => pane.label || pane.agent || pane.paneId;

export default function HerdrPage() {
  const { t } = useTranslation('common');
  const params = useParams<{ sessionName: string; paneId: string }>();
  const navigate = useNavigate();
  const sessions = useHerdrSessions();
  const sessionName = params.sessionName ?? null;
  const snapshot = useHerdrSnapshot(sessionName);
  const [selection, setSelection] = useState<{
    sessionName: string;
    pane: HerdrPane;
    errors: [number, number, number];
  } | null>(null);
  const [revoked, setRevoked] = useState(false);
  const [selectionRevision, setSelectionRevision] = useState(0);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const selectedPane = snapshot.data?.session.name === sessionName
    ? snapshot.data.panes.find((pane) => pane.paneId === params.paneId) ?? null : null;
  const selectionMatches = selection?.sessionName === sessionName
    && selection.pane.paneId === selectedPane?.paneId
    && selection.pane.terminalId === selectedPane?.terminalId
    && selection.pane.observationToken === selectedPane?.observationToken;
  const output = useHerdrOutput(sessionName, selectedPane?.paneId ?? null);
  const observedOutput = output.data
    && selectedPane
    && output.data.sessionName === sessionName
    && output.data.paneId === selectedPane.paneId
    && output.data.terminalId === selectedPane.terminalId
    && output.data.observationToken === selectedPane.observationToken
    ? output.data : undefined;
  const sessionAvailable = snapshot.data?.session.status === 'available'
    && sessions.data?.some((session) => session.name === sessionName && session.status !== 'unreachable' && session.status !== 'unsupported');
  const fresh = now - snapshot.dataUpdatedAt < 15_000 && (!output.data || now - output.dataUpdatedAt < 15_000);
  const readFailed = Boolean(sessions.failureCount || snapshot.failureCount || output.failureCount);
  const selectionFailed = Boolean(selection && (
    sessions.errorUpdatedAt > selection.errors[0]
    || snapshot.errorUpdatedAt > selection.errors[1]
    || output.errorUpdatedAt > selection.errors[2]
  ));
  const revoke = useCallback(() => setRevoked(true), []);
  useEffect(() => {
    if (selection && (!selectionMatches || readFailed || selectionFailed || !fresh || !sessionAvailable
      || (output.data && !observedOutput))) revoke();
  }, [selection, selectionMatches, readFailed, selectionFailed, fresh, sessionAvailable, output.data, observedOutput, revoke]);

  const chooseSession = (name: string) => {
    setSelection(null);
    setRevoked(false);
    navigate(`/herdr/${encodeURIComponent(name)}`);
  };
  const choosePane = (pane: HerdrPane) => {
    if (!sessionName) return;
    startTransition(() => {
      setSelection({
        sessionName,
        pane,
        errors: [sessions.errorUpdatedAt, snapshot.errorUpdatedAt, output.errorUpdatedAt],
      });
      setSelectionRevision((revision) => revision + 1);
      setRevoked(false);
      navigate(`/herdr/${encodeURIComponent(sessionName)}/panes/${encodeURIComponent(pane.paneId)}`);
    });
  };

  return (
    <main className="flex h-full min-h-0 flex-col bg-background p-4 text-foreground">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Network className="size-4" aria-hidden />{t('herdr.eyebrow')}</div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('herdr.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('herdr.description')}</p>
        </div>
        <Link className={cn(buttonVariants({ variant: 'outline' }))} to="/">{t('herdr.backToChats')}</Link>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        <Card className="min-h-0">
          <CardHeader><CardTitle>{t('herdr.sessions')}</CardTitle></CardHeader>
          <CardContent className="min-h-0">
            {sessions.error && <p className="mb-2 text-sm text-destructive" role="alert">{t('herdr.readFailed')}</p>}
            <ScrollArea className="max-h-[calc(100vh-13rem)] overflow-auto">
              <div className="space-y-2">
                {(sessions.data ?? []).map((session) => (
                  <button
                    key={session.name}
                    type="button"
                    aria-pressed={session.name === sessionName}
                    onClick={() => chooseSession(session.name)}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${session.name === sessionName ? 'border-primary bg-primary/10' : 'hover:bg-accent/70'}`}
                  >
                    <span className="block font-medium">{session.label}</span>
                    <span className="block text-xs text-muted-foreground">{session.name} · {t(`herdr.status.${session.status}`)}</span>
                    {session.error && <span className="block text-xs text-destructive">{t('herdr.readFailed')}</span>}
                  </button>
                ))}
                {!sessions.isLoading && !sessions.error && sessions.data?.length === 0 && <p className="text-sm text-muted-foreground">{t('herdr.noSessions')}</p>}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <div className="grid min-h-0 gap-4 xl:grid-cols-[18rem_minmax(0,1fr)]">
          <Card className="min-h-0">
            <CardHeader><CardTitle>{t('herdr.panes')}</CardTitle></CardHeader>
            <CardContent>
              {snapshot.error && <p className="mb-2 text-sm text-destructive" role="alert">{t('herdr.readFailed')}</p>}
              {!sessionName && <p className="text-sm text-muted-foreground">{t('herdr.chooseSession')}</p>}
              {(revoked || (params.paneId && !selection)) && <p className="mb-2 text-sm text-destructive" role="alert">{t('herdr.selectionStale')}</p>}
              <div className="space-y-2">
                {(snapshot.data?.workspaces ?? []).map((workspace) => (
                  <section key={workspace.workspaceId} aria-label={workspace.label}>
                    <h2 className="font-semibold">{workspace.label}</h2>
                    {(snapshot.data?.tabs ?? []).filter((tab) => tab.workspaceId === workspace.workspaceId).map((tab) => (
                      <section key={tab.tabId} className="ml-2 space-y-2" aria-label={tab.label}>
                        <h3 className="text-sm font-medium">{tab.label}</h3>
                        {(snapshot.data?.panes ?? []).filter((pane) => pane.workspaceId === workspace.workspaceId && pane.tabId === tab.tabId).map((pane) => (
                  <button
                    key={`${sessionName}:${pane.paneId}:${pane.terminalId}`}
                    type="button"
                    onClick={() => choosePane(pane)}
                    disabled={Boolean(sessions.error || snapshot.error)}
                    aria-pressed={pane === selectedPane}
                    className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition-colors ${pane === selectedPane ? 'border-primary bg-primary/10' : 'hover:bg-accent/70'}`}
                  >
                    <span className="block font-medium">{paneTitle(pane)}</span>
                    <span className="block text-xs text-muted-foreground">{pane.paneId} · {t(`herdr.status.${pane.agentStatus}`)}</span>
                    <span className="block truncate text-xs text-muted-foreground">{pane.cwd}</span>
                  </button>
                ))}
                      </section>
                    ))}
                  </section>
                ))}
              </div>
            </CardContent>
          </Card>

          <div className="flex min-h-0 flex-col gap-3">
            <HerdrPaneOutput output={observedOutput} isLoading={output.isFetching} error={output.error} />
            <HerdrInput
              key={JSON.stringify([sessionName, selectedPane?.paneId, selectedPane?.terminalId, selectedPane?.observationToken, selectionRevision])}
              sessionName={sessionName}
              pane={selectedPane}
              enabled={Boolean(selectionMatches && !revoked && !selectionFailed && fresh && sessionAvailable && observedOutput && !readFailed)}
              onRevoke={revoke}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
