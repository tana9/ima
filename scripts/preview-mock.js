// プレビュー専用。データはページ内のメモリに保持し、Googleには送信しない。
var google = (function() {
  var interval = 5 * 60 * 1000;
  var now = DateRules.roundDown(Date.now(), 5);
  var scenario = typeof location === 'undefined' ? 'active' : new URLSearchParams(location.search).get('scenario');
  var failNextRead = scenario === 'error';
  var events = [
    { id: '見本1', title: 'メール確認', location: '自宅', description: '今日の予定を確認', start: now - 3600000, end: now - 1800000, active: false },
    { id: '見本2', title: '資料作成', location: '自宅', description: '打ち合わせ用の資料', start: now - 1800000, end: now + interval, active: true }
  ];
  if (scenario === 'empty') events = [];
  if (scenario === 'history') {
    var yesterday = DateRules.dayRange(DateRules.shiftDay(DateRules.calendarDate(now), -1)).start;
    events.push({ id: '見本前日', title: '資料作成', location: '自宅', description: '前日の見本',
      start: yesterday + 9 * 3600000, end: yesterday + 11 * 3600000, active: false });
  }
  if (scenario === 'long') {
    events[1].title = '来週の打ち合わせに向けた資料作成と関係者への確認事項の整理'.repeat(4);
    events[1].location = 'オンライン会議室・共同作業スペース';
  }
  var nextId = 3;
  function status() {
    var event = events.find(function(item) { return item.active; });
    return event ? { active: true, eventId: event.id, title: event.title, location: event.location,
      description: event.description, startTime: event.start } : { active: false };
  }
  function find(id) {
    var event = events.find(function(item) { return item.id === id; });
    if (!event) throw new Error('予定が見つかりませんでした');
    return event;
  }
  function close(end, explicit) {
    var event = events.find(function(item) { return item.active; });
    if (!event) return;
    event.end = DateRules.closeEnd(event.start, end, explicit);
    event.active = false;
  }
  function requireCurrent(expectedId) {
    if ((status().eventId || null) !== expectedId) throw new Error('進行中の作業が変更されています。「再読み込み」で確認してから操作してください');
  }
  var methods = {
    getDashboard: function(selectedDate) {
      if (failNextRead) {
        failNextRead = false;
        throw new Error('通信エラーの見本です。「再読み込み」で復旧を確認できます。');
      }
      var day = DateRules.dayRange(selectedDate == null ? DateRules.calendarDate(Date.now()) : selectedDate);
      return { status: status(), day: day,
        events: events.filter(function(event) { return DateRules.overlapsDay(event, day, Date.now()); }).sort(function(a, b) { return a.start - b.start; }),
        titles: Array.from(new Set(events.map(function(event) { return event.title; }))) };
    },
    startActivity: function(title, location, description, expectedId) {
      requireCurrent(expectedId);
      title = title.trim();
      if (!title) throw new Error('内容を入力してください');
      var start = DateRules.roundDown(Date.now(), 5);
      close(start, false);
      events.push({ id: '見本' + nextId++, title: title, location: location.trim(), description: description.trim(),
        start: start, end: start + interval, active: true });
      return status();
    },
    finishActivity: function(end, expectedId) {
      requireCurrent(expectedId);
      var explicit = end !== null && end !== undefined;
      close(explicit ? end : DateRules.roundUp(Date.now(), 5), explicit);
      return status();
    },
    updateEvent: function(id, title, location, description, start, end) {
      var event = find(id);
      title = title.trim();
      if (!title) throw new Error('内容を入力してください');
      var range = DateRules.editRange(start, end, event.end);
      Object.assign(event, { title: title, location: location.trim(), description: description.trim(), start: start,
        end: range.end });
      return { updated: true };
    },
    deleteEvent: function(id) {
      find(id);
      events = events.filter(function(event) { return event.id !== id; });
      return { deleted: true };
    },
    attachImageToEvent: function(id) {
      find(id);
      throw new Error('ローカルプレビューでは画像の選択まで確認できます。Driveへの保存は実環境で確認してください。');
    }
  };
  function runner(success, failure) {
    return new Proxy({}, { get: function(_, method) {
      if (method === 'withSuccessHandler') return function(callback) { return runner(callback, failure); };
      if (method === 'withFailureHandler') return function(callback) { return runner(success, callback); };
      return function() {
        var args = Array.from(arguments);
        Promise.resolve().then(function() {
          if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new Error('未対応のプレビュー操作です: ' + method);
          return JSON.parse(JSON.stringify(methods[method].apply(null, args)));
        }).then(success, failure);
      };
    } });
  }
  return { script: { run: runner() } };
})();
