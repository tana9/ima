const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/browser',
  fullyParallel: true,
  workers: 2,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3100',
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  projects: [
    { name: 'デスクトップ', use: { ...devices['Desktop Chrome'] } },
    { name: 'スマートフォン', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: 'task preview PORT=3100',
    url: 'http://127.0.0.1:3100',
    reuseExistingServer: false,
    timeout: 15000
  }
});
