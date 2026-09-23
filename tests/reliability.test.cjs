const assert = require('node:assert/strict');
const { test } = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { source } = require('./helpers.cjs');

function server() {
  const state = { locked: false, releases: 0, current: '前の記録', events: new Map(), files: [], attachments: [], patches: 0 };
  function event(id, start, end) {
    const record = { id, start, end, getId: () => id,
      getStartTime: () => new Date(record.start), getEndTime: () => new Date(record.end),
      getTitle: () => '作業', getLocation: () => '', getDescription: () => '',
      setTime(start, end) {
        assert.equal(state.locked, true);
        record.start = start.getTime(); record.end = end.getTime();
        if (state.failClose) { state.failClose = false; throw new Error('終了に失敗しました'); }
      },
      deleteEvent() { state.events.delete(id); }
    };
    state.events.set(id, record);
    return record;
  }
  event('前の記録', 1000, 301000);
  const props = {
    getProperty: () => state.current,
    setProperty(_, id) {
      state.current = id;
      if (state.failProperty) { state.failProperty = false; throw new Error('状態保存に失敗しました'); }
    },
    deleteProperty: () => { state.current = null; }
  };
  const context = vm.createContext({
    LockService: { getUserLock: () => ({
      tryLock() { if (state.locked || state.refuseLock) return false; state.locked = true; return true; },
      releaseLock() { state.locked = false; state.releases++; }
    }) },
    PropertiesService: { getUserProperties: () => props },
    Utilities: {
      base64Decode: value => Array.from(Buffer.from(value, 'base64')),
      newBlob: (bytes, mimeType, name) => ({ bytes, mimeType, name }),
      DigestAlgorithm: { SHA_256: 'sha256' },
      computeDigest: (algorithm, value) => Array.from(crypto.createHash(algorithm).update(value).digest())
    },
    DriveApp: { Access: { ANYONE_WITH_LINK: 'リンク共有' }, Permission: { VIEW: '閲覧' } },
    Calendar: { Events: {
      get() {
        assert.equal(state.locked, true);
        if (state.failRead) throw new Error('予定を取得できません');
        return { attachments: state.attachments.slice() };
      },
      patch(record) {
        state.patches++;
        assert.deepEqual(Object.keys(record), ['attachments']);
        if (state.failPatch) {
          if (state.failVerification) state.failRead = true;
          throw new Error('添付に失敗しました');
        }
        state.attachments = record.attachments;
        if (state.lostResponse) throw new Error('応答を受信できません');
      }
    } }
  });
  vm.runInContext(source('DateValidation.gs') + '\n' + source('Code.gs'), context);
  context.cachedCalendar_ = {
    getId: () => '専用カレンダー', getEventById: id => state.events.get(id),
    createEvent(_, start, end) {
      assert.equal(state.locked, true);
      if (state.failCreate) throw new Error('作成に失敗しました');
      if (state.onCreate) state.onCreate();
      return event('新しい記録', start.getTime(), end.getTime());
    }
  };
  context.cachedFolder_ = {
    getFilesByName(name) {
      const found = state.files.filter(file => file.name === name);
      return { hasNext: () => found.length > 0, next: () => found.shift() };
    },
    createFile(blob) {
      const id = '画像' + state.files.length;
      const file = { name: blob.name, getId: () => id, getUrl: () => 'https://example.invalid/' + id,
        isTrashed: () => !!file.trashed,
        setSharing() { if (state.failSharing) throw new Error('共有に失敗しました'); },
        setTrashed(value) { file.trashed = value; }
      };
      state.files.push(file);
      return file;
    }
  };
  return { context, state };
}

test('別タブの開始と古い画面からの終了を拒否し、進行中の記録を守る', () => {
  const { context, state } = server();
  state.onCreate = () => assert.throws(() => context.startActivity('別タブ', '', '', '前の記録'), /別の操作/);
  context.startActivity('新しい作業', '', '', '前の記録');
  assert.equal(state.current, '新しい記録');
  assert.throws(() => context.finishActivity(null, '前の記録'), /進行中の作業が変更/);
  assert.throws(() => context.startActivity('古い画面', '', '', '前の記録'), /進行中の作業が変更/);
  assert.throws(() => context.finishActivity(null), /進行中の作業が変更/);
  assert.equal(state.current, '新しい記録');
  assert.equal(state.locked, false);
});

