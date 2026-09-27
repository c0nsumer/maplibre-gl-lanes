/**
 * Worker entry. A layout session keeps the graph and its caches, so a pan
 * pays only for the pieces it has not reached yet.
 */

import {fromTransfer, packPaths, pathTransferables, type GraphTransfer, type PathTransfer} from '../core/serialize.js';
import {LaneOrderer, type OrderOptions} from '../core/order.js';
import {stabilizeLanes, type StabilizeOptions} from '../core/baselines.js';
import {layoutAtZoom, LayoutCache, type LaneLook, type LaneStyle, type LaneSizes} from '../core/layout.js';
import {tessellate, TessellateCache} from '../render/tessellate.js';
import type {GraphEdge, LaneAppearance, LineGraph} from '../core/graph.js';
import type {Bounds} from '../core/geometry.js';

export interface OrderRequest {
    kind?: 'order';
    id: number;
    graph: GraphTransfer;
    order?: OrderOptions;
    stabilize?: StabilizeOptions | false;
}

export interface OrderResponse {
    kind?: 'order';
    id: number;
    cost: number;
    orders: string[][];
    baselines: (number | undefined)[];
    ms: number;
    error?: string;
    /** The worker was disposed before it answered. */
    disposed?: boolean;
}

export interface LayoutRequest {
    kind: 'layout';
    id: number;
    /** Sent with `graph` the first time. */
    session: number;
    graph?: GraphTransfer;
    /** Sent with the graph. */
    origin?: [number, number];
    unitsPerMercator?: number;
    zoom: number;
    style: LaneSizes;
    smooth: boolean;
    openFolds: boolean;
    bounds: Bounds | null;
    routes?: string[] | null;
    /** 'full' sends paths alone for the whole graph, with its own cache so the two do not evict each other. */
    extent?: 'built' | 'full';
    /**
     * The resolved `laneStyle` callback, which cannot cross to a worker, per
     * (edge, route). Undefined keeps the session's table; null clears it.
     */
    looks?: (LaneAppearance | null)[] | null;
}

export interface LayoutResponse {
    kind: 'layout';
    id: number;
    session: number;
    zoom: number;
    scale: number;
    bounds: Bounds | null;
    mergedEdges: number[];
    drawOrder: string[];
    stats: {edges: number; edgesBuilt: number; edgesMerged: number; nodes: number; vertices: number; ms: number};
    paths: PathTransfer;
    vertices: Float32Array;
    colors: Uint8Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
    groups: [number, number][];
    groupRoutes: string[];
    groupLooks: LaneLook[];
    groupDots: [number, number][];
    layoutMs: number;
    meshMs: number;
    /** The worker restarted or evicted the session: send the graph again. */
    needGraph?: boolean;
    error?: string;
}

export type WorkerRequest = OrderRequest | LayoutRequest | {kind: 'dispose'; id: number; session: number};
export type WorkerResponse = OrderResponse | LayoutResponse | {kind: 'dispose'; id: number; error?: string};

export function handleOrderRequest(req: OrderRequest): OrderResponse {
    const t0 = performance.now();
    const g = fromTransfer(req.graph);
    const cost = new LaneOrderer(g, req.order).solve();
    if (req.stabilize !== false) stabilizeLanes(g, req.stabilize ?? {});
    return {id: req.id, cost, orders: g.edges.map((e) => e.order), baselines: g.edges.map((e) => e.baseline), ms: performance.now() - t0};
}

interface Session {
    id: number;
    graph: LineGraph;
    origin: [number, number];
    unitsPerMercator: number;
    layoutCache: LayoutCache;
    fullCache: LayoutCache;
    meshCache: TessellateCache;
    lookAt: Int32Array;
    looks: (LaneAppearance | null)[] | null;
    /** Stable across requests: the layout cache keys on the callback's identity. */
    laneStyle: LaneStyle;
}

/** One session per graph, so two lane layers do not evict each other. */
const sessions = new Map<number, Session>();
const MAX_SESSIONS = 4;

function openSession(req: LayoutRequest): Session {
    const graph = fromTransfer(req.graph!);
    const lookAt = new Int32Array(graph.edges.length);
    let at = 0;
    for (const e of graph.edges) {
        lookAt[e.id] = at;
        at += e.routes.length;
    }
    const s: Session = {
        id: req.session,
        graph,
        origin: req.origin ?? [0, 0],
        unitsPerMercator: req.unitsPerMercator ?? 1,
        layoutCache: new LayoutCache(),
        fullCache: new LayoutCache(),
        meshCache: new TessellateCache(),
        lookAt,
        looks: null,
        laneStyle: (e: GraphEdge, r: string) => {
            const table = s.looks;
            if (!table) return null;
            const i = e.routes.indexOf(r);
            return i < 0 ? null : table[lookAt[e.id] + i];
        },
    };
    return s;
}

