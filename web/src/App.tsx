import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { api, mergeConversations, sameEnvironment, tabSession, hostKey, type Agent, type AgentType, type Config, type Conversation, type DirectoryListing, type DiscoverResult, type History, type HistoryItem, type Session, type Workspace, type WorkspaceTab } from './api';
import { applyTheme, storedTheme, type ThemeName } from './theme';
import WorkspaceTools from './WorkspaceTools';
const Terminal = lazy(() => import('./Terminal'));
const emptyAgent = { name: '', type: 'claude-code' as const, connection: 'ssh' as const, target: '', cwd: '~', executable: 'claude', configDir: '', initScript: '' };
const agentTypes: Record<AgentType, { label: string; executable: string; suffix: string }> = {
  'claude-code': { label: 'Claude Code', executable: 'claude', suffix: 'Claude' },
  codex: { label: 'Codex', executable: 'codex', suffix: 'Codex' },
  traex: { label: 'TraeX', executable: 'traex', suffix: 'TraeX' },
};
const emptyWorkspace: Workspace = { tabs: [], activeTabId: null };
const emptyHistory: History = { items: [], total: 0, warnings: [] };
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function timestamp(value: number) { return new Date(value).toLocaleDateString([], { month: '2-digit', day: '2-digit' }); }
// Give each agent a stable, distinct hue for its tab-group band, derived from its id.
const bandPalette = ['#d97757', '#6ea8d0', '#83b28a', '#c7a35f', '#b58bd0', '#5fb0b0', '#d08fa8', '#9a9ae0'];
function agentBand(agentId: string) {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  return bandPalette[hash % bandPalette.length];
}
function splitDirectoryQuery(value: string) {
  const raw = value.trim() || '~';
  if (raw === '~') return { base: '~', term: '', searching: false };
  const trimmed = raw.replace(/\/+$/, '') || raw;
  if (raw.endsWith('/')) return { base: trimmed === '~' ? '~' : trimmed, term: '', searching: trimmed !== '~' };
  const index = raw.lastIndexOf('/');
  if (index <= 0) return { base: '~', term: raw.startsWith('~') ? raw.slice(1) : raw, searching: true };
  const base = raw.slice(0, index) || '~';
  return { base, term: raw.slice(index + 1), searching: true };
}
function AgentIcon({ type, size = 18, labelled = true }: { type: Agent['type']; size?: number; labelled?: boolean }) {
  if (type === 'claude-code') return <span className="agent-icon claude-icon" title={labelled ? 'Claude Code' : undefined} aria-hidden={labelled ? undefined : true}><svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2.25v19.5M2.25 12h19.5M5.1 5.1l13.8 13.8M18.9 5.1 5.1 18.9M8.27 2.98l7.46 18.04M21.02 8.27 2.98 15.73M15.73 2.98 8.27 21.02M2.98 8.27l18.04 7.46" /></svg>{labelled && <span className="sr-only">Claude Code</span>}</span>;
  if (type === 'codex') return <span className="agent-icon codex-icon" title={labelled ? 'Codex' : undefined} aria-hidden={labelled ? undefined : true}><img className="codex-dark" src="/codex-icon-dark.png" width={size} height={size} alt="" /><img className="codex-light" src="/codex-icon-light.png" width={size} height={size} alt="" />{labelled && <span className="sr-only">Codex</span>}</span>;
  return <span className="agent-icon traex-icon" title={labelled ? 'TraeX' : undefined} aria-hidden={labelled ? undefined : true}><img src="/traex-icon.png" width={size} height={size} alt="" />{labelled && <span className="sr-only">TraeX</span>}</span>;
}

function AgentSwitcher({ agents, selected, disabled, onSelect }: { agents: Agent[]; selected?: Agent; disabled: boolean; onSelect(id: string): void }) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const groups = new Map<string, { label: string; agents: Agent[] }>();
  for (const agent of agents) {
    const key = `${agent.connection}:${agent.target}`;
    const group = groups.get(key) ?? { label: agent.connection === 'local' ? `本机 · ${agent.target}` : `SSH · ${agent.target}`, agents: [] };
    group.agents.push(agent); groups.set(key, group);
  }
  const orderedGroups = [...groups.entries()].sort(([, left], [, right]) => Number(right.agents[0].connection === 'local') - Number(left.agents[0].connection === 'local'));
  const orderedAgents = orderedGroups.flatMap(([, group]) => group.agents);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const choose = (agent: Agent) => { setOpen(false); onSelect(agent.id); };
  const keyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { setOpen(false); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(event.key)) return;
    event.preventDefault();
    if (!open) { setOpen(true); setFocused(Math.max(0, orderedAgents.findIndex(item => item.id === selected?.id))); return; }
    if (event.key === 'ArrowDown') setFocused(value => (value + 1) % orderedAgents.length);
    else if (event.key === 'ArrowUp') setFocused(value => (value + orderedAgents.length - 1) % orderedAgents.length);
    else if (event.key === 'Home') setFocused(0);
    else if (event.key === 'End') setFocused(orderedAgents.length - 1);
    else if (orderedAgents[focused]) choose(orderedAgents[focused]);
  };
  return <div className="agent-switcher" ref={root}>
    <button type="button" className="agent-switch-button" role="combobox" aria-label="选择 Agent" aria-expanded={open} aria-controls="agent-options" aria-activedescendant={open && orderedAgents[focused] ? `agent-option-${orderedAgents[focused].id}` : undefined} disabled={disabled} onClick={() => { setFocused(Math.max(0, orderedAgents.findIndex(item => item.id === selected?.id))); setOpen(value => !value); }} onKeyDown={keyDown}>
      {selected ? <><AgentIcon type={selected.type} size={18} labelled={false} /><span>{selected.name} - {selected.target}</span></> : <span>未配置</span>}<span className="agent-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="agent-menu" id="agent-options" role="listbox" aria-label="Agents">{orderedGroups.map(([key, group]) => <div className="agent-group" role="group" aria-label={group.label} key={key}><div className="agent-group-label">{group.label}</div>{group.agents.map(item => { const index = orderedAgents.indexOf(item); return <button id={`agent-option-${item.id}`} type="button" role="option" aria-selected={item.id === selected?.id} className={`agent-option ${index === focused ? 'focused' : ''}`} key={item.id} onMouseEnter={() => setFocused(index)} onClick={() => choose(item)}><AgentIcon type={item.type} size={19} labelled={false} /><span>{item.name}</span>{item.id === selected?.id && <span className="agent-check" aria-hidden="true">✓</span>}</button>; })}</div>)}</div>}
  </div>;
}

