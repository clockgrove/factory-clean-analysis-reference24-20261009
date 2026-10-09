// Personal metadata stays in this browser; canonical details are fetched separately.
export const triageStorageKey = 'incident-explorer.triage.v1';
const fields = ['id', 'title', 'service', 'severity', 'status'];
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const visitOnly = 'Browser storage is unavailable. Your triage list and notes will last only for this visit.';

function validRecognition(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && fields.every(key => typeof value[key] === 'string' && value[key].length > 0)
    && services.includes(value.service) && severities.includes(value.severity) && statuses.includes(value.status);
}
function entry(value, note = '') {
  return {...Object.fromEntries(fields.map(key => [key, value[key]])), note};
}
function hydrate(raw) {
  const value = JSON.parse(raw);
  if (!value || value.version !== 1 || !Array.isArray(value.entries)) throw new Error('Invalid triage structure');
  const ids = new Set();
  return value.entries.map(value => {
    if (!validRecognition(value) || typeof value.note !== 'string' || ids.has(value.id)) throw new Error('Invalid triage entry');
    ids.add(value.id);
    return entry(value, value.note);
  });
}

export function createTriage(storage) {
  let entries = [], message = '';
  let raw;
  try { raw = storage.getItem(triageStorageKey); }
  catch { message = visitOnly; }
  if (raw !== null && raw !== undefined) {
    try { entries = hydrate(raw); }
    catch { message = 'Stored triage data is malformed and could not be loaded. You can start a new list for this visit.'; }
  }
  function persist() {
    try {
      storage.setItem(triageStorageKey, JSON.stringify({version: 1, entries}));
      message = 'Triage list and notes saved in this browser.';
    } catch { message = visitOnly; }
  }
  return {
    get entries() { return entries; },
    get message() { return message; },
    add(detail) {
      if (!validRecognition(detail) || entries.some(value => value.id === detail.id)) return false;
      entries = [...entries, entry(detail)];
      persist();
      return true;
    },
    edit(id, note) {
      if (typeof note !== 'string' || !entries.some(value => value.id === id && value.note !== note)) return false;
      entries = entries.map(value => value.id === id ? {...value, note} : value);
      persist();
      return true;
    },
    remove(id) {
      if (!entries.some(value => value.id === id)) return false;
      entries = entries.filter(value => value.id !== id);
      persist();
      return true;
    }
  };
}
