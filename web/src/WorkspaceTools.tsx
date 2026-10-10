import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, type GitChange, type GitChangeKind, type GitDiff, type GitStatus, type Session, type WorkspaceFileContent, type WorkspaceFileEntry, type WorkspaceFileListing, type WorkspaceTab } from './api';

const Terminal = lazy(() => import('./Terminal'));
type Tool = 'shell' | 'review';
type ChangeView = 'flat' | 'tree';
type ReviewView = 'files' | 'changes';
interface ChangeTreeNode { key: string; name: string; path: string; children: ChangeTreeNode[]; change?: GitChange }
export interface TextSelection { start: number; end: number; startLine: number; startColumn: number; endLine: number; endColumn: number; text: string }
export interface ReviewAnnotation { selection: TextSelection; comment: string }

const groups: { kind: GitChangeKind; label: string }[] = [
  { kind: 'staged', label: '已暂存' },
  { kind: 'unstaged', label: '未暂存' },
  { kind: 'untracked', label: '未跟踪' },
];
function errorText(error: unknown) { return error instanceof Error ? error.message : String(error); }
function changeKey(change: GitChange) { return `${change.kind}:${change.path}`; }
function cleanPromptText(value: string) { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''); }
function positionAt(content: string, offset: number) {
  const before = content.slice(0, offset), lastBreak = before.lastIndexOf('\n');
  return { line: before.split('\n').length, column: offset - lastBreak };
}
export function textSelection(content: string, start: number, end: number): TextSelection | null {
  const from = Math.min(start, end), to = Math.max(start, end);
  if (from === to || from < 0 || to > content.length) return null;
  const first = positionAt(content, from), last = positionAt(content, to);
  return { start: from, end: to, startLine: first.line, startColumn: first.column, endLine: last.line, endColumn: last.column, text: content.slice(from, to) };
}
export function buildReviewPrompt(path: string, annotations: ReviewAnnotation[]) {
  const details = annotations.map((annotation, index) => {
    const excerpt = cleanPromptText(annotation.selection.text).split('\n').map(line => `    ${line}`).join('\n');
    return `${index + 1}. 选中内容：\n${excerpt}\n   标注：${cleanPromptText(annotation.comment.trim())}`;
  }).join('\n\n');
  return `请审阅并直接修改当前工作区中的文件 \`${path}\`。只处理下面的标注，避免无关改动；如果文件已经变化，请根据选中内容定位。完成后简要说明修改结果。\n\n${details}`;
}

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

