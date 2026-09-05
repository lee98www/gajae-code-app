import express, { type Request, type Response } from 'express';
import { ZodError } from 'zod';

import { herdrInputRequestSchema, herdrPaneIdSchema, herdrSessionNameSchema } from '../../shared/herdr-protocol.js';
import { HerdrError } from '../services/herdr-client.js';
import { type HerdrSessionsService } from '../services/herdr-sessions.js';
import { asyncHandler, createApiSuccessResponse } from '../shared/utils.js';

const parseSession = (raw: unknown) => herdrSessionNameSchema.parse(String(raw ?? ''));
const parsePane = (raw: unknown) => herdrPaneIdSchema.parse(String(raw ?? ''));

export function createHerdrRouter(service: HerdrSessionsService) {
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

  router.get('/sessions', handle(async (_req, signal) => ({ sessions: await service.listSessions(signal) })));
  router.get('/sessions/:sessionName/snapshot', handle((req, signal) => service.snapshot(parseSession(req.params.sessionName), signal)));
  router.get('/sessions/:sessionName/panes/:paneId/output', handle((req, signal) => service.output(parseSession(req.params.sessionName), parsePane(req.params.paneId), signal)));
  router.post('/sessions/:sessionName/panes/:paneId/input', handle((req, signal) => service.input(parseSession(req.params.sessionName), parsePane(req.params.paneId), herdrInputRequestSchema.parse(req.body ?? {}), signal)));
  return router;
}
