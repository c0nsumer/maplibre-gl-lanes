/**
 * The layout runs in a worker by default: the render call asks for a mesh
 * and keeps drawing the one it has until the answer lands. There is no
 * `Worker` in Node, so these drive the real message handler through a fake
 * one that clones both ways, which also proves the messages are
 * structured-cloneable.
 */
import {describe, it, expect, afterEach, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph, type LaneAppearance} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {orderLanesAsync} from '../src/core/order-async';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom} from '../src/core/layout';
import {tessellate} from '../src/render/tessellate';
import {toTransfer, packPaths, unpackPaths} from '../src/core/serialize';
import {handleLayoutRequest, handleOrderRequest, type LayoutRequest, type WorkerRequest, type WorkerResponse} from '../src/worker/lanes.worker';
import {disposeWorkers, nextRequestId, sendToWorker} from '../src/core/worker-client';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
orderLanes(graph);
stabilizeLanes(graph, {});
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

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

function withFakeWorker(): void {
    FakeWorker.requests = [];
    (globalThis as {Worker?: unknown}).Worker = FakeWorker;
}

afterEach(() => {
    disposeWorkers();
    delete (globalThis as {Worker?: unknown}).Worker;
});

/** A WebGL2 context that records what it is asked to do. */
function recordingGl() {
    const calls: {name: string; args: unknown[]}[] = [];
    const gl = new Proxy({}, {
        get: (_, name: string) => {
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return () => 0;
            return (...args: unknown[]) => {
                calls.push({name, args});
                return {};
            };
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, calls};
}

function mapStub(zoom: number, view = {west: -180, south: -85, east: 180, north: 85}) {
    return {
        getTerrain: () => null,
        getZoom: () => zoom,
        getPixelRatio: () => 1,
        triggerRepaint: () => {},
        getBounds: () => ({getWest: () => view.west, getSouth: () => view.south, getEast: () => view.east, getNorth: () => view.north}),
        unproject: () => ({lng: 0, lat: 0}),
        view,
    };
}

const shaderData = {variantName: 'mercator', vertexShaderPrelude: '', define: ''};
const args = {
    shaderData,
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16),
        fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1],
        clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0,
        clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('layout in the worker', () => {
    it('builds the same mesh the main thread would', () => {
        const req: LayoutRequest = {
            kind: 'layout', id: 1, session: 1, graph: structuredClone(toTransfer(graph)),
            origin: [0, 0], unitsPerMercator: 8192, zoom: 16, style: style(), smooth: true, openFolds: true, bounds: null,
        };
        const res = handleLayoutRequest(req);
        const layout = layoutAtZoom(graph, 16, style);
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin: [0, 0], unitsPerMercator: 8192, drawOrder: layout.drawOrder});
        expect(res.stats.vertices).toBe(layout.stats.vertices);
        expect(res.drawOrder).toEqual(layout.drawOrder);
        expect(res.mergedEdges).toEqual(layout.mergedEdges);
        expect(res.vertexCount).toBe(mesh.vertexCount);
        expect(res.groups).toEqual(mesh.groups);
        expect(res.groupPieces).toEqual(mesh.groupPieces);
        expect([...res.vertices]).toEqual([...mesh.vertices]);
        expect([...res.indices]).toEqual([...mesh.indices]);
        const paths = unpackPaths(res.paths);
        expect(paths.length).toBe(layout.paths.length);
        paths.forEach((p, i) => {
            expect(p.coords).toEqual(layout.paths[i].coords);
            expect(p.anchors).toEqual(layout.paths[i].anchors);
            expect(p.look).toEqual(layout.paths[i].look);
            expect(p.between).toEqual(layout.paths[i].between);
        });
    });

    it('asks for the graph again when it does not know the session', () => {
        const res = handleLayoutRequest({kind: 'layout', id: 2, session: 987, zoom: 16, style: style(), smooth: true, openFolds: true, bounds: null});
        expect(res.needGraph).toBe(true);
        expect(res.vertexCount).toBe(0);
    });

    it('draws lanes by way when the request carries a look table', () => {
        // One route, on one edge only, so that route comes out as two
        // groups: the overridden edge and everything else.
        const route = graph.edges[0].routes[0];
        const looks: (LaneAppearance | null)[] = [];
        for (const e of graph.edges) {
            for (const r of e.routes) looks.push(e.id === 0 && r === route ? {color: '#123456', dash: [2, 2]} : null);
        }
        const res = handleLayoutRequest({
            kind: 'layout', id: 3, session: 3, graph: structuredClone(toTransfer(graph)),
            origin: [0, 0], unitsPerMercator: 8192, zoom: 16, style: style(), smooth: true, openFolds: true, bounds: null, looks,
        });
        const used = new Set(unpackPaths(res.paths).map((p) => p.look.color));
        expect(used.has('#123456')).toBe(true);
        expect(used.size).toBeGreaterThan(1);
        // The dash travels with the color, and reaches the mesh as its own
        // draw pass: a route with two looks is two groups.
        const dashed = unpackPaths(res.paths).filter((p) => p.look.color === '#123456');
        expect(dashed.every((p) => p.look.dash?.[0] === 2 && p.look.dash?.[1] === 2)).toBe(true);
        expect(res.groupLooks.filter((l) => l.dash).length).toBeGreaterThan(0);
        expect(res.groupRoutes.length).toBeGreaterThan(new Set(res.groupRoutes).size);
    });

    it('round-trips paths through the transfer form', () => {
        const layout = layoutAtZoom(graph, 14, style);
        const back = unpackPaths(structuredClone(packPaths(layout.paths)));
        expect(back).toEqual(layout.paths.map((p) => ({...p, between: p.between ?? undefined})));
    });
});

