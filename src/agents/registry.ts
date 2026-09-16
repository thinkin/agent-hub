import type { Agent, DiscoverInput } from '../config.js';
import type { AgentAdapter } from './types.js';
import { quote, runRemote } from '../ssh.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { TraexAdapter } from './traex.js';

export interface DiscoveredAgent { type: Agent['type']; label: string; executable: string; version: string }
export interface DiscoverResult { hostname: string; python: boolean; agents: DiscoveredAgent[]; warnings: string[] }
export interface DirectoryEntry { name: string; path: string; hasChildren: boolean }
export interface DirectoryListing { path: string; entries: DirectoryEntry[]; truncated: boolean }

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
  async directories(agent: Agent, path: string): Promise<DirectoryListing> {
    const source = `import json,os,sys\nhome=os.path.abspath(os.path.expanduser("~"))\nrequested=os.path.abspath(os.path.expanduser(sys.argv[1]))\nif os.path.commonpath([home,requested]) != home: raise ValueError("只能浏览主目录下的文件夹")\nif not os.path.isdir(requested): raise ValueError("目录不存在或不可访问")\nitems=[]\nwith os.scandir(requested) as scan:\n for entry in scan:\n  try:\n   if not entry.is_dir(follow_symlinks=False): continue\n   child=os.path.abspath(entry.path)\n   has_children=any(item.is_dir(follow_symlinks=False) for item in os.scandir(child))\n   items.append({"name":entry.name,"path":"~"+(child[len(home):] if child != home else ""),"hasChildren":has_children})\n  except OSError: pass\nitems.sort(key=lambda item:(item["name"].startswith("."),item["name"].casefold()))\nprint("__AGENT_HUB_DIRS__"+json.dumps({"path":"~"+(requested[len(home):] if requested != home else ""),"entries":items[:200],"truncated":len(items)>200},ensure_ascii=False))`;
    const encoded = Buffer.from(source).toString('base64');
    const environment = agent.initScript.trim() ? `set -e\neval ${quote(agent.initScript)} </dev/null\n` : '';
    const command = `${environment}python3 -c "import base64;exec(base64.b64decode('${encoded}'))" ${quote(path)}`;
    const output = await this.run(agent, command, '');
    const marker = output.lastIndexOf('__AGENT_HUB_DIRS__');
    if (marker < 0) throw new Error('目录读取返回格式无效');
    return JSON.parse(output.slice(marker + '__AGENT_HUB_DIRS__'.length).trim()) as DirectoryListing;
  }
  close() { for (const adapter of this.adapters.values()) adapter.close(); }
}
