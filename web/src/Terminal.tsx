import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { themes, type ThemeName } from './theme';

export default function Terminal({ sessionId, theme, active, endpoint = 'terminal', label = 'Agent 终端', processLabel = 'Agent 进程', onExit }: { sessionId: string; theme: ThemeName; active: boolean; endpoint?: 'terminal' | 'shell'; label?: string; processLabel?: string; onExit?(): void }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const activeRef = useRef(active);
  const resizeRef = useRef<(() => void) | null>(null);
  const onExitRef = useRef(onExit);
  activeRef.current = active;
  onExitRef.current = onExit;
  const [state, setState] = useState('连接终端…');
  const [attempt, setAttempt] = useState(0);
  const takeover = useRef(false);
  const autoTakeover = useRef(false);
  useEffect(() => {
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.3, scrollback: 1500, theme: themes[theme].terminal, allowProposedApi: false });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!);
    let disposed = false, ready = false, reconnect: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket;
    const resize = () => {
      if (!ready || disposed || !activeRef.current) return;
      const viewportY = terminal.buffer.active.viewportY;
      const wasAtBottom = viewportY === terminal.buffer.active.baseY;
      fit.fit();
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
          terminal.reset(); terminal.resize(message.cols, message.rows);
          terminal.write(message.data, () => {
            if (disposed) return;
            ready = true; resize(); terminal.scrollToBottom();
            if (activeRef.current) terminal.focus();
            setState(message.status === 'exited' ? `${processLabel}已退出` : '已连接');
            if (message.status === 'exited') onExitRef.current?.();
          });
        } else if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'status') { setState(`${processLabel}已退出 (${message.exitCode ?? '—'})`); onExitRef.current?.(); }
      };
      ws.onclose = event => {
        ready = false;
        if (disposed) return;
        // A stale page still holds this terminal — take control automatically once, then fall back to a manual prompt.
        if (event.code === 4001) {
          if (!autoTakeover.current) { autoTakeover.current = true; takeover.current = true; setState('接管终端…'); reconnect = setTimeout(connect, 200); return; }
          setState('此终端由其他页面控制'); return;
        }
        if (event.code === 4004) { setState('会话已过期，请从历史恢复'); return; }
        setState('连接断开 · 2 秒后重试'); reconnect = setTimeout(connect, 2000);
      };
    };
    const input = terminal.onData(data => {
      if (!ready || ws.readyState !== WebSocket.OPEN) return;
      for (let offset = 0; offset < data.length; offset += 8000) ws.send(JSON.stringify({ type: 'input', data: data.slice(offset, offset + 8000) }));
    });
    const observer = new ResizeObserver(resize); observer.observe(host.current!);
    connect();
    return () => {
      disposed = true; terminalRef.current = null; resizeRef.current = null; clearTimeout(reconnect); observer.disconnect(); input.dispose();
      if (ws.readyState === WebSocket.CONNECTING) ws.onopen = () => ws.close();
      else if (ws.readyState === WebSocket.OPEN) ws.close();
      terminal.dispose();
    };
  }, [sessionId, endpoint, processLabel, attempt]);
  useEffect(() => {
    if (!active) return;
    const frame = requestAnimationFrame(() => { resizeRef.current?.(); terminalRef.current?.focus(); });
    return () => cancelAnimationFrame(frame);
  }, [active]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = themes[theme].terminal; }, [theme]);
  return <div className="terminal-panel" data-state={state === '已连接' ? 'connected' : 'other'} hidden={!active}>
    {state !== '已连接' && <div className="terminal-status"><span className="muted-dot" />{state}
      {state === '此终端由其他页面控制' && <button onClick={() => { takeover.current = true; setAttempt(x => x + 1); }}>接管终端</button>}
    </div>}
    <div className="terminal-host" ref={host} aria-label={label} />
  </div>;
}
