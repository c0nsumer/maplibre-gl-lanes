/**
 * Dash phase is read off every piece of a dashed route at a zoom, in view
 * or not, so it neither moves when the viewport moves nor breaks at a seam
 * no walk from the route's start would reach. It used to be walked chain
 * by chain over the pieces the viewport had built, so a lane outside the
 * view counted its edge's length instead of its own, and dashes jumped by
 * up to 9 px between two builds half a screen apart. A connector that
 * joined a branch to its trunk, or a loop end to its stem, was not on any
 * chain's walk and kept its phase at zero.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type LanePath} from '../src/core/layout';
import {polylineLength} from '../src/core/geometry';

const sizesAt = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

function line(route: string, coords: number[][]): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}

/** The distance along the route at a piece's first (0) or last (1) vertex. */
function distanceAt(p: LanePath, end: 0 | 1): number {
    const s = p.startDistance, l = polylineLength(p.coords);
    return end ? (s >= 0 ? s + l : -s - l) : Math.abs(s);
}

/** Seams of one route: pairs of piece ends at one point, with the two distances read there. */
function seams(paths: LanePath[], route: string): {a: string; b: string; da: number; db: number}[] {
    const at = new Map<string, {p: LanePath; end: 0 | 1}[]>();
    for (const p of paths) {
        if (p.route !== route) continue;
        for (const end of [0, 1] as const) {
            const c = p.coords;
            const k = end ? `${c[c.length - 2]},${c[c.length - 1]}` : `${c[0]},${c[1]}`;
            const list = at.get(k) ?? [];
            list.push({p, end});
            at.set(k, list);
        }
    }
    const out: {a: string; b: string; da: number; db: number}[] = [];
    const name = (x: {p: LanePath; end: 0 | 1}) => `${x.p.kind} ${x.p.between ? x.p.between.join('->') : x.p.edge} end ${x.end}`;
    for (const list of at.values()) {
        for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
            out.push({a: name(list[i]), b: name(list[j]), da: distanceAt(list[i].p, list[i].end), db: distanceAt(list[j].p, list[j].end)});
        }
    }
    return out;
}

describe('dash phase of a route that forks', () => {
    // A dashed trail runs west to east; a spur of the same route leaves its
    // middle to the north, and a second route shares the trunk so its lanes
    // are cut back at the fork and joined by connectors.
    const g = buildLineGraph([
        line('A', [[-0.002, 0], [0, 0], [0.002, 0]]),
        line('A', [[0, 0], [0, 0.002]]),
        line('B', [[-0.002, 0], [0, 0], [0.002, 0]]),
    ], {routes: {A: {dash: [2, 1]}}});
    orderLanes(g);

    it('agrees at every seam, including where the spur joins the trunk', () => {
        const layout = layoutAtZoom(g, 15, sizesAt);
        const all = seams(layout.paths, 'A');
        expect(all.length).toBeGreaterThanOrEqual(3);
        expect(all.filter((s) => Math.abs(s.da - s.db) > 1e-6)).toEqual([]);
    });
});

describe('dash phase across two viewports', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/mfo.src.geojson', import.meta.url), 'utf8'));
    const routes: Record<string, {dash: [number, number]}> = {};
    for (const f of fc.features) routes[String(f.properties.route_id)] = {dash: [2, 1]};
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', routes});
    orderLanes(g, {seed: 1});
    stabilizeLanes(g);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of g.nodes) {
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
    }

    for (const z of [12, 13]) {
        it(`is the same on every piece two builds half a screen apart share, at z${z}`, () => {
            const scale = 512 * Math.pow(2, z);
            const w = (390 * 1.5) / scale, h = (844 * 1.5) / scale;
            const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
            const view = (dx: number) => ({minX: cx + dx - w / 2, minY: cy - h / 2, maxX: cx + dx + w / 2, maxY: cy + h / 2});
            const key = (p: LanePath) => `${p.route}|${p.kind}|${p.edge}|${p.between?.join('/')}|${p.coords.length}`;
            const first = new Map(layoutAtZoom(g, z, sizesAt, {bounds: view(0)}).paths.map((p) => [key(p), p.startDistance]));
            const second = layoutAtZoom(g, z, sizesAt, {bounds: view(195 / scale)}).paths;
            const shared = second.filter((p) => first.has(key(p)));
            expect(shared.length).toBeGreaterThan(10);
            const moved = shared.filter((p) => p.startDistance !== first.get(key(p)));
            expect(moved.map((p) => `${key(p)}: ${first.get(key(p))} then ${p.startDistance}`)).toEqual([]);
        });
    }
});
