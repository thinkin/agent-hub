import type { Agent } from '../config.js';
import { quote, remotePath } from '../ssh.js';
import { BaseAgentAdapter, type AgentRunner } from './base.js';

export class CodexAdapter extends BaseAgentAdapter {
  readonly type = 'codex' as const;
  readonly label = 'Codex';
  readonly defaultExecutable = 'codex';
  constructor(run?: AgentRunner) { super(run); }

  protected configEnvironment(agent: Agent) {
    return agent.configDir ? `export CODEX_HOME=${remotePath(agent.configDir)}\n` : '';
  }
  protected validateHelp(output: string) {
    if (!output.includes('resume') || !output.includes('--cd')) throw new Error('需要支持 resume 和 --cd 的 Codex CLI');
  }
  async prepareLaunch(agent: Agent, cwd: string, sessionId?: string, picker = false) {
    const option = sessionId ? `resume ${quote(sessionId)}` : picker ? 'resume' : '';
    const command = this.inDirectory(agent, cwd, `exec -- ${this.executable(agent)} ${option}`.trimEnd());
    return {
      command, agentSessionId: sessionId,
      resolveSessionId: !sessionId && !picker ? (signal: AbortSignal) => this.trackNewThread(agent, cwd, signal) : undefined,
    };
  }
}
