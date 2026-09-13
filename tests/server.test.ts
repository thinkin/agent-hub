import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
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
  const app = await createApp({ store, sessions, registry: new AgentRegistry([claude]) });
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
    assert.equal((await request('/sessions', 'POST', { agentId: agent.id, cwd: 'bad\u0000path' })).status, 400);
    const response = await request('/sessions', 'POST', { agentId: agent.id });
    assert.equal(response.status, 201);
    const session = await response.json();
    assert.equal((await fetch(`${origin}/api/workspace`)).status, 401);
    assert.equal((await request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id, title: 'private' })).status, 400);
    const opened = await (await request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id })).json();
    const tabId = opened.agents[agent.id].activeTabId;
    await Promise.all([request('/workspace', 'PATCH', { action: 'open', agentId: agent.id, sessionId: session.id }), request('/workspace', 'PATCH', { action: 'agent', agentId: agent.id })]);
    const workspace = await (await request('/workspace')).json();
    assert.equal(workspace.agents[agent.id].tabs.length, 1);
    assert.equal(workspace.selectedAgentId, agent.id);
    assert.deepEqual((await new ConfigStore(directory).load()).get().workspace, workspace);
    const stranger = { ...agent, id: randomUUID(), target: 'other-host' };
    await store.update(c => c.agents.push(stranger));
    assert.equal((await request('/workspace', 'PATCH', { action: 'open', agentId: stranger.id, sessionId: session.id })).status, 500);
    assert.equal((await request('/workspace', 'PATCH', { action: 'select', agentId: agent.id, tabId: randomUUID() })).status, 500);
    await request('/workspace', 'PATCH', { action: 'close', agentId: agent.id, tabId });
    assert.equal(sessions.get(session.id)?.info.status, 'running');
    assert.equal(store.get().workspace.agents[agent.id].activeTabId, null);
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
