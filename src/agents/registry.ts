import type { Agent, DiscoverInput } from '../config.js';
import type { AgentAdapter } from './types.js';
import { quote, runRemote } from '../ssh.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { TraexAdapter } from './traex.js';

export interface DiscoveredAgent { type: Agent['type']; label: string; executable: string; version: string }
export interface DiscoverResult { hostname: string; python: boolean; agents: DiscoveredAgent[]; warnings: string[] }

export class AgentRegistry {
  private adapters: Map<Agent['type'], AgentAdapter>;
  constructor(
    adapters: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new TraexAdapter()],
    private run = runRemote,
  ) {
    this.adapters = new Map(adapters.map(adapter => [adapter.type, adapter]));
  }
  for(agent: Agent | Agent['type']) {
    const type = typeof agent === 'string' ? agent : agent.type;
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`不支持的 Agent 类型：${type}`);
    return adapter;
  }
  async discover(input: DiscoverInput): Promise<DiscoverResult> {
    const probe = { id: '', name: '', type: 'claude-code' as const, connection: input.connection, target: input.target, cwd: input.cwd, executable: 'true', configDir: '', initScript: input.initScript };
    const environment = input.initScript.trim() ? `set -e\neval ${quote(input.initScript)} </dev/null\nset +e\n` : '';
    const entries = [...this.adapters.values()];
    const script = entries.map(adapter =>
      `path=$(command -v ${quote(adapter.defaultExecutable)} 2>/dev/null) && printf '__AGENT_HUB_FOUND__ %s %s\\n' ${quote(adapter.type)} "$path"`,
    ).join('\n');
    const command = `${environment}printf '__AGENT_HUB_HOST__ %s\\n' "$(hostname 2>/dev/null)"\npython3 --version >/dev/null 2>&1 && printf '__AGENT_HUB_PYTHON__\\n'\n${script}\ntrue`;
    const output = await this.run(probe, command, '');
    const hostname = /__AGENT_HUB_HOST__ (.+)/.exec(output)?.[1]?.trim() ?? '';
    const python = output.includes('__AGENT_HUB_PYTHON__');
    const found = new Set([...output.matchAll(/__AGENT_HUB_FOUND__ (\S+) (\S+)/g)].map(match => match[1]));
    const agents: DiscoveredAgent[] = [];
    const warnings: string[] = [];
    for (const adapter of entries) {
      if (!found.has(adapter.type)) continue;
      agents.push({ type: adapter.type, label: adapter.label, executable: adapter.defaultExecutable, version: '' });
    }
    if (!agents.length) warnings.push('未在该环境探测到 Claude Code、Codex 或 TraeX，可手动填写可执行文件路径。');
    if (agents.length && !python) warnings.push('未检测到 Python 3，历史读取将不可用；请在该环境安装 Python 3。');
    return { hostname, python, agents, warnings };
  }
  close() { for (const adapter of this.adapters.values()) adapter.close(); }
}
