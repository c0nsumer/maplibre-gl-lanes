import {defineConfig, type Plugin} from 'vite';
import {mkdirSync, writeFileSync, createReadStream, existsSync, readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Dev only: the page's `snap()` POSTs a canvas PNG to /__shot?name=..., saved
 * to $SHOT_DIR (default ./shots), to review renders from remote browsers.
 */
function shotSink(): Plugin {
    return {
        name: 'shot-sink',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                if (!req.url?.startsWith('/__shot') || req.method !== 'POST') return next();
                const name = (new URL(req.url, 'http://x').searchParams.get('name') ?? 'shot').replace(/[^\w.-]/g, '_');
                const dir = process.env.SHOT_DIR ?? join(process.cwd(), 'shots');
                mkdirSync(dir, {recursive: true});
                const chunks: Buffer[] = [];
                req.on('data', (c) => chunks.push(c));
                req.on('end', () => {
                    writeFileSync(join(dir, `${name}.png`), Buffer.concat(chunks));
                    res.statusCode = 204;
                    res.end();
                });
            });
        },
    };
}

/**
 * Serves /<name>.geojson from test/fixtures/<name>.src.geojson, so the demo
 * and the tests share files with no copy step. A build emits them as assets,
 * since the middleware exists only in the dev server.
 */
function fixtures(): Plugin {
    const dir = new URL('../test/fixtures/', import.meta.url).pathname;
    return {
        name: 'fixtures',
        configureServer(server) {
            server.middlewares.use((req, res, next) => {
                const m = /^\/(\w+)\.geojson(\?|$)/.exec(req.url ?? '');
                const file = m && join(dir, `${m[1]}.src.geojson`);
                if (!file || !existsSync(file)) return next();
                res.setHeader('Content-Type', 'application/geo+json');
                createReadStream(file).pipe(res);
            });
        },
        generateBundle() {
            for (const f of readdirSync(dir)) {
                const m = /^(\w+)\.src\.geojson$/.exec(f);
                if (m) this.emitFile({type: 'asset', fileName: `${m[1]}.geojson`, source: readFileSync(join(dir, f))});
            }
        },
    };
}

/**
 * MapLibre 6 loads maplibre-gl-worker.mjs, which imports
 * maplibre-gl-shared.mjs, from beside its own module: the assets directory
 * once bundled. The build does not emit them, so without this the built
 * demo has no basemap.
 */
function maplibreWorker(): Plugin {
    const dir = new URL('../node_modules/maplibre-gl/dist/', import.meta.url).pathname;
    return {
        name: 'maplibre-worker',
        apply: 'build',
        generateBundle() {
            for (const f of ['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']) {
                this.emitFile({type: 'asset', fileName: `assets/${f}`, source: readFileSync(join(dir, f))});
            }
        },
    };
}

export default defineConfig({
    root: new URL('.', import.meta.url).pathname,
    publicDir: 'public',
    plugins: [shotSink(), fixtures(), maplibreWorker()],
    worker: {format: 'es'},
    optimizeDeps: {exclude: ['maplibre-gl']},
    server: {port: 5177, strictPort: true, host: true, fs: {allow: ['..']}},
    resolve: {alias: {'maplibre-gl-lanes': new URL('../src/index.ts', import.meta.url).pathname}},
});
