// 「今なにしてる」を Google カレンダーに登録するだけの Web アプリ

var CURRENT_EVENT_ID_KEY = 'CURRENT_EVENT_ID';
var TENTATIVE_MINUTES = 5; // 進行中イベントに一時的に設定しておく長さ(次の操作で実際の終了時刻に上書きされる)
var IMA_CALENDAR_NAME = 'ima';

var IMA_FOLDER_NAME = 'ima';
var IMA_FOLDER_ID_KEY = 'IMA_FOLDER_ID';

var cachedCalendar_ = null;
var cachedFolder_ = null;

// 同じ利用者の別タブ・別端末からの操作も直列化する。
function withUserLock_(action) {
  var lock = LockService.getUserLock();
  if (!lock.tryLock(10000)) throw new Error('別の操作を処理中です。少し待って再試行してください');
  try { return action(); } finally { lock.releaseLock(); }
}

function requireCurrentEvent_(expectedId) {
  var currentId = PropertiesService.getUserProperties().getProperty(CURRENT_EVENT_ID_KEY);
  if (expectedId === undefined || (expectedId !== null && typeof expectedId !== 'string') || currentId !== expectedId) {
    throw new Error('進行中の作業が変更されています。「再読み込み」で確認してから操作してください');
  }
  return currentId;
}

// 「ima」という名前の専用カレンダーを取得し、なければ作成する(1回のリクエスト内ではキャッシュする)
function getImaCalendar_() {
  if (cachedCalendar_) return cachedCalendar_;
  var calendars = CalendarApp.getCalendarsByName(IMA_CALENDAR_NAME);
  cachedCalendar_ = calendars.length > 0 ? calendars[0] : CalendarApp.createCalendar(IMA_CALENDAR_NAME);
  return cachedCalendar_;
}

// 添付画像の保存先「ima」フォルダを取得し、なければ作成する。
// 作成したフォルダの ID を保存し、同名フォルダと混同せず次回以降も取得する。
function getImaFolder_() {
  if (cachedFolder_) return cachedFolder_;
  var props = PropertiesService.getUserProperties();
  var folderId = props.getProperty(IMA_FOLDER_ID_KEY);
  if (folderId) {
    try {
      cachedFolder_ = DriveApp.getFolderById(folderId);
      return cachedFolder_;
    } catch (e) {
      // 保存されていたフォルダが見つからない場合は作り直す
    }
  }
  cachedFolder_ = DriveApp.createFolder(IMA_FOLDER_NAME);
  props.setProperty(IMA_FOLDER_ID_KEY, cachedFolder_.getId());
  return cachedFolder_;
}