function DirectoryBrowser({ agent, value, recent, onChange }: { agent: Agent; value: string; recent: string[]; onChange(value: string): void }) {
  const [browsing, setBrowsing] = useState(false);
  const [listings, setListings] = useState<Record<string, DirectoryListing>>({});
  const [expanded, setExpanded] = useState(() => new Set<string>());
  const [loading, setLoading] = useState(() => new Set<string>());
  const [error, setError] = useState('');
  const query = splitDirectoryQuery(value);
  const filter = query.term.trim().toLocaleLowerCase();
  const load = useCallback(async (path: string, expand = true) => {
    setLoading(previous => new Set(previous).add(path)); setError('');
    try {
      const listing = await api<DirectoryListing>(`/agents/${agent.id}/directories?path=${encodeURIComponent(path)}`);
      setListings(previous => ({ ...previous, [path]: listing }));
      if (expand) setExpanded(previous => new Set(previous).add(path));
    } catch (error) { setError(errorText(error)); }
    finally { setLoading(previous => { const next = new Set(previous); next.delete(path); return next; }); }
  }, [agent.id]);
  useEffect(() => { setBrowsing(false); setListings({}); setExpanded(new Set()); setError(''); }, [agent.id]);
  const browse = () => { setBrowsing(true); if (!listings['~'] && !loading.has('~')) void load('~'); };
  useEffect(() => {
    if (!browsing || listings[query.base] || loading.has(query.base)) return;
    void load(query.base, query.base === '~');
  }, [browsing, listings, loading, load, query.base]);
  const toggle = (path: string) => {
    if (path === '~') return;
    if (expanded.has(path)) { setExpanded(previous => { const next = new Set(previous); next.delete(path); return next; }); return; }
    if (listings[path]) setExpanded(previous => new Set(previous).add(path));
    else void load(path);
  };
  const rows: { path: string; name: string; depth: number; hasChildren: boolean }[] = [{ path: '~', name: '~', depth: 0, hasChildren: true }];
  const append = (parent: string, depth: number) => {
    if (parent !== '~' && !expanded.has(parent)) return;
    for (const entry of listings[parent]?.entries ?? []) { rows.push({ ...entry, depth }); append(entry.path, depth + 1); }
  };
  append('~', 1);
  const source = listings[query.base]?.entries ?? [];
  const exact = query.searching && filter ? source.find(entry => entry.name.toLocaleLowerCase() === filter || entry.path === value.trim()) : undefined;
  const browseBase = exact?.path ?? query.base;
  useEffect(() => {
    if (!browsing || !exact || listings[exact.path] || loading.has(exact.path)) return;
    void load(exact.path, false);
  }, [browsing, exact, listings, loading, load]);
  const filtered = source.filter(entry => !filter || entry.name.toLocaleLowerCase().includes(filter));
  const visibleRows = query.searching && !exact ? filtered.map(entry => ({ ...entry, name: entry.path, depth: 0 })) : exact ? (listings[browseBase]?.entries ?? []).map(entry => ({ ...entry, depth: 0 })) : rows;
  const busyPath = exact ? browseBase : query.base;
  return <div className="directory-browser" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBrowsing(false); }} onKeyDown={event => { if (event.key === 'Escape' && browsing) { event.stopPropagation(); setBrowsing(false); } }}>
    <input required value={value} spellCheck={false} autoComplete="off" aria-label="工作目录" aria-controls="directory-source" aria-expanded={browsing} onChange={event => onChange(event.target.value)} onFocus={browse} onKeyDown={event => { if (event.key === 'Escape') { setBrowsing(false); event.currentTarget.blur(); } }} />
    {!browsing ? <div className="recent-directories" id="directory-source" aria-label="最近工作目录">
      <div className="directory-source-heading">最近使用</div>
      {recent.length > 0 ? recent.slice(0, 5).map(path => <button type="button" className={path === value ? 'selected' : ''} title={path} key={path} onClick={() => onChange(path)}><code>{path}</code></button>) : <p>暂无最近使用的目录</p>}
    </div> : <div className="directory-tree" id="directory-source" role="tree" aria-label={`${agent.connection === 'local' ? '本机' : agent.target}目录`} aria-busy={loading.size > 0}>
      {visibleRows.map(row => { const open = row.path === '~' || expanded.has(row.path), pending = loading.has(row.path); return <div className={`directory-row ${row.path === value ? 'selected' : ''}`} role="treeitem" aria-level={row.depth + 1} aria-expanded={!query.searching && row.hasChildren ? open : undefined} aria-selected={row.path === value} style={{ paddingLeft: `${8 + row.depth * 18}px` }} key={row.path}>
        <button type="button" className="directory-name" title={row.path} onClick={() => { onChange(row.path); if (row.hasChildren && !open && !pending) toggle(row.path); }}>{pending ? `${row.name}...` : row.name}</button>
      </div>; })}
      {loading.has(busyPath) && <p className="directory-empty">读取目录...</p>}
      {!loading.has(busyPath) && (exact ? listings[browseBase] : listings[query.base]) && visibleRows.length === 0 && <p className="directory-empty">没有匹配的目录</p>}
    </div>}
    {Object.values(listings).some(listing => listing.truncated) && <p className="directory-note">包含子目录过多，仅显示前 200 项</p>}
    {error && <p className="directory-error" role="alert">{error}</p>}
  </div>;
}

