import test from 'node:test';
import assert from 'node:assert/strict';
import {createTriage, triageStorageKey} from '../../public/triage.js';

const incident = (id = 'INC-000001') => ({id, title: 'Investigate <sample>', service: 'Billing', severity: 'high', status: 'open', description: 'Canonical details are not stored'});
function storage(raw = null) {
  return {raw, getItem(key) { assert.equal(key, triageStorageKey); return this.raw; }, setItem(key, value) { assert.equal(key, triageStorageKey); this.raw = value; }};
}

test('membership is insertion ordered, duplicate adds preserve recognition and literal notes, removal deletes both', () => {
  const store = storage(), model = createTriage(store);
  assert.equal(model.add(incident()), true);
  const note = '<script>alert("text")</script> & punctuation\nsecond line';
  assert.equal(model.edit('INC-000001', note), true);
  model.add(incident('INC-000002'));
  assert.equal(model.add({...incident(), title: 'Changed canonical title'}), false);
  assert.deepEqual(model.entries.map(value => value.id), ['INC-000001', 'INC-000002']);
  assert.equal(model.entries[0].title, 'Investigate <sample>');
  assert.equal(model.entries[0].note, note);
  assert.equal('description' in model.entries[0], false);
  const hydrated = createTriage(store);
  assert.deepEqual(hydrated.entries, model.entries);
  hydrated.remove('INC-000001');
  assert.equal(hydrated.edit('INC-000001', 'late edit'), false);
  hydrated.add(incident());
  assert.deepEqual(hydrated.entries.map(value => value.id), ['INC-000002', 'INC-000001']);
  assert.equal(hydrated.entries[1].note, '');
  assert.equal(createTriage(store).entries[1].note, '');
});

test('malformed hydration reports the limitation without partial or poisoned membership', () => {
  const good = {...incident(), note: 'saved'};
  for (const raw of ['{', 'null', '[]', JSON.stringify({version: 2, entries: []}), JSON.stringify({version: 1, entries: [good, good]}), JSON.stringify({version: 1, entries: [good, {...good, id: 'second', note: 5}]}), JSON.stringify({version: 1, entries: [{...good, service: 'Unknown'}]})]) {
    const store = storage(raw), model = createTriage(store);
    assert.deepEqual(model.entries, []);
    assert.match(model.message, /malformed/);
    assert.equal(model.add(incident()), true);
    assert.deepEqual(createTriage(store).entries, model.entries);
    assert.match(model.message, /saved/);
  }
});

test('read and write storage failures preserve usable in-memory additions, edits and removals', () => {
  const model = createTriage({getItem() { throw new Error('blocked'); }, setItem() { throw new Error('quota'); }});
  assert.match(model.message, /only for this visit/);
  model.add(incident()); model.add(incident('INC-000002'));
  model.edit('INC-000001', '<b>literal</b>');
  assert.equal(model.entries[0].note, '<b>literal</b>');
  model.remove('INC-000002');
  assert.deepEqual(model.entries.map(value => value.id), ['INC-000001']);
  assert.match(model.message, /only for this visit/);
  model.remove('INC-000001');
  assert.deepEqual(model.entries, []);
});

test('hydrated notes remain usable on failed edits and persistence can recover', () => {
  const store = storage(), original = createTriage(store);
  original.add(incident()); original.edit('INC-000001', 'previous');
  const model = createTriage(store), save = store.setItem;
  store.setItem = () => { throw new Error('quota'); };
  model.edit('INC-000001', 'current unsaved');
  assert.equal(model.entries[0].note, 'current unsaved');
  assert.equal(createTriage(storage(store.raw)).entries[0].note, 'previous');
  store.setItem = save;
  model.add(incident('INC-000002'));
  assert.equal(createTriage(store).entries[0].note, 'current unsaved');
  assert.match(model.message, /saved/);
});

test('invalid input and obsolete edits cannot create or recreate membership', () => {
  const model = createTriage(storage());
  for (const value of [null, {}, {...incident(), id: ''}, {...incident(), status: 'bad'}]) assert.equal(model.add(value), false);
  assert.equal(model.edit('absent', 'note'), false);
  model.add(incident());
  assert.equal(model.edit('INC-000001', null), false);
  model.remove('INC-000001');
  assert.equal(model.edit('INC-000001', 'late editor event'), false);
  assert.equal(model.remove('INC-000001'), false);
  assert.deepEqual(model.entries, []);
});
