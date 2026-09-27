/**
 * Dash phase across a tail: a route that starts or ends inside a merged
 * junction is drawn there as one sliding piece, and the dash walk has to
 * hand that piece the distance where its cut-back lane left off.
 */
import {describe, it, expect} from 'vitest';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom, type LanePath} from '../src/core/layout';
import {polylineLength} from '../src/core/geometry';

function line(route: string, coords: number[][]): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** The distances a piece covers along its route's travel, from its start and its sign convention. */
function span(p: LanePath): [number, number] {
    const len = polylineLength(p.coords);
    return p.startDistance < 0 ? [-p.startDistance - len, -p.startDistance] : [p.startDistance, p.startDistance + len];
}

const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
const n2 = [0.00005, 0];

describe('dash phase across a sliding tail', () => {
    for (const side of ['end', 'start'] as const) {
        it(`is continuous at the joint of a tail that slides at its ${side}`, () => {
            // A chain starts from the lowest-numbered edge with a free end,
            // and edges are numbered as the features are read: B listed
            // first, from its end on the short edge, begins its chain there.
            const b = side === 'end' ? line('B', [...trunk, n2]) : line('B', [n2, ...[...trunk].reverse()]);
            const a = line('A', [...trunk, n2, [0.00005, -0.001]]);
            const g = buildLineGraph([...(side === 'end' ? [a, b] : [b, a]), line('C', [...trunk, [0, 0.001]])], {routes: {B: {dash: [1, 1]}}});
            orderLanes(g);
            const layout = layoutAtZoom(g, 16, style);
            const shortEdge = g.edges.find((e) => e.routes.length === 2)!;
            expect(layout.mergedEdges).toEqual([shortEdge.id]);
            const steps = g.chains.get('B')![0].steps;
            expect(steps).toHaveLength(2);
            expect(steps[side === 'end' ? 1 : 0].edge).toBe(shortEdge.id);
            const pieces = layout.paths.filter((p) => p.route === 'B');
            const lane = pieces.find((p) => p.kind === 'lane')!;
            const slide = pieces.find((p) => p.kind === 'connector')!;
            expect(pieces).toHaveLength(2);
            if (side === 'end') expect(span(slide)[0]).toBeCloseTo(span(lane)[1], 6);
            else expect(span(lane)[0]).toBeCloseTo(span(slide)[1], 6);
        });
    }
});
