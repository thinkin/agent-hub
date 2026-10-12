#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { connectRelay, createRelay, relayOrigin } from './relay.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: process.env.PORT || '4317' }, 'config-dir': { type: 'string', default: process.env.CONFIG_DIR || undefined }, relay: { type: 'string' }, 'public-origin': { type: 'string' }, 'no-open': { type: 'boolean' }, dev: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || positionals.length === 0) {
    console.log('agent-hub start [--port 4317] [--config-dir PATH] [--no-open] [--relay https://hub.example.com]\nagent-hub relay --port 4320 --public-origin https://hub.example.com\n远程接入：两端设置同一个 AGENT_HUB_RELAY_KEY（至少 32 字符），公网入口需配置 HTTPS/WSS 反向代理。\n\n环境变量：PORT（默认 4317）、CONFIG_DIR（默认 ~/.agent-hub/）\n命令行参数优先于环境变量；配置目录仅用于 Agent Hub。\n关闭网页不会结束会话；退出此服务会关闭终端连接。');
    return;
  }
  if (positionals.length !== 1 || !['start', 'relay'].includes(positionals[0])) throw new Error('使用 agent-hub start 或 agent-hub relay 启动');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  const key = process.env.AGENT_HUB_RELAY_KEY ?? '';
  const remoteOrigin = values.relay ? relayOrigin(values.relay) : undefined;
  if ((remoteOrigin || positionals[0] === 'relay') && key.length < 32) throw new Error('AGENT_HUB_RELAY_KEY 至少需要 32 个字符');
  if (positionals[0] === 'relay') {
    if (!values['public-origin']) throw new Error('Relay 需要 --public-origin');
    const relay = createRelay({ origin: values['public-origin'], key });
    await relay.listen(port);
    console.log(`Relay 已启动，监听 127.0.0.1:${port}。请将公网 HTTPS/WSS 入口代理到此端口。`);
    const shutdown = () => { void relay.close(); };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    return;
  }
  const [{ ConfigStore, ensureLocalAgents }, { createApp }, { default: open }] = await Promise.all([import('./config.js'), import('./server.js'), import('open')]);
  const configDir = values['config-dir'];
  if (configDir !== undefined && !configDir.trim()) throw new Error('配置目录不能为空');
  const directory = configDir === undefined ? undefined : resolve(configDir === '~' ? homedir() : configDir.startsWith('~/') ? resolve(homedir(), configDir.slice(2)) : configDir);
  const store = await new ConfigStore(directory).load();
  const localAgentsChanged = await ensureLocalAgents(store);
  const app = await createApp({ store, dev: values.dev, remoteOrigin });
  let origin: string;
  try { origin = await app.listen(port); }
  catch (error) { await app.close(); throw error; }
  const tunnel = remoteOrigin ? connectRelay({ origin: remoteOrigin, key, localOrigin: origin, onStatus: connected => console.log(connected ? 'Relay 已连接。' : 'Relay 已断开，正在重试…') }) : undefined;
  const url = `${origin}/#token=${app.token}`;
  console.log(`\nAgent Hub\n\n${remoteOrigin ? `远程访问：${remoteOrigin}/#token=${app.token}\n` : ''}本地访问：${url}\n\n配置：${store.directory}/config.json${localAgentsChanged ? '\n已同步本机 Agent CLI。' : ''}\n终端会话由此进程保持。按 Ctrl+C 结束服务及其连接。\n`);
  if (!values['no-open']) await open(url).catch(() => console.error('无法自动打开浏览器，请打开上面的链接。'));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n正在关闭终端会话…');
    tunnel?.close();
    await app.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
