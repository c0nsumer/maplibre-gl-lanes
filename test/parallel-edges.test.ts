/**
 * Two edges can join the same two junctions: a short link and the long way
 * round. A route that turns from one onto the other does so at both
 * junctions, and each turn needs a connector of its own. RAMBA has one such
 * pair, edges 438 and 439 between nodes 298 and 299.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type LanePath} from '../src/core/layout';

const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(g);
stabilizeLanes(g);
const sizesAt = (z: number) => {
    const width = z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

describe('parallel edges between the same two junctions', () => {
    it('are there in the fixture', () => {
        const a = g.edges[438], b = g.edges[439];
        expect(new Set([a.a, a.b])).toEqual(new Set([b.a, b.b]));
        expect(a.a).not.toBe(a.b);
    });

    for (const z of [13, 15, 17]) {
        it(`join every turn between two drawn lanes with a connector of its own at z${z}`, () => {
            const layout = layoutAtZoom(g, z, sizesAt);
            // No path stands in for another: each is emitted once.
            expect(new Set(layout.paths).size).toBe(layout.paths.length);
            const lanes = new Map<string, LanePath>();
            for (const p of layout.paths) if (p.kind === 'lane') lanes.set(`${p.edge}:${p.route}`, p);
            const connectors = layout.paths.filter((p) => p.kind === 'connector');
            const merged = new Set(layout.mergedEdges);
            const endOf = (p: LanePath, end: 'a' | 'b') => (end === 'a' ? [p.coords[0], p.coords[1]] : [p.coords[p.coords.length - 2], p.coords[p.coords.length - 1]]);
            const touches = (c: LanePath, e: number[]) => {
                const n = c.coords.length;
                return Math.hypot(c.coords[0] - e[0], c.coords[1] - e[1]) < 0.01 || Math.hypot(c.coords[n - 2] - e[0], c.coords[n - 1] - e[1]) < 0.01;
            };
            const unjoined: string[] = [];
            let turns = 0;
            for (const node of g.nodes) {
                for (const t of node.transitions) {
                    if (t.from < 0 || t.to < 0) continue;
                    const pu = node.ports[t.from], pv = node.ports[t.to];
                    if (merged.has(pu.edge) || merged.has(pv.edge)) continue;
                    const a = lanes.get(`${pu.edge}:${t.route}`), b = lanes.get(`${pv.edge}:${t.route}`);
                    if (!a || !b) continue;
                    const ea = endOf(a, pu.end), eb = endOf(b, pv.end);
                    // Lanes that already meet need nothing between them.
                    if (Math.hypot(ea[0] - eb[0], ea[1] - eb[1]) < 0.5) continue;
                    turns++;
                    if (!connectors.some((c) => c.route === t.route && touches(c, ea) && touches(c, eb))) unjoined.push(`node ${node.id}: e${pu.edge} to e${pv.edge}`);
                }
            }
            expect(turns).toBeGreaterThan(100);
            expect(unjoined).toEqual([]);
        });
    }
});
