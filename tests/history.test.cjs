const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const { source, client } = require('./helpers.cjs');

test('日本時間の日付境界と月・年・うるう年をまたぐ日付移動を扱う', () => {
  const { context } = client();
  const rules = context.DateRules;
  assert.equal(rules.calendarDate(Date.parse('2026-09-22T15:00:00Z')), '2026-09-23');
  assert.equal(rules.shiftDay('2027-01-01', -1), '2026-12-31');
  assert.equal(rules.shiftDay('2028-03-01', -1), '2028-02-29');
  assert.equal(rules.shiftDay('2026-09-30', 1), '2026-10-01');
  for (const value of ['2026-02-29', '2026-13-01', '', '2026-9-1', null]) assert.throws(() => rules.dayRange(value));
});

test('過去の日付で取得範囲を指定し、仮終了が前日でも進行中の作業を含める', () => {
  const now = Date.parse('2026-09-23T10:03:00+09:00');
  class FixedDate extends Date { static now() { return now; } }
  const context = vm.createContext({ Date: FixedDate,
    LockService: { getUserLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    PropertiesService: { getUserProperties: () => ({ getProperty: () => '継続中' }) }
  });
  vm.runInContext(source('DateValidation.gs') + '\n' + source('Code.gs'), context);
  function event(id, start, end) {
    return { getId: () => id, getTitle: () => '作業', getLocation: () => '', getDescription: () => '',
      getStartTime: () => new Date(start), getEndTime: () => new Date(end) };
  }
  const active = event('継続中', '2026-09-22T23:00:00+09:00', '2026-09-22T23:05:00+09:00');
  const completed = event('終了済み', '2026-09-21T10:00:00+09:00', '2026-09-21T11:00:00+09:00');
  const ranges = [];
  context.cachedCalendar_ = { getEventById: () => active,
    getEvents: (start, end) => { ranges.push([start.getTime(), end.getTime()]); return [completed]; } };
  context.getRecentTitles = () => [];
  const history = context.getDashboard('2026-09-21');
  assert.deepEqual(ranges[0], [Date.parse('2026-09-21T00:00:00+09:00'), Date.parse('2026-09-22T00:00:00+09:00')]);
  assert.deepEqual(Array.from(history.events, item => item.id), ['終了済み']);
  assert.equal(history.status.active, true);
  const today = context.getDashboard();
  assert.equal(today.day.date, '2026-09-23');
  assert.deepEqual(Array.from(today.events, item => item.id), ['継続中']);
  assert.throws(() => context.getDashboard('2026-02-30'), /有効な日付/);
});

test('日をまたぐ記録を選択日内に収め、同じ作業名と進行中の時間を集計する', () => {
  const { context } = client();
  const day = context.DateRules.dayRange('2026-09-23');
  const hour = 3600000;
  const events = [
    { title: '資料作成', start: day.start - hour, end: day.start + hour },
    { title: '資料作成', start: day.start + hour, end: day.start + 2 * hour },
    { title: '__proto__', start: day.start + 23 * hour, end: day.end + hour },
    { title: '進行中の作業', start: day.start + 2 * hour, end: day.start + 2 * hour + 300000, active: true }
  ];
  const summary = context.DateTime.summarize(events, day, day.start + 3 * hour);
  assert.equal(summary.total, 4 * hour);
  assert.equal(summary.items.find(item => item.title === '資料作成').millis, 2 * hour);
  assert.equal(summary.items.find(item => item.title === '__proto__').millis, hour);
  assert.equal(summary.items.find(item => item.title === '進行中の作業').millis, hour);
  assert.equal(context.DateTime.summarize([], day, day.start).total, 0);
  assert.equal(context.DateTime.summarize([{ title: '未来', start: day.end, active: true }], day, day.start).total, 0);
  assert.equal(context.DateTime.formatDuration(59999), '1分未満');
  assert.equal(context.DateTime.formatDuration(3660000), '1時間1分');
});

test('日時編集で年をまたぐ修正を送信し、変更しない秒は保持する', async () => {
  const { context, handlers, result } = client();
  const event = { id: '年越し', title: '作業', start: Date.parse('2026-12-31T23:50:20+09:00'),
    end: Date.parse('2027-01-01T00:10:40+09:00'), active: false };
  handlers.updateEvent = () => ({ updated: true });
  const form = context.buildEditForm(event);
  const newEnd = new Date(event.end + 86400000).getTime();
  form.querySelector('.edit-end').value = context.DateTime.formatLocal(newEnd);
  await form.querySelector('.edit-save').emit('click');
  const update = result.calls.find(call => call.method === 'updateEvent');
  assert.equal(update.args[4], event.start);
  assert.equal(update.args[5], newEnd - 40000);
});

function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
}

