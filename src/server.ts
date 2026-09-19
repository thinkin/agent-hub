import express from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { z, ZodError } from 'zod';
import { ConfigStore, agentInput, batchInput, discoverInput, initScriptKey, workingDirectory, MAX_RECENT_CWDS, hostKey, type Agent } from './config.js';
import { AgentRegistry } from './agents/registry.js';
import type { AgentAdapter } from './agents/types.js';
import { AuxiliaryShells, Sessions } from './sessions.js';
import { gitDiff, gitStatus } from './git.js';
import { runRemote } from './ssh.js';

export function equalSecret(actual: string | undefined, expected: string) {
  return !!actual && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export async function createApp(options: { store: ConfigStore; sessions?: Sessions; auxiliaryShells?: AuxiliaryShells; registry?: AgentRegistry; runCommand?: (agent: Agent, command: string, input?: string, signal?: AbortSignal) => Promise<string>; dev?: boolean }) {
  const { store } = options;
  const registry = options.registry ?? new AgentRegistry();
  const sessions = options.sessions ?? new Sessions(undefined, registry);
  const auxiliaryShells = options.auxiliaryShells ?? new AuxiliaryShells();
  const runCommand = options.runCommand ?? runRemote;
  sessions.setRegistry(registry);
  sessions.setSessionIdListener((session, agentSessionId) => {
    const tab = store.get().workspace.tabs.find(tab => tab.sessionId === session.id);
    if (!tab || tab.agentSessionId === agentSessionId) return;
    void store.update(config => {
      const current = config.workspace.tabs.find(tab => tab.sessionId === session.id);
      if (current) current.agentSessionId = agentSessionId;
    }).catch(() => {});
  });
  const token = randomBytes(32).toString('hex');
  const cookie = randomBytes(32).toString('hex');
  const cookieName = `mam_${randomBytes(6).toString('hex')}`;
  const app = express();
  app.disable('x-powered-by');
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  let origin = '';
  function authenticated(cookies = '') {
    const value = cookies.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return equalSecret(value, cookie);
  }
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'");
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) { res.status(403).json({ error: '请求来源不被允许' }); return; }
    if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) { res.status(403).json({ error: '缺少可信来源' }); return; }
    next();
  });
  app.use(express.json({ limit: '32kb' }));
  app.post('/api/auth', (req, res) => {
    if (typeof req.body?.token !== 'string' || !equalSecret(req.body.token, token)) { res.status(401).json({ error: '访问令牌无效，请使用 CLI 输出的链接' }); return; }
    res.setHeader('Set-Cookie', `${cookieName}=${cookie}; HttpOnly; SameSite=Strict; Path=/`);
    res.json({ ok: true });
  });
  app.use('/api', (req, res, next) => {
    if (!authenticated(req.headers.cookie)) { res.status(401).json({ error: '请通过 CLI 输出的链接打开工作台' }); return; }
    next();
  });
  app.get('/api/config', (_req, res) => { const config = store.get(); res.json({ ...config, agents: config.agents.map(agent => ({ ...agent, initScriptKey: initScriptKey(agent) })) }); });
  app.get('/api/workspace', (_req, res) => res.json(store.get().workspace));
  app.patch('/api/workspace', async (req, res) => {
    const input = z.discriminatedUnion('action', [
      z.object({ action: z.literal('open'), agentId: z.string().uuid(), sessionId: z.string().uuid() }).strict(),
      z.object({ action: z.literal('select'), tabId: z.string().uuid() }).strict(),
      z.object({ action: z.literal('close'), tabId: z.string().uuid() }).strict(),
    ]).parse(req.body);
    const result = await store.update(c => {
      const workspace = c.workspace;
      if (input.action === 'open') {
        const agent = c.agents.find(a => a.id === input.agentId);
        if (!agent) throw new Error('Agent 不存在');
        const session = sessions.get(input.sessionId);
        if (!session || session.isDisposed() || session.info.type !== agent.type || session.info.connection !== agent.connection || session.info.target !== agent.target || session.info.configDir !== agent.configDir || session.info.initScriptKey !== initScriptKey(agent)) throw new Error('会话不属于当前 Agent 环境');
        const info = session.info;
        let tab = workspace.tabs.find(t => t.agentId === agent.id && t.type === info.type && t.connection === info.connection && t.target === info.target && t.configDir === info.configDir && (t.initScriptKey ?? initScriptKey({ ...agent, initScript: '' })) === info.initScriptKey && (t.sessionId === info.id || (!!info.agentSessionId && t.agentSessionId === info.agentSessionId)));
        if (tab) { tab.sessionId = info.id; if (info.agentSessionId) tab.agentSessionId = info.agentSessionId; }
        else {
          if (workspace.tabs.length >= 20) throw new Error('已达到 20 个 tab 上限，请先关闭一些对话');
          tab = { id: randomUUID(), agentId: agent.id, sessionId: info.id, agentSessionId: info.agentSessionId, cwd: info.cwd, type: info.type, connection: info.connection, target: info.target, configDir: info.configDir, initScriptKey: info.initScriptKey };
          // Keep tabs from the same agent adjacent by inserting after the last sibling.
          let insert = workspace.tabs.length;
          for (let i = workspace.tabs.length - 1; i >= 0; i--) if (workspace.tabs[i].agentId === agent.id) { insert = i + 1; break; }
          workspace.tabs.splice(insert, 0, tab);
        }
        workspace.activeTabId = tab.id;
      } else if (input.action === 'select') {
        if (!workspace.tabs.some(t => t.id === input.tabId)) throw new Error('Tab 不存在');
        workspace.activeTabId = input.tabId;
      } else {
        const index = workspace.tabs.findIndex(t => t.id === input.tabId);
        if (index < 0) return;
        workspace.tabs.splice(index, 1);
        if (workspace.activeTabId === input.tabId) workspace.activeTabId = workspace.tabs[Math.min(index, workspace.tabs.length - 1)]?.id ?? null;
      }
    });
    if (input.action === 'close') auxiliaryShells.closeTab(input.tabId);
    res.json(result.workspace);
  });
  app.patch('/api/settings', async (req, res) => {
    const { historyLimit } = z.object({ historyLimit: z.number().int().min(1).max(100) }).strict().parse(req.body);
    res.json(await store.update(c => { c.historyLimit = historyLimit; }));
  });
  app.post('/api/agents', async (req, res) => {
    const agent = { ...agentInput.parse(req.body), id: randomUUID() };
    await store.update(c => { c.agents.push(agent); });
    res.status(201).json(agent);
  });
  app.post('/api/agents/discover', async (req, res) => { res.json(await registry.discover(discoverInput.parse(req.body))); });
  app.post('/api/agents/batch', async (req, res) => {
    const agents = batchInput.parse(req.body).agents.map(agent => ({ ...agent, id: randomUUID() }));
    const result = await store.update(c => { c.agents.push(...agents); });
    res.status(201).json({ agents, workspace: result.workspace });
  });
  app.put('/api/agents/:id', async (req, res) => {
    const id = req.params.id;
    store.agent(id);
    const agent = { ...agentInput.parse(req.body), id };
    await store.update(c => { c.agents = c.agents.map(a => a.id === id ? agent : a); });
    res.json(agent);
  });
  app.delete('/api/agents/:id', async (req, res) => {
    const id = req.params.id;
    store.agent(id);
    if (sessions.list().some(s => s.agentId === id && s.status === 'running')) { res.status(409).json({ error: '请先结束该 Agent 的运行会话' }); return; }
    await store.update(c => { c.agents = c.agents.filter(a => a.id !== id); c.workspace.tabs = c.workspace.tabs.filter(t => t.agentId !== id); if (c.workspace.activeTabId && !c.workspace.tabs.some(t => t.id === c.workspace.activeTabId)) c.workspace.activeTabId = c.workspace.tabs[0]?.id ?? null; });
    auxiliaryShells.closeAgent(id);
    res.json({ ok: true });
  });
  app.post('/api/agents/probe', async (req, res) => { const agent = { ...agentInput.parse(req.body), id: randomUUID() }; res.json(await registry.for(agent).probe(agent)); });
  app.get('/api/agents/:id/history', async (req, res) => {
    const agent = store.agent(req.params.id);
    const { offset, limit, refresh } = z.object({ offset: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(store.get().historyLimit), refresh: z.enum(['true', 'false']).default('false') }).parse(req.query);
    res.json(await registry.for(agent).history(agent, offset, limit, refresh === 'true'));
  });
  app.get('/api/agents/:id/directories', async (req, res) => {
    const agent = store.agent(req.params.id);
    const { path } = z.object({ path: workingDirectory.default('~') }).parse(req.query);
    res.json(await registry.directories(agent, path));
  });
  app.get('/api/agents/:id/session-titles', async (req, res) => {
    const agent = store.agent(req.params.id);
    const tabs = store.get().workspace.tabs.filter(t => t.agentId === agent.id);
    const ids = [...new Set([...sessions.list(), ...tabs].filter(s => s.type === agent.type && s.connection === agent.connection && s.target === agent.target && s.configDir === agent.configDir && (s.initScriptKey ?? initScriptKey({ ...agent, initScript: '' })) === initScriptKey(agent) && s.agentSessionId).map(s => s.agentSessionId!))];
    res.json(ids.length ? await registry.for(agent).history(agent, 0, 100, false, undefined, ids.sort()) : { items: [], total: 0, warnings: [] });
  });
  app.get('/api/sessions', (_req, res) => res.json(sessions.list()));
  app.post('/api/sessions', async (req, res) => {
    const input = z.object({ agentId: z.string().uuid(), cwd: workingDirectory.optional(), historyId: z.string().uuid().optional(), picker: z.boolean().default(false) }).strict().parse(req.body);
    const agent = store.agent(input.agentId);
    let cwd = input.cwd ?? agent.cwd;
    let agentSessionId: string | undefined;
    if (input.historyId) {
      const existing = sessions.find(agent, input.historyId);
      if (existing) { res.json(existing.info); return; }
      const history = await registry.for(agent).history(agent, 0, 1, true, input.historyId);
      const item = history.items.find(item => item.id === input.historyId);
      if (!item) { res.status(404).json({ error: 'Agent 历史已删除或不可读取' }); return; }
      if (!item.cwd) { res.status(422).json({ error: '该历史缺少工作目录，请使用原生历史选择器恢复' }); return; }
      cwd = workingDirectory.parse(item.cwd); agentSessionId = item.id;
    }
    const session = await sessions.create(agent, cwd, agentSessionId, input.picker);
    if (input.cwd) await store.update(c => { const key = hostKey(agent); c.recentCwds[key] = [input.cwd!, ...(c.recentCwds[key] ?? []).filter(x => x !== input.cwd)].slice(0, MAX_RECENT_CWDS); });
    res.status(201).json(session.info);
  });
  app.delete('/api/sessions/:id', (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) { res.status(404).json({ error: '会话不存在' }); return; }
    session.dispose();
    res.json({ ok: true });
  });
  function workspaceContext(tabId: string) {
    const tab = store.get().workspace.tabs.find(item => item.id === tabId);
    if (!tab) throw new Error('工作区不存在');
    const agent = store.agent(tab.agentId);
    if (tab.type !== agent.type || tab.connection !== agent.connection || tab.target !== agent.target || tab.configDir !== agent.configDir || (tab.initScriptKey ?? initScriptKey({ ...agent, initScript: '' })) !== initScriptKey(agent)) throw new Error('Agent 环境已更改');
    return { tab, agent };
  }
  app.post('/api/workspace/:tabId/shell', (req, res) => {
    const { tab, agent } = workspaceContext(z.string().uuid().parse(req.params.tabId));
    res.status(201).json(auxiliaryShells.create(tab.id, agent, tab.cwd).info);
  });
  app.delete('/api/workspace/:tabId/shell', (req, res) => {
    const { tab } = workspaceContext(z.string().uuid().parse(req.params.tabId));
    auxiliaryShells.closeTab(tab.id);
    res.json({ ok: true });
  });
  app.get('/api/workspace/:tabId/git/status', async (req, res) => {
    const { tab, agent } = workspaceContext(z.string().uuid().parse(req.params.tabId));
    res.json(await gitStatus(agent, tab.cwd, runCommand));
  });
  app.get('/api/workspace/:tabId/git/diff', async (req, res) => {
    const input = z.object({ path: z.string().min(1).max(4096), kind: z.enum(['staged', 'unstaged', 'untracked']) }).parse(req.query);
    const { tab, agent } = workspaceContext(z.string().uuid().parse(req.params.tabId));
    res.json(await gitDiff(agent, tab.cwd, input.path, input.kind, runCommand));
  });
  app.use('/api', (_req, res) => { res.status(404).json({ error: '接口不存在' }); });
  let vite: { close(): Promise<void> } | undefined;
  if (options.dev) {
    const { createServer: createVite } = await import('vite');
    const dev = await createVite({ server: { middlewareMode: true, hmr: false }, appType: 'spa' });
    app.use(dev.middlewares); vite = dev;
  } else {
    const root = fileURLToPath(new URL('./web', import.meta.url));
    app.use(express.static(root));
    app.get('/', (_req, res) => res.sendFile(`${root}/index.html`));
  }
  app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error instanceof ZodError || error instanceof SyntaxError ? 400 : 500).json({ error: error instanceof ZodError ? error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') : error.message });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.headers.host !== new URL(origin).host || req.headers.origin !== origin || !authenticated(req.headers.cookie)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
    const url = new URL(req.url!, origin);
    const match = /^\/(terminal|shell)\/([a-f0-9-]+)$/.exec(url.pathname);
    const session = match && (match[1] === 'terminal' ? sessions.get(match[2]) : auxiliaryShells.get(match[2]));
    if (!session || session.isDisposed()) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      session.attach(ws, url.searchParams.get('takeover') === 'true');
      ws.on('message', buffer => {
        try {
          const message = z.discriminatedUnion('type', [
            z.object({ type: z.literal('input'), data: z.string().max(16000) }),
            z.object({ type: z.literal('resize'), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(200) }),
          ]).parse(JSON.parse(buffer.toString()));
          if (message.type === 'input') session.input(ws, message.data);
          else session.resize(ws, message.cols, message.rows);
        } catch { ws.close(1008, 'Invalid terminal message'); }
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const client = ws as typeof ws & { alive?: boolean; initialized?: boolean };
      if (client.alive === false) { client.terminate(); continue; }
      if (!client.initialized) { client.on('pong', () => { client.alive = true; }); client.initialized = true; }
      client.alive = false; client.ping();
    }
  }, 15000);
  heartbeat.unref();
  return {
    token, sessions,
    async listen(port = 4317) {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', reject);
          origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          resolve();
        });
      });
      return origin;
    },
    async close() {
      clearInterval(heartbeat); registry.close(); sessions.close(); auxiliaryShells.close();
      for (const ws of wss.clients) ws.terminate();
      wss.close(); await vite?.close();
      await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
    },
  };
}
