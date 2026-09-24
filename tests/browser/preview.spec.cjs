const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPreviewServer } = require('../../scripts/preview.cjs');

test.beforeEach(async ({ page }) => {
  // 時刻の境界で結果が変わらないよう、日時だけを固定する。
  await page.clock.setFixedTime(new Date('2026-09-23T10:03:00+09:00'));
});

test('空の一覧から開始・編集・終了・削除を画面で操作できる', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?scenario=empty');
  await expect(page.locator('#todayList')).toHaveText('まだ今日の記録がありません。');
  await page.getByLabel('今やっていること').fill('ブラウザでの確認');
  await page.getByRole('button', { name: '開始する', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('ブラウザでの確認 を開始しますか?');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#status')).toContainText('ブラウザでの確認');
  await expect(page.locator('.today-time')).toHaveText('10:00〜進行中');

  await page.locator('.today-item').click();
  await page.locator('.edit-title').fill('編集した作業');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.today-title')).toHaveText('編集した作業');
  await expect(page.locator('#status')).toContainText('編集した作業');

  await page.getByRole('button', { name: 'この時刻で終了' }).click();
  await expect(page.getByRole('dialog')).toContainText('5分単位で切り上げ');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('現在なにも記録していません');
  await expect(page.locator('.today-time')).toHaveText('10:00〜10:05');

  await page.locator('.today-item').click();
  await page.getByRole('button', { name: 'この予定を削除' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#todayList')).toHaveText('まだ今日の記録がありません。');
  expect(errors).toEqual([]);
});

test('表示状態を切り替え、通信エラーから再試行で復旧できる', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('資料作成');
  await page.getByRole('link', { name: '記録なし', exact: true }).click();
  await expect(page.locator('#todayList')).toContainText('まだ今日の記録がありません');
  await page.getByRole('link', { name: '長いタイトル', exact: true }).click();
  await expect(page.locator('#status')).toContainText('来週の打ち合わせ');
  expect((await page.locator('#status .doing').textContent()).length).toBeGreaterThan(100);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('link', { name: '通信エラー', exact: true }).click();
  await expect(page.locator('#operationStatus')).toContainText('読み込みに失敗しました');
  await expect(page.locator('#startBtn')).toBeDisabled();
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('#status')).toContainText('資料作成');
  await expect(page.locator('#retryLoadBtn')).toBeEnabled();
});

test('不正な終了日時は確認を表示せず入力を保持する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#finishTimeInput').fill('2026-09-23T09:00');
  await page.getByRole('button', { name: 'この時刻で終了' }).click();
  await expect(page.locator('#errorMessage')).toContainText('終了時刻は開始時刻より後');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#finishTimeInput')).toHaveValue('2026-09-23T09:00');
  await expect(page.locator('#status')).toContainText('資料作成');
});

