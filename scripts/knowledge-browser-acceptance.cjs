'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');

async function verify({ frontend, account, project, scratch }) {
  assert.ok(process.env.KFIVE_PLAYWRIGHT_MODULE, 'Set the installed Playwright module path');
  const { chromium } = require(process.env.KFIVE_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${frontend.url}/login`);
    await page.locator('input[type="email"]').fill(account.email);
    await page.locator('input[type="password"]').fill(account.password);
    await page.getByRole('button', { name: /sign in/i }).click();
    await page.waitForURL('**/app/**');
    const pages = page.getByRole('navigation', { name: 'Knowledge history pages' });
    const names = () => page.getByRole('button', { name: /^Delete / }).evaluateAll(items => items.map(item => item.getAttribute('aria-label').slice(7)));
    const waitCount = async count => page.waitForFunction(expected => document.querySelectorAll('button[aria-label^="Delete "]').length === expected, count);
    for (const [query, count, prefix] of [['', 217, 'workspace'], [`?projectId=${project}`, 103, 'project'], ['?scope=orphaned', 57, 'orphaned'], ['', 217, 'workspace']]) {
      await page.goto(`${frontend.url}/app/knowledge${query}`);
      await page.getByRole('heading', { name: 'Knowledge / RAG', exact: true }).waitFor();
      await waitCount(50);
      assert.equal(await pages.getByRole('button', { name: 'Previous', exact: true }).isDisabled(), true);
      const all = []; const pageCount = Math.ceil(count / 50);
      for (let index = 0; index < pageCount; index += 1) {
        await waitCount(Math.min(50, count - index * 50));
        all.push(...await names());
        if (index + 1 < pageCount) {
          const response = page.waitForResponse(response => response.url().includes('/knowledge/sources?') && response.request().method() === 'GET');
          await pages.getByRole('button', { name: 'Next', exact: true }).click(); await response;
          await page.waitForFunction(number => document.querySelector('nav[aria-label="Knowledge history pages"]').textContent.includes(`Page ${number} `), index + 2);
        }
      }
      assert.equal(all.length, count); assert.equal(new Set(all).size, count);
      assert.ok(all.every(name => name.startsWith(`${prefix}-`) || (prefix === 'workspace' && name === 'new-after-first-page')));
      assert.equal(await pages.getByRole('button', { name: 'Next', exact: true }).isDisabled(), true);
      await pages.getByRole('button', { name: 'Previous', exact: true }).click(); await waitCount(50);
    }
    await pages.screenshot({ path: path.join(scratch, 'knowledge-pagination.png') });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

module.exports = { verify };