function AgentForm({ agent, embedded, onClose, onSaved }: { agent: Agent | null; embedded?: boolean; onClose(): void; onSaved(agent: Agent): void }) {
  const [form, setForm] = useState(agent ? { name: agent.name, type: agent.type, connection: agent.connection, target: agent.target, cwd: agent.cwd, executable: agent.executable, configDir: agent.configDir, initScript: agent.initScript ?? '' } : emptyAgent);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [testedForm, setTestedForm] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!embedded) dialog.current?.showModal(); }, [embedded]);
  const payload = form.connection === 'local' ? form : (({ connection: _, ...remote }) => remote)(form);
  const formKey = JSON.stringify(payload);
  const updateForm = (next: typeof form) => { setForm(next); setNotice(''); };
  const act = async (probe: boolean) => {
    setBusy(true); setNotice('');
    try {
      if (probe) { const result = await api<{ message: string }>('/agents/probe', 'POST', payload); setTestedForm(formKey); setNotice(result.message); }
      else { const saved = await api<Agent>(agent ? `/agents/${agent.id}` : '/agents', agent ? 'PUT' : 'POST', payload); onSaved(saved); }
    } catch (error) { if (probe) setTestedForm(null); setNotice(errorText(error)); }
    finally { setBusy(false); }
  };
  const field = (key: keyof typeof form, title: string, placeholder: string, hint?: string) => <label>{title}<input aria-label={title} aria-describedby={hint ? `hint-${key}` : undefined} value={form[key]} placeholder={placeholder} required={key !== 'configDir'} onChange={event => updateForm({ ...form, [key]: event.target.value })} />{hint && <small id={`hint-${key}`}>{hint}</small>}</label>;
  const body = <form onSubmit={event => { event.preventDefault(); void act(false); }}>
    <p className="subtle">{form.connection === 'local' ? `直接使用本机 ${agentTypes[form.type].label}，不经过 SSH。` : '复用现有 SSH 配置，不安装远程服务。'}</p>
    {field('name', '名称', '开发环境')}
    <label>Agent 类型<span className="agent-type-control"><AgentIcon type={form.type} /><select aria-label="Agent 类型" value={form.type} disabled={!!agent} onChange={event => { const type = event.target.value as AgentType; updateForm({ ...form, type, executable: agentTypes[type].executable }); }}>{Object.entries(agentTypes).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></span></label>
    {form.connection === 'ssh' && field('target', 'SSH 目标', 'dev-server 或 user@host', '首次连接请先在本机终端完成 SSH 主机信任。')}
    {field('cwd', '默认工作目录', '~/projects')}
    <details><summary>高级配置</summary>{field('executable', `${agentTypes[form.type].label} 可执行文件`, agentTypes[form.type].executable)}{field('configDir', 'Agent 配置目录（可选）', form.type === 'claude-code' ? '~/.claude' : form.type === 'codex' ? '~/.codex' : '~/.trae/cli', `留空时遵循${form.connection === 'local' ? '本机' : '远程'}默认配置目录。`)}<label>初始化脚本（Bash）<textarea aria-label="初始化脚本（Bash）" aria-describedby="init-script-hint" rows={6} maxLength={8192} value={form.initScript} onChange={event => updateForm({ ...form, initScript: event.target.value })} placeholder={'source ~/.config/agent/env.sh\nexport PATH="$HOME/.local/bin:$PATH"'} spellCheck={false} /><small id="init-script-hint">在{form.connection === 'local' ? '本机' : '远程'}执行，启动、测试连接及历史查询都会运行。请使用可重复执行、无交互的脚本；显式配置目录优先。内容将明文保存到本地配置，密钥建议从权限受控的文件 source。</small></label></details>
    {notice && <div className="notice" role="status">{notice}</div>}
    <div className="dialog-actions"><button disabled={busy} type="button" onClick={() => void act(true)}>{busy ? '处理中…' : '测试连接'}</button><button disabled={busy || testedForm !== formKey} className="primary" type="submit">保存 Agent</button></div>
  </form>;
  if (embedded) return body;
  return <dialog ref={dialog} onCancel={onClose} className="agent-dialog" aria-label={agent ? '编辑 Agent' : '注册 Agent'}>
    <div className="dialog-heading"><h2>{agent ? '编辑 Agent' : '注册 Agent'}</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    {body}
  </dialog>;
}

