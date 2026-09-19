import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { api, type GitChange, type GitChangeKind, type GitDiff, type GitStatus, type Session, type WorkspaceTab } from './api';
import type { ThemeName } from './theme';

const Terminal = lazy(() => import('./Terminal'));
type Tool = 'shell' | 'review';
type ChangeView = 'flat' | 'tree';
interface ChangeTreeNode { key: string; name: string; path: string; children: ChangeTreeNode[]; change?: GitChange }
const groups: { kind: GitChangeKind; label: string }[] = [
  { kind: 'staged', label: '已暂存' },
  { kind: 'unstaged', label: '未暂存' },
  { kind: 'untracked', label: '未跟踪' },
];
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function changeKey(change: GitChange) { return `${change.kind}:${change.path}`; }
export function buildChangeTree(changes: GitChange[]) {
  const root: ChangeTreeNode = { key: '', name: '', path: '', children: [] };
  for (const change of changes) {
    const parts = change.path.split('/').filter(Boolean);
    let parent = root, path = '';
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index]; path = path ? `${path}/${name}` : name;
      const leaf = index === parts.length - 1;
      let node = parent.children.find(item => item.name === name && !!item.change === leaf);
      if (!node) { node = { key: `${change.kind}:${path}${leaf ? ':file' : ':directory'}`, name, path, children: [], change: leaf ? change : undefined }; parent.children.push(node); }
      parent = node;
    }
  }
  const sort = (nodes: ChangeTreeNode[]) => { nodes.sort((left, right) => Number(!!left.change) - Number(!!right.change) || left.name.localeCompare(right.name)); for (const node of nodes) sort(node.children); };
  sort(root.children);
  return root.children;
}
function ChangeFile({ change, name, depth, selected, tree = false, onSelect }: { change: GitChange; name: string; depth: number; selected: boolean; tree?: boolean; onSelect(change: GitChange): void }) {
  return <button type="button" role={tree ? 'treeitem' : undefined} className={`change-file ${selected ? 'selected' : ''}`} aria-selected={tree ? selected : undefined} aria-pressed={tree ? undefined : selected} title={change.path} style={{ paddingLeft: `${10 + depth * 14}px` }} onClick={() => onSelect(change)}><span className={`change-status status-${change.status.toLowerCase()}`}>{change.status}</span><span>{name}</span></button>;
}
function ChangeTree({ changes, selected, collapsed, onToggle, onSelect }: { changes: GitChange[]; selected: GitChange | null; collapsed: Set<string>; onToggle(key: string): void; onSelect(change: GitChange): void }) {
  const render = (nodes: ChangeTreeNode[], depth = 0): React.ReactNode => nodes.map(node => node.change
    ? <ChangeFile key={node.key} change={node.change} name={node.name} depth={depth} tree selected={!!selected && changeKey(selected) === changeKey(node.change)} onSelect={onSelect} />
    : <div className="change-tree-branch" role="treeitem" aria-expanded={!collapsed.has(node.key)} key={node.key}><button type="button" className="change-directory" style={{ paddingLeft: `${10 + depth * 14}px` }} title={node.path} onClick={() => onToggle(node.key)}><span className="tree-chevron" aria-hidden="true">{collapsed.has(node.key) ? '›' : '⌄'}</span><span>{node.name}</span></button>{!collapsed.has(node.key) && <div role="group">{render(node.children, depth + 1)}</div>}</div>);
  return <div className="change-tree" role="tree">{render(buildChangeTree(changes))}</div>;
}
function diffLineClass(line: string) {
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-meta';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-remove';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'diff-meta';
  return '';
}

