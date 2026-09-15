import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, mkdir, writeFile, utimes } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { ConfigStore, agentInput, ensureLocalAgents, workspaceSchema } from '../src/config.js';
import { quote, remotePath, runRemote, spawnTerminal, sshArgs, terminalEnvironment } from '../src/ssh.js';
import { ClaudeAdapter } from '../src/agents/claude.js';
import { CodexAdapter } from '../src/agents/codex.js';
import { TraexAdapter } from '../src/agents/traex.js';
import { equalSecret } from '../src/server.js';
import { mergeConversations, tabSession, type Session } from '../web/src/api.js';

const agent = { ...agentInput.parse({ name: 'Development', target: 'dev-host', cwd: '~/project' }), id: randomUUID() };

test('configuration is atomic, private, metadata-only and serializes concurrent updates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-config-'));
  try {
    const store = await new ConfigStore(directory).load();
    await Promise.all([store.update(c => { c.agents.push(agent); }), store.update(c => { c.historyLimit = 50; })]);
    const reloaded = await new ConfigStore(directory).load();
    assert.equal(reloaded.get().agents[0].target, 'dev-host');
    assert.equal(reloaded.get().historyLimit, 50);
    assert.equal((await stat(join(directory, 'config.json'))).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(directory, 'config.json'), 'utf8'))).sort(), ['agents', 'historyLimit', 'recentCwds', 'version', 'workspace']);
    await assert.rejects(store.update(c => { c.historyLimit = -1; }));
    await store.update(c => { c.historyLimit = 10; });
    assert.equal(store.get().historyLimit, 10);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('legacy config migrates session metadata and keeps type-specific executable defaults', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-migrate-'));
  const agentId = randomUUID(), tabId = randomUUID(), legacySessionId = randomUUID();
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'config.json'), JSON.stringify({ version: 1, historyLimit: 30, agents: [{ id: agentId, name: 'Legacy', target: 'host', cwd: '~', executable: 'claude', configDir: '', initScript: '' }], workspace: { selectedAgentId: agentId, agents: { [agentId]: { tabs: [{ id: tabId, sessionId: randomUUID(), claudeId: legacySessionId, cwd: '~', target: 'host', configDir: '' }], activeTabId: tabId } } } }));
    const config = (await new ConfigStore(directory).load()).get();
    assert.equal(config.version, 3);
    assert.equal(config.workspace.tabs[0].agentSessionId, legacySessionId);
    assert.equal(config.workspace.tabs[0].agentId, agentId);
    assert.equal(config.workspace.tabs[0].type, 'claude-code');
    assert.equal(config.workspace.activeTabId, tabId);
    assert.equal(agentInput.parse({ name: 'Codex', type: 'codex', target: 'host' }).executable, 'codex');
    assert.equal(agentInput.parse({ name: 'TraeX', type: 'traex', target: 'host' }).executable, 'traex');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('startup discovers Claude, Codex and TraeX once with type-specific executables', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-local-agents-'));
  try {
    const store = await new ConfigStore(directory).load();
    const paths: Record<string, string> = { claude: '/bin/claude', codex: '/bin/codex', traex: '/bin/traex' };
    assert.equal(await ensureLocalAgents(store, async command => paths[command]), true);
    assert.deepEqual(store.get().agents.map(item => [item.type, item.name, item.executable]), [
      ['claude-code', `${hostname()} Claude`, '/bin/claude'], ['codex', `${hostname()} Codex`, '/bin/codex'], ['traex', `${hostname()} TraeX`, '/bin/traex'],
    ]);
    assert.equal(await ensureLocalAgents(store, async command => paths[command]), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('local discovery preserves SSH configuration and migrates local target metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-local-'));
  try {
    const store = await new ConfigStore(directory).load();
    await store.update(config => config.agents.push(agent));
    const find = async (command: string) => command === 'claude' ? '/opt/bin/claude' : '';
    assert.equal(await ensureLocalAgents(store, find), true);
    assert.equal(await ensureLocalAgents(store, find), false);
    const config = store.get();
    assert.equal(config.agents.length, 2);
    assert.deepEqual(config.agents[0], { id: config.agents[0].id, name: `${hostname()} Claude`, type: 'claude-code', connection: 'local', target: userInfo().username, cwd: '~', executable: '/opt/bin/claude', configDir: '', initScript: '' });
    assert.equal(config.agents[1].connection, 'ssh');
    assert.equal(await runRemote(config.agents[0], 'printf local-direct'), 'local-direct');
    const terminal = spawnTerminal(config.agents[0], 'printf local-pty', 80, 24);
    let output = '';
    terminal.onData(data => { output += data; });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { terminal.kill(); reject(new Error('local PTY timed out')); }, 3000);
      terminal.onExit(() => { clearTimeout(timer); resolve(); });
    });
    assert.match(output, /local-pty/);
    await store.update(value => {
      const local = value.agents[0];
      local.target = 'localhost';
      value.workspace.tabs = [{ id: randomUUID(), agentId: local.id, sessionId: randomUUID(), agentSessionId: randomUUID(), cwd: '~', type: 'claude-code', connection: 'local', target: 'localhost', configDir: '' }];
      value.workspace.activeTabId = null;
    });
    assert.equal(await ensureLocalAgents(store, find), true);
    assert.equal(store.get().agents[0].target, userInfo().username);
    assert.equal(store.get().workspace.tabs[0].target, userInfo().username);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('workspace metadata persists without titles or content and resolves sessions by environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-workspace-'));
  const session: Session = { id: randomUUID(), agentId: agent.id, agentName: agent.name, type: agent.type, connection: agent.connection, target: agent.target, configDir: '', cwd: '/work', agentSessionId: randomUUID(), status: 'running', created: 1 };
  const tab = { id: randomUUID(), agentId: agent.id, sessionId: session.id, agentSessionId: session.agentSessionId, cwd: session.cwd, type: agent.type, connection: agent.connection, target: session.target, configDir: '' };
  try {
    const store = await new ConfigStore(directory).load();
    await store.update(c => { c.agents.push(agent); c.workspace = { tabs: [tab], activeTabId: tab.id }; });
    assert.deepEqual((await new ConfigStore(directory).load()).get().workspace, store.get().workspace);
    const value = store.get().workspace;
    assert.throws(() => workspaceSchema.parse({ ...value, tabs: [{ ...tab, title: 'private content' }] }));
    assert.throws(() => workspaceSchema.parse({ ...value, tabs: [tab, tab] }));
    assert.throws(() => workspaceSchema.parse({ ...value, activeTabId: randomUUID() }));
    assert.equal(tabSession(tab, agent, [session])?.id, session.id);
    assert.equal(tabSession(tab, { ...agent, target: 'other-host' }, [session]), undefined);
    const resumed = { ...session, id: randomUUID() };
    assert.equal(tabSession(tab, agent, [{ ...session, status: 'exited' }, resumed])?.id, resumed.id);
    assert.equal(tabSession(tab, agent, []), undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('shell quoting prevents command expansion and preserves paths', () => {
  const dangerous = "weird ' directory; $(printf injected) `whoami`";
  assert.equal(execFileSync('/bin/bash', ['-c', `printf %s ${quote(dangerous)}`], { encoding: 'utf8' }), dangerous);
  assert.equal(execFileSync('/bin/bash', ['-c', `printf %s ${remotePath('~/' + dangerous)}`], { encoding: 'utf8' }), `${process.env.HOME}/${dangerous}`);
  assert.ok(sshArgs('dev-host', 'command').includes('StrictHostKeyChecking=yes'));
  assert.ok(sshArgs('dev-host', 'command').includes('BatchMode=yes'));
  assert.deepEqual(terminalEnvironment({ PATH: '/bin', TERM: 'xterm', TERM_PROGRAM: 'iTerm.app', NO_COLOR: '1', FORCE_COLOR: '1' }), { PATH: '/bin', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AgentHub' });
  assert.throws(() => agentInput.parse({ name: 'x', target: '-oProxyCommand=evil' }));
  assert.throws(() => agentInput.parse({ name: 'x', target: 'dev\nhost' }));
  assert.equal(equalSecret('é'.repeat(64), 'a'.repeat(64)), false);
});

test('agent adapters encapsulate native launch and resume commands', async () => {
  const claude = new ClaudeAdapter(), codex = new CodexAdapter(), traex = new TraexAdapter();
  const id = randomUUID();
  try {
    const claudePlan = await claude.prepareLaunch(agent, '/work');
    assert.match(claudePlan.command, /--session-id/); assert.ok(claudePlan.agentSessionId);
    const codexAgent = { ...agent, type: 'codex' as const, executable: 'codex' };
    const codexPlan = await codex.prepareLaunch(codexAgent, '/work', id);
    assert.match(codexPlan.command, new RegExp(`'codex' resume '${id}'`)); assert.equal(codexPlan.agentSessionId, id);
    // Codex and TraeX new sessions launch without a pre-assigned id and backfill the real one.
    const codexNew = await codex.prepareLaunch(codexAgent, '/work');
    assert.doesNotMatch(codexNew.command, /--session-id/); assert.equal(codexNew.agentSessionId, undefined); assert.equal(typeof codexNew.resolveSessionId, 'function');
    const traexAgent = { ...agent, type: 'traex' as const, executable: 'traex' };
    const traexPlan = await traex.prepareLaunch(traexAgent, '/work');
    assert.doesNotMatch(traexPlan.command, /--session-id/); assert.equal(traexPlan.agentSessionId, undefined); assert.equal(typeof traexPlan.resolveSessionId, 'function');
    const traexResume = await traex.prepareLaunch(traexAgent, '/work', id);
    assert.match(traexResume.command, new RegExp(`'traex' resume '${id}'`)); assert.equal(traexResume.agentSessionId, id);
  } finally { claude.close(); codex.close(); traex.close(); }
});

test('Codex and TraeX history reads their structured thread databases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-thread-history-'));
  const first = randomUUID(), second = randomUUID();
  try {
    execFileSync('sqlite3', [join(directory, 'state_5.sqlite'), 'CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, updated_at INTEGER, updated_at_ms INTEGER, archived INTEGER);']);
    execFileSync('sqlite3', [join(directory, 'state_5.sqlite'), `INSERT INTO threads VALUES ('${first}', '/one', 'First', 10, 10000, 0), ('${second}', '/two', 'Second', 20, 20000, 0);`]);
    const history = (type: 'codex' | 'traex', options: object) => JSON.parse(execFileSync('python3', ['src/agents/history.py', JSON.stringify({ type, configDir: directory, ...options })], { encoding: 'utf8' }).trim().replace('__AGENT_HUB_JSON__', ''));
    assert.deepEqual(history('codex', { limit: 1 }).items.map((item: { id: string }) => item.id), [second]);
    assert.equal(history('traex', { sessionId: first }).items[0].cwd, '/one');
    assert.deepEqual(history('codex', { sessionIds: [first, second] }).items.map((item: { id: string }) => item.id), [second, first]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('remote history spans projects, excludes nested subagents, handles partial records and pages', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-history-'));
  try {
    const projects = join(directory, 'projects');
    await mkdir(join(projects, 'one', 'subagents'), { recursive: true });
    await mkdir(join(projects, 'two'), { recursive: true });
    const first = randomUUID(), second = randomUUID(), nested = randomUUID();
    const a = join(projects, 'one', `${first}.jsonl`), b = join(projects, 'two', `${second}.jsonl`);
    await writeFile(a, JSON.stringify({ type: 'user', cwd: '/work/one', message: { content: 'Existing conversation before registration' } }) + '\n');
    await writeFile(b, [JSON.stringify({ type: 'user', cwd: '/work/two', message: { content: [{ type: 'text', text: '中文历史' }] } }), JSON.stringify({ type: 'custom-title', customTitle: 'Renamed conversation' }), '{"partial":'].join('\n'));
    await writeFile(join(projects, 'one', 'subagents', `${nested}.jsonl`), '{}');
    await utimes(a, 1000, 1000); await utimes(b, 2000, 2000);
    const history = (options: object) => JSON.parse(execFileSync('python3', ['src/agents/history.py', JSON.stringify({ configDir: directory, ...options })], { encoding: 'utf8' }).trim().replace('__AGENT_HUB_JSON__', ''));
    const latest = history({ limit: 1 });
    assert.equal(latest.total, 2); assert.equal(latest.items[0].id, second); assert.equal(latest.items[0].title, 'Renamed conversation');
    assert.equal(history({ offset: 1, limit: 1 }).items[0].id, first);
    assert.equal(history({ sessionId: first }).items[0].cwd, '/work/one');
    assert.deepEqual(history({ sessionIds: [first, second], limit: 30 }).items.map((item: { id: string }) => item.id), [second, first]);
    assert.equal(history({ sessionIds: [first] }).total, 1);
    assert.equal(history({ sessionIds: [] }).total, 0);
    assert.equal(history({ sessionId: randomUUID() }).total, 0);
    assert.equal(history({ configDir: join(directory, 'missing') }).items.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('conversation list merges shared agents, prefers titles, keeps active first and isolates environments', () => {
  const id = randomUUID(), old = randomUUID();
  const session: Session = { id: randomUUID(), agentId: randomUUID(), agentName: 'Another Agent', type: agent.type, connection: agent.connection, target: agent.target, configDir: '', cwd: '/project', agentSessionId: id, status: 'running', created: 1000 };
  const history = [{ id, title: 'Original title', cwd: '/project', modified: 2 }, { id: old, title: 'Older chat', cwd: '/other', modified: 500 }];
  const rows = mergeConversations(agent, [session], history, [{ ...history[0], title: 'Renamed chat' }]);
  assert.equal(rows.length, 2); assert.equal(rows[0].title, 'Renamed chat'); assert.equal(rows[0].session?.id, session.id);
  assert.equal(mergeConversations(agent, [{ ...session, configDir: '/different' }], [], []).length, 0);
  assert.equal(mergeConversations(agent, [session], [], [history[0]])[0].title, 'Original title');
  assert.equal(mergeConversations(agent, [session], [], [])[0].title, '新对话');
  assert.equal(mergeConversations(agent, [{ ...session, agentSessionId: undefined }], history, []).length, 3);
  assert.equal(mergeConversations(agent, [{ ...session, agentSessionId: undefined }], [], [])[0].title, '历史选择器');
  assert.equal(mergeConversations(agent, [], history, [])[0].history?.id, old);
  assert.equal(mergeConversations(agent, [session, { ...session, id: randomUUID(), status: 'exited', created: 5000 }], history, [])[0].session?.status, 'running');
});

test('initialization exports and source apply to launch, probe and history without consuming stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mam-init-'));
  const id = randomUUID();
  try {
    await mkdir(join(directory, 'projects', 'one'), { recursive: true });
    await writeFile(join(directory, 'projects', 'one', `${id}.jsonl`), JSON.stringify({ type: 'user', cwd: directory, message: { content: 'init history' } }) + '\n');
    await writeFile(join(directory, 'env.sh'), `export MAM_TEST_VALUE='space and quote'\nexport CLAUDE_CONFIG_DIR=${quote(directory)}\n`);
    const executable = join(directory, 'claude-test');
    await writeFile(executable, '#!/bin/bash\n[ "$MAM_TEST_VALUE" = "space and quote" ] || exit 9\nif [ "$1" = --help ]; then printf -- "--session-id --resume\\n"; else printf "%s" "$MAM_TEST_VALUE"; fi\n', { mode: 0o700 });
    const initialized = { ...agent, cwd: directory, executable, initScript: `source ${quote(join(directory, 'env.sh'))}\nprintf 'init output\\n'\ncat >/dev/null` };
    const execute = (command: string, input = '') => execFileSync('/bin/bash', ['-c', command], { input, encoding: 'utf8' });
    const adapter = new ClaudeAdapter(async (_agent, command, input) => execute(command, input));
    try {
      assert.match(execute((await adapter.prepareLaunch(initialized, directory, id)).command), /space and quote/);
      assert.equal((await adapter.probe(initialized)).ok, true);
      assert.equal((await adapter.history(initialized, 0, 30)).items[0].id, id);
      const explicit = new ClaudeAdapter(async (_agent, command, input) => execute(command, input));
      assert.equal((await explicit.history({ ...initialized, configDir: '/explicit' }, 0, 1).catch(() => ({ items: [] }))).items.length, 0);
      explicit.close();
      await assert.rejects(adapter.probe({ ...initialized, initScript: 'false\nexport MAM_TEST_VALUE=should-not-run' }));
      await assert.rejects(adapter.history({ ...initialized, initScript: 'source /does-not-exist' }, 0, 30));
      await assert.rejects(adapter.prepareLaunch({ ...initialized, initScript: 'false\nprintf should-not-run' }, directory, id).then(plan => execute(plan.command)));
      assert.throws(() => agentInput.parse({ name: 'Test', target: 'host', initScript: 'bad\u0000script' }));
    } finally { adapter.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('history adapter deduplicates shared remote environments and surfaces unsupported output', async () => {
  let calls = 0;
  const adapter = new ClaudeAdapter(async () => { calls++; return '__AGENT_HUB_JSON__' + JSON.stringify({ items: [], total: 0, warnings: [] }); });
  await Promise.all([adapter.history(agent, 0, 30), adapter.history({ ...agent, id: randomUUID() }, 0, 30)]);
  assert.equal(calls, 1);
  await adapter.history(agent, 0, 30, true); assert.equal(calls, 2);
  await adapter.history({ ...agent, initScript: 'export CLAUDE_CONFIG_DIR=~/other' }, 0, 30);
  assert.equal(calls, 3); adapter.close();
  const invalid = new ClaudeAdapter(async () => 'unexpected format');
  await assert.rejects(invalid.history(agent, 0, 30), /未返回有效数据/); invalid.close();
});
