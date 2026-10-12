import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { ConfigStore, agentInput } from '../src/config.js';
import { Sessions } from '../src/sessions.js';
import { createApp } from '../src/server.js';

test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

async function fixture(page: Page, historyLines = 0, bottomStatus = false) {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-mobile-'));
  const store = await new ConfigStore(directory).load();
  const sessions = new Sessions((_agent, _command, cols, rows) => pty.spawn('python3', ['-u', '-c', `import os,tty,signal\ntty.setraw(0)\nos.write(1,b"MOBILE READY\\r\\n")\nos.write(1,b"".join(("HISTORY:%d\\r\\n"%i).encode() for i in range(${historyLines})))\ndef status(*args):\n if ${bottomStatus ? "True" : "False"}: os.write(1,("\\x1b7\\x1b[%d;1H\\x1b[2KCLI STATUS: ready\\x1b8"%os.get_terminal_size(0).lines).encode())\nsignal.signal(signal.SIGWINCH,status)\nstatus()\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,b"INPUT:"+data.hex().encode()+b"\\r\\n")`], { cols, rows, name: 'xterm-256color' }));
  const app = await createApp({ store, sessions, dev: true });
  const origin = await app.listen(0);
  const agent = { ...agentInput.parse({ name: 'Mobile fixture with a long name', connection: 'local', target: 'localhost', configDir: directory, cwd: directory }), id: randomUUID() };
  await page.route('**/api/agents/*/history?*', route => route.fulfill({ json: { items: [], total: 0, warnings: [] } }));
  await page.route('**/api/agents/*/session-titles', route => route.fulfill({ json: { items: [], total: 0, warnings: [] } }));
  await page.route('**/api/agents/*/directories?*', route => route.fulfill({ json: { path: directory, entries: [{ name: 'project', path: join(directory, 'project'), hasChildren: false }], truncated: false } }));
  return { store, sessions, app, origin, agent, directory, async close() { await app.close(); await rm(directory, { recursive: true, force: true }); } };
}

async function noHorizontalOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
}

test('mobile empty state, launcher, agent menu and errors fit narrow screens', async ({ page }, testInfo) => {
  const f = await fixture(page);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${f.origin}/#token=${f.app.token}`);
    await expect(page.getByRole('button', { name: '注册第一个 Agent' })).toBeEnabled();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: '注册第一个 Agent' }).tap();
    await expect(page.getByRole('dialog')).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: '关闭', exact: true }).tap();
    await f.store.update(config => config.agents.push(f.agent));
    await page.reload();
    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(page.getByRole('heading', { name: '新建对话', exact: true })).toBeVisible();
      await page.getByRole('heading', { name: '打开历史对话' }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('textbox', { name: '搜索对话' })).toBeVisible();
      await noHorizontalOverflow(page);
      await page.getByRole('combobox').scrollIntoViewIfNeeded();
      const comboRect = (await page.getByRole('combobox').boundingBox())!;
      expect(comboRect.x).toBeGreaterThanOrEqual(0); expect(comboRect.x + comboRect.width).toBeLessThanOrEqual(width);
      await page.getByRole('combobox').tap();
      const option = page.getByRole('option').first();
      await expect(option).toBeVisible();
      const rect = await option.boundingBox(); expect(rect!.x).toBeGreaterThanOrEqual(0); expect(rect!.x + rect!.width).toBeLessThanOrEqual(width);
      await option.tap();
      await page.screenshot({ path: testInfo.outputPath(`mobile-launcher-${width}.png`) });
    }
    await page.route('**/api/agents/*/history?*', route => route.fulfill({ status: 500, json: { error: '合成历史读取失败，请重试' } }));
    await page.getByRole('button', { name: '刷新历史对话' }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '刷新历史对话' }).tap();
    await page.getByRole('alert').scrollIntoViewIfNeeded();
    await expect(page.getByRole('alert')).toContainText('合成历史读取失败');
    await noHorizontalOverflow(page);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

