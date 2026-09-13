import { chmod, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
if (process.platform !== 'win32') {
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve('node-pty/package.json'));
  for (const directory of [`prebuilds/${process.platform}-${process.arch}`, 'build/Release']) {
    const helper = join(root, directory, 'spawn-helper');
    try { await access(helper); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    // node-pty 1.1.0 ships its Unix spawn helper without executable permissions.
    await chmod(helper, 0o755);
  }
}
