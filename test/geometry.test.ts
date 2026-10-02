import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {offsetPolylineAnchored, polylineLength, selfIntersects, type Polyline} from '../src/core/geometry';
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

    // A loop cut 98 px along a segment used to take the segment start as its
    // anchor; the mesh keeps that offset between rebuilds, which slid the
    // vertex off the lane as the map zoomed.
    it('anchors the point where a loop is cut to the ground under it', () => {
        const kink: Polyline = [0, 0, 100, 0, 100.3, 0.001, 100.31, 0.4, 100, 10, 100, 60];
        const lane = offsetPolylineAnchored(kink, -1.5);
        expect(farthestFromAnchor(lane.points, lane.anchors)).toBeLessThan(2);
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

describe('a line that loops back over itself', () => {
    // A trail that circles a knoll and comes back to its own stem. The loop is shorter than loop
    // removal's window, and used to be cut as if the offset had made it: the lane shortcut across
    // the stem, and a route whose edges all merge into one junction lost most of its length.
    const lollipop: Polyline = [-20, 0, 0, 0];
    for (let i = 0; i <= 24; i++) {
        const a = Math.PI + (i / 24) * 2 * Math.PI;
        lollipop.push(3 + 3 * Math.cos(a), 3 * Math.sin(a));
    }
    lollipop.push(-20, 0.5);

    it('keeps the loop at an offset smaller than the loop', () => {
        for (const d of [2, -2]) {
            const lane = offsetPolylineAnchored(lollipop, d);
            // The inside of the loop is shorter by one turn of the offset; the outside is longer.
            expect(polylineLength(lane.points)).toBeGreaterThan(0.85 * (polylineLength(lollipop) - 2 * Math.PI * Math.abs(d)));
            // Cut, the lane ends where the stem does; kept, it reaches around the far side.
            let farthest = -Infinity;
            for (let i = 0; i < lane.points.length; i += 2) farthest = Math.max(farthest, lane.points[i]);
            expect(farthest).toBeGreaterThan(3);
        }
    });

    it('still cuts the loop a hairpin makes, which winds against the turn', () => {
        const hairpin: Polyline = [0, 0, 100, 0, 200, 0, 100, 30, 0, 60];
        for (const d of [3, -3]) {
            const lane = offsetPolylineAnchored(hairpin, d);
            expect(selfIntersects(lane.points)).toBe(false);
            expect(farthestFromAnchor(lane.points, lane.anchors)).toBeLessThanOrEqual(8 * 3);
        }
    });
});