export function handleLayoutRequest(req: LayoutRequest): LayoutResponse {
    if (req.graph) {
        sessions.set(req.session, openSession(req));
        while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
    }
    const s = sessions.get(req.session);
    if (!s) return {...emptyLayout(req), needGraph: true};
    // Map order is the LRU order.
    sessions.delete(req.session);
    sessions.set(req.session, s);
    if (req.looks !== undefined) {
        // Colors are part of what the caches hold, so a change drops them.
        s.looks = req.looks;
        s.layoutCache.clear();
        s.fullCache.clear();
        s.meshCache.clear();
    }
    const full = req.extent === 'full';
    const t0 = performance.now();
    const layout = layoutAtZoom(s.graph, req.zoom, () => req.style, {
        bounds: full ? null : req.bounds,
        smooth: req.smooth,
        openFolds: req.openFolds,
        routes: req.routes ?? undefined,
        laneStyle: s.looks ? s.laneStyle : undefined,
        cache: full ? s.fullCache : s.layoutCache,
    });
    const t1 = performance.now();
    const mesh = full ? EMPTY_MESH : tessellate(layout.paths, {
        scale: layout.scale,
        origin: s.origin,
        unitsPerMercator: s.unitsPerMercator,
        drawOrder: layout.drawOrder,
        width: req.style.width,
        cache: s.meshCache,
    });
    const t2 = performance.now();
    return {
        kind: 'layout',
        id: req.id,
        session: req.session,
        zoom: layout.zoom,
        scale: layout.scale,
        bounds: layout.bounds,
        mergedEdges: layout.mergedEdges,
        drawOrder: layout.drawOrder,
        stats: layout.stats,
        paths: packPaths(layout.paths),
        // The mesh cache reuses its buffers, so the copies are what transfers.
        vertices: mesh.vertices.slice(),
        colors: mesh.colors.slice(),
        indices: mesh.indices.slice(),
        vertexCount: mesh.vertexCount,
        indexCount: mesh.indexCount,
        groups: mesh.groups,
        groupRoutes: mesh.groupRoutes,
        groupLooks: mesh.groupLooks,
        groupDots: mesh.groupDots,
        layoutMs: t1 - t0,
        meshMs: t2 - t1,
    };
}

const EMPTY_MESH = {
    vertices: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint32Array(0),
    vertexCount: 0, indexCount: 0, groups: [] as [number, number][], groupRoutes: [] as string[],
    groupLooks: [] as LaneLook[], groupDots: [] as [number, number][],
};

function emptyLayout(req: LayoutRequest): LayoutResponse {
    return {
        kind: 'layout', id: req.id, session: req.session, zoom: req.zoom, scale: 512 * Math.pow(2, req.zoom),
        bounds: req.bounds, mergedEdges: [], drawOrder: [],
        stats: {edges: 0, edgesBuilt: 0, edgesMerged: 0, nodes: 0, vertices: 0, ms: 0},
        paths: packPaths([]),
        vertices: new Float32Array(0), colors: new Uint8Array(0), indices: new Uint32Array(0),
        vertexCount: 0, indexCount: 0, groups: [], groupRoutes: [], groupLooks: [], groupDots: [], layoutMs: 0, meshMs: 0,
    };
}

export function layoutTransferables(res: LayoutResponse): ArrayBuffer[] {
    return [...pathTransferables(res.paths), res.vertices.buffer as ArrayBuffer, res.colors.buffer as ArrayBuffer, res.indices.buffer as ArrayBuffer];
}

type WorkerScope = {
    onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
    postMessage(msg: WorkerResponse, transfer?: Transferable[]): void;
};
declare const self: WorkerScope;
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
    self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
        const req = ev.data;
        try {
            if (req.kind === 'dispose') {
                sessions.delete(req.session);
                self.postMessage({kind: 'dispose', id: req.id});
            } else if (req.kind === 'layout') {
                const res = handleLayoutRequest(req);
                self.postMessage(res, layoutTransferables(res));
            } else {
                self.postMessage(handleOrderRequest(req));
            }
        } catch (err) {
            const error = String((err as Error)?.stack ?? err);
            if (req.kind === 'layout') self.postMessage({...emptyLayout(req), error});
            else if (req.kind === 'dispose') self.postMessage({kind: 'dispose', id: req.id, error});
            else self.postMessage({id: req.id, cost: NaN, orders: [], baselines: [], ms: 0, error});
        }
    };
}