test('開始の作成・自動終了・状態保存の失敗時に前の記録を復旧する', () => {
  for (const failure of ['failCreate', 'failClose', 'failProperty']) {
    const { context, state } = server();
    state[failure] = true;
    assert.throws(() => context.startActivity('作業', '', '', '前の記録'), /失敗/);
    assert.equal(state.current, '前の記録');
    assert.equal(state.events.get('前の記録').end, 301000);
    assert.equal(state.events.size, 1);
    assert.equal(state.locked, false);
    assert.equal(state.releases, 1);
  }
});

test('ロック取得に失敗した場合は記録を変更しない', () => {
  const { context, state } = server();
  state.refuseLock = true;
  assert.throws(() => context.startActivity('作業', '', '', '前の記録'), /別の操作/);
  assert.equal(state.events.size, 1);
  assert.equal(state.current, '前の記録');
  assert.equal(state.releases, 0);
});

test('復旧にも失敗した場合は残りの後始末を実行し、確認が必要なことを伝える', () => {
  const { context, state } = server();
  state.events.get('前の記録').setTime = () => { throw new Error('日時を保存できません'); };
  assert.throws(() => context.startActivity('作業', '', '', '前の記録'), /復旧も完了できませんでした/);
  assert.equal(state.current, '前の記録');
  assert.equal(state.events.has('新しい記録'), false);
  assert.equal(state.locked, false);
});

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]).toString('base64');
const attach = context => context.attachImageToEvent('前の記録', png, 'image/png', '写真.png');

test('画像の再送と応答消失後の再試行でもファイルと添付を重複作成しない', () => {
  for (const lostResponse of [false, true]) {
    const { context, state } = server();
    state.lostResponse = lostResponse;
    assert.equal(attach(context).attached, true);
    assert.equal(attach(context).attached, true);
    assert.equal(state.files.length, 1);
    assert.equal(state.attachments.length, 1);
    assert.equal(state.patches, 1);
    assert.equal(state.files[0].trashed, undefined);
  }
});

test('添付や共有の失敗で残ったファイルを片付け、再試行で添付できる', () => {
  for (const failure of ['failPatch', 'failSharing']) {
    const { context, state } = server();
    state[failure] = true;
    assert.throws(() => attach(context), /失敗/);
    assert.equal(state.files[0].trashed, true);
    assert.equal(state.attachments.length, 0);
    state[failure] = false;
    assert.equal(attach(context).attached, true);
    assert.equal(state.files.filter(file => !file.trashed).length, 1);
  }
});

test('添付結果が不明な場合はファイルを保持し、再試行時に再利用する', () => {
  const { context, state } = server();
  state.failPatch = state.failVerification = true;
  assert.throws(() => attach(context), /保存結果を確認できません/);
  assert.equal(state.files[0].trashed, undefined);
  state.failPatch = state.failVerification = state.failRead = false;
  assert.equal(attach(context).attached, true);
  assert.equal(state.files.length, 1);
});

test('画像の容量・形式・データをサーバーで検証し、予定の確認前に保存しない', () => {
  const { context, state } = server();
  for (const [data, type] of [[png, 'text/plain'], ['不正なデータ', 'image/png'],
    ['AAAA', 'image/png'], ['A'.repeat(6990509), 'image/png'], ['', 'image/png']]) {
    assert.throws(() => context.attachImageToEvent('前の記録', data, type, '写真.png'));
  }
  state.failRead = true;
  assert.throws(() => attach(context), /予定を取得できません/);
  assert.equal(state.files.length, 0);
});

test('上限ちょうどの画像を保存でき、1バイト超過した画像は保存しない', () => {
  const { context, state } = server();
  const bytes = Buffer.alloc(5 * 1024 * 1024 + 1);
  Buffer.from(png, 'base64').copy(bytes);
  assert.throws(() => context.attachImageToEvent('前の記録', bytes.toString('base64'), 'image/png', '大きな写真.png'), /5MB/);
  assert.equal(state.files.length, 0);
  assert.equal(context.attachImageToEvent('前の記録', bytes.subarray(0, -1).toString('base64'), 'image/png', '写真.png').attached, true);
  assert.equal(state.files.length, 1);
});

test('組み込みプロパティと同名のタイトルも使用回数順に集計する', () => {
  const { context } = server();
  context.cachedCalendar_.getEvents = () => ['通常の作業', '__proto__', 'constructor', '__proto__']
    .map(title => ({ getTitle: () => title }));
  assert.deepEqual(Array.from(context.getRecentTitles()), ['__proto__', 'constructor', '通常の作業']);
});
