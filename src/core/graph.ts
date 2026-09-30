/**
 * The "line graph" of Bast, Brosi & Storandt. Routes that share a path must
 * share its vertex coordinates exactly, as anything derived from OSM does.
 */

import type {Polyline} from './geometry.js';
import type {Feature as GJFeature, LineString, MultiLineString} from 'geojson';

/** The part of a route's look a `LaneStyle` callback may override per edge, field by field. */
export interface LaneAppearance {
    /** CSS color of the lane fill. */
    color?: string;
    /**
     * [dash, gap] in lane widths, read as a MapLibre dash array. Gaps show
     * `dashColor` if given, else the casing. `[0, gap]` draws round dots,
     * which unlike MapLibre's stay round at every zoom.
     */
    dash?: [number, number];
    /** Fills the gaps of a dashed lane, which makes a two-color pattern. */
    dashColor?: string;
    /** Dash ends, as MapLibre's line-cap draws them on a dashed line. Default 'butt'. */
    dashCap?: 'butt' | 'round' | 'square';
}

export interface RouteMeta extends LaneAppearance {
    id: string;
    color: string;
    name?: string;
    /** Draw the casing under this route. Default true. */
    casing?: boolean;
}

export interface GraphNode {
    id: number;
    /** Web Mercator position in [0, 1] world units. */
    x: number;
    y: number;
    /** One per incident edge end, in no particular order. */
    ports: Port[];
    transitions: NodeTransition[];
}

export interface NodeTransition {
    route: string;
    /** Indices into `ports`. */
    from: number;
    to: number;
}

export interface Port {
    edge: number;
    end: 'a' | 'b';
}

export interface GraphEdge {
    id: number;
    a: number;
    b: number;
    /** Mercator polyline from node a to node b. */
    coords: Polyline;
    routes: string[];
    /** Per route: +1 a->b, -1 b->a, 0 both or unknown. */
    direction: Map<string, number>;
    /** Left-to-right lane order when traveling a->b. */
    order: string[];
    /** Sideways shift of the bundle, in lanes, positive = left of a->b; see `stabilizeLanes`. */
    baseline?: number;
    /** @internal Filled lazily by the layout. */
    bounds?: {minX: number; minY: number; maxX: number; maxY: number};
    /** @internal Filled lazily by the layout; see `simplifyRank`. */
    simplifyRank?: Float64Array;
    /** Values of the `uniformProperties` along this edge, when any were requested. */
    properties?: Record<string, unknown>;
}

export interface LineGraph {
    nodes: GraphNode[];
    edges: GraphEdge[];
    routes: Map<string, RouteMeta>;
    /** Per route, in travel order. */
    chains: Map<string, RouteChain[]>;
}

export interface RouteStep {
    edge: number;
    forward: boolean;
}

export interface RouteChain {
    steps: RouteStep[];
    closed: boolean;
    /** Open chains: the edge whose lane this end merges into, such as a lollipop's stem. */
    mergeStart?: number;
    mergeEnd?: number;
}

export interface LineGraphOptions {
    /** Feature property holding the route id. Default "route". */
    routeProperty?: string;
    /** Feature property holding the route color. Default "color". */
    colorProperty?: string;
    /** Feature property holding the route name. Default "name". */
    nameProperty?: string;
    /** Route metadata keyed by id; overrides per-feature properties. */
    routes?: Record<string, Partial<RouteMeta>>;
    /** Coordinate rounding used to match shared vertices, in degrees. Default 1e-7. */
    snapDegrees?: number;
    /**
     * Feature properties that must stay the same along an edge, kept on
     * `GraphEdge.properties`. Where routes disagree, the first feature wins. Off by default.
     */
    uniformProperties?: string[];
}

type Feature = GJFeature<LineString | MultiLineString>;

export function lngLatToMercator(lng: number, lat: number): [number, number] {
    const x = (lng + 180) / 360;
    const s = Math.sin((lat * Math.PI) / 180);
    const y = 0.5 - (0.25 * Math.log((1 + s) / (1 - s))) / Math.PI;
    return [x, y];
}

export function mercatorToLngLat(x: number, y: number): [number, number] {
    const lng = x * 360 - 180;
    const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
    return [lng, lat];
}

interface ElemEdge {
    u: string;
    v: string;
    routes: Map<string, number>;
    props: Record<string, unknown> | null;
    /** Route set and uniform property values as one string, built on first use. */
    sig: string | null;
}

