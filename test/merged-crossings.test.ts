/**
 * Where the graph takes a route from one drawn edge, through edges merged
 * into a junction, to another drawn edge, the layout owes a connector that
 * joins those two lanes. The graph's transitions do not say which way a
 * route travels: where a chain of the route ends at a node that has more
 * of the route, it is joined to another edge with the chain's own edge as
 * `from`. A route that forks beside a merged edge then has that edge as
 * `from` at both ends, and the crossing was once left to whichever end the
 * route arrives by, which was neither: the lane stopped on one side of the
 * junction and took up again on the other.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph, type LineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type LanePath} from '../src/core/layout';

const sizesAt = (z: number) => {
    const width = z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

function graphOf(fixture: string): LineGraph {
    const fc = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.src.geojson`, import.meta.url), 'utf8'));
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
    orderLanes(g);
    stabilizeLanes(g);
    return g;
}

/** Crossings the graph asks for at this zoom, and those of them no connector joins. */
function crossings(g: LineGraph, zoom: number): {all: number; unjoined: string[]} {
    const layout = layoutAtZoom(g, zoom, sizesAt);
    const merged = new Set(layout.mergedEdges);
    const lanes = new Map<string, LanePath>();
    for (const p of layout.paths) if (p.kind === 'lane') lanes.set(`${p.edge}:${p.route}`, p);
    const connectors = layout.paths.filter((p) => p.kind === 'connector');
    type Port = {edge: number; end: 'a' | 'b'};
    const pairs = new Map<string, {route: string; a: Port; b: Port}>();
    // From a drawn edge, along every branch of merged edges, to each drawn edge the route comes out on.
    const walk = (route: string, cur: number, node: number, seen: number[], start: Port) => {
        if (seen.includes(cur)) return;
        const e = g.edges[cur], far = e.a === node ? e.b : e.a;
        for (const t of g.nodes[far].transitions) {
            if (t.route !== route || t.from < 0 || t.to < 0) continue;
            const pa = g.nodes[far].ports[t.from], pb = g.nodes[far].ports[t.to];
            const next = pa.edge === cur && pb.edge !== cur ? pb : pb.edge === cur && pa.edge !== cur ? pa : null;
            if (!next) continue;
            if (merged.has(next.edge)) walk(route, next.edge, far, [...seen, cur], start);
            else if (next.edge !== start.edge || next.end !== start.end) {
                pairs.set([`${start.edge}${start.end}`, `${next.edge}${next.end}`].sort().join('|') + '|' + route, {route, a: start, b: next});
            }
        }
    };
    for (const node of g.nodes) {
        for (const t of node.transitions) {
            if (t.from < 0 || t.to < 0) continue;
            const from = node.ports[t.from], to = node.ports[t.to];
            if (merged.has(from.edge) === merged.has(to.edge)) continue;
            walk(t.route, (merged.has(from.edge) ? from : to).edge, node.id, [], merged.has(from.edge) ? to : from);
        }
    }
    const endOf = (p: LanePath, end: 'a' | 'b') => (end === 'a' ? [p.coords[0], p.coords[1]] : [p.coords[p.coords.length - 2], p.coords[p.coords.length - 1]]);
    const touches = (c: LanePath, e: number[]) => {
        const n = c.coords.length;
        return Math.hypot(c.coords[0] - e[0], c.coords[1] - e[1]) < 0.01 || Math.hypot(c.coords[n - 2] - e[0], c.coords[n - 1] - e[1]) < 0.01;
    };
    const unjoined: string[] = [];
    let all = 0;
    for (const {route, a, b} of pairs.values()) {
        const la = lanes.get(`${a.edge}:${route}`), lb = lanes.get(`${b.edge}:${route}`);
        if (!la || !lb) continue;
        all++;
        const ea = endOf(la, a.end), eb = endOf(lb, b.end);
        if (!connectors.some((c) => c.route === route && touches(c, ea) && touches(c, eb))) unjoined.push(`route ${route}: e${a.edge} to e${b.edge}`);
    }
    return {all, unjoined};
}

describe('a route across edges merged into a junction', () => {
    for (const [fixture, zooms] of [['ramba', [13, 14, 15, 16]], ['example', [13, 14]], ['mfo', [13, 15]]] as const) {
        const g = graphOf(fixture);
        for (const z of zooms) {
            it(`is joined by a connector wherever the graph takes it through, on ${fixture} at z${z}`, () => {
                const {all, unjoined} = crossings(g, z);
                expect(all).toBeGreaterThan(0);
                expect(unjoined).toEqual([]);
                const paths = layoutAtZoom(g, z, sizesAt).paths;
                expect(new Set(paths).size).toBe(paths.length);
            });
        }
    }
});