function GitReview({ tab }: { tab: WorkspaceTab }) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [selected, setSelected] = useState<GitChange | null>(null);
  const [diff, setDiff] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(true), [diffLoading, setDiffLoading] = useState(false), [error, setError] = useState('');
  const [changeView, setChangeView] = useState<ChangeView>('tree');
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set<string>());
  const [refreshVersion, setRefreshVersion] = useState(0);
  const diffCache = useRef(new Map<string, GitDiff>());
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
    const key = changeKey(selected), cached = diffCache.current.get(key);
    if (cached) { setDiff(cached); setDiffLoading(false); return; }
    const controller = new AbortController(); setDiffLoading(true); setError('');
    void api<GitDiff>(`/workspace/${tab.id}/git/diff?path=${encodeURIComponent(selected.path)}&kind=${selected.kind}`, 'GET', undefined, controller.signal)
      .then(next => { diffCache.current.set(key, next); setDiff(next); }).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }).finally(() => { if (!controller.signal.aborted) setDiffLoading(false); });
    return () => controller.abort();
  }, [tab.id, selected, refreshVersion]);
  const refresh = () => { diffCache.current.clear(); setDiff(null); setRefreshVersion(version => version + 1); void loadStatus(); };
  return <div className="review-tool git-review">
    <header className="tool-header"><div><strong>Git 变更</strong><code>{tab.cwd}</code></div><button type="button" onClick={refresh} disabled={loading}>刷新</button></header>
    {error && <div className="tool-error" role="alert">{error}</div>}
    {loading && !status ? <div className="tool-empty">读取 Git 工作区…</div> : status && !status.repository ? <div className="tool-empty"><strong>当前目录不是 Git 仓库</strong><span>文件审阅仍可在“文件”视图中使用。</span></div> : status && status.changes.length === 0 ? <div className="tool-empty"><strong>工作区没有未提交的修改</strong><span>这里会显示相对 HEAD 的 staged、unstaged 和 untracked 变化。</span></div> : status && <div className="review-layout">
      <aside className="change-list" aria-label="Changed files"><div className="change-view-switch" role="radiogroup" aria-label="文件展示方式"><button type="button" role="radio" aria-checked={changeView === 'flat'} className={changeView === 'flat' ? 'selected' : ''} onClick={() => setChangeView('flat')}>平铺</button><button type="button" role="radio" aria-checked={changeView === 'tree'} className={changeView === 'tree' ? 'selected' : ''} onClick={() => setChangeView('tree')}>树形</button></div>{groups.map(group => { const changes = status.changes.filter(change => change.kind === group.kind); return changes.length ? <section key={group.kind}><h3>{group.label}<span>{changes.length}</span></h3>{changeView === 'tree' ? <ChangeTree changes={changes} selected={selected} collapsed={collapsedFolders} onToggle={key => setCollapsedFolders(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} onSelect={setSelected} /> : changes.map(change => <ChangeFile key={changeKey(change)} change={change} name={change.path} depth={0} selected={!!selected && changeKey(selected) === changeKey(change)} onSelect={setSelected} />)}</section> : null; })}</aside>
      <section className="diff-view" aria-label="文件差异">{selected && <div className="diff-heading"><span>{selected.path}</span><small>{groups.find(group => group.kind === selected.kind)?.label}</small></div>}{diffLoading ? <div className="tool-empty">读取 diff…</div> : diff ? <><pre>{diff.diff ? diff.diff.split('\n').map((line, index) => <span className={diffLineClass(line)} key={index}>{line}{'\n'}</span>) : '该文件没有可显示的文本差异。\n'}</pre>{diff.truncated && <div className="diff-truncated">Diff 超过 512 KB，仅显示前半部分。</div>}</> : null}</section>
    </div>}
  </div>;
}

function FileTree({ tabId, selected, onSelect }: { tabId: string; selected: string; onSelect(path: string): void }) {
  const [listings, setListings] = useState<Record<string, WorkspaceFileListing>>({});
  const [expanded, setExpanded] = useState(() => new Set<string>(['']));
  const [loading, setLoading] = useState(() => new Set<string>());
  const [query, setQuery] = useState(''), [search, setSearch] = useState<WorkspaceFileListing | null>(null), [error, setError] = useState('');
  const load = useCallback(async (path: string) => {
    setLoading(previous => new Set(previous).add(path)); setError('');
    try { const next = await api<WorkspaceFileListing>(`/workspace/${tabId}/files?path=${encodeURIComponent(path)}`); setListings(previous => ({ ...previous, [path]: next })); }
    catch (error) { setError(errorText(error)); }
    finally { setLoading(previous => { const next = new Set(previous); next.delete(path); return next; }); }
  }, [tabId]);
  useEffect(() => { void load(''); }, [load]);
  useEffect(() => {
    const value = query.trim(); if (!value) { setSearch(null); return; }
    const controller = new AbortController();
    const timer = setTimeout(() => { setError(''); void api<WorkspaceFileListing>(`/workspace/${tabId}/files?query=${encodeURIComponent(value)}`, 'GET', undefined, controller.signal).then(setSearch).catch(error => { if (!controller.signal.aborted) setError(errorText(error)); }); }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, tabId]);
  const toggle = (entry: WorkspaceFileEntry) => {
    if (entry.type !== 'directory') return;
    setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; });
    if (!listings[entry.path]) void load(entry.path);
  };
  const render = (path = '', depth = 0): React.ReactNode => (listings[path]?.entries ?? []).map(entry => entry.type === 'directory'
    ? <div className="workspace-file-branch" role="treeitem" aria-expanded={expanded.has(entry.path)} key={entry.path}><button type="button" className="workspace-file-row directory" style={{ paddingLeft: `${9 + depth * 14}px` }} onClick={() => toggle(entry)}><span className="tree-chevron" aria-hidden="true">{expanded.has(entry.path) ? '⌄' : '›'}</span><span>{entry.name}</span></button>{expanded.has(entry.path) && <div role="group">{loading.has(entry.path) ? <span className="file-tree-loading">读取中…</span> : render(entry.path, depth + 1)}</div>}</div>
    : <button type="button" role="treeitem" aria-selected={selected === entry.path} className={`workspace-file-row file ${selected === entry.path ? 'selected' : ''}`} style={{ paddingLeft: `${23 + depth * 14}px` }} title={entry.path} onClick={() => onSelect(entry.path)} key={entry.path}>{entry.name}</button>);
  return <aside className="workspace-file-sidebar" aria-label="工作区文件">
    <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索文件" aria-label="搜索文件" />
    <div className="workspace-file-tree" role="tree" aria-label="文件树" aria-busy={loading.size > 0}>{query.trim() ? (search?.entries.map(entry => <button type="button" role="treeitem" aria-selected={selected === entry.path} className={`workspace-file-row search-result ${selected === entry.path ? 'selected' : ''}`} title={entry.path} onClick={() => onSelect(entry.path)} key={entry.path}>{entry.path}</button>) ?? <span className="file-tree-loading">搜索中…</span>) : render()}</div>
    {(listings['']?.truncated || search?.truncated) && <p className="file-tree-note">结果过多，仅显示前一部分</p>}
    {error && <p className="file-tree-error" role="alert">{error}</p>}
  </aside>;
}

