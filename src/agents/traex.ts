import type { Agent } from '../config.js';
import { quote, remotePath } from '../ssh.js';
import { BaseAgentAdapter, type AgentRunner } from './base.js';

export class TraexAdapter extends BaseAgentAdapter {
  readonly type = 'traex' as const;
  readonly label = 'TraeX';
  readonly defaultExecutable = 'traex';
  constructor(run?: AgentRunner) { super(run); }

  protected configEnvironment(agent: Agent) {
    return agent.configDir ? `export TRAECLI_HOME=${remotePath(agent.configDir)}\n` : '';
  }
  protected validateHelp(output: string) {
    if (!output.includes('--session-id') || !output.includes('resume')) throw new Error('需要支持 --session-id / resume 的 TraeX');
  }
  async prepareLaunch(agent: Agent, cwd: string, sessionId?: string, picker = false) {
    const id = sessionId ?? (!picker ? crypto.randomUUID() : undefined);
    const option = sessionId ? `resume ${quote(sessionId)}` : picker ? 'resume' : `--session-id ${quote(id!)}`;
    return { command: this.inDirectory(agent, cwd, `exec -- ${this.executable(agent)} ${option}`), agentSessionId: id };
  }
}
