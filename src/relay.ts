import { createServer, request, type IncomingMessage } from 'node:http';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import { equalSecret } from './auth.js';

export function relayOrigin(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
    throw new Error('Relay 地址须为 HTTPS origin（本机测试可用 HTTP），不能包含路径或凭证');
  }
  return url.origin;
}

const MAX_CONNECTIONS = 128;
const MAX_BUFFER = 4 * 1024 * 1024;
function streamFor(ws: WebSocket) {
  const stream = createWebSocketStream(ws);
  const timer = setInterval(() => { if (ws.bufferedAmount > MAX_BUFFER) stream.destroy(); }, 1000);
  timer.unref();
  stream.on('error', () => {});
  stream.once('close', () => { clearInterval(timer); ws.terminate(); });
  return stream;
}

export function createRelay(options: { origin: string; key: string }) {
  const origin = relayOrigin(options.origin);
  if (options.key.length < 32) throw new Error('AGENT_HUB_RELAY_KEY 至少需要 32 个字符');
  let agent: WebSocket | undefined;
  const active = new Set<Duplex>();
  const pending = new Map<string, { resolve: (stream: Duplex) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  function openTunnel(): Promise<Duplex> {
    if (!agent || agent.readyState !== WebSocket.OPEN) return Promise.reject(new Error('设备离线'));
    if (active.size + pending.size >= MAX_CONNECTIONS) return Promise.reject(new Error('连接数已达上限'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('连接设备超时')); }, 10000);
      pending.set(id, { resolve, reject, timer });
      agent!.send(JSON.stringify({ id }));
    });
  }
  function disconnect() {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('设备离线')); }
    pending.clear();
    for (const stream of active) stream.destroy();
    active.clear();
  }
  function validHost(req: IncomingMessage) { return req.headers.host === new URL(origin).host; }
  server.on('request', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!validHost(req)) { res.writeHead(403).end(); return; }
    if (req.url?.startsWith('/_relay/')) { res.writeHead(404).end(); return; }
    try {
      const stream = await openTunnel();
      if (res.destroyed) { stream.destroy(); return; }
      const upstream = request({ host: 'localhost', method: req.method, path: req.url, headers: { ...req.headers, connection: 'close' }, createConnection: () => stream }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      res.on('close', () => { upstream.destroy(); stream.destroy(); });
      const timer = setTimeout(() => upstream.destroy(), 60000);
      res.once('close', () => clearTimeout(timer));
      req.pipe(upstream);
    } catch { res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Agent Hub 设备离线或暂时无法连接'); }
  });
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => {});
    if (!validHost(req)) { socket.destroy(); return; }
    const url = new URL(req.url!, origin);
    if (url.pathname.startsWith('/_relay/')) {
      if (!equalSecret(req.headers.authorization, `Bearer ${options.key}`) || req.headers.origin) { socket.destroy(); return; }
      if (url.pathname === '/_relay/agent' && !agent) {
        wss.handleUpgrade(req, socket, head, ws => {
          agent = ws; watchPong(ws);
          ws.on('error', () => {});
          ws.once('close', () => { if (agent === ws) { agent = undefined; disconnect(); } });
          ws.on('message', () => ws.close(1008));
        });
      } else if (url.pathname === '/_relay/tunnel' && pending.has(url.searchParams.get('id') ?? '')) {
        const id = url.searchParams.get('id')!;
        const item = pending.get(id)!;
        pending.delete(id); clearTimeout(item.timer);
        wss.handleUpgrade(req, socket, head, ws => {
          watchPong(ws);
          const stream = streamFor(ws); active.add(stream);
          stream.once('close', () => active.delete(stream));
          item.resolve(stream);
        });
      } else socket.destroy();
      return;
    }
    if (req.headers.origin !== origin || !/^\/(terminal|shell)\/[a-f0-9-]+(?:\?|$)/.test(req.url!)) { socket.destroy(); return; }
    try {
      const stream = await openTunnel();
      if (socket.destroyed) { stream.destroy(); return; }
      const headers = req.rawHeaders.reduce((text, value, i) => text + (i % 2 ? `${value}\r\n` : `${value}: `), '');
      stream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n`);
      if (head.length) stream.write(head);
      stream.pipe(socket); socket.pipe(stream);
      socket.once('close', () => stream.destroy());
      stream.once('close', () => { if (!stream.readableEnded) socket.destroy(); });
    } catch { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); }
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const client = ws as WebSocket & { alive?: boolean };
      if (client.alive === false) { client.terminate(); continue; }
      client.alive = false; client.ping();
    }
  }, 15000);
  heartbeat.unref();
  function watchPong(ws: WebSocket) { ws.on('pong', () => { (ws as WebSocket & { alive?: boolean }).alive = true; }); }
  return {
    async listen(port: number) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
      return (server.address() as { port: number }).port;
    },
    async close() {
      clearInterval(heartbeat); disconnect();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}

export function connectRelay(options: { origin: string; key: string; localOrigin: string; onStatus?: (connected: boolean) => void }) {
  const origin = relayOrigin(options.origin);
  const local = new URL(options.localOrigin);
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1') throw new Error('Relay 只允许连接本机 Agent Hub');
  const base = origin.replace(/^http/, 'ws');
  let stopped = false;
  let control: WebSocket;
  let retry: NodeJS.Timeout | undefined;
  let backoff = 1000;
  let watchdog: NodeJS.Timeout | undefined;
  const sockets = new Set<WebSocket>();
  function start() {
    control = new WebSocket(`${base}/_relay/agent`, { headers: { Authorization: `Bearer ${options.key}` }, handshakeTimeout: 10000, maxPayload: 4096 });
    control.on('error', () => {});
    const alive = () => { clearTimeout(watchdog); watchdog = setTimeout(() => control.terminate(), 45000); watchdog.unref(); };
    control.on('ping', alive);
    control.on('open', () => { alive(); backoff = 1000; options.onStatus?.(true); });
    control.on('message', data => {
      let id: string;
      try { id = JSON.parse(data.toString()).id; if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error(); }
      catch { control.close(1008); return; }
      if (sockets.size >= MAX_CONNECTIONS) return;
      const ws = new WebSocket(`${base}/_relay/tunnel?id=${id}`, { headers: { Authorization: `Bearer ${options.key}` }, handshakeTimeout: 10000, maxPayload: 1024 * 1024 });
      sockets.add(ws); ws.on('error', () => {}); ws.once('close', () => sockets.delete(ws));
      ws.once('open', () => {
        const stream = streamFor(ws);
        const target = connect(Number(local.port), '127.0.0.1');
        target.on('error', () => stream.destroy());
        target.once('close', hadError => { if (hadError || !target.readableEnded) stream.destroy(); });
        stream.once('close', () => target.destroy());
        stream.pipe(target); target.pipe(stream);
      });
    });
    control.once('close', () => {
      clearTimeout(watchdog);
      for (const ws of sockets) ws.terminate();
      options.onStatus?.(false);
      if (!stopped) { retry = setTimeout(start, backoff); backoff = Math.min(30000, backoff * 2); }
    });
  }
  start();
  return { close() { stopped = true; clearTimeout(retry); clearTimeout(watchdog); control.terminate(); for (const ws of sockets) ws.terminate(); } };
}
