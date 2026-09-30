import {expect, it} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {LaneOrderer} from '../src/core/order';

it('every route of RAMBA has a chain, and the node costs add up to the solve', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const feats = fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id)));
    const g = buildLineGraph(feats, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
    for (const rid of g.routes.keys()) expect(g.chains.get(rid)?.length ?? 0).toBeGreaterThan(0);
    const o = new LaneOrderer(g);
    const cost = o.solve();
    // The solve reports the same total the per-node readout does, so a diagnostic can trust either.
    let sum = 0;
    for (const n of g.nodes) sum += o.nodeCost(n.id);
    expect(sum).toBeCloseTo(cost, 9);
});

it('stable lanes reduce lateral movement', async () => {
    const {stabilizeLanes, lateralMovement} = await import('../src/core/baselines');
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const feats = fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id)));
    const g = buildLineGraph(feats, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
    new LaneOrderer(g).solve();
    const before = lateralMovement(g);
    stabilizeLanes(g);
    const after = lateralMovement(g);
    expect(after).toBeLessThan(before);
});
