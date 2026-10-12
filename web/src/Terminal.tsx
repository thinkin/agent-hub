import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { terminalMinimumContrastRatio, terminalTheme } from './theme';

export interface TerminalHandle { submitPrompt(text: string): boolean }

const Terminal = forwardRef<TerminalHandle, { sessionId: string; active: boolean; endpoint?: 'terminal' | 'shell'; label?: string; processLabel?: string; onExit?(): void }>(function Terminal({ sessionId, active, endpoint = 'terminal', label = 'Agent 终端', processLabel = 'Agent 进程', onExit }, ref) {
  const pasteId = useId();
  const host = useRef<HTMLDivElement>(null);
  const scrollRail = useRef<HTMLDivElement>(null);
  const scrollThumb = useRef<HTMLDivElement>(null);
  const viewportId = useId();
  const terminalRef = useRef<XTerminal | null>(null);
  const activeRef = useRef(active);
  const resizeRef = useRef<(() => void) | null>(null);
  const onExitRef = useRef(onExit);
  const inputRef = useRef<(data: string) => boolean>(() => false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const submitRef = useRef<(text: string) => boolean>(() => false);
  activeRef.current = active;
  onExitRef.current = onExit;
  const [state, setState] = useState('连接终端…');
  const [controlBlocked, setControlBlocked] = useState(false);
  const controlDialog = useRef<HTMLDialogElement>(null);
  const controlTitle = useId(), controlDescription = useId();
  useEffect(() => {
    const dialog = controlDialog.current;
    if (controlBlocked && active) { if (!dialog?.open) dialog?.showModal(); }
    else dialog?.close();
  }, [controlBlocked, active]);
  const [attempt, setAttempt] = useState(0);
  const takeover = useRef(false);
  const autoTakeover = useRef(false);
  useImperativeHandle(ref, () => ({ submitPrompt: text => submitRef.current(text) }), []);
  useEffect(() => {
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.3, scrollback: 1500, minimumContrastRatio: terminalMinimumContrastRatio, theme: terminalTheme, allowProposedApi: false });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!);
    const rail = scrollRail.current!, thumb = scrollThumb.current!;
    let scrollFrame = 0, dragOffset: number | undefined;
    const syncScrollbar = () => {
      scrollFrame = 0;
      const buffer = terminal.buffer.active, height = rail.clientHeight;
      const thumbHeight = Math.min(height, Math.max(52, height * terminal.rows / (buffer.baseY + terminal.rows)));
      thumb.style.height = `${thumbHeight}px`;
      thumb.style.transform = `translateY(${buffer.baseY ? (height - thumbHeight) * buffer.viewportY / buffer.baseY : 0}px)`;
      thumb.hidden = buffer.baseY === 0;
      rail.setAttribute('aria-valuemax', String(buffer.baseY));
      rail.setAttribute('aria-valuenow', String(buffer.viewportY));
      rail.setAttribute('aria-disabled', String(buffer.baseY === 0));
    };
    const scheduleScrollbar = () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(syncScrollbar); };
    const scrollAt = (clientY: number) => {
      const travel = rail.clientHeight - thumb.offsetHeight;
      if (travel > 0) terminal.scrollToLine(Math.round(Math.max(0, Math.min(1, (clientY - rail.getBoundingClientRect().top - (dragOffset ?? 0)) / travel)) * terminal.buffer.active.baseY));
      scheduleScrollbar();
    };
    const pointerDown = (event: PointerEvent) => {
      if (!event.isPrimary || event.button !== 0 || terminal.buffer.active.baseY === 0) return;
      event.preventDefault(); rail.focus(); rail.setPointerCapture(event.pointerId);
      dragOffset = event.target === thumb ? event.clientY - thumb.getBoundingClientRect().top : thumb.offsetHeight / 2;
      scrollAt(event.clientY);
    };
    const pointerMove = (event: PointerEvent) => { if (rail.hasPointerCapture(event.pointerId)) scrollAt(event.clientY); };
    const pointerEnd = (event: PointerEvent) => { if (rail.hasPointerCapture(event.pointerId)) rail.releasePointerCapture(event.pointerId); dragOffset = undefined; };
    const scrollKey = (event: KeyboardEvent) => {
      const buffer = terminal.buffer.active;
      const positions: Record<string, number> = { ArrowUp: buffer.viewportY - 1, ArrowDown: buffer.viewportY + 1, PageUp: buffer.viewportY - terminal.rows, PageDown: buffer.viewportY + terminal.rows, Home: 0, End: buffer.baseY };
      if (event.key in positions) { event.preventDefault(); terminal.scrollToLine(positions[event.key]); scheduleScrollbar(); }
    };
    rail.addEventListener('pointerdown', pointerDown); rail.addEventListener('pointermove', pointerMove);
    rail.addEventListener('pointerup', pointerEnd); rail.addEventListener('pointercancel', pointerEnd); rail.addEventListener('keydown', scrollKey);
    const scrollListener = terminal.onScroll(scheduleScrollbar), renderListener = terminal.onRender(scheduleScrollbar);
    let disposed = false, ready = false, running = true, reconnect: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket;
    const sendInput = (data: string) => {
      if (!ready || !running || ws.readyState !== WebSocket.OPEN) return false;
      for (let offset = 0; offset < data.length; offset += 8000) ws.send(JSON.stringify({ type: 'input', data: data.slice(offset, offset + 8000) }));
      return true;
    };
    inputRef.current = sendInput;
    const resize = () => {
      if (!ready || disposed || !activeRef.current) return;
      const viewportY = terminal.buffer.active.viewportY;
      const wasAtBottom = viewportY === terminal.buffer.active.baseY;
      fit.fit();
      scheduleScrollbar();
      if (wasAtBottom) terminal.scrollToBottom();
      else terminal.scrollToLine(Math.min(viewportY, terminal.buffer.active.baseY));
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: Math.min(500, Math.max(20, terminal.cols)), rows: Math.min(200, Math.max(5, terminal.rows)) }));
    };
    resizeRef.current = resize;
    const connect = () => {
      ready = false; setState('连接终端…');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/${endpoint}/${sessionId}?takeover=${takeover.current}`);
      takeover.current = false;
      ws.onmessage = event => {
        if (disposed) return;
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') {
          running = message.status !== 'exited';
          terminal.reset(); terminal.resize(message.cols, message.rows);
          terminal.write(message.data, () => {
            if (disposed) return;
            ready = true; resize(); terminal.scrollToBottom();
            if (activeRef.current && !matchMedia('(pointer: coarse), (max-width: 650px)').matches) terminal.focus();
            setState(message.status === 'exited' ? `${processLabel}已退出` : '已连接');
            setControlBlocked(false);
            if (message.status === 'exited') onExitRef.current?.();
          });
        } else if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'status') { running = false; setState(`${processLabel}已退出 (${message.exitCode ?? '—'})`); onExitRef.current?.(); }
      };
      ws.onclose = event => {
        ready = false;
        if (disposed) return;
        // A stale page still holds this terminal — take control automatically once, then fall back to a manual prompt.
        if (event.code === 4001) {
          if (!autoTakeover.current) { autoTakeover.current = true; takeover.current = true; setState('接管终端…'); reconnect = setTimeout(connect, 200); return; }
          setState('此终端由其他页面控制'); setControlBlocked(true); return;
        }
        if (event.code === 4004) { setState('会话已过期，请从历史恢复'); return; }
        setState('连接断开 · 2 秒后重试'); reconnect = setTimeout(connect, 2000);
      };
    };
    submitRef.current = text => {
      if (!text || !ready || !running || ws.readyState !== WebSocket.OPEN) return false;
      const accepted = sendInput(`\x1b[200~${text}\x1b[201~`);
      if (accepted) { sendInput('\r'); terminal.focus(); }
      return accepted;
    };
    const input = terminal.onData(data => { sendInput(data); });
    const observer = new ResizeObserver(resize); observer.observe(host.current!);
    connect();
    return () => {
      cancelAnimationFrame(scrollFrame); scrollListener.dispose(); renderListener.dispose();
      rail.removeEventListener('pointerdown', pointerDown); rail.removeEventListener('pointermove', pointerMove);
      rail.removeEventListener('pointerup', pointerEnd); rail.removeEventListener('pointercancel', pointerEnd); rail.removeEventListener('keydown', scrollKey);
      disposed = true; terminalRef.current = null; resizeRef.current = null; submitRef.current = () => false; inputRef.current = () => false; clearTimeout(reconnect); observer.disconnect(); input.dispose();
      if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
      // xterm 5 leaves snapshot-reset frame callbacks queued. Drain writes and let
      // those callbacks run while the renderer still exists before releasing it.
      terminal.write('', () => requestAnimationFrame(() => terminal.dispose()));
    };
  }, [sessionId, endpoint, processLabel, attempt]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { resizeRef.current?.(); if (!matchMedia('(pointer: coarse), (max-width: 650px)').matches) terminalRef.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <div className="terminal-panel" data-state={state === '已连接' ? 'connected' : 'other'} hidden={!active}>
    <dialog ref={controlDialog} className="terminal-control-dialog" role="alertdialog" aria-modal="true" aria-labelledby={controlTitle} aria-describedby={controlDescription} onCancel={event => event.preventDefault()} onKeyDown={event => { if (event.key === 'Tab') { event.preventDefault(); event.currentTarget.querySelector('button')?.focus(); } }}>
      <h2 id={controlTitle}>此终端由其他页面控制</h2>
      <p id={controlDescription}>刷新页面或点击“接管终端”即可继续操作，另一页面将失去控制权。</p>
      <button className="primary" disabled={state === '接管终端…' || state === '连接终端…'} onClick={() => { takeover.current = true; setState('接管终端…'); setAttempt(x => x + 1); }}>{state === '接管终端…' || state === '连接终端…' ? '正在接管…' : '接管终端'}</button>
    </dialog>
    {state !== '已连接' && !controlBlocked && <div className="terminal-status"><span className="muted-dot" />{state}</div>}
    <div className="terminal-viewport-layout">
      <div className="terminal-scroll-rail" ref={scrollRail} role="scrollbar" aria-label="终端历史滚动" aria-controls={viewportId} aria-orientation="vertical" aria-valuemin={0} aria-valuemax={0} aria-valuenow={0} tabIndex={0}><div className="terminal-scroll-thumb" ref={scrollThumb} hidden /></div>
      <div className="terminal-host" id={viewportId} ref={host} aria-label={label} />
    </div>
    {pasteOpen && <form className="mobile-paste" id={pasteId} onSubmit={event => {
      event.preventDefault();
      if (pasteText && inputRef.current(`\x1b[200~${pasteText}\x1b[201~`)) { setPasteText(''); setPasteOpen(false); terminalRef.current?.focus(); }
    }}>
      <textarea rows={2} autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-label="粘贴到终端的文本" placeholder="在此粘贴或输入文本" value={pasteText} onChange={event => setPasteText(event.target.value)} />
      <div><button type="button" onClick={() => setPasteOpen(false)}>取消</button><button disabled={!pasteText || state !== '已连接'}>输入终端</button></div>
    </form>}
    <div className="mobile-terminal-keys" role="group" aria-label="终端快捷键">
      <div className="mobile-key-scroll">
      <button type="button" onPointerDown={event => event.preventDefault()} onClick={() => { const terminal = terminalRef.current; if (document.activeElement === terminal?.textarea) terminal.blur(); else terminal?.focus(); }}>键盘</button>
      <button type="button" aria-expanded={pasteOpen} aria-controls={pasteId} onClick={() => setPasteOpen(value => !value)}>粘贴</button>
      {([['Enter', '\r'], ['Ctrl+C', '\x03'], ['Esc', '\x1b'], ['Tab', '\t'], ['↑', '\x1b[A'], ['↓', '\x1b[B']] as const).map(([key, data]) =>
        <button type="button" key={key} aria-label={key} disabled={state !== '已连接'} onPointerDown={event => event.preventDefault()} onClick={() => inputRef.current(data)}>{key}</button>)}
      </div>
    </div>
  </div>;
});

export default Terminal;