test('mobile terminal keys, paste, viewport resize and tab switching preserve sessions', async ({ page }, testInfo) => {
  const f = await fixture(page);
  const sent: { type: string; data?: string; rows?: number }[] = [];
  page.on('websocket', socket => socket.on('framesent', event => { try { sent.push(JSON.parse(String(event.payload))); } catch {} }));
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await f.store.update(config => config.agents.push(f.agent));
    const first = await f.sessions.create(f.agent, f.directory, undefined, false);
    const second = await f.sessions.create(f.agent, f.directory, undefined, false);
    const tabs = [first, second].map(session => ({ id: randomUUID(), agentId: f.agent.id, sessionId: session.info.id, cwd: f.directory, type: f.agent.type, connection: f.agent.connection, target: f.agent.target, configDir: f.agent.configDir }));
    await f.store.update(config => { config.workspace = { tabs, activeTabId: tabs[0].id }; });
    await page.goto(`${f.origin}/#token=${f.app.token}`);
    const terminal = () => page.locator('.terminal-panel:not([hidden])');
    await expect(terminal()).toHaveAttribute('data-state', 'connected');
    await expect(page.locator('.appbar .brand')).toBeHidden();
    await expect(page.locator('.appbar-active')).toBeHidden();
    expect((await page.locator('.main').boundingBox())!.y).toBe(0);
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '会话', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '管理 Agents', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: '关闭', exact: true }).tap();
    await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
    const keys = () => terminal().getByRole('group', { name: '终端快捷键' });
    await keys().getByRole('button', { name: '键盘', exact: true }).tap();
    await expect(terminal().locator('.xterm-helper-textarea')).toBeFocused();
    await keys().getByRole('button', { name: '键盘', exact: true }).tap();
    await expect(page.locator('.xterm-helper-textarea:focus')).toHaveCount(0);
    const inputsBeforePaste = sent.filter(message => message.type === 'input').length;
    await keys().getByRole('button', { name: '粘贴', exact: true }).tap();
    await page.getByRole('textbox', { name: '粘贴到终端的文本' }).fill('hello\n手机输入');
    await page.getByRole('button', { name: '输入终端', exact: true }).tap();
    await expect(page.getByRole('textbox', { name: '粘贴到终端的文本' })).toHaveCount(0);
    const pasteInputs = sent.filter(message => message.type === 'input').slice(inputsBeforePaste);
    expect(pasteInputs.map(message => message.data)).toEqual(['\x1b[200~hello\n手机输入\x1b[201~']);
    for (const [key, data] of [['Enter', '\r'], ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B'], ['Ctrl+C', '\x03']]) {
      await keys().getByRole('button', { name: key, exact: true }).scrollIntoViewIfNeeded();
      await keys().getByRole('button', { name: key, exact: true }).tap();
      await expect.poll(() => sent.filter(message => message.type === 'input').at(-1)?.data).toBe(data);
    }
    const originalRows = sent.filter(message => message.type === 'resize').at(-1)!.rows!;
    await terminal().locator('.mobile-key-scroll').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    await expect(page.getByRole('button', { name: '会话', exact: true })).toBeInViewport();
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '会话', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭', exact: true }).tap();
    await page.evaluate(() => {
      Object.defineProperty(window.visualViewport!, 'height', { configurable: true, get: () => 420 });
      window.visualViewport!.dispatchEvent(new Event('resize'));
    });
    await expect.poll(() => page.locator('.workspace').evaluate(el => el.getBoundingClientRect().height)).toBe(420);
    await expect.poll(() => sent.filter(message => message.type === 'resize').at(-1)!.rows!).toBeLessThan(originalRows);
    expect((await keys().boundingBox())!.y + (await keys().boundingBox())!.height).toBeLessThanOrEqual(420);
    await keys().getByRole('button', { name: '粘贴', exact: true }).scrollIntoViewIfNeeded();
    await keys().getByRole('button', { name: '粘贴', exact: true }).tap();
    await expect(page.getByRole('textbox', { name: '粘贴到终端的文本' })).toBeVisible();
    expect((await keys().boundingBox())!.y + (await keys().boundingBox())!.height).toBeLessThanOrEqual(420);
    await page.screenshot({ path: testInfo.outputPath('mobile-keyboard-height.png') });
    await page.getByRole('button', { name: '取消', exact: true }).tap();
    await page.evaluate(() => { Reflect.deleteProperty(window.visualViewport!, 'height'); window.visualViewport!.dispatchEvent(new Event('resize')); });
    await page.getByRole('button', { name: '会话', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await page.getByRole('button', { name: '切换到 新对话', exact: true }).nth(1).tap();
    await expect(page.locator('.terminal-panel').first()).toBeHidden();
    await expect(terminal()).toHaveAttribute('data-state', 'connected');
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await page.getByRole('button', { name: '切换到 新对话', exact: true }).first().tap();
    await expect(page.locator('.terminal-panel').first()).toBeVisible();
    await expect(terminal()).toHaveAttribute('data-state', 'connected');
    expect(f.sessions.list()).toHaveLength(2);
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await page.getByRole('button', { name: '新建或打开对话', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '打开对话' })).toBeVisible();
    await page.getByRole('textbox', { name: '搜索对话' }).scrollIntoViewIfNeeded();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: '关闭', exact: true }).tap();
    await page.getByRole('button', { name: '审阅', exact: true }).tap();
    await expect(page.getByRole('complementary', { name: '审阅', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: '收起工具抽屉' }).tap();
    await page.getByRole('button', { name: '变更', exact: true }).tap();
    await expect(page.getByRole('complementary', { name: '变更', exact: true })).toBeVisible();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: '收起工具抽屉' }).tap();
    for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }]) {
      await page.setViewportSize(size);
      await expect(terminal()).toHaveAttribute('data-state', 'connected');
      await noHorizontalOverflow(page);
      expect((await page.locator('.main').boundingBox())!.y).toBe(0);
      const entry = page.getByRole('button', { name: '会话', exact: true });
      await expect(entry).toBeInViewport();
      const entryBox = (await entry.boundingBox())!;
      expect(entryBox.y).toBe(8);
      expect(entryBox.x + entryBox.width).toBe(size.width - 4);
      const hostBox = (await terminal().locator('.terminal-host').boundingBox())!;
      expect(hostBox.x + hostBox.width).toBe(size.width);
      await page.screenshot({ path: testInfo.outputPath(`mobile-terminal-${size.width}.png`) });
    }
    await page.getByRole('button', { name: '会话', exact: true }).scrollIntoViewIfNeeded();
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await page.screenshot({ path: testInfo.outputPath('mobile-conversation-menu.png') });
    await page.getByRole('button', { name: '关闭 新对话', exact: true }).last().tap();
    await expect(page.locator('.mobile-conversation-row')).toHaveCount(1);
    expect(f.sessions.list()).toHaveLength(2);
    await page.getByRole('button', { name: '关闭', exact: true }).tap();
    f.sessions.get(first.info.id)!.dispose();
    await expect.poll(async () => { const enter = keys().getByRole('button', { name: 'Enter', exact: true }); return !await enter.count() || await enter.isDisabled(); }).toBe(true);
    expect(errors).toEqual([]);
  } finally { await f.close(); }
});

