const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { client, source } = require('./helpers.cjs');

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));

test('API forwards arguments and turns failure callbacks into rejected promises', async () => {
  const { context, handlers } = client();
  handlers.echo = (...args) => args;
  assert.deepEqual(await context.callServer('echo', 'id', 123, null), ['id', 123, null]);
  handlers.echo = () => { throw new Error('permission denied'); };
  await assert.rejects(context.callServer('echo'), /permission denied/);
});

test('the latest dashboard response wins, even when requests finish in reverse order', async () => {
  const { context } = client();
  const first = deferred(), second = deferred();
  let calls = 0;
  context.callServer = () => (++calls === 1 ? first.promise : second.promise);
  const oldRequest = context.refreshDashboard();
  const newRequest = context.refreshDashboard();
  second.resolve({ status: { active: false }, events: [], titles: ['new'] });
  assert.equal(await newRequest, true);
  first.resolve({ status: { active: true }, events: [], titles: ['old'] });
  assert.equal(await oldRequest, false);
  assert.equal(context.appState.titles[0], 'new');
  assert.equal(context.appState.status.active, false);
  assert.equal(context.appState.loading, false);
});

test('failed initial load shows retry and a successful retry enables actions', async () => {
  const { context, handlers, fields, result } = client();
  context.appState.status = null;
  fields.titleInput.value = 'work';
  handlers.getDashboard = () => { throw new Error('offline'); };
  assert.equal(await context.refreshDashboard(), false);
  assert.equal(fields.retryLoadBtn.hidden, false);
  assert.equal(fields.startBtn.disabled, true);
  assert.match(result.messages[0].message, /offline/);
  handlers.getDashboard = () => ({ status: { active: false }, events: [], titles: [] });
  assert.equal(await context.refreshDashboard(), true);
  assert.equal(fields.retryLoadBtn.hidden, true);
  assert.equal(fields.startBtn.disabled, false);
});

test('double start is blocked during confirmation and during the server request', async () => {
  const { context, fields, handlers, result } = client();
  fields.titleInput.value = 'work';
  fields.descriptionInput.value = 'memo';
  const confirm = deferred(), request = deferred();
  let confirmations = 0;
  context.showConfirm = () => { confirmations++; return confirm.promise; };
  handlers.startActivity = () => request.promise;
  const first = context.handleStart();
  await context.handleStart();
  assert.equal(confirmations, 1);
  assert.equal(fields.titleInput.disabled, true);
  confirm.resolve(true);
  await tick();
  await context.handleStart();
  assert.equal(result.calls.filter(call => call.method === 'startActivity').length, 1);
  request.resolve({ active: true, title: 'work', startTime: Date.now(), eventId: 'id' });
  await first;
  assert.equal(context.appState.busy, false);
  assert.equal(fields.titleInput.value, '');
  assert.equal(fields.descriptionInput.value, '');
});

test('start failure preserves input and releases the lock for retry', async () => {
  const { context, handlers, fields, result } = client();
  fields.titleInput.value = 'work';
  fields.descriptionInput.value = 'memo';
  fields.imageInput.files = [{ name: 'photo.png', size: 100 }];
  handlers.startActivity = () => { throw new Error('offline'); };
  await context.handleStart();
  assert.equal(fields.titleInput.value, 'work');
  assert.equal(fields.descriptionInput.value, 'memo');
  assert.equal(fields.imageInput.files[0].name, 'photo.png');
  assert.equal(context.appState.busy, false);
  assert.equal(fields.startBtn.disabled, false);
  assert.match(result.messages.at(-1).message, /offline/);
});

test('cancelled confirmation does not send a mutation and unlocks controls', async () => {
  const { context, fields, result } = client();
  fields.titleInput.value = 'work';
  context.showConfirm = async () => false;
  await context.handleStart();
  assert.equal(result.calls.length, 0);
  assert.equal(fields.titleInput.value, 'work');
  assert.equal(context.appState.busy, false);
});

test('finish failure retains its date and the active status', async () => {
  const { context, handlers, input } = client();
  context.appState.status = { active: true, title: 'work', startTime: 1000 };
  input.value = '2026-09-24T00:20';
  handlers.finishActivity = () => { throw new Error('offline'); };
  await context.handleFinish();
  assert.equal(input.value, '2026-09-24T00:20');
  assert.equal(context.appState.status.active, true);
  assert.equal(context.appState.busy, false);
});

test('date helpers reject malformed and nonexistent dates and invalid ranges', () => {
  const { context } = client();
  for (const value of ['', '2026-02-30T12:00', '2026-09-23T24:01', '2026-09-23']) {
    assert.throws(() => context.DateTime.parseLocal(value));
  }
  assert.throws(() => context.DateTime.timeOnDate(Date.now(), '25:00'));
  assert.throws(() => context.DateTime.validateRange(2000, 1000));
  assert.equal(context.DateTime.parseLocal('2028-02-29T12:00'), new Date(2028, 1, 29, 12).getTime());
});

