/**
 * A dotted look, `dash: [0, gap]`, is drawn from one quad per dot. A dot
 * worked out in the fragment shader from the distance along the ribbon and
 * across it is only a disc where the ribbon is straight; at a bend it came
 * out as a wedge or half a disc. What is checked here is the geometry the
 * tessellator hands over, and that the layer draws it with no pattern set.
 */
import {describe, it, expect} from 'vitest';
import {tessellate, FLOATS_PER_VERTEX, type Mesh} from '../src/render/tessellate';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import type {LaneLook, LanePath} from '../src/core/layout';

const dotted: LaneLook = {color: '#808080', dash: [0, 2], dashCap: 'round'};
const opts = {scale: 1, origin: [0, 0] as [number, number], width: 5};

function path(coords: number[], startDistance: number, look = dotted): LanePath {
    return {route: 'r', look, coords, anchors: coords.slice(), kind: 'lane', travel: 0, startDistance, edge: 0};
}

/** Centers of the dot quads of group `gi`, from the mesh alone: anchor plus delta of each quad's first vertex. */
function dotCenters(mesh: Mesh, gi = 0): [number, number][] {
    const [first, count] = mesh.groupDots[gi];
    const out: [number, number][] = [];
    for (let k = first; k < first + count; k += 6) {
        const o = mesh.indices[k] * FLOATS_PER_VERTEX;
        out.push([mesh.vertices[o] + mesh.vertices[o + 2], mesh.vertices[o + 1] + mesh.vertices[o + 3]]);
    }
    return out;
}

describe('dots as geometry', () => {
    it('puts a dot every gap lane widths, half a period in, as the shader did', () => {
        const mesh = tessellate([path([0, 0, 100, 0], 0)], opts);
        // Period 2 x 5 px: centers at 5, 15, ... 95.
        expect(dotCenters(mesh).map(([x]) => x)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
        expect(mesh.groupDots[0][1]).toBe(10 * 6);
        // The ribbon is still there, for a color between the dots and for the highlight.
        expect(mesh.groups[0][1]).toBeGreaterThan(0);
        expect(mesh.groupDots[0][0]).toBe(mesh.groups[0][0] + mesh.groups[0][1]);
    });

    it('makes each dot a square of normals, so the shader reads the distance from its center', () => {
        const mesh = tessellate([path([0, 0, 100, 0], 0)], opts);
        const [first] = mesh.groupDots[0];
        const corners = new Set<string>();
        for (let k = first; k < first + 6; k++) {
            const o = mesh.indices[k] * FLOATS_PER_VERTEX;
            // Extrude and normal agree, one unit along each axis.
            expect([mesh.vertices[o + 4], mesh.vertices[o + 5]]).toEqual([mesh.vertices[o + 6], mesh.vertices[o + 7]]);
            corners.add(`${mesh.vertices[o + 4]},${mesh.vertices[o + 5]}`);
        }
        expect([...corners].sort()).toEqual(['-1,-1', '-1,1', '1,-1', '1,1']);
    });

    it('keeps round a bend, where each dot sits on the path itself', () => {
        // A hairpin tighter than a dot is wide.
        const bend = [0, 0, 50, 0, 52, 2, 50, 4, 0, 4];
        const centers = dotCenters(tessellate([path(bend, 0)], opts));
        expect(centers.length).toBeGreaterThanOrEqual(10);
        for (const [x, y] of centers) {
            const onPath = (Math.abs(y) < 1e-4 && x <= 50) || (Math.abs(y - 4) < 1e-4 && x <= 50) || (x >= 50 && x <= 52.01);
            expect(onPath).toBe(true);
        }
    });

    it('hands the rhythm from one piece of a route to the next, and along a piece traveled backward', () => {
        // 0 to 37 px, then 37 to 100: one dot each 10 px straight through the joint.
        const mesh = tessellate([path([0, 0, 37, 0], 0), path([37, 0, 100, 0], 37)], opts);
        expect(dotCenters(mesh).map(([x]) => x).sort((a, b) => a - b)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
        // The same second piece drawn from its far end: the route runs 37 to 100 from x = 100 back to x = 37.
        const back = tessellate([path([0, 0, 37, 0], 0), path([100, 0, 37, 0], -100)], opts);
        expect(dotCenters(back).map(([x]) => Math.round(x * 1e6) / 1e6).sort((a, b) => a - b)).toEqual([5, 15, 25, 35, 45, 55, 65, 75, 85, 95]);
    });

    it('draws a dot on a joint once', () => {
        const mesh = tessellate([path([0, 0, 35, 0], 0), path([35, 0, 70, 0], 35)], opts);
        expect(dotCenters(mesh).map(([x]) => x).sort((a, b) => a - b)).toEqual([5, 15, 25, 35, 45, 55, 65]);
    });

    it('has none for a dash, or when it is not told the lane width', () => {
        expect(tessellate([path([0, 0, 100, 0], 0, {color: '#808080', dash: [2, 2]})], opts).groupDots).toEqual([[expect.any(Number), 0]]);
        expect(tessellate([path([0, 0, 100, 0], 0)], {scale: 1, origin: [0, 0]}).groupDots).toEqual([[expect.any(Number), 0]]);
    });
});

describe('the layer', () => {
    it('draws dots from their quads with no pattern set, casing and fill alike', () => {
        const fc = {type: 'FeatureCollection', features: [{type: 'Feature', properties: {route_id: 'd'}, geometry: {type: 'LineString', coordinates: [[0, 0], [0.002, 0], [0.002, 0.002]]}}]};
        const graph = buildLineGraph(fc.features as never, {routeProperty: 'route_id', routes: {d: {dash: [0, 2], dashCap: 'round'}}});
        orderLanes(graph);
        const draws: {dash: [number, number]; first: number; count: number}[] = [];
        const names = new Map<object, string>();
        let dash: [number, number] = [0, 0];
        const gl = new Proxy({}, {
            get: (_, name: string) => {
                if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
                if (name === 'getAttribLocation') return () => 0;
                if (name === 'getUniformLocation') return (_p: unknown, u: string) => {
                    const key = {};
                    names.set(key, u);
                    return key;
                };
                if (name === 'uniform2f') return (loc: object, x: number, y: number) => {
                    if (names.get(loc) === 'u_dash') dash = [x, y];
                };
                if (name === 'drawElements') return (_m: number, count: number, _t: number, offset: number) => {
                    draws.push({dash, first: offset / 4, count});
                };
                return () => ({});
            },
        }) as unknown as WebGL2RenderingContext;
        const layer = new LaneLayer({id: 'lanes', graph, sizes: () => ({spacing: 7, width: 6, casingWidth: 1}), worker: false});
        layer.onAdd({
            getTerrain: () => null, getZoom: () => 16, getPixelRatio: () => 1, triggerRepaint: () => {},
            getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
            unproject: () => ({lng: 0, lat: 0}),
        }, gl);
        layer.render(gl, {
            shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
            getProjectionData: () => ({mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16), tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1], projectionTransition: 0, clipAntimeridian: false}),
        } as unknown as LaneRenderArgs);
        // Casing, then fill: the same range of quads both times, and whole quads.
        expect(draws).toHaveLength(2);
        expect(draws[0]).toEqual(draws[1]);
        expect(draws[0].dash).toEqual([0, 0]);
        expect(draws[0].count % 6).toBe(0);
        expect(draws[0].first).toBeGreaterThan(0);
    });
});