describe('full-extent lane features', () => {
    it('are the same features the render thread would build', async () => {
        withFakeWorker();
        const busiest = graph.edges.reduce((a, e) => (e.routes.length > a.routes.length ? e : a)).routes[0];
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(16), gl);
        const fromWorker = await layer.laneFeaturesAsync({zoom: 16, routes: [busiest], extent: 'full'});
        const here = new LaneLayer({id: 'b', graph, sizes: style, worker: false});
        here.onAdd(mapStub(16), recordingGl().gl);
        const onThisThread = here.laneFeatures({zoom: 16, routes: [busiest], extent: 'full'});
        expect(fromWorker).toEqual(onThisThread);
        expect(fromWorker.features.length).toBeGreaterThan(4);
        // No mesh comes back for a full extent, and no build is recorded.
        const req = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(req.every((r) => r.extent === 'full')).toBe(true);
        expect(layer.getBuildInfo()).toBe(null);
    });

    it('cache per zoom and route set, and share one request', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        layer.onAdd(mapStub(16), recordingGl().gl);
        const both = await Promise.all([
            layer.laneFeaturesAsync({zoom: 16, extent: 'full'}),
            layer.laneFeaturesAsync({zoom: 16, extent: 'full'}),
        ]);
        expect(both[0]).toBe(both[1]);
        expect(await layer.laneFeaturesAsync({zoom: 16, extent: 'full'})).toBe(both[0]);
        expect(FakeWorker.requests.filter((r) => r.kind === 'layout').length).toBe(1);
        await layer.laneFeaturesAsync({zoom: 17, extent: 'full'});
        expect(FakeWorker.requests.filter((r) => r.kind === 'layout').length).toBe(2);
    });

    it('fall back to this thread without a worker, and answer the built extent at once', async () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        layer.onAdd(mapStub(16), recordingGl().gl);
        const full = await layer.laneFeaturesAsync({zoom: 16, extent: 'full'});
        expect(full).toEqual(layer.laneFeatures({zoom: 16, extent: 'full'}));
        expect(await layer.laneFeaturesAsync()).toEqual(layer.laneFeatures());
    });

    it('do not disturb the build the layer is drawing', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(16), gl);
        layer.render(gl, args);
        const features = layer.laneFeaturesAsync({zoom: 12, extent: 'full'});
        await tick();
        await features;
        expect(layer.getBuildInfo()!.build).toBe(1);
        expect(layer.getBuildInfo()!.zoom).toBe(16);
        // The viewport build and the full extent each carry their own zoom.
        const layouts = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(layouts.map((r) => `${r.extent}@${r.zoom}`)).toEqual(['built@16', 'full@12']);
        expect(layouts[1].graph).toBeFalsy();
        layer.render(gl, args);
        expect(layer.getBuildInfo()!.zoom).toBe(16);
    });

    it('rebuild after the style changes', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        layer.onAdd(mapStub(16), recordingGl().gl);
        const before = await layer.laneFeaturesAsync({zoom: 16, extent: 'full'});
        layer.setSizes(() => ({spacing: 20, width: 6, casingWidth: 1}));
        const after = await layer.laneFeaturesAsync({zoom: 16, extent: 'full'});
        expect(after).not.toBe(before);
        expect(after.features[0].geometry).not.toEqual(before.features[0].geometry);
    });
});