async function verifyControlConflict(page: Page, testInfo: TestInfo) {
  const f = await fixture(page);
  try {
    await f.store.update(config => config.agents.push(f.agent));
    const session = await f.sessions.create(f.agent, f.directory, undefined, false);
    const tab = { id: randomUUID(), agentId: f.agent.id, sessionId: session.info.id, cwd: f.directory, type: f.agent.type, connection: f.agent.connection, target: f.agent.target, configDir: f.agent.configDir };
    await f.store.update(config => { config.workspace = { tabs: [tab], activeTabId: tab.id }; });
    await page.goto(`${f.origin}/#token=${f.app.token}`);
    await expect(page.locator('.terminal-panel')).toHaveAttribute('data-state', 'connected');
    const url = `${f.origin.replace('http', 'ws')}/terminal/${session.info.id}?takeover=true`;
    // Exhaust the existing one-time automatic takeover, then retain a second controller.
    await page.evaluate(url => new Promise<void>(resolve => {
      const socket = new WebSocket(url); socket.onclose = () => resolve();
    }), url);
    await expect(page.locator('.terminal-panel')).toHaveAttribute('data-state', 'connected');
    await page.evaluate(url => new Promise<void>(resolve => {
      const socket = new WebSocket(url); socket.onmessage = () => resolve();
    }), url);
    const dialog = page.getByRole('alertdialog', { name: '此终端由其他页面控制' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('刷新页面或点击“接管终端”即可继续操作');
    const box = (await dialog.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - page.viewportSize()!.width / 2)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - page.viewportSize()!.height / 2)).toBeLessThan(2);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press('Control+Shift+G');
    await expect(page.locator('.tool-rail button[aria-label="审阅"]')).toHaveAttribute('aria-pressed', 'false');
    const mobile = page.viewportSize()!.width < 650;
    const entry = mobile ? page.locator('.mobile-conversation-entry') : page.locator('.manage-button');
    const entryBox = (await entry.boundingBox())!;
    await page.mouse.click(entryBox.x + entryBox.width / 2, entryBox.y + entryBox.height / 2);
    await expect(page.getByRole('dialog', { name: mobile ? '会话' : '管理 Agents', exact: true })).not.toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('control-conflict.png') });
    await dialog.getByRole('button', { name: '接管终端', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(page.locator('.terminal-panel')).toHaveAttribute('data-state', 'connected');
    await entry.click();
    await expect(page.getByRole('dialog', { name: mobile ? '会话' : '管理 Agents', exact: true })).toBeVisible();
    expect(f.sessions.list()).toHaveLength(1);
  } finally { await f.close(); }
}

