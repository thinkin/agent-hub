import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { themes, type ThemeName } from './theme';

export default function Terminal({ sessionId, theme }: { sessionId: string; theme: ThemeName }) {
  const host = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerminal | null>(null);
  const [state, setState] = useState('连接终端…');
  const [attempt, setAttempt] = useState(0);
  const takeover = useRef(false);
  useEffect(() => {
    const terminal = new XTerminal({ cursorBlink: true, fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', fontSize: 13, lineHeight: 1.3, scrollback: 1500, theme: themes[theme].terminal, allowProposedApi: false });
    terminalRef.current = terminal;
    const fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(host.current!);
    let disposed = false, ready = false, reconnect: ReturnType<typeof setTimeout> | undefined;
    let ws: WebSocket;
    const resize = () => {
      if (!ready || disposed) return;
      fit.fit();
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: Math.min(500, Math.max(20, terminal.cols)), rows: Math.min(200, Math.max(5, terminal.rows)) }));
    };
    const connect = () => {
      ready = false; setState('连接终端…');
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/terminal/${sessionId}?takeover=${takeover.current}`);
      takeover.current = false;
      ws.onmessage = event => {
        if (disposed) return;
        const message = JSON.parse(event.data);
        if (message.type === 'snapshot') {
          terminal.reset(); terminal.resize(message.cols, message.rows);
          terminal.write(message.data, () => {
            if (disposed) return;
            ready = true; resize(); terminal.focus();
            setState(message.status === 'exited' ? 'Agent 进程已退出' : '已连接');
          });
        } else if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'status') setState(`Agent 进程已退出 (${message.exitCode ?? '—'})`);
      };
      ws.onclose = event => {
        ready = false;
        if (disposed) return;
        if (event.code === 4001) { setState('此终端由其他页面控制'); return; }
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
    return () => { disposed = true; terminalRef.current = null; clearTimeout(reconnect); observer.disconnect(); input.dispose(); ws.close(); terminal.dispose(); };
  }, [sessionId, attempt]);
  useEffect(() => { if (terminalRef.current) terminalRef.current.options.theme = themes[theme].terminal; }, [theme]);
  return <div className="terminal-panel">
    <div className="terminal-status"><span className={state === '已连接' ? 'live-dot' : 'muted-dot'} />{state}
      {state === '此终端由其他页面控制' && <button onClick={() => { takeover.current = true; setAttempt(x => x + 1); }}>接管终端</button>}
    </div>
    <div className="terminal-host" ref={host} aria-label="Agent 终端" />
  </div>;
}
