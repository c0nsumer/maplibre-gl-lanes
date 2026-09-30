import {describe, it, expect} from 'vitest';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import type {Feature} from 'geojson';

function line(route: string, coords: number[][]): Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}
const sizes = () => ({spacing: 6, width: 5, casingWidth: 1});

/** How many routes are drawn between two lanes of a group they cross. */
function woven(order: string[], group: string[], across: string[]): number {
    const at = group.map((r) => order.indexOf(r));
    const lo = Math.min(...at), hi = Math.max(...at);
    return across.filter((r) => order.indexOf(r) > lo && order.indexOf(r) < hi).length;
}

describe('drawing order', () => {
    it('draws a route that crosses a group above all of it or below all of it', () => {
        // A, C and E run west to east together. B crosses them at a four-way node, and by id
        // alone it would be drawn between A and C.
        const west = [[-0.002, 0], [0, 0]];
        const east = [[0, 0], [0.002, 0]];
        const g = buildLineGraph([
            ...['A', 'C', 'E'].flatMap((r) => [line(r, west), line(r, east)]),
            line('B', [[0, -0.002], [0, 0]]),
            line('B', [[0, 0], [0, 0.002]]),
        ]);
        orderLanes(g);
        const order = layoutAtZoom(g, 16, sizes).drawOrder;
        expect(order.slice().sort()).toEqual(['A', 'B', 'C', 'E']);
        expect(woven(order, ['A', 'C', 'E'], ['B'])).toBe(0);
    });

    it('leaves the order alone where no route crosses a group', () => {
        const g = buildLineGraph([
            line('B', [[-0.002, 0], [0, 0], [0.002, 0]]),
            line('A', [[-0.002, 0], [0, 0], [0.002, 0]]),
            line('C', [[0, -0.002], [0, -0.001]]),
        ]);
        orderLanes(g);
        expect(layoutAtZoom(g, 16, sizes).drawOrder).toEqual(['A', 'B', 'C']);
    });
});
