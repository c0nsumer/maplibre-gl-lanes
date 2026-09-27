/**
 * Junction merging: an edge too short for its junctions at a zoom is merged
 * into them, its routes cross on lanes that follow its geometry, and it
 * comes back as a normal edge at a zoom where it is long enough.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom, type LanePath, type Layout} from '../src/core/layout';

function line(route: string, coords: number[][]): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Every route's pieces, in chain order, must meet end to start; returns the joins that do not. */
function breaks(g: ReturnType<typeof buildLineGraph>, layout: Layout): string[] {
    const lanes = new Map<string, LanePath>();
    const conns = new Map<string, LanePath>();
    for (const p of layout.paths) {
        if (p.kind === 'lane') lanes.set(`${p.edge}:${p.route}`, p);
        else conns.set(`${p.route}:${p.between![0]}:${p.between![1]}`, p);
    }
    const start = (c: number[], fwd: boolean) => (fwd ? [c[0], c[1]] : [c[c.length - 2], c[c.length - 1]]);
    const end = (c: number[], fwd: boolean) => (fwd ? [c[c.length - 2], c[c.length - 1]] : [c[0], c[1]]);
    const d = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const out: string[] = [];
    for (const [rid, chains] of g.chains) {
        for (const chain of chains) {
            const seq = chain.steps.filter((s) => lanes.has(`${s.edge}:${rid}`));
            const pairs = seq.length - (chain.closed ? 0 : 1);
            for (let i = 0; i < pairs; i++) {
                const s = seq[i], t = seq[(i + 1) % seq.length];
                const a = lanes.get(`${s.edge}:${rid}`)!, b = lanes.get(`${t.edge}:${rid}`)!;
                const aEnd = end(a.coords, s.forward), bStart = start(b.coords, t.forward);
                const conn = conns.get(`${rid}:${s.edge}:${t.edge}`);
                const gap = conn ? Math.max(d(aEnd, [conn.coords[0], conn.coords[1]]), d([conn.coords[conn.coords.length - 2], conn.coords[conn.coords.length - 1]], bStart)) : d(aEnd, bStart);
                if (gap > 1) out.push(`${rid} ${s.edge}->${t.edge} ${gap.toFixed(1)} px`);
            }
        }
    }
    return out;
}

function selfIntersects(c: number[]): boolean {
    const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) => {
        const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
        const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
        return d1 * d2 < 0 && d3 * d4 < 0;
    };
    const n = c.length / 2;
    for (let i = 0; i + 1 < n; i++) for (let j = i + 2; j + 1 < n; j++) if (cross(c[2 * i], c[2 * i + 1], c[2 * i + 2], c[2 * i + 3], c[2 * j], c[2 * j + 1], c[2 * j + 2], c[2 * j + 3])) return true;
    return false;
}

