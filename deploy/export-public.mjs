import { copyFile, lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLIC_FILES } from '../server.mjs';

// Export only deployable browser assets. The destination must be empty so stale
// private files cannot accidentally be uploaded along with a newer release.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw new Error('Usage: node deploy/export-public.mjs <empty-output-directory>');
const output = path.resolve(process.argv[2]);
await mkdir(output, { recursive: true });
if ((await readdir(output)).length) throw new Error('The output directory must be empty');
const resolvedRoot = await realpath(root);
for (const name of PUBLIC_FILES) {
  const source = path.join(root, name);
  const relative = path.relative(resolvedRoot, await realpath(source));
  if (!(await lstat(source)).isFile() || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Refusing a public asset outside the release directory: ${name}`);
  }
  const target = path.join(output, name);
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
}
console.log(`Exported ${PUBLIC_FILES.size} public files to ${output}`);
