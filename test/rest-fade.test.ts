/**
 * A rest build lays the lanes out again once the zoom holds still at another zoom than the
 * mesh's, and a dash fade dissolves the last build's pattern into the new one. The pattern is
 * shaders, so what is checked here is the last build's phase read into the new mesh, and what
 * the layer asks of the map and the context: when it builds, what it fades, and that it stops.
 */
import {describe, it, expect, vi, afterEach} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {tessellate, FLOATS_PER_VERTEX} from '../src/render/tessellate';
import {alongFromSource} from '../src/render/fade';
import {LaneLayer, type LaneRenderArgs, type LaneBuildInfo} from '../src/render/layer';
import {toTransfer} from '../src/core/serialize';
import {handleLayoutRequest, handleOrderRequest, type LayoutRequest, type WorkerRequest, type WorkerResponse} from '../src/worker/lanes.worker';
import {disposeWorkers} from '../src/core/worker-client';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
for (const r of graph.routes.values()) r.dash = [1, 1.5];
orderLanes(graph);
const sizes = () => ({spacing: 8, width: 6, casingWidth: 1});
// A tile the size of the graph, as the layer anchors its mesh: float32 anchors in a tile of the
// whole world round by about 2 px at z16.
const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
const tz = Math.floor(-Math.log2(Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))));
const ORIGIN: [number, number] = [Math.floor(Math.min(...xs) * 2 ** tz) / 2 ** tz, Math.floor(Math.min(...ys) * 2 ** tz) / 2 ** tz];
const UPM = 8192 * 2 ** tz;

function build(zoom: number) {
    const layout = layoutAtZoom(graph, zoom, sizes);
    const mesh = tessellate(layout.paths, {scale: layout.scale, origin: ORIGIN, unitsPerMercator: UPM, drawOrder: layout.drawOrder, width: 6});
    return {layout, mesh, source: {paths: layout.paths, zoom, scale: layout.scale, width: 6}};
}

/** The ribbon vertices of the dashed groups, each once. */
function dashedVertices(mesh: ReturnType<typeof build>['mesh']): number[] {
    const seen = new Set<number>();
    for (let gi = 0; gi < mesh.groups.length; gi++) {
        const [first, count] = mesh.groups[gi];
        for (let k = first; k < first + count; k++) seen.add(mesh.indices[k]);
    }
    return [...seen];
}

describe('the last build\'s phase, read into a new mesh', () => {
    it('is the mesh\'s own distance along when read from its own build', () => {
        const {mesh, source} = build(16);
        const along = alongFromSource(mesh, source, 16, ORIGIN, UPM)!;
        const vs = dashedVertices(mesh);
        let off = 0;
        for (const v of vs) {
            const own = mesh.vertices[v * FLOATS_PER_VERTEX + 8];
            if (along[v * 2 + 1] !== 1 || Math.abs(along[v * 2] - own) > 0.5) off++;
        }
        // Where pieces of one route overlap at a seam either may answer; both agree there.
        expect(off / vs.length).toBeLessThan(0.01);
    });

    it('finds nearly every dashed vertex in a build half a zoom out, in that build\'s pixels', () => {
        const before = build(15.5);
        const {mesh} = build(16);
        const along = alongFromSource(mesh, before.source, 16, ORIGIN, UPM)!;
        const vs = dashedVertices(mesh);
        const found = vs.filter((v) => along[v * 2 + 1] === 1);
        expect(found.length / vs.length).toBeGreaterThan(0.95);
        // Half a zoom out, the same ground is about 2^-0.5 as many pixels along.
        const ratios = found.map((v) => along[v * 2] / mesh.vertices[v * FLOATS_PER_VERTEX + 8]).filter((r) => isFinite(r) && r > 0).sort((a, b) => a - b);
        expect(ratios[Math.floor(ratios.length / 2)]).toBeCloseTo(Math.SQRT1_2, 1);
    });

    it('is null for a mesh with no dashes', () => {
        const solid = buildLineGraph(fc.features, {routeProperty: 'route_id'});
        orderLanes(solid);
        const layout = layoutAtZoom(solid, 16, sizes);
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin: ORIGIN, unitsPerMercator: UPM, drawOrder: layout.drawOrder, width: 6});
        expect(alongFromSource(mesh, {paths: layout.paths, zoom: 15.5, scale: layout.scale}, 16, ORIGIN, UPM)).toBeNull();
    });
});

