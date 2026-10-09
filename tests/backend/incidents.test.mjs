import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createAppServer } from '../../server/app.mjs';

const dataURL = new URL('../../.runtime/incidents.json', import.meta.url);
const fields = ['id', 'title', 'description', 'service', 'severity', 'status', 'openedAt', 'resolvedAt', 'team', 'region', 'tags'];

// Independent oracle: numeric dates/priorities and a separate summary reduction.
function expected(rows, options = {}) {
  const found = rows.filter(row => {
    if (options.q && !`${row.id}\u0000${row.title}\u0000${row.description}`.toUpperCase().includes(options.q.toUpperCase())) return false;
    for (const facet of ['service', 'status', 'severity']) {
      if (options[facet]?.length && !options[facet].includes(row[facet])) return false;
    }
    const day = Date.parse(row.openedAt.slice(0, 10));
    return (!options.from || day >= Date.parse(options.from)) && (!options.to || day <= Date.parse(options.to));
  });
  const priority = { critical: 40, high: 30, medium: 20, low: 10 };
  found.sort((a, b) => {
    const direction = options.direction === 'asc' ? 1 : -1;
    const primary = options.sort === 'severity' ? priority[a.severity] - priority[b.severity] : Date.parse(a.openedAt) - Date.parse(b.openedAt);
    return primary * direction || (options.sort === 'severity' ? Date.parse(b.openedAt) - Date.parse(a.openedAt) : 0) || a.id.localeCompare(b.id);
  });
  const counts = {};
  let unresolved = 0, highSeverity = 0;
  for (const row of found) {
    if (row.status === 'open' || row.status === 'in_progress') unresolved++;
    if (priority[row.severity] >= 30) highSeverity++;
    const date = row.openedAt.substring(0, 10);
    counts[date] = (counts[date] || 0) + 1;
  }
  return { found, summary: { total: found.length, unresolved, highSeverity, openedByDay: Object.keys(counts).sort().map(date => ({ date, count: counts[date] })) } };
}

function query(options) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    for (const item of Array.isArray(value) ? value : [value]) params.append(key, item);
  }
  return params.toString();
}

// Parse CSV independently, checking that separators outside quotes are CRLF.
function parseCSV(text) {
  const records = [];
  let record = [], value = '', quoted = false, closed = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { value += '"'; index++; }
        else { quoted = false; closed = true; }
      } else value += char;
    } else if (char === '"') {
      assert.equal(value, '');
      assert.equal(closed, false);
      quoted = true;
    } else if (char === ',' || char === '\r') {
      record.push(value); value = ''; closed = false;
      if (char === '\r') {
        assert.equal(text[++index], '\n');
        records.push(record); record = [];
      }
    } else {
      assert.notEqual(char, '\n');
      assert.equal(closed, false);
      value += char;
    }
  }
  assert.equal(quoted, false);
  assert.equal(value, '');
  assert.deepEqual(record, []);
  return records;
}

