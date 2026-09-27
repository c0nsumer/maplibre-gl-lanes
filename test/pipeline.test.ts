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
        console.log(`nodes=${g.nodes.length} (junction-degree!=2: ${junctions}) edges=${g.edges.length} routes=${g.routes.size} maxLanes=${maxLanes}`);
        const chains = [...g.chains.values()].map((c) => c.length);
        console.log('chains per route', chains.join(','), 'closed:', [...g.chains.values()].map((cs) => cs.map((c) => c.closed ? 'C' : 'o').join('')).join(' '));
        expect(g.edges.length).toBeGreaterThan(10);
        expect(maxLanes).toBe(6);
        for (const e of g.edges) expect(e.coords.length).toBeGreaterThanOrEqual(4);
    });

    it('orders lanes with a low crossing cost', () => {
        const orderer = new LaneOrderer(g);
        for (const e of g.edges) e.order = e.routes.slice().sort();
        const initial = orderer.totalCost();
        const t0 = performance.now();
        const cost = orderer.solve();
        console.log(`order cost: initial=${initial} final=${cost} in ${(performance.now() - t0).toFixed(1)}ms`);
        expect(cost).toBeLessThan(initial);
        for (const e of g.edges) expect(e.order.length).toBe(e.routes.length);
    });

    it('lays out and tessellates at several zooms', () => {
        orderLanes(g);
        for (const z of [12, 14, 16, 18]) {
            const t0 = performance.now();
            const layout = layoutAtZoom(g, z, () => ({spacing: 8, width: 6, casingWidth: 1}));
            const n0 = g.nodes[Math.floor(g.nodes.length / 2)];
            const culled = layoutAtZoom(g, z, () => ({spacing: 8, width: 6, casingWidth: 1}), {bounds: {minX: n0.x - 2e-5, minY: n0.y - 2e-5, maxX: n0.x + 2e-5, maxY: n0.y + 2e-5}});
            console.log(`z${z} culled: ${culled.stats.edgesBuilt}/${culled.stats.edges} edges, ${culled.paths.length} paths, ${culled.stats.ms.toFixed(1)}ms`);
            const mesh = tessellate(layout.paths, {scale: layout.scale, origin: [0.25, 0.35]});
            console.log(`z${z}: paths=${layout.paths.length} vertices=${layout.stats.vertices} mesh v=${mesh.vertexCount} i=${mesh.indexCount} layout ${layout.stats.ms.toFixed(1)}ms total ${(performance.now() - t0).toFixed(1)}ms`);
            expect(mesh.indexCount).toBeGreaterThan(0);
            let bad = 0;
            for (let i = 0; i < mesh.vertices.length; i++) if (!Number.isFinite(mesh.vertices[i])) bad++;
            expect(bad).toBe(0);
        }
    }, 30000);
});
