const assert = require('node:assert/strict');
const vm = require('node:vm');
const { test } = require('node:test');
const { source, client } = require('./helpers.cjs');
const LockService = { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }) };

test('開始時刻は5分単位で切り捨て、前のタスクも同じ時刻で終了する', () => {
  for (const [now, expected] of [
    ['2026-09-23T10:01:00+09:00', '2026-09-23T10:00:00+09:00'],
    ['2026-09-23T10:05:00+09:00', '2026-09-23T10:05:00+09:00'],
    ['2026-09-23T10:05:00.001+09:00', '2026-09-23T10:05:00+09:00'],
    ['2026-12-31T23:59:59+09:00', '2026-12-31T23:55:00+09:00']
  ]) {
    class FixedDate extends Date {
      constructor(...args) { super(...(args.length ? args : [Date.parse(now)])); }
      static now() { return Date.parse(now); }
    }
    const context = vm.createContext({ Date: FixedDate, LockService });
    vm.runInContext(source('DateValidation.gs'), context);
    vm.runInContext(source('Code.gs'), context);
    let currentId = '前の記録';
    let previousEnd;
    let created;
    context.PropertiesService = { getUserProperties: () => ({
      getProperty: () => currentId,
      deleteProperty: () => { currentId = null; },
      setProperty: (_, value) => { currentId = value; }
    }) };
    context.cachedCalendar_ = {
      getEventById: () => ({
        getStartTime: () => new Date(Date.parse(now) - 600000),
        getEndTime: () => new Date(Date.parse(now) - 300000),
        setTime: (_, end) => { previousEnd = end.getTime(); }
      }),
      createEvent: (title, start, end, options) => {
        created = { title, start: start.getTime(), end: end.getTime(), ...options };
        return { getId: () => '新しい記録' };
      }
    };
    const result = context.startActivity(' 作業 ', ' 事務所 ', ' メモ ', '前の記録');
    const expectedStart = Date.parse(expected);
    assert.deepEqual(created, { title: '作業', start: expectedStart,
      end: expectedStart + 300000, location: '事務所', description: 'メモ' });
    assert.equal(result.startTime, expectedStart);
    assert.equal(result.eventId, '新しい記録');
    assert.equal(previousEnd, expectedStart);
    assert.equal(currentId, '新しい記録');
  }
});

test('時間を加算して翌日になった場合も送信まで日付を保持する', async () => {
  const { context, input, result } = client(new Date(2026, 8, 23, 23, 50).getTime());
  context.finishWithOffset(30);
  assert.equal(input.value, '2026-09-24T00:20');
  context.finishWithOffset(60);
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 8, 24, 1, 20).getTime());
  assert.match(result.confirmation, /2026-09-24 01:20/);
});

test('年をまたぐ時間の減算でも前年の日付を保持する', async () => {
  const { context, input, result } = client(new Date(2027, 0, 1, 0, 10).getTime());
  context.appState.offsetSign = -1;
  context.finishWithOffset(30);
  assert.equal(input.value, '2026-12-31T23:40');
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 11, 31, 23, 40).getTime());
});

test('現在時刻ボタンの切り上げで翌日になった場合も日付を保持する', async () => {
  const { context, input, result } = client(new Date(2026, 8, 30, 23, 58).getTime());
  context.setFinishTimeToNow();
  assert.equal(input.value, '2026-10-01T00:00');
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 9, 1).getTime());
});

test('終了日時の直接指定と未入力の両方を受け付ける', async () => {
  const { context, input, result } = client(new Date(2026, 8, 23).getTime());
  input.value = '2026-09-22T23:55';
  await context.handleFinish();
  assert.equal(result.end, new Date(2026, 8, 22, 23, 55).getTime());
  input.value = '';
  await context.handleFinish();
  assert.equal(result.end, null);
});

function server() {
  const context = vm.createContext({ LockService });
  vm.runInContext(source('DateValidation.gs'), context);
  vm.runInContext(source('Code.gs'), context);
  const changes = [];
  context.cachedCalendar_ = { getEventById: () => ({
    getEndTime: () => new Date(5000),
    setTime: (start, end) => changes.push(['日時', start.getTime(), end.getTime()]),
    setTitle: value => changes.push(['内容', value]),
    setLocation: value => changes.push(['場所', value]),
    setDescription: value => changes.push(['説明', value])
  }) };
  return { context, changes };
}

test('不正な編集では記録の全項目を変更しない', () => {
  for (const [start, end] of [[2000, 1000], [2000, 2000], ['不正な値', 5000],
    [1000, '不正な値'], [null, 5000], ['', 5000], [undefined, 5000]]) {
    const { context, changes } = server();
    assert.throws(() => context.updateEvent('id', '新しい記録', '新しい記録', '新しい記録', start, end));
    assert.deepEqual(changes, []);
  }
});