function FileReview({ tab, active, onSubmitPrompt, initialSelectedPath, onSelectedPathChange }: { tab: WorkspaceTab; active: boolean; onSubmitPrompt(text: string): boolean; initialSelectedPath: string; onSelectedPathChange(path: string): void }) {
  const [selectedPath, setSelectedPath] = useState(initialSelectedPath);
  const [file, setFile] = useState<WorkspaceFileContent | null>(null);
  const [selection, setSelection] = useState<TextSelection | null>(null);
  const [composerPosition, setComposerPosition] = useState<{ left: number; top: number } | null>(null);
  const [comment, setComment] = useState(''), [annotations, setAnnotations] = useState<ReviewAnnotation[]>([]), [batch, setBatch] = useState(false), [wrap, setWrap] = useState(true);
  const [loading, setLoading] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [polling, setPolling] = useState(false);
  const fileRef = useRef<WorkspaceFileContent | null>(null), fileMain = useRef<HTMLElement>(null), gutter = useRef<HTMLPreElement>(null), viewer = useRef<HTMLTextAreaElement>(null), commentInput = useRef<HTMLTextAreaElement>(null);
  const selecting = useRef(false), selectionPoint = useRef({ x: 0, y: 0 });
  fileRef.current = file;
  const closeComposer = () => { setSelection(null); setComposerPosition(null); setComment(''); };
  const clearDraft = () => { closeComposer(); setAnnotations([]); };
  const hasDraft = !!selection || !!comment.trim() || annotations.length > 0;
  const loadFile = useCallback(async (path: string, revision = '') => {
    setLoading(true); setError('');
    try {
      const next = await api<WorkspaceFileContent>(`/workspace/${tab.id}/file?path=${encodeURIComponent(path)}${revision ? `&revision=${encodeURIComponent(revision)}` : ''}`);
      if (next.changed) { setFile(next); setSelection(null); }
      return next;
    } catch (error) { setError(errorText(error)); return null; }
    finally { setLoading(false); }
  }, [tab.id]);
  const chooseFile = (path: string) => {
    if (path === selectedPath) return;
    if (hasDraft && !confirm('切换文件会清空尚未发送的标注，继续吗？')) return;
    clearDraft(); setSelectedPath(path); onSelectedPathChange(path); setFile(null); setNotice('');
  };
  useEffect(() => { if (selectedPath && !fileRef.current) void loadFile(selectedPath); }, [selectedPath, loadFile]);
  useEffect(() => {
    if (!active || !selectedPath || !fileRef.current) return;
    void loadFile(selectedPath, fileRef.current.revision);
  }, [active, selectedPath, loadFile]);
  useEffect(() => {
    if (!selection) return;
    const frame = requestAnimationFrame(() => commentInput.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [selection]);
  useEffect(() => {
    if (!polling || !selectedPath) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const deadline = Date.now() + 60_000;
    const poll = async () => {
      if (disposed) return;
      if (document.hidden) { timer = setTimeout(poll, 3000); return; }
      const current = fileRef.current;
      if (!current) { setPolling(false); return; }
      const next = await loadFile(selectedPath, current.revision);
      if (disposed) return;
      if (next?.changed) { setNotice('文件已更新'); setPolling(false); return; }
      if (Date.now() < deadline) timer = setTimeout(poll, 3000); else setPolling(false);
    };
    timer = setTimeout(poll, 3000);
    return () => { disposed = true; clearTimeout(timer); };
  }, [polling, selectedPath, loadFile]);
  useEffect(() => {
    if (!notice || polling) return;
    const timer = setTimeout(() => setNotice(current => current === notice ? '' : current), 3000);
    return () => clearTimeout(timer);
  }, [notice, polling]);
  const captureSelection = (target: HTMLTextAreaElement, clientX?: number, clientY?: number) => {
    if (!file?.content) return;
    const next = textSelection(file.content, target.selectionStart, target.selectionEnd);
    if (next && next.text.length > 16 * 1024) { setError('单个选区不能超过 16 KiB'); closeComposer(); return; }
    if (!next) { closeComposer(); return; }
    const bounds = target.getBoundingClientRect(), mainBounds = fileMain.current?.getBoundingClientRect() ?? bounds;
    const anchorX = clientX && clientX > 0 ? clientX : bounds.right - 330;
    const anchorY = clientY && clientY > 0 ? clientY : bounds.top + 42;
    const composerWidth = Math.min(320, Math.max(0, mainBounds.width - 16));
    setError(''); setComment(''); setSelection(next);
    setComposerPosition({ left: Math.max(8, Math.min(anchorX - mainBounds.left + 12, mainBounds.width - composerWidth - 8)), top: Math.max(8, Math.min(anchorY - mainBounds.top + 10, mainBounds.height - 190)) });
  };
  const currentAnnotation = selection && comment.trim() ? { selection, comment: comment.trim() } : null;
  const addAnnotation = () => {
    if (!currentAnnotation) return;
    if (annotations.length >= 20) { setError('一个批次最多包含 20 条标注'); return; }
    setAnnotations(previous => [...previous, currentAnnotation]); closeComposer();
    if (viewer.current) { viewer.current.selectionStart = viewer.current.selectionEnd; }
  };
  const submit = (items: ReviewAnnotation[]) => {
    if (!selectedPath || !items.length) return;
    const prompt = buildReviewPrompt(selectedPath, items);
    if (prompt.length > 48 * 1024) { setError('本次审阅内容超过 48 KiB，请减少选区或分批发送'); return; }
    if (!onSubmitPrompt(prompt)) { setError('当前 Agent 终端尚未连接，标注已保留'); return; }
    clearDraft(); setError(''); setNotice('已发送给 Agent'); setPolling(true);
  };
  const toggleBatch = () => {
    if (batch && hasDraft && !confirm('关闭批量模式会清空尚未发送的标注，继续吗？')) return;
    if (batch) clearDraft(); setBatch(value => !value);
  };
  const content = file?.content ?? '';
  const lines = Math.max(1, content.split('\n').length);
  return <div className="review-tool file-review">
    <header className="tool-header"><div><strong>文件审阅</strong><code>{selectedPath || tab.cwd}</code></div><div className="file-review-actions"><label><input type="checkbox" checked={wrap} onChange={event => { closeComposer(); setWrap(event.target.checked); }} />换行</label><label><input type="checkbox" checked={batch} onChange={toggleBatch} />批量</label>{selectedPath && <button type="button" onClick={() => void loadFile(selectedPath)}>刷新</button>}</div></header>
    {error && <div className="tool-error" role="alert">{error}</div>}
    {notice && <div className={`tool-notice ${notice === '已发送给 Agent' ? 'in-progress' : 'complete'}`} role="status">{notice}{polling ? ' · 等待文件更新' : ''}</div>}
    <div className="file-review-layout">
      <FileTree tabId={tab.id} selected={selectedPath} onSelect={chooseFile} />
      <section className="file-review-main" aria-label="文件内容" ref={fileMain}>
        {!selectedPath ? <div className="tool-empty"><strong>选择一个文本文件</strong><span>圈选内容、填写标注，然后交给当前 Agent 修改。</span></div> : loading && !file ? <div className="tool-empty">读取文件…</div> : file?.content !== undefined ? <>
          <div className={`file-code-frame ${wrap ? 'wrap' : ''}`}><pre className="file-line-numbers" aria-hidden="true" ref={gutter}>{Array.from({ length: lines }, (_, index) => index + 1).join('\n')}</pre><textarea ref={viewer} className="file-text-viewer" readOnly spellCheck={false} wrap={wrap ? 'soft' : 'off'} value={content} aria-label={`${selectedPath} 文件内容`} onMouseDown={event => { selecting.current = true; selectionPoint.current = { x: event.clientX, y: event.clientY }; }} onMouseMove={event => { if (selecting.current) selectionPoint.current = { x: event.clientX, y: event.clientY }; }} onMouseUp={event => { selecting.current = false; selectionPoint.current = { x: event.clientX, y: event.clientY }; const target = event.currentTarget; requestAnimationFrame(() => captureSelection(target, selectionPoint.current.x, selectionPoint.current.y)); }} onKeyUp={event => captureSelection(event.currentTarget)} onScroll={event => { if (!wrap && gutter.current) gutter.current.scrollTop = event.currentTarget.scrollTop; }} /></div>
          {selection && composerPosition && <div className="annotation-composer" role="dialog" aria-label="添加审阅标注" style={composerPosition}>
            <div className="annotation-composer-heading"><span>选中内容</span><button type="button" aria-label="关闭标注" onClick={closeComposer}>×</button></div>
            <blockquote>{selection.text.length > 180 ? `${selection.text.slice(0, 180)}…` : selection.text}</blockquote>
            <textarea ref={commentInput} aria-label="审阅标注" value={comment} maxLength={2048} placeholder="写下希望 Agent 如何审阅或修改…" onChange={event => setComment(event.target.value)} onKeyDown={event => { if (event.nativeEvent.isComposing) return; if (event.key === 'Escape') { event.preventDefault(); closeComposer(); } else if (event.key === 'Enter' && !event.shiftKey && currentAnnotation) { event.preventDefault(); if (batch) addAnnotation(); else submit([currentAnnotation]); } }} />
            <div className="annotation-composer-actions"><span>Enter 发送 · Shift+Enter 换行</span><button type="button" className="primary" disabled={!currentAnnotation} onClick={() => { if (!currentAnnotation) return; if (batch) addAnnotation(); else submit([currentAnnotation]); }}>{batch ? '添加标注' : '交给 Agent'}</button></div>
          </div>}
          {batch && annotations.length > 0 && <aside className="annotation-rail" aria-label="待发送标注"><header><strong>{annotations.length} 条待发送</strong><button type="button" aria-label="清空待发送标注" onClick={() => setAnnotations([])}>清空</button></header><ol>{annotations.map((annotation, index) => <li key={`${annotation.selection.start}:${index}`}><blockquote title={annotation.selection.text}>{annotation.selection.text.length > 80 ? `${annotation.selection.text.slice(0, 80)}…` : annotation.selection.text}</blockquote><p>{annotation.comment}</p><button type="button" aria-label={`删除标注 ${index + 1}`} onClick={() => setAnnotations(previous => previous.filter((_, item) => item !== index))}>×</button></li>)}</ol><button type="button" className="primary annotation-rail-submit" onClick={() => submit(annotations)}>交给 Agent</button></aside>}
        </> : null}
      </section>
    </div>
  </div>;
}

export default function WorkspaceTools({ tab, open, onOpen, onClose, onSubmitPrompt, initialReviewFile, onReviewFileChange }: { tab: WorkspaceTab; open: Tool | null; onOpen(tool: Tool): void; onClose(): void; onSubmitPrompt(text: string): boolean; initialReviewFile: string; onReviewFileChange(path: string): void }) {
  const [shell, setShell] = useState<Session | null>(null), [shellBusy, setShellBusy] = useState(false), [shellError, setShellError] = useState('');
  const [shellStarted, setShellStarted] = useState(false), [reviewView, setReviewView] = useState<ReviewView>('files');
  const [reviewOpened, setReviewOpened] = useState(open === 'review');
  useEffect(() => { setShell(null); setShellStarted(false); setShellError(''); }, [tab.id]);
  useEffect(() => { if (open === 'review') setReviewOpened(true); }, [open]);
  useEffect(() => {
    if (open !== 'shell' || shell || shellBusy || shellStarted) return;
    setShellStarted(true); setShellBusy(true); setShellError('');
    void api<Session>(`/workspace/${tab.id}/shell`, 'POST').then(setShell).catch(error => setShellError(errorText(error))).finally(() => setShellBusy(false));
  }, [open, shell, shellBusy, shellStarted, tab.id]);
  const stopShell = async () => {
    setShellBusy(true); setShellError('');
    try { await api(`/workspace/${tab.id}/shell`, 'DELETE'); setShellStarted(true); setShell(null); } catch (error) { setShellError(errorText(error)); } finally { setShellBusy(false); }
  };
  return <div className={`workspace-tools ${open ? 'open' : ''}`}>
    <div className="tool-rail" role="group" aria-label="工作区工具">
      <button type="button" aria-pressed={open === 'shell'} aria-label="辅助终端" title="辅助终端 · Ctrl+Shift+T" data-tooltip="辅助终端" data-shortcut="Ctrl ⇧ T" onClick={() => open === 'shell' ? onClose() : onOpen('shell')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 8 4 4-4 4M12.5 16H18" /></svg></button>
      <button type="button" aria-pressed={open === 'review'} aria-label="审阅" title="审阅 · Ctrl+Shift+G" data-tooltip="审阅" data-shortcut="Ctrl ⇧ G" onClick={() => open === 'review' ? onClose() : onOpen('review')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h10l4 4v12H5zM15 4v5h4M8 13h8M8 16h5" /></svg></button>
    </div>
    {open === 'shell' && <aside className="tool-drawer" aria-label="辅助终端">
      <button type="button" className="tool-close" aria-label="收起工具抽屉" title="收起 · Ctrl+Shift+T" onClick={onClose}>×</button>
      <div className="shell-tool"><header className="tool-header"><div><strong>辅助终端</strong><code>{tab.cwd}</code></div>{shell && <button type="button" onClick={() => void stopShell()} disabled={shellBusy}>结束终端</button>}</header>{shellError && <div className="tool-error" role="alert">{shellError}</div>}{shell ? <Suspense fallback={<div className="tool-empty">加载终端…</div>}><Terminal sessionId={tab.id} endpoint="shell" label="辅助终端" processLabel="Shell" active onExit={() => setShell(null)} /></Suspense> : <div className="tool-empty">{shellBusy ? '启动终端…' : <><strong>终端已结束</strong><button type="button" onClick={() => { setShellError(''); setShellBusy(true); void api(`/workspace/${tab.id}/shell`, 'DELETE').catch(() => {}).then(() => api<Session>(`/workspace/${tab.id}/shell`, 'POST')).then(next => { setShellStarted(true); setShell(next); }).catch(error => setShellError(errorText(error))).finally(() => setShellBusy(false)); }}>重新启动</button></>}</div>}</div>
    </aside>}
    {reviewOpened && <aside className="tool-drawer review-drawer" aria-label="审阅" hidden={open !== 'review'}>
      <button type="button" className="tool-close" aria-label="收起工具抽屉" title="收起 · Ctrl+Shift+G" onClick={onClose}>×</button>
      <nav className="review-view-tabs" aria-label="审阅内容"><button type="button" aria-current={reviewView === 'files' ? 'page' : undefined} onClick={() => setReviewView('files')}>文件</button><button type="button" aria-current={reviewView === 'changes' ? 'page' : undefined} onClick={() => setReviewView('changes')}>变更</button></nav>
      <div className="review-view" hidden={reviewView !== 'files'}><FileReview tab={tab} active={open === 'review' && reviewView === 'files'} onSubmitPrompt={onSubmitPrompt} initialSelectedPath={initialReviewFile} onSelectedPathChange={onReviewFileChange} /></div>
      {reviewView === 'changes' && <GitReview tab={tab} />}
    </aside>}
  </div>;
}