test('control conflict blocks the whole workspace until takeover succeeds', async ({ page }, testInfo) => verifyControlConflict(page, testInfo));

test.describe('desktop control conflict', () => {
  test.use({ isMobile: false, hasTouch: false, viewport: { width: 1440, height: 980 } });
  test('modal blocks background until takeover succeeds', async ({ page }, testInfo) => verifyControlConflict(page, testInfo));
});

test('wide left scrollbar drags history without sending terminal input', async ({ page }, testInfo) => {
  const f = await fixture(page, 300);
  const inputs: string[] = [];
  page.on('websocket', socket => socket.on('framesent', event => { const message = JSON.parse(String(event.payload)); if (message.type === 'input') inputs.push(message.data); }));
  try {
    await f.store.update(config => config.agents.push(f.agent));
    const session = await f.sessions.create(f.agent, f.directory, undefined, false);
    const tab = { id: randomUUID(), agentId: f.agent.id, sessionId: session.info.id, cwd: f.directory, type: f.agent.type, connection: f.agent.connection, target: f.agent.target, configDir: f.agent.configDir };
    await f.store.update(config => { config.workspace = { tabs: [tab], activeTabId: tab.id }; });
    await page.goto(`${f.origin}/#token=${f.app.token}`);
    await expect(page.locator('.terminal-panel')).toHaveAttribute('data-state', 'connected');
    const rail = page.getByRole('scrollbar', { name: '终端历史滚动' });
    await expect(rail).toHaveAttribute('aria-disabled', 'false');
    const box = (await rail.boundingBox())!;
    expect(box.x).toBe(0); expect(box.width).toBe(28);
    expect((await page.locator('.terminal-host').boundingBox())!.x).toBe(8);
    expect(await rail.evaluate(el => getComputedStyle(el).pointerEvents)).toBe('none');
    const thumb = (await rail.locator('.terminal-scroll-thumb').boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 14, y: thumb.y + thumb.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 14, y: box.y + thumb.height / 2 }] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(rail).toHaveAttribute('aria-valuenow', '0');
    await expect(page.locator('.xterm-screen')).toContainText('HISTORY:0');
    await page.screenshot({ path: testInfo.outputPath('left-scrollbar.png') });
    await rail.press('End');
    await expect.poll(async () => (await rail.getAttribute('aria-valuenow')) === (await rail.getAttribute('aria-valuemax'))).toBe(true);
    await expect(page.locator('.xterm-screen')).toContainText('HISTORY:299');
    expect(inputs).toEqual([]);
    await page.getByRole('button', { name: '会话', exact: true }).tap();
    await expect(page.getByRole('dialog', { name: '会话', exact: true })).toBeVisible();
    await cdp.detach();
  } finally { await f.close(); }
});

test('CLI status painted on the last PTY row stays above mobile controls', async ({ page }, testInfo) => {
  const f = await fixture(page, 0, true);
  try {
    await f.store.update(config => config.agents.push(f.agent));
    const session = await f.sessions.create(f.agent, f.directory, undefined, false);
    const tab = { id: randomUUID(), agentId: f.agent.id, sessionId: session.info.id, cwd: f.directory, type: f.agent.type, connection: f.agent.connection, target: f.agent.target, configDir: f.agent.configDir };
    await f.store.update(config => { config.workspace = { tabs: [tab], activeTabId: tab.id }; });
    await page.goto(`${f.origin}/#token=${f.app.token}`);
    await expect(page.locator('.terminal-panel')).toHaveAttribute('data-state', 'connected');
    for (const height of [844, 420]) {
      await page.setViewportSize({ width: 390, height });
      await expect.poll(() => page.locator('.workspace').evaluate(el => el.getBoundingClientRect().height)).toBe(height);
      await expect.poll(async () => {
        const last = await page.locator('.xterm-rows > div').last().boundingBox(), host = await page.locator('.terminal-host').boundingBox();
        return !!last && !!host && last.y + last.height <= host.y + host.height + 1;
      }).toBe(true);
      await expect(page.locator('.xterm-rows > div').last()).toContainText('CLI STATUS: ready');
      const last = (await page.locator('.xterm-rows > div').last().boundingBox())!;
      const host = (await page.locator('.terminal-host').boundingBox())!;
      const controls = (await page.locator('.mobile-terminal-keys').boundingBox())!;
      expect(last.y + last.height).toBeLessThanOrEqual(host.y + host.height + 1);
      expect(last.y + last.height).toBeLessThanOrEqual(controls.y);
      await page.screenshot({ path: testInfo.outputPath(`cli-status-${height}.png`) });
    }
  } finally { await f.close(); }
});