describe('the layer with a worker', () => {
    it('draws nothing until the first build lands, then draws it', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl, calls} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        expect(calls.some((c) => c.name === 'drawElements')).toBe(false);
        expect(layer.getLayout()).toBe(null);
        await tick();
        expect(layer.getLayout()).not.toBe(null);
        layer.render(gl, args);
        expect(calls.some((c) => c.name === 'drawElements')).toBe(true);
        // The render thread only uploaded; the layout ran in the worker.
        const {layoutMs, meshMs, renderThreadMs} = layer.getBuildInfo()!.timings;
        expect(layoutMs).toBeGreaterThan(0);
        expect(renderThreadMs).toBeLessThan(layoutMs + meshMs);
    });

    it('sends the graph once and asks for one build per view', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        layer.render(gl, args);
        layer.render(gl, args);
        await tick();
        layer.render(gl, args);
        await tick();
        const layouts = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(layouts.length).toBe(1);
        expect(layouts[0].graph).toBeTruthy();
    });

    it('gives the same geometry as building on the render thread', async () => {
        withFakeWorker();
        const worker = new LaneLayer({id: 'a', graph, sizes: style});
        const {gl} = recordingGl();
        worker.onAdd(mapStub(15), gl);
        worker.render(gl, args);
        await tick();
        const here = new LaneLayer({id: 'b', graph, sizes: style, worker: false});
        const plain = recordingGl();
        here.onAdd(mapStub(15), plain.gl);
        here.render(plain.gl, args);
        const a = worker.getLayout()!;
        const b = here.getLayout()!;
        expect(a.paths.length).toBe(b.paths.length);
        a.paths.forEach((p, i) => {
            expect(p.route).toBe(b.paths[i].route);
            expect(p.coords).toEqual(b.paths[i].coords);
        });
        expect(worker.laneFeatures().features.length).toBe(here.laneFeatures().features.length);
        expect(worker.queryLaneAt([-87.64, 46.49], 15, 1e6)?.route).toBe(here.queryLaneAt([-87.64, 46.49], 15, 1e6)?.route);
    });

    it('keeps one build in flight and asks again from where the pan ended', async () => {
        withFakeWorker();
        const view = {west: -88.0, south: 46.4, east: -87.9, north: 46.5};
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14, view), gl);
        layer.render(gl, args);
        // Panning while the first build is in flight adds no requests.
        for (let i = 0; i < 5; i++) {
            view.west += 0.05;
            view.east += 0.05;
            layer.render(gl, args);
        }
        expect(FakeWorker.requests.filter((r) => r.kind === 'layout').length).toBe(1);
        await tick();
        layer.render(gl, args);
        const layouts = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(layouts.length).toBe(2);
        // The second asks for where the pan ended, not for where it started.
        expect(layouts[1].bounds!.minX).toBeGreaterThan(layouts[0].bounds!.minX);
        expect(layouts[1].graph).toBeFalsy();
    });

    it('reports every finished build, the new graph first after setGraph', async () => {
        withFakeWorker();
        const seen: {build: number; edges: number}[] = [];
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, onBuild: (i) => seen.push({build: i.build, edges: i.stats.edges})});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        // Never inside the render call, even when the build happens there.
        expect(seen).toEqual([]);
        await tick();
        expect(seen).toEqual([{build: 1, edges: graph.edges.length}]);
        expect(layer.getBuildInfo()!.build).toBe(1);
        const fewer = buildLineGraph(fc.features.filter((_: unknown, i: number) => i % 2 === 0), {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(fewer);
        layer.setGraph(fewer);
        layer.render(gl, args);
        await tick();
        expect(seen.length).toBe(2);
        expect(seen[1]).toEqual({build: 2, edges: fewer.edges.length});
        expect(fewer.edges.length).not.toBe(graph.edges.length);
    });

    it('reports builds made in the render call too', async () => {
        const seen: number[] = [];
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        layer.setOnBuild((i) => seen.push(i.build));
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        expect(seen).toEqual([]);
        await tick();
        expect(seen).toEqual([1]);
        layer.setOnBuild(null);
        layer.setSizes(() => ({spacing: 10, width: 6, casingWidth: 1}));
        layer.render(gl, args);
        await tick();
        expect(seen).toEqual([1]);
        expect(layer.getBuildInfo()!.build).toBe(2);
    });

    it('rebuilds after the graph is replaced', async () => {
        withFakeWorker();
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        await tick();
        const other = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
        orderLanes(other);
        layer.setGraph(other);
        layer.render(gl, args);
        await tick();
        const layouts = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(layouts.length).toBe(2);
        expect(layouts[1].session).not.toBe(layouts[0].session);
        expect(layouts[1].graph).toBeTruthy();
        expect(FakeWorker.requests.some((r) => r.kind === 'dispose')).toBe(true);
        expect(layer.getLayout()).not.toBe(null);
    });
});