export function buildLineGraph(features: GJFeature[], opts: LineGraphOptions = {}): LineGraph {
    const routeProp = opts.routeProperty ?? 'route';
    const colorProp = opts.colorProperty ?? 'color';
    const nameProp = opts.nameProperty ?? 'name';
    const snap = opts.snapDegrees ?? 1e-7;
    const uniform = opts.uniformProperties ?? [];
    const routes = new Map<string, RouteMeta>();

    const vertexPos = new Map<string, [number, number]>();
    const elem = new Map<string, ElemEdge>();
    const adjacency = new Map<string, Set<string>>(); // vertex -> elementary edge keys

    const keyOf = (lng: number, lat: number) => {
        const kx = Math.round(lng / snap);
        const ky = Math.round(lat / snap);
        return `${kx},${ky}`;
    };

    for (const f of features as Feature[]) {
        if (!f.geometry) continue;
        const props = f.properties ?? {};
        const rid = props[routeProp];
        if (rid === undefined || rid === null) continue;
        const routeId = String(rid);
        if (!routes.has(routeId)) {
            const override = opts.routes?.[routeId] ?? {};
            routes.set(routeId, {
                id: routeId,
                color: override.color ?? (props[colorProp] as string) ?? '#888888',
                name: override.name ?? (props[nameProp] as string) ?? undefined,
                dash: override.dash,
                dashColor: override.dashColor,
                dashCap: override.dashCap,
                casing: override.casing,
            });
        }
        const lines = f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [];
        const uniformProps = uniform.length ? Object.fromEntries(uniform.map((k) => [k, props[k]])) : null;
        for (const line of lines) {
            let prevKey: string | null = null;
            for (const c of line) {
                const k = keyOf(c[0], c[1]);
                if (!vertexPos.has(k)) vertexPos.set(k, lngLatToMercator(c[0], c[1]));
                if (prevKey !== null && prevKey !== k) {
                    const forward = prevKey < k;
                    const ek = forward ? `${prevKey}|${k}` : `${k}|${prevKey}`;
                    let e = elem.get(ek);
                    if (!e) {
                        e = {u: forward ? prevKey : k, v: forward ? k : prevKey, routes: new Map(), props: uniformProps, sig: null};
                        elem.set(ek, e);
                        for (const vk of [prevKey, k]) {
                            let s = adjacency.get(vk);
                            if (!s) adjacency.set(vk, (s = new Set()));
                            s.add(ek);
                        }
                    }
                    const dir = forward ? 1 : -1;
                    const prev = e.routes.get(routeId);
                    e.routes.set(routeId, prev === undefined ? dir : prev === dir ? dir : 0);
                }
                prevKey = k;
            }
        }
    }

    // Each vertex is asked several times, from the junction scan and from every walk that
    // passes it, and each answer builds two signatures per incident edge: once each is enough.
    const sigOf = (e: ElemEdge): string => {
        if (e.sig === null) {
            const routeSig = [...e.routes.keys()].sort().join('\0');
            e.sig = routeSig + '\u0001' + (e.props ? JSON.stringify(uniform.map((k) => e.props![k] ?? null)) : '');
        }
        return e.sig;
    };
    const junction = new Map<string, boolean>();
    const isJunction = (vk: string): boolean => {
        let is = junction.get(vk);
        if (is === undefined) {
            const inc = adjacency.get(vk)!;
            if (inc.size !== 2) {
                is = true;
            } else {
                const [k1, k2] = inc;
                is = sigOf(elem.get(k1)!) !== sigOf(elem.get(k2)!);
            }
            junction.set(vk, is);
        }
        return is;
    };

    const nodeIndex = new Map<string, number>();
    const nodes: GraphNode[] = [];
    const nodeFor = (vk: string): number => {
        let id = nodeIndex.get(vk);
        if (id === undefined) {
            const [x, y] = vertexPos.get(vk)!;
            id = nodes.length;
            nodeIndex.set(vk, id);
            nodes.push({id, x, y, ports: [], transitions: []});
        }
        return id;
    };

    const edges: GraphEdge[] = [];
    const visited = new Set<string>();

    const walk = (startVk: string, firstEk: string) => {
        const coordsKeys: string[] = [startVk];
        const elemKeys: string[] = [];
        let vk = startVk;
        let ek = firstEk;
        for (;;) {
            visited.add(ek);
            elemKeys.push(ek);
            const e = elem.get(ek)!;
            const next = e.u === vk ? e.v : e.u;
            coordsKeys.push(next);
            vk = next;
            if (isJunction(vk) || vk === startVk) break;
            const inc = [...adjacency.get(vk)!];
            const nk = inc[0] === ek ? inc[1] : inc[0];
            if (visited.has(nk)) break;
            ek = nk;
        }
        const first = elem.get(elemKeys[0])!;
        const a = nodeFor(coordsKeys[0]);
        const b = nodeFor(coordsKeys[coordsKeys.length - 1]);
        const coords: Polyline = [];
        for (const k of coordsKeys) {
            const p = vertexPos.get(k)!;
            coords.push(p[0], p[1]);
        }
        const id = edges.length;
        const direction = new Map<string, number>();
        for (const [r, d] of first.routes) {
            // Elementary edges run from the lesser vertex key, not along the walk.
            const walkForward = first.u === coordsKeys[0];
            direction.set(r, d === 0 ? 0 : walkForward ? d : -d);
        }
        const edge: GraphEdge = {id, a, b, coords, routes: [...first.routes.keys()].sort(), direction, order: []};
        if (first.props) edge.properties = first.props;
        edges.push(edge);
        nodes[a].ports.push({edge: id, end: 'a'});
        nodes[b].ports.push({edge: id, end: 'b'});
    };

    for (const vk of adjacency.keys()) {
        if (!isJunction(vk)) continue;
        for (const ek of adjacency.get(vk)!) {
            if (!visited.has(ek)) walk(vk, ek);
        }
    }
    for (const ek of elem.keys()) {
        if (!visited.has(ek)) walk(elem.get(ek)!.u, ek);
    }

    const chains = deriveChains(nodes, edges, routes);
    return {nodes, edges, routes, chains};
}

