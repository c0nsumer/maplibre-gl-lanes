/**
 * Junctions are read by the geometry of their legs: a lane turns at a
 * corner, and the centerline keeps the corners the data has rather than
 * rounding them off.
 */
import {describe, it, expect} from 'vitest';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {smoothCatmullRom, type Polyline} from '../src/core/geometry';

const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Farthest any vertex of a is from the polyline b. */
function deviation(a: Polyline, b: Polyline): number {
    let worst = 0;
    for (let i = 0; i < a.length; i += 2) {
        let best = Infinity;
        for (let j = 0; j + 3 < b.length; j += 2) {
            const ax = b[j], ay = b[j + 1], dx = b[j + 2] - ax, dy = b[j + 3] - ay;
            const l2 = dx * dx + dy * dy;
            const t = l2 > 0 ? Math.max(0, Math.min(1, ((a[i] - ax) * dx + (a[i + 1] - ay) * dy) / l2)) : 0;
            best = Math.min(best, Math.hypot(a[i] - (ax + dx * t), a[i + 1] - (ay + dy * t)));
        }
        worst = Math.max(worst, best);
    }
    return worst;
}

/** A line of lng/lat pairs as one route's feature. */
const route = (id: string, coords: [number, number][]) => ({
    type: 'Feature' as const, properties: {route_id: id, route_colour: '#ff0000'},
    geometry: {type: 'LineString' as const, coordinates: coords},
});

describe('the centerline keeps the corners the data has', () => {
    it('does not round a square corner in a road', () => {
        // A kilometer east, then a kilometer north, with a vertex at the turn.
        const corner: Polyline = [0, 0, 400, 0, 400, -400];
        const rounded = smoothCatmullRom(corner, 5);
        const kept = smoothCatmullRom(corner, 5, 10, 3, 60);
        expect(deviation(rounded, corner)).toBeGreaterThan(20);
        expect(deviation(kept, corner)).toBeLessThan(0.001);
        // Asked for a radius, it rounds the corner by that radius. The
        // tangent points are a radius along each leg, so a quadratic fillet
        // of a right angle sits a quarter of its radius off the legs at its
        // middle. The fillet has to reach past the vertices the spline
        // itself put there, a few pixels apart, or it comes out far
        // smaller than asked for.
        const filleted = smoothCatmullRom(corner, 5, 10, 3, 60, 12);
        expect(deviation(filleted, corner)).toBeCloseTo(3, 1);
        // And the legs themselves are where they were.
        expect(deviation(corner, filleted)).toBeLessThan(0.36 * 12);
        // A gentle bend is still smoothed.
        const bend: Polyline = [0, 0, 400, 0, 800, -60];
        expect(smoothCatmullRom(bend, 5, 10, 3, 60).length).toBeGreaterThan(bend.length);
    });

    it('keeps a road corner in the drawn lane', () => {
        const g = buildLineGraph([route('a', [[-83.2, 42.8], [-83.19, 42.8], [-83.19, 42.81]])], {routeProperty: 'route_id'});
        orderLanes(g);
        const z = 16, scale = 512 * Math.pow(2, z);
        const layout = layoutAtZoom(g, z, style);
        const raw = g.edges[0].coords.map((v) => v * scale);
        const lane = layout.paths.find((p) => p.kind === 'lane')!;
        expect(deviation(lane.coords, raw)).toBeLessThan(style().width);
    });
});

describe('turns at a junction', () => {
    // A T: an east-west road with a road leaving it to the north, one route
    // along each, so the turn is a single lane and easy to measure.
    const graph = () => {
        const g = buildLineGraph([
            route('ew', [[-83.2, 42.8], [-83.19, 42.8], [-83.18, 42.8]]),
            route('ns', [[-83.19, 42.8], [-83.19, 42.81]]),
            route('turn', [[-83.2, 42.8], [-83.19, 42.8], [-83.19, 42.81]]),
        ], {routeProperty: 'route_id'});
        orderLanes(g);
        return g;
    };

    it('runs to the corner and rounds it, rather than bowing across', () => {
        const g = graph();
        const turn = layoutAtZoom(g, 17, style).paths.find((p) => p.kind === 'connector' && p.route === 'turn')!;
        const c = turn.coords;
        // A corner keeps the straight run of each leg: the first and last
        // segments are long, and everything bends in the middle.
        const first = Math.hypot(c[2] - c[0], c[3] - c[1]);
        const last = Math.hypot(c[c.length - 2] - c[c.length - 4], c[c.length - 1] - c[c.length - 3]);
        const pitch = style().spacing;
        expect(Math.max(first, last)).toBeGreaterThan(pitch);
        // And the bend is tight: the rounded part spans about a lane pitch,
        // not the whole junction.
        let bend = 0;
        for (let i = 2; i + 3 < c.length; i += 2) bend += Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1]);
        expect(bend).toBeLessThan(3 * pitch);
    });

    it('leaves a gentle bend as an arc', () => {
        const g = buildLineGraph([
            route('a', [[-83.2, 42.8], [-83.19, 42.8], [-83.18, 42.8005]]),
            route('b', [[-83.2, 42.8], [-83.19, 42.8]]),
        ], {routeProperty: 'route_id'});
        orderLanes(g);
        const conns = layoutAtZoom(g, 17, style).paths.filter((p) => p.kind === 'connector');
        // Sampled arcs, so every step is short: no long straight run to a corner.
        for (const p of conns) {
            const c = p.coords;
            for (let i = 0; i + 3 < c.length; i += 2) {
                expect(Math.hypot(c[i + 2] - c[i], c[i + 3] - c[i + 1])).toBeLessThan(2 * style().spacing);
            }
        }
    });
});
