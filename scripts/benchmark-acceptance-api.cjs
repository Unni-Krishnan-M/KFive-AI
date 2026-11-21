'use strict';

// Loopback-only test launcher around the compiled production app and services.
// The worker uses its unmodified production entry point in a separate process.
if (!process.env.KFIVE_BENCHMARK_ACCEPTANCE) throw new Error('Acceptance launcher only');
const { createApp } = require('../backend/dist/app');
const { getEnvironment } = require('../backend/dist/config/environment');
const { connectDatabase, disconnectDatabase } = require('../backend/dist/config/database');
const { connectRedis, disconnectRedis } = require('../backend/dist/config/redis');
const { initializeQueues, closeQueues } = require('../backend/dist/config/queues');
const { benchmarkService } = require('../backend/dist/services/benchmarkService');
const { BenchmarkRunModel } = require('../backend/dist/models/BenchmarkRun');
const { Server } = require('socket.io');
const { setupSocketHandlers } = require('../backend/dist/socket');

(async () => {
  await connectDatabase();
  await BenchmarkRunModel.init();
  await connectRedis();
  await initializeQueues();
  await benchmarkService.recoverInterrupted();
  let recovering = false;
  const timer = setInterval(async () => {
    if (recovering) return;
    recovering = true;
    try { await benchmarkService.recoverInterrupted(); }
    catch { console.error('Benchmark acceptance reconciliation failed'); }
    finally { recovering = false; }
  }, 30_000);
  const server = createApp(getEnvironment()).listen(0, '127.0.0.1', () => {
    process.send({ port: server.address().port });
  });
  const io = new Server(server, { cors: { origin: getEnvironment().corsOrigins, credentials: true } });
  setupSocketHandlers(io);
  process.once('SIGTERM', async () => {
    clearInterval(timer);
    await new Promise((resolve) => io.close(resolve));
    server.close(); server.closeAllConnections();
    await closeQueues(); await disconnectRedis(); await disconnectDatabase();
    process.exit(0);
  });
})().catch((error) => { console.error(error); process.exit(1); });
