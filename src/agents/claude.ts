import type { Agent } from '../config.js';
import { quote, remotePath } from '../ssh.js';
import { BaseAgentAdapter, type AgentRunner } from './base.js';

export class ClaudeAdapter extends BaseAgentAdapter {
  readonly type = 'claude-code' as const;
  readonly label = 'Claude Code';
  readonly defaultExecutable = 'claude';
  constructor(run?: AgentRunner) { super(run); }

  protected configEnvironment(agent: Agent) {
    return agent.configDir ? `export CLAUDE_CONFIG_DIR=${remotePath(agent.configDir)}\n` : '';
  }
  protected validateHelp(output: string) {
    if (!output.includes('--session-id') || !output.includes('--resume')) throw new Error('需要支持 --session-id / --resume 的 Claude Code');
  }
  async prepareLaunch(agent: Agent, cwd: string, sessionId?: string, picker = false) {
    const option = sessionId ? `--resume ${quote(sessionId)}` : picker ? '--resume' : `--session-id ${quote(crypto.randomUUID())}`;
    const id = !sessionId && !picker ? /--session-id '([^']+)'/.exec(option)?.[1] : sessionId;
    return { command: this.inDirectory(agent, cwd, `exec -- ${this.executable(agent)} ${option}`), agentSessionId: id };
  }
}

export { historyItem, historyResult, type HistoryResult } from './types.js';