test('ページの作り直し後に開始・編集の下書きと日付を復元し、画像本体は保存しない', async () => {
  const saved = storage();
  const first = client();
  first.context.sessionStorage = saved;
  first.context.initDrafts();
  first.fields.titleInput.value = '入力途中';
  first.fields.descriptionInput.value = '保存前のメモ';
  first.fields.imageInput.files = [{ name: '写真.png', size: 100, type: 'image/png' }];
  first.context.appState.selectedDate = '2026-09-22';
  first.context.appState.editDraft = { id: '編集中', title: '変更途中', location: '自宅', description: '説明',
    start: '2026-09-22T09:00', end: '2026-09-22T10:00', file: { name: '編集写真.png' } };
  await first.fields.titleInput.emit('input');
  const second = client();
  second.context.sessionStorage = saved;
  second.context.initDrafts();
  assert.equal(second.fields.titleInput.value, '入力途中');
  assert.equal(second.fields.descriptionInput.value, '保存前のメモ');
  assert.equal(second.context.appState.selectedDate, '2026-09-22');
  assert.equal(second.context.appState.editDraft.title, '変更途中');
  assert.equal(second.context.appState.editDraft.file, null);
  assert.equal(second.context.appState.editDraft.imageName, '編集写真.png');
  assert.match(second.fields.imageDraftHint.textContent, /写真.png.*再選択/);
});

test('終了日時の下書きは同じ進行中の記録だけに復元する', () => {
  for (const eventId of ['前の作業', '新しい作業']) {
    const saved = storage();
    saved.setItem('ima-draft-v1', JSON.stringify({ version: 1, finish: { eventId: '前の作業', value: '2026-09-23T12:00' } }));
    const { context, input } = client();
    context.sessionStorage = saved;
    context.initDrafts();
    context.applyDashboard({ status: { active: true, eventId }, events: [], titles: [] });
    assert.equal(input.value, eventId === '前の作業' ? '2026-09-23T12:00' : '');
  }
});

test('下書きの破損や保存拒否があっても記録を開始できる', async () => {
  for (const saved of [
    { getItem: () => '壊れたデータ', setItem() {} },
    { getItem() { throw new Error('保存先を利用できません'); }, setItem() { throw new Error('保存先を利用できません'); } }
  ]) {
    const { context, fields, handlers, result } = client();
    context.sessionStorage = saved;
    context.initDrafts();
    fields.titleInput.value = '作業';
    await fields.titleInput.emit('input');
    handlers.startActivity = () => ({ active: true, title: '作業', startTime: Date.now(), eventId: '作業' });
    await context.handleStart();
    assert.equal(result.calls.filter(call => call.method === 'startActivity').length, 1);
  }
});

test('日付変更時に下書きの破棄を取り消すと日付と入力を保持する', async () => {
  const { context, result, fields } = client();
  context.appState.selectedDate = '2026-09-23';
  context.appState.editDraft = { id: '作業', title: '変更途中', dirty: true };
  context.showConfirm = async () => false;
  await context.selectRecordDate('2026-09-22');
  assert.equal(context.appState.selectedDate, '2026-09-23');
  assert.equal(fields.recordDateInput.value, '2026-09-23');
  assert.equal(context.appState.editDraft.title, '変更途中');
  assert.equal(result.calls.length, 0);
});