/** Never answers, like a worker still busy when it is terminated. */
class SilentWorker {
    onmessage: unknown = null;
    onerror: unknown = null;
    onmessageerror: unknown = null;
    postMessage(): void {}
    terminate(): void {}
}

/**
 * Fails on the first request of the kind named, the way a worker whose
 * script cannot load does: an error event with no message. The other kind
 * of request is answered as FakeWorker answers it.
 */
function workerFailingOn(kind: 'layout' | 'order', otherDelayMs = 0) {
    return class extends FakeWorker {
        declare onerror: ((ev: {message?: string}) => void) | null;
        postMessage(msg: WorkerRequest): void {
            if ((msg.kind ?? 'order') === kind) queueMicrotask(() => this.onerror?.({}));
            else setTimeout(() => super.postMessage(msg), otherDelayMs);
        }
    };
}

const freshGraph = () => buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});

describe('a worker that dies or is disposed', () => {
    it('does not leave the layer waiting on a build that was in flight when the workers were disposed', async () => {
        (globalThis as {Worker?: unknown}).Worker = SilentWorker;
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        disposeWorkers();
        withFakeWorker();
        await tick();
        layer.render(gl, args);
        await tick();
        // The graph went again, to the new worker, and its answer was drawn.
        const layouts = FakeWorker.requests.filter((r) => r.kind === 'layout') as LayoutRequest[];
        expect(layouts.length).toBe(1);
        expect(layouts[0].graph).toBeTruthy();
        expect(layer.getLayout()).not.toBe(null);
    });

    it('falls back to the render thread when the layout worker fails', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        (globalThis as {Worker?: unknown}).Worker = workerFailingOn('layout');
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        await tick();
        layer.render(gl, args);
        expect(layer.getLayout()).not.toBe(null);
        expect(warn.mock.calls.some((c) => String(c[0]).includes('layout worker failed'))).toBe(true);
        warn.mockRestore();
    });

    it('finishes an ordering in flight at dispose on this thread, spawning no worker', async () => {
        (globalThis as {Worker?: unknown}).Worker = SilentWorker;
        const g = freshGraph();
        const ordering = orderLanesAsync(g);
        disposeWorkers();
        withFakeWorker();
        const cost = await ordering;
        const expected = freshGraph();
        expect(cost).toBe(await orderLanesAsync(expected, {sync: true}));
        expect(g.edges.map((e) => e.order)).toEqual(expected.edges.map((e) => e.order));
        expect(FakeWorker.requests).toEqual([]);
    });

    it('does not spawn a worker only to drop a session', () => {
        withFakeWorker();
        disposeWorkers();
        expect(sendToWorker({kind: 'dispose', id: nextRequestId(), session: 1})).toBeNull();
        expect(FakeWorker.requests).toEqual([]);
    });

    it('orders on this thread when the ordering worker fails without a message', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        (globalThis as {Worker?: unknown}).Worker = workerFailingOn('order');
        const g = freshGraph();
        const cost = await orderLanesAsync(g);
        expect(cost).toBe(await orderLanesAsync(freshGraph(), {sync: true}));
        expect(g.edges.every((e) => e.order.length === e.routes.length)).toBe(true);
        warn.mockRestore();
    });

    it('does not fail the ordering worker\'s requests when the layout worker dies', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // The ordering answer lands after the layout worker has died.
        (globalThis as {Worker?: unknown}).Worker = workerFailingOn('layout', 20);
        FakeWorker.requests = [];
        const ordering = orderLanesAsync(freshGraph());
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const {gl} = recordingGl();
        layer.onAdd(mapStub(14), gl);
        layer.render(gl, args);
        await ordering;
        const messages = warn.mock.calls.map((c) => String(c[0]));
        expect(messages.some((m) => m.includes('layout worker failed'))).toBe(true);
        expect(messages.some((m) => m.includes('ordering in worker failed'))).toBe(false);
        warn.mockRestore();
    });
});