const args = {
    shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0, clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

/** Keeps the last value of each uniform by name, and the vertex attribute calls. */
function recordingGl() {
    const names = new Map<object, string>();
    const uniforms = new Map<string, unknown[]>();
    const calls: string[] = [];
    const gl = new Proxy({drawingBufferWidth: 100, drawingBufferHeight: 100} as Record<string, unknown>, {
        get: (target, name: string) => {
            if (name in target) return target[name];
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return (_p: unknown, a: string) => (a === 'a_along_old' ? 7 : 0);
            if (name === 'getParameter') return () => null;
            if (name === 'getUniformLocation') return (_p: unknown, u: string) => {
                const key = {};
                names.set(key, u);
                return key;
            };
            return (...a: unknown[]) => {
                if (name.startsWith('uniform') && names.has(a[0] as object)) uniforms.set(names.get(a[0] as object)!, a.slice(1));
                if ((name === 'enableVertexAttribArray' || name === 'disableVertexAttribArray') && a[0] === 7) calls.push(name);
                if (name === 'bufferData') calls.push('bufferData');
                return {};
            };
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, uniforms, calls};
}

function mapStub(start: number) {
    const listeners = new Map<string, () => void>();
    const map = {
        zoom: start,
        repaints: 0,
        getTerrain: () => null, getZoom: () => map.zoom, getPixelRatio: () => 1,
        triggerRepaint: () => {
            map.repaints++;
        },
        getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
        unproject: () => ({lng: 0, lat: 0}),
        on: (type: string, fn: () => void) => {
            listeners.set(type, fn);
        },
        off: (type: string) => {
            listeners.delete(type);
        },
        fire: (type: string) => listeners.get(type)?.(),
        listeners,
    };
    return map;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function setup(opts: {restBuild?: boolean; restDelay?: number; dashFade?: number}) {
    const builds: LaneBuildInfo[] = [];
    const layer = new LaneLayer({id: 'lanes', graph, sizes, worker: false, onBuild: (i) => builds.push(i), ...opts});
    const rec = recordingGl();
    const map = mapStub(17.5);
    layer.onAdd(map, rec.gl);
    layer.render(rec.gl, args);
    return {layer, rec, map, builds};
}

describe('a rest build', () => {
    it('is off by default: no map listeners, and the mesh stays at its zoom', () => {
        const {layer, rec, map} = setup({});
        expect(map.listeners.size).toBe(0);
        map.zoom = 18;
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(17.5);
        expect(layer.restBuildPending()).toBe(false);
    });

    it('lands on moveend, which an ease fires in the frame of its last zoom', async () => {
        vi.useFakeTimers();
        const {layer, rec, map, builds} = setup({restBuild: true});
        map.zoom = 18;
        map.fire('zoom');
        layer.render(rec.gl, args);
        // Within the zoomEpsilon margin: still the old mesh, with a rest build to come.
        expect(layer.getBuildInfo()!.zoom).toBe(17.5);
        expect(layer.restBuildPending()).toBe(true);
        map.fire('moveend');
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(18);
        expect(layer.restBuildPending()).toBe(false);
        await Promise.resolve();
        expect(builds.map((b) => b.zoom)).toEqual([17.5, 18]);
        // A late timer finds nothing to do.
        vi.advanceTimersByTime(100);
        layer.render(rec.gl, args);
        expect(builds).toHaveLength(2);
    });

    it('lands once the zoom has held still for restDelay, before a wheel zoom\'s late moveend', () => {
        vi.useFakeTimers();
        const {layer, rec, map} = setup({restBuild: true, restDelay: 60});
        map.zoom = 17.8;
        map.fire('zoom');
        vi.advanceTimersByTime(40);
        map.zoom = 18;
        map.fire('zoom');
        vi.advanceTimersByTime(40);
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(17.5);
        const repaints = map.repaints;
        vi.advanceTimersByTime(30);
        expect(map.repaints).toBe(repaints + 1);
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(18);
    });

    it('does not come for a zoom a hair off the build\'s, as a zoom clamped by maxBounds can be', () => {
        vi.useFakeTimers();
        const {layer, rec, map, builds} = setup({restBuild: true});
        map.zoom = 17.5 + 7e-12;
        map.fire('zoom');
        map.fire('moveend');
        vi.advanceTimersByTime(100);
        layer.render(rec.gl, args);
        expect(layer.restBuildPending()).toBe(false);
        expect(layer.getBuildInfo()!.zoom).toBe(17.5);
        expect(builds.length).toBeLessThanOrEqual(1);
    });

    it('does nothing after a pan, at the zoom it was built for', () => {
        const {layer, rec, map, builds} = setup({restBuild: true});
        map.fire('moveend');
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.build).toBe(1);
        expect(builds.length).toBeLessThanOrEqual(1);
    });

    it('lets go of the map on removal', () => {
        const {layer, rec, map} = setup({restBuild: true});
        layer.onRemove(map, rec.gl);
        expect(map.listeners.size).toBe(0);
    });
});

describe('a dash fade', () => {
    it('runs for dashFade ms after a build for another zoom, then stops asking for frames', () => {
        let now = 1000;
        vi.spyOn(performance, 'now').mockImplementation(() => now);
        const {layer, rec, map} = setup({restBuild: true, dashFade: 300});
        expect(rec.uniforms.get('u_fade')).toEqual([1]);
        map.zoom = 18;
        map.fire('moveend');
        rec.calls.length = 0;
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(18);
        expect(layer.getBuildInfo()!.timings.fadeMs).toBeGreaterThanOrEqual(0);
        expect(rec.calls).toContain('enableVertexAttribArray');
        expect(rec.uniforms.get('u_fade')).toEqual([0]);
        expect(rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.SQRT2, 6);
        // Old dashes are sized at the old zoom's width, as they were on screen.
        expect(rec.uniforms.get('u_dash_old')).toEqual([6, 9]);
        now += 150;
        let repaints = map.repaints;
        layer.render(rec.gl, args);
        expect(rec.uniforms.get('u_fade')![0]).toBeCloseTo(0.5, 6);
        expect(map.repaints).toBe(repaints + 1);
        now += 200;
        rec.calls.length = 0;
        repaints = map.repaints;
        layer.render(rec.gl, args);
        expect(rec.uniforms.get('u_fade')).toEqual([1]);
        expect(rec.calls).toContain('disableVertexAttribArray');
        expect(map.repaints).toBe(repaints);
    });

    it('does not run for a build at the same zoom, or with dashFade 0', () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const same = setup({dashFade: 300});
        same.layer.setGraph(graph);
        same.layer.render(same.rec.gl, args);
        expect(same.rec.uniforms.get('u_fade')).toEqual([1]);
        const off = setup({restBuild: true});
        off.map.zoom = 18;
        off.map.fire('moveend');
        off.layer.render(off.rec.gl, args);
        expect(off.layer.getBuildInfo()!.zoom).toBe(18);
        expect(off.rec.uniforms.get('u_fade')).toEqual([1]);
    });

    it('does not run across a new graph, whose mesh has its own tile', () => {
        vi.spyOn(performance, 'now').mockImplementation(() => 1000);
        const {layer, rec, map} = setup({dashFade: 300});
        const other = buildLineGraph(fc.features, {routeProperty: 'route_id'});
        for (const r of other.routes.values()) r.dash = [1, 1.5];
        orderLanes(other);
        layer.setGraph(other);
        map.zoom = 18.2;
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(18.2);
        expect(rec.uniforms.get('u_fade')).toEqual([1]);
    });
});

describe('a build landing mid-fade', () => {
    function fading() {
        const clock = {now: 1000};
        vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
        const t = setup({restBuild: true, dashFade: 300});
        t.map.zoom = 18;
        t.map.fire('moveend');
        t.layer.render(t.rec.gl, args);
        return {...t, clock};
    }

    it('carries the fade on through a pan, at the same zoom', () => {
        const {layer, rec, clock} = fading();
        clock.now += 100;
        // A new graph object of the same graph would end it; a forced rebuild at this zoom must not.
        layer.setSizes(sizes);
        layer.render(rec.gl, args);
        expect(rec.uniforms.get('u_fade')![0]).toBeCloseTo(1 / 3, 6);
        expect(rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.SQRT2, 6);
    });

    it('in its first half, carries the fade on from the first zoom', () => {
        const {layer, rec, map, clock} = fading();
        clock.now += 100;
        map.zoom = 18.6;
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(18.6);
        expect(rec.uniforms.get('u_fade')![0]).toBeCloseTo(1 / 3, 6);
        expect(rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.pow(2, 18.6 - 17.5), 6);
    });

    it('in its second half, fades afresh from the mesh on screen', () => {
        const {layer, rec, map, clock} = fading();
        clock.now += 200;
        map.zoom = 18.6;
        layer.render(rec.gl, args);
        expect(rec.uniforms.get('u_fade')).toEqual([0]);
        expect(rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.pow(2, 0.6), 6);
    });

    it('keeps its own length when dashFade changes', () => {
        const {layer, rec, clock} = fading();
        layer.setDashFade(3000);
        clock.now += 150;
        layer.render(rec.gl, args);
        expect(rec.uniforms.get('u_fade')![0]).toBeCloseTo(0.5, 6);
    });
});

/** Runs the real handlers, cloning in both directions as a worker would. */
class FakeWorker {
    static requests: WorkerRequest[] = [];
    onmessage: ((ev: {data: WorkerResponse}) => void) | null = null;
    onerror: ((ev: {message: string}) => void) | null = null;
    postMessage(msg: WorkerRequest): void {
        const req = structuredClone(msg);
        FakeWorker.requests.push(req);
        queueMicrotask(() => {
            const res: WorkerResponse = req.kind === 'layout' ? handleLayoutRequest(req)
                : req.kind === 'dispose' ? {kind: 'dispose', id: req.id}
                : handleOrderRequest(req);
            this.onmessage?.({data: structuredClone(res)});
        });
    }
    terminate(): void {}
}

describe('a dash fade after a worker build', () => {
    afterEach(() => {
        disposeWorkers();
        delete (globalThis as {Worker?: unknown}).Worker;
    });

    const flush = () => new Promise((r) => setTimeout(r, 0));
    const layoutRequests = () => FakeWorker.requests.filter((r): r is LayoutRequest => r.kind === 'layout');

    async function workerSetup(dashFade: number) {
        FakeWorker.requests = [];
        (globalThis as {Worker?: unknown}).Worker = FakeWorker;
        const clock = {now: 1000};
        vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
        const layer = new LaneLayer({id: 'lanes', graph, sizes, restBuild: true, dashFade});
        const rec = recordingGl();
        const map = mapStub(17.5);
        layer.onAdd(map, rec.gl);
        layer.render(rec.gl, args);
        await flush();
        layer.render(rec.gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(17.5);
        return {layer, rec, map, clock};
    }

    async function zoomTo(t: Awaited<ReturnType<typeof workerSetup>>, zoom: number) {
        t.map.zoom = zoom;
        t.map.fire('moveend');
        t.layer.render(t.rec.gl, args);
        await flush();
        t.layer.render(t.rec.gl, args);
        expect(t.layer.getBuildInfo()!.zoom).toBe(zoom);
    }

    it('reads the phase in the worker, from the build it kept, and fades', async () => {
        const t = await workerSetup(300);
        const [first] = layoutRequests();
        expect(first.keepPhase).toBe(true);
        expect(first.fadeFrom).toBeUndefined();
        await zoomTo(t, 18);
        const second = layoutRequests()[1];
        expect(second.fadeFrom).toEqual([first.id]);
        expect(t.rec.uniforms.get('u_fade')).toEqual([0]);
        expect(t.rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.SQRT2, 6);
        expect(t.rec.uniforms.get('u_dash_old')).toEqual([6, 9]);
        expect(t.layer.getBuildInfo()!.timings.fadeReadMs).toBeGreaterThanOrEqual(0);
    });

    it('asks the worker for nothing extra without a dash fade', async () => {
        const t = await workerSetup(0);
        await zoomTo(t, 18);
        for (const r of layoutRequests()) {
            expect(r.keepPhase).toBeUndefined();
            expect(r.fadeFrom).toBeUndefined();
        }
        expect(t.rec.uniforms.get('u_fade')).toEqual([1]);
    });

    it('mid-fade, asks for both sources and picks as a build on this thread would', async () => {
        const t = await workerSetup(300);
        await zoomTo(t, 18);
        const [first, second] = layoutRequests();
        // First half: carries on from 17.5.
        t.clock.now += 100;
        await zoomTo(t, 18.6);
        const third = layoutRequests()[2];
        expect(third.fadeFrom).toEqual([first.id, second.id]);
        expect(t.rec.uniforms.get('u_fade')![0]).toBeCloseTo(1 / 3, 6);
        expect(t.rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.pow(2, 18.6 - 17.5), 6);
        // Second half: afresh from the mesh on screen, built at 18.6.
        t.clock.now += 100;
        await zoomTo(t, 19.2);
        expect(layoutRequests()[3].fadeFrom).toEqual([first.id, third.id]);
        expect(t.rec.uniforms.get('u_fade')).toEqual([0]);
        expect(t.rec.uniforms.get('u_along_scale_old')![0]).toBeCloseTo(Math.pow(2, 0.6), 6);
    });

    it('reads what a build on this thread reads, and nothing for a build it no longer keeps', () => {
        const base = {kind: 'layout' as const, session: 9001, style: sizes(), smooth: true, openFolds: true, bounds: null};
        handleLayoutRequest({...base, id: 1, zoom: 15.5, graph: toTransfer(graph), origin: ORIGIN, unitsPerMercator: UPM, keepPhase: true});
        const res = handleLayoutRequest({...base, id: 2, zoom: 16, fadeFrom: [1, 12345]});
        const before = build(15.5);
        const {mesh} = build(16);
        expect(res.vertexCount).toBe(mesh.vertexCount);
        const here = alongFromSource(mesh, before.source, 16, ORIGIN, UPM)!;
        expect(res.along![0]).toEqual(here);
        expect(res.along![1]).toBeNull();
        expect(res.fadeFrom).toEqual([1, 12345]);
    });
});
