import test from 'node:test';
import assert from 'node:assert/strict';
import { request, createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import * as pty from 'node-pty';
import { ConfigStore, agentInput } from '../src/config.js';
import { createApp } from '../src/server.js';
import { Sessions } from '../src/sessions.js';
import { connectRelay, createRelay, relayOrigin } from '../src/relay.js';

async function port() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve())); return value;
}
function message(ws: WebSocket, matches: (data: any) => boolean) {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', receive); reject(new Error('terminal timeout')); }, 5000);
    function receive(data: Buffer) { const value = JSON.parse(data.toString()); if (matches(value)) { clearTimeout(timer); ws.off('message', receive); resolve(value); } }
    ws.on('message', receive);
  });
}

test('relay validates public origins and device credentials', () => {
  for (const origin of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=x']) assert.throws(() => relayOrigin(origin));
  assert.equal(relayOrigin('https://example.com/'), 'https://example.com');
  assert.throws(() => createRelay({ origin: 'https://example.com', key: 'short' }));
});

test('reverse relay forwards authenticated HTTP and PTY, reconnects without ending sessions', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-relay-'));
  const store = await new ConfigStore(directory).load();
  const agent = { ...agentInput.parse({ name: 'Synthetic', connection: 'local', target: 'localhost', configDir: directory, cwd: directory }), id: randomUUID() };
  await store.update(config => config.agents.push(agent));
  let resized!: () => void;
  const resizeDone = new Promise<void>(resolve => { resized = resolve; });
  const sessions = new Sessions((_agent, _command, cols, rows) => {
    const process = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'printf "READY\\n"; while IFS= read -r line; do printf "ECHO:%s\\n" "$line"; done'], { cols, rows, name: 'xterm-256color' });
    const resize = process.resize.bind(process);
    process.resize = (cols, rows) => { resize(cols, rows); resized(); };
    return process;
  });
  const relayPort = await port();
  const origin = `http://127.0.0.1:${relayPort}`;
  const key = 'synthetic-relay-key-with-at-least-32-characters';
  let relay = createRelay({ origin, key });
  await relay.listen(relayPort);
  const app = await createApp({ store, sessions, remoteOrigin: origin });
  const localOrigin = await app.listen(0);
  let tunnel: ReturnType<typeof connectRelay> | undefined;
  const sockets: WebSocket[] = [];
  try {
    assert.equal((await fetch(`${origin}/api/config`)).status, 503);
    const denied = new WebSocket(`${origin.replace('http', 'ws')}/_relay/agent`, { headers: { Authorization: 'Bearer wrong' } });
    denied.on('error', () => {}); await new Promise<void>(resolve => denied.once('close', () => resolve()));
    let ready!: () => void;
    const connected = new Promise<void>(resolve => { ready = resolve; });
    tunnel = connectRelay({ origin, key, localOrigin, onStatus: connected => { if (connected) ready(); } });
    await connected;
    const duplicate = new WebSocket(`${origin.replace('http', 'ws')}/_relay/agent`, { headers: { Authorization: `Bearer ${key}` } });
    duplicate.on('error', () => {}); await new Promise<void>(resolve => duplicate.once('close', () => resolve()));
    assert.equal((await fetch(`${origin}/api/config`)).status, 401);
    assert.equal((await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) })).status, 403);
    assert.equal((await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'wrong' }) })).status, 401);
    const auth = await fetch(`${origin}/api/auth`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: app.token }) });
    assert.equal(auth.status, 200);
    const cookie = auth.headers.get('set-cookie')!.split(';')[0];
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    assert.equal((await fetch(`${origin}/api/config`, { headers })).status, 200);
    assert.equal((await fetch(`${localOrigin}/api/config`)).status, 401);
    const response = await fetch(`${origin}/api/sessions`, { method: 'POST', headers, body: JSON.stringify({ agentId: agent.id }) });
    assert.equal(response.status, 201); const session = await response.json();
    const open = () => { const ws = new WebSocket(`${origin.replace('http', 'ws')}/terminal/${session.id}`, { headers }); sockets.push(ws); return ws; };
    const unauthorized = new WebSocket(`${origin.replace('http', 'ws')}/terminal/${session.id}`, { headers: { Origin: origin } });
    let status = 0;
    unauthorized.on('error', () => {});
    unauthorized.on('unexpected-response', (_req, res) => { status = res.statusCode!; unauthorized.terminate(); });
    await new Promise<void>(resolve => unauthorized.once('close', () => resolve()));
    assert.equal(status, 403);
    const ws = open();
    await message(ws, data => data.type === 'snapshot');
    const output = message(ws, data => data.type === 'output' && data.data.includes('ECHO:hello'));
    ws.send(JSON.stringify({ type: 'input', data: 'hello\r' })); await output;
    ws.send(JSON.stringify({ type: 'resize', cols: 91, rows: 31 }));
    await resizeDone;
    await relay.close();
    assert.equal(sessions.get(session.id)?.info.status, 'running');
    const reconnected = new Promise<void>(resolve => { ready = resolve; });
    relay = createRelay({ origin, key }); await relay.listen(relayPort); await reconnected;
    const next = open(); const snapshot = await message(next, data => data.type === 'snapshot');
    assert.match(snapshot.data, /ECHO:hello/);
    assert.equal(snapshot.cols, 91); assert.equal(snapshot.rows, 31);
    const second = message(next, data => data.type === 'output' && data.data.includes('ECHO:again'));
    next.send(JSON.stringify({ type: 'input', data: 'again\r' })); await second;
    assert.equal(sessions.list().length, 1);
  } finally {
    for (const ws of sockets) ws.terminate();
    tunnel?.close(); await relay.close(); await app.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('HTTPS relay cookies are Secure and Host must match Origin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-hub-relay-secure-'));
  const store = await new ConfigStore(directory).load();
  const app = await createApp({ store, remoteOrigin: 'https://hub.example.com' });
  const local = await app.listen(0);
  try {
    const headers = { Host: 'hub.example.com', Origin: 'https://hub.example.com', 'Content-Type': 'application/json' };
    const auth = (origin: string) => new Promise<{ status: number; cookie: string; csp: string }>((resolve, reject) => {
      const req = request(`${local}/api/auth`, { method: 'POST', headers: { ...headers, Origin: origin } }, res => {
        res.resume(); res.once('end', () => resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0] ?? '', csp: String(res.headers['content-security-policy']) }));
      });
      req.on('error', reject); req.end(JSON.stringify({ token: app.token }));
    });
    const response = await auth('https://hub.example.com');
    assert.equal(response.status, 200);
    assert.match(response.cookie, /; Secure/);
    assert.match(response.csp, /wss:\/\/hub\.example\.com/);
    assert.equal((await auth(local)).status, 403);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('relay drains a large HTTP response before closing the tunnel', { timeout: 15000 }, async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 'x');
  const backend = createHttpServer((_req, res) => { res.writeHead(200, { 'Content-Length': payload.length }); res.end(payload); });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const localOrigin = `http://127.0.0.1:${(backend.address() as { port: number }).port}`;
  const relayPort = await port(); const origin = `http://127.0.0.1:${relayPort}`;
  const key = 'synthetic-large-http-response-relay-key';
  const relay = createRelay({ origin, key }); await relay.listen(relayPort);
  let tunnel: ReturnType<typeof connectRelay> | undefined;
  try {
    await new Promise<void>(resolve => { tunnel = connectRelay({ origin, key, localOrigin, onStatus: connected => { if (connected) resolve(); } }); });
    for (let attempt = 0; attempt < 3; attempt++) {
      const received = await new Promise<Buffer>((resolve, reject) => {
        const req = request(origin, res => {
          const chunks: Buffer[] = [];
          res.on('data', chunk => { chunks.push(chunk); res.pause(); setTimeout(() => res.resume(), 2); });
          res.on('error', reject); res.once('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject); req.end();
      });
      assert.ok(received.equals(payload));
    }
  } finally {
    tunnel?.close(); await relay.close();
    await new Promise<void>(resolve => { backend.close(() => resolve()); backend.closeAllConnections(); });
  }
});
