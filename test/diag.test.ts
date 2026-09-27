import {it} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {LaneOrderer} from '../src/core/order';

it('RAMBA diagnostics', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const feats = fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id)));
    const g = buildLineGraph(feats, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
    for (const [rid, chains] of g.chains) {
        const name = g.routes.get(rid)?.name;
        console.log(`route ${rid} ${name}: ${chains.length} chains: ${chains.map((c) => `${c.steps.length}${c.closed ? 'C' : 'o'}`).join(' ')}`);
    }
    const o = new LaneOrderer(g);
    const cost = o.solve();
    const nodeCosts = g.nodes.map((n) => ({n, c: o.nodeCost(n.id)})).filter((x) => x.c > 0).sort((a, b) => b.c - a.c);
    console.log(`total ${cost}; nodes with cost: ${nodeCosts.length}`);
    for (const {n, c} of nodeCosts.slice(0, 12)) {
        const desc = n.ports.map((p) => {
            const e = g.edges[p.edge];
            return `e${e.id}${p.end}[${e.order.map((r) => g.routes.get(r)?.name?.split(' ')[0]).join(',')}]`;
        }).join(' ');
        const lngLat = [n.x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * n.y))) * 180) / Math.PI];
        console.log(`  cost ${c} at ${lngLat[1].toFixed(5)},${lngLat[0].toFixed(5)} ports=${n.ports.length}: ${desc}`);
    }
});

it('stable lanes reduce lateral movement', async () => {
    const {stabilizeLanes, lateralMovement} = await import('../src/core/baselines');
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const feats = fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id)));
    const g = buildLineGraph(feats, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
    new LaneOrderer(g).solve();
    const before = lateralMovement(g);
    const t0 = performance.now();
    stabilizeLanes(g);
    const after = lateralMovement(g);
    console.log(`lateral movement: centered ${before.toFixed(1)} lanes -> stabilized ${after.toFixed(1)} lanes (${(performance.now() - t0).toFixed(1)} ms)`);
});
