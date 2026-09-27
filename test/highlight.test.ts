/**
 * The highlight lifts one route or several, and its widths can follow the
 * zoom. The drawing itself is shaders, so what is checked here is what the
 * layer asks the context to do: which mesh groups are drawn, in which
 * order, and with which outset.
 */
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(graph);
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Records every draw call with the uniforms that were set for it. */
function recordingGl() {
    const draws: {outset: number; opacity: number; first: number}[] = [];
    const uniforms: Record<string, number> = {};
    const names = new Map<object, string>();
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
                uniforms[names.get(loc) ?? '?'] = v;
            };
            if (name === 'drawElements') return (_m: number, _c: number, _t: number, offset: number) => {
                draws.push({outset: uniforms.u_outset, opacity: uniforms.u_opacity, first: offset / 4});
            };
            return () => ({});
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, draws};
}

const args = {
    shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0, clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

function mapStub(zoom: number) {
    return {
        getTerrain: () => null, getZoom: () => zoom, getPixelRatio: () => 1, triggerRepaint: () => {},
        getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
        unproject: () => ({lng: 0, lat: 0}),
    };
}

/** A layer with its mesh already built, so render draws rather than waits. */
function drawn(zoom: number, highlight: string | string[] | null, style2 = {}) {
    const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
    const {gl, draws} = recordingGl();
    layer.onAdd(mapStub(zoom), gl);
    if (highlight !== null) layer.setHighlight(highlight, style2);
    layer.render(gl, args);
    return {layer, draws};
}

describe('setHighlight', () => {
    it('takes one route or a list, and reports what is lit', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        expect(layer.getHighlight()).toEqual([]);
        layer.setHighlight('a');
        expect(layer.getHighlight()).toEqual(['a']);
        layer.setHighlight(['a', 'b', 'c']);
        expect(layer.getHighlight()).toEqual(['a', 'b', 'c']);
        layer.setHighlight(null);
        expect(layer.getHighlight()).toEqual([]);
        layer.setHighlight([]);
        expect(layer.getHighlight()).toEqual([]);
        // The caller's array is copied, in both directions.
        const routes = ['a'];
        layer.setHighlight(routes);
        routes.push('b');
        expect(layer.getHighlight()).toEqual(['a']);
        layer.getHighlight().push('z');
        expect(layer.getHighlight()).toEqual(['a']);
    });

    it('dims the rest and lifts every highlighted route', () => {
        const routes = [...graph.routes.keys()].slice(0, 3);
        const {draws} = drawn(16, routes, {dim: 0.5});
        const dimmed = draws.filter((d) => d.opacity === 0.5);
        const lit = draws.filter((d) => d.opacity === 1);
        expect(dimmed.length).toBeGreaterThan(0);
        expect(lit.length).toBeGreaterThan(0);
        // Every lit draw comes after every dimmed one: the highlight is on top.
        const lastDimmed = draws.map((d) => d.opacity).lastIndexOf(0.5);
        expect(draws.findIndex((d) => d.opacity === 1)).toBeGreaterThan(lastDimmed);
        // Three halos, then three outlines, then the lanes: a halo drawn per
        // route in turn would wash over the lane of the route beside it.
        const outsets = lit.map((d) => d.outset);
        const halo = Math.max(...outsets);
        const outline = Math.max(...outsets.filter((o) => o < halo));
        expect(outsets.slice(0, 3)).toEqual([halo, halo, halo]);
        expect(outsets.slice(3, 6)).toEqual([outline, outline, outline]);
    });

    it('reaches as far as the documented formula says', () => {
        // What HighlightStyle.haloWidth promises: a caller compares this
        // with the lane pitch to know whether a halo covers its neighbors.
        const routes = [...graph.routes.keys()].slice(0, 1);
        const {draws} = drawn(16, routes, {haloWidth: 5, outlineWidth: 2});
        const {width, casingWidth: casing} = style();
        const lit = draws.filter((d) => d.opacity === 1);
        const aa = 0.5;
        expect(Math.max(...lit.map((d) => d.outset))).toBeCloseTo(width / 2 + casing + 2 + 5 + aa, 5);
        // The outline's width counts toward the halo's reach even when no
        // outline is drawn, so the reach does not move when one is turned off.
        const bare = drawn(16, routes, {haloWidth: 5, outlineWidth: 2, outline: null}).draws.filter((d) => d.opacity === 1);
        expect(Math.max(...bare.map((d) => d.outset))).toBeCloseTo(width / 2 + casing + 2 + 5 + aa, 5);
    });

    it('takes its widths from the zoom when given a callback', () => {
        const routes = [...graph.routes.keys()].slice(0, 1);
        const flat = drawn(16, routes, {haloWidth: 4}).draws;
        const near = drawn(16, routes, {haloWidth: (z: number) => z}).draws;
        const far = drawn(12, routes, {haloWidth: (z: number) => z}).draws;
        const widest = (ds: {outset: number}[]) => Math.max(...ds.map((d) => d.outset));
        expect(widest(near)).toBeCloseTo(widest(flat) + 12, 5);
        expect(widest(near) - widest(far)).toBeCloseTo(4, 5);
    });
});

describe('a program that fails to build', () => {
    it('logs once and draws nothing, rather than throwing every frame', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const {gl, draws} = recordingGl();
        const broken = new Proxy(gl, {get: (t, name: string) => (name === 'getShaderParameter' ? () => false : Reflect.get(t, name))});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        layer.onAdd(mapStub(14), broken);
        expect(() => layer.render(broken, args)).not.toThrow();
        expect(() => layer.render(broken, args)).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
        expect(draws).toEqual([]);
        error.mockRestore();
    });
});
