import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes, LaneOrderer} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {tessellate} from '../src/render/tessellate';

function load(name: string) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

describe('pipeline on RAMBA', () => {
    const fc = load('ramba.src.geojson');
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});

    it('builds a line graph', () => {
        const junctions = g.nodes.filter((n) => n.ports.length !== 2).length;
        const maxLanes = Math.max(...g.edges.map((e) => e.routes.length));
        expect(g.edges.length).toBeGreaterThan(10);
        expect(junctions).toBeGreaterThan(0);
        expect(maxLanes).toBe(6);
        // Every route gets at least one chain; a route without one would draw no lanes.
        for (const rid of g.routes.keys()) expect(g.chains.get(rid)?.length ?? 0).toBeGreaterThan(0);
        for (const e of g.edges) expect(e.coords.length).toBeGreaterThanOrEqual(4);
    });

    it('orders lanes with a low crossing cost', () => {
        const orderer = new LaneOrderer(g);
        for (const e of g.edges) e.order = e.routes.slice().sort();
        const initial = orderer.totalCost();
        const cost = orderer.solve();
        expect(cost).toBeLessThan(initial);
        for (const e of g.edges) expect(e.order.length).toBe(e.routes.length);
    });

    it('lays out and tessellates at several zooms', () => {
        orderLanes(g);
        for (const z of [12, 14, 16, 18]) {
            const layout = layoutAtZoom(g, z, () => ({spacing: 8, width: 6, casingWidth: 1}));
            const n0 = g.nodes[Math.floor(g.nodes.length / 2)];
            const culled = layoutAtZoom(g, z, () => ({spacing: 8, width: 6, casingWidth: 1}), {bounds: {minX: n0.x - 2e-5, minY: n0.y - 2e-5, maxX: n0.x + 2e-5, maxY: n0.y + 2e-5}});
            // A view around one node builds fewer edges than the whole network, and never none.
            expect(culled.stats.edgesBuilt).toBeGreaterThan(0);
            expect(culled.stats.edgesBuilt).toBeLessThan(layout.stats.edgesBuilt);
            const mesh = tessellate(layout.paths, {scale: layout.scale, origin: [0.25, 0.35]});
            expect(mesh.indexCount).toBeGreaterThan(0);
            let bad = 0;
            for (let i = 0; i < mesh.vertices.length; i++) if (!Number.isFinite(mesh.vertices[i])) bad++;
            expect(bad).toBe(0);
        }
    }, 30000);
});