test('finish before or at the start keeps the input and does not ask for confirmation', async () => {
  for (const value of ['2026-09-23T09:59', '2026-09-23T10:00']) {
    const { context, input, result } = client();
    context.appState.status = { active: true, startTime: new Date(2026, 8, 23, 10).getTime() };
    input.value = value;
    await context.handleFinish();
    assert.equal(result.calls.length, 0);
    assert.equal(result.confirmation, undefined);
    assert.equal(input.value, value);
    assert.equal(context.appState.status.active, true);
    assert.equal(context.appState.busy, false);
    assert.match(result.messages.at(-1).message, /終了時刻は開始時刻より後/);
  }
});

test('editing only a title preserves seconds for short and overnight records', async () => {
  for (const [start, end] of [
    [new Date(2026, 8, 23, 10, 0, 10, 123).getTime(), new Date(2026, 8, 23, 10, 0, 40, 456).getTime()],
    [new Date(2026, 8, 22, 23, 59, 30).getTime(), new Date(2026, 8, 23, 0, 0, 20).getTime()]
  ]) {
    const { context, handlers, result } = client();
    const event = { id: 'id', title: 'work', start, end, active: false };
    context.appState.editingEventId = event.id;
    handlers.updateEvent = () => ({ updated: true });
    const form = context.buildEditForm(event);
    form.querySelector('.edit-title').value = 'new title';
    await form.querySelector('.edit-save').emit('click');
    const update = result.calls.find(call => call.method === 'updateEvent');
    assert.ok(update);
    assert.deepEqual(update.args, ['id', 'new title', '', '', start, end]);
    assert.equal(context.appState.editingEventId, null);
  }
});

test('changing an edit time keeps its date and resets seconds', () => {
  const { context } = client();
  const original = new Date(2026, 8, 22, 23, 58, 30, 123).getTime();
  assert.equal(context.DateTime.timeOnDate(original, '23:59'), new Date(2026, 8, 22, 23, 59).getTime());
});

test('edit validation prevents server calls, and drafts survive a refresh', async () => {
  const { context, result } = client();
  const event = { id: 'id', title: 'work', start: new Date(2026, 8, 23, 10).getTime(),
    end: new Date(2026, 8, 23, 11).getTime(), active: false };
  context.appState.editingEventId = 'id';
  const form = context.buildEditForm(event);
  form.querySelector('.edit-title').value = 'draft';
  await form.querySelector('.edit-title').emit('input');
  form.querySelector('.edit-end').value = '09:00';
  await form.querySelector('.edit-end').emit('input');
  await form.querySelector('.edit-save').emit('click');
  assert.equal(result.calls.length, 0);
  const rebuilt = context.buildEditForm(event);
  assert.equal(rebuilt.querySelector('.edit-title').value, 'draft');
  assert.equal(rebuilt.querySelector('.edit-end').value, '09:00');
});

test('attachment failure keeps the edit draft and file available for retry', async () => {
  const { context, handlers } = client();
  const event = { id: 'id', title: 'work', start: new Date(2026, 8, 23, 10).getTime(),
    end: new Date(2026, 8, 23, 11).getTime(), active: false };
  context.appState.editingEventId = 'id';
  handlers.updateEvent = () => ({ updated: true });
  handlers.attachImageToEvent = () => { throw new Error('upload failed'); };
  handlers.getDashboard = () => ({ status: { active: false }, events: [event], titles: [] });
  context.readImage = async () => 'base64';
  const form = context.buildEditForm(event);
  const file = { name: 'photo.png', size: 100, type: 'image/png' };
  form.querySelector('.edit-image').files = [file];
  await form.querySelector('.edit-image').emit('change');
  await form.querySelector('.edit-save').emit('click');
  assert.equal(context.appState.editingEventId, 'id');
  assert.equal(context.appState.editDraft.file, file);
  assert.equal(context.buildEditForm(event).querySelector('.edit-image-name').textContent, 'photo.png');
});

test('deleting an edited event clears the editor and refreshes all view state', async () => {
  const { context, handlers, result } = client();
  const event = { id: 'id', title: 'work', start: 1000, end: 61000, active: true };
  context.appState.editingEventId = 'id';
  handlers.deleteEvent = () => ({ deleted: true });
  const form = context.buildEditForm(event);
  await form.querySelector('.edit-delete').emit('click');
  assert.equal(context.appState.editingEventId, null);
  assert.equal(context.appState.editDraft, null);
  assert.deepEqual(result.calls.map(call => call.method), ['deleteEvent', 'getDashboard']);
});

test('templates include every client module in order and compile without a build step', () => {
  const includes = [...source('Index.html').matchAll(/<\?!= include_\('([^']+)'\); \?>/g)].map(match => match[1]);
  assert.deepEqual(includes, ['Styles', 'DateTime', 'Api', 'State', 'App']);
  const rendered = source('Index.html').replace(/<\?!= include_\('([^']+)'\); \?>/g, (_, name) => source(name + '.html'));
  for (const match of rendered.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new vm.Script(match[1]));
  }
  assert.equal([...rendered.matchAll(/<style>/g)].length, 1);
});
