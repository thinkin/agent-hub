import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import type { Agent } from './config.js';

export function quote(value: string) { return `'${value.replaceAll("'", "'\\''")}'`; }
export function remotePath(value: string) {
  if (value === '~') return '"$HOME"';
  if (value.startsWith('~/')) return `"$HOME"/${quote(value.slice(2))}`;
  return quote(value);
}
export function sshArgs(target: string, command: string, terminal = false) {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', terminal ? '-tt' : '-T', '--', target, command];
}
export function loginCommand(command: string) { return `bash -lc ${quote(command)}`; }
export function terminalEnvironment(source: NodeJS.ProcessEnv = process.env) {
  const environment = { ...source };
  delete environment.NO_COLOR;
  delete environment.FORCE_COLOR;
  environment.TERM = 'xterm-256color';
  environment.COLORTERM = 'truecolor';
  environment.TERM_PROGRAM = 'AgentHub';
  return environment as Record<string, string>;
}
export function runRemote(agent: Agent, command: string, input = '', signal?: AbortSignal): Promise<string> {
  if (agent.connection === 'local') return runLocal(command, input, signal);
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(agent.target, loginCommand(command)), { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '', error = '', size = 0, failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error('SSH 操作超时，请检查连接'); child.kill(); }, 25_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) { failure = new Error('远程返回数据超过限制'); child.kill(); }
      else output += chunk;
    });
    child.stderr.on('data', (chunk: string) => { error = (error + chunk).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(error.trim() || `SSH 命令退出 (${code})`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
function runLocal(command: string, input = '', signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/bash', ['-lc', command], { stdio: ['pipe', 'pipe', 'pipe'], signal });
    let output = '', error = '', size = 0, failure: Error | undefined;
    const timeout = setTimeout(() => { failure = new Error('本地操作超时'); child.kill(); }, 25_000);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 2 * 1024 * 1024) { failure = new Error('本地返回数据超过限制'); child.kill(); }
      else output += chunk;
    });
    child.stderr.on('data', (chunk: string) => { error = (error + chunk).slice(-4096); });
    child.stdin.on('error', () => {});
    child.on('error', err => { clearTimeout(timeout); reject(err); });
    child.on('close', code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(error.trim() || `本地命令退出 (${code})`));
      else resolve(output);
    });
    child.stdin.end(input);
  });
}
export function spawnTerminal(agent: Agent, command: string, cols: number, rows: number) {
  const terminalCommand = `unset NO_COLOR FORCE_COLOR; export TERM=xterm-256color COLORTERM=truecolor TERM_PROGRAM=AgentHub; ${command}`;
  if (agent.connection === 'local') {
    return pty.spawn('/bin/bash', ['-lc', terminalCommand], {
      name: 'xterm-256color', cols, rows, cwd: process.cwd(),
      env: terminalEnvironment(),
    });
  }
  return pty.spawn('ssh', sshArgs(agent.target, loginCommand(terminalCommand), true), {
    name: 'xterm-256color', cols, rows, cwd: process.cwd(),
    env: terminalEnvironment(),
  });
}
