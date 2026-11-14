/**
 * On one-way paths a route enters a node by one leg and leaves by another, so
 * the junction must not join two legs that both flow out of it (or both in),
 * even where that pair is the straighter one.
 */
import {describe, it, expect} from 'vitest';
import type {Feature} from 'geojson';
import {buildLineGraph, filterGraph, type LineGraph} from '../src/core/graph';

const line = (route: string, coords: [number, number][], oneway: string): Feature => ({
    type: 'Feature',
    properties: {route, oneway},
    geometry: {type: 'LineString', coordinates: coords},
});

// The pairs of legs the route joins at the node at the origin, each leg named by its direction.
function joins(g: LineGraph, route: string, legs: Record<string, [number, number]>): string[] {
    const n = g.nodes.find((v) => Math.hypot(v.x - 0.5, v.y - 0.5) < 1e-9)!;
    const legOf = (port: number) => {
        const {edge, end} = n.ports[port];
        const c = g.edges[edge].coords;
        const [x, y] = end === 'a' ? [c[2], c[3]] : [c[c.length - 4], c[c.length - 3]];
        // Mercator y grows southward, latitude northward.
        const dx = x - n.x, dy = n.y - y;
        let best = '', bestCos = -Infinity;
        for (const [name, [lng, lat]] of Object.entries(legs)) {
            const cos = (dx * lng + dy * lat) / (Math.hypot(dx, dy) * Math.hypot(lng, lat));
            if (cos > bestCos) {
                bestCos = cos;
                best = name;
            }
        }
        return best;
    };
    return n.transitions.filter((t) => t.route === route).map((t) => [legOf(t.from), legOf(t.to)].sort().join('-')).sort();
}

describe('one-way flow at a node', () => {
    // Lap one rides east to west through the T, a later lap turns north. All three legs are
    // one-way along the route. The north leg leans east, so by straightness alone its chain
    // end would join the west leg: two legs that both flow out of the node.
    const legs: Record<string, [number, number]> = {east: [0.01, 0], west: [-0.01, 0], north: [0.003, 0.01]};
    const tee = [
        line('R', [legs.east, [0, 0], legs.west], 'yes'),
        line('R', [legs.east, [0, 0], legs.north], 'yes'),
    ];

    it('joins by straightness alone without the option', () => {
        const g = buildLineGraph(tee);
        expect(joins(g, 'R', legs)).toEqual(['east-west', 'north-west']);
    });

    it('joins the leg flowing out to the one flowing in with the option', () => {
        const g = buildLineGraph(tee, {onewayProperty: 'oneway'});
        expect(joins(g, 'R', legs)).toEqual(['east-north', 'east-west']);
        expect(g.edges.every((e) => e.oneway)).toBe(true);
        // The option alone does not add the property to the edges.
        expect(g.edges.every((e) => e.properties === undefined)).toBe(true);
    });

    it('keeps the rule through filterGraph', () => {
        const g = buildLineGraph([...tee, line('S', [legs.west, [0, 0]], 'yes')], {onewayProperty: 'oneway'});
        const f = filterGraph(g, (r) => r === 'R');
        expect(joins(f, 'R', legs)).toEqual(['east-north', 'east-west']);
    });

    it('does not count reversible or no as one-way', () => {
        for (const v of ['reversible', 'no', '']) {
            const g = buildLineGraph(tee.map((f) => ({...f, properties: {...f.properties, oneway: v}})), {onewayProperty: 'oneway'});
            expect(joins(g, 'R', legs)).toEqual(['east-west', 'north-west']);
        }
    });

    it('does not ride straight on from one leg flowing in to another', () => {
        // A crossing where east and west flow in, north and south out. Straight on is in to in.
        const x: Record<string, [number, number]> = {east: [0.01, 0], west: [-0.01, 0], north: [0, 0.01], south: [0, -0.01]};
        const fs = [line('R', [x.east, [0, 0], x.south], 'yes'), line('R', [x.west, [0, 0], x.north], 'yes')];
        expect(joins(buildLineGraph(fs), 'R', x)).toEqual(['east-west', 'north-south']);
        const after = joins(buildLineGraph(fs, {onewayProperty: 'oneway'}), 'R', x);
        expect(after).toHaveLength(2);
        for (const pair of after) expect(pair.split('-').filter((l) => l === 'east' || l === 'west')).toHaveLength(1);
    });

    it('still joins two one-way paths that meet head on', () => {
        // Both legs flow into the node and the route has no other way out of it. A second
        // route on the west leg makes the node a junction.
        const hl: Record<string, [number, number]> = {east: [0.01, 0], west: [-0.01, 0], south: [0, -0.01]};
        const fs = [
            line('R', [hl.east, [0, 0]], 'yes'),
            line('R', [hl.west, [0, 0]], 'yes'),
            line('S', [hl.west, [0, 0], hl.south], 'no'),
        ];
        const before = joins(buildLineGraph(fs), 'R', hl);
        const after = joins(buildLineGraph(fs, {onewayProperty: 'oneway'}), 'R', hl);
        expect(before).toEqual(['east-west']);
        expect(after).toEqual(before);
    });
});
