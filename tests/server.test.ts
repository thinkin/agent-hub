import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import { ConfigStore, agentInput } from '../src/config.js';
import { Sessions } from '../src/sessions.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { AgentRegistry } from '../src/agents/registry.js';
import { createApp } from '../src/server.js';

const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const execFileAsync = promisify(execFile);

async function availablePort() {
  const server = createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

test('CLI environment settings isolate configuration and yield to explicit options', { timeout: 30000 }, async t => {
  for (const mode of ['environment', 'arguments', 'home'] as const) await t.test(mode, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-hub-cli-'));
    const port = await availablePort();
    const args = ['--import', import.meta.resolve('tsx'), cliPath, 'start', '--no-open'];
    if (mode === 'arguments') args.push('--port', String(port), '--config-dir', 'explicit config');
    const configName = mode === 'arguments' ? 'explicit config' : 'environment config';
    const child = spawn(process.execPath, args, {
      cwd: directory,
      env: { ...process.env, HOME: directory, PORT: mode === 'arguments' ? 'invalid' : String(port), CONFIG_DIR: mode === 'home' ? '~/environment config' : 'environment config' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    child.stderr.resume();
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('CLI startup timed out')), 10000);
        let output = '';
        child.stdout.on('data', data => {
          output += data.toString();
          if (output.includes(`http://127.0.0.1:${port}/#token=`)) { clearTimeout(timer); resolve(); }
        });
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`CLI exited before ready (${code})`)); });
      });
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/config`)).status, 401);
      assert.equal((await stat(join(directory, configName, 'config.json'))).mode & 0o777, 0o600);
      assert.equal((await stat(join(directory, configName))).mode & 0o777, 0o700);
      await assert.rejects(stat(join(directory, '.agent-hub')), { code: 'ENOENT' });
      if (mode === 'arguments') await assert.rejects(stat(join(directory, 'environment config')), { code: 'ENOENT' });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

test('CLI rejects invalid ports before creating configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-cli-invalid-'));
  try {
    for (const port of ['0', '65536', '1.5', 'invalid']) {
      await assert.rejects(execFileAsync(process.execPath, ['--import', import.meta.resolve('tsx'), cliPath, 'start', '--no-open'], {
        env: { ...process.env, PORT: port, CONFIG_DIR: join(directory, 'unused') },
      }), (error: any) => error.code === 1 && error.stderr.includes('端口必须在 1–65535 之间'));
    }
    await assert.rejects(stat(join(directory, 'unused')), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function nextMessage(ws: WebSocket, predicate: (value: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('WebSocket message timed out')); }, 5000);
    const receive = (data: Buffer) => { const value = JSON.parse(data.toString()); if (predicate(value)) { clearTimeout(timer); ws.off('message', receive); resolve(value); } };
    ws.on('message', receive);
  });
}

test('HTTP security and real PTY survives disconnect, snapshots and exclusive control', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-server-'));
  const store = await new ConfigStore(directory).load();
  const agent = { ...agentInput.parse({ name: 'Test agent', target: 'test-host' }), id: randomUUID() };
  await store.update(c => c.agents.push(agent));
  let spawns = 0;
  const sessions = new Sessions((_agent, _command, cols, rows) => { spawns++; return pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf "PTY READY\\n"; while IFS= read -r line; do printf "REPLY:%s\\n" "$line"; done'], { cols, rows, name: 'xterm-256color' }); });
  const historicalId = randomUUID();
  const claude = new ClaudeAdapter(async () => '__AGENT_HUB_JSON__' + JSON.stringify({ items: [{ id: historicalId, cwd: '/existing', title: 'Old chat', modified: 1000 }], total: 1, warnings: [] }));
  const discoverRun = async (probe: { target: string }, command: string) => {
    assert.match(command, /command -v 'claude'/);
    return probe.target === 'scan-host' ? '__AGENT_HUB_HOST__ scanbox\n__AGENT_HUB_PYTHON__\n__AGENT_HUB_FOUND__ claude-code /opt/claude\n' : '__AGENT_HUB_HOST__ barebox\n';
  };
  const app = await createApp({ store, sessions, registry: new AgentRegistry([claude], discoverRun) });
  const origin = await app.listen(0);
  const sockets: WebSocket[] = [];
  try {
    assert.equal((await fetch(`${origin}/api/config`)).status, 401);
    assert.equal((await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })).status, 403);
    const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0];
    const request = (path: string, method = 'GET', body?: unknown) => fetch(`${origin}/api${path}`, { method, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    assert.equal((await request('/config')).status, 200);
    const discovered = await (await request('/agents/discover', 'POST', { connection: 'ssh', target: 'scan-host' })).json();
    assert.equal(discovered.hostname, 'scanbox');
    assert.equal(discovered.python, true);
    assert.deepEqual(discovered.agents.map((a: { type: string }) => a.type), ['claude-code']);
    const empty = await (await request('/agents/discover', 'POST', { connection: 'ssh', target: 'bare-host' })).json();
    assert.deepEqual(empty.agents, []);
    assert.ok(empty.warnings.length);
    const before = store.get().agents.length;
    const batch = await request('/agents/batch', 'POST', { agents: [{ name: 'scanbox Claude', type: 'claude-code', connection: 'ssh', target: 'scan-host', cwd: '~', executable: 'claude' }] });
    assert.equal(batch.status, 201);
    assert.equal((await batch.json()).agents.length, 1);
    assert.equal(store.get().agents.length, before + 1);
    assert.equal((await request('/agents/batch', 'POST', { agents: [] })).status, 400);
    assert.equal((await request('/sessions', 'POST', { agentId: agent.id, cwd: 'bad\u0000path' })).status, 400);
    const response = await request('/sessions', 'POST', { agentId: agent.id });
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal((await fetch(`${origin}/api/workspace`)).status, 401);
    assert.equal((await request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id, title: 'private' })).status, 400);
    const opened = await (await request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id })).json();
    const tabId = opened.activeTabId;
    await Promise.all([request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id }), request('/workspace', 'PATCH', { action: 'select', tabId })]);
    const workspace = await (await request('/workspace')).json();
    assert.equal(workspace.tabs.length, 1);
    assert.equal(workspace.tabs[0].agentId, agent.id);
    assert.equal(workspace.activeTabId, tabId);
    assert.deepEqual((await new ConfigStore(directory).load()).get().workspace, workspace);
    const stranger = { ...agent, id: randomUUID(), target: 'other-host' };
    await store.update(c => c.agents.push(stranger));
    assert.equal((await request('/workspace', 'PATCH', { action: 'open', agentId: stranger.id, sessionId: session.id })).status, 500);
    assert.equal((await request('/workspace', 'PATCH', { action: 'select', tabId: randomUUID() })).status, 500);
    await request('/workspace', 'PATCH', { action: 'close', tabId });
    assert.equal(sessions.get(session.id)?.info.status, 'running');
    assert.equal(store.get().workspace.activeTabId, null);
    function connect(takeover = false) { const ws = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal/${session.id}?takeover=${takeover}`, { headers: { Cookie: cookie, Origin: origin } }); sockets.push(ws); return ws; }
    const first = connect(); await nextMessage(first, v => v.type === 'snapshot');
    const reply = nextMessage(first, v => v.type === 'output' && v.data.includes('REPLY:hello'));
    first.send(JSON.stringify({ type: 'input', data: 'hello\r' })); await reply;
    first.close(); await once(first, 'close');
    assert.equal(sessions.get(session.id)?.info.status, 'running');
    const second = connect(); const snapshot = await nextMessage(second, v => v.type === 'snapshot');
    assert.match(snapshot.data, /REPLY:hello/); assert.equal(spawns, 1);
    const blocked = connect(); const [code] = await once(blocked, 'close'); assert.equal(code, 4001);
    const transferred = once(second, 'close');
    const third = connect(true); await nextMessage(third, v => v.type === 'snapshot'); assert.equal((await transferred)[0], 4001);
    third.send(JSON.stringify({ type: 'resize', cols: 90, rows: 25 }));
    const more = nextMessage(third, v => v.type === 'output' && v.data.includes('REPLY:again'));
    third.send(JSON.stringify({ type: 'input', data: 'again\r' })); await more;
    assert.equal((await request(`/agents/${agent.id}`, 'DELETE')).status, 409);
    const resumed = await (await request('/sessions', 'POST', { agentId: agent.id, historyId: historicalId })).json();
    const duplicate = await (await request('/sessions', 'POST', { agentId: agent.id, historyId: historicalId })).json();
    assert.equal(resumed.id, duplicate.id); assert.equal(resumed.cwd, '/existing');
    await store.update(c => { c.agents.find(a => a.id === agent.id)!.initScript = 'export MAM_TEST_ENV=changed'; });
    const changed = await (await request('/sessions', 'POST', { agentId: agent.id, historyId: historicalId })).json();
    assert.notEqual(changed.id, resumed.id);
    assert.notEqual(changed.initScriptKey, resumed.initScriptKey);
    assert.equal(sessions.get(resumed.id)?.info.status, 'running');
    await request(`/sessions/${session.id}`, 'DELETE');
    assert.equal(sessions.list().some(s => s.id === session.id), false);
    const unauthorized = new WebSocket(`${origin.replace('http:', 'ws:')}/terminal/${resumed.id}`, { headers: { Cookie: cookie, Origin: 'https://attacker.invalid' } });
    unauthorized.on('error', () => {});
    const rejection = await new Promise<number | undefined>(resolve => unauthorized.on('unexpected-response', (_req, res) => { resolve(res.statusCode); res.resume(); unauthorized.terminate(); }));
    assert.equal(rejection, 403);
    await delay(20);
  } finally { for (const ws of sockets) ws.terminate(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});
