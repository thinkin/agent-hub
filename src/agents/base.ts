import { readFile } from 'node:fs/promises';
import { initScriptKey, type Agent } from '../config.js';
import { quote, remotePath, runRemote } from '../ssh.js';
import { historyResult, type AgentAdapter, type HistoryResult, type LaunchPlan } from './types.js';

export type AgentRunner = typeof runRemote;

export abstract class BaseAgentAdapter implements AgentAdapter {
  abstract readonly type: Agent['type'];
  abstract readonly label: string;
  abstract readonly defaultExecutable: string;
  private cache = new Map<string, { expires: number; value: Promise<HistoryResult> }>();
  private queue = Promise.resolve();
  protected controller = new AbortController();

  constructor(protected run: AgentRunner = runRemote) {}

  protected abstract configEnvironment(agent: Agent): string;
  protected abstract validateHelp(output: string): void;
  abstract prepareLaunch(agent: Agent, cwd: string, sessionId?: string, picker?: boolean): Promise<LaunchPlan>;

  protected environment(agent: Agent) {
    return (agent.initScript.trim() ? `set -e\neval ${quote(agent.initScript)} </dev/null\n` : '') + this.configEnvironment(agent);
  }

  protected executable(agent: Agent) { return remotePath(agent.executable); }

  protected inDirectory(agent: Agent, cwd: string, command: string) {
    return `${this.environment(agent)}cd -- ${remotePath(cwd)} && ${command}`;
  }

  async probe(agent: Agent) {
    const output = await this.run(agent, this.inDirectory(agent, agent.cwd, `${this.executable(agent)} --help && printf '\n__AGENT_HUB_PYTHON__\n' && python3 --version`), '', this.controller.signal);
    this.validateHelp(output);
    if (!output.includes('Python 3')) throw new Error(`${this.label} 历史读取需要 Python 3`);
    return { ok: true as const, message: `${agent.connection === 'local' ? '本机' : 'SSH'}、${this.label} 会话恢复及 Python 3 检查通过` };
  }

  history(agent: Agent, offset: number, limit: number, refresh = false, sessionId?: string, sessionIds?: string[]): Promise<HistoryResult> {
    const key = JSON.stringify([this.type, agent.connection, agent.target, agent.configDir, initScriptKey(agent), offset, limit, sessionId, sessionIds]);
    const cached = this.cache.get(key);
    if (!refresh && cached && cached.expires > Date.now()) return cached.value;
    const value = this.queue.then(async () => {
      const source = await readFile(new URL('./history.py', import.meta.url), 'utf8');
      const options = JSON.stringify({ type: this.type, configDir: agent.configDir, offset, limit, sessionId, sessionIds });
      const output = await this.run(agent, `${this.environment(agent)}python3 - ${quote(options)}`, source, this.controller.signal);
      const marker = '__AGENT_HUB_JSON__';
      const line = output.split('\n').reverse().find(line => line.startsWith(marker));
      if (!line) throw new Error(`${this.label} 历史读取失败：未返回有效数据`);
      return historyResult.parse(JSON.parse(line.slice(marker.length)));
    });
    this.queue = value.then(() => {}, () => {});
    if (this.cache.size >= 100) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, { value, expires: Date.now() + 15_000 });
    value.catch(() => { if (this.cache.get(key)?.value === value) this.cache.delete(key); });
    return value;
  }

  close() { this.controller.abort(); this.cache.clear(); }
}
