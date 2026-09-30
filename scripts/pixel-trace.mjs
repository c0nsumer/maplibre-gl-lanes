// Record a Chrome performance trace of a tethered Android phone while a
// probe drives the page, and save it where a DevTools "Save profile" would
// have, which DevTools attached through chrome://inspect does not always do.
//
// Once, on the machine the phone is tethered to (adb from Android's
// platform-tools; USB debugging is already on if chrome://inspect sees the
// phone):
//
//     adb forward tcp:9222 localabstract:chrome_devtools_remote
//
// Then, with the page open and visible on the phone and no DevTools window
// attached to it:
//
//     node scripts/pixel-trace.mjs ramba scripts/device-probe.js out/pixel
//
// The first argument picks the tab by a substring of its URL. The probe is
// pasted into the page as the console would paste it, and the recording
// stops when the probe prints its JSON. Two files come out: out/pixel.trace.json
// for scripts/profile-trace.py or the Performance panel's "Load profile",
// and out/pixel.probe.json with what the probe printed. Node 18 or later;
// nothing to install. `--port` picks another forwarded port.

import {readFileSync, writeFileSync, mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {connect} from 'node:net';
import {createHash, randomBytes} from 'node:crypto';

// A WebSocket client of its own, so the script runs on the Node a machine
// happens to have: the built-in one arrived in Node 22. Text frames only,
// which is all the protocol uses; a trace chunk arrives fragmented, so
// continuation frames are joined.
function openSocket(url) {
    const {hostname, port, pathname, search} = new URL(url);
    return new Promise((resolve, reject) => {
        const sock = connect({host: hostname, port: Number(port) || 80});
        const key = randomBytes(16).toString('base64');
        const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        const ws = {onmessage: null, close: () => sock.end()};
        ws.send = (text) => {
            const payload = Buffer.from(text), mask = randomBytes(4), n = payload.length;
            const head = n < 126 ? Buffer.from([0x81, 0x80 | n])
                : n < 65536 ? Buffer.from([0x81, 0xfe, n >> 8, n & 255])
                : Buffer.concat([Buffer.from([0x81, 0xff]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
            for (let i = 0; i < n; i++) payload[i] ^= mask[i & 3];
            sock.write(Buffer.concat([head, mask, payload]));
        };
        let buf = Buffer.alloc(0), upgraded = false, parts = [];
        sock.on('error', reject);
        sock.on('data', (chunk) => {
            buf = Buffer.concat([buf, chunk]);
            if (!upgraded) {
                const end = buf.indexOf('\r\n\r\n');
                if (end < 0) return;
                const head = buf.subarray(0, end).toString();
                if (!head.startsWith('HTTP/1.1 101') || !head.includes(accept)) return reject(new Error('WebSocket upgrade refused: ' + head.split('\r\n')[0]));
                upgraded = true;
                buf = buf.subarray(end + 4);
                resolve(ws);
            }
            for (;;) {
                if (buf.length < 2) return;
                const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
                let len = buf[1] & 0x7f, at = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
                if (masked) at += 4;
                if (buf.length < at + len) return;
                const payload = buf.subarray(at, at + len);
                buf = buf.subarray(at + len);
                if (op === 8) { sock.end(); return; }
                if (op === 9) { sock.write(Buffer.concat([Buffer.from([0x8a, 0x80]), randomBytes(4)])); continue; }
                if (op === 1 || op === 0) {
                    parts.push(payload);
                    if (fin) { const data = Buffer.concat(parts).toString(); parts = []; ws.onmessage?.({data}); }
                }
            }
        });
        sock.on('connect', () => sock.write(`GET ${pathname}${search} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    });
}

const args = process.argv.slice(2);
const portAt = args.indexOf('--port');
const port = portAt >= 0 ? Number(args.splice(portAt, 2)[1]) : 9222;
const [match, probePath, outBase] = args;
if (!match || !probePath || !outBase) {
    console.error('usage: node scripts/pixel-trace.mjs <url substring> <probe.js> <output base> [--port 9222]');
    process.exit(2);
}

// The Performance panel's own categories, without screenshots: they cost
// frames on a phone, which is what the trace is meant to measure.
const CATEGORIES = [
    '-*', 'devtools.timeline', 'disabled-by-default-devtools.timeline',
    'disabled-by-default-devtools.timeline.frame', 'disabled-by-default-devtools.timeline.stack',
    'disabled-by-default-v8.cpu_profiler', 'disabled-by-default-v8.cpu_profiler.hires',
    'v8.execute', 'v8', 'blink.console', 'blink.user_timing', 'latencyInfo', 'toplevel', 'loading',
].join(',');

// The browser endpoint rather than /json: Chrome for Android leaves the
// page that is in front out of that list at times, while its workers stay in.
const {webSocketDebuggerUrl} = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
const ws = await openSocket(webSocketDebuggerUrl);
let nextId = 0;
const replies = new Map(), listeners = [];
ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && replies.has(d.id)) { replies.get(d.id)(d); replies.delete(d.id); }
    else if (d.method) for (const l of listeners) l(d);
};
const raw = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    replies.set(id, (d) => (d.error ? reject(new Error(`${method}: ${d.error.message}`)) : resolve(d.result)));
    ws.send(JSON.stringify({id, method, params, sessionId}));
});
const once = (method) => new Promise((resolve) => listeners.push((d) => d.method === method && resolve(d.params)));

const {targetInfos} = await raw('Target.getTargets');
const pages = targetInfos.filter((t) => t.type === 'page');
const page = pages.find((t) => t.url.includes(match) || (t.title || '').includes(match));
if (!page) {
    console.error(`no open page matches "${match}"; pages:`, pages.map((t) => `${t.url} (${t.title})`));
    process.exit(1);
}
console.error('page:', page.url);
const {sessionId} = await raw('Target.attachToTarget', {targetId: page.targetId, flatten: true});
const call = (method, params) => raw(method, params, sessionId);

await call('Runtime.enable');
const logs = [];
listeners.push((d) => {
    if (d.method === 'Runtime.consoleAPICalled') logs.push(d.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
});

await call('Tracing.start', {categories: CATEGORIES, options: 'sampling-frequency=10000', transferMode: 'ReturnAsStream', streamFormat: 'json'});
console.error('recording; pasting the probe');
const started = Date.now();
await call('Runtime.evaluate', {expression: readFileSync(probePath, 'utf8')});

let printed = null;
while (!printed && Date.now() - started < 120000) {
    await new Promise((r) => setTimeout(r, 250));
    printed = logs.find((l) => l.startsWith('{') || l.startsWith('FAIL'));
}
if (!printed) console.error('the probe printed nothing in two minutes; saving the trace anyway');
else console.error(`probe finished after ${((Date.now() - started) / 1000).toFixed(1)} s`);

const complete = once('Tracing.tracingComplete');
await call('Tracing.end');
const {stream} = await complete;
let trace = '';
for (;;) {
    const chunk = await call('IO.read', {handle: stream, size: 1 << 20});
    trace += chunk.base64Encoded ? Buffer.from(chunk.data, 'base64').toString('utf8') : chunk.data;
    if (chunk.eof) break;
}
await call('IO.close', {handle: stream});
ws.close();

mkdirSync(dirname(outBase), {recursive: true});
writeFileSync(`${outBase}.trace.json`, trace);
if (printed) writeFileSync(`${outBase}.probe.json`, printed);
console.error(`wrote ${outBase}.trace.json (${(trace.length / 1048576).toFixed(1)} MB)${printed ? ` and ${outBase}.probe.json` : ''}`);
if (printed && printed.startsWith('FAIL')) console.error(printed);