describe('a new graph before its first build lands', () => {
    // One route alone spans less of the map, so its graph gets a smaller tile.
    const oneRoute = () => {
        const first = fc.features[0].properties.route_id;
        const g = buildLineGraph(fc.features.filter((f: GeoJSON.Feature) => f.properties!.route_id === first), {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
        orderLanes(g);
        return g;
    };

    for (const worker of [false, true]) {
        it(`answers queries from the graph that was laid out (worker: ${worker})`, async () => {
            if (worker) withFakeWorker();
            // The same features reversed: the same routes on edges numbered differently.
            const g2 = buildLineGraph([...fc.features].reverse(), {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
            orderLanes(g2);
            const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker});
            const {gl} = recordingGl();
            layer.onAdd(mapStub(16) as never, gl);
            layer.render(gl, args);
            await tick();
            layer.setGraph(g2);
            const features = layer.laneFeatures().features;
            expect(features.length).toBeGreaterThan(0);
            for (const f of features) expect(f.properties!.routes).toContain(f.properties!.route);
        });

        it(`draws the old mesh in the old graph's tile (worker: ${worker})`, async () => {
            if (worker) withFakeWorker();
            const tiles: {z: number}[] = [];
            const capture = {...args, getProjectionData: (p: {tileID: {canonical: {z: number}}}) => {
                tiles.push(p.tileID.canonical);
                return (args.getProjectionData as (p: object) => unknown)(p);
            }} as unknown as LaneRenderArgs;
            const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker});
            const {gl} = recordingGl();
            layer.onAdd(mapStub(16) as never, gl);
            layer.render(gl, capture);
            await tick();
            layer.render(gl, capture);
            const before = tiles[tiles.length - 1].z;
            layer.setGraph(oneRoute());
            // With a worker this frame still draws the old mesh; without, it builds the new one.
            layer.render(gl, capture);
            const drawn = tiles[tiles.length - 1].z;
            if (worker) expect(drawn).toBe(before);
            await tick();
            layer.render(gl, capture);
            expect(tiles[tiles.length - 1].z).toBeGreaterThan(before);
        });
    }
});
