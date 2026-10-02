import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {offsetPolylineAnchored, type Polyline} from '../src/core/geometry';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom} from '../src/core/layout';

/** Whether the segment at one end of `p` runs the way (dx, dy) does. */
function endRunsAlong(p: Polyline, end: 0 | 1, dx: number, dy: number): boolean {
    const i = end ? p.length - 4 : 0;
    return (p[i + 2] - p[i]) * dx + (p[i + 3] - p[i + 1]) * dy > 0;
}

describe('offsetting a line that bends just short of its end', () => {
    // 100 px east, then a 45 degree turn to the right (y is down) with
    // under a pixel left to run: what a node front leaves when it cuts an
    // edge just past a bend.
    const line: Polyline = [0, 0, 100, 0, 100.6, 0.6];
    const back: Polyline = [100.6, 0.6, 100, 0, 0, 0];

    it('ends the lane on the inside of the bend without doubling back', () => {
        // Right of travel is the inside of a right turn.
        const inside = offsetPolylineAnchored(line, -6);
        expect(endRunsAlong(inside.points, 1, 0.6, 0.6)).toBe(true);
        expect(inside.anchors).toHaveLength(inside.points.length);
        // The end point is where it was: square off the end of the source.
        const n = inside.points.length;
        expect(inside.points[n - 2]).toBeCloseTo(100.6 - 6 * Math.SQRT1_2, 6);
        expect(inside.points[n - 1]).toBeCloseTo(0.6 + 6 * Math.SQRT1_2, 6);
        // And the lane still comes from where it came from.
        expect(inside.points.slice(0, 2)).toEqual([0, 6]);
    });

    it('does the same at the start of a line', () => {
        const inside = offsetPolylineAnchored(back, 6);
        expect(endRunsAlong(inside.points, 0, -0.6, -0.6)).toBe(true);
        expect(inside.points[0]).toBeCloseTo(100.6 - 6 * Math.SQRT1_2, 6);
        expect(inside.points[1]).toBeCloseTo(0.6 + 6 * Math.SQRT1_2, 6);
    });

    it('leaves the outside of the bend, which has no hook, as it was', () => {
        const outside = offsetPolylineAnchored(line, 6);
        expect(endRunsAlong(outside.points, 1, 0.6, 0.6)).toBe(true);
        // Start, the end of the long segment, the arc round the bend, the end.
        expect(outside.points.length / 2).toBeGreaterThanOrEqual(4);
        expect(outside.points.slice(0, 4)).toEqual([0, -6, 100, -6]);
    });

    it('leaves a lane alone that turns back further from its end than a hook reaches', () => {
        // A real hairpin 40 px before the end, wide enough for the offset.
        const hairpin: Polyline = [0, 0, 100, 0, 110, 10, 100, 20, 60, 20];
        const lane = offsetPolylineAnchored(hairpin, -3);
        expect(lane.points.length).toBeGreaterThanOrEqual(hairpin.length);
        expect(lane.points.slice(0, 2)).toEqual([0, 3]);
    });
});

describe('lane ends at a RAMBA junction cut just past a bend', () => {
    // Node 58 at zoom 15.9: the front cuts edge 67 under a pixel past a
    // bend, and the two lanes inside the bend used to end in a hook. The
    // connectors took their direction from it, left the wrong way and
    // swung back, which opened a wedge of background inside the bundle.
    it('end running toward the node', () => {
        const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(g);
        stabilizeLanes(g);
        const width = 4 + ((15.9 - 14) / 4) * 3;
        const layout = layoutAtZoom(g, 15.9, () => ({spacing: width + 1, width, casingWidth: 1}));
        const edge = g.edges[67];
        expect(edge.b).toBe(58);
        const node = g.nodes[58];
        const lanes = layout.paths.filter((p) => p.kind === 'lane' && p.edge === 67);
        expect(lanes).toHaveLength(5);
        for (const lane of lanes) {
            const c = lane.coords, n = c.length;
            // Toward the node from well back along the lane, against the last segment.
            const back = Math.max(0, n - 8);
            const toNode = [node.x * layout.scale - c[back], node.y * layout.scale - c[back + 1]];
            expect(endRunsAlong(c, 1, toNode[0], toNode[1])).toBe(true);
        }
    });
});

/** Farthest any vertex of `points` lies from its anchor. */
function farthestFromAnchor(points: Polyline, anchors: Polyline): number {
    let far = 0;
    for (let i = 0; i < points.length; i += 2) far = Math.max(far, Math.hypot(points[i] - anchors[i], points[i + 1] - anchors[i + 1]));
    return far;
}

describe('the inside of a hairpin narrower than a pixel', () => {
    // Out and back, 0.01 px apart: the two offset segments at the turn are
    // nearly parallel, so their intersection lay 30000 px along the line.
    it('stays within a few offsets of the turn', () => {
        const hairpin: Polyline = [0, 0, 100, 0, 200, 0, 100, 0.01, 0, 0.01];
        const lane = offsetPolylineAnchored(hairpin, -1.5);
        expect(farthestFromAnchor(lane.points, lane.anchors)).toBeLessThanOrEqual(8 * 1.5);
    });

    // Roller Coaster in MFO at zoom 10.5: sub-meter twists in the trail put
    // a lane vertex over 200 px west of the bundle, a spike off the screen.
    it('puts no MFO lane vertex far from its ground point', () => {
        const fc = JSON.parse(readFileSync(new URL('./fixtures/mfo.src.geojson', import.meta.url), 'utf8'));
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(g);
        stabilizeLanes(g);
        const width = 2 + ((10.5 - 10) / 4) * 2;
        const layout = layoutAtZoom(g, 10.5, () => ({spacing: width + 1, width, casingWidth: 1}));
        for (const p of layout.paths) expect(farthestFromAnchor(p.coords, p.anchors)).toBeLessThan(60);
    });
});
