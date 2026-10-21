import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, type Note } from './api';

const quadrants = ['紧急不重要', '重要且紧急', '不紧急不重要', '重要不紧急'];
const colors: Array<[Note['color'], string]> = [['yellow', '黄色'], ['pink', '粉色'], ['green', '绿色'], ['blue', '蓝色'], ['purple', '紫色'], ['gray', '灰色']];
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const title = (note: Note) => note.content.trim().split('\n')[0]?.slice(0, 60) || '新便签';
const archivePrefix = '__agent_hub_archived__:';
const completedAt = (note: Note) => note.title.startsWith(archivePrefix) ? Number(note.title.slice(archivePrefix.length)) || 0 : 0;
const payload = (note: Note) => ({ title: note.title, content: note.content, color: note.color, layout: note.layout, quadrant: note.quadrant, order: note.order });
const changed = (note: Note, saved?: Note) => JSON.stringify(payload(note)) !== (saved && JSON.stringify(payload(saved)));

export default function Notes({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const current = useRef<Note[]>([]);
  const saved = useRef(new Map<string, Note>());
  const saving = useRef<Promise<boolean> | null>(null);
  const dragged = useRef('');
  const [notes, setNotes] = useState<Note[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const [palette, setPalette] = useState('');
  const [view, setView] = useState<'board' | 'archive'>('board');
  const [dragging, setDragging] = useState('');
  const replace = (next: Note[]) => { current.current = next; setNotes(next); };
  const dirty = notes.some(note => changed(note, saved.current.get(note.id)));

  useEffect(() => { if (visible) dialog.current?.showModal(); else dialog.current?.close(); }, [visible]);
  useEffect(() => {
    if (!visible || current.current.some(note => changed(note, saved.current.get(note.id)))) return;
    const controller = new AbortController();
    setLoading(true);
    api<Note[]>('/notes', 'GET', undefined, controller.signal).then(items => {
      saved.current = new Map(items.map(item => [item.id, item]));
      replace(items); setLoading(false);
    }).catch(err => { if (!controller.signal.aborted) { setError(message(err)); setLoading(false); } });
    return () => controller.abort();
  }, [visible]);

  function flush(): Promise<boolean> {
    if (saving.current) return saving.current;
    const task = (async () => {
      setStatus('保存中…');
      try {
        while (true) {
          const draft = current.current.find(note => changed(note, saved.current.get(note.id)));
          if (!draft) break;
          const result = await api<Note>(`/notes/${draft.id}`, 'PUT', { ...payload(draft), version: saved.current.get(draft.id)!.version });
          saved.current.set(result.id, result);
          replace(current.current.map(note => note.id === result.id ? { ...result, ...payload(note) } : note));
        }
        setStatus('已保存'); setError(''); return true;
      } catch (err) { setError(message(err)); setStatus('未保存'); return false; }
    })();
    saving.current = task;
    void task.finally(() => {
      saving.current = null;
      if (current.current.some(note => changed(note, saved.current.get(note.id)))) window.setTimeout(() => { void flush(); }, 0);
    });
    return task;
  }
  useEffect(() => {
    if (!dirty || error) return;
    const timer = window.setTimeout(() => { void flush(); }, 500);
    return () => window.clearTimeout(timer);
  }, [notes, dirty, error]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  async function close() {
    if (busy) return;
    setBusy(true); if (await flush()) onClose(); setBusy(false);
  }
  async function create(quadrant: number) {
    setBusy(true);
    try {
      if (!(await flush())) return;
      const note = await api<Note>('/notes', 'POST', {});
      const active = current.current.filter(item => !completedAt(item));
      const order = active.filter(item => item.quadrant === quadrant).reduce((maximum, item) => Math.max(maximum, item.order), -1) + 1;
      const placed = { ...note, title: '', quadrant, order };
      saved.current.set(note.id, note); replace([...current.current, placed]); setQuery(''); setStatus('待保存');
      requestAnimationFrame(() => document.getElementById(`note-text-${note.id}`)?.focus());
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  async function remove(id: string) {
    const note = current.current.find(item => item.id === id); if (!note) return;
    setBusy(true);
    try {
      if (!(await flush())) return;
      await api(`/notes/${id}`, 'DELETE', { version: saved.current.get(id)!.version });
      saved.current.delete(id); replace(current.current.filter(item => item.id !== id)); setDeleting('');
    } catch (err) { setError(message(err)); } finally { setBusy(false); }
  }
  function edit(id: string, patch: Partial<Note>) {
    replace(current.current.map(note => note.id === id ? { ...note, ...patch } : note)); setStatus('待保存');
  }
  function move(id: string, quadrant: number, beforeId?: string) {
    if (query.trim()) return;
    const moving = current.current.find(note => note.id === id); if (!moving) return;
    const target = current.current.filter(note => note.id !== id && !completedAt(note) && note.quadrant === quadrant).sort((a, b) => a.order - b.order);
    const index = beforeId ? Math.max(0, target.findIndex(note => note.id === beforeId)) : target.length;
    target.splice(index, 0, moving);
    const positions = new Map(target.map((note, order) => [note.id, order]));
    replace(current.current.map(note => positions.has(note.id) ? { ...note, quadrant, order: positions.get(note.id)! } : note));
    setStatus('待保存');
  }
  function drop(event: DragEvent, quadrant: number, beforeId?: string) {
    event.preventDefault(); event.stopPropagation(); move(dragged.current, quadrant, beforeId); dragged.current = '';
  }
  function startDrag(event: DragEvent<HTMLButtonElement>, note: Note) {
    dragged.current = note.id; setDragging(note.id);
    event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', note.id);
    const rect = event.currentTarget.closest('.sticky-strip')!.getBoundingClientRect();
    const ghost = document.createElement('div');
    ghost.className = `sticky-strip sticky-${note.color} sticky-drag-ghost`;
    ghost.textContent = note.content || '写点什么…';
    ghost.style.width = `${rect.width}px`; ghost.style.height = `${rect.height}px`;
    document.body.append(ghost); event.dataTransfer.setDragImage(ghost, 18, rect.height / 2);
    window.setTimeout(() => ghost.remove(), 0);
  }
  function archive(id: string) { edit(id, { title: `${archivePrefix}${Date.now()}` }); setPalette(''); setDeleting(''); }
  function restore(note: Note) {
    const order = current.current.filter(item => !completedAt(item) && item.quadrant === note.quadrant).reduce((maximum, item) => Math.max(maximum, item.order), -1) + 1;
    edit(note.id, { title: '', order });
  }

  const term = query.trim().toLocaleLowerCase();
  const activeNotes = notes.filter(note => !completedAt(note));
  const archivedNotes = notes.filter(note => completedAt(note)).sort((a, b) => completedAt(b) - completedAt(a));
  const filtered = activeNotes.filter(note => note.content.toLocaleLowerCase().includes(term));
  return <dialog ref={dialog} className="sticky-desktop" aria-label="便签管理" onCancel={event => { event.preventDefault(); void close(); }}>
    <header className="sticky-toolbar"><strong>{view === 'board' ? '便签' : '归档'}</strong>
      <input aria-label="搜索便签" placeholder="搜索便签" value={query} onChange={event => setQuery(event.target.value)} />
      {view === 'board' ? <button aria-label="查看归档" title="查看归档" onClick={() => { setView('archive'); setQuery(''); }}>归档</button> : <button aria-label="返回四象限" title="返回四象限" onClick={() => { setView('board'); setQuery(''); }}>返回</button>}
      <button aria-label="关闭便签管理" title="关闭" disabled={busy} onClick={() => void close()}>×</button>
      <span className="sr-only" role="status">{status || '已保存'}</span>
    </header>
    {view === 'board' ? <div className="sticky-canvas">
      {error && <div className="sticky-error" role="alert"><span>{error}</span><button disabled={busy} onClick={() => void flush()}>重试保存</button></div>}
      {quadrants.map((label, quadrant) => <section className={`sticky-quadrant quadrant-${quadrant}`} aria-label={label} key={label} onDragOver={event => { if (!term) event.preventDefault(); }} onDrop={event => drop(event, quadrant)}>
        <h2><span>{label}</span><button aria-label={`在${label}中新建便签`} title="在此象限新建" disabled={busy || loading || (!!error && !dirty)} onClick={() => void create(quadrant)}>＋</button></h2>
        <div className="sticky-list">{filtered.filter(note => note.quadrant === quadrant).sort((a, b) => a.order - b.order).map(note => <article className={`sticky-strip sticky-${note.color}${dragging === note.id ? ' is-dragging' : ''}`} aria-label={title(note)} key={note.id} onDragOver={event => { if (!term) event.preventDefault(); }} onDrop={event => drop(event, quadrant, note.id)}>
          <button className="sticky-handle" aria-label="拖动调整顺序" title={term ? '清除搜索后可排序' : '拖动调整顺序'} draggable={!term} onDragStart={event => startDrag(event, note)} onDragEnd={() => { dragged.current = ''; setDragging(''); }}>⠿</button>
          <textarea id={`note-text-${note.id}`} aria-label="便签内容" placeholder="写点什么…" maxLength={8000} value={note.content} disabled={busy} onChange={event => edit(note.id, { content: event.target.value })} />
          <button className="sticky-complete" aria-label="完成便签" title="完成并归档" onClick={() => archive(note.id)}>✓</button>
          <button className="sticky-more" aria-label="便签颜色" title="颜色" onClick={() => setPalette(value => value === note.id ? '' : note.id)}><span className="sticky-color-dot" /></button>
          <button className="sticky-remove" aria-label="删除便签" title="删除" onClick={() => setDeleting(note.id)}>×</button>
          {palette === note.id && <div className="sticky-palette" aria-label="便签颜色">{colors.map(([color, name]) => <button key={color} className={`sticky-${color}`} aria-label={name} aria-pressed={note.color === color} onClick={() => { edit(note.id, { color }); setPalette(''); }} />)}</div>}
          {deleting === note.id && <div className="sticky-delete" role="alert"><span>删除？</span><button onClick={() => setDeleting('')}>取消</button><button onClick={() => void remove(note.id)}>确认</button></div>}
        </article>)}</div>
      </section>)}
    </div> : <section className="sticky-archive" aria-label="已归档便签">
      <div className="sticky-archive-list">{archivedNotes.filter(note => note.content.toLocaleLowerCase().includes(term)).map(note => <article className={`sticky-archive-row sticky-${note.color}`} key={note.id}>
        <span className="sticky-archive-color" aria-hidden="true" /><div><p>{note.content || '空便签'}</p><time>{new Date(completedAt(note)).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</time></div>
        <button aria-label={`恢复 ${title(note)}`} onClick={() => restore(note)}>恢复</button><button className="danger-button" aria-label={`删除 ${title(note)}`} onClick={() => setDeleting(note.id)}>删除</button>
        {deleting === note.id && <div className="sticky-archive-delete" role="alert"><span>永久删除？</span><button onClick={() => setDeleting('')}>取消</button><button className="danger-button" onClick={() => void remove(note.id)}>确认</button></div>}
      </article>)}</div>
    </section>}
  </dialog>;
}
