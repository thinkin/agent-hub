import type { Agent } from '../config.js';
import type { AgentAdapter } from './types.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { TraexAdapter } from './traex.js';

export class AgentRegistry {
  private adapters: Map<Agent['type'], AgentAdapter>;
  constructor(adapters: AgentAdapter[] = [new ClaudeAdapter(), new CodexAdapter(), new TraexAdapter()]) {
    this.adapters = new Map(adapters.map(adapter => [adapter.type, adapter]));
  }
  for(agent: Agent | Agent['type']) {
    const type = typeof agent === 'string' ? agent : agent.type;
    const adapter = this.adapters.get(type);
    if (!adapter) throw new Error(`不支持的 Agent 类型：${type}`);
    return adapter;
  }
  close() { for (const adapter of this.adapters.values()) adapter.close(); }
}