test('canonical incidents through real loopback HTTP', async t => {
  const before = await readFile(dataURL);
  const rows = JSON.parse(before);
  const server = await createAppServer();
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    assert.equal(server.address().address, '127.0.0.1');
    const base = `http://127.0.0.1:${server.address().port}`;
    const checkList = async (options = {}) => {
      const response = await fetch(`${base}/api/incidents?${query(options)}`);
      assert.equal(response.status, 200);
      const actual = await response.json();
      const { found, summary } = expected(rows, options);
      const pageSize = Number(options.pageSize || 25);
      const totalPages = Math.ceil(found.length / pageSize);
      const page = Math.min(Number(options.page || 1), totalPages || 1);
      assert.deepEqual(actual, { items: found.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: found.length, totalPages, summary });
      return actual;
    };

    await t.test('defaults and whole-result summaries', async () => {
      const body = await checkList();
      assert.equal(body.total, 2400);
      assert.equal(body.items.length, 25);
      assert.equal(body.summary.openedByDay.length, 90);
      assert.equal(body.summary.openedByDay.reduce((n, bucket) => n + bucket.count, 0), 2400);
    });
    await t.test('literal case-insensitive search in all three fields', async () => {
      for (const q of ['inc-000001', 'BATCH PROCESSING DELAY', 'sEcOnD LiNe: <SAMPLE>', 'retry, then continue', '.*', '[', 'Cobalt']) await checkList({ q });
      assert.equal((await checkList({ q: '.*' })).total, 0);
      assert.equal((await checkList({ q: 'Cobalt' })).total, 0);
    });
    await t.test('OR within facets and AND across search, facets and dates', async () => {
      const options = { q: 'incident', service: ['Billing', 'Notifications'], status: ['open', 'in_progress'], severity: ['critical', 'high'], from: '2026-04-15', to: '2026-06-13' };
      assert.ok((await checkList(options)).total > 25);
      await checkList({ service: ['Billing', 'Billing', 'Search'] });
    });
    await t.test('inclusive UTC dates and both single-ended ranges', async () => {
      for (const options of [
        { from: '2026-04-01', to: '2026-04-01' },
        { from: '2026-06-29', to: '2026-06-29' },
        { from: '2026-04-01', to: '2026-06-29' },
        { from: '2026-06-13' }, { to: '2026-04-15' },
        { from: '2027-01-01' },
      ]) await checkList(options);
    });
    await t.test('every sort direction is deterministic including ties', async () => {
      for (const sort of ['openedAt', 'severity']) {
        for (const direction of ['asc', 'desc']) {
          const options = { sort, direction, from: rows[0].openedAt.slice(0, 10), to: rows[0].openedAt.slice(0, 10), pageSize: 50 };
          const first = await checkList(options);
          assert.deepEqual(await checkList(options), first);
          const ids = first.items.map(row => row.id);
          assert.ok(ids.indexOf(rows[0].id) < ids.indexOf(rows[1].id));
        }
      }
    });
    await t.test('pagination bounds, page sizes and empty results', async () => {
      for (const options of [{ page: 2 }, { pageSize: 50, page: 2 }, { page: 999999 }, { pageSize: 50, page: 48 }, { q: 'no such incident', page: 300 }]) await checkList(options);
    });
    await t.test('complete details and useful errors without mutations', async () => {
      for (const row of [rows[0], rows.find(row => row.resolvedAt !== null), rows.at(-1)]) {
        const response = await fetch(`${base}/api/incidents/${row.id}`);
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), row);
      }
      for (const [path, method, status] of [
        ['/api/incidents/INC-999999', 'GET', 404], ['/api/unknown', 'GET', 404],
        ['/api/incidents', 'POST', 405], ['/api/incidents/INC-000001', 'DELETE', 405],
        ['/api/incidents/%ZZ', 'GET', 400], ['/..%2fpackage.json', 'GET', 404],
        ['/..%2f.runtime%2fincidents.json', 'GET', 404],
      ]) {
        const response = await fetch(base + path, { method });
        assert.equal(response.status, status);
        const body = await response.json();
        assert.equal(typeof body.error.code, 'string');
        assert.ok(body.error.message.length);
      }
    });
    await t.test('invalid query parameters return useful 400 errors', async () => {
      const bad = ['from=2026-02-30', 'from=2026-04-31', 'to=2026-13-01', 'from=2026-4-01', 'from=', 'from=2026-06-01&to=2026-04-01', 'service=billing', 'status=closed', 'severity=urgent', 'sort=id', 'direction=down', 'q=a&q=b', 'sort=severity&sort=openedAt', 'page=0', 'page=-1', 'page=1.5', 'page=9007199254740992', 'pageSize=100', 'pageSize=25&pageSize=50', 'unknown=yes'];
      for (const params of bad) {
        const response = await fetch(`${base}/api/incidents?${params}`);
        assert.equal(response.status, 400, params);
        const body = await response.json();
        assert.equal(body.error.code, 'INVALID_QUERY');
        assert.ok(body.error.message.length);
        const overview = await fetch(`${base}/api/overview?${params}`, { signal: AbortSignal.timeout(5000) });
        assert.equal(overview.status, 400, params);
        assert.deepEqual(await overview.json(), body);
      }
      const invalidExport = await fetch(`${base}/api/export.csv?severity=urgent`);
      assert.equal(invalidExport.status, 400);
    });
    await t.test('whole-result CSV round trips every field, quote and newline', async () => {
      for (const options of [{}, { sort: 'severity', direction: 'asc' }, { q: 'Note:', service: ['Notifications', 'Billing'], status: ['open', 'resolved'], from: '2026-04-01', to: '2026-06-29', sort: 'severity', direction: 'desc' }]) {
        const response = await fetch(`${base}/api/export.csv?${query({ ...options, page: 'ignored', pageSize: 1 })}`);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/csv/);
        assert.match(response.headers.get('content-disposition'), /attachment/);
        const text = await response.text();
        const actual = parseCSV(text);
        assert.deepEqual(actual.shift(), fields);
        const { found } = expected(rows, options);
        assert.deepEqual(actual, found.map(row => fields.map(key => row[key] === null ? '' : Array.isArray(row[key]) ? JSON.stringify(row[key]) : String(row[key]))));
        assert.ok(actual.length > 25);
      }
      const empty = await fetch(`${base}/api/export.csv?q=no-such-incident`);
      assert.deepEqual(parseCSV(await empty.text()), [fields]);
    });
  } finally {
    await new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); });
    assert.deepEqual(await readFile(dataURL), before);
  }
});

test('startup reports an ephemeral loopback URL and exits on SIGTERM', async () => {
  const before = await readFile(dataURL);
  const child = spawn(process.execPath, ['server/start.mjs'], { cwd: new URL('../../', import.meta.url), env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  let timer;
  try {
    const url = await new Promise((resolve, reject) => {
      let output = '';
      timer = setTimeout(() => reject(new Error(`Startup timed out: ${stderr}`)), 10000);
      child.on('error', reject);
      child.on('exit', () => reject(new Error(`Startup exited before reporting URL: ${stderr}`)));
      child.stdout.on('data', chunk => {
        output += chunk;
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) resolve(match[0]);
      });
    });
    clearTimeout(timer);
    assert.notEqual(new URL(url).port, '0');
    const response = await fetch(`${url}/api/incidents?q=inc-000001`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).total, 1);
  } finally {
    clearTimeout(timer);
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      const [code, signal] = await exited;
      assert.equal(code, 0, stderr);
      assert.equal(signal, null);
    } finally { clearTimeout(force); }
    assert.deepEqual(await readFile(dataURL), before);
  }
});
