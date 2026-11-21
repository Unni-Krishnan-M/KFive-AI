'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

async function createFrontend({ getBase, root }) {
  const frontend = path.join(root, 'frontend/dist');
  assert.ok(fs.existsSync(path.join(frontend, 'index.html')), 'Build frontend first');
  const app = express();
  app.use(['/api', '/socket.io'], (req, res) => {
    const target = new URL(getBase());
    const proxy = http.request({ hostname: target.hostname, port: target.port, path: req.originalUrl,
      method: req.method, headers: { ...req.headers, host: target.host } }, (upstream) => {
      res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    res.on('close', () => { if (!res.writableEnded) proxy.destroy(); });
    req.pipe(proxy);
  });
  app.use(express.static(frontend)); app.get('*', (_req, res) => res.sendFile(path.join(frontend, 'index.html')));
  const server = app.listen(0, '127.0.0.1');
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/socket.io/')) { socket.destroy(); return; }
    const target = new URL(getBase());
    const upstream = http.request({ hostname: target.hostname, port: target.port, path: req.url,
      headers: { ...req.headers, host: target.host } });
    upstream.on('upgrade', (response, peer, peerHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (head.length) peer.write(head); if (peerHead.length) socket.write(peerHead);
      socket.pipe(peer).pipe(socket);
      peer.on('error', () => socket.destroy()); socket.on('error', () => peer.destroy());
      socket.once('close', () => peer.destroy()); peer.once('close', () => socket.destroy());
    });
    upstream.on('error', () => socket.destroy()); upstream.on('response', () => { upstream.destroy(); socket.destroy(); });
    upstream.end();
  });
  await new Promise((resolve) => server.once('listening', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

async function verify({ frontend, account, runs, scratch }) {
  // Explicit local module path avoids silently downloading a browser or dependencies.
  assert.ok(process.env.KFIVE_PLAYWRIGHT_MODULE, 'Set KFIVE_PLAYWRIGHT_MODULE to an installed Playwright module');
  const { chromium } = require(process.env.KFIVE_PLAYWRIGHT_MODULE);
  let browser;
  let page;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
    page = await context.newPage(); const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`${frontend.url}/login`);
    await page.locator('input[type="email"]').fill(account.email);
    await page.locator('input[type="password"]').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/app/**');
    await page.goto(`${frontend.url}/app/benchmarks`);
    await page.getByRole('heading', { name: 'Model Benchmarks', exact: true }).waitFor();
    await page.locator('aside button').filter({ hasText: 'succeeded' }).first().click();
    const selector = page.getByLabel('Comparison run'); await selector.waitFor();
    const options = await selector.locator('option').evaluateAll((items) => items.map((item) => item.value).filter(Boolean));
    assert.equal(options.length, 1); assert.ok(runs.some((run) => run.id === options[0]));
    await selector.selectOption(options[0]);
    await page.getByText('Comparison', { exact: true }).first().waitFor();
    const selected = runs.find((run) => run.id !== options[0]);
    const comparison = runs.find((run) => run.id === options[0]);
    for (const [label, key] of [['Median duration', 'medianDurationMs'], ['Median TTFT', 'medianTtftMs'],
      ['Median output', 'medianOutputBytes'], ['Output throughput', 'outputTokensPerSecond']]) {
      const meter = page.getByRole('meter', { name: label, exact: true });
      assert.equal(Number(await meter.getAttribute('aria-valuenow')), selected.aggregate[key]);
      assert.equal(Number(await meter.getAttribute('aria-valuemax')), Math.max(selected.aggregate[key], comparison.aggregate[key]));
    }
    assert.equal(await page.locator('tbody tr').count(), 6);
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export JSON/i }).click();
    const download = await downloadPromise; const file = path.join(scratch, 'browser-export.json'); await download.saveAs(file);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    const serialized = JSON.stringify(exported);
    assert.doesNotMatch(serialized, /"(?:uuid|ownerId|leaseOwner|execution|activeOwnerSlot)"/);
    assert.equal(exported.id, selected.id); assert.equal(exported.status, 'succeeded');
    assert.equal(exported.completedCalls, 6); assert.deepEqual(exported.aggregate, selected.aggregate);
    assert.deepEqual(exported.results.map((result) => [result.callIndex, result.output, result.outputBytes]),
      selected.results.map((result) => [result.callIndex, result.output, result.outputBytes]));
    for (const width of [1440, 768, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      if (width < 1024) {
        await page.getByRole('button', { name: 'Open menu', exact: true }).click();
        await page.getByRole('button', { name: 'Close menu', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('aside').getBoundingClientRect().right <= 1);
      }
      const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Compare compatible completed run', exact: true }) });
      await section.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `page overflow at ${width}`);
      assert.equal(await section.evaluate((element) => element.scrollWidth <= element.clientWidth), true, `comparison card overflow at ${width}`);
      await section.screenshot({ path: path.join(scratch, `benchmark-comparison-${width}.png`) });
    }
    assert.deepEqual(errors, []);
    await context.close();
  } catch (error) {
    if (page && !page.isClosed()) {
      // Never capture the login form (it can contain the disposable credentials).
      if (page.url().includes('/app/')) await page.screenshot({ path: path.join(scratch, 'browser-failure.png'), fullPage: true }).catch(() => {});
      fs.writeFileSync(path.join(scratch, 'browser-failure.txt'), `${error.message}\nURL: ${page.url()}\n`, { mode: 0o600 });
    }
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
module.exports = { createFrontend, verify };