describe('short edges merge into their junctions', () => {
    // A three-route trunk reaches N1, where C turns north. A and B go on 4 m
    // east to N2, where A turns south and B ends. That 4 m edge is a few
    // pixels at z16, far under the bundle width, and 160 px at z22.
    const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
    const n2 = [0.00005, 0];
    const g = buildLineGraph([
        line('A', [...trunk, n2, [0.00005, -0.001]]),
        line('B', [...trunk, n2]),
        line('C', [...trunk, [0, 0.001]]),
    ]);
    orderLanes(g);
    const shortEdge = g.edges.find((e) => e.routes.length === 2 && e.routes.includes('A') && e.routes.includes('B'))!;
    const trunkEdge = g.edges.find((e) => e.routes.length === 3)!;
    const south = g.edges.find((e) => e.routes.length === 1 && e.routes[0] === 'A')!;

    it('merges the edge at a low zoom and crosses it on one connector per route', () => {
        const layout = layoutAtZoom(g, 16, style);
        expect(layout.mergedEdges).toEqual([shortEdge.id]);
        // A passes through: no lane on the short edge, one connector from the trunk to the south branch.
        expect(layout.paths.some((p) => p.kind === 'lane' && p.edge === shortEdge.id && p.route === 'A')).toBe(false);
        const a = layout.paths.find((p) => p.kind === 'connector' && p.route === 'A')!;
        expect(a.between).toEqual([trunkEdge.id, south.id]);
        // B ends on the short edge: one piece runs from its trunk lane to its
        // end there, so the route keeps its visible extent.
        const b = layout.paths.find((p) => p.kind === 'connector' && p.route === 'B')!;
        expect(b.between).toEqual([trunkEdge.id, shortEdge.id]);
        const scale = layout.scale;
        const n2 = g.nodes[shortEdge.b === trunkEdge.b || shortEdge.b === trunkEdge.a ? shortEdge.a : shortEdge.b];
        const endDist = Math.hypot(b.coords[b.coords.length - 2] - n2.x * scale, b.coords[b.coords.length - 1] - n2.y * scale);
        expect(endDist).toBeLessThan(style().spacing);
        expect(breaks(g, layout)).toEqual([]);
        for (const p of layout.paths) expect(selfIntersects(p.coords)).toBe(false);
    });

    it('keeps the edge at a zoom where it is long enough', () => {
        const layout = layoutAtZoom(g, 22, style);
        expect(layout.mergedEdges).toEqual([]);
        expect(layout.paths.filter((p) => p.kind === 'lane' && p.edge === shortEdge.id).map((p) => p.route).sort()).toEqual(['A', 'B']);
        expect(breaks(g, layout)).toEqual([]);
    });
});

describe('RAMBA junctions across zooms', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const g = buildLineGraph(fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id))), {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name', uniformProperties: ['oneway', 'trail_name']});
    orderLanes(g, {seed: 42});
    const styleAt = (z: number) => {
        const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
        return {spacing: width + 1, width, casingWidth: 1};
    };

    for (const z of [14, 15, 15.75, 16, 18]) {
        it(`stays continuous with no self-crossing connectors at z${z}`, () => {
            const layout = layoutAtZoom(g, z, styleAt);
            expect(breaks(g, layout)).toEqual([]);
            const crossing = layout.paths.filter((p) => p.kind === 'connector' && selfIntersects(p.coords));
            expect(crossing.length).toBeLessThanOrEqual(z <= 14 ? 1 : 0);
            // A connector leaves its lane ends along them, never sideways. A
            // connector derived from a clique reference that was cut
            // elsewhere once had its ends snapped onto the lane from 28 px
            // away, a jump that closed into a loop. The length of that first
            // piece says nothing on its own: a turn drawn as a corner runs
            // straight to the corner before it bends, so what is checked is
            // that it carries on in the direction it set off in.
            const turn = (c: number[], i: number, j: number, k: number) => {
                const ax = c[j] - c[i], ay = c[j + 1] - c[i + 1];
                const bx = c[k] - c[j], by = c[k + 1] - c[j + 1];
                const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
                if (la < 0.1 || lb < 0.1) return 0;
                return (Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))) * 180) / Math.PI;
            };
            const spacing = styleAt(z).spacing;
            const far = (c: number[], i: number, j: number) => Math.hypot(c[j] - c[i], c[j + 1] - c[i + 1]) > 1.5 * spacing;
            const jumps = layout.paths.filter((p) => {
                if (p.kind !== 'connector' || p.coords.length < 8) return false;
                const c = p.coords, n = c.length;
                return (far(c, 0, 2) && turn(c, 0, 2, 4) > 30) || (far(c, n - 4, n - 2) && turn(c, n - 6, n - 4, n - 2) > 30);
            });
            expect(jumps.map((p) => `${p.route} ${p.between!.join('->')}`)).toEqual([]);
            // Merging fades out with zoom.
            if (z >= 18) expect(layout.mergedEdges.length).toBeLessThanOrEqual(2);
            else expect(layout.mergedEdges.length).toBeGreaterThan(0);
        });
    }
});
