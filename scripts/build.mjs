// Library build: ESM + IIFE bundles with the ordering worker inlined.
import {build} from 'esbuild';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';

// Clean first: tsc does not remove declarations for source files that are
// gone, so a stale .d.ts would otherwise be published forever.
rmSync('dist', {recursive: true, force: true});
mkdirSync('dist', {recursive: true});

// The worker as a classic script (IIFE), so it can run from a Blob URL.
const worker = await build({
    entryPoints: ['src/worker/lanes.worker.ts'],
    bundle: true,
    format: 'iife',
    target: 'es2020',
    minify: true,
    write: false,
});
const workerSource = worker.outputFiles[0].text;

/**
 * Stub out the development worker spawn: the published bundle spawns from
 * the inlined Blob. A consumer's bundler resolves `new Worker(new URL(...))`
 * at build time even in a dead branch, and the source it names is not
 * shipped, so leaving it in fails every such build.
 */
const stubDevWorker = {
    name: 'stub-dev-worker',
    setup(b) {
        b.onLoad({filter: /[/\\]core[/\\]worker-dev\.ts$/}, () => ({
            contents: 'export function spawnDevWorker() { return null; }',
            loader: 'ts',
        }));
    },
};

const common = {
    entryPoints: ['src/index.ts'],
    bundle: true,
    target: 'es2020',
    sourcemap: true,
    external: ['maplibre-gl'],
    plugins: [stubDevWorker],
    define: {__LANES_WORKER_SOURCE__: JSON.stringify(workerSource)},
};

// `minifySyntax` folds the `typeof __LANES_WORKER_SOURCE__` test and drops
// the dead branch. Without it esbuild keeps the branch but tree-shakes the
// function it calls, leaving a call to an undefined identifier. Names and
// line structure survive.
await build({...common, format: 'esm', minifySyntax: true, outfile: 'dist/maplibre-gl-lanes.mjs'});
await build({...common, format: 'iife', globalName: 'maplibreLanes', minify: true, outfile: 'dist/maplibre-gl-lanes.js'});

/**
 * Check the output rather than trust the steps above: any of these means
 * the development spawn, or a dangling call to it, reached the bundle.
 */
const forbidden = ['lanes.worker.ts', 'new Worker(new URL', 'spawnDevWorker'];
for (const f of ['dist/maplibre-gl-lanes.mjs', 'dist/maplibre-gl-lanes.js']) {
    const text = readFileSync(f, 'utf8');
    for (const bad of forbidden) {
        if (text.includes(bad)) throw new Error(`${f} contains ${JSON.stringify(bad)}; the development worker spawn reached the published bundle`);
    }
}

writeFileSync('dist/README.txt', 'maplibre-gl-lanes.js: browser script (global maplibreLanes). maplibre-gl-lanes.mjs: ES module. Types in dist/types/.\n');
console.log(`built dist/ (worker ${(workerSource.length / 1024).toFixed(0)} kB inlined)`);
