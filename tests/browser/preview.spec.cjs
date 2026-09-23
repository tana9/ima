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
  await expect(page.locator('#retryLoadBtn')).toBeHidden();
});

test('不正な終了日時は確認を表示せず入力を保持する', async ({ page }) => {
  await page.goto('/');
  await page.locator('#finishTimeInput').fill('2026-09-23T09:00');
  await page.getByRole('button', { name: '指定時刻で終了' }).click();
  await expect(page.locator('#toast')).toContainText('終了時刻は開始時刻より後');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#finishTimeInput')).toHaveValue('2026-09-23T09:00');
  await expect(page.locator('#status')).toContainText('資料作成');
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
