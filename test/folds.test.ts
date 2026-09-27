import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {openFolds} from '../src/core/folds';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import type {Polyline} from '../src/core/geometry';

const CLEARANCE = 12;

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

/** Points every `step` px along `p`. */
function sample(p: Polyline, step: number): [number, number][] {
    const out: [number, number][] = [[p[0], p[1]]];
    let carry = 0;
    for (let i = 2; i < p.length; i += 2) {
        const ax = p[i - 2], ay = p[i - 1], dx = p[i] - ax, dy = p[i + 1] - ay;
        const len = Math.hypot(dx, dy);
        let d = step - carry;
        for (; d <= len; d += step) out.push([ax + (dx * d) / len, ay + (dy * d) / len]);
        carry = len - (d - step);
    }
    return out;
}

/**
 * The narrowest the line gets against itself: the least distance between
 * two points further apart along it than the half circle a bend of
 * `clearance` would put between them.
 */
function narrowest(p: Polyline, clearance: number): number {
    const s = sample(p, 0.5);
    const sep = Math.ceil(((Math.PI / 2) * clearance) / 0.5);
    let least = Infinity;
    for (let i = 0; i < s.length; i++) {
        for (let j = i + sep; j < s.length; j++) least = Math.min(least, Math.hypot(s[j][0] - s[i][0], s[j][1] - s[i][1]));
    }
    return least;
}

function farthestFrom(p: Polyline, from: Polyline): number {
    let worst = 0;
    for (const [x, y] of sample(p, 0.5)) worst = Math.max(worst, distToPolyline(x, y, from));
    return worst;
}

/**
 * A hairpin with straight legs `gap` apart and a half circle for an apex.
 * The legs part at the open end, as they do where a trail leaves one.
 */
function hairpin(gap: number, legs = 120): Polyline {
    const p: Polyline = [0, -40, 40, 0, legs, 0];
    for (let k = 1; k < 12; k++) {
        const a = -Math.PI / 2 + (Math.PI * k) / 12;
        p.push(legs + (Math.cos(a) * gap) / 2, gap / 2 + (Math.sin(a) * gap) / 2);
    }
    p.push(legs, gap, 40, gap, 0, gap + 40);
    return p;
}

describe('opening fold backs', () => {
    it('pushes the legs of a narrow hairpin apart to the clearance, and no further', () => {
        const p = hairpin(5);
        expect(narrowest(p, CLEARANCE)).toBeLessThan(5.01);
        const opened = openFolds(p, CLEARANCE, 10, 10);
        expect(opened).not.toBe(p);
        // Half a pixel short of the clearance is the smoothing of the push.
        expect(narrowest(opened, CLEARANCE)).toBeGreaterThan(CLEARANCE - 0.5);
        // Each leg gives half of what the gap lacked: nothing strays past that.
        expect(farthestFrom(opened, p)).toBeLessThan((CLEARANCE - 5) / 2 + 0.5);
    });

    it('opens a sharp apex into a turn the bundle fits round, through its tip', () => {
        // Legs 30 degrees apart meeting in a point: nothing like a half circle.
        const spread = Math.tan((15 * Math.PI) / 180) * 150;
        const p: Polyline = [0, -spread, 150, 0, 0, spread];
        const opened = openFolds(p, CLEARANCE, 10, 10);
        expect(opened).not.toBe(p);
        expect(narrowest(opened, CLEARANCE)).toBeGreaterThan(CLEARANCE - 0.5);
        expect(distToPolyline(150, 0, opened)).toBeLessThan(0.5);
        expect(farthestFrom(opened, p)).toBeLessThanOrEqual(CLEARANCE / 2);
        // The turn is round now: no vertex turns by more than its share of a half circle.
        for (let i = 2; i + 3 < opened.length; i += 2) {
            const ax = opened[i] - opened[i - 2], ay = opened[i + 1] - opened[i - 1];
            const bx = opened[i + 2] - opened[i], by = opened[i + 3] - opened[i + 1];
            expect(Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))).toBeLessThan(Math.PI / 4);
        }
    });

    it('returns the very line where there is nothing to open', () => {
        const wide = hairpin(CLEARANCE + 1);
        expect(openFolds(wide, CLEARANCE, 10, 10)).toBe(wide);
        const straight: Polyline = [0, 0, 50, 2, 100, 0];
        expect(openFolds(straight, CLEARANCE, 0, 0)).toBe(straight);
    });

    it('leaves a corner alone, however wide the bundle', () => {
        // A right angle whose legs bow inward: closer than the clearance a
        // long way round the corner, but a corner, and drawn well as one.
        const p: Polyline = [0, 0, 40, 3, 80, 0, 83, 40, 80, 80];
        expect(openFolds(p, 40, 0, 0)).toBe(p);
    });

    it('leaves a stack of switchbacks alone', () => {
        const p: Polyline = [0, 0, 120, 0, 123, 2.5, 120, 5, 0, 5, -3, 7.5, 0, 10, 120, 10];
        expect(openFolds(p, CLEARANCE, 0, 0)).toBe(p);
    });

    it('moves nothing near the ends of the line', () => {
        const p = hairpin(5);
        const opened = openFolds(p, CLEARANCE, 80, 80);
        expect(opened).not.toBe(p);
        // 80 px along either leg is x = 63: short of that, the line is its old self.
        for (const [x, y] of sample(opened, 0.5)) if (x < 60) expect(distToPolyline(x, y, p)).toBeLessThan(1e-9);
        expect(farthestFrom(opened, p)).toBeGreaterThan(3);
    });
});

