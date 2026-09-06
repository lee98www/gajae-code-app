import express, { type Request, type Response } from 'express';
import { ZodError } from 'zod';

import { herdrInputRequestSchema, herdrPaneIdSchema, herdrSessionNameSchema } from '../../shared/herdr-protocol.js';
import { herdrManagedSelectionSchema, type HerdrManagedPublicSelection } from '../../shared/herdr-managed-provision-protocol.js';
import { getProductionHerdrManagedWorkspacesService, HerdrError, type HerdrManagedWorkspacesService, type HerdrSessionsService } from '../modules/herdr/index.js';
import { asyncHandler, createApiSuccessResponse } from '../shared/utils.js';

const parseSession = (raw: unknown) => herdrSessionNameSchema.parse(String(raw ?? ''));
const parsePane = (raw: unknown) => herdrPaneIdSchema.parse(String(raw ?? ''));

export function createHerdrRouter(service: HerdrSessionsService, managed?: Pick<HerdrManagedWorkspacesService, 'selection' | 'select'>) {
  const router = express.Router();
  const handle = (operation: (req: Request, signal: AbortSignal) => Promise<unknown>) => asyncHandler(async (req: Request, res: Response) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    const closed = () => { if (!res.writableFinished) abort(); };
    req.once('aborted', abort);
    res.once('close', closed);
    if (req.aborted || res.destroyed) abort();
    res.setHeader('Cache-Control', 'no-store');
    try {
      const data = await operation(req, controller.signal);
      if (!controller.signal.aborted) res.json(createApiSuccessResponse(data));
    } catch (error) {
      if (!controller.signal.aborted) {
        const failure = error instanceof ZodError
          ? new HerdrError('HERDR_INVALID_REQUEST', 400, 'Invalid Herdr request.')
          : error instanceof HerdrError ? error
            : new HerdrError('HERDR_UNAVAILABLE', 502, 'Herdr is unavailable or returned an invalid response.');
        res.status(failure.status).json({ error: { code: failure.code, message: failure.message } });
      }
    } finally {
      req.removeListener('aborted', abort);
      res.removeListener('close', closed);
    }
  });

  const publicSelection = (selection: HerdrManagedPublicSelection): HerdrManagedPublicSelection => ({
    selectedSessionName: selection.selectedSessionName,
    status: selection.status,
    instances: selection.instances.map(({ name, label, status }) => ({ name, label, status })),
  });
  router.get('/managed/selection', handle(async () => publicSelection(await (managed ?? getProductionHerdrManagedWorkspacesService()).selection())));
  router.put('/managed/selection', handle(async (req) => {
    const { selectedSessionName } = herdrManagedSelectionSchema.parse(req.body);
    return publicSelection(await (managed ?? getProductionHerdrManagedWorkspacesService()).select(selectedSessionName));
  }));
  router.get('/sessions', handle(async (_req, signal) => ({ sessions: await service.listSessions(signal) })));
  router.get('/sessions/:sessionName/snapshot', handle((req, signal) => service.snapshot(parseSession(req.params.sessionName), signal)));
  router.get('/sessions/:sessionName/panes/:paneId/output', handle((req, signal) => service.output(parseSession(req.params.sessionName), parsePane(req.params.paneId), signal)));
  router.post('/sessions/:sessionName/panes/:paneId/input', handle((req, signal) => service.input(parseSession(req.params.sessionName), parsePane(req.params.paneId), herdrInputRequestSchema.parse(req.body ?? {}), signal)));
  return router;
}
