// サーバー側の検証はブラウザの検証とは独立して必ず実施する。
function requireTimestamp_(value) {
  if (typeof value !== 'number' || !isFinite(value) || !isFinite(new Date(value).getTime())) {
    throw new Error('有効な開始・終了時刻を入力してください');
  }
  return value;
}

function validateEventRange_(startMillis, endMillis, existingEndMillis) {
  var start = requireTimestamp_(startMillis);
  var keepEnd = endMillis === null || endMillis === undefined;
  var end = requireTimestamp_(keepEnd ? existingEndMillis : endMillis);
  if (end <= start) {
    if (!keepEnd) throw new Error('終了時刻は開始時刻より後にしてください');
    end = requireTimestamp_(start + 60 * 1000);
  }
  return { start: start, end: end };
}
