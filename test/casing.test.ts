/**
 * A translucent casing is blended once per pixel, with a mark kept in the
 * depth buffer (see `DEPTH_MARK` in the layer). The drawing itself is
 * shaders, so what is checked here is what the layer asks of the context:
 * that every colored draw keeps MapLibre's depth test at the layer's depth,
 * so an opaque fill above covers it, that a translucent casing gets the
 * passes that make the mark work in the gap behind that depth, that a
 * translucent fill paints each pixel once the same way, and that the
 * stencil buffer, which holds MapLibre's tile clipping masks, is never
 * written.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(graph);
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

const GL = {DEPTH_BITS: 0x0d56, DEPTH_RANGE: 0x0b70, DEPTH_TEST: 0x0b71, STENCIL_TEST: 0x0b90, LESS: 0x0201, LEQUAL: 0x0203, ALWAYS: 0x0207};
/** What MapLibre gives the first of 14-sublayer layers, and the gap behind it to the layer below. */
const LAYER = 1 - 14 / 65536, GAP = 1 / 65536;
const inGap = (d: number) => d > LAYER && d < LAYER + GAP;

interface Call {name: string; args: unknown[]}
interface Draw {outset: number; cover: number; depthFunc: number; depthMask: boolean; depthRange: number; color: boolean; depthTest: boolean}

