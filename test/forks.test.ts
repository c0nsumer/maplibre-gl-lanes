/**
 * A route that forks inside a merged junction crosses the merged edge on
 * two connectors. They have to share a line across it, or the route draws
 * wider than a lane for the length of the junction.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom} from '../src/core/layout';
import {offsetPolylineSlidingAnchored, type Polyline} from '../src/core/geometry';

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

describe('a slide by way of other offsets', () => {
    it('passes through each on the way, and is the straight slide without any', () => {
        const line: Polyline = [0, 0, 100, 0];
        // Left of travel is up the screen: negative y.
        const yAt = (p: Polyline, x: number) => {
            for (let i = 0; i < p.length; i += 2) if (Math.abs(p[i] - x) < 1e-6) return p[i + 1];
            return NaN;
        };
        const straight = offsetPolylineSlidingAnchored(line, 4, -4).points;
        expect(yAt(straight, 0)).toBeCloseTo(-4, 6);
        expect(yAt(straight, 48)).toBeCloseTo(-0.16, 6);
        expect(yAt(straight, 100)).toBeCloseTo(4, 6);
        const via = offsetPolylineSlidingAnchored(line, 4, -4, 4, [0.4, 4]).points;
        // Held at 4 to the knot at 40 px, then down to -4 over the rest.
        expect(yAt(via, 20)).toBeCloseTo(-4, 6);
        expect(yAt(via, 40)).toBeCloseTo(-4, 6);
        expect(yAt(via, 100)).toBeCloseTo(4, 6);
        expect(yAt(via, 72)).toBeCloseTo(-4 + (8 * 32) / 60, 6);
    });
});

describe('a route that forks inside a merged junction', () => {
    // MFO at zoom 13: the gold and the orange route each arrive at one
    // junction on the main bundle (edge 1) and on a spur (edge 4), and leave
    // together on edge 5. The edge between the two arrivals is too short to
    // draw at this zoom, so each arrival crosses it on a connector of its own.
    const fc = JSON.parse(readFileSync(new URL('./fixtures/mfo.src.geojson', import.meta.url), 'utf8'));
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
    orderLanes(g);
    stabilizeLanes(g);
    const width = 2 + ((13 - 10) / 4) * 2;
    const spacing = width + 1;
    const layout = layoutAtZoom(g, 13, () => ({spacing, width, casingWidth: 1}));

    it('brings the two arrivals onto one line before the junction is crossed', () => {
        expect(layout.mergedEdges.length).toBeGreaterThan(0);
        let forks = 0;
        for (const route of ['-84', '-124']) {
            const find = (from: number) => layout.paths.find((p) => p.kind === 'connector' && p.route === route && p.between![0] === from && p.between![1] === 5);
            const a = find(1), b = find(4);
            expect(a && b).toBeTruthy();
            forks++;
            // The two join at the middle of the merged edge, which falls
            // about half way along, sooner or later with the node fronts.
            // Over the last third they are never a tenth of a lane apart.
            // Slid straight from lane to lane they were a sixth of a lane
            // apart even there, a quarter over the second half, and more
            // than half a lane on the full network.
            const c = a!.coords;
            const cum = [0];
            for (let i = 2; i < c.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(c[i] - c[i - 2], c[i + 1] - c[i - 1]));
            const total = cum[cum.length - 1];
            let apart = 0;
            for (let i = 0; i < c.length; i += 2) if (cum[i / 2] >= (2 / 3) * total) apart = Math.max(apart, distToPolyline(c[i], c[i + 1], b!.coords));
            expect(apart / spacing).toBeLessThan(0.1);
        }
        expect(forks).toBe(2);
    });
});
