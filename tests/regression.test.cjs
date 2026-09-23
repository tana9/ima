const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { source, client } = require('./helpers.cjs');

test('positive offsets retain the next date through submission', async () => {
  const { context, input, result } = client(new Date(2026, 8, 23, 23, 50).getTime());
  context.finishWithOffset(30);
  assert.equal(input.value, '2026-09-24T00:20');
  context.finishWithOffset(60);
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 8, 24, 1, 20).getTime());
  assert.match(result.confirmation, /2026-09-24 01:20/);
});

test('negative offsets retain the previous date across a year boundary', async () => {
  const { context, input, result } = client(new Date(2027, 0, 1, 0, 10).getTime());
  context.appState.offsetSign = -1;
  context.finishWithOffset(30);
  assert.equal(input.value, '2026-12-31T23:40');
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 11, 31, 23, 40).getTime());
});

test('now button retains the next date when rounding past midnight', async () => {
  const { context, input, result } = client(new Date(2026, 8, 30, 23, 58).getTime());
  context.setFinishTimeToNow();
  assert.equal(input.value, '2026-10-01T00:00');
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 9, 1).getTime());
});

test('manual dates and empty input are supported', async () => {
  const { context, input, result } = client(new Date(2026, 8, 23).getTime());
  input.value = '2026-09-22T23:55';
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 8, 22, 23, 55).getTime());
  input.value = '';
  await context.handleFinish();
  assert.equal(result.end, null);
});

function server() {
  const context = vm.createContext({});
  vm.runInContext(source('DateValidation.gs'), context);
  vm.runInContext(source('Code.gs'), context);
  const changes = [];
  context.cachedCalendar_ = { getEventById: () => ({
    getEndTime: () => new Date(5000),
    setTime: (start, end) => changes.push(['time', start.getTime(), end.getTime()]),
    setTitle: value => changes.push(['title', value]),
    setLocation: value => changes.push(['location', value]),
    setDescription: value => changes.push(['description', value])
  }) };
  return { context, changes };
}

test('invalid edits leave all event fields unchanged', () => {
  for (const [start, end] of [[2000, 1000], [2000, 2000], ['invalid', 5000],
    [1000, 'invalid'], [null, 5000], ['', 5000], [undefined, 5000]]) {
    const { context, changes } = server();
    assert.throws(() => context.updateEvent('id', 'new', 'new', 'new', start, end));
    assert.deepEqual(changes, []);
  }
});

test('valid edits update time and content', () => {
  const { context, changes } = server();
  context.updateEvent('id', ' title ', ' place ', ' description ', 1000, 3000);
  assert.deepEqual(changes, [
    ['time', 1000, 3000], ['title', 'title'], ['location', 'place'], ['description', 'description']
  ]);
});

test('active edits preserve the end or extend it beyond the new start', () => {
  for (const [start, expectedEnd] of [[1000, 5000], [6000, 66000]]) {
    const { context, changes } = server();
    context.updateEvent('id', 'title', '', '', start, null);
    assert.deepEqual(changes[0], ['time', start, expectedEnd]);
  }
});

function finishServer() {
  const { context, changes } = server();
  let currentId = 'id';
  context.PropertiesService = { getUserProperties: () => ({
    getProperty: () => currentId,
    deleteProperty: () => { currentId = null; }
  }) };
  context.cachedCalendar_ = { getEventById: () => ({
    getStartTime: () => new Date(2000),
    setTime: (start, end) => changes.push([start.getTime(), end.getTime()])
  }) };
  return { context, changes, currentId: () => currentId };
}

test('invalid explicit finish dates do not change the event or clear the active record', () => {
  for (const end of [1000, 2000, NaN, Infinity, '3000']) {
    const { context, changes, currentId } = finishServer();
    assert.throws(() => context.finishActivity(end));
    assert.deepEqual(changes, []);
    assert.equal(currentId(), 'id');
  }
});

test('valid explicit finish uses the requested date and clears the active record', () => {
  const { context, changes, currentId } = finishServer();
  assert.equal(context.finishActivity(3000).active, false);
  assert.deepEqual(changes, [[2000, 3000]]);
  assert.equal(currentId(), null);
});

test('automatic close still gives a just-started event its minimum duration', () => {
  const { context, changes, currentId } = finishServer();
  context.closeCurrentEvent_(new Date(2000));
  assert.deepEqual(changes, [[2000, 62000]]);
  assert.equal(currentId(), null);
});
