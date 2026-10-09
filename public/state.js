// DOM-free state transitions. Tokens identify ownership, not network cancellation.
export const defaults = Object.freeze({q: '', service: [], status: [], severity: [], from: '', to: '', sort: 'openedAt', direction: 'desc', page: 1, pageSize: 25});
const values = {service: ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'], status: ['open', 'in_progress', 'resolved'], severity: ['critical', 'high', 'medium', 'low']};
export function normalizeIntent(input = {}) {
  const x = {...defaults, ...input};
  const result = {...defaults};
  result.q = typeof x.q === 'string' ? x.q : '';
  for (const key of Object.keys(values)) result[key] = [...new Set(Array.isArray(x[key]) ? x[key].filter(v => values[key].includes(v)) : [])].sort();
  for (const key of ['from', 'to']) {
    const value = x[key], time = typeof value === 'string' ? Date.parse(`${value}T00:00:00.000Z`) : NaN;
    result[key] = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? value : '';
  }
  if (result.from && result.to && result.from > result.to) result.from = result.to = '';
  result.sort = x.sort === 'severity' ? 'severity' : 'openedAt';
  result.direction = x.direction === 'asc' ? 'asc' : 'desc';
  result.pageSize = (x.pageSize === 50 || x.pageSize === '50') ? 50 : 25;
  result.page = Number.isSafeInteger(x.page) && x.page > 0 ? x.page : 1;
  return result;
}
export function addressIntent(params) {
  const input = {};
  for (const key of Object.keys(defaults)) {
    const entries = params.getAll(key);
    if (key in values) input[key] = entries;
    else if (entries.length === 1) input[key] = key === 'page' ? (/^[1-9]\d*$/.test(entries[0]) ? Number(entries[0]) : 1) : entries[0];
  }
  return normalizeIntent(input);
}
export function savedView(intent) {
  const {page, ...view} = normalizeIntent(intent);
  return view;
}
export function queryParams(intent, {pagination = true} = {}) {
  const x = normalizeIntent(intent), params = new URLSearchParams();
  for (const key of ['q', 'from', 'to']) if (x[key]) params.set(key, x[key]);
  for (const key of Object.keys(values)) for (const value of x[key]) params.append(key, value);
  params.set('sort', x.sort); params.set('direction', x.direction);
  if (pagination) { params.set('page', x.page); params.set('pageSize', x.pageSize); }
  return params;
}
export function overviewSelection(intent) {
  const x = normalizeIntent(intent);
  return Object.fromEntries(['q', 'service', 'status', 'severity', 'from', 'to'].map(key => [key, x[key]]));
}
export const overviewIdentity = intent => JSON.stringify(overviewSelection(intent));
export const isOverviewCurrent = state => !!state.overview && overviewIdentity(state.intent) === state.overview.identity;
const operation = token => ({token, pending: false, error: null});
const emptyDetail = token => ({...operation(token), id: null, data: null});
export function createState() {
  return {intent: normalizeIntent(), result: null, overview: null, overviewOp: operation(0), resultOp: operation(0), detail: emptyDetail(0), exportOp: operation(0)};
}
export function isResultCurrent(state) {
  return !!state.result && JSON.stringify(state.intent) === JSON.stringify(state.result.intent);
}
export function canPaginate(state) {
  return !state.resultOp.pending && isResultCurrent(state) && state.result.data.totalPages > 0;
}
function changeIntent(state, intent, force = true, supersedeOverview = false) {
  if (!force && JSON.stringify(intent) === JSON.stringify(state.intent)) return state;
  return {...state, intent, overviewOp: supersedeOverview || overviewIdentity(intent) !== overviewIdentity(state.intent) ? operation(state.overviewOp.token + 1) : state.overviewOp, resultOp: operation(state.resultOp.token + 1), detail: emptyDetail(state.detail.token + 1), exportOp: operation(state.exportOp.token + 1)};
}
export function transition(state, event) {
  switch (event.type) {
    case 'intent': return changeIntent(state, normalizeIntent({...state.intent, ...event.patch, page: 1}), false);
    case 'address': return changeIntent(state, normalizeIntent(event.intent), true, true);
    case 'restore': return changeIntent(state, normalizeIntent({...event.view, page: 1}), true, true);
    case 'page': {
      if (!canPaginate(state) || !Number.isSafeInteger(event.delta)) return state;
      const page = Math.max(1, Math.min(state.result.data.totalPages, state.intent.page + event.delta));
      return page === state.intent.page ? state : changeIntent(state, {...state.intent, page});
    }
    case 'overview:start': return {...state, overviewOp: {...operation(state.overviewOp.token + 1), pending: true}};
    case 'overview:success':
      if (event.token !== state.overviewOp.token || !state.overviewOp.pending) return state;
      return {...state, overview: {identity: overviewIdentity(state.intent), selection: overviewSelection(state.intent), data: event.data}, overviewOp: operation(event.token)};
    case 'overview:failure':
      if (event.token !== state.overviewOp.token || !state.overviewOp.pending) return state;
      return {...state, overviewOp: {...operation(event.token), error: event.error}};
    case 'overview:finish':
      if (event.token !== state.overviewOp.token) return state;
      return {...state, overviewOp: {...state.overviewOp, pending: false}};
    case 'result:start': return {...state, resultOp: {...operation(state.resultOp.token + 1), pending: true}};
    case 'result:success': {
      if (event.token !== state.resultOp.token || !state.resultOp.pending) return state;
      const intent = {...state.intent, page: event.data.page};
      return {...state, intent, result: {intent, data: event.data}, resultOp: operation(event.token)};
    }
    case 'result:failure':
      if (event.token !== state.resultOp.token || !state.resultOp.pending) return state;
      return {...state, resultOp: {...operation(event.token), error: event.error}};
    case 'result:finish':
      if (event.token !== state.resultOp.token) return state;
      return {...state, resultOp: {...state.resultOp, pending: false}};
    case 'detail:select': return {...state, detail: {...emptyDetail(state.detail.token + 1), id: event.id}};
    case 'detail:close': return {...state, detail: emptyDetail(state.detail.token + 1)};
    case 'detail:start':
      if (!state.detail.id) return state;
      return {...state, detail: {...state.detail, token: state.detail.token + 1, pending: true, error: null, data: null}};
    case 'detail:success':
    case 'detail:failure':
      if (event.token !== state.detail.token || !state.detail.pending || !state.detail.id || (event.type === 'detail:success' && event.data.id !== state.detail.id)) return state;
      return {...state, detail: {...state.detail, pending: false, data: event.type === 'detail:success' ? event.data : null, error: event.type === 'detail:failure' ? event.error : null}};
    case 'detail:finish':
      if (event.token !== state.detail.token) return state;
      return {...state, detail: {...state.detail, pending: false}};
    case 'export:start': return {...state, exportOp: {...operation(state.exportOp.token + 1), pending: true}};
    case 'export:success':
    case 'export:failure':
      if (event.token !== state.exportOp.token || !state.exportOp.pending) return state;
      return {...state, exportOp: {...operation(event.token), error: event.type === 'export:failure' ? event.error : null}};
    case 'export:finish':
      if (event.token !== state.exportOp.token) return state;
      return {...state, exportOp: {...state.exportOp, pending: false}};
    default: return state;
  }
}
export function announcement(state) {
  if (state.detail.id) return state.detail.error || (state.detail.pending ? 'Loading incident details.' : state.detail.data ? 'Incident details ready.' : '');
  if (state.resultOp.error) return state.resultOp.error;
  if (state.resultOp.pending) return state.result ? 'Loading results. Previous results are shown.' : 'Loading results.';
  if (state.overviewOp.error) return `Service overview: ${state.overviewOp.error}`;
  if (state.overviewOp.pending) return 'Loading service overview for current selections.';
  if (state.exportOp.error) return state.exportOp.error;
  if (state.exportOp.pending) return 'Preparing CSV download.';
  return isResultCurrent(state) ? `${state.result.data.total} matching incidents.` : '';
}
