/**
 * The layout and mesh table in `docs/performance.md`: one zoom's cost over
 * a whole fixture, and culled to a phone viewport. Medians of five runs
 * with no cache, so the figures are a first build's.
 *
 *   node scripts/run-ts.mjs scripts/bench-layout.ts [fixture ...]
 *
 * Run it from the repo root: fixtures are read relative to the working
 * directory.
 */

import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type SizesAtZoom} from '../src/core/layout';
import {tessellate} from '../src/render/tessellate';
import type {Bounds} from '../src/core/geometry';

const fixtures = process.argv.slice(3);
if (!fixtures.length) fixtures.push('ramba.src.geojson', 'mfo.src.geojson', 'example.src.geojson');

// The demo's style: spacing one pixel wider than the fill.
const styleAt: SizesAtZoom = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

const VIEW_W = 390;
const VIEW_H = 844;
const CULL_MARGIN = 0.5;
const RUNS = 5;

function median(xs: number[]): number {
    const s = [...xs].sort((a, b) => a - b);
    return s[s.length >> 1];
}

for (const fixture of fixtures) {
    const fc = JSON.parse(readFileSync(`test/fixtures/${fixture}`, 'utf8'));
    const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
    orderLanes(graph);
    stabilizeLanes(graph, {});
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of graph.nodes) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
    }
    const origin: [number, number] = [minX, minY];
    console.log(`\n${fixture}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.routes.size} routes`);
    console.log('| Zoom | Full layout | Path vertices | Merged edges | Mesh build | Mesh vertices | Mesh size | Culled layout, phone view |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const zoom of [12, 14, 16, 18]) {
        const scale = 512 * Math.pow(2, zoom);
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
        const w = VIEW_W / scale / 2 * (1 + 2 * CULL_MARGIN);
        const h = VIEW_H / scale / 2 * (1 + 2 * CULL_MARGIN);
        const view: Bounds = {minX: cx - w, minY: cy - h, maxX: cx + w, maxY: cy + h};
        const full: number[] = [];
        const mesh: number[] = [];
        const culled: number[] = [];
        let vertices = 0, merged = 0, meshVertices = 0, bytes = 0, edgesBuilt = 0;
        for (let i = 0; i < RUNS; i++) {
            let t = performance.now();
            const layout = layoutAtZoom(graph, zoom, styleAt);
            full.push(performance.now() - t);
            t = performance.now();
            const m = tessellate(layout.paths, {scale: layout.scale, origin, unitsPerMercator: 8192 * Math.pow(2, 14), drawOrder: layout.drawOrder});
            mesh.push(performance.now() - t);
            t = performance.now();
            const c = layoutAtZoom(graph, zoom, styleAt, {bounds: view});
            culled.push(performance.now() - t);
            vertices = layout.stats.vertices;
            merged = layout.stats.edgesMerged;
            edgesBuilt = c.stats.edgesBuilt;
            meshVertices = m.vertexCount;
            bytes = m.vertices.byteLength + m.colors.byteLength + m.indices.byteLength;
        }
        console.log(`| ${zoom} | ${median(full).toFixed(0)} ms | ${vertices} | ${merged} | ${median(mesh).toFixed(0)} ms | ${meshVertices} | ` +
            `${(bytes / 1048576).toFixed(1)} MB | ${median(culled).toFixed(0)} ms, ${edgesBuilt} of ${graph.edges.length} edges |`);
    }
}