function CodeReview({ tab }: { tab: WorkspaceTab }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<GitChange | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(true), [diffLoading, setDiffLoading] = useState(false), [error, setError] = useState('');
  const [changeView, setChangeView] = useState<ChangeView>('flat');
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set<string>());
  const loadStatus = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const next = await api<GitStatus>(`/workspace/${tab.id}/git/status`);
      setStatus(next);
      setSelected(previous => previous && next.changes.some(change => changeKey(change) === changeKey(previous)) ? previous : next.changes[0] ?? null);
    } catch (error) { setError(errorText(error)); } finally { setLoading(false); }
  }, [tab.id]);
  useEffect(() => { void loadStatus(); }, [loadStatus]);
  useEffect(() => {
    if (!selected) { setDiff(null); return; }
    const controller = new AbortController(); setDiffLoading(true); setError('');
    void api<GitDiff>(`/workspace/${tab.id}/git/diff?path=${encodeURIComponent(selected.path)}&kind=${selected.kind}`, 'GET', undefined, controller.signal)
      .then(setDiff).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setDiffLoading(false); });
    return () => controller.abort();
  }, [tab.id, selected]);
  return <div className="review-tool">
    <header className="tool-header"><div><strong>代码审查</strong><code>{tab.cwd}</code></div><button type="button" onClick={() => void loadStatus()} disabled={loading}>刷新</button></header>
    {error && <div className="tool-error" role="alert">{error}</div>}
    {loading && !status ? <div className="tool-empty">读取 Git 工作区…</div> : status && !status.repository ? <div className="tool-empty"><strong>当前目录不是 Git 仓库</strong><span>代码审查仅支持 Git 工作区。</span></div> : status && status.changes.length === 0 ? <div className="tool-empty"><strong>工作区没有未提交的修改</strong><span>这里会显示相对 HEAD 的 staged、unstaged 和 untracked 变化。</span></div> : status && <div className="review-layout">
      <aside className="change-list" aria-label="Changed files"><div className="change-view-switch" role="radiogroup" aria-label="文件展示方式"><button type="button" role="radio" aria-checked={changeView === 'flat'} className={changeView === 'flat' ? 'selected' : ''} onClick={() => setChangeView('flat')}>平铺</button><button type="button" role="radio" aria-checked={changeView === 'tree'} className={changeView === 'tree' ? 'selected' : ''} onClick={() => setChangeView('tree')}>树形</button></div>{groups.map(group => { const changes = status.changes.filter(change => change.kind === group.kind); return changes.length ? <section key={group.kind}><h3>{group.label}<span>{changes.length}</span></h3>{changeView === 'tree' ? <ChangeTree changes={changes} selected={selected} collapsed={collapsedFolders} onToggle={key => setCollapsedFolders(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onSelect={setSelected} /> : changes.map(change => <ChangeFile key={changeKey(change)} change={change} name={change.path} depth={0} selected={!!selected && changeKey(selected) === changeKey(change)} onSelect={setSelected} />)}</section> : null; })}</aside>
      <section className="diff-view" aria-label="文件差异">{selected && <div className="diff-heading"><span>{selected.path}</span><small>{groups.find(group => group.kind === selected.kind)?.label}</small></div>}{diffLoading ? <div className="tool-empty">读取 diff…</div> : diff ? <><pre>{diff.diff ? diff.diff.split('\n').map((line, index) => <span className={diffLineClass(line)} key={index}>{line}{'\n'}</span>) : '该文件没有可显示的文本差异。\n'}</pre>{diff.truncated && <div className="diff-truncated">Diff 超过 512 KB，仅显示前半部分。</div>}</> : null}</section>
    </div>}
  </div>;
}

export default function WorkspaceTools({ tab, theme, open, onOpen, onClose }: { tab: WorkspaceTab; theme: ThemeName; open: Tool | null; onOpen(tool: Tool): void; onClose(): void }) {
  const [shell, setShell] = useState<Session | null>(null), [shellBusy, setShellBusy] = useState(false), [shellError, setShellError] = useState('');
  const [shellStarted, setShellStarted] = useState(false);
  useEffect(() => { setShell(null); setShellStarted(false); setShellError(''); }, [tab.id]);
  useEffect(() => {
    if (open !== 'shell' || shell || shellBusy || shellStarted) return;
    setShellStarted(true);
    setShellBusy(true); setShellError('');
    void api<Session>(`/workspace/${tab.id}/shell`, 'POST').then(setShell).catch(error => setShellError(errorText(error))).finally(() => setShellBusy(false));
  }, [open, shell, shellBusy, tab.id]);
  const stopShell = async () => {
    setShellBusy(true); setShellError('');
    try { await api(`/workspace/${tab.id}/shell`, 'DELETE'); setShellStarted(true); setShell(null); } catch (error) { setShellError(errorText(error)); } finally { setShellBusy(false); }
  };
  return <div className={`workspace-tools ${open ? 'open' : ''}`}>
    <div className="tool-rail" role="group" aria-label="工作区工具">
      <button type="button" aria-pressed={open === 'shell'} aria-label="辅助终端" title="辅助终端 · Ctrl+Shift+T" data-tooltip="辅助终端" data-shortcut="Ctrl ⇧ T" onClick={() => open === 'shell' ? onClose() : onOpen('shell')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 8 4 4-4 4M12.5 16H18" /></svg></button>
      <button type="button" aria-pressed={open === 'review'} aria-label="代码审查" title="代码审查 · Ctrl+Shift+G" data-tooltip="代码审查" data-shortcut="Ctrl ⇧ G" onClick={() => open === 'review' ? onClose() : onOpen('review')}><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7" cy="6" r="2" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="12" r="2" /><path d="M7 8v8M9 6h2a6 6 0 0 1 6 4" /></svg></button>
    </div>
    {open && <aside className="tool-drawer" aria-label={open === 'shell' ? '辅助终端' : '代码审查'}>
      <button type="button" className="tool-close" aria-label="收起工具抽屉" title={`收起 · ${open === 'shell' ? 'Ctrl+Shift+T' : 'Ctrl+Shift+G'}`} onClick={onClose}>×</button>
      {open === 'shell' ? <div className="shell-tool"><header className="tool-header"><div><strong>辅助终端</strong><code>{tab.cwd}</code></div>{shell && <button type="button" onClick={() => void stopShell()} disabled={shellBusy}>结束终端</button>}</header>{shellError && <div className="tool-error" role="alert">{shellError}</div>}{shell ? <Suspense fallback={<div className="tool-empty">加载终端…</div>}><Terminal sessionId={tab.id} endpoint="shell" label="辅助终端" processLabel="Shell" theme={theme} active onExit={() => setShell(null)} /></Suspense> : <div className="tool-empty">{shellBusy ? '启动终端…' : <><strong>终端已结束</strong><button type="button" onClick={() => { setShellError(''); setShellBusy(true); void api(`/workspace/${tab.id}/shell`, 'DELETE').catch(() => {}).then(() => api<Session>(`/workspace/${tab.id}/shell`, 'POST')).then(next => { setShellStarted(true); setShell(next); }).catch(error => setShellError(errorText(error))).finally(() => setShellBusy(false)); }}>重新启动</button></>}</div>}</div> : <CodeReview tab={tab} />}
    </aside>}
  </div>;
}
