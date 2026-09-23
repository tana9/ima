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

  await page.getByRole('button', { name: '指定時刻で終了' }).click();
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
  await page.getByRole('button', { name: '指定時刻で終了' }).click();
  await expect(page.locator('#errorMessage')).toContainText('終了時刻は開始時刻より後');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#finishTimeInput')).toHaveValue('2026-09-23T09:00');
  await expect(page.locator('#status')).toContainText('資料作成');
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

test('古い画面からの終了を拒否し、エラーを保持したまま再読み込みで復旧する', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#status')).toContainText('資料作成');
  await page.evaluate(async () => {
    await callServer('startActivity', '別端末の作業', '', '', appState.status.eventId);
  });
  await page.getByRole('button', { name: '指定時刻で終了' }).click();
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