function doGet(e) {
  if (e && e.parameter && e.parameter.manifest) {
    return buildManifestResponse_();
  }

  var template = HtmlService.createTemplateFromFile('Index');
  template.manifestUrl = ScriptApp.getService().getUrl() + '?manifest=1';
  return template.evaluate()
    .setTitle('今なにしてる')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// アプリ内の静的なHTML断片のみを読み込む。末尾 _ によりクライアントからは呼べない。
function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getDashboard() {
  return withUserLock_(getDashboard_);
}

function getDashboard_() {
  return {
    status: getCurrentStatus_(),
    events: getTodayEvents(),
    titles: getRecentTitles(8)
  };
}

// Android などでホーム画面に追加した際のアプリらしい見た目のための Web App Manifest。
// Service Worker がないため正式な「インストール」条件は満たさないが、
// 対応するブラウザではホーム画面追加後の表示に反映される場合がある。
function buildManifestResponse_() {
  var manifest = {
    name: '今なにしてる',
    short_name: 'ima',
    start_url: ScriptApp.getService().getUrl(),
    display: 'standalone',
    background_color: '#f5f5f7',
    theme_color: '#007aff'
  };
  return ContentService.createTextOutput(JSON.stringify(manifest))
    .setMimeType(ContentService.MimeType.JSON);
}

function getCurrentStatus() {
  return withUserLock_(getCurrentStatus_);
}

function getCurrentStatus_() {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty(CURRENT_EVENT_ID_KEY);
  if (!id) return { active: false };

  var event = getImaCalendar_().getEventById(id);
  if (!event) {
    props.deleteProperty(CURRENT_EVENT_ID_KEY);
    return { active: false };
  }
  return {
    active: true,
    eventId: id,
    title: event.getTitle(),
    location: event.getLocation(),
    description: event.getDescription(),
    startTime: event.getStartTime().getTime()
  };
}

// 進行中のイベントがあれば、終了時刻を今の時刻(または開始時刻+1分)に確定させる
function closeCurrentEvent_(endTime, validateEnd) {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty(CURRENT_EVENT_ID_KEY);
  if (!id) return;

  var event = getImaCalendar_().getEventById(id);
  if (event) {
    var start = event.getStartTime();
    var actualEnd = new Date(DateRules.closeEnd(start.getTime(), endTime.getTime(), validateEnd));
    event.setTime(start, actualEnd);
  }
  props.deleteProperty(CURRENT_EVENT_ID_KEY);
}

// 開始時刻は現在時刻を5分単位で切り捨てる。前のタスクも同じ時刻で自動終了する。
function startActivity(title, location, description, expectedId) {
  return withUserLock_(function() { return startActivity_(title, location, description, expectedId); });
}

function startActivity_(title, location, description, expectedId) {
  title = (title || '').trim();
  location = (location || '').trim();
  description = (description || '').trim();
  if (!title) throw new Error('内容を入力してください');

  var previousId = requireCurrentEvent_(expectedId);
  var calendar = getImaCalendar_();
  var previous = previousId ? calendar.getEventById(previousId) : null;
  var previousStart = previous ? previous.getStartTime() : null;
  var previousEnd = previous ? previous.getEndTime() : null;
  var start = new Date(DateRules.roundDown(Date.now(), 5));

  var tentativeEnd = new Date(start.getTime() + TENTATIVE_MINUTES * 60 * 1000);
  var options = {};
  if (location) options.location = location;
  if (description) options.description = description;
  // 新規作成に失敗しても、前の記録と進行中状態は変更しない。
  var event = calendar.createEvent(title, start, tentativeEnd, options);
  var props = PropertiesService.getUserProperties();
  try {
    if (previous) previous.setTime(previousStart, new Date(DateRules.closeEnd(previousStart.getTime(), start.getTime(), false)));
    props.setProperty(CURRENT_EVENT_ID_KEY, event.getId());
  } catch (error) {
    var recoveryFailed = false;
    // 一つの復旧に失敗しても、残りの復旧を試みる。
    [function() { if (previous) previous.setTime(previousStart, previousEnd); },
      function() { if (previousId) props.setProperty(CURRENT_EVENT_ID_KEY, previousId); else props.deleteProperty(CURRENT_EVENT_ID_KEY); },
      function() { event.deleteEvent(); }].forEach(function(recover) {
        try { recover(); } catch (_) { recoveryFailed = true; }
      });
    if (recoveryFailed) throw new Error('開始に失敗し、元の状態への復旧も完了できませんでした。カレンダーの記録を確認して再読み込みしてください');
    throw error;
  }
  return { active: true, title: title, location: location, description: description, startTime: start.getTime(), eventId: event.getId() };
}

// 進行中のタスクを終了する。endTimeMillis の省略時は現在時刻を5分単位で切り上げる。
function finishActivity(endTimeMillis, expectedId) {
  return withUserLock_(function() {
    requireCurrentEvent_(expectedId);
    return finishActivity_(endTimeMillis);
  });
}

function finishActivity_(endTimeMillis) {
  var explicitEnd = endTimeMillis !== null && endTimeMillis !== undefined;
  var endTime = !explicitEnd
    ? new Date(DateRules.roundUp(Date.now(), 5))
    : new Date(requireTimestamp_(endTimeMillis));
  closeCurrentEvent_(endTime, explicitEnd);
  return { active: false };
}

// 過去に登録したタイトルを、よく使われている順(同数なら新しい順)に返す
function getRecentTitles(limit) {
  limit = limit || 8;
  var now = new Date();
  var since = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  var events = getImaCalendar_().getEvents(since, now);

  var counts = Object.create(null);
  var order = [];
  for (var i = events.length - 1; i >= 0; i--) {
    var t = events[i].getTitle();
    if (!t) continue;
    if (!counts[t]) {
      counts[t] = 0;
      order.push(t);
    }
    counts[t]++;
  }
  order.sort(function(a, b) { return counts[b] - counts[a]; });
  return order.slice(0, limit);
}

// 今日(0:00〜24:00)に登録された予定を、開始時刻順に返す
function getTodayEvents() {
  var now = new Date();
  var start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  var end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  var currentId = PropertiesService.getUserProperties().getProperty(CURRENT_EVENT_ID_KEY);

  var events = getImaCalendar_().getEvents(start, end);
  events.sort(function(a, b) { return a.getStartTime().getTime() - b.getStartTime().getTime(); });

  return events.map(function(e) {
    return {
      id: e.getId(),
      title: e.getTitle(),
      location: e.getLocation(),
      description: e.getDescription(),
      start: e.getStartTime().getTime(),
      end: e.getEndTime().getTime(),
      active: e.getId() === currentId
    };
  });
}

// 予定の内容・場所・説明・時刻を編集する。進行中の予定は終了時刻を変更できない(endMillis を null にする)。
function updateEvent(eventId, title, location, description, startMillis, endMillis) {
  return withUserLock_(function() { return updateEvent_(eventId, title, location, description, startMillis, endMillis); });
}

function updateEvent_(eventId, title, location, description, startMillis, endMillis) {
  title = (title || '').trim();
  location = (location || '').trim();
  description = (description || '').trim();
  if (!title) throw new Error('内容を入力してください');

  var event = getImaCalendar_().getEventById(eventId);
  if (!event) throw new Error('予定が見つかりませんでした');

  var range = validateEventRange_(startMillis, endMillis, event.getEndTime().getTime());
  event.setTime(new Date(range.start), new Date(range.end));
  event.setTitle(title);
  event.setLocation(location);
  event.setDescription(description);

  return { updated: true };
}

// 予定を削除する。進行中の予定を削除した場合は進行中状態も解除する。
function deleteEvent(eventId) {
  return withUserLock_(function() { return deleteEvent_(eventId); });
}

function deleteEvent_(eventId) {
  var event = getImaCalendar_().getEventById(eventId);
  if (!event) throw new Error('予定が見つかりませんでした');
  event.deleteEvent();

  var props = PropertiesService.getUserProperties();
  if (props.getProperty(CURRENT_EVENT_ID_KEY) === eventId) {
    props.deleteProperty(CURRENT_EVENT_ID_KEY);
  }

  return { deleted: true };
}

// 画像を Google Drive にアップロードし、指定した予定に添付ファイルとして紐付ける
function attachImageToEvent(eventId, base64Data, mimeType, filename) {
  return withUserLock_(function() { return attachImageToEvent_(eventId, base64Data, mimeType, filename); });
}

function attachImageToEvent_(eventId, base64Data, mimeType, filename) {
  if (!eventId) throw new Error('予定が指定されていません');
  if (typeof base64Data !== 'string' || !base64Data) throw new Error('画像データがありません');
  if (base64Data.length > Math.ceil(5 * 1024 * 1024 / 3) * 4) throw new Error('画像が大きすぎます(5MBまで)');
  if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType)) throw new Error('画像はPNG・JPEG・GIF・WebPを選んでください');
  if (base64Data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64Data)) throw new Error('画像データが不正です');
  var bytes = Utilities.base64Decode(base64Data);
  if (!bytes.length || bytes.length > 5 * 1024 * 1024) throw new Error('画像は5MB以下にしてください');
  var header = bytes.slice(0, 12).map(function(value) { return value & 255; });
  var signatures = {
    'image/png': [137, 80, 78, 71, 13, 10, 26, 10], 'image/jpeg': [255, 216, 255],
    'image/gif': [71, 73, 70, 56], 'image/webp': [82, 73, 70, 70]
  };
  if (!signatures[mimeType].every(function(value, index) { return header[index] === value; }) ||
      (mimeType === 'image/webp' && header.slice(8, 12).join(',') !== '87,69,66,80')) {
    throw new Error('画像の形式とデータが一致しません');
  }
  var calendarId = getImaCalendar_().getId();
  var apiEventId = eventId.replace(/@.*$/, '');
  var event = Calendar.Events.get(calendarId, apiEventId);
  // 予定と画像内容から保存名を決め、応答が失われた後の再試行でも同じファイルを使う。
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, eventId + ':' + base64Data)
    .map(function(value) { return ('0' + (value & 255).toString(16)).slice(-2); }).join('');
  var folder = getImaFolder_();
  var storedName = 'ima-' + digest;
  var matches = folder.getFilesByName(storedName);
  var file = null;
  while (matches.hasNext()) {
    var candidate = matches.next();
    if (!candidate.isTrashed()) { file = candidate; break; }
  }
  if (!file) file = folder.createFile(Utilities.newBlob(bytes, mimeType, storedName));
  function isAttached(record) {
    return (record.attachments || []).some(function(item) { return item.fileId === file.getId() || item.fileUrl === file.getUrl(); });
  }
  if (isAttached(event)) return { attached: true, url: file.getUrl() };
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    var attachments = (event.attachments || []).concat([{ fileUrl: file.getUrl(), title: filename || '画像', mimeType: mimeType }]);
    Calendar.Events.patch({ attachments: attachments }, calendarId, apiEventId, { supportsAttachments: true });
  } catch (error) {
    // 更新成功後に応答だけ失われた場合、添付済みのファイルを削除しない。
    var current;
    try { current = Calendar.Events.get(calendarId, apiEventId); } catch (_) {
      throw new Error('画像の保存結果を確認できません。同じ画像で再試行してください');
    }
    if (isAttached(current)) return { attached: true, url: file.getUrl() };
    try { file.setTrashed(true); } catch (_) {
      throw new Error('画像を添付できず、Driveのファイルも片付けられませんでした。同じ画像で再試行してください');
    }
    throw error;
  }
  return { attached: true, url: file.getUrl() };
}
