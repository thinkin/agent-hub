import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './tests', testMatch: '*.browser.ts', workers: 1, timeout: 30000, use: { channel: 'chrome', viewport: { width: 1440, height: 980 }, screenshot: 'only-on-failure', trace: 'off' } });
