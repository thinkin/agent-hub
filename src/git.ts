import type { Agent } from './config.js';
import { quote, remotePath, runRemote } from './ssh.js';

export type GitChangeKind = 'staged' | 'unstaged' | 'untracked';
export interface GitChange { path: string; originalPath?: string; status: string; kind: GitChangeKind }
export interface GitStatus { repository: boolean; changes: GitChange[] }
export interface GitDiff { path: string; kind: GitChangeKind; diff: string; truncated: boolean }

const statusMarker = '__AGENT_HUB_GIT_STATUS__';
const diffMarker = '__AGENT_HUB_GIT_DIFF__';
const maxDiffBytes = 512 * 1024;

function environment(agent: Agent, cwd: string) {
  const initScript = agent.initScript ?? '';
  const initialize = initScript.trim() ? `set -e\neval ${quote(initScript)} </dev/null\n` : '';
  return `${initialize}cd ${remotePath(cwd)}\n`;
}

export async function gitStatus(agent: Agent, cwd: string, run = runRemote): Promise<GitStatus> {
  const command = `${environment(agent, cwd)}if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf '${statusMarker}1\n'; git status --porcelain=v1 -z --untracked-files=all; else printf '${statusMarker}0\n'; fi`;
  const output = await run(agent, command, '');
  const marker = output.lastIndexOf(statusMarker);
  if (marker < 0) throw new Error('Git 状态返回格式无效');
  const payload = output.slice(marker + statusMarker.length);
  if (payload.startsWith('0')) return { repository: false, changes: [] };
  if (!payload.startsWith('1\n')) throw new Error('Git 状态返回格式无效');
  const records = payload.slice(2).split('\0');
  const changes: GitChange[] = [];
  for (let index = 0; index < records.length;) {
    const record = records[index++];
    if (!record || record.length < 4) continue;
    const x = record[0], y = record[1], path = record.slice(3);
    const renamed = x === 'R' || x === 'C' || y === 'R' || y === 'C';
    const originalPath = renamed ? records[index++] || undefined : undefined;
    if (x === '?' && y === '?') changes.push({ path, status: '?', kind: 'untracked' });
    else {
      if (x !== ' ' && x !== '?') changes.push({ path, originalPath, status: x, kind: 'staged' });
      if (y !== ' ' && y !== '?') changes.push({ path, originalPath, status: y, kind: 'unstaged' });
    }
  }
  return { repository: true, changes };
}

export function validGitPath(path: string) {
  return !!path && path.length <= 4096 && !path.includes('\0') && !path.includes('\n') && !path.startsWith('/') && !path.split('/').includes('..');
}

export async function gitDiff(agent: Agent, cwd: string, path: string, kind: GitChangeKind, run = runRemote): Promise<GitDiff> {
  if (!validGitPath(path)) throw new Error('Git 文件路径无效');
  const target = quote(path);
  const diff = kind === 'staged'
    ? `git diff --cached --no-ext-diff --no-color --unified=3 -- ${target}`
    : kind === 'unstaged'
      ? `git diff --no-ext-diff --no-color --unified=3 -- ${target}`
      : `git diff --no-index --no-ext-diff --no-color --unified=3 -- /dev/null ${target} || test $? -eq 1`;
  const command = `${environment(agent, cwd)}printf '${diffMarker}\n'; { ${diff}; } | head -c ${maxDiffBytes + 1}`;
  const output = await run(agent, command, '');
  const marker = output.lastIndexOf(`${diffMarker}\n`);
  if (marker < 0) throw new Error('Git diff 返回格式无效');
  const value = output.slice(marker + diffMarker.length + 1);
  const bytes = Buffer.from(value);
  return { path, kind, diff: bytes.subarray(0, maxDiffBytes).toString(), truncated: bytes.length > maxDiffBytes };
}