describe('a bundle through a hairpin narrower than itself', () => {
    const sizes = () => ({spacing: 6, width: 5, casingWidth: 1});
    // Pixels at zoom 15 on the equator, as degrees.
    const deg = 360 / (512 * 2 ** 15);
    // Straight legs all the way to the ends: a bend in them would set the
    // spline swinging across so narrow a gap.
    const px: Polyline = [0, 0, 200, 0];
    for (let k = 1; k < 12; k++) px.push(200 + Math.sin((Math.PI * k) / 12) * 2.5, 2.5 - Math.cos((Math.PI * k) / 12) * 2.5);
    px.push(200, 5, 0, 5);
    const coords: number[][] = [];
    for (let i = 0; i < px.length; i += 2) coords.push([px[i] * deg, -px[i + 1] * deg]);
    const features = ['a', 'b'].map((id) => ({
        type: 'Feature', properties: {route_id: id, route_colour: id === 'a' ? '#c00' : '#00c'},
        geometry: {type: 'LineString', coordinates: coords},
    }));
    const lanes = (openFolds: boolean) => {
        const g = buildLineGraph(features as never, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(g);
        return layoutAtZoom(g, 15, sizes, {openFolds}).paths.filter((p) => p.kind === 'lane');
    };
    /**
     * The part of each lane past the first 40 px. The ends of the line do
     * not move, so the legs are still 5 px apart there.
     */
    const pastTheEnds = (paths: ReturnType<typeof lanes>): Polyline[] => {
        let x0 = Infinity;
        for (let i = 0; i < paths[0].coords.length; i += 2) x0 = Math.min(x0, paths[0].coords[i]);
        return paths.map((p) => sample(p.coords, 1).filter(([x]) => x - x0 > 40).flat());
    };
    /** How far the two lanes stray from one lane pitch apart, measured both ways. */
    const offPitch = ([a, b]: Polyline[]) => {
        let worst = 0;
        for (const [from, to] of [[a, b], [b, a]]) {
            for (let i = 0; i < from.length; i += 2) worst = Math.max(worst, Math.abs(distToPolyline(from[i], from[i + 1], to) - 6));
        }
        return worst;
    };

    it('keeps its lanes one pitch apart all the way round, and each clear of itself', () => {
        const open = lanes(true);
        expect(open).toHaveLength(2);
        const parts = pastTheEnds(open);
        expect(offPitch(parts)).toBeLessThan(0.75);
        // A lane is 7 px across with its casing. The inner lane's legs end
        // up that far apart, where the line's own legs were 5 px apart.
        expect(Math.min(...parts.map((p) => narrowest(p, 7)))).toBeGreaterThan(6.5);
    });

    it('lays the legs of the inner lane over each other when left alone', () => {
        const parts = pastTheEnds(lanes(false));
        expect(Math.min(...parts.map((p) => narrowest(p, 7)))).toBeLessThan(1.5);
    });
});

describe('fold opening on a real network', () => {
    it('changes the edges that fold and nothing else', () => {
        const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(g);
        const sizes = () => ({spacing: 5.75, width: 4.75, casingWidth: 1});
        // The node as well: two edges can join the same two junctions, and a
        // route then has the same turn, between the same edges, at both.
        const key = (p: {kind: string; route: string; edge: number; node?: number; between?: [number, number]}) => `${p.kind}|${p.route}|${p.edge}|${p.node ?? ''}|${p.between ?? ''}`;
        const shut = new Map(layoutAtZoom(g, 15, sizes, {openFolds: false}).paths.map((p) => [key(p), p]));
        const open = layoutAtZoom(g, 15, sizes).paths;
        expect(shut.size).toBe(open.length);
        expect(new Set(open.map(key)).size).toBe(open.length);
        const movedEdges = new Set<number>();
        let movedConnectors = 0;
        for (const p of open) {
            const q = shut.get(key(p))!;
            if (p.coords.length === q.coords.length && p.coords.every((v, i) => v === q.coords[i])) continue;
            if (p.kind === 'lane') movedEdges.add(p.edge);
            // An opened line has other vertices, so a lane end on it is the
            // same point from different arithmetic.
            else if (p.coords.length !== q.coords.length || p.coords.some((v, i) => Math.abs(v - q.coords[i]) > 1e-6)) movedConnectors++;
        }
        // The node fronts are out of reach, so no connector moves.
        expect(movedConnectors).toBe(0);
        expect(movedEdges.size).toBeGreaterThan(0);
        expect(movedEdges.size).toBeLessThan(15);
        for (const e of movedEdges) expect(g.edges[e].routes.length).toBeGreaterThan(1);
    });
});
