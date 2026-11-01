/**
 * A lane is a claim about where the path is. Rounding a bend keeps the lane
 * within a fixed pixel budget of the source line at every zoom; the spline
 * this replaced bowed meters off a path mapped with sparse vertices.
 */
import {describe, it, expect} from 'vitest';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {roundBends, type Polyline} from '../src/core/geometry';

/** The layout's budget, `BEND_DEVIATION_PX` in src/core/layout.ts. */
const CAP = 1.5;
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Distance from a point to the nearest point of a polyline. */
function distance(x: number, y: number, b: Polyline): number {
    let best = Infinity;
    for (let j = 0; j + 3 < b.length; j += 2) {
        const ax = b[j], ay = b[j + 1], dx = b[j + 2] - ax, dy = b[j + 3] - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        best = Math.min(best, Math.hypot(x - (ax + dx * t), y - (ay + dy * t)));
    }
    return best;
}

/** Farthest any vertex of a is from the polyline b. */
function deviation(a: Polyline, b: Polyline): number {
    let worst = 0;
    for (let i = 0; i < a.length; i += 2) worst = Math.max(worst, distance(a[i], a[i + 1], b));
    return worst;
}

/** Largest turn between consecutive segments, in degrees. */
function maxTurnDeg(p: Polyline): number {
    let worst = 0;
    for (let i = 2; i + 3 < p.length; i += 2) {
        const ax = p[i] - p[i - 2], ay = p[i + 1] - p[i - 1];
        const bx = p[i + 2] - p[i], by = p[i + 3] - p[i + 1];
        worst = Math.max(worst, Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by)));
    }
    return (worst * 180) / Math.PI;
}

/** `legs` segments of `legPx`, turning `bendDeg` at each vertex, all one way or alternating. */
function zigzag(legPx: number, bendDeg: number, legs: number, alternate: boolean): Polyline {
    const out: Polyline = [0, 0];
    let x = 0, y = 0, a = 0;
    for (let i = 0; i < legs; i++) {
        x += legPx * Math.cos(a);
        y += legPx * Math.sin(a);
        out.push(x, y);
        a += ((alternate && i % 2 ? -bendDeg : bendDeg) * Math.PI) / 180;
    }
    return out;
}

describe('rounded bends stay on the path', () => {
    it('keeps the line within the budget, and turns over several segments', () => {
        const cases: [number, number, boolean][] = [[220, 30, false], [220, 30, true], [60, 30, true], [150, 59, false], [25, 10, false]];
        for (const [leg, bend, alternate] of cases) {
            const src = zigzag(leg, bend, 6, alternate);
            const out = roundBends(src, CAP, 3, 60, 12);
            expect(deviation(out, src)).toBeLessThanOrEqual(CAP + 1e-9);
            // A fillet cuts the vertex by the budget over the cosine of half the bend, so for bends
            // under 60 degrees the source line is within 1.16 budgets of the result.
            expect(deviation(src, out)).toBeLessThanOrEqual(CAP / Math.cos((30 * Math.PI) / 180) + 1e-9);
            expect(maxTurnDeg(out)).toBeLessThan(bend / 3);
            // The middle of every leg is a straight the result still runs along.
            for (let i = 0; i + 3 < src.length; i += 2) {
                expect(distance((src[i] + src[i + 2]) / 2, (src[i + 1] + src[i + 3]) / 2, out)).toBeLessThan(1e-9);
            }
        }
    });

    it('leaves a line alone below the bend threshold', () => {
        const straight: Polyline = [0, 0, 100, 0, 200, 0.5, 300, 0.5];
        expect(roundBends(straight, CAP, 3, 60, 12)).toEqual(straight);
    });

    it('keeps a solo lane within the budget of its path at z18', () => {
        // Legs of 25 to 90 m with 20 to 40 degree bends, as a trail thinned to its turns is mapped.
        const lat0 = 47.4547, lng0 = -87.80945;
        const mPerDegLat = 110574, mPerDegLng = 111320 * Math.cos((lat0 * Math.PI) / 180);
        const legsM = [60, 89, 25, 70, 40, 85, 30, 55];
        const bendsDeg = [25, -35, 40, -20, 30, -25, 35];
        const coords: [number, number][] = [[lng0, lat0]];
        let x = 0, y = 0, a = 0.3;
        for (let i = 0; i < legsM.length; i++) {
            x += legsM[i] * Math.cos(a);
            y += legsM[i] * Math.sin(a);
            coords.push([lng0 + x / mPerDegLng, lat0 + y / mPerDegLat]);
            if (i < bendsDeg.length) a += (bendsDeg[i] * Math.PI) / 180;
        }
        const g = buildLineGraph([{
            type: 'Feature' as const, properties: {route_id: 'a', route_colour: '#ff0000'},
            geometry: {type: 'LineString' as const, coordinates: coords},
        }], {routeProperty: 'route_id'});
        orderLanes(g);
        const z = 18, scale = 512 * Math.pow(2, z);
        const layout = layoutAtZoom(g, z, style);
        const raw = g.edges[0].coords.map((v) => v * scale);
        const lane = layout.paths.find((p) => p.kind === 'lane')!;
        // The budget, plus the 0.25 px simplification before rounding and the one after it.
        expect(deviation(lane.coords, raw)).toBeLessThanOrEqual(CAP + 0.5 + 1e-6);
        // And it is a real test of the budget: the raw spline bowed several px here.
        expect(deviation(lane.coords, raw)).toBeGreaterThan(0.5);
    });
});
