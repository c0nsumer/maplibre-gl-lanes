/**
 * Dash patterns are measured in lane widths, as a MapLibre dash array is,
 * and they hold their place on the ground between rebuilds. The drawing is
 * shaders, so what is checked here is the uniforms the layer sets: the
 * period it asks for, and that the period does not move when the map zooms
 * without rebuilding.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const first = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
const [dotted, dashed] = [...first.routes.keys()];
const graph = buildLineGraph(fc.features, {
    routeProperty: 'route_id', colorProperty: 'route_colour',
    routes: {
        [dotted]: {dash: [0, 2], dashCap: 'round'},
        [dashed]: {dash: [1, 1]},
    },
});
orderLanes(graph);
/** Widths that change with the zoom, so a period from the wrong zoom shows up. */
const style = (z: number) => ({spacing: z + 2, width: z, casingWidth: 1});

function recordingGl() {
    const dashes: [number, number][] = [];
    const floats: Record<string, number> = {};
    /** One entry per draw call, with the uniforms it was made under. */
    const draws: {outset: number; dash: [number, number]; cap: number; first: number}[] = [];
    const names = new Map<object, string>();
    const now: Record<string, number> = {};
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
            if (name === 'uniform1f') return (loc: object, v: number) => {
                floats[names.get(loc) ?? '?'] = v;
                now[names.get(loc) ?? '?'] = v;
            };
            if (name === 'uniform2f') return (loc: object, x: number, y: number) => {
                if (names.get(loc) !== 'u_dash') return;
                dash = [x, y];
                if (x || y) dashes.push([x, y]);
            };
            if (name === 'drawElements') return (_m: number, _c: number, _t: number, offset: number) => {
                draws.push({outset: now.u_outset, dash, cap: now.u_cap, first: offset / 4});
            };
            return () => ({});
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, dashes, floats, draws};
}

const args = {
    shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0, clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

function mapStub(zoom: {value: number}) {
    return {
        getTerrain: () => null, getZoom: () => zoom.value, getPixelRatio: () => 1, triggerRepaint: () => {},
        getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
        unproject: () => ({lng: 0, lat: 0}),
    };
}

describe('dash patterns', () => {
    it('ask for a period of dash plus gap lane widths', () => {
        const zoom = {value: 16};
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const {gl, dashes} = recordingGl();
        layer.onAdd(mapStub(zoom), gl);
        layer.render(gl, args);
        const w = style(16).width;
        // A dashed route's period is the two together, as MapLibre reads it.
        expect(dashes).toContainEqual([1 * w, 1 * w]);
        // Dots are geometry, a quad each, so no pattern is asked for them
        // (test/dots.test.ts has their spacing).
        expect(dashes.some(([x]) => x === 0)).toBe(false);
    });

    it('hold the pattern still when the zoom moves without a rebuild', () => {
        const zoom = {value: 16};
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const {gl, dashes, floats} = recordingGl();
        layer.onAdd(mapStub(zoom), gl);
        layer.render(gl, args);
        const built = layer.getBuildInfo()!.build;
        const atBuild = [...dashes];
        expect(floats.u_along_scale).toBe(1);

        // Inside the rebuild threshold: the mesh, and the distances along it,
        // are still the ones built at z16.
        zoom.value = 16.2;
        dashes.length = 0;
        layer.render(gl, args);
        expect(layer.getBuildInfo()!.build).toBe(built);
        expect(dashes).toEqual(atBuild);
        expect(floats.u_along_scale).toBeCloseTo(Math.pow(2, 0.2), 6);
        // The lanes themselves still follow the current zoom.
        expect(floats.u_outset).toBeCloseTo(style(16.2).width / 2 + 0.5, 6);
    });

    it('give a per-edge dash its own pass, under the same route', () => {
        const zoom = {value: 16};
        // One edge dashed, the rest of the graph as its routes ask for.
        const plain = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(plain);
        const layer = new LaneLayer({
            id: 'lanes', graph: plain, sizes: style, worker: false,
            laneStyle: (e) => (e.id === 0 ? {dash: [3, 3], dashCap: 'round'} : null),
        });
        const {gl, dashes, draws} = recordingGl();
        layer.onAdd(mapStub(zoom), gl);
        layer.render(gl, args);
        const w = style(16).width;
        expect(dashes).toContainEqual([3 * w, 3 * w]);
        // The cap travels with the dash, on the pass the dash is drawn in.
        expect(draws.some((d) => d.dash[0] === 3 * w && d.cap === 1)).toBe(true);
        // A field left out keeps the route's own: these routes carry no
        // dash of their own, so nothing else on them is dashed.
        expect(dashes.filter(([x]) => x !== 3 * w)).toEqual([]);
    });

    it('lay every casing of a route down before any of its fills', () => {
        const zoom = {value: 16};
        const plain = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(plain);
        const dashed = new Set(plain.edges.slice(0, 2).map((e) => e.id));
        const layer = new LaneLayer({
            id: 'lanes', graph: plain, sizes: style, worker: false,
            laneStyle: (e) => (dashed.has(e.id) ? {dash: [1, 1]} : null),
        });
        const {gl, draws} = recordingGl();
        layer.onAdd(mapStub(zoom), gl);
        layer.render(gl, args);
        const casing = style(16).width / 2 + style(16).casingWidth + 0.5;
        // A route is more than one pass when its ways look different, and
        // a casing drawn after a neighboring fill would show as a seam
        // where the two meet. So two casing passes of one route run back to
        // back, with no fill of that route between them.
        const batched = draws.some((d, i) => {
            const next = draws[i + 1];
            return !!next && d.outset === casing && next.outset === casing && d.first !== next.first;
        });
        expect(batched).toBe(true);
        const fills = draws.filter((d) => d.outset !== casing);
        expect(fills.length).toBeGreaterThan(0);
        expect(fills.some((d) => d.dash[0] > 0)).toBe(true);
    });

    it('take the new width once a rebuild has happened', () => {
        const zoom = {value: 16};
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const {gl, dashes, floats} = recordingGl();
        layer.onAdd(mapStub(zoom), gl);
        layer.render(gl, args);
        zoom.value = 17;
        dashes.length = 0;
        layer.render(gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(17);
        expect(dashes).toContainEqual([style(17).width, style(17).width]);
        expect(floats.u_along_scale).toBe(1);
    });
});
