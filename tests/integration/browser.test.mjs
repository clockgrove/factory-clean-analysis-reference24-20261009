import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdir, readFile} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {once} from 'node:events';
import {createAppServer} from '../../server/app.mjs';
import {expected, rows, parseCSV, csvRows} from './oracle.js';

const alias = dirname(execFileSync('bash', ['-c', 'command -v qualification-chromium'], {encoding: 'utf8'}).trim());
process.env.PLAYWRIGHT_BROWSERS_PATH = resolve(alias, '../browsers');
await mkdir('.runtime/browser-tmp', {recursive: true});
for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = '.runtime/browser-tmp';
const {chromium} = await import('playwright');
// Poll observable DOM state; node:assert supplies assertions without another package.
function expect(locator, negate = false) {
  const poll = async (read, wanted) => {
    const deadline = Date.now() + 10000;
    let actual;
    do {
      actual = await read();
      if ((actual === wanted) !== negate) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    } while (Date.now() < deadline);
    assert.fail(`DOM expectation timed out: actual=${actual}, expected=${wanted}, negate=${negate}`);
  };
  return {
    get not() { return expect(locator, !negate); },
    toHaveAttribute: (key, value) => poll(() => locator.getAttribute(key), value),
    toHaveText: value => poll(() => locator.textContent(), value),
    toContainText: value => poll(async () => (await locator.textContent()).includes(value), true),
    toHaveCount: value => poll(() => locator.count(), value),
    toHaveValue: value => poll(() => locator.inputValue(), value),
    toBeVisible: () => poll(() => locator.isVisible(), true),
    toBeFocused: () => poll(() => locator.evaluate(x => x === document.activeElement), true),
    toBeChecked: () => poll(() => locator.isChecked(), true),
    toBeDisabled: () => poll(() => locator.isDisabled(), true)
  };
}
const utc = value => value ? value.replace('T', ' ').replace('.000Z', ' UTC') : 'Not resolved';
const human = value => value.replaceAll('_', ' ');