/** Records every call, and every draw with the state it was made under. */
function recordingGl(depthBits: number) {
    const calls: Call[] = [];
    const draws: Draw[] = [];
    const names = new Map<object, string>();
    // MapLibre's read-only depth mode for a 2D custom layer.
    const now = {outset: 0, cover: 0, depthFunc: GL.LEQUAL, depthMask: false, depthRange: LAYER, color: true, depthTest: true};
    const gl = new Proxy(GL as Record<string, unknown>, {
        get: (target, name: string) => {
            if (name in target) return target[name];
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return () => 0;
            if (name === 'getParameter') return (p: number) => (p === GL.DEPTH_BITS ? depthBits : p === GL.DEPTH_RANGE ? new Float32Array([LAYER, LAYER]) : null);
            if (name === 'getUniformLocation') return (_p: unknown, u: string) => {
                const key = {};
                names.set(key, u);
                return key;
            };
            return (...args: unknown[]) => {
                calls.push({name, args});
                if (name === 'uniform1f' && names.get(args[0] as object) === 'u_outset') now.outset = args[1] as number;
                if (name === 'uniform1f' && names.get(args[0] as object) === 'u_cover') now.cover = args[1] as number;
                if (name === 'depthFunc') now.depthFunc = args[0] as number;
                if (name === 'depthMask') now.depthMask = args[0] as boolean;
                if (name === 'depthRange') now.depthRange = args[0] as number;
                if (name === 'colorMask') now.color = args[0] as boolean;
                if (name === 'enable' && args[0] === GL.DEPTH_TEST) now.depthTest = true;
                if (name === 'disable' && args[0] === GL.DEPTH_TEST) now.depthTest = false;
                if (name === 'drawElements') draws.push({...now});
                return {};
            };
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, calls, draws, now};
}

const args = {
    shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0, clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

const mapStub = {
    getTerrain: () => null, getZoom: () => 16, getPixelRatio: () => 1, triggerRepaint: () => {},
    getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
    unproject: () => ({lng: 0, lat: 0}),
};

function drawn(opts: {casingColor?: string | null; opacity?: number}, depthBits = 24) {
    const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false, ...opts});
    const rec = recordingGl(depthBits);
    layer.onAdd(mapStub, rec.gl);
    layer.render(rec.gl, args);
    return rec;
}

const CASING = 6 / 2 + 1 + 0.5, FILL = 6 / 2 + 0.5;
const writesDepth = (c: Call) => (c.name === 'depthMask' && c.args[0] === true) || c.name === 'colorMask';
/** Tested at the layer's depth, without writing it: an opaque fill above covers it. */
const underLayersAbove = {depthTest: true, depthFunc: GL.LEQUAL, depthMask: false, depthRange: LAYER, color: true};

describe('an opaque casing', () => {
    it('is drawn as it always was: one casing draw and one fill draw a group, tested at the layer depth', () => {
        const {calls, draws} = drawn({casingColor: '#333'});
        expect(calls.filter(writesDepth)).toEqual([]);
        for (const d of draws) expect(d).toMatchObject(underLayersAbove);
        expect(draws.length).toBeGreaterThan(0);
        expect(draws.filter((d) => d.outset === CASING)).toHaveLength(draws.length / 2);
        expect(draws.filter((d) => d.outset === FILL)).toHaveLength(draws.length / 2);
        expect(draws.every((d) => d.cover === 0)).toBe(true);
    });
});

describe('a translucent casing', () => {
    const {calls, draws, now} = drawn({casingColor: 'rgba(255, 255, 255, 0.3)'});
    const groups = drawn({casingColor: '#333'}).draws.length / 2;

    it('claims its pixels first, without color, except where a layer above is nearer', () => {
        expect(draws[0]).toMatchObject({outset: CASING, depthFunc: GL.LEQUAL, depthMask: true, color: false, depthTest: true});
        expect(inGap(draws[0].depthRange)).toBe(true);
    });

    it('tests every colored draw against the layers above', () => {
        for (const d of draws.filter((x) => x.color)) {
            expect(d.depthTest).toBe(true);
            expect([GL.LEQUAL, GL.LESS]).toContain(d.depthFunc);
            expect(d.depthRange).toBeGreaterThanOrEqual(LAYER);
        }
    });

    it('writes depth only in the gap behind the layer', () => {
        for (const d of draws.filter((x) => x.depthMask)) expect(inGap(d.depthRange)).toBe(true);
    });

    it('draws each casing twice: fragments that cover their pixel test and set the mark, the rest only test it', () => {
        const casings = draws.slice(1).filter((d) => d.outset === CASING);
        expect(casings).toHaveLength(2 * groups);
        for (let i = 0; i < casings.length; i += 2) {
            expect(casings[i]).toMatchObject({cover: 1, depthFunc: GL.LESS, depthMask: true, color: true});
            expect(casings[i + 1]).toMatchObject({cover: 2, depthFunc: GL.LESS, depthMask: false, color: true});
            expect(casings[i].depthRange).toBeLessThan(draws[0].depthRange);
            expect(casings[i].depthRange).toBe(casings[i + 1].depthRange);
        }
    });

    it('draws each fill whole, then clears the mark under it without color', () => {
        const fills = draws.filter((d) => d.outset === FILL);
        expect(fills).toHaveLength(2 * groups);
        for (let i = 0; i < fills.length; i += 2) {
            expect(fills[i]).toMatchObject({cover: 0, ...underLayersAbove});
            expect(fills[i + 1]).toMatchObject({cover: 3, depthFunc: GL.ALWAYS, depthMask: true, depthRange: draws[0].depthRange, color: false});
        }
    });

    it('never writes the stencil buffer, which holds the tile clipping masks', () => {
        const stencil = calls.filter((c) => /stencil/i.test(c.name) || (c.name === 'clear'));
        expect(stencil).toEqual([]);
        expect(calls.some((c) => c.name === 'enable' && c.args[0] === GL.STENCIL_TEST)).toBe(false);
    });

    it('leaves color and depth as MapLibre set them', () => {
        expect(now).toMatchObject({...underLayersAbove, cover: 0});
    });
});

describe('a translucent fill', () => {
    const {calls, draws, now} = drawn({casingColor: null, opacity: 0.6});
    const groups = drawn({casingColor: null}).draws.length;
    const fills = draws.slice(1);

    it('paints each pixel once: fragments that cover their pixel test and set a fill mark, the rest only test it', () => {
        expect(draws[0]).toMatchObject({color: false, depthFunc: GL.LEQUAL, depthMask: true});
        const painted = fills.filter((d) => d.color);
        expect(painted).toHaveLength(2 * groups);
        for (let i = 0; i < painted.length; i += 2) {
            expect(painted[i]).toMatchObject({outset: FILL, cover: 1, depthFunc: GL.LESS, depthMask: true});
            expect(painted[i + 1]).toMatchObject({outset: FILL, cover: 2, depthFunc: GL.LESS, depthMask: false});
            expect(inGap(painted[i].depthRange)).toBe(true);
            expect(painted[i].depthRange).toBe(painted[i + 1].depthRange);
        }
    });

    it('clears the mark under each route once its fill is down, so other routes still blend over it', () => {
        const clears = fills.filter((d) => !d.color);
        expect(clears).toHaveLength(groups);
        for (const d of clears) expect(d).toMatchObject({cover: 3, depthFunc: GL.ALWAYS, depthMask: true, depthRange: draws[0].depthRange});
        expect(fills[fills.length - 1].color).toBe(false);
    });

    it('sits nearer than the casing mark, so a fill passes over its own casing', () => {
        const cased = drawn({casingColor: 'rgba(255, 255, 255, 0.3)', opacity: 0.6}).draws;
        const casing = cased.find((d) => d.outset === CASING && d.cover === 1)!;
        const fill = cased.find((d) => d.outset === FILL && d.cover === 1)!;
        expect(fill.depthRange).toBeLessThan(casing.depthRange);
    });

    it('never writes the stencil buffer, and leaves depth as MapLibre set it', () => {
        expect(calls.filter((c) => /stencil/i.test(c.name) || c.name === 'clear')).toEqual([]);
        expect(now).toMatchObject({...underLayersAbove, cover: 0});
    });

    it('is drawn as it always was when opaque', () => {
        const {calls, draws} = drawn({casingColor: null});
        expect(calls.filter(writesDepth)).toEqual([]);
        for (const d of draws) expect(d).toMatchObject(underLayersAbove);
    });
});

describe('a highlight over a translucent casing', () => {
    it('draws its halo and outline under the layers above, and clears the mark in a draw of its own', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false, casingColor: 'rgba(255, 255, 255, 0.3)'});
        const rec = recordingGl(24);
        layer.onAdd(mapStub, rec.gl);
        layer.setHighlight([...graph.routes.keys()][0]);
        layer.render(rec.gl, args);
        const wide = rec.draws.filter((d) => d.outset > CASING);
        expect(wide.length).toBeGreaterThan(0);
        for (const d of wide.filter((x) => x.color)) expect(d).toMatchObject(underLayersAbove);
        for (const d of wide.filter((x) => !x.color)) expect(d).toMatchObject({depthFunc: GL.ALWAYS, depthMask: true});
        expect(rec.now).toMatchObject({...underLayersAbove, cover: 0});
    });
});

describe('what else needs the casing blended once', () => {
    it('a layer that is itself translucent, since its casing then is', () => {
        expect(drawn({casingColor: '#333', opacity: 0.6}).draws[0]).toMatchObject({color: false, depthMask: true});
    });

    it('but not on a depth buffer too coarse to hold the mark', () => {
        const {calls, draws} = drawn({casingColor: 'rgba(255, 255, 255, 0.3)'}, 16);
        expect(calls.filter(writesDepth)).toEqual([]);
        for (const d of draws) expect(d).toMatchObject(underLayersAbove);
    });
});
