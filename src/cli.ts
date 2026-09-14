#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import open from 'open';
import { ConfigStore, ensureLocalAgents } from './config.js';
import { createApp } from './server.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: process.env.PORT || '4317' }, 'config-dir': { type: 'string', default: process.env.CONFIG_DIR || undefined }, 'no-open': { type: 'boolean' }, dev: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || positionals.length === 0) {
    console.log('agent-hub start [--port 4317] [--config-dir PATH] [--no-open]\n\n环境变量：PORT（默认 4317）、CONFIG_DIR（默认 ~/.agent-hub/）\n命令行参数优先于环境变量；配置目录仅用于 Agent Hub。\n关闭网页不会结束会话；退出此服务会关闭终端连接。');
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'start') throw new Error('使用 agent-hub start 启动');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  const configDir = values['config-dir'];
  if (configDir !== undefined && !configDir.trim()) throw new Error('配置目录不能为空');
  const directory = configDir === undefined ? undefined : resolve(configDir === '~' ? homedir() : configDir.startsWith('~/') ? resolve(homedir(), configDir.slice(2)) : configDir);
  const store = await new ConfigStore(directory).load();
  const localAgentsChanged = await ensureLocalAgents(store);
  const app = await createApp({ store, dev: values.dev });
  let origin: string;
  try { origin = await app.listen(port); }
  catch (error) { await app.close(); throw error; }
  const url = `${origin}/#token=${app.token}`;
  console.log(`\nAgent Hub\n\n${url}\n\n配置：${store.directory}/config.json${localAgentsChanged ? '\n已同步本机 Agent CLI。' : ''}\n终端会话由此进程保持。按 Ctrl+C 结束服务及其连接。\n`);
  if (!values['no-open']) await open(url).catch(() => console.error('无法自动打开浏览器，请打开上面的链接。'));
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\n正在关闭终端会话…');
    await app.close();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
