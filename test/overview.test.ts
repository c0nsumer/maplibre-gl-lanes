/**
 * Every route draws at every zoom. At overview zooms most edges merge into
 * their junctions, and a route is then drawn on pieces that follow the
 * merged edges. Three cases used to draw nothing: a route whose every edge
 * merged had no drawn edge to start from; a chain joined to a merged edge
 * at the end a walk entered it by was never reached, because the walk only
 * followed the transitions at the far end of each edge; and a walk that
 * came back onto an edge it had crossed, a loop inside the junction,
 * dropped the whole loop. RAMBA route 8468010 flickered in and out
 * between z9.25 and z10, and MFO route -68 lost a 140 px loop at z10.5.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom} from '../src/core/layout';
import {polylineLength} from '../src/core/geometry';

const sizesAt = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

function line(route: string, coords: number[][]): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}

describe('every route draws at every overview zoom', () => {
    for (const fixture of ['ramba', 'mfo', 'example']) {
        it(`on ${fixture}, from z8 to z13 in steps of an eighth`, () => {
            const fc = JSON.parse(readFileSync(new URL(`./fixtures/${fixture}.src.geojson`, import.meta.url), 'utf8'));
            const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
            orderLanes(g, {seed: 1});
            stabilizeLanes(g);
            const lengthOf = new Map<string, number>();
            for (const e of g.edges) for (const r of e.routes) lengthOf.set(r, (lengthOf.get(r) ?? 0) + polylineLength(e.coords));
            const missing: string[] = [];
            for (let z = 8; z <= 13; z += 1 / 8) {
                const layout = layoutAtZoom(g, z, sizesAt);
                const drawn = new Map<string, number>();
                for (const p of layout.paths) drawn.set(p.route, (drawn.get(p.route) ?? 0) + polylineLength(p.coords));
                for (const [r, len] of lengthOf) {
                    // A route under a pixel long at this zoom may well draw nothing.
                    if (len * layout.scale < 1) continue;
                    if ((drawn.get(r) ?? 0) < 1) missing.push(`route ${r} at z${z}`);
                }
            }
            expect(missing).toEqual([]);
        });
    }
});

describe('a route whose every edge merges into one junction', () => {
    // Loop trail A is a triangle with 2 m sides. Trail B runs along its base and on for a
    // kilometer each way. At z16 a side is a few pixels, under the lane spacing, so every edge
    // of A merges into one junction, which B crosses on a connector.
    const m = 0.00002;
    const g = buildLineGraph([
        line('A', [[0, 0], [m, 0], [m / 2, m], [0, 0]]),
        line('B', [[-0.01, 0], [0, 0], [m, 0], [0.01, 0]]),
    ]);
    orderLanes(g);

    it('is drawn as one piece that follows the merged edges', () => {
        const layout = layoutAtZoom(g, 16, () => ({spacing: 8, width: 6, casingWidth: 1}));
        const edgesOfA = g.edges.filter((e) => e.routes.includes('A'));
        expect(edgesOfA.length).toBeGreaterThan(1);
        for (const e of edgesOfA) expect(layout.mergedEdges).toContain(e.id);
        let drawn = 0;
        for (const p of layout.paths) if (p.route === 'A') drawn += polylineLength(p.coords);
        let length = 0;
        for (const e of edgesOfA) length += polylineLength(e.coords) * layout.scale;
        expect(drawn).toBeGreaterThan(0.8 * length);
    });
});
