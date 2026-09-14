import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import serialization from '@xterm/addon-serialize';
import { WebSocket } from 'ws';
import type { IPty } from 'node-pty';
import { initScriptKey, type Agent } from './config.js';
import { spawnTerminal } from './ssh.js';
import type { AgentRegistry } from './agents/registry.js';
import type { LaunchPlan } from './agents/types.js';

const { Terminal } = headless;
const { SerializeAddon } = serialization;
export type TerminalFactory = (agent: Agent, command: string, cols: number, rows: number) => IPty;
export interface SessionInfo {
  id: string; agentId: string; agentName: string; type: Agent['type']; connection: Agent['connection']; target: string; configDir: string;
  initScriptKey: string; agentSessionId?: string; cwd: string; status: 'running' | 'exited'; created: number; exitCode?: number;
}
export class Session {
  readonly info: SessionInfo;
  private terminal = new Terminal({ cols: 100, rows: 30, scrollback: 1500, allowProposedApi: true });
  private serializer = new SerializeAddon();
  private process: IPty;
  private viewer?: WebSocket;
  private attaching?: WebSocket;
  private paused = false;
  private pending = '';
  private pendingBytes = 0;
  private timer?: NodeJS.Timeout;
  private termination?: NodeJS.Timeout;
  private disposed = false;
  private stopping = false;
  private transportClosed = false;
  private idleTimer?: NodeJS.Timeout;
  private idController = new AbortController();
  constructor(agent: Agent, cwd: string, plan: LaunchPlan, factory: TerminalFactory) {
    this.info = { id: randomUUID(), agentId: agent.id, agentName: agent.name, type: agent.type, connection: agent.connection, target: agent.target, configDir: agent.configDir, initScriptKey: initScriptKey(agent), agentSessionId: plan.agentSessionId, cwd, status: 'running', created: Date.now() };
    this.terminal.loadAddon(this.serializer);
    this.process = factory(agent, plan.command, 100, 30);
    // Adopt the agent-minted thread id in the background; the terminal is usable immediately
    // whether or not the id ever resolves, so a slow first message never blocks or fails launch.
    if (plan.resolveSessionId) plan.resolveSessionId(this.idController.signal).then(id => {
      if (id && !this.disposed) this.info.agentSessionId = id;
    }).catch(() => {});
    this.terminal.onData(data => {
      if (!this.viewer && !this.transportClosed && !this.disposed) this.process.write(data);
    });
    this.process.onData(data => {
      if (this.disposed || this.transportClosed) return;
      this.pendingBytes += Buffer.byteLength(data);
      if (this.pendingBytes > 512 * 1024 && !this.paused) { this.process.pause(); this.paused = true; }
      this.pending += data;
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 16);
    });
    this.process.onExit(({ exitCode }) => {
      this.transportClosed = true;
      clearTimeout(this.termination);
      if (this.disposed) return;
      this.flush();
      this.terminal.write('', () => {
        if (this.disposed) return;
        this.info.status = 'exited'; this.info.exitCode = exitCode;
        this.send({ type: 'status', status: 'exited', exitCode });
        this.scheduleDisposal();
      });
    });
  }
  private flush() {
    clearTimeout(this.timer); this.timer = undefined;
    const data = this.pending; this.pending = '';
    if (!data || this.disposed) return;
    this.terminal.write(data, () => {
      this.pendingBytes -= Buffer.byteLength(data);
      if (this.paused && this.pendingBytes < 128 * 1024 && !this.transportClosed && !this.disposed) { this.process.resume(); this.paused = false; }
      if (!this.disposed) this.send({ type: 'output', data });
    });
  }
  private send(value: unknown) {
    const socket = this.viewer;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 2 * 1024 * 1024) { socket.close(4002, 'Client too slow; reconnect'); return; }
    socket.send(JSON.stringify(value));
  }
  attach(socket: WebSocket, takeover: boolean) {
    if (this.disposed) { socket.close(4004, 'Session expired'); return; }
    const owner = this.attaching ?? this.viewer;
    if (owner && owner.readyState === WebSocket.OPEN) {
      if (!takeover) { socket.close(4001, 'Already controlled in another page'); return; }
      owner.close(4001, 'Control transferred');
    }
    clearTimeout(this.idleTimer); this.idleTimer = undefined;
    this.attaching = socket;
    // Queue the snapshot behind parsed output so reconnection cannot replay a chunk twice.
    this.flush();
    this.viewer = undefined;
    this.terminal.write('', () => {
      if (this.disposed || this.attaching !== socket || socket.readyState !== WebSocket.OPEN) return;
      this.attaching = undefined; this.viewer = socket;
      this.send({ type: 'snapshot', data: this.serializer.serialize(), cols: this.terminal.cols, rows: this.terminal.rows, status: this.info.status });
    });
    socket.on('close', () => { if (this.viewer === socket) this.viewer = undefined; if (this.attaching === socket) this.attaching = undefined; this.scheduleDisposal(); });
  }
  input(socket: WebSocket, data: string) { if (socket === this.viewer && this.info.status === 'running' && !this.transportClosed) this.process.write(data); }
  resize(socket: WebSocket, cols: number, rows: number) {
    if (socket !== this.viewer || this.disposed) return;
    this.flush();
    this.terminal.write('', () => {
      if (this.disposed || socket !== this.viewer) return;
      this.terminal.resize(cols, rows);
      if (!this.transportClosed) this.process.resize(cols, rows);
    });
  }
  stop() {
    if (this.transportClosed || this.stopping) return;
    this.stopping = true;
    this.process.kill('SIGHUP');
    this.termination = setTimeout(() => { if (!this.transportClosed) this.process.kill('SIGKILL'); }, 1500);
    this.termination.unref();
  }
  private scheduleDisposal() {
    if (this.disposed || this.info.status !== 'exited' || this.viewer || this.attaching || this.idleTimer) return;
    this.idleTimer = setTimeout(() => this.dispose(), 5 * 60_000);
    this.idleTimer.unref();
  }
  isDisposed() { return this.disposed; }
  dispose() {
    if (this.disposed) return;
    this.stop(); this.disposed = true; this.idController.abort();
    this.info.status = 'exited';
    this.attaching?.close(4004, 'Session closed'); this.attaching = undefined;
    clearTimeout(this.timer); clearTimeout(this.idleTimer);
    this.viewer?.close(4004, 'Session closed'); this.viewer = undefined;
    this.terminal.dispose();
  }
}
export class Sessions {
  private sessions = new Map<string, Session>();
  private creationQueues = new Map<string, Promise<unknown>>();
  constructor(private factory: TerminalFactory = spawnTerminal, private registry?: AgentRegistry) {}
  setRegistry(registry: AgentRegistry) { this.registry ??= registry; }
  list() {
    for (const [id, session] of this.sessions) if (session.isDisposed()) this.sessions.delete(id);
    return [...this.sessions.values()].map(s => ({ ...s.info }));
  }
  get(id: string) { return this.sessions.get(id); }
  find(agent: Agent, agentSessionId: string) {
    return [...this.sessions.values()].find(s => s.info.type === agent.type && s.info.connection === agent.connection && s.info.target === agent.target && s.info.configDir === agent.configDir && s.info.initScriptKey === initScriptKey(agent) && s.info.agentSessionId === agentSessionId && s.info.status === 'running');
  }
  async create(agent: Agent, cwd: string, agentSessionId: string | undefined, picker: boolean) {
    const existing = agentSessionId && this.find(agent, agentSessionId);
    if (existing) return existing;
    if (this.list().length >= 30) throw new Error('会话数量已达 30，请先关闭闲置会话');
    if (!this.registry) throw new Error('Agent adapter registry 未配置');
    const key = JSON.stringify([agent.type, agent.connection, agent.target, agent.configDir, initScriptKey(agent)]);
    const previous = this.creationQueues.get(key) ?? Promise.resolve();
    const task = previous.then(async () => {
      const duplicate = agentSessionId && this.find(agent, agentSessionId);
      if (duplicate) return duplicate;
      const plan = await this.registry!.for(agent).prepareLaunch(agent, cwd, agentSessionId, picker);
      const session = new Session(agent, cwd, plan, this.factory);
      this.sessions.set(session.info.id, session);
      return session;
    });
    this.creationQueues.set(key, task);
    task.finally(() => { if (this.creationQueues.get(key) === task) this.creationQueues.delete(key); }).catch(() => {});
    return task;
  }
  close() { for (const session of this.sessions.values()) session.dispose(); this.sessions.clear(); }
}
