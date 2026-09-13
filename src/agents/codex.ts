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
    const before = !sessionId && !picker ? await this.history(agent, 0, 100, true).then(result => new Set(result.items.map(item => item.id))) : undefined;
    const option = sessionId ? `resume ${quote(sessionId)}` : picker ? 'resume' : '';
    const command = this.inDirectory(agent, cwd, `exec -- ${this.executable(agent)} ${option}`.trimEnd());
    return {
      command, agentSessionId: sessionId,
      resolveSessionId: before ? async () => {
        for (let attempt = 0; attempt < 20; attempt++) {
          await new Promise(resolve => setTimeout(resolve, 250));
          const latest = await this.history(agent, 0, 10, true);
          const candidates = latest.items.filter(item => !before.has(item.id));
          const found = candidates.find(item => item.cwd === cwd) ?? (candidates.length === 1 ? candidates[0] : undefined);
          if (found) return found.id;
        }
      } : undefined,
    };
  }
}