function AgentDiscover({ agents, embedded, onClose, onDone }: { agents: Agent[]; embedded?: boolean; onClose(): void; onDone(workspace: Workspace): void }) {
  const [form, setForm] = useState({ target: '', cwd: '~' });
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [result, setResult] = useState<DiscoverResult | null>(null);
  const [selected, setSelected] = useState<Record<AgentType, boolean>>({ 'claude-code': true, codex: true, traex: true });
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (!embedded) dialog.current?.showModal(); }, [embedded]);
  const registered = (type: AgentType) => agents.some(a => a.connection === 'ssh' && a.target === form.target && a.type === type && !a.configDir);
  const scan = async () => {
    setBusy(true); setError(''); setResult(null);
    try { setResult(await api<DiscoverResult>('/agents/discover', 'POST', { connection: 'ssh', target: form.target, cwd: form.cwd })); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  };
  const chosen = (result?.agents ?? []).filter(item => selected[item.type] && !registered(item.type));
  const save = async () => {
    setSaving(true); setError('');
    try {
      const prefix = result?.hostname || form.target;
      const payload = chosen.map(item => ({ name: `${prefix} ${agentTypes[item.type].suffix}`, type: item.type, connection: 'ssh', target: form.target, cwd: form.cwd, executable: item.executable, configDir: '', initScript: '' }));
      const response = await api<{ workspace: Workspace }>('/agents/batch', 'POST', { agents: payload });
      onDone(response.workspace);
    } catch (error) { setError(errorText(error)); setSaving(false); }
  };
  const body = <form onSubmit={event => { event.preventDefault(); if (result) void save(); else void scan(); }}>
    <p className="subtle">填写 SSH 目标后自动探测该机器上的 Claude Code、Codex、TraeX，勾选即可批量注册。</p>
    <label>SSH 目标<input aria-label="SSH 目标" value={form.target} placeholder="dev-server 或 user@host" required onChange={event => { setForm({ ...form, target: event.target.value }); setResult(null); setError(''); }} /><small>首次连接请先在本机终端完成 SSH 主机信任。</small></label>
    <label>默认工作目录<input aria-label="默认工作目录" value={form.cwd} placeholder="~" required onChange={event => { setForm({ ...form, cwd: event.target.value }); setResult(null); }} /></label>
    {result && <div className="discover-result">
      {result.agents.length ? <ul className="discover-agents">{result.agents.map(item => { const done = registered(item.type); return <li key={item.type}><label className="discover-agent"><input type="checkbox" checked={done ? false : selected[item.type]} disabled={done} onChange={event => setSelected({ ...selected, [item.type]: event.target.checked })} /><AgentIcon type={item.type} size={18} /><span>{result.hostname || form.target} {agentTypes[item.type].suffix}</span><code>{item.executable}</code>{done && <span className="discover-note">已注册</span>}</label></li>; })}</ul> : <p className="subtle">未探测到可用的 Agent CLI。</p>}
      {result.warnings.map((warning, index) => <p className="sync-warning" key={index}>{warning}</p>)}
    </div>}
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="dialog-actions">
      <span />
      {result ? <button className="primary" type="submit" disabled={saving || !chosen.length}>{saving ? '注册中…' : `注册 ${chosen.length} 个 Agent`}</button> : <button className="primary" type="submit" disabled={busy || !form.target.trim()}>{busy ? '扫描中…' : '扫描环境'}</button>}
    </div>
  </form>;
  if (embedded) return body;
  return <dialog ref={dialog} onCancel={onClose} className="agent-dialog" aria-label="扫描远程 Agent">
    <div className="dialog-heading"><h2>扫描远程 Agent</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    {body}
  </dialog>;
}

function AgentRegister({ agents, onClose, onDone, onSaved }: { agents: Agent[]; onClose(): void; onDone(workspace: Workspace): void; onSaved(agent: Agent): void }) {
  const [mode, setMode] = useState<'discover' | 'manual'>('discover');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog ref={dialog} onCancel={onClose} className="agent-dialog" aria-label="注册 Agent">
    <div className="dialog-heading"><h2>注册 Agent</h2><button type="button" className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    <div className="mode-switch" role="radiogroup" aria-label="注册方式">
      <button type="button" role="radio" aria-checked={mode === 'discover'} className={`mode-option ${mode === 'discover' ? 'selected' : ''}`} onClick={() => setMode('discover')}>自动识别</button>
      <button type="button" role="radio" aria-checked={mode === 'manual'} className={`mode-option ${mode === 'manual' ? 'selected' : ''}`} onClick={() => setMode('manual')}>手动配置</button>
    </div>
    {mode === 'discover' ? <AgentDiscover embedded agents={agents} onClose={onClose} onDone={onDone} /> : <AgentForm embedded agent={null} onClose={onClose} onSaved={onSaved} />}
  </dialog>;
}

