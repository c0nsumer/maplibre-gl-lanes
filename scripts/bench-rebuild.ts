/**
 * Rebuild benchmark: what a pan costs the render thread.
 *
 * `LaneLayer` rebuilds when the viewport leaves the built area (the
 * viewport plus `cullMargin` on each side). This walks a phone-sized
 * viewport across a fixture on a lawnmower path, rebuilds on the same rule,
 * and reports each rebuild's cost. The pinch pass moves the zoom too, which
 * resets the cache every step: the worst case for caching.
 *
 *   node scripts/run-ts.mjs scripts/bench-rebuild.ts [fixture] [--no-cache] [--worker]
 *
 * `--worker` goes through the worker's message handler, adding the path
 * packing and mesh copy for transfer: the worker's cost per rebuild.
 *
 * Run it from the repo root: fixtures are read relative to the working
 * directory.
 */

import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, LayoutCache, type SizesAtZoom} from '../src/core/layout';
import {tessellate, TessellateCache} from '../src/render/tessellate';
import {toTransfer} from '../src/core/serialize';
import {handleLayoutRequest} from '../src/worker/lanes.worker';
import type {Bounds} from '../src/core/geometry';

const args = process.argv.slice(3);
const fixture = args.find((a) => !a.startsWith('--')) ?? 'ramba.src.geojson';
const useCache = !args.includes('--no-cache');
const asWorker = args.includes('--worker');

// The demo's style: spacing one pixel wider than the fill.
const styleAt: SizesAtZoom = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

const VIEW_W = 390;
const VIEW_H = 844;
const CULL_MARGIN = 0.5;
/** Pan step, px. Small enough that the rebuild rule, not the step, decides. */
const STEP_PX = 50;

const fc = JSON.parse(readFileSync(`test/fixtures/${fixture}`, 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
orderLanes(graph);
stabilizeLanes(graph, {});

// Mercator bounding box of the network, for the pan path.
let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of graph.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
}

const origin: [number, number] = [minX, minY];
const unitsPerMercator = 8192 * Math.pow(2, 14);

interface Rebuild {
    layoutMs: number;
    meshMs: number;
    edgesBuilt: number;
    vertices: number;
}

/** Viewport centers along a lawnmower path over the network, in Mercator. */
function panPath(zoom: number): [number, number][] {
    const scale = 512 * Math.pow(2, zoom);
    const step = STEP_PX / scale;
    const rowStep = (VIEW_H * 0.8) / scale;
    const out: [number, number][] = [];
    let row = 0;
    for (let y = minY; y <= maxY; y += rowStep, row++) {
        const leftToRight = row % 2 === 0;
        for (let x = minX; x <= maxX; x += step) {
            out.push([leftToRight ? x : minX + maxX - x, y]);
        }
    }
    return out;
}

function viewOf(center: [number, number], zoom: number): Bounds {
    const scale = 512 * Math.pow(2, zoom);
    const w = VIEW_W / scale / 2;
    const h = VIEW_H / scale / 2;
    return {minX: center[0] - w, minY: center[1] - h, maxX: center[0] + w, maxY: center[1] + h};
}

function grown(b: Bounds): Bounds {
    const mx = (b.maxX - b.minX) * CULL_MARGIN;
    const my = (b.maxY - b.minY) * CULL_MARGIN;
    return {minX: b.minX - mx, minY: b.minY - my, maxX: b.maxX + mx, maxY: b.maxY + my};
}

function inside(view: Bounds, built: Bounds): boolean {
    return view.minX >= built.minX && view.maxX <= built.maxX && view.minY >= built.minY && view.maxY <= built.maxY;
}

let nextSession = 1;

/** One pass of the pan path at `zooms[i]` per step, rebuilding on the layer's rule. */
function pan(zooms: (step: number) => number, centers: [number, number][]): Rebuild[] {
    const layoutCache = useCache ? new LayoutCache() : undefined;
    const meshCache = useCache ? new TessellateCache() : undefined;
    const session = nextSession++;
    let sentGraph = false;
    const out: Rebuild[] = [];
    let built: Bounds | null = null;
    let builtZoom = NaN;
    for (let i = 0; i < centers.length; i++) {
        const zoom = zooms(i);
        const view = viewOf(centers[i], zoom);
        const dz = zoom - builtZoom;
        if (built && inside(view, built) && dz >= -0.25 && dz <= 0.5) continue;
        const bounds = grown(view);
        if (asWorker) {
            const t0 = performance.now();
            const res = handleLayoutRequest({
                kind: 'layout', id: i, session, zoom, style: styleAt(zoom), smooth: true, openFolds: true, bounds,
                graph: sentGraph ? undefined : toTransfer(graph), origin, unitsPerMercator,
            });
            const total = performance.now() - t0;
            sentGraph = true;
            // Mesh build, path packing and buffer copies.
            out.push({layoutMs: res.layoutMs, meshMs: total - res.layoutMs, edgesBuilt: res.stats.edgesBuilt, vertices: res.vertexCount});
            built = bounds;
            builtZoom = zoom;
            continue;
        }
        const t0 = performance.now();
        const layout = layoutAtZoom(graph, zoom, styleAt, {bounds, cache: layoutCache});
        const t1 = performance.now();
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin, unitsPerMercator, drawOrder: layout.drawOrder, cache: meshCache});
        const t2 = performance.now();
        out.push({layoutMs: t1 - t0, meshMs: t2 - t1, edgesBuilt: layout.stats.edgesBuilt, vertices: mesh.vertexCount});
        built = bounds;
        builtZoom = zoom;
    }
    return out;
}

function quantile(xs: number[], q: number): number {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}

function report(label: string, rs: Rebuild[]): void {
    const total = rs.map((r) => r.layoutMs + r.meshMs);
    const sum = total.reduce((a, b) => a + b, 0);
    console.log(
        `${label.padEnd(22)} ${String(rs.length).padStart(3)} rebuilds  ` +
        `total ${sum.toFixed(0).padStart(5)} ms  ` +
        `median ${quantile(total, 0.5).toFixed(1).padStart(5)}  ` +
        `p90 ${quantile(total, 0.9).toFixed(1).padStart(5)}  ` +
        `max ${Math.max(...total).toFixed(1).padStart(5)}  ` +
        `(layout ${quantile(rs.map((r) => r.layoutMs), 0.5).toFixed(1)} / mesh ${quantile(rs.map((r) => r.meshMs), 0.5).toFixed(1)} median)`,
    );
}

console.log(`${fixture}: ${graph.nodes.length} nodes, ${graph.edges.length} edges, ${graph.routes.size} routes; ` +
    `${VIEW_W}x${VIEW_H} viewport, cache ${useCache ? 'on' : 'off'}${asWorker ? ', through the worker handler' : ''}`);

for (const zoom of [15, 16]) {
    const centers = panPath(zoom);
    pan(() => zoom, centers.slice(0, 8)); // warm the JIT, then measure with a fresh cache
    report(`pan z${zoom}`, pan(() => zoom, centers));
}

// Pinch: zoom steps of 0.1 around z15.5 rebuild the zoom state every time.
{
    const centers = panPath(15.5);
    const zooms = (i: number) => 15.5 + 0.1 * (i % 11) - 0.5;
    // Whole passes, so both modes reach the measured pass equally warm: an uncached run
    // has already laid out hundreds of pans by now, a cached one mostly reused them.
    pan(zooms, centers);
    pan(zooms, centers);
    report('pinch z15..16', pan(zooms, centers));
}