test('終了欄の現在時刻ボタンは日時入力と同じ高さで横並びになる', async ({ page }) => {
  await page.goto('/');
  const input = page.locator('#finishTimeInput');
  const nowButton = page.getByRole('button', { name: '現在時刻を入力' });
  const finishButton = page.getByRole('button', { name: 'この時刻で終了' });
  const boxes = await Promise.all([input.boundingBox(), nowButton.boundingBox(), finishButton.boundingBox()]);
  expect(boxes[0].height).toBe(boxes[1].height);
  expect(boxes[1].height).toBeGreaterThanOrEqual(44);
  expect(boxes[0].y).toBe(boxes[1].y);
  if (await page.evaluate(() => window.innerWidth < 720)) {
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y);
  }
  expect(await finishButton.evaluate(button => button.scrollWidth <= button.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('スマートフォンでは終了欄が追従し、日付操作を1行で使える', async ({ page }) => {
  await page.goto('/');
  const layout = await page.evaluate(() => {
    const finish = document.getElementById('finishCard');
    const navigation = document.querySelector('.day-navigation');
    const date = document.getElementById('recordDateInput');
    const style = getComputedStyle(finish);
    const navStyle = getComputedStyle(navigation);
    return { position: style.position, columns: navStyle.gridTemplateColumns,
      dateTop: date.getBoundingClientRect().top, navTop: navigation.getBoundingClientRect().top };
  });
  if (await page.evaluate(() => window.innerWidth < 720)) {
    expect(layout.position).toBe('sticky');
    expect(layout.columns).not.toBe('none');
    expect(layout.dateTop).toBe(layout.navTop);
  }
});

test('編集フォームの場所・説明・画像を詳細欄にまとめる', async ({ page }) => {
  await page.goto('/?scenario=empty');
  await page.getByLabel('今やっていること').fill('詳細欄の確認');
  await page.getByRole('button', { name: '開始する', exact: true }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.locator('.today-item').click();
  const details = page.locator('.edit-details');
  await expect(details).toHaveCount(1);
  await expect(details.locator('summary')).toHaveText('場所・説明・画像');
  await expect(details).not.toHaveAttribute('open', '');
  await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details.getByLabel('場所(任意)', { exact: true })).toBeVisible();
});

test('選択した画像をサムネイルでプレビューし、解除すると消える', async ({ page }) => {
  await page.goto('/?scenario=empty');
  await page.getByText('場所・説明・画像を追加', { exact: true }).click();
  await expect(page.locator('#imagePreview')).toBeHidden();
  await page.locator('#imageInput').setInputFiles({ name: '写真.png', mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await expect(page.locator('#imagePreview')).toBeVisible();
  await expect(page.locator('#imagePreview')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: '画像の選択を解除' }).click();
  await expect(page.locator('#imagePreview')).toBeHidden();

  await page.getByLabel('今やっていること').fill('編集欄プレビューの確認');
  await page.getByRole('button', { name: '開始する', exact: true }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.locator('.today-item').click();
  await page.getByText('場所・説明・画像', { exact: true }).click();
  await expect(page.locator('.edit-image-preview')).toBeHidden();
  await page.locator('.edit-image').setInputFiles({ name: '写真2.png', mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await expect(page.locator('.edit-image-preview')).toBeVisible();
  await expect(page.locator('.edit-image-preview')).toHaveAttribute('src', /^blob:/);
  await page.getByRole('button', { name: '添付画像の選択を解除' }).click();
  await expect(page.locator('.edit-image-preview')).toBeHidden();
});

test('記録をキーボードで編集でき、確認画面のフォーカスを保持して元に戻す', async ({ page }) => {
  await page.goto('/');
  const row = page.getByRole('button', { name: /資料作成/ });
  await row.focus();
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await page.getByLabel('内容', { exact: true }).fill('キーボードで編集');
  await expect(page.locator('.edit-title')).toHaveValue('キーボードで編集');
  const remove = page.getByRole('button', { name: 'この予定を削除' });
  await remove.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'OK', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#confirmCancelBtn')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#confirmOkBtn')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(remove).toBeFocused();
});

test('終了し忘れを警告し、開始時に前の作業の終了日時を補正できる', async ({ page }) => {
  await page.goto('/?scenario=forgotten');
  await expect(page.locator('#forgottenWarning')).toContainText('開始から5時間以上経過しています。終了し忘れていませんか');
  await page.getByLabel('今やっていること').fill('会議');
  await page.getByRole('button', { name: '開始する', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('前の作業「資料作成」は開始から5時間3分経過');
  const previousEnd = dialog.getByLabel('前の作業の終了日時');
  await expect(previousEnd).toHaveValue('2026-09-23T10:00');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(previousEnd).toBeFocused();
  await previousEnd.fill('2026-09-23T08:00');
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#status')).toContainText('会議');
  await expect(page.locator('#forgottenWarning')).toBeHidden();
  await expect(page.locator('.today-time')).toHaveText(['04:00〜05:00', '05:00〜08:00', '10:00〜進行中']);
});

test('古い画面からの終了を拒否し、エラーを保持したまま再読み込みで復旧する', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('資料作成');
  await page.evaluate(async () => {
    await callServer('startActivity', '別端末の作業', '', '', appState.status.eventId);
  });
  await page.getByRole('button', { name: 'この時刻で終了' }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('進行中の作業が変更');
  await page.waitForTimeout(2800);
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: '再読み込み', exact: true }).click();
  await expect(page.locator('#status')).toContainText('別端末の作業');
  await page.getByRole('button', { name: 'エラーを閉じる' }).click();
  await expect(page.getByRole('alert')).toBeHidden();
});

test('開始後に画像添付が失敗した場合は保存済みの記録の編集欄で再試行できる', async ({ page }) => {
  await page.goto('/?scenario=empty');
  await page.getByLabel('今やっていること').fill('画像付きの作業');
  await page.getByText('場所・説明・画像を追加', { exact: true }).click();
  await page.locator('#imageInput').setInputFiles({ name: '写真.png', mimeType: 'image/png',
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]) });
  await page.getByRole('button', { name: '開始する', exact: true }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await expect(page.locator('#status')).toContainText('画像付きの作業');
  await expect(page.getByRole('alert')).toContainText('予定は保存済み');
  await expect(page.locator('.edit-image-name')).toHaveText('写真.png');
  await expect(page.locator('#imageInput')).toHaveValue('');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('.edit-image-name')).toHaveText('写真.png');
  await expect(page.locator('.today-item')).toHaveCount(1);
});

test('前日の記録を日時ごと編集でき、日付移動と作業時間の集計が一致する', async ({ page }) => {
  await page.goto('/?scenario=history');
  await expect(page.locator('#daySummary')).toContainText('合計 1時間3分');
  await page.getByRole('button', { name: '前日', exact: true }).click();
  await expect(page.locator('#recordDateInput')).toHaveValue('2026-09-22');
  await expect(page.locator('#status')).toContainText('資料作成');
  await expect(page.locator('#daySummary')).toContainText('資料作成：2時間');
  await page.locator('.today-item').click();
  await page.getByLabel('開始', { exact: true }).fill('2026-09-21T23:30');
  await page.getByLabel('終了', { exact: true }).fill('2026-09-22T00:30');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#daySummary')).toContainText('合計 30分');
  await expect(page.locator('.today-time')).toContainText('2026-09-21 23:30');
  await page.getByRole('button', { name: '前日', exact: true }).click();
  await expect(page.locator('#daySummary')).toContainText('合計 30分');
  await page.getByRole('button', { name: '翌日', exact: true }).click();
  await expect(page.locator('#recordDateInput')).toHaveValue('2026-09-22');
  await page.getByRole('button', { name: '今日', exact: true }).click();
  await expect(page.locator('#recordDateInput')).toHaveValue('2026-09-23');
  await page.getByLabel('記録の日付（日本時間）').fill('2026-09-24');
  await expect(page.locator('#todayList')).toHaveText('この日の記録はありません。');
  await expect(page.locator('#daySummary')).toContainText('合計 0分');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('開始前の下書きを再読み込みで復元し、画像の再選択を案内して破棄できる', async ({ page }) => {
  await page.goto('/?scenario=empty');
  await page.getByLabel('今やっていること').fill('途中の作業');
  await page.getByText('場所・説明・画像を追加', { exact: true }).click();
  await page.getByLabel('場所(任意)', { exact: true }).fill('自宅');
  await page.getByLabel('説明(任意)', { exact: true }).fill('途中のメモ');
  await page.locator('#imageInput').setInputFiles({ name: '写真.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await page.reload();
  await expect(page.getByLabel('今やっていること')).toHaveValue('途中の作業');
  await expect(page.getByLabel('場所(任意)', { exact: true })).toHaveValue('自宅');
  await expect(page.getByLabel('説明(任意)', { exact: true })).toHaveValue('途中のメモ');
  await expect(page.locator('#imageDraftHint')).toContainText('再選択してください');
  await expect(page.locator('#imageInput')).toHaveValue('');
  await page.getByRole('button', { name: '下書きを破棄', exact: true }).click();
  await page.getByRole('button', { name: 'OK', exact: true }).click();
  await page.reload();
  await expect(page.getByLabel('今やっていること')).toHaveValue('');
  await expect(page.locator('#imageDraftHint')).toHaveText('');
});

test('過去の記録の編集下書きを復元し、保存成功後は下書きを消す', async ({ page }) => {
  await page.goto('/?scenario=history');
  await page.getByRole('button', { name: '前日', exact: true }).click();
  await page.locator('.today-item').click();
  await page.getByLabel('内容', { exact: true }).fill('編集中の内容');
  await page.getByLabel('開始', { exact: true }).fill('2026-09-22T08:30');
  await page.reload();
  await expect(page.locator('#recordDateInput')).toHaveValue('2026-09-22');
  await expect(page.getByLabel('内容', { exact: true })).toHaveValue('編集中の内容');
  await expect(page.getByLabel('開始', { exact: true })).toHaveValue('2026-09-22T08:30');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.locator('#daySummary')).toContainText('編集中の内容：2時間30分');
  await page.reload();
  await expect(page.locator('.today-edit')).toHaveCount(0);
  await expect(page.locator('#recordDateInput')).toHaveValue('2026-09-22');
});

test('HTML保存で自動更新し、一時停止中は入力を保持して再開後に反映する', async ({ page }) => {
  // 他のテストや作業中のソースを変更しないよう、一時コピーを配信する。
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ima-browser-'));
  fs.cpSync(path.join(__dirname, '../../src'), sourceRoot, { recursive: true });
  const server = createPreviewServer({ sourceRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await page.goto('http://127.0.0.1:' + server.address().port + '/?scenario=empty');
    await expect(page.locator('#todayList')).toContainText('まだ今日の記録がありません');
    const file = path.join(sourceRoot, 'Index.html');
    const original = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, original.replace('<h1>今なにしてる</h1>', '<h1>保存後の画面</h1>'));
    await expect(page.getByRole('heading', { name: '保存後の画面' })).toBeVisible();
    await expect(page.locator('#todayList')).toContainText('まだ今日の記録がありません');
    await page.getByRole('button', { name: '自動更新を一時停止' }).click();
    await page.getByLabel('今やっていること').fill('入力途中の作業');
    fs.writeFileSync(file, original.replace('<h1>今なにしてる</h1>', '<h1>再開後の画面</h1>'));
    // 更新周期を超えても入力と画面が保持されることを確認する。
    await page.waitForTimeout(1800);
    await expect(page.getByLabel('今やっていること')).toHaveValue('入力途中の作業');
    await expect(page.getByRole('heading', { name: '保存後の画面' })).toBeVisible();
    await page.getByRole('button', { name: '自動更新を再開' }).click();
    await expect(page.getByRole('heading', { name: '再開後の画面' })).toBeVisible();
  } finally {
    await page.goto('about:blank');
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});
