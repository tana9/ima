const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { renderPreview, createPreviewServer } = require('../scripts/preview.cjs');
const { script, source } = require('./helpers.cjs');

function previewContext(scenario = 'active') {
  const context = vm.createContext({ location: { search: '?scenario=' + scenario }, URLSearchParams });
  vm.runInContext(source('DateValidation.gs'), context);
  const mock = fs.readFileSync(path.join(__dirname, '../scripts/preview-mock.js'), 'utf8');
  vm.runInContext(mock + script('DateTime.html') + script('Api.html'), context);
  return { context, mock };
}

test('プレビューは本番のテンプレートを展開し、通信より前にモックを読み込む', () => {
  const html = renderPreview();
  assert.doesNotMatch(html, /<\?/);
  assert.doesNotMatch(html, /rel="manifest"/);
  assert.match(html, /ローカルプレビュー/);
  assert.ok(html.indexOf('var google =') < html.indexOf('function callServer'));
  for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
    assert.doesNotThrow(() => new vm.Script(match[1]));
  }
});

test('サンプルデータで開始・編集・終了・削除でき、再読み込みで初期化する', async () => {
  const { context, mock } = previewContext();
  const initial = await context.callServer('getDashboard');
  assert.equal(initial.events.length, 2);
  const started = await context.callServer('startActivity', '試験作業', '会議室', '確認用', initial.status.eventId);
  assert.equal(started.title, '試験作業');
  assert.equal(started.startTime % 300000, 0);
  const snapshot = await context.callServer('getDashboard');
  assert.equal(snapshot.events.filter(event => event.active).length, 1);
  await context.callServer('updateEvent', started.eventId, '修正した作業', '自宅', '修正済み', started.startTime - 60000, null);
  assert.equal((await context.callServer('getDashboard')).status.title, '修正した作業');
  await assert.rejects(context.callServer('finishActivity', started.startTime - 120000, started.eventId), /終了時刻は開始時刻より後/);
  assert.equal((await context.callServer('finishActivity', null, started.eventId)).active, false);
  await assert.rejects(context.callServer('attachImageToEvent', started.eventId), /Driveへの保存は実環境/);
  await context.callServer('deleteEvent', started.eventId);
  assert.equal((await context.callServer('getDashboard')).events.length, 2);
  vm.runInContext(mock, context);
  assert.equal((await context.callServer('getDashboard')).status.title, '資料作成');
});

test('プレビューで空の一覧・長いタイトル・通信エラーからの復旧を確認できる', async () => {
  const empty = await previewContext('empty').context.callServer('getDashboard');
  assert.equal(empty.events.length, 0);
  assert.equal(empty.status.active, false);
  const long = await previewContext('long').context.callServer('getDashboard');
  assert.ok(long.status.title.length > 100);
  const { context } = previewContext('error');
  await assert.rejects(context.callServer('getDashboard'), /通信エラーの見本/);
  assert.equal((await context.callServer('getDashboard')).status.active, true);
});

test('プレビューの編集でも開始時刻より後の既存終了時刻をそのまま保持する', async () => {
  const { context } = previewContext();
  const event = (await context.callServer('getDashboard')).events.find(item => item.active);
  await context.callServer('updateEvent', event.id, '境界の確認', '', '', event.end - 1, null);
  const updated = (await context.callServer('getDashboard')).events.find(item => item.id === event.id);
  assert.equal(updated.end, event.end);
});

test('ソースの保存で更新識別子と配信HTMLが変わる', async t => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-preview-'));
  fs.cpSync(path.join(__dirname, '../src'), sourceRoot, { recursive: true });
  const server = createPreviewServer({ sourceRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  });
  const url = 'http://127.0.0.1:' + server.address().port;
  const before = await (await fetch(url + '/__preview/revision')).json();
  const file = path.join(sourceRoot, 'Index.html');
  fs.appendFileSync(file, '\n<!-- 保存した変更 -->');
  const after = await (await fetch(url + '/__preview/revision')).json();
  assert.notEqual(after.revision, before.revision);
  assert.match(await (await fetch(url + '/?scenario=empty')).text(), /保存した変更/);
});

test('プレビューサーバーはHTMLを配信し、任意のファイルを公開しない', async t => {
  const server = createPreviewServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(await response.text(), /ローカルプレビュー/);
  assert.equal((await fetch(url + '/.clasp.json')).status, 404);
  assert.equal((await fetch(url, { method: 'POST' })).status, 404);
});