function AgentManager({ agents, onClose, onEdit, onRegister, onRemove }: { agents: Agent[]; onClose(): void; onEdit(agent: Agent): void; onRegister(): void; onRemove(agent: Agent): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [error, setError] = useState('');
  const [removing, setRemoving] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const groups = new Map<string, { label: string; local: boolean; agents: Agent[] }>();
  for (const agent of agents) {
    const key = `${agent.connection}:${agent.target}`;
    const group = groups.get(key) ?? { label: agent.connection === 'local' ? `本机 · ${agent.target}` : `SSH · ${agent.target}`, local: agent.connection === 'local', agents: [] };
    group.agents.push(agent); groups.set(key, group);
  }
  const orderedGroups = [...groups.values()].sort((a, b) => Number(b.local) - Number(a.local));
  return <dialog ref={dialog} onCancel={onClose} className="manager-dialog" aria-label="管理 Agents">
    <div className="dialog-heading"><h2>Agents</h2><button className="icon-button" onClick={onClose} aria-label="关闭">×</button></div>
    <p className="subtle">一个 Agent 对应一套本地或远程环境；同一台机器可以注册多个。</p>
    <div className="managed-groups">{orderedGroups.map(group => <div className="managed-group" role="group" aria-label={group.label} key={group.label}>
      <div className="managed-group-label">{group.label}</div>
      {group.agents.map(agent => <div className="managed-agent" key={agent.id}><AgentIcon type={agent.type} size={20} /><div><strong>{agent.name}</strong><small>{agent.cwd}</small></div><button onClick={() => onEdit(agent)} aria-label={`编辑 ${agent.name}`}>编辑</button><button className="danger-button" disabled={!!removing} onClick={async () => { setError(''); setRemoving(agent.id); try { await onRemove(agent); } catch (error) { setError(errorText(error)); } finally { setRemoving(''); } }} aria-label={`移除 ${agent.name}`}>移除</button></div>)}
    </div>)}</div>
    {error && <div className="notice error" role="alert">{error}</div>}
    <div className="dialog-actions"><button className="primary" onClick={onRegister}>注册 Agent</button><button onClick={onClose}>完成</button></div>
  </dialog>;
}

function ConversationLauncher({ agents, agent, onAgentChange, sessions, titles, limit, busy, recentCwds, onOpen, onStart }: { agents: Agent[]; agent: Agent; onAgentChange(id: string): void; sessions: Session[]; titles: HistoryItem[]; limit: number; busy: boolean; recentCwds: Record<string, string[]>; onOpen(agentId: string, row: Conversation): Promise<void>; onStart(agentId: string, cwd: string): Promise<void> }) {
  const [history, setHistory] = useState<History>(emptyHistory), [query, setQuery] = useState('');
  const [cwd, setCwd] = useState(agent.cwd), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const offset = useRef(0), request = useRef<AbortController | undefined>(undefined);
  useEffect(() => { setCwd(agent.cwd); setQuery(''); }, [agent.id, agent.cwd]);
  const load = useCallback(async (more = false) => {
    request.current?.abort(); const controller = new AbortController(); request.current = controller;
    setLoading(true); setError(''); const start = more ? offset.current : 0;
    try {
      const result = await api<History>(`/agents/${agent.id}/history?offset=${start}&limit=${limit}&refresh=${!more}`, 'GET', undefined, controller.signal);
      if (controller.signal.aborted) return;
      offset.current = start + limit;
      setHistory(previous => ({ ...result, items: more ? [...previous.items, ...result.items.filter(item => !previous.items.some(old => old.id === item.id))] : result.items }));
    } catch (error) { if (!controller.signal.aborted) setError(errorText(error)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [agent.id, limit]);
  useEffect(() => { void load(); return () => request.current?.abort(); }, [load]);
  const rows = mergeConversations(agent, sessions, history.items, titles).filter(row => `${row.title} ${row.cwd}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const start = async () => { setError(''); try { await onStart(agent.id, cwd); } catch (error) { setError(errorText(error)); } };
  return <div className="conversation-launcher">
    <label className="launcher-agent">选择 Agent<AgentSwitcher agents={agents} selected={agent} disabled={busy} onSelect={onAgentChange} /></label>
    <section className="new-conversation" aria-labelledby="new-conversation-heading">
      <div className="launcher-heading"><div><h3 id="new-conversation-heading">新建对话</h3><p>在 {agent.name} 启动新的 {agentTypes[agent.type].label}</p></div></div>
      <form onSubmit={event => { event.preventDefault(); void start(); }}>
        <label>工作目录<DirectoryBrowser agent={agent} value={cwd} onChange={setCwd} recent={recentCwds[hostKey(agent)] ?? []} /></label>
        <button type="submit" className="primary" disabled={busy}>{busy ? '正在连接…' : `启动 ${agentTypes[agent.type].label}`}</button>
      </form>
    </section>
    <section className="history-conversations" aria-labelledby="history-conversations-heading">
      <div className="history-heading"><div className="launcher-heading"><div><h3 id="history-conversations-heading">打开历史对话</h3><p>接回活跃进程或恢复 {agentTypes[agent.type].label} 记录</p></div></div><button disabled={loading} onClick={() => void load()} aria-label="刷新历史对话" title="刷新历史对话">↻</button></div>
      <input className="conversation-search" aria-label="搜索对话" placeholder="搜索标题或目录…" value={query} onChange={event => setQuery(event.target.value)} />
      <div className="picker-list" aria-busy={loading}>{rows.map(row => <button className="conversation" key={row.key} disabled={busy} onClick={() => { setError(''); void onOpen(agent.id, row).catch(error => setError(errorText(error))); }}>
        <span className={`state-icon ${row.session?.status === 'running' ? 'running' : ''}`} aria-hidden="true" title={row.session?.status === 'running' ? '活跃' : '历史'} />
        <span className="conversation-body"><span className="conversation-title">{row.title}</span><span className="conversation-meta"><span>{row.cwd}</span><time>{timestamp(row.modified)}</time></span></span><span className="sr-only">{row.session?.status === 'running' ? '活跃' : '历史'}</span>
      </button>)}{!rows.length && !loading && <p className="list-empty">{query ? '没有匹配的对话' : '暂无历史对话'}</p>}</div>
      {loading && <p className="history-status" role="status">读取 {agentTypes[agent.type].label} 对话…</p>}
      {offset.current < history.total && <button className="load-more" disabled={loading} onClick={() => void load(true)}>加载更多</button>}
    </section>
    {(error || history.warnings.length > 0) && <div className="launcher-messages">{history.warnings.map(warning => <p className="sync-warning" key={warning}>{warning}</p>)}{error && <div className="notice error" role="alert">{error}</div>}</div>}
  </div>;
}

function ConversationPicker({ agents, agent, onAgentChange, sessions, titles, limit, busy, recentCwds, onClose, onOpen, onStart }: { agents: Agent[]; agent: Agent; onAgentChange(id: string): void; sessions: Session[]; titles: HistoryItem[]; limit: number; busy: boolean; recentCwds: Record<string, string[]>; onClose(): void; onOpen(agentId: string, row: Conversation): Promise<void>; onStart(agentId: string, cwd: string): Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  return <dialog className="conversation-dialog" ref={dialog} onCancel={onClose} aria-label="打开对话">
    <div className="dialog-heading"><h2>打开对话</h2><button className="icon-button" aria-label="关闭" onClick={onClose}>×</button></div>
    <ConversationLauncher agents={agents} agent={agent} onAgentChange={onAgentChange} sessions={sessions} titles={titles} limit={limit} busy={busy} recentCwds={recentCwds} onOpen={onOpen} onStart={onStart} />
  </dialog>;
}

export default function App() {
  const [config, setConfig] = useState<Config>({ agents: [], historyLimit: 30, workspace: emptyWorkspace, recentCwds: {} });
  const [workspace, setWorkspace] = useState<Workspace>(emptyWorkspace);
  const [sessions, setSessions] = useState<Session[]>([]), [titles, setTitles] = useState<Record<string, HistoryItem[]>>({});
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [titleError, setTitleError] = useState('');
  const [modal, setModal] = useState<Agent | undefined>(undefined), [managing, setManaging] = useState(false), [registering, setRegistering] = useState(false);
  const [dialog, setDialog] = useState<'open' | null>(null);
  const [launcherAgentId, setLauncherAgentId] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemeName>(storedTheme);
  const [workspaceTool, setWorkspaceTool] = useState<'shell' | 'review' | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const tabsViewport = useRef<HTMLDivElement>(null);
  const launching = useRef(false);
  const activatedTabs = useRef(new Set<string>());
  const tabs = workspace.tabs;
  const active = tabs.find(tab => tab.id === workspace.activeTabId);
  const agentOf = (tab: WorkspaceTab | undefined) => tab ? config.agents.find(a => a.id === tab.agentId) : undefined;
  const activeAgent = agentOf(active);
  const activeSession = active && activeAgent ? tabSession(active, activeAgent, sessions) : undefined;
  const mountedTerminalTabs = useRef(new Set<string>());
  if (activeSession && active) mountedTerminalTabs.current.add(active.id);
  const mountedTerminals = tabs.flatMap(tab => {
    if (!mountedTerminalTabs.current.has(tab.id)) return [];
    const agent = agentOf(tab), session = agent ? tabSession(tab, agent, sessions) : undefined;
    return session ? [{ tab, session }] : [];
  });
  const launcherAgent = config.agents.find(a => a.id === launcherAgentId) ?? config.agents[0];
  const tabAgentIds = [...new Set(tabs.map(t => t.agentId))].filter(id => config.agents.some(a => a.id === id));
  const tabAgentKey = [...tabAgentIds].sort().join(',');
  const titleKey = JSON.stringify([tabs.map(t => [t.agentId, t.agentSessionId]), sessions.map(s => [s.id, s.status, s.agentSessionId])]);
  // Codex/TraeX mint their thread id after the first message, so a new tab starts without one;
  // fall back to the id its live session has backfilled so titles resolve before it is persisted.
  const resolvedSessionId = (tab: WorkspaceTab) => { const a = agentOf(tab); return tab.agentSessionId ?? (a ? tabSession(tab, a, sessions)?.agentSessionId : undefined); };
  const titleFor = (tab: WorkspaceTab) => { const id = resolvedSessionId(tab); return titles[tab.agentId]?.find(item => item.id === id)?.title || '新对话'; };
  const activeTitle = active ? titleFor(active) : '';
  const changedEnvironment = !!active && (!activeAgent || !sameEnvironment(active, activeAgent));
  const previousActiveTab = useRef<string | null>(workspace.activeTabId);
  useEffect(() => {
    if (previousActiveTab.current !== workspace.activeTabId) setWorkspaceTool(null);
    previousActiveTab.current = workspace.activeTabId;
  }, [workspace.activeTabId]);
  useEffect(() => {
    if (!active || !activeAgent || changedEnvironment) return;
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || event.repeat) return;
      const tool = event.key.toLowerCase() === 't' ? 'shell' : event.key.toLowerCase() === 'g' ? 'review' : null;
      if (!tool) return;
      event.preventDefault(); event.stopPropagation();
      setWorkspaceTool(current => current === tool ? null : tool);
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, [active?.id, activeAgent?.id, changedEnvironment]);
  useEffect(() => { applyTheme(theme); }, [theme]);
  useLayoutEffect(() => {
    const viewport = tabsViewport.current, tab = active && document.getElementById(`tab-${active.id}`)?.parentElement;
    if (!viewport || !tab) return;
    const reveal = () => {
      const left = tab.offsetLeft, right = left + tab.offsetWidth;
      if (left < viewport.scrollLeft) viewport.scrollLeft = left;
      else if (right > viewport.scrollLeft + viewport.clientWidth) viewport.scrollLeft = right - viewport.clientWidth;
    };
    reveal();
    const observer = new ResizeObserver(reveal); observer.observe(viewport); observer.observe(tab);
    return () => observer.disconnect();
  }, [active?.id, activeTitle]);
  const loadSessions = useCallback(async () => { const data = await api<Session[]>('/sessions'); setSessions(data); return data; }, []);
  const changeWorkspace = useCallback((change: object) => {
    const task = queue.current.then(async () => { const next = await api<Workspace>('/workspace', 'PATCH', change); setWorkspace(next); });
    queue.current = task.catch(() => {}); return task;
  }, []);
  const act = (task: Promise<unknown>) => { setError(''); void task.catch(error => setError(errorText(error))); };
  useEffect(() => {
    let disposed = false;
    void (async () => {
      try {
        const token = new URLSearchParams(location.hash.slice(1)).get('token');
        if (token) { await api('/auth', 'POST', { token }); window.history.replaceState(null, '', location.pathname); }
        const [data, running] = await Promise.all([api<Config>('/config'), api<Session[]>('/sessions')]);
        if (!disposed) { setConfig(data); setWorkspace(data.workspace); setSessions(running); setReady(true); }
      } catch (error) { if (!disposed) setError(errorText(error)); }
    })();
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => { try { await loadSessions(); } catch (error) { if (!disposed) setError(errorText(error)); } if (!disposed) timer = setTimeout(poll, 3000); };
    timer = setTimeout(poll, 3000); return () => { disposed = true; clearTimeout(timer); };
  }, [ready, loadSessions]);
  useEffect(() => {
    if (!ready || !tabAgentIds.length) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined, loading = false;
    const poll = async () => {
      clearTimeout(timer); if (controller.signal.aborted || loading || document.hidden) return;
      loading = true; const warnings: string[] = [];
      await Promise.all(tabAgentIds.map(async id => {
        try {
          const result = await api<History>(`/agents/${id}/session-titles`, 'GET', undefined, controller.signal);
          if (!controller.signal.aborted) { setTitles(prev => ({ ...prev, [id]: result.items })); warnings.push(...result.warnings); }
        } catch (error) { if (!controller.signal.aborted) warnings.push(`标题同步失败：${errorText(error)}`); }
      }));
      loading = false; if (!controller.signal.aborted) { setTitleError([...new Set(warnings)].join('；')); timer = setTimeout(poll, 20000); }
    };
    void poll();
    const visibility = () => { if (!document.hidden) void poll(); else clearTimeout(timer); };
    document.addEventListener('visibilitychange', visibility);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
  }, [tabAgentKey, titleKey, ready]);
  const launch = async (agentId: string, input: { cwd?: string; historyId?: string }) => {
    if (launching.current) return;
    launching.current = true; setBusy(true);
    try {
      const session = await api<Session>('/sessions', 'POST', { agentId, ...input });
      await loadSessions(); await changeWorkspace({ action: 'open', agentId, sessionId: session.id }); setDialog(null);
      if ('cwd' in input) setConfig(await api<Config>('/config'));
    } finally { launching.current = false; setBusy(false); }
  };
  const selectTab = async (id: string) => {
    const tab = tabs.find(item => item.id === id); if (!tab) return;
    const tabAgent = agentOf(tab);
    await changeWorkspace({ action: 'select', tabId: id });
    if (tab.agentSessionId && tabAgent && sameEnvironment(tab, tabAgent) && tabSession(tab, tabAgent, sessions)?.status !== 'running') await launch(tabAgent.id, { historyId: tab.agentSessionId });
  };
  useEffect(() => {
    if (!ready || !active || !activeAgent || !active.agentSessionId || !sameEnvironment(active, activeAgent)) return;
    const key = active.id;
    if (activeSession?.status === 'running') { activatedTabs.current.add(key); return; }
    if (activatedTabs.current.has(key)) return;
    activatedTabs.current.add(key);
    act(launch(activeAgent.id, { historyId: active.agentSessionId }));
  }, [ready, active?.id, activeSession?.status]);
  const open = async (agentId: string, row: Conversation) => {
    const tabAgent = config.agents.find(a => a.id === agentId); if (!tabAgent) return;
    const existing = tabs.find(tab => tab.agentId === agentId && sameEnvironment(tab, tabAgent) && (tab.agentSessionId ? tab.agentSessionId === (row.history?.id ?? row.session?.agentSessionId) : tab.sessionId === row.session?.id));
    if (existing) { await selectTab(existing.id); setDialog(null); }
    else if (row.session?.status === 'running' || (row.session && !row.history)) { await changeWorkspace({ action: 'open', agentId, sessionId: row.session.id }); setDialog(null); }
    else if (row.history) await launch(agentId, { historyId: row.history.id });
  };
  const removeAgent = async (item: Agent) => {
    if (!confirm(`移除 Agent「${item.name}」的配置和 tabs？Agent 对话内容不受影响。`)) return;
    await queue.current; await api(`/agents/${item.id}`, 'DELETE'); const data = await api<Config>('/config'); setConfig(data); setWorkspace(data.workspace);
  };
  const groups: { agentId: string; agent?: Agent; tabs: WorkspaceTab[] }[] = [];
  const groupIndex = new Map<string, number>();
  for (const tab of tabs) {
    let idx = groupIndex.get(tab.agentId);
    if (idx === undefined) { idx = groups.length; groupIndex.set(tab.agentId, idx); groups.push({ agentId: tab.agentId, agent: config.agents.find(a => a.id === tab.agentId), tabs: [] }); }
    groups[idx].tabs.push(tab);
  }
  const focusTab = (id: string) => { document.getElementById(`tab-${id}`)?.focus(); };
  const moveFocus = (event: React.KeyboardEvent, id: string) => {
    const index = tabs.findIndex(t => t.id === id); if (index < 0 || !tabs.length) return;
    let next: number | undefined;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = tabs.length - 1;
    if (next !== undefined) { event.preventDefault(); act(selectTab(tabs[next].id)); focusTab(tabs[next].id); }
  };
  const openPicker = (agentId?: string) => { if (agentId) setLauncherAgentId(agentId); setDialog('open'); };
  return <div className="workspace">
    <a className="skip-link" href="#main">跳到终端区域</a>
    <header className="appbar">
      <span className="brand" role="img" aria-label="Agent Hub" title="Agent Hub"><img className="brand-light" src="/agent-hub-lockup-light.png" alt="" /><img className="brand-dark" src="/agent-hub-lockup-dark.png" alt="" /></span>
      <div className="agent-controls" role="group" aria-label="Agent 管理">
        <button className="manage-button" aria-label="管理 Agents" title="管理 Agents" disabled={!ready || busy} onClick={() => setManaging(true)}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="8" width="14" height="10" rx="2.5" /><path d="M12 8V4.5M12 4.5a1.4 1.4 0 1 0 0-2.8 1.4 1.4 0 0 0 0 2.8Z" /><path d="M2.6 12v3M21.4 12v3" /><circle cx="9.2" cy="13" r="1.1" fill="currentColor" stroke="none" /><circle cx="14.8" cy="13" r="1.1" fill="currentColor" stroke="none" /></svg>
          <span className="sr-only">管理 Agents</span>
        </button>
      </div>
      {active && <div className="appbar-active" title={`${titleFor(active)}\n${activeAgent ? `${activeAgent.name} · ${activeAgent.connection === 'local' ? '本机' : activeAgent.target}` : ''}\n${active.cwd}`}><span className="appbar-active-title">{titleFor(active)}</span><span className="appbar-active-meta">{activeAgent && <><AgentIcon type={activeAgent.type} size={12} labelled={false} /><span className="appbar-active-agent">{activeAgent.connection === 'local' ? `本机 · ${activeAgent.target}` : activeAgent.target}</span><span aria-hidden="true">·</span></>}<code className="appbar-cwd">{active.cwd}</code></span></div>}
      <div className="theme-switch" role="radiogroup" aria-label="颜色主题">
        <button type="button" role="radio" aria-checked={theme === 'modernLight'} className={`theme-option ${theme === 'modernLight' ? 'selected' : ''}`} title="白天（浅色）" onClick={() => setTheme('modernLight')}>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><circle cx="10" cy="10" r="3.4" /><path d="M10 2v2m0 12v2M2 10h2m12 0h2M4.35 4.35l1.42 1.42m8.46 8.46 1.42 1.42m0-11.3-1.42 1.42m-8.46 8.46-1.42 1.42" /></svg>
          <span className="sr-only">浅色</span>
        </button>
        <button type="button" role="radio" aria-checked={theme === 'modernDark'} className={`theme-option ${theme === 'modernDark' ? 'selected' : ''}`} title="黑夜（深色）" onClick={() => setTheme('modernDark')}>
          <svg viewBox="0 0 20 20" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M15.5 11.5A6 6 0 0 1 8.5 4.5a6 6 0 1 0 7 7z" /></svg>
          <span className="sr-only">深色</span>
        </button>
      </div>
    </header>
    <div className="tabbar">
      <div className="tabs" ref={tabsViewport} role="tablist" aria-label="打开的对话">{groups.map(group => (
        <div className="tab-group" role="group" style={{ ['--agent-band' as string]: agentBand(group.agentId) }} aria-label={group.agent ? group.agent.name : '已移除的 Agent'} title={group.agent ? `${group.agent.name} · ${group.agent.connection === 'local' ? '本机' : group.agent.target}` : '已移除的 Agent'} key={group.agentId}>{group.tabs.map(tab => {
          const session = group.agent && tabSession(tab, group.agent, sessions), selected = active?.id === tab.id;
          const status = session?.status === 'running' ? '活跃' : session ? '已退出' : '待恢复';
          return <div className={`tab ${selected ? 'selected' : ''}`} key={tab.id}>
            <button role="tab" id={`tab-${tab.id}`} aria-selected={selected} aria-controls="terminal-panel" tabIndex={selected || (!active && tabs[0]?.id === tab.id) ? 0 : -1} onClick={() => act(selectTab(tab.id))} title={`${titleFor(tab)}\n${tab.cwd}\n${status}`} onKeyDown={event => moveFocus(event, tab.id)}>{group.agent && <AgentIcon type={group.agent.type} size={14} labelled={false} />}<span className={`state-icon ${session?.status === 'running' ? 'running' : ''}`} title={status} aria-hidden="true" /><span className="tab-title">{titleFor(tab)}</span><span className="sr-only">{status}</span></button>
            <button className="tab-close" aria-label={`关闭 ${titleFor(tab)}`} title="关闭 tab，Agent 会话继续运行，辅助终端将结束" onClick={() => act(changeWorkspace({ action: 'close', tabId: tab.id }))}>×</button>
          </div>;
        })}</div>
      ))}</div>
      {tabs.length > 0 && <div className="tab-actions"><button aria-label="添加对话" title="新建或打开对话" disabled={!config.agents.length || busy || tabs.length >= 20} onClick={() => openPicker()}>+</button></div>}
    </div>
    <main id="main" className="main" tabIndex={-1}>
      {error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭错误" onClick={() => setError('')}>×</button></div>}
      {titleError && <p className="sync-warning">{titleError}</p>}
      {active ? <section className="active-workspace" id="terminal-panel" role="tabpanel" aria-labelledby={`tab-${active.id}`}>
        {mountedTerminals.map(({ tab, session }) => <Suspense key={tab.id} fallback={tab.id === active.id ? <div className="loading">加载终端…</div> : null}><Terminal sessionId={session.id} theme={theme} active={tab.id === active.id} /></Suspense>)}
        {!activeSession && <div className="empty-workspace"><h2>{titleFor(active)}</h2><p className="subtle">{changedEnvironment ? 'Agent 环境已更改，无法在当前环境恢复此 tab。' : active.agentSessionId ? busy ? '正在恢复 Agent 对话…' : 'Agent 对话暂未运行，点击当前 tab 可重试。' : '历史选择器没有可靠的对话标识，请重新打开对话。'}</p></div>}
        {!changedEnvironment && activeAgent && <WorkspaceTools tab={active} theme={theme} open={workspaceTool} onOpen={setWorkspaceTool} onClose={() => setWorkspaceTool(null)} />}
      </section> : launcherAgent ? <section className="empty-workspace launcher-workspace" aria-label="打开对话"><ConversationLauncher agents={config.agents} agent={launcherAgent} onAgentChange={setLauncherAgentId} sessions={sessions} titles={titles[launcherAgent.id] ?? []} limit={config.historyLimit} busy={busy} recentCwds={config.recentCwds} onOpen={open} onStart={(agentId, cwd) => launch(agentId, { cwd })} /></section> : <section className="empty-workspace"><span className="prompt-symbol" aria-hidden="true">&gt;_</span><h2>连接远程 Agent</h2><button className="primary" disabled={!ready} onClick={() => setRegistering(true)}>{ready ? '注册第一个 Agent' : '连接本地服务…'}</button></section>}
    </main>
    {managing && <AgentManager agents={config.agents} onClose={() => setManaging(false)} onRegister={() => { setManaging(false); setRegistering(true); }} onEdit={item => { setManaging(false); setModal(item); }} onRemove={removeAgent} />}
    {registering && <AgentRegister agents={config.agents} onClose={() => setRegistering(false)} onDone={next => { setRegistering(false); act(api<Config>('/config').then(data => { setConfig(data); setWorkspace(next); })); }} onSaved={saved => { setRegistering(false); setLauncherAgentId(saved.id); act(api<Config>('/config').then(data => setConfig(data))); }} />}
    {modal !== undefined && <AgentForm agent={modal} onClose={() => setModal(undefined)} onSaved={saved => { setModal(undefined); setLauncherAgentId(saved.id); act(api<Config>('/config').then(data => setConfig(data))); }} />}
    {dialog === 'open' && launcherAgent && <ConversationPicker key={launcherAgent.id} agents={config.agents} agent={launcherAgent} onAgentChange={setLauncherAgentId} sessions={sessions} titles={titles[launcherAgent.id] ?? []} limit={config.historyLimit} busy={busy} recentCwds={config.recentCwds} onClose={() => setDialog(null)} onOpen={open} onStart={(agentId, cwd) => launch(agentId, { cwd })} />}
  </div>;
}
