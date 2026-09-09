import { Request, Response, Router } from 'express';
import { getAuthenticatedUserId } from '@/middleware/auth';
import { asyncHandler } from '@/middleware/errorHandler';
import { aiLimiter } from '@/middleware/rateLimiter';
import {
  BenchmarkRunError,
  BenchmarkService,
  BenchmarkStreamEvent,
  benchmarkService,
} from '@/services/benchmarkService';

function writeSse(res: Response, event: string, revision: number, value: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  const json = JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (character) => {
    const escaped: Record<string, string> = {
      '<': '\\u003c', '>': '\\u003e', '&': '\\u0026', '\u2028': '\\u2028', '\u2029': '\\u2029',
    };
    return escaped[character];
  });
  res.write(`id: ${revision}\nevent: ${event}\ndata: ${json}\n\n`);
  res.flush?.();
}

export function createBenchmarksRouter(service: BenchmarkService = benchmarkService): Router {
  const router = Router();

  router.get('/status', asyncHandler(async (req, res) => {
    res.json({ success: true, data: await service.status(getAuthenticatedUserId(req), req.query.projectId) });
  }));

  router.get('/suites', (_req, res) => {
    res.json({ success: true, data: { suites: service.suites() } });
  });

  router.get('/runs', asyncHandler(async (req, res) => {
    const page = await service.list(getAuthenticatedUserId(req), req.query.page, req.query.projectId);
    res.json({ success: true, data: page });
  }));

  router.get('/runs/:runId', asyncHandler(async (req, res) => {
    const run = await service.get(getAuthenticatedUserId(req), req.params.runId);
    res.json({ success: true, data: { run } });
  }));

  const stream = async (req: Request, res: Response,
    runId: string, cursor?: unknown): Promise<void> => {
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.flushHeaders?.();
    const connection = new AbortController();
    res.once('close', () => { if (!res.writableEnded) connection.abort(); });
    const emit = (event: BenchmarkStreamEvent): void => {
      if (event.type === 'run') writeSse(res, 'run', event.revision, { revision: event.revision, run: event.run });
      else if (event.type === 'call-start') writeSse(res, 'call-start', event.revision, {
        revision: event.revision, runId: event.runId, callIndex: event.callIndex,
        promptIndex: event.promptIndex, repetition: event.repetition,
      });
      else if (event.type === 'call-completed') writeSse(res, 'call-completed', event.revision, {
        revision: event.revision, runId: event.runId, result: event.result,
      });
      else writeSse(res, 'completed', event.revision, { revision: event.revision, run: event.run });
    };
    await service.follow(getAuthenticatedUserId(req), runId, emit, connection.signal, cursor);
    if (!res.writableEnded && !res.destroyed) { res.write('data: [DONE]\n\n'); res.end(); }
  };

  router.get('/runs/:runId/stream', asyncHandler(async (req, res) => {
    const run = await service.get(getAuthenticatedUserId(req), req.params.runId);
    const rawCursor = req.get('Last-Event-ID');
    if (rawCursor !== undefined && (!/^\d+$/.test(rawCursor) || Number(rawCursor) > 1_000_000 || Number(rawCursor) > run.revision)) {
      throw new BenchmarkRunError('Last-Event-ID is invalid or ahead of canonical state.', 'INVALID_BENCHMARK_INPUT', 400);
    }
    await stream(req, res, run.id, rawCursor);
  }));

  router.post('/runs/:runId/cancel', asyncHandler(async (req, res) => {
    const result = await service.cancel(getAuthenticatedUserId(req), req.params.runId);
    res.json({ success: true, data: result });
  }));

  router.delete('/runs/:runId', asyncHandler(async (req, res) => {
    const result = await service.delete(getAuthenticatedUserId(req), req.params.runId);
    res.json({ success: true, data: result });
  }));

  router.post('/runs/stream', aiLimiter, asyncHandler(async (req, res) => {
    const prepared = await service.prepare(getAuthenticatedUserId(req), req.body);
    const run = await service.start(prepared);
    try {
      await stream(req, res, run.id, 0);
    } catch (error) {
      if (!res.writableEnded && !res.destroyed) {
        const safe = error instanceof BenchmarkRunError
          ? { code: error.code, message: error.message }
          : { code: 'BENCHMARK_EXECUTION_FAILED', message: 'The benchmark run failed.' };
        writeSse(res, 'error', run.revision, { revision: run.revision, error: safe.message, code: safe.code });
        res.end();
      }
    }
  }));

  return router;
}

export default createBenchmarksRouter();
