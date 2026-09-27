/** Worker transfer forms. Paths travel as typed arrays so they cross as transferables. */

import type {LineGraph, GraphNode, GraphEdge, RouteChain, RouteMeta} from './graph.js';
import type {LanePath, LaneLook} from './layout.js';

export interface GraphTransfer {
    nodes: GraphNode[];
    edges: {
        id: number;
        a: number;
        b: number;
        coords: number[];
        routes: string[];
        order: string[];
        /** As pairs: a Map does not survive every host. */
        direction: [string, number][];
        baseline?: number;
    }[];
    routeIds: string[];
    routes: RouteMeta[];
    chains: [string, RouteChain[]][];
}

export function toTransfer(g: LineGraph): GraphTransfer {
    return {
        nodes: g.nodes.map((n) => ({id: n.id, x: n.x, y: n.y, ports: n.ports, transitions: n.transitions})),
        edges: g.edges.map((e) => ({id: e.id, a: e.a, b: e.b, coords: e.coords, routes: e.routes, order: e.order, direction: [...e.direction], baseline: e.baseline})),
        routeIds: [...g.routes.keys()],
        routes: [...g.routes.values()],
        chains: [...g.chains],
    };
}

/** Edge properties do not travel. */
export function fromTransfer(t: GraphTransfer): LineGraph {
    const edges: GraphEdge[] = t.edges.map((e) => ({...e, direction: new Map(e.direction ?? []), order: e.order.slice()}));
    const routes = t.routes
        ? new Map(t.routes.map((r) => [r.id, r]))
        : new Map(t.routeIds.map((id) => [id, {id, color: '#000'}]));
    return {nodes: t.nodes, edges, routes, chains: new Map(t.chains)};
}

/** Path i's coordinates run from `offsets[i]` to `offsets[i + 1]`. */
export interface PathTransfer {
    coords: Float64Array;
    anchors: Float64Array;
    offsets: Uint32Array;
    /** Route and look of each path, as indices into these two lists. */
    routeIds: string[];
    route: Uint32Array;
    looks: LaneLook[];
    look: Uint32Array;
    /** 0 for a lane, 1 for a connector. */
    kind: Uint8Array;
    travel: Int8Array;
    startDistance: Float64Array;
    edge: Int32Array;
    /** Connectors: the node they cross; -1 on a lane. */
    node: Int32Array;
    /** Connectors: the edges arrived on and left on; -1 on a lane. */
    betweenU: Int32Array;
    betweenV: Int32Array;
}

export function packPaths(paths: LanePath[]): PathTransfer {
    const n = paths.length;
    const offsets = new Uint32Array(n + 1);
    let total = 0;
    for (let i = 0; i < n; i++) {
        total += paths[i].coords.length;
        offsets[i + 1] = total;
    }
    const t: PathTransfer = {
        coords: new Float64Array(total),
        anchors: new Float64Array(total),
        offsets,
        routeIds: [],
        route: new Uint32Array(n),
        looks: [],
        look: new Uint32Array(n),
        kind: new Uint8Array(n),
        travel: new Int8Array(n),
        startDistance: new Float64Array(n),
        edge: new Int32Array(n),
        node: new Int32Array(n),
        betweenU: new Int32Array(n),
        betweenV: new Int32Array(n),
    };
    const routeIndex = new Map<string, number>();
    // Interned by identity, which the layout already shares between paths.
    const lookIndex = new Map<LaneLook, number>();
    for (let i = 0; i < n; i++) {
        const p = paths[i];
        const o = offsets[i];
        for (let k = 0; k < p.coords.length; k++) {
            t.coords[o + k] = p.coords[k];
            t.anchors[o + k] = p.anchors[k];
        }
        let r = routeIndex.get(p.route);
        if (r === undefined) {
            r = t.routeIds.push(p.route) - 1;
            routeIndex.set(p.route, r);
        }
        let c = lookIndex.get(p.look);
        if (c === undefined) {
            c = t.looks.push(p.look) - 1;
            lookIndex.set(p.look, c);
        }
        t.route[i] = r;
        t.look[i] = c;
        t.kind[i] = p.kind === 'lane' ? 0 : 1;
        t.travel[i] = p.travel;
        t.startDistance[i] = p.startDistance;
        t.edge[i] = p.edge;
        t.node[i] = p.node ?? -1;
        t.betweenU[i] = p.between ? p.between[0] : -1;
        t.betweenV[i] = p.between ? p.between[1] : -1;
    }
    return t;
}

export function unpackPaths(t: PathTransfer): LanePath[] {
    const n = t.route.length;
    const paths: LanePath[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const from = t.offsets[i], to = t.offsets[i + 1];
        const coords: number[] = new Array(to - from);
        const anchors: number[] = new Array(to - from);
        for (let k = from; k < to; k++) {
            coords[k - from] = t.coords[k];
            anchors[k - from] = t.anchors[k];
        }
        paths[i] = {
            route: t.routeIds[t.route[i]],
            look: t.looks[t.look[i]],
            coords,
            anchors,
            kind: t.kind[i] === 0 ? 'lane' : 'connector',
            travel: t.travel[i] as 1 | -1 | 0,
            startDistance: t.startDistance[i],
            edge: t.edge[i],
            node: t.node[i] >= 0 ? t.node[i] : undefined,
            between: t.betweenU[i] >= 0 ? [t.betweenU[i], t.betweenV[i]] : undefined,
        };
    }
    return paths;
}

export function pathTransferables(t: PathTransfer): ArrayBuffer[] {
    return [t.coords.buffer, t.anchors.buffer, t.offsets.buffer, t.route.buffer, t.look.buffer,
        t.kind.buffer, t.travel.buffer, t.startDistance.buffer, t.edge.buffer, t.node.buffer, t.betweenU.buffer, t.betweenV.buffer] as ArrayBuffer[];
}
