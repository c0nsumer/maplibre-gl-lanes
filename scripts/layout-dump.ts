/**
 * The fidelity guard for performance work: every layout the plugin produces
 * for the fixtures at 17 zooms, full and culled to a phone view, with the
 * lane orders, baselines, draw order and mesh buffers, saved and compared
 * as text. Every number must match exactly: a change that moves a
 * coordinate by one ulp shows up and gets judged rather than hidden.
 *
 *   node scripts/run-ts.mjs scripts/layout-dump.ts save <dir>
 *   ... change the code ...
 *   node scripts/run-ts.mjs scripts/layout-dump.ts compare <dir>
 *
 * Further GeoJSON files can follow the directory; each is dumped under its
 * file name, with `--uniform a,b,c` applied to all of them. Run it from the
 * repo root: fixtures are read relative to the working directory. The dumps
 * are gzipped and take about 7 MB per fixture.
 */

import {readFileSync, writeFileSync, mkdirSync, existsSync} from 'node:fs';
import {basename} from 'node:path';
import {gzipSync, gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type SizesAtZoom} from '../src/core/layout';
import {tessellate} from '../src/render/tessellate';
import type {Bounds} from '../src/core/geometry';

const args = process.argv.slice(3);
const uniformAt = args.indexOf('--uniform');
const uniform = uniformAt >= 0 ? args.splice(uniformAt, 2)[1].split(',') : undefined;
const [mode, dir, ...extra] = args;
if ((mode !== 'save' && mode !== 'compare') || !dir) throw new Error('usage: save|compare <dir> [more.geojson ...] [--uniform a,b]');
mkdirSync(dir, {recursive: true});

const inputs: {name: string; file: string; opts: Record<string, unknown>}[] = [
    {name: 'ramba', file: 'test/fixtures/ramba.src.geojson', opts: {}},
    {name: 'mfo', file: 'test/fixtures/mfo.src.geojson', opts: {}},
    {name: 'example', file: 'test/fixtures/example.src.geojson', opts: {}},
    ...extra.map((file) => ({name: basename(file).replace(/\.(src\.)?geojson$/, ''), file, opts: {uniformProperties: uniform}})),
];
const styleAt: SizesAtZoom = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};
const zooms: number[] = [];
for (let z = 10; z <= 18; z += 0.5) zooms.push(z);

const sha = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const num = (x: number) => (Object.is(x, -0) ? '0' : String(x));
const poly = (p: ArrayLike<number>) => Array.from(p, num).join(',');

let failures = 0;
const report: string[] = [];
for (const inp of inputs) {
    const fc = JSON.parse(readFileSync(inp.file, 'utf8'));
    const t0 = performance.now();
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name', ...inp.opts});
    const tGraph = performance.now() - t0;
    const t1 = performance.now();
    const cost = orderLanes(g);
    const tOrder = performance.now() - t1;
    stabilizeLanes(g, {});
    const orders = g.edges.map((e) => `${e.id}:${e.order.join('|')}:${e.baseline === undefined ? 'undefined' : num(e.baseline)}`).join('\n');
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of g.nodes) { minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x); minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y); }
    const origin: [number, number] = [minX, minY];
    const sections: Record<string, string> = {orders: `cost ${cost}\n${orders}`};
    for (const z of zooms) {
        const scale = 512 * Math.pow(2, z);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w = 390 / scale, h = 844 / scale;
        const view: Bounds = {minX: cx - w, minY: cy - h, maxX: cx + w, maxY: cy + h};
        for (const [tag, opts] of [['full', {}], ['culled', {bounds: view}]] as const) {
            const L = layoutAtZoom(g, z, styleAt, opts);
            const lines = L.paths.map((p) => [p.route, p.kind, p.edge, p.node ?? '', p.between ? p.between.join('/') : '', p.travel, num(p.startDistance),
                JSON.stringify(p.look), poly(p.coords), poly(p.anchors)].join('\t'));
            lines.push('drawOrder ' + L.drawOrder.join('|'), 'merged ' + L.mergedEdges.join('|'),
                `stats ${L.stats.edges} ${L.stats.edgesBuilt} ${L.stats.edgesMerged} ${L.stats.nodes} ${L.stats.vertices}`);
            const m = tessellate(L.paths, {scale: L.scale, origin, unitsPerMercator: 8192 * Math.pow(2, 14), drawOrder: L.drawOrder});
            lines.push('mesh ' + sha(Buffer.from(m.vertices.buffer, m.vertices.byteOffset, m.vertices.byteLength).toString('hex'))
                + ' ' + sha(Buffer.from(m.colors.buffer, m.colors.byteOffset, m.colors.byteLength).toString('hex'))
                + ' ' + sha(Buffer.from(m.indices.buffer, m.indices.byteOffset, m.indices.byteLength).toString('hex')) + ` ${m.vertexCount}`);
            sections[`${tag}-z${z}`] = lines.join('\n');
        }
    }
    const file = `${dir}/${inp.name}.json.gz`;
    if (mode === 'save') {
        writeFileSync(file, gzipSync(JSON.stringify(sections)));
        report.push(`${inp.name}: saved ${Object.keys(sections).length} sections (graph ${tGraph.toFixed(0)} ms, order ${tOrder.toFixed(0)} ms, cost ${cost})`);
    } else {
        if (!existsSync(file)) throw new Error(`no baseline for ${inp.name}`);
        const base = JSON.parse(gunzipSync(readFileSync(file)).toString()) as Record<string, string>;
        const bad: string[] = [];
        for (const k of Object.keys(base)) {
            if (base[k] !== sections[k]) {
                bad.push(k);
                const a = base[k].split('\n'), b = (sections[k] ?? '').split('\n');
                let i = 0;
                while (i < a.length && i < b.length && a[i] === b[i]) i++;
                if (bad.length <= 3) report.push(`  ${inp.name} ${k}: first difference at line ${i}\n    was: ${a[i]?.slice(0, 200)}\n    now: ${b[i]?.slice(0, 200)}`);
            }
        }
        failures += bad.length;
        report.push(`${inp.name}: ${bad.length ? 'DIFFERS in ' + bad.length + ' sections: ' + bad.slice(0, 8).join(', ') : 'identical'} (graph ${tGraph.toFixed(0)} ms, order ${tOrder.toFixed(0)} ms, cost ${cost})`);
    }
}
console.log(report.join('\n'));
if (failures) process.exit(1);
