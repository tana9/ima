// 「今なにしてる」を Google カレンダーに登録するだけの Web アプリ

var CURRENT_EVENT_ID_KEY = 'CURRENT_EVENT_ID';
var TENTATIVE_MINUTES = 5; // 進行中イベントに一時的に設定しておく長さ(次の操作で実際の終了時刻に上書きされる)
var IMA_CALENDAR_NAME = 'ima';

// 「ima」という名前の専用カレンダーを取得し、なければ作成する
function getImaCalendar_() {
  var calendars = CalendarApp.getCalendarsByName(IMA_CALENDAR_NAME);
  if (calendars.length > 0) return calendars[0];
  return CalendarApp.createCalendar(IMA_CALENDAR_NAME);
}

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('今なにしてる')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function getCurrentStatus() {
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
    title: event.getTitle(),
    startTime: event.getStartTime().getTime()
  };
}

// 進行中のイベントがあれば、終了時刻を今の時刻(または開始時刻+1分)に確定させる
function closeCurrentEvent_(endTime) {
  var props = PropertiesService.getUserProperties();
  var id = props.getProperty(CURRENT_EVENT_ID_KEY);
  if (!id) return;

  var event = getImaCalendar_().getEventById(id);
  if (event) {
    var start = event.getStartTime();
    var actualEnd = endTime.getTime() > start.getTime()
      ? endTime
      : new Date(start.getTime() + 60 * 1000);
    event.setTime(start, actualEnd);
  }
  props.deleteProperty(CURRENT_EVENT_ID_KEY);
}

// 「今これをやっている」を開始する。前に進行中のタスクがあれば、そこで自動的に終了させる。
function startActivity(title) {
  title = (title || '').trim();
  if (!title) throw new Error('内容を入力してください');

  var now = new Date();
  closeCurrentEvent_(now);

  var tentativeEnd = new Date(now.getTime() + TENTATIVE_MINUTES * 60 * 1000);
  var event = getImaCalendar_().createEvent(title, now, tentativeEnd);

  PropertiesService.getUserProperties().setProperty(CURRENT_EVENT_ID_KEY, event.getId());
  return { active: true, title: title, startTime: now.getTime() };
}

// 進行中のタスクを終了する。endTimeMillis を省略した場合は今の時刻で終了する。
function finishActivity(endTimeMillis) {
  var endTime = (endTimeMillis === null || endTimeMillis === undefined)
    ? new Date()
    : new Date(endTimeMillis);
  closeCurrentEvent_(endTime);
  return { active: false };
}

// 過去に登録したタイトルを、よく使われている順(同数なら新しい順)に返す
function getRecentTitles(limit) {
  limit = limit || 8;
  var now = new Date();
  var since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  var events = getImaCalendar_().getEvents(since, now);

  var counts = {};
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