test('有効な編集では日時と内容を更新する', () => {
  const { context, changes } = server();
  context.updateEvent('id', ' 内容 ', ' 場所 ', ' 説明 ', 1000, 3000);
  assert.deepEqual(changes, [
    ['日時', 1000, 3000], ['内容', '内容'], ['場所', '場所'], ['説明', '説明']
  ]);
});

test('進行中の編集では終了日時を保持するか、新しい開始日時より後に延長する', () => {
  for (const [start, expectedEnd] of [[1000, 5000], [6000, 66000]]) {
    const { context, changes } = server();
    context.updateEvent('id', '内容', '', '', start, null);
    assert.deepEqual(changes[0], ['日時', start, expectedEnd]);
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

test('不正な終了日時を指定しても記録を変更せず、進行中の状態を保持する', () => {
  for (const end of [1000, 2000, NaN, Infinity, '3000']) {
    const { context, changes, currentId } = finishServer();
    assert.throws(() => context.finishActivity(end, 'id'));
    assert.deepEqual(changes, []);
    assert.equal(currentId(), 'id');
  }
});

test('有効な終了日時の指定ではその日時で終了し、進行中の状態を解除する', () => {
  const { context, changes, currentId } = finishServer();
  assert.equal(context.finishActivity(3000, 'id').active, false);
  assert.deepEqual(changes, [[2000, 3000]]);
  assert.equal(currentId(), null);
});

test('終了時刻の既定値は5分単位で切り上げ、境界時刻と年越しも正しく扱う', () => {
  for (const [now, expected] of [
    ['2026-09-23T10:01:00+09:00', '2026-09-23T10:05:00+09:00'],
    ['2026-09-23T10:05:00+09:00', '2026-09-23T10:05:00+09:00'],
    ['2026-09-23T10:05:00.001+09:00', '2026-09-23T10:10:00+09:00'],
    ['2026-12-31T23:59:59+09:00', '2027-01-01T00:00:00+09:00']
  ]) {
    for (const value of [null, undefined]) {
      const { context, changes, currentId } = finishServer();
      context.Date = class extends Date {
        static now() { return Date.parse(now); }
      };
      context.finishActivity(value, 'id');
      assert.deepEqual(changes, [[2000, Date.parse(expected)]]);
      assert.equal(currentId(), null);
    }
  }
});

test('未入力からの時間加減算は切り上げた終了時刻の既定値を基準にする', () => {
  const { context, input } = client(new Date(2026, 11, 31, 23, 58).getTime());
  context.finishWithOffset(5);
  assert.equal(input.value, '2027-01-01T00:05');
});

test('開始直後の記録でも自動終了時は最低限の長さを確保する', () => {
  const { context, changes, currentId } = finishServer();
  context.closeCurrentEvent_(new Date(2000));
  assert.deepEqual(changes, [[2000, 62000]]);
  assert.equal(currentId(), null);
});

test('前の作業の終了日時を指定して開始でき、不正な指定では記録を変更しない', () => {
  const now = Date.parse('2026-09-23T15:03:00+09:00');
  const previousStart = Date.parse('2026-09-23T09:00:00+09:00');
  function setup() {
    class FixedDate extends Date {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    }
    const context = vm.createContext({ Date: FixedDate, LockService });
    vm.runInContext(source('DateValidation.gs'), context);
    vm.runInContext(source('Code.gs'), context);
    const state = { currentId: '前の記録', previousEnd: null, created: 0 };
    context.PropertiesService = { getUserProperties: () => ({
      getProperty: () => state.currentId,
      deleteProperty: () => { state.currentId = null; },
      setProperty: (_, value) => { state.currentId = value; }
    }) };
    context.cachedCalendar_ = {
      getEventById: () => ({
        getStartTime: () => new Date(previousStart),
        getEndTime: () => new Date(previousStart + 300000),
        setTime: (_, end) => { state.previousEnd = end.getTime(); }
      }),
      createEvent: () => { state.created++; return { getId: () => '新しい記録' }; }
    };
    return { context, state };
  }

  const { context, state } = setup();
  const lunch = Date.parse('2026-09-23T12:00:00+09:00');
  context.startActivity('作業', '', '', '前の記録', lunch);
  assert.equal(state.previousEnd, lunch);
  assert.equal(state.currentId, '新しい記録');

  for (const [end, message] of [
    [Date.parse('2026-09-23T15:05:00+09:00'), /新しい開始時刻以前/],
    [previousStart, /終了時刻は開始時刻より後/]
  ]) {
    const { context, state } = setup();
    assert.throws(() => context.startActivity('作業', '', '', '前の記録', end), message);
    assert.equal(state.created, 0);
    assert.equal(state.previousEnd, null);
    assert.equal(state.currentId, '前の記録');
  }
});
