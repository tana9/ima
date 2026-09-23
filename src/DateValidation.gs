// 本番サーバー・ブラウザ・プレビューで同じ日時ルールを使用する。
// GoogleサービスやDOMに依存させない。
function createDateRules_() {
  function timestamp(value) {
    if (typeof value !== 'number' || !isFinite(value) || !isFinite(new Date(value).getTime())) {
      throw new Error('有効な開始・終了時刻を入力してください');
    }
    return value;
  }
  function round(value, minutes, direction) {
    if (typeof minutes !== 'number' || !isFinite(minutes) || minutes <= 0) {
      throw new Error('丸める間隔は正の数にしてください');
    }
    var interval = minutes * 60000;
    return timestamp(direction(timestamp(value) / interval) * interval);
  }
  function roundDown(value, minutes) { return round(value, minutes, Math.floor); }
  function roundUp(value, minutes) { return round(value, minutes, Math.ceil); }
  function validateRange(start, end) {
    timestamp(start);
    if (end !== null) {
      timestamp(end);
      if (end <= start) throw new Error('終了時刻は開始時刻より後にしてください');
    }
    return { start: start, end: end };
  }
  function editRange(start, end, existingEnd) {
    timestamp(start);
    var keepEnd = end === null || end === undefined;
    end = timestamp(keepEnd ? existingEnd : end);
    if (keepEnd && end <= start) end = timestamp(start + 60000);
    return validateRange(start, end);
  }
  function closeEnd(start, end, explicit) {
    timestamp(start);
    timestamp(end);
    if (explicit) return validateRange(start, end).end;
    return end > start ? end : timestamp(start + 60000);
  }
  // プロジェクトのタイムゾーン Asia/Tokyo と同じ日付境界を全環境で使う。
  function calendarDate(value) {
    return new Date(timestamp(value) + 9 * 60 * 60000).toISOString().slice(0, 10);
  }
  function dayRange(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('有効な日付を選んでください');
    var start = new Date(value + 'T00:00:00+09:00').getTime();
    if (!isFinite(start) || calendarDate(start) !== value) throw new Error('有効な日付を選んでください');
    return { date: value, start: start, end: timestamp(start + 86400000) };
  }
  function shiftDay(value, days) {
    return calendarDate(dayRange(value).start + days * 86400000);
  }
  function overlapsDay(event, range, now) {
    var end = event.active ? Math.max(event.start, now) : event.end;
    return event.start < range.end && (end > range.start || (event.active && event.start >= range.start));
  }
  return { timestamp: timestamp, roundDown: roundDown, roundUp: roundUp,
    validateRange: validateRange, editRange: editRange, closeEnd: closeEnd,
    calendarDate: calendarDate, dayRange: dayRange, shiftDay: shiftDay, overlapsDay: overlapsDay };
}

var DateRules = createDateRules_();

// ブラウザで検証していても、サーバー側でも必ず検証する。
function requireTimestamp_(value) { return DateRules.timestamp(value); }

function validateEventRange_(startMillis, endMillis, existingEndMillis) {
  return DateRules.editRange(startMillis, endMillis, existingEndMillis);
}

// 同じファクトリー関数を配信し、クライアント用のコピーを作らない。
function includeDateRules_() {
  return '<script>var DateRules = (' + createDateRules_.toString() + ')();</script>';
}
