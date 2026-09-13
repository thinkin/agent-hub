import { copyFile, chmod } from 'node:fs/promises';
await copyFile(new URL('../src/agents/history.py', import.meta.url), new URL('../dist/agents/history.py', import.meta.url));
await chmod(new URL('../dist/cli.js', import.meta.url), 0o755);
