/**
 * A solo lane takes a baseline shift only to meet a bundle at a junction
 * without a jog. Along the rest of its edge it has to lie on the path it
 * follows, and where its route ends it has to end on the path: a basemap
 * that draws the path, or a marker placed on it, shows any shift it keeps.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom} from '../src/core/layout';
import {polylineLength, type Polyline} from '../src/core/geometry';

function distToPolyline(x: number, y: number, p: Polyline): number {
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
        const l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
}

const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id'});
orderLanes(graph);
stabilizeLanes(graph);
const spacing = 6;
const layout = layoutAtZoom(graph, 15, () => ({spacing, width: 5, casingWidth: 1}));
const shifted = graph.edges.filter((e) => e.routes.length === 1 && (e.baseline ?? 0) !== 0);
const laneOn = (edge: number) => layout.paths.find((p) => p.kind === 'lane' && p.edge === edge)!;
const pathPx = (edge: number) => graph.edges[edge].coords.map((v) => v * layout.scale);
// The lane follows the edge's line as simplified and smoothed for the zoom,
// which strays from the source line by less than this.
const ON_PATH = 0.75;

describe('a solo lane with a baseline shift', () => {
    it('is what the fixture has: shifted solo edges, some long, some ending at a dead end', () => {
        expect(shifted.length).toBeGreaterThan(10);
        expect(shifted.some((e) => graph.nodes[e.b].ports.length === 1 || graph.nodes[e.a].ports.length === 1)).toBe(true);
    });

    it('ends on the path where its route ends', () => {
        let ends = 0;
        for (const e of shifted) {
            const lane = laneOn(e.id);
            if (!lane) continue;
            const px = pathPx(e.id);
            if (graph.nodes[e.a].ports.length === 1) {
                expect(distToPolyline(lane.coords[0], lane.coords[1], px)).toBeLessThan(ON_PATH);
                ends++;
            }
            if (graph.nodes[e.b].ports.length === 1) {
                expect(distToPolyline(lane.coords[lane.coords.length - 2], lane.coords[lane.coords.length - 1], px)).toBeLessThan(ON_PATH);
                ends++;
            }
        }
        expect(ends).toBeGreaterThan(0);
    });

    it('keeps the shift at a junction its route continues through, and lies on the path between', () => {
        let long = 0;
        for (const e of shifted) {
            const lane = laneOn(e.id);
            if (!lane) continue;
            const px = pathPx(e.id);
            if (polylineLength(px) < 40 * spacing) continue;
            long++;
            for (const [end, at] of [[e.a, 0], [e.b, lane.coords.length - 2]] as const) {
                if (graph.nodes[end].ports.length === 1) continue;
                const d = distToPolyline(lane.coords[at], lane.coords[at + 1], px);
                expect(Math.abs(d - spacing / 2)).toBeLessThan(1.5);
            }
            const mid = Math.floor(lane.coords.length / 4) * 2;
            expect(distToPolyline(lane.coords[mid], lane.coords[mid + 1], px)).toBeLessThan(ON_PATH);
        }
        expect(long).toBeGreaterThan(0);
    });

    it('eases gently: on a straight path it never slides faster than one px in ten', () => {
        // Two routes share a straight road; one turns off, the other runs
        // straight on alone to a dead end. The shift is set by hand, so the
        // test does not depend on what the solver makes of so small a graph.
        const line = (id: string, coordinates: number[][]) => ({type: 'Feature' as const, geometry: {type: 'LineString' as const, coordinates}, properties: {route_id: id}});
        const g = buildLineGraph([
            line('a', [[-83.2, 42.8], [-83.19, 42.8], [-83.17, 42.8]]),
            line('b', [[-83.2, 42.8], [-83.19, 42.8], [-83.19, 42.81]]),
        ], {routeProperty: 'route_id'});
        orderLanes(g);
        const solo = g.edges.find((e) => e.routes.length === 1 && e.routes[0] === 'a')!;
        solo.baseline = 0.5;
        const l = layoutAtZoom(g, 15, () => ({spacing, width: 5, casingWidth: 1}));
        const lane = l.paths.find((p) => p.kind === 'lane' && p.edge === solo.id)!;
        const y0 = solo.coords[1] * l.scale;
        const c = lane.coords;
        let steepest = 0, farthest = 0;
        for (let i = 2; i < c.length; i += 2) {
            const run = Math.abs(c[i] - c[i - 2]);
            if (run > 1e-6) steepest = Math.max(steepest, Math.abs(c[i + 1] - c[i - 1]) / run);
            farthest = Math.max(farthest, Math.abs(c[i + 1] - y0));
        }
        expect(farthest).toBeCloseTo(spacing / 2, 1);
        expect(steepest).toBeLessThan(0.1);
        expect(steepest).toBeGreaterThan(0);
        const deadEnd = g.nodes[solo.a].ports.length === 1 ? 0 : c.length - 2;
        expect(Math.abs(c[deadEnd + 1] - y0)).toBeLessThan(1e-6);
    });
});
