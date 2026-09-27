import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {toTransfer, fromTransfer} from '../src/core/serialize';
import {handleOrderRequest} from '../src/worker/lanes.worker';
import {orderLanesAsync} from '../src/core/order-async';

describe('worker ordering', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});

    it('round-trips a graph through the transfer form', () => {
        const t = toTransfer(g);
        const g2 = fromTransfer(structuredClone(t));
        expect(g2.edges.length).toBe(g.edges.length);
        expect(g2.nodes[0].transitions).toEqual(g.nodes[0].transitions);
    });

    it('worker handler and sync path agree', async () => {
        const res = handleOrderRequest({id: 1, graph: structuredClone(toTransfer(g))});
        const cost = await orderLanesAsync(g, {sync: true});
        expect(res.cost).toBe(cost);
        expect(res.orders).toEqual(g.edges.map((e) => e.order));
    });
});
