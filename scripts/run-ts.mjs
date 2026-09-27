// Run one TypeScript file under Node by bundling it with esbuild first: the
// repo has no TypeScript loader, and the benchmarks need the source modules,
// not the built library.
//
//   node scripts/run-ts.mjs scripts/bench-rebuild.ts [args...]
//
// Arguments after the entry point reach the script as process.argv.slice(3).
import {build} from 'esbuild';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

const entry = process.argv[2];
if (!entry) {
    console.error('usage: node scripts/run-ts.mjs <entry.ts> [args...]');
    process.exit(1);
}
const out = await build({
    entryPoints: [entry],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: 'inline',
    write: false,
});
const dir = mkdtempSync(join(tmpdir(), 'lanes-run-'));
// Each run leaves about half a megabyte, which adds up on a RAM-disk /tmp.
process.on('exit', () => rmSync(dir, {recursive: true, force: true}));
const file = join(dir, 'bundle.mjs');
writeFileSync(file, out.outputFiles[0].text);
await import(pathToFileURL(file).href);
