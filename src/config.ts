import { mkdir, readFile, rename, writeFile, chmod, unlink } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const text = z.string().trim().min(1).max(1024).regex(/^[^\x00-\x1f\x7f]+$/, '不能包含控制字符');
export const agentInput = z.object({
  name: text.max(80),
  type: z.enum(['claude-code', 'codex', 'traex']).default('claude-code'),
  connection: z.enum(['ssh', 'local']).default('ssh'),
  target: text.max(255).regex(/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?[a-zA-Z0-9_][a-zA-Z0-9_.:\[\]-]*$/, '请输入 SSH Host 别名或 user@host'),
  cwd: text.default('~'),
  executable: text.default('claude'),
  configDir: z.union([z.literal(''), text]).default(''),
  initScript: z.string().max(8192).regex(/^[^\x00]*$/, '初始化脚本不能包含 NUL 字符').default(''),
}).strict();
export const agentSchema = agentInput.extend({ id: z.string().uuid() });
export type Agent = z.infer<typeof agentSchema>;
export function initScriptKey(agent: Agent) { return createHash('sha256').update(agent.initScript).digest('hex'); }
export const tabSchema = z.object({
  id: z.string().uuid(), sessionId: z.string().uuid(), agentSessionId: z.string().uuid().optional(),
  cwd: text, type: agentInput.shape.type, connection: agentInput.shape.connection, target: agentInput.shape.target, configDir: agentInput.shape.configDir,
  initScriptKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const agentWorkspaceSchema = z.object({
  tabs: z.array(tabSchema).max(100), activeTabId: z.string().uuid().nullable(),
}).strict().superRefine((value, context) => {
  if (new Set(value.tabs.map(tab => tab.id)).size !== value.tabs.length) context.addIssue({ code: 'custom', message: 'Tab 重复' });
  if (value.activeTabId !== null && !value.tabs.some(tab => tab.id === value.activeTabId)) context.addIssue({ code: 'custom', message: '选中的 Tab 不存在' });
});
export const workspaceSchema = z.object({
  selectedAgentId: z.string().uuid().nullable(),
  agents: z.record(z.string().uuid(), agentWorkspaceSchema),
}).strict();
export type Workspace = z.infer<typeof workspaceSchema>;
export type WorkspaceTab = z.infer<typeof tabSchema>;
const currentConfigSchema = z.object({ version: z.literal(2), historyLimit: z.number().int().min(1).max(100), agents: z.array(agentSchema), workspace: workspaceSchema.default(() => ({ selectedAgentId: null, agents: {} })) });
export const configSchema = z.preprocess(value => {
  if (!value || typeof value !== 'object') return value;
  const raw = structuredClone(value) as any;
  if (raw.version === 1) {
    raw.version = 2;
  }
  const types = new Map((raw.agents ?? []).map((agent: any) => [agent.id, agent.type ?? 'claude-code']));
  for (const [agentId, view] of Object.entries(raw.workspace?.agents ?? {}) as [string, any][]) for (const tab of view.tabs ?? []) {
    tab.agentSessionId = tab.agentSessionId ?? tab.claudeId; delete tab.claudeId;
    tab.type ??= types.get(agentId) ?? 'claude-code';
  }
  return raw;
}, currentConfigSchema);
export type Config = z.infer<typeof configSchema>;
export const workingDirectory = text;
const execFileAsync = promisify(execFile);

export class ConfigStore {
  private state: Config = { version: 2, historyLimit: 30, agents: [], workspace: { selectedAgentId: null, agents: {} } };
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly directory = join(homedir(), '.multi-agent-mgr')) {}
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try { this.state = configSchema.parse(JSON.parse(await readFile(join(this.directory, 'config.json'), 'utf8'))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return this;
  }
  get() { return structuredClone(this.state); }
  agent(id: string) {
    const agent = this.state.agents.find(a => a.id === id);
    if (!agent) throw new Error('Agent 不存在');
    return { ...agent };
  }
  update(change: (config: Config) => void) {
    const task = this.queue.then(async () => {
      const next = this.get();
      change(next);
      configSchema.parse(next);
      const temporary = join(this.directory, `config.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temporary, join(this.directory, 'config.json'));
      } finally { await unlink(temporary).catch(() => {}); }
      this.state = next;
      return this.get();
    });
    this.queue = task.catch(() => {});
    return task;
  }
}

const localAgents = [
  { type: 'claude-code' as const, name: 'Local Claude', command: 'claude' },
  { type: 'codex' as const, name: 'Local Codex', command: 'codex' },
  { type: 'traex' as const, name: 'Local TraeX', command: 'traex' },
];
export async function ensureLocalAgents(store: ConfigStore, findExecutable: (command: string) => Promise<string> = async command => {
  const { stdout } = await execFileAsync('/bin/bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' });
  return stdout.trim();
}) {
  const username = userInfo().username;
  const discovered: Array<{ type: Agent['type']; name: string; executable: string }> = [];
  for (const candidate of localAgents) {
    try { const executable = await findExecutable(candidate.command); if (executable) discovered.push({ ...candidate, executable }); } catch {}
  }
  let changed = false;
  await store.update(config => {
    const additions: Agent[] = [];
    for (const candidate of discovered) {
      const existing = config.agents.find(agent => agent.type === candidate.type && agent.connection === 'local');
      if (existing) {
        if (existing.target !== username) {
          const previousTarget = existing.target; existing.target = username; changed = true;
          for (const tab of config.workspace.agents[existing.id]?.tabs ?? []) if (tab.connection === 'local' && tab.target === previousTarget) tab.target = username;
        }
        continue;
      }
      const agent = agentSchema.parse({ id: randomUUID(), name: candidate.name, type: candidate.type, connection: 'local', target: username, cwd: '~', executable: candidate.executable, configDir: '', initScript: '' });
      additions.push(agent); config.workspace.selectedAgentId ??= agent.id; changed = true;
    }
    config.agents.unshift(...additions);
  });
  return changed;
}
