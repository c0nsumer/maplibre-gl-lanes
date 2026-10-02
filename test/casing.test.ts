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

const GL = {
    DEPTH_RANGE: 0x0b70, DEPTH_TEST: 0x0b71, STENCIL_TEST: 0x0b90, LESS: 0x0201, LEQUAL: 0x0203, ALWAYS: 0x0207,
    COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x100, STENCIL_BUFFER_BIT: 0x400,
    FRAMEBUFFER: 0x8d40, FRAMEBUFFER_BINDING: 0x8ca6, FRAMEBUFFER_COMPLETE: 0x8cd5,
    drawingBufferWidth: 100, drawingBufferHeight: 100,
};
/** What MapLibre gives the first of 14-sublayer layers, and the gap behind it to the layer below. */
const LAYER = 1 - 14 / 65536, GAP = 1 / 65536;
const inGap = (d: number) => d > LAYER && d < LAYER + GAP;

interface Call {name: string; args: unknown[]; offscreen: boolean}
interface Draw {outset: number; cover: number; depthFunc: number; depthMask: boolean; depthRange: number; color: boolean; depthTest: boolean; offscreen: boolean; kind: 'elements' | 'arrays'}

/** Records every call, and every draw with the state it was made under. */
function recordingGl(complete = true) {
    const calls: Call[] = [];
    const draws: Draw[] = [];
    const names = new Map<object, string>();
    // MapLibre's read-only depth mode for a 2D custom layer, drawing to its framebuffer.
    const now = {outset: 0, cover: 0, depthFunc: GL.LEQUAL, depthMask: false, depthRange: LAYER, color: true, depthTest: true, offscreen: false};
    const gl = new Proxy(GL as Record<string, unknown>, {
        get: (target, name: string) => {
            if (name in target) return target[name];
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return () => 0;
            if (name === 'checkFramebufferStatus') return () => (complete ? GL.FRAMEBUFFER_COMPLETE : 0);
            if (name === 'getParameter') return (p: number) => (p === GL.DEPTH_RANGE ? new Float32Array([LAYER, LAYER]) : null);
            if (name === 'getUniformLocation') return (_p: unknown, u: string) => {
                const key = {};
                names.set(key, u);
                return key;
            };
            return (...args: unknown[]) => {
                calls.push({name, args, offscreen: now.offscreen});
                if (name === 'uniform1f' && names.get(args[0] as object) === 'u_outset') now.outset = args[1] as number;
                if (name === 'uniform1f' && names.get(args[0] as object) === 'u_cover') now.cover = args[1] as number;
                if (name === 'depthFunc') now.depthFunc = args[0] as number;
                if (name === 'depthMask') now.depthMask = args[0] as boolean;
                if (name === 'depthRange') now.depthRange = args[0] as number;
                if (name === 'colorMask') now.color = args[0] as boolean;
                if (name === 'enable' && args[0] === GL.DEPTH_TEST) now.depthTest = true;
                if (name === 'disable' && args[0] === GL.DEPTH_TEST) now.depthTest = false;
                if (name === 'bindFramebuffer') now.offscreen = args[1] !== null;
                if (name === 'drawElements' || name === 'drawArrays') draws.push({...now, kind: name === 'drawElements' ? 'elements' : 'arrays'});
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

function drawn(opts: {casingColor?: string | null; opacity?: number}, complete = true) {
    const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false, ...opts});
    const rec = recordingGl(complete);
    layer.onAdd(mapStub, rec.gl);
    layer.render(rec.gl, args);
    return rec;
}

const CASING = 6 / 2 + 1 + 0.5, FILL = 6 / 2 + 0.5;
const writesDepth = (c: Call) => (c.name === 'depthMask' && c.args[0] === true) || c.name === 'colorMask';
/** Tested at the layer's depth, without writing it: an opaque fill above covers it. */
const atLayerDepth = {depthTest: true, depthFunc: GL.LEQUAL, depthMask: false, depthRange: LAYER, color: true};
const underLayersAbove = {...atLayerDepth, offscreen: false};
/** The mark values, offsets into the gap behind the layer (see `DEPTH_CLEAR` and the rest). */
const CLEAR = LAYER + (GAP * 4) / 8, MARK = LAYER + (GAP * 3) / 8, FILL_MARK = LAYER + (GAP * 2) / 8;
/** A clear of the layer's own buffer, color and depth only: the stencil buffer holds MapLibre's masks. */
const ownClear = (c: Call) => c.name === 'clear' && c.offscreen && ((c.args[0] as number) & GL.STENCIL_BUFFER_BIT) === 0;

describe('an opaque casing', () => {
    it('is drawn as it always was: one casing draw and one fill draw a group, tested at the layer depth', () => {
        const {calls, draws} = drawn({casingColor: '#333'});
        expect(calls.filter(writesDepth)).toEqual([]);
        expect(calls.filter((c) => c.name === 'bindFramebuffer' || c.name === 'clear')).toEqual([]);
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
    const pieces = draws.filter((d) => d.kind === 'elements');

    it('is drawn into a buffer of its own, cleared first, and laid on the map once at the layer depth', () => {
        expect(pieces.length).toBeGreaterThan(0);
        for (const d of pieces) expect(d.offscreen).toBe(true);
        const clears = calls.filter((c) => c.name === 'clear');
        expect(clears).toHaveLength(1);
        expect(clears.every(ownClear)).toBe(true);
        expect(calls.findIndex((c) => c.name === 'clear')).toBeLessThan(calls.findIndex((c) => c.name === 'drawElements'));
        const last = draws[draws.length - 1];
        expect(last).toMatchObject({kind: 'arrays', ...underLayersAbove});
        expect(draws.filter((d) => d.kind === 'arrays')).toHaveLength(1);
    });

    it('tests every colored draw at or behind the layer depth', () => {
        for (const d of draws.filter((x) => x.color)) {
            expect(d.depthTest).toBe(true);
            expect([GL.LEQUAL, GL.LESS]).toContain(d.depthFunc);
            expect(d.depthRange).toBeGreaterThanOrEqual(LAYER);
        }
    });

    it('writes depth only in the gap behind the layer, and only in its own buffer', () => {
        for (const d of draws.filter((x) => x.depthMask)) {
            expect(inGap(d.depthRange)).toBe(true);
            expect(d.offscreen).toBe(true);
        }
    });

    it('draws each casing twice: fragments that cover their pixel test and set the mark, the rest only test it', () => {
        const casings = pieces.filter((d) => d.outset === CASING);
        expect(casings).toHaveLength(2 * groups);
        for (let i = 0; i < casings.length; i += 2) {
            expect(casings[i]).toMatchObject({cover: 1, depthFunc: GL.LESS, depthMask: true, color: true, depthRange: MARK});
            expect(casings[i + 1]).toMatchObject({cover: 2, depthFunc: GL.LESS, depthMask: false, color: true, depthRange: MARK});
        }
    });

    it('draws each fill whole, then clears the mark under it without color', () => {
        const fills = pieces.filter((d) => d.outset === FILL);
        expect(fills).toHaveLength(2 * groups);
        for (let i = 0; i < fills.length; i += 2) {
            expect(fills[i]).toMatchObject({cover: 0, ...atLayerDepth});
            expect(fills[i + 1]).toMatchObject({cover: 3, depthFunc: GL.ALWAYS, depthMask: true, depthRange: CLEAR, color: false});
        }
    });

    it('never writes the stencil buffer, which holds the tile clipping masks, nor clears any buffer of the map', () => {
        expect(calls.filter((c) => /stencil/i.test(c.name))).toEqual([]);
        expect(calls.filter((c) => c.name === 'clear' && !ownClear(c))).toEqual([]);
        expect(calls.some((c) => c.name === 'enable' && c.args[0] === GL.STENCIL_TEST)).toBe(false);
    });

    it('leaves color, depth and the framebuffer as MapLibre set them', () => {
        expect(now).toMatchObject({...underLayersAbove, cover: 0});
    });
});

describe('a translucent fill', () => {
    const {calls, draws, now} = drawn({casingColor: null, opacity: 0.6});
    const groups = drawn({casingColor: null}).draws.length;
    const fills = draws.filter((d) => d.kind === 'elements');

    it('paints each pixel once: fragments that cover their pixel test and set a fill mark, the rest only test it', () => {
        const painted = fills.filter((d) => d.color);
        expect(painted).toHaveLength(2 * groups);
        for (let i = 0; i < painted.length; i += 2) {
            expect(painted[i]).toMatchObject({outset: FILL, cover: 1, depthFunc: GL.LESS, depthMask: true, depthRange: FILL_MARK, offscreen: true});
            expect(painted[i + 1]).toMatchObject({outset: FILL, cover: 2, depthFunc: GL.LESS, depthMask: false, depthRange: FILL_MARK, offscreen: true});
        }
    });

    it('clears the mark under each route once its fill is down, so other routes still blend over it', () => {
        const clears = fills.filter((d) => !d.color);
        expect(clears).toHaveLength(groups);
        for (const d of clears) expect(d).toMatchObject({cover: 3, depthFunc: GL.ALWAYS, depthMask: true, depthRange: CLEAR});
        expect(fills[fills.length - 1].color).toBe(false);
    });

    it('sits nearer than the casing mark, so a fill passes over its own casing', () => {
        const cased = drawn({casingColor: 'rgba(255, 255, 255, 0.3)', opacity: 0.6}).draws;
        const casing = cased.find((d) => d.outset === CASING && d.cover === 1)!;
        const fill = cased.find((d) => d.outset === FILL && d.cover === 1)!;
        expect(fill.depthRange).toBeLessThan(casing.depthRange);
    });

    it('never writes the stencil buffer, and leaves depth and the framebuffer as MapLibre set them', () => {
        expect(calls.filter((c) => /stencil/i.test(c.name) || (c.name === 'clear' && !ownClear(c)))).toEqual([]);
        expect(now).toMatchObject({...underLayersAbove, cover: 0});
        expect(draws[draws.length - 1]).toMatchObject({kind: 'arrays', ...underLayersAbove});
    });

    it('is drawn as it always was when opaque', () => {
        const {calls, draws} = drawn({casingColor: null});
        expect(calls.filter(writesDepth)).toEqual([]);
        expect(calls.filter((c) => c.name === 'bindFramebuffer')).toEqual([]);
        for (const d of draws) expect(d).toMatchObject(underLayersAbove);
    });
});

describe('a highlight over a translucent casing', () => {
    it('draws its halo and outline at the layer depth in the layer\'s own buffer, and clears the mark in a draw of its own', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false, casingColor: 'rgba(255, 255, 255, 0.3)'});
        const rec = recordingGl();
        layer.onAdd(mapStub, rec.gl);
        layer.setHighlight([...graph.routes.keys()][0]);
        layer.render(rec.gl, args);
        const wide = rec.draws.filter((d) => d.outset > CASING);
        expect(wide.length).toBeGreaterThan(0);
        for (const d of wide.filter((x) => x.color)) expect(d).toMatchObject({...atLayerDepth, offscreen: true});
        for (const d of wide.filter((x) => !x.color)) expect(d).toMatchObject({depthFunc: GL.ALWAYS, depthMask: true, offscreen: true});
        expect(rec.now).toMatchObject({...underLayersAbove, cover: 0});
    });
});

describe('what else needs the casing blended once', () => {
    it('a layer that is itself translucent, since its casing then is', () => {
        expect(drawn({casingColor: '#333', opacity: 0.6}).draws[0]).toMatchObject({outset: CASING, cover: 1, depthMask: true, offscreen: true});
    });

    it('but not without a buffer of its own: an incomplete framebuffer leaves the look blended as it comes', () => {
        const {calls, draws} = drawn({casingColor: 'rgba(255, 255, 255, 0.3)'}, false);
        expect(calls.filter(writesDepth)).toEqual([]);
        expect(calls.filter((c) => c.name === 'clear')).toEqual([]);
        expect(draws.length).toBeGreaterThan(0);
        for (const d of draws) expect(d).toMatchObject(underLayersAbove);
    });
});

describe('the layer depth', () => {
    // Reading DEPTH_RANGE is a round trip to the GPU process that blocks the frame.
    it('is read again only when the layer moves in the style', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const rec = recordingGl();
        let reads = 0;
        const gl = new Proxy(rec.gl as unknown as Record<string, unknown>, {
            get: (target, name: string) => name === 'getParameter'
                ? (p: number) => {
                    if (p === GL.DEPTH_RANGE) reads++;
                    return (target.getParameter as (p: number) => unknown)(p);
                }
                : target[name],
        }) as unknown as WebGL2RenderingContext;
        let order = ['background', 'lanes'];
        layer.onAdd({...mapStub, getLayersOrder: () => order}, gl);
        layer.render(gl, args);
        layer.render(gl, args);
        layer.render(gl, args);
        expect(reads).toBe(1);
        order = ['background', 'water', 'lanes'];
        layer.render(gl, args);
        layer.render(gl, args);
        expect(reads).toBe(2);
    });
});
