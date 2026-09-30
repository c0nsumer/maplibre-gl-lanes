// Open every example page and the built demo in headless Chromium and report
// what a reviewer would check by hand: page errors, console errors, whether
// the plugin and the data loaded, and whether the map drew anything.
//
//   corepack pnpm build
//   node scripts/smoke-pages.mjs [path/to/chrome]
//
// It starts the examples server on port 5178, serves the built demo from
// demo/dist on 5179 and the bundler example's own build on 5180, all on
// 127.0.0.1, and stops them when done. The browser
// defaults to Playwright's Chromium under ~/.cache/ms-playwright; pass another
// path as the argument. Nothing to install: Node 22 speaks WebSocket itself.
// Exit status is 1 when any page fails a check.

import {spawn} from 'node:child_process';
import {existsSync, readdirSync} from 'node:fs';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, resolve} from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const chrome = process.argv[2] ?? findChrome();
if (!chrome || !existsSync(chrome)) {
    console.error('no Chromium found; pass its path as the argument');
    process.exit(2);
}

function findChrome() {
    const cache = join(process.env.HOME ?? '', '.cache', 'ms-playwright');
    if (!existsSync(cache)) return null;
    const dirs = readdirSync(cache).filter((d) => d.startsWith('chromium-')).sort();
    for (const d of dirs.reverse()) {
        const p = join(cache, d, 'chrome-linux64', 'chrome');
        if (existsSync(p)) return p;
    }
    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The demo's built files, as Pages would serve them, with the base path the
// build was made for. A missing demo/dist skips the demo rather than failing.
const demoDist = join(root, 'demo', 'dist');
const TYPES = {'.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.geojson': 'application/geo+json', '.pmtiles': 'application/octet-stream', '.png': 'image/png', '.webp': 'image/webp', '.map': 'application/json'};
function serveStatic(dir, base = '') {
    return createServer(async (req, res) => {
        let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
        if (base && p.startsWith(base + '/')) p = p.slice(base.length);
        if (p.endsWith('/')) p += 'index.html';
        const file = join(dir, p);
        try {
            const data = await readFile(file);
            const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
            if (range) {
                const a = Number(range[1]), b = range[2] ? Number(range[2]) : data.length - 1;
                res.writeHead(206, {'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes'});
                res.end(data.subarray(a, b + 1));
                return;
            }
            res.writeHead(200, {'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes'});
            res.end(data);
        } catch {
            res.writeHead(404);
            res.end();
        }
    });
}

const examples = spawn(process.execPath, [join(root, 'scripts', 'serve-examples.mjs')], {stdio: 'ignore', env: {...process.env, PORT: '5178'}});
const demoServer = existsSync(demoDist) ? serveStatic(demoDist, '/maplibre-gl-lanes').listen(5179, '127.0.0.1') : null;
// The bundler example is a Vite project; its own build is what a visitor gets.
const bundlerDist = join(root, 'examples', 'bundler', 'dist');
const bundlerServer = existsSync(bundlerDist) ? serveStatic(bundlerDist).listen(5180, '127.0.0.1') : null;
const browser = spawn(chrome, ['--headless=new', '--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
    '--disable-dev-shm-usage', '--remote-debugging-port=9337', '--window-size=900,700', 'about:blank'], {stdio: 'ignore'});

let version = null;
for (let i = 0; i < 50 && !version; i++) {
    await sleep(200);
    try { version = await (await fetch('http://127.0.0.1:9337/json/version')).json(); } catch {}
}
const ws = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let nextId = 0;
const replies = new Map();
const listeners = [];
ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && replies.has(d.id)) { replies.get(d.id)(d); replies.delete(d.id); }
    else if (d.method) for (const l of listeners) l(d);
};
const call = (method, params = {}, sessionId) => new Promise((resolve) => {
    const id = ++nextId;
    replies.set(id, resolve);
    ws.send(JSON.stringify({id, method, params, sessionId}));
});

const pages = readdirSync(join(root, 'examples'), {withFileTypes: true})
    .filter((d) => d.isDirectory() && d.name !== 'bundler' && existsSync(join(root, 'examples', d.name, 'index.html')))
    .map((d) => ({name: `examples/${d.name}`, url: `http://127.0.0.1:5178/examples/${d.name}/`}));
