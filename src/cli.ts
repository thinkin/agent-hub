#!/usr/bin/env node
import { parseArgs } from 'node:util';
import open from 'open';
import { ConfigStore, ensureLocalAgents } from './config.js';
import { createApp } from './server.js';

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { port: { type: 'string', default: '4317' }, 'no-open': { type: 'boolean' }, dev: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help || positionals.length === 0) {
    console.log('multi-agent-mgr start [--port 4317] [--no-open]\n\n配置目录：~/.multi-agent-mgr/\n关闭网页不会结束会话；退出此服务会关闭 SSH 连接。');
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== 'start') throw new Error('使用 multi-agent-mgr start 启动');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间');
  const store = await new ConfigStore().load();
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
