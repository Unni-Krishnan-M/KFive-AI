const http = require('node:http');
const { extractPdf, ocrImage, ocrPdf, ProcessingError, MAX_FILE_BYTES } = require('./processor.cjs');

function createServer(processors = extractPdf) {
  const handlers = typeof processors === 'function'
    ? { extractPdf: processors, ocrImage, ocrPdf }
    : { extractPdf, ocrImage, ocrPdf, ...processors };
  let active = false;
  function respond(res, status, body) {
    if (res.destroyed) return;
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      return respond(res, 200, { status: 'ok', capabilities: { pdfText: true, ocr: true } });
    }
    if (req.method !== 'POST' || !['/extract', '/ocr'].includes(req.url)) return respond(res, 404, { code: 'NOT_FOUND' });
    const mimeType = req.headers['content-type'];
    const allowed = req.url === '/extract'
      ? mimeType === 'application/pdf'
      : ['application/pdf', 'image/png', 'image/jpeg'].includes(mimeType);
    if (!allowed) return respond(res, 415, { code: 'UNSUPPORTED_TYPE' });
    if (active) return respond(res, 503, { code: 'PROCESSOR_BUSY' });
    active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); req.destroy(); }, req.url === '/ocr' ? 65000 : 20000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) { respond(res, 413, { code: 'FILE_TOO_LARGE' }); return; }
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const result = req.url === '/extract'
        ? await handlers.extractPdf(bytes, { signal: controller.signal })
        : mimeType === 'application/pdf'
          ? await handlers.ocrPdf(bytes, { signal: controller.signal })
          : await handlers.ocrImage(bytes, mimeType, { signal: controller.signal });
      respond(res, 200, result);
    } catch (error) {
      const code = error instanceof ProcessingError ? error.code : 'PROCESSING_FAILED';
      respond(res, code === 'PROCESSING_TIMEOUT' ? 504 : 422, { code });
    } finally { clearTimeout(timer); active = false; }
  });
  server.requestTimeout = 65000;
  server.headersTimeout = 5000;
  server.maxConnections = 8;
  return server;
}

function installShutdownHandlers(server, processRef = process) {
  processRef.once('SIGTERM', () => server.close());
  processRef.once('SIGINT', () => server.close());
}

if (require.main === module) {
  const server = createServer();
  server.listen(8080, '0.0.0.0');
  installShutdownHandlers(server);
}
module.exports = { createServer, installShutdownHandlers };
