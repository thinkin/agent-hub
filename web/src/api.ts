export type AgentType = 'claude-code' | 'codex' | 'traex';
export interface Agent { id: string; name: string; type: AgentType; connection: 'ssh' | 'local'; target: string; cwd: string; executable: string; configDir: string; initScript?: string; initScriptKey?: string }
export interface WorkspaceTab { id: string; agentId: string; sessionId: string; agentSessionId?: string; cwd: string; type: AgentType; connection: 'ssh' | 'local'; target: string; configDir: string; initScriptKey?: string }
const emptyScriptKey = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export function sameEnvironment(a: { type: AgentType; connection: 'ssh' | 'local'; target: string; configDir: string; initScriptKey?: string }, b: { type: AgentType; connection: 'ssh' | 'local'; target: string; configDir: string; initScriptKey?: string }) {
  return a.type === b.type && a.connection === b.connection && a.target === b.target && a.configDir === b.configDir && (a.initScriptKey ?? emptyScriptKey) === (b.initScriptKey ?? emptyScriptKey);
}
export interface AgentWorkspace { tabs: WorkspaceTab[]; activeTabId: string | null }
export interface Workspace { tabs: WorkspaceTab[]; activeTabId: string | null }
export interface Config { agents: Agent[]; historyLimit: number; workspace: Workspace; recentCwds: Record<string, string[]> }
export function hostKey(agent: { connection: 'ssh' | 'local'; target: string }) { return `${agent.connection}:${agent.target}`; }
export interface DiscoveredAgent { type: AgentType; label: string; executable: string; version: string }
export interface DiscoverResult { hostname: string; python: boolean; agents: DiscoveredAgent[]; warnings: string[] }
export function tabSession(tab: WorkspaceTab, agent: Agent, sessions: Session[]) {
  if (!sameEnvironment(tab, agent)) return undefined;
  const matching = sessions.filter(s => sameEnvironment(s, tab) && (s.id === tab.sessionId || (!!tab.agentSessionId && s.agentSessionId === tab.agentSessionId)));
  return matching.find(s => s.status === 'running') ?? matching.find(s => s.id === tab.sessionId);
}
export interface Session { id: string; agentId: string; agentName: string; type: AgentType; connection: 'ssh' | 'local'; target: string; configDir: string; cwd: string; agentSessionId?: string; initScriptKey?: string; status: 'running' | 'exited'; created: number; exitCode?: number }
export interface HistoryItem { id: string; title: string; cwd: string; modified: number; created?: number }
export interface History { items: HistoryItem[]; total: number; warnings: string[] }
export interface DirectoryEntry { name: string; path: string; hasChildren: boolean }
export interface DirectoryListing { path: string; entries: DirectoryEntry[]; truncated: boolean }
export type GitChangeKind = 'staged' | 'unstaged' | 'untracked';
export interface GitChange { path: string; originalPath?: string; status: string; kind: GitChangeKind }
export interface GitStatus { repository: boolean; changes: GitChange[] }
export interface GitDiff { path: string; kind: GitChangeKind; diff: string; truncated: boolean }
export interface Conversation { key: string; title: string; cwd: string; modified: number; session?: Session; history?: HistoryItem }
export function mergeConversations(agent: Agent, sessions: Session[], history: HistoryItem[], titles: HistoryItem[]): Conversation[] {
  const metadata = new Map(history.map(item => [item.id, item]));
  for (const item of titles) metadata.set(item.id, item);
  const rows = new Map<string, Conversation>();
  for (const item of history) rows.set(item.id, { key: item.id, title: item.title || '新对话', cwd: item.cwd, modified: item.modified * 1000, history: item });
  const matching = sessions.filter(s => sameEnvironment(s, agent)).sort((a, b) => a.created - b.created);
  for (const session of matching) {
    const key = session.agentSessionId ?? session.id;
    const item = session.agentSessionId ? metadata.get(session.agentSessionId) : undefined;
    if (rows.get(key)?.session?.status === 'running' && session.status !== 'running') continue;
    rows.set(key, { key, title: item?.title || (session.agentSessionId ? '新对话' : '历史选择器'), cwd: session.cwd, modified: Math.max(session.created, (item?.modified ?? 0) * 1000), session, history: item });
  }
  return [...rows.values()].sort((a, b) => Number(b.session?.status === 'running') - Number(a.session?.status === 'running') || b.modified - a.modified || a.key.localeCompare(b.key));
}
export async function api<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${path}`, { method, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`);
  return data;
}