/**
 * Decompose routes into chains and fill `transitions`. A chain continues
 * along the straightest unused edge, so a route that revisits a junction
 * still reads as one ride through it.
 */
export function deriveChains(nodes: GraphNode[], edges: GraphEdge[], routes: Map<string, RouteMeta>): Map<string, RouteChain[]> {
    for (const n of nodes) n.transitions = [];
    const chains = new Map<string, RouteChain[]>();
    const portIndex = (node: GraphNode, edge: number, end: 'a' | 'b') => node.ports.findIndex((p) => p.edge === edge && p.end === end);
    const outDir = (node: GraphNode, edge: number, end: 'a' | 'b'): [number, number] => {
        const c = edges[edge].coords;
        let dx: number, dy: number;
        if (end === 'a') {
            dx = c[2] - c[0];
            dy = c[3] - c[1];
        } else {
            const n = c.length;
            dx = c[n - 4] - c[n - 2];
            dy = c[n - 3] - c[n - 1];
        }
        const l = Math.hypot(dx, dy) || 1;
        return [dx / l, dy / l];
    };

    for (const rid of routes.keys()) {
        const routeEdges = edges.filter((e) => e.routes.includes(rid));
        if (!routeEdges.length) {
            chains.set(rid, []);
            continue;
        }
        const unused = new Set(routeEdges.map((e) => e.id));
        const degree = new Map<number, number>();
        for (const e of routeEdges) {
            degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
            degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
        }
        const out: RouteChain[] = [];
        const chainEndPorts: {node: number; port: number; chain: RouteChain; end: 'start' | 'end'}[] = [];
        while (unused.size) {
            // Odd-degree nodes are route ends.
            let startEdge: GraphEdge | null = null;
            let startNode = -1;
            for (const id of unused) {
                const e = edges[id];
                if ((degree.get(e.a)! % 2 === 1) && (startEdge === null || startNode !== e.a && startNode !== e.b)) {
                    startEdge = e;
                    startNode = e.a;
                    break;
                }
                if (degree.get(e.b)! % 2 === 1) {
                    startEdge = e;
                    startNode = e.b;
                    break;
                }
            }
            if (!startEdge) {
                const id = Math.min(...unused);
                startEdge = edges[id];
                startNode = startEdge.a;
            }
            const steps: RouteStep[] = [];
            let node = startNode;
            let arriving: [number, number] | null = null;
            let nextEdge: GraphEdge | null = startEdge;
            while (nextEdge) {
                const forward = nextEdge.a === node;
                steps.push({edge: nextEdge.id, forward});
                unused.delete(nextEdge.id);
                const far = forward ? nextEdge.b : nextEdge.a;
                const farEnd: 'a' | 'b' = forward ? 'b' : 'a';
                const d = outDir(nodes[far], nextEdge.id, farEnd);
                arriving = [-d[0], -d[1]];
                node = far;
                let best: GraphEdge | null = null;
                let bestDot = -Infinity;
                for (const p of nodes[node].ports) {
                    if (!unused.has(p.edge)) continue;
                    const o = outDir(nodes[node], p.edge, p.end);
                    const dot = o[0] * arriving[0] + o[1] * arriving[1];
                    if (dot > bestDot + 1e-9 || (Math.abs(dot - bestDot) <= 1e-9 && best && p.edge < best.id)) {
                        bestDot = dot;
                        best = edges[p.edge];
                    }
                }
                nextEdge = best;
            }
            const first = steps[0];
            const last = steps[steps.length - 1];
            const firstNode = first.forward ? edges[first.edge].a : edges[first.edge].b;
            const lastNode = last.forward ? edges[last.edge].b : edges[last.edge].a;
            const closed = steps.length > 1 && firstNode === lastNode;
            const chain: RouteChain = {steps, closed};
            out.push(chain);
            const stepEnd = (s: RouteStep) => ({node: s.forward ? edges[s.edge].b : edges[s.edge].a, end: (s.forward ? 'b' : 'a') as 'a' | 'b'});
            const stepStart = (s: RouteStep) => ({node: s.forward ? edges[s.edge].a : edges[s.edge].b, end: (s.forward ? 'a' : 'b') as 'a' | 'b'});
            const pairs = steps.length - (closed ? 0 : 1);
            for (let i = 0; i < pairs; i++) {
                const s = steps[i];
                const t = steps[(i + 1) % steps.length];
                const n = nodes[stepEnd(s).node];
                n.transitions.push({route: rid, from: portIndex(n, s.edge, stepEnd(s).end), to: portIndex(n, t.edge, stepStart(t).end)});
            }
            if (!closed) {
                chainEndPorts.push({node: firstNode, port: portIndex(nodes[firstNode], first.edge, stepStart(first).end), chain, end: 'start'});
                chainEndPorts.push({node: lastNode, port: portIndex(nodes[lastNode], last.edge, stepEnd(last).end), chain, end: 'end'});
            }
        }
        // An edge carries a route once, so a lollipop's loop end must rejoin the stem.
        const seen = new Set<string>();
        for (const ce of chainEndPorts) {
            const n = nodes[ce.node];
            const own = n.ports[ce.port];
            const arriveDir = outDir(n, own.edge, own.end).map((v) => -v) as [number, number];
            let best = -1;
            let bestDot = -Infinity;
            n.ports.forEach((p, i) => {
                if (i === ce.port || !edges[p.edge].routes.includes(rid)) return;
                const o = outDir(n, p.edge, p.end);
                const dot = o[0] * arriveDir[0] + o[1] * arriveDir[1];
                if (dot > bestDot) {
                    bestDot = dot;
                    best = i;
                }
            });
            if (best < 0) continue;
            const key = `${ce.node}:${Math.min(ce.port, best)}:${Math.max(ce.port, best)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            n.transitions.push({route: rid, from: ce.port, to: best});
            if (ce.end === 'start') ce.chain.mergeStart = n.ports[best].edge;
            else ce.chain.mergeEnd = n.ports[best].edge;
        }
        chains.set(rid, out);
    }
    return chains;
}

/** Restrict the graph to a subset of routes. */
export function filterGraph(g: LineGraph, visible: (routeId: string) => boolean): LineGraph {
    const keepEdge = new Map<number, number>();
    const edges: GraphEdge[] = [];
    for (const e of g.edges) {
        const routes = e.routes.filter(visible);
        if (!routes.length) continue;
        keepEdge.set(e.id, edges.length);
        edges.push({...e, id: edges.length, routes, order: [], baseline: undefined, direction: new Map([...e.direction].filter(([r]) => visible(r)))});
    }
    const nodes: GraphNode[] = g.nodes.map((n) => ({
        ...n,
        transitions: [],
        ports: n.ports.filter((p) => keepEdge.has(p.edge)).map((p) => ({edge: keepEdge.get(p.edge)!, end: p.end})),
    }));
    const routes = new Map([...g.routes].filter(([r]) => visible(r)));
    const chains = deriveChains(nodes, edges, routes);
    return {nodes, edges, routes, chains};
}