test('real Chromium: correctness, persisted views, keyboard, phone and overlapping HTTP intents', {timeout: 120000}, async t => {
  const before = await readFile('.runtime/incidents.json');
  let server, browser, context, port;
  const start = async () => {
    server = await createAppServer(); server.listen(port || 0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  };
  const stop = async () => {
    if (!server?.listening) return;
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeAllConnections(); });
  };
  try {
    await start();
    browser = await chromium.launch({channel: 'chromium', headless: true, chromiumSandbox: true, env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      LD_LIBRARY_PATH: resolve(alias, '../host-libs/usr/lib/x86_64-linux-gnu'),
      ALSA_CONFIG_PATH: resolve(alias, '../host-libs/usr/share/alsa/alsa.conf'),
      TMPDIR: '.runtime/browser-tmp', TMP: '.runtime/browser-tmp', TEMP: '.runtime/browser-tmp'
    }});
    context = await browser.newContext({acceptDownloads: true});
    let page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const cdp = await context.newCDPSession(page);
    const throttle = latency => cdp.send('Network.emulateNetworkConditions', {offline: false, latency, downloadThroughput: -1, uploadThroughput: -1});
    await cdp.send('Network.enable');
    const check = async (options = {}) => {
      await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#freshness')).toHaveText('Current selections');
      const {items, summary} = expected(options);
      const size = options.pageSize || 25, n = options.page || 1;
      const address = new URL(page.url()).searchParams;
      for (const [key, fallback] of Object.entries({q: '', from: '', to: '', sort: 'openedAt', direction: 'desc', page: 1, pageSize: 25})) assert.equal(address.get(key) ?? '', String(options[key] ?? fallback), `address ${key}`);
      for (const facet of ['service', 'status', 'severity']) assert.deepEqual(address.getAll(facet), [...(options[facet] || [])].sort());
      assert.deepEqual(await page.locator('#rows button').evaluateAll(nodes => nodes.map(x => x.dataset.incident)), items.slice((n - 1) * size, n * size).map(x => x.id));
      assert.deepEqual(await page.locator('#summary strong').allTextContents(), [summary.total, summary.unresolved, summary.highSeverity].map(x => x.toLocaleString()));
      await expect(page.locator('#chart-text')).toHaveText(summary.openedByDay.length ? summary.openedByDay.map(d => `${d.date}: ${d.count} incident${d.count === 1 ? '' : 's'}`).join('; ') : 'No matching incidents were opened in this range.');
      await expect(page.locator('#page-label')).toHaveText(items.length ? `Page ${n} of ${Math.ceil(items.length / size)} · ${items.length.toLocaleString()} incidents` : '0 incidents · no pages');
    };
    const search = async q => { await page.getByLabel('Search ID, title or description').fill(q); await page.getByLabel('Search ID, title or description').press('Enter'); };
    const clear = async () => { await page.getByRole('button', {name: 'Clear search and filters', exact: true}).click(); };
    const detail = async row => {
      await expect(page.locator('#detail-content dd')).toHaveCount(11);
      assert.deepEqual(await page.locator('#detail-content dd').allTextContents(), Object.entries(row).map(([key, value]) => key.endsWith('At') ? utc(value) : key === 'tags' ? value.join(', ') : key === 'status' ? human(value) : String(value)));
    };
    await t.test('unfiltered startup and loading, complete summaries and repeated pagination', async () => {
      await throttle(600); await page.goto(`http://127.0.0.1:${port}`);
      await expect(page.locator('#result-message')).toContainText('Loading'); await check(); await throttle(0);
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({page: 2});
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({page: 3});
      await page.getByLabel('Rows per page').selectOption('50'); await check({pageSize: 50});
      await page.getByRole('button', {name: 'Next', exact: true}).click(); await check({pageSize: 50, page: 2});
    });
    await t.test('search, facet OR/AND, dates, all sorts, page resets and CSV', async () => {
      await page.getByLabel('Rows per page').selectOption('25');
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>']) { await search(q); await check({q}); }
      await search('incident');
      const options = {q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29'};
      for (const [facet, values] of Object.entries(options)) if (Array.isArray(values)) for (const value of values) await page.locator(`#${facet}`).getByLabel(human(value), {exact: true}).check();
      await page.getByLabel('From (inclusive)').fill(options.from); await page.getByLabel('To (inclusive)').fill(options.to); await check(options);
      assert.ok(expected(options).items.length > 50);
      for (const sort of ['openedAt', 'severity']) for (const direction of ['asc', 'desc']) {
        await page.getByLabel('Sort by').selectOption(sort); await page.getByLabel('Order', {exact: true}).selectOption(direction); await check({...options, sort, direction});
      }
      const downloadReady = page.waitForEvent('download'); await page.getByRole('button', {name: 'Download CSV'}).click(); const download = await downloadReady;
      assert.deepEqual(parseCSV(await readFile(await download.path(), 'utf8')), csvRows(expected({...options, sort: 'severity', direction: 'desc'}).items));
      await clear(); await page.getByLabel('Sort by').selectOption('openedAt'); await page.getByLabel('Order', {exact: true}).selectOption('desc');
      for (const date of ['2026-04-01', '2026-06-29', rows[0].openedAt.slice(0, 10)]) {
        await clear(); await page.getByLabel('From (inclusive)').fill(date); await page.getByLabel('To (inclusive)').fill(date); await check({from: date, to: date});
      }
    });
    await t.test('saved views survive reload, restore all choices and delete persistently', async () => {
      await clear(); await search('retry'); await page.locator('#service').getByLabel('Billing', {exact: true}).check();
      await page.getByLabel('Sort by').selectOption('severity'); await page.getByLabel('Order', {exact: true}).selectOption('asc'); await page.getByLabel('Rows per page').selectOption('50');
      const options = {q: 'retry', service: ['Billing', 'Search'], status: ['open', 'resolved'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13', sort: 'severity', direction: 'asc', pageSize: 50};
      await page.locator('#service').getByLabel('Search', {exact: true}).check();
      for (const facet of ['status', 'severity']) for (const value of options[facet]) await page.locator(`#${facet}`).getByLabel(human(value), {exact: true}).check();
      await page.getByLabel('From (inclusive)').fill(options.from); await page.getByLabel('To (inclusive)').fill(options.to); await check(options);
      await page.getByLabel('Name this view').fill('Billing retry'); await page.getByRole('button', {name: 'Save current view'}).click();
      await page.reload(); await check(options); await page.getByRole('button', {name: 'Open saved view Billing retry'}).click(); await check(options);
      await expect(page.getByLabel('Search ID, title or description')).toHaveValue('retry'); await expect(page.locator('#service').getByLabel('Billing', {exact: true})).toBeChecked();
      for (const facet of ['service', 'status', 'severity']) for (const value of options[facet]) await expect(page.locator(`#${facet}`).getByLabel(human(value), {exact: true})).toBeChecked();
      for (const [label, value] of [['From (inclusive)', options.from], ['To (inclusive)', options.to], ['Sort by', options.sort], ['Order', options.direction], ['Rows per page', '50']]) await expect(page.getByLabel(label, {exact: true})).toHaveValue(value);
      await page.getByRole('button', {name: 'Delete saved view Billing retry'}).click(); await page.reload(); await check(options); await expect(page.locator('#views')).toHaveText('No saved views yet.');
    });
    await t.test('share every applied field and later page through reload, fresh tab and history', async () => {
      const options = {q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-01', to: '2026-06-29', sort: 'severity', direction: 'asc', pageSize: 25, page: 2};
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(options)) for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
      const address = `http://127.0.0.1:${port}/?${params}#results`;
      const controls = async () => {
        for (const [id, key] of [['search', 'q'], ['from', 'from'], ['to', 'to'], ['sort', 'sort'], ['direction', 'direction'], ['page-size', 'pageSize']]) await expect(page.locator(`#${id}`)).toHaveValue(String(options[key]));
        for (const facet of ['service', 'status', 'severity']) assert.deepEqual(await page.locator(`#${facet} input:checked`).evaluateAll(xs => xs.map(x => x.value).sort()), [...options[facet]].sort());
      };
      await page.goto(address); await check(options); await controls();
      const canonical = page.url(); assert.equal(new URL(canonical).hash, '#results');
      await page.reload(); await check(options); await controls(); assert.equal(page.url(), canonical);
      const original = page; const fresh = await context.newPage(); fresh.setDefaultTimeout(10000);
      try { page = fresh; await page.goto(canonical); await check(options); await controls(); await expect(page.locator('#detail')).not.toBeVisible(); }
      finally { page = original; await fresh.close(); }
      const historyLength = await page.evaluate(() => history.length);
      await search('incident'); await check({...options, page: 1});
      assert.equal(await page.evaluate(() => history.length), historyLength + 1);
      await search('incident'); await check({...options, page: 1});
      assert.equal(await page.evaluate(() => history.length), historyLength + 1);
      await page.locator('#search').fill('discard this draft');
      await page.evaluate(() => history.back()); await check(options); await controls(); await expect(page.locator('#search')).toBeFocused();
      await page.evaluate(() => history.forward()); await check({...options, page: 1});
      await page.goto(`http://127.0.0.1:${port}/`); await check();
    });
    await t.test('malformed links normalize before HTTP; encoded text and repeated facets retain meaning', async () => {
      const requests = [];
      const observe = request => { if (request.url().includes('/api/incidents?')) requests.push(request.url()); };
      page.on('request', observe);
      try {
        for (const [query, options] of [
          ['q=a&q=b&sort=id&direction=down&page=1e2&pageSize=5e1&from=2026-02-29&to=2026-04-31&unknown=yes', {}],
          ['from=1900-02-29&to=2026-13-01&page=9007199254740992', {}],
          ['from=2026-04-01&from=2026-04-01&to=2026-06-29&to=2026-06-29&page=-1&pageSize=100', {}],
          ['page=1.5', {}],
          ['from=2026-06-01&to=2026-04-01&page=0', {}],
          ['sort=severity&sort=severity&direction=asc&direction=asc&pageSize=50&pageSize=50&page=2&page=2', {}],
          ['from=2000-02-29&to=2000-02-29', {from: '2000-02-29', to: '2000-02-29'}],
          ['q=a%2Bb%20%26%20%25%20%23%20caf%C3%A9&service=Search&service=Billing&service=Search&service=bad&status=open&status=resolved', {q: 'a+b & % # café', service: ['Billing', 'Search'], status: ['open', 'resolved']}]
        ]) {
          await page.goto(`http://127.0.0.1:${port}/?${query}`); await check(options);
          const actual = new URL(requests.at(-1)).searchParams;
          assert.equal(actual.has('unknown'), false);
          for (const key of ['q', 'from', 'to', 'sort', 'direction', 'page', 'pageSize']) assert.ok(actual.getAll(key).length <= 1);
          assert.equal(new URL(page.url()).search, new URL(requests.at(-1)).search);
          await expect(page.locator('#search')).toHaveValue(options.q || '');
        }
        await page.goto(`http://127.0.0.1:${port}/?page=999999`); await check({page: 96});
        assert.equal(new URL(page.url()).searchParams.get('page'), '96');
      } finally { page.off('request', observe); }
      await page.goto(`http://127.0.0.1:${port}/`); await check();
    });
    await t.test('Back during pending HTTP, current failure/retry, details and obsolete export cleanup', async () => {
      await search('Uploads'); await check({q: 'Uploads'});
      await throttle(900);
      const pending = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await pending;
      const snapshot = await page.locator('#summary').textContent();
      await stop();
      await page.evaluate(() => history.back());
      await expect(page.locator('#search')).toHaveValue('Uploads');
      assert.equal(await page.locator('#summary').textContent(), snapshot);
      await expect(page.locator('#result-message button')).toHaveText('Retry');
      await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await start(); await throttle(0);
      const length = await page.evaluate(() => history.length);
      await page.locator('#result-message button').click(); await check({q: 'Uploads'});
      assert.equal(await page.evaluate(() => history.length), length);
      await page.evaluate(() => history.forward()); await check({q: 'Billing'});
      await page.locator('#rows button').first().click(); await detail(expected({q: 'Billing'}).items[0]);
      await page.evaluate(() => history.back()); await expect(page.locator('#detail')).not.toBeVisible(); await check({q: 'Uploads'});
      const downloads = []; const download = value => downloads.push(value); page.on('download', download);
      try {
        await throttle(900);
        const exporting = page.waitForRequest(r => r.url().includes('/api/export.csv?'));
        await page.locator('#export').click(); await exporting;
        await page.evaluate(() => history.forward()); await check({q: 'Billing'});
        await expect(page.locator('#export-message')).toHaveText('');
        assert.equal(downloads.length, 0);
      } finally { page.off('download', download); await throttle(0); }
      const ready = page.waitForEvent('download'); await page.locator('#export').click();
      assert.deepEqual(parseCSV(await readFile(await (await ready).path(), 'utf8')), csvRows(expected({q: 'Billing'}).items));
      await clear(); await check();
    });
    await t.test('keyboard details expose all fields, focus and results return; phone controls fit', async () => {
      await search('inc-000001'); await check({q: 'inc-000001'});
      const button = page.locator('#rows button').first(); await button.focus(); await button.press('Enter'); await detail(rows[0]);
      await page.keyboard.press('Escape'); await expect(page.locator('#detail')).not.toBeVisible(); await expect(button).toBeFocused(); await check({q: 'inc-000001'});
      assert.notEqual(await button.evaluate(x => getComputedStyle(x).outlineStyle), 'none');
      await page.setViewportSize({width: 375, height: 812}); await clear(); await check();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#service').getByLabel('Search', {exact: true}).focus(); await page.keyboard.press('Space'); await check({service: ['Search']});
      await page.locator('#rows button').first().click(); await detail(expected({service: ['Search']}).items[0]); await page.getByRole('button', {name: 'Close details'}).click(); await check({service: ['Search']});
      await page.setViewportSize({width: 1280, height: 900});
    });
    await t.test('personal triage persists literal notes, keeps editor focus, and restores actual opener on phones', async () => {
      await clear(); await check();
      const row = expected({}).items[0];
      await page.locator('#rows button').first().click(); await detail(row);
      await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
      await page.getByRole('button', {name: 'Add to personal triage', exact: true}).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('#triage-list textarea')).toHaveCount(1);
      const note = '<b>Investigate & retry</b> "literal"';
      const editor = page.getByLabel(`Personal note for ${row.id}`);
      await editor.fill(note);
      await editor.evaluate(x => { x.focus(); x.setSelectionRange(3, 9); });
      // Apply another request without moving focus; its completion must retain the editor.
      await page.evaluate(() => { const select = document.querySelector('#direction'); select.value = 'asc'; select.dispatchEvent(new Event('change')); });
      await check({direction: 'asc'});
      await expect(editor).toBeFocused();
      assert.deepEqual(await editor.evaluate(x => [x.selectionStart, x.selectionEnd]), [3, 9]);
      await page.evaluate(() => { const select = document.querySelector('#direction'); select.value = 'desc'; select.dispatchEvent(new Event('change')); });
      await check();
      await page.reload(); await check();
      await expect(page.getByLabel(`Personal note for ${row.id}`)).toHaveValue(note);
      await page.setViewportSize({width: 375, height: 812});
      const opener = page.getByRole('button', {name: `Open triage incident ${row.id}`, exact: true});
      const address = page.url(), length = await page.evaluate(() => history.length);
      await opener.focus(); await opener.press('Enter'); await detail(row);
      await page.keyboard.press('Escape'); await expect(opener).toBeFocused();
      assert.equal(page.url(), address); assert.equal(await page.evaluate(() => history.length), length);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.getByRole('button', {name: `Remove ${row.id} from triage`, exact: true}).click();
      await page.reload(); await check(); await expect(page.locator('#triage-list textarea')).toHaveCount(0);
      await page.setViewportSize({width: 1280, height: 900});
    });
    await t.test('pending intent replacement, detail close/reselection, empty and genuine failure/retry', async () => {
      await clear(); await check(); await throttle(900);
      const previousSummary = await page.locator('#summary').textContent();
      const firstRequest = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await firstRequest; await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('#results')).toHaveAttribute('data-stale', 'true');
      assert.equal(await page.locator('#summary').textContent(), previousSummary);
      await expect(page.locator('#next')).toBeDisabled();
      // Repeated keyboard activation while stale must not move pagination.
      await page.locator('#next').press('Enter'); await page.locator('#next').press('Enter');
      await search('Uploads'); await check({q: 'Uploads'});
      const snapshot = await page.locator('#rows').textContent();
      const oldDetail = page.waitForRequest(r => r.url().includes('/api/incidents/INC-'));
      await page.locator('#rows button').first().click(); await oldDetail; await expect(page.locator('#detail-content')).toContainText('Loading');
      await page.keyboard.press('Escape'); await page.locator('#rows button').nth(1).click(); await detail(expected({q: 'Uploads'}).items[1]);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#rows').textContent(), snapshot); await check({q: 'Uploads'});
      const pending = page.waitForRequest(r => r.url().includes('/api/incidents?') && new URL(r.url()).searchParams.get('q') === 'Billing');
      await search('Billing'); await pending; await stop(); await search('Search');
      await expect(page.locator('#result-message button')).toHaveText('Retry'); await expect(page.locator('#results')).toHaveAttribute('aria-busy', 'false');
      await expect(page.getByLabel('Search ID, title or description')).toHaveValue('Search');
      await search('Notifications'); await expect(page.locator('#result-message button')).toHaveText('Retry');
      await start(); await throttle(0); await page.locator('#result-message').getByRole('button', {name: 'Retry'}).click(); await check({q: 'Notifications'});
      // A real detail connection failure is retried for the newly selected ID.
      await stop(); await page.locator('#rows button').first().click();
      await expect(page.locator('#detail-content button')).toHaveText('Retry');
      await page.keyboard.press('Escape'); await page.locator('#rows button').nth(1).click();
      await expect(page.locator('#detail-content button')).toHaveText('Retry');
      await start(); await page.locator('#detail-content').getByRole('button', {name: 'Retry'}).click();
      await detail(expected({q: 'Notifications'}).items[1]); await page.keyboard.press('Escape'); await check({q: 'Notifications'});
      await search('nothing matches this phrase'); await check({q: 'nothing matches this phrase'}); await expect(page.locator('#result-message')).toContainText('No incidents match'); await expect(page.locator('#next')).toBeDisabled();
    });
    assert.deepEqual(errors, []);
  } finally {
    try { await context?.close(); } finally { try { await browser?.close(); } finally { await stop(); } }
    assert.deepEqual(await readFile('.runtime/incidents.json'), before);
  }
});
