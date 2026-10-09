import test from 'node:test';
import assert from 'node:assert/strict';
import {createState, transition, announcement, queryParams} from '../../public/state.js';
import {expected, rows} from './oracle.js';

const send = (state, type, payload = {}) => transition(state, {type, ...payload});
const data = options => { const {items, summary} = expected(options); return {items: items.slice(0, 25), summary, page: 1, pageSize: 25, total: items.length, totalPages: Math.ceil(items.length / 25)}; };

test('canonical snapshot survives newer failure and every earlier completion; retry owns changed context', () => {
  let state = send(createState(), 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: data({})});
  const snapshot = state.result;
  state = send(state, 'intent', {patch: {q: 'Billing'}});
  state = send(state, 'result:start'); const old = state.resultOp.token;
  state = send(state, 'intent', {patch: {q: 'Search', status: ['open']}});
  state = send(state, 'result:start');
  state = send(state, 'result:failure', {token: state.resultOp.token, error: 'Connection refused'});
  for (const type of ['result:success', 'result:failure', 'result:finish']) {
    assert.equal(send(state, type, {token: old, data: data({q: 'Billing'}), error: 'Earlier failure'}), state);
  }
  assert.equal(state.result, snapshot); assert.equal(announcement(state), 'Connection refused');
  state = send(state, 'intent', {patch: {q: 'Notifications'}});
  state = send(state, 'result:start'); const current = state.resultOp.token;
  assert.equal(queryParams(state.intent).get('q'), 'Notifications');
  assert.deepEqual(queryParams(state.intent).getAll('status'), ['open']);
  assert.equal(send(state, 'result:finish', {token: old}), state);
  state = send(state, 'result:success', {token: current, data: data({q: 'Notifications', status: ['open']})});
  assert.deepEqual(state.result.data, data({q: 'Notifications', status: ['open']}));
});

test('detail replacement/failure/retry and closing invalidate old data, errors and cleanup together', () => {
  let state = send(createState(), 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: data({})});
  const result = state.result, intent = state.intent;
  state = send(state, 'detail:select', {id: rows[0].id}); state = send(state, 'detail:start'); const old = state.detail.token;
  state = send(state, 'detail:select', {id: rows[1].id}); state = send(state, 'detail:start');
  state = send(state, 'detail:failure', {token: state.detail.token, error: 'Connection refused'});
  for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(send(state, type, {token: old, data: rows[0], error: 'old'}), state);
  state = send(state, 'detail:start'); assert.equal(state.detail.id, rows[1].id);
  state = send(state, 'detail:success', {token: state.detail.token, data: rows[1]}); assert.deepEqual(state.detail.data, rows[1]);
  const closedToken = state.detail.token;
  state = send(state, 'detail:close');
  for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(send(state, type, {token: closedToken, data: rows[1], error: 'old'}), state);
  assert.equal(state.result, result); assert.equal(state.intent, intent); assert.equal(state.detail.id, null);
});

test('address navigation supersedes all writers, failure and late cleanup; retry and clamp own restored page', () => {
  let state = send(createState(), 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: data({})});
  const snapshot = state.result;
  state = send(state, 'detail:select', {id: rows[0].id}); state = send(state, 'detail:start');
  state = send(state, 'export:start'); state = send(state, 'result:start');
  const tokens = {result: state.resultOp.token, detail: state.detail.token, export: state.exportOp.token};
  state = send(state, 'address', {intent: {q: 'Billing', page: 3}});
  assert.equal(state.intent.page, 3); assert.equal(state.detail.id, null);
  assert.equal(state.result, snapshot);
  state = send(state, 'result:start');
  for (const operation of ['result', 'detail', 'export']) for (const ending of ['success', 'failure', 'finish']) {
    assert.equal(send(state, `${operation}:${ending}`, {token: tokens[operation], data: data({}), error: 'obsolete'}), state);
  }
  const failed = state.resultOp.token;
  state = send(state, 'result:failure', {token: failed, error: 'restored failure'});
  assert.equal(announcement(state), 'restored failure');
  state = send(state, 'result:start');
  assert.equal(queryParams(state.intent).get('page'), '3');
  assert.equal(send(state, 'result:finish', {token: failed}), state);
  state = send(state, 'address', {intent: {q: 'Search', page: 2}});
  assert.equal(state.resultOp.error, null); assert.equal(state.exportOp.error, null);
  state = send(state, 'result:start');
  state = send(state, 'result:success', {token: state.resultOp.token, data: data({q: 'Search'})});
  assert.equal(state.intent.page, 1); assert.deepEqual(state.result.data.summary, expected({q: 'Search'}).summary);
  assert.equal(state.result.intent, state.intent);
});

test('overview and personal triage stay independent through detail removal, replacement and late writers', async () => {
  const {createTriage} = await import('../../public/triage.js');
  const triage = createTriage({getItem: () => null, setItem() { throw new Error('unavailable'); }});
  let state = send(createState(), 'detail:select', {id: rows[0].id});
  state = send(state, 'detail:start'); const old = state.detail.token;
  state = send(state, 'detail:success', {token: old, data: rows[0]});
  triage.add(state.detail.data); triage.edit(rows[0].id, '<literal> note');
  state = send(state, 'overview:start'); const overview = state.overviewOp.token;
  state = send(state, 'detail:close');
  triage.remove(rows[0].id);
  state = send(state, 'detail:select', {id: rows[1].id}); state = send(state, 'detail:start');
  for (const type of ['detail:success', 'detail:failure', 'detail:finish']) assert.equal(send(state, type, {token: old, data: rows[0], error: 'obsolete'}), state);
  state = send(state, 'overview:failure', {token: overview, error: 'current service failure'});
  assert.equal(announcement(state), 'Loading incident details.');
  assert.deepEqual(triage.entries, []);
  state = send(state, 'detail:success', {token: state.detail.token, data: rows[1]});
  triage.add(state.detail.data);
  assert.deepEqual(triage.entries.map(entry => entry.id), [rows[1].id]);
  assert.equal(triage.entries[0].note, '');
  assert.match(triage.message, /only for this visit/);
});
