import { test, expect } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { ConfigStore, agentInput } from '../src/config.js';
import { Sessions } from '../src/sessions.js';
import { createApp } from '../src/server.js';
import { createRelay, connectRelay } from '../src/relay.js';

test('browser uses the existing workspace and terminal through relay', async ({ page }) => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-relay-browser-'));
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const key = 'synthetic-browser-relay-key-at-least-32';
  const store = await new ConfigStore(directory).load();
  const agent = { ...agentInput.parse({ name: 'Relay fixture', connection: 'local', target: 'localhost', configDir: directory, cwd: directory }), id: randomUUID() };
  await store.update(config => config.agents.push(agent));
  const sessions = new Sessions((_agent, _command, cols, rows) => pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf "RELAY READY\\n"; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done'], { cols, rows, name: 'xterm-256color' }));
  const app = await createApp({ store, sessions, remoteOrigin: origin, dev: true });
  const localOrigin = await app.listen(0);
  const session = await sessions.create(agent, directory, undefined, false);
  const tab = { id: randomUUID(), agentId: agent.id, sessionId: session.info.id, cwd: directory, type: agent.type, connection: agent.connection, target: agent.target, configDir: agent.configDir };
  await store.update(config => { config.workspace = { tabs: [tab], activeTabId: tab.id }; });
  const relay = createRelay({ origin, key }); await relay.listen(port);
  let tunnel: ReturnType<typeof connectRelay> | undefined;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  try {
    await new Promise<void>(resolve => { tunnel = connectRelay({ origin, key, localOrigin, onStatus: connected => { if (connected) resolve(); } }); });
    await page.goto(`${origin}/#token=${app.token}`);
    await expect(page.locator('.terminal-panel[data-state="connected"]')).toBeVisible();
    await expect(page).toHaveURL(`${origin}/`);
    await expect(page.locator('.xterm-screen')).toContainText('RELAY READY');
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type('relay-browser'); await page.keyboard.press('Enter');
    await expect(page.locator('.xterm-screen')).toContainText('REPLY:relay-browser');
    await page.reload();
    await expect(page.locator('.terminal-panel[data-state="connected"]')).toBeVisible();
    await expect(page.locator('.xterm-screen')).toContainText('REPLY:relay-browser');
    expect(sessions.list()).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally { tunnel?.close(); await relay.close(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
