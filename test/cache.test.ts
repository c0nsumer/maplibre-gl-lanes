import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom, LayoutCache, type LanePath, type Layout} from '../src/core/layout';
import {stabilizeLanes} from '../src/core/baselines';
import {tessellate, TessellateCache} from '../src/render/tessellate';
import type {Bounds} from '../src/core/geometry';

const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
orderLanes(graph);
stabilizeLanes(graph, {});
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
for (const n of graph.nodes) {
    minX = Math.min(minX, n.x);
    maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y);
    maxY = Math.max(maxY, n.y);
}
const w = maxX - minX, h = maxY - minY;
/** Two overlapping windows on the network, as a pan would produce. */
const viewA: Bounds = {minX, minY, maxX: minX + 0.6 * w, maxY: minY + 0.6 * h};
const viewB: Bounds = {minX: minX + 0.3 * w, minY: minY + 0.3 * h, maxX, maxY};

/** Identifies a path across builds: its kind, route and where it sits. */
function key(p: LanePath): string {
    return `${p.kind}:${p.route}:${p.edge}:${p.node ?? ''}:${p.between ? p.between.join('-') : ''}`;
}

function sameGeometry(cached: Layout, plain: Layout): void {
    expect(cached.paths.length).toBe(plain.paths.length);
    expect(cached.drawOrder).toEqual(plain.drawOrder);
    expect(cached.mergedEdges).toEqual(plain.mergedEdges);
    cached.paths.forEach((p, i) => {
        expect(key(p)).toBe(key(plain.paths[i]));
        expect(p.coords).toEqual(plain.paths[i].coords);
        expect(p.anchors).toEqual(plain.paths[i].anchors);
        expect(p.look).toEqual(plain.paths[i].look);
    });
}

describe('LayoutCache', () => {
    it('gives every viewport the layout it would have had on its own', () => {
        const cache = new LayoutCache();
        sameGeometry(layoutAtZoom(graph, 16, style, {bounds: viewA, cache}), layoutAtZoom(graph, 16, style, {bounds: viewA}));
        sameGeometry(layoutAtZoom(graph, 16, style, {bounds: viewB, cache}), layoutAtZoom(graph, 16, style, {bounds: viewB}));
        // Back to the first window, now entirely out of the cache.
        sameGeometry(layoutAtZoom(graph, 16, style, {bounds: viewA, cache}), layoutAtZoom(graph, 16, style, {bounds: viewA}));
        sameGeometry(layoutAtZoom(graph, 16, style, {cache}), layoutAtZoom(graph, 16, style));
    });

    it('hands back the same path objects for pieces in both viewports', () => {
        const cache = new LayoutCache();
        const a = layoutAtZoom(graph, 16, style, {bounds: viewA, cache});
        const byKey = new Map(a.paths.map((p) => [key(p), p]));
        const b = layoutAtZoom(graph, 16, style, {bounds: viewB, cache});
        let shared = 0;
        for (const p of b.paths) {
            const before = byKey.get(key(p));
            if (!before) continue;
            shared++;
            expect(p).toBe(before);
        }
        expect(shared).toBeGreaterThan(50);
    });

    it('resets when the zoom, the style or the graph changes', () => {
        const cache = new LayoutCache();
        layoutAtZoom(graph, 16, style, {bounds: viewA, cache});
        sameGeometry(layoutAtZoom(graph, 17, style, {bounds: viewA, cache}), layoutAtZoom(graph, 17, style, {bounds: viewA}));
        const wider = () => ({spacing: 12, width: 6, casingWidth: 1});
        sameGeometry(layoutAtZoom(graph, 17, wider, {bounds: viewA, cache}), layoutAtZoom(graph, 17, wider, {bounds: viewA}));
        const other = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(other);
        stabilizeLanes(other, {});
        sameGeometry(layoutAtZoom(other, 17, wider, {bounds: viewA, cache}), layoutAtZoom(other, 17, wider, {bounds: viewA}));
    });

    it('is not disturbed by a build for one route', () => {
        const cache = new LayoutCache();
        const busiest = graph.edges.reduce((a, e) => (e.routes.length > a.routes.length ? e : a)).routes[0];
        layoutAtZoom(graph, 16, style, {bounds: viewA, routes: [busiest], cache});
        sameGeometry(layoutAtZoom(graph, 16, style, {bounds: viewA, cache}), layoutAtZoom(graph, 16, style, {bounds: viewA}));
    });
});

describe('TessellateCache', () => {
    it('builds the mesh a fresh tessellation would', () => {
        const layoutCache = new LayoutCache();
        const meshCache = new TessellateCache();
        const opts = {scale: 512 * Math.pow(2, 16), origin: [minX, minY] as [number, number], unitsPerMercator: 8192 * 16384};
        for (const bounds of [viewA, viewB, viewA, viewB]) {
            const layout = layoutAtZoom(graph, 16, style, {bounds, cache: layoutCache});
            const cached = tessellate(layout.paths, {...opts, drawOrder: layout.drawOrder, cache: meshCache});
            const plain = tessellate(layout.paths, {...opts, drawOrder: layout.drawOrder});
            expect(cached.vertexCount).toBe(plain.vertexCount);
            expect(cached.indexCount).toBe(plain.indexCount);
            expect(cached.groups).toEqual(plain.groups);
            expect(cached.groupRoutes).toEqual(plain.groupRoutes);
            expect([...cached.vertices]).toEqual([...plain.vertices]);
            expect([...cached.indices]).toEqual([...plain.indices]);
            expect([...cached.colors]).toEqual([...plain.colors]);
        }
    });
});