if (bundlerServer) pages.push({name: 'examples/bundler (its build)', url: 'http://127.0.0.1:5180/'});
else console.log('skip examples/bundler: no dist; run pnpm build in examples/bundler first');
if (demoServer) {
    pages.push({name: 'demo', url: 'http://127.0.0.1:5179/maplibre-gl-lanes/'});
    pages.push({name: 'demo/plain.html', url: 'http://127.0.0.1:5179/maplibre-gl-lanes/plain.html'});
}

let failed = 0;
for (const page of pages) {
    const {result: {targetId}} = await call('Target.createTarget', {url: 'about:blank'});
    const {result: {sessionId}} = await call('Target.attachToTarget', {targetId, flatten: true});
    const ev = (m, p) => call(m, p, sessionId);
    const errors = [];
    const onEvent = (d) => {
        if (d.sessionId !== sessionId) return;
        if (d.method === 'Runtime.exceptionThrown') errors.push('exception: ' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text).split('\n')[0]);
        if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error: ' + d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 160));
        // No page here has a favicon; the browser's request for one is not a page error.
        if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error' && !/favicon\.ico/.test(d.params.entry.url ?? '')) {
            errors.push('log: ' + d.params.entry.text.slice(0, 160) + (d.params.entry.url ? ' ' + d.params.entry.url : ''));
        }
    };
    listeners.push(onEvent);
    await ev('Runtime.enable');
    await ev('Log.enable');
    await ev('Page.enable');
    await ev('Page.navigate', {url: page.url});
    // Long enough for the ordering worker and the first build; the check below waits for a draw.
    let drew = false, loaded = null;
    for (let i = 0; i < 40 && !drew; i++) {
        await sleep(500);
        const r = await ev('Runtime.evaluate', {returnByValue: true, expression: `(() => {
            const res = performance.getEntriesByType('resource').map((e) => e.name);
            const plugin = res.some((n) => /maplibre-gl-lanes\\.(m?js)(\\?|$)/.test(n) || /\\/assets\\/.*\\.js/.test(n));
            const data = res.some((n) => /\\.geojson(\\?|$)/.test(n));
            const canvas = document.querySelector('canvas.maplibregl-canvas');
            if (!canvas) return {plugin, data, canvas: false};
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return {plugin, data, canvas: true, gl: false};
            const px = new Uint8Array(4 * 64 * 64);
            gl.readPixels(Math.floor(canvas.width / 2) - 32, Math.floor(canvas.height / 2) - 32, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
            const seen = new Set();
            for (let k = 0; k < px.length; k += 4) seen.add((px[k] << 16) | (px[k + 1] << 8) | px[k + 2]);
            return {plugin, data, canvas: true, gl: true, colors: seen.size};
        })()`});
        loaded = r.result?.result?.value ?? null;
        // A drawn map has many colors in its middle; a blank or single-color canvas has one or two.
        drew = !!loaded && loaded.colors > 8;
    }
    // The canvas is read after the frame, so preserveDrawingBuffer matters; MapLibre sets it off,
    // and a read then can be black. Fall back to a screenshot's variety when that happens.
    if (!drew && loaded?.canvas) {
        const shot = await ev('Page.captureScreenshot', {format: 'png'});
        const bytes = Buffer.from(shot.result.data, 'base64');
        // A PNG of a blank page compresses to almost nothing; a drawn map does not.
        drew = bytes.length > 20000;
        loaded.screenshotBytes = bytes.length;
    }
    listeners.splice(listeners.indexOf(onEvent), 1);
    await call('Target.closeTarget', {targetId});
    const ok = errors.length === 0 && loaded?.plugin && loaded?.data && drew;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${page.name}: plugin ${loaded?.plugin ? 'loaded' : 'MISSING'}, data ${loaded?.data ? 'loaded' : 'MISSING'}, ${drew ? 'drew' : 'DREW NOTHING'}${loaded?.screenshotBytes ? ` (screenshot ${loaded.screenshotBytes} bytes)` : ''}${errors.length ? `\n      ${errors.join('\n      ')}` : ''}`);
}

ws.close();
browser.kill();
examples.kill();
demoServer?.close();
bundlerServer?.close();
process.exit(failed ? 1 : 0);
