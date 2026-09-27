/**
 * Lane polylines in world pixels at one zoom. As in LOOM's renderer, an edge's lanes are offsets
 * of its centerline cut back by a node front, and connectors join each route across the node. A
 * lane that ends where other routes pass through runs to the node instead (see `drawOrder`).
 */

import type {GraphEdge, LaneAppearance, LineGraph, RouteStep} from './graph.js';
import {openFolds} from './folds.js';
import {
    boundsIntersect,
    connectorCurve,
    intersectLines,
    endDirection,
    offsetPolyline,
    offsetPolylineAnchored,
    offsetPolylineSlidingAnchored,
    selfIntersects,
    polylineBounds,
    polylineLength,
    reversed,
    simplify,
    smoothCatmullRom,
    splineEndDirection,
    splineStartDirection,
    startDirection,
    trimPolyline,
    type Bounds,
    type Polyline,
    type Vec,
} from './geometry.js';

export interface LaneSizes {
    /** Center-to-center distance between adjacent lanes, px. */
    spacing: number;
    /** Lane fill width, px. */
    width: number;
    /** Casing (outline) width on each side, px. */
    casingWidth: number;
}

export interface LanePath {
    route: string;
    /** The route's look on this piece, with any per-edge override applied. */
    look: LaneLook;
    /** World pixel coordinates at the layout zoom, flat [x, y, ...]. */
    coords: Polyline;
    /** Per vertex, its ground point (world px); `coords - anchors` holds at other zooms. */
    anchors: Polyline;
    kind: 'lane' | 'connector';
    /** The route's direction of travel along `coords`: 1 with them, -1 against, 0 where the route's features cross the edge both ways. */
    travel: 1 | -1 | 0;
    /** Distance (px at the layout zoom) along the route where this path starts; keeps dash phase continuous. */
    startDistance: number;
    /** The graph edge: a lane's own, and for a connector the edge it arrives from. */
    edge: number;
    /** Connectors only: the node they cross. */
    node?: number;
    /** Connectors only: the edges arrived on and left on. */
    between?: [number, number];
}

export interface Layout {
    readonly zoom: number;
    /** Pixels per Mercator unit at this zoom. */
    readonly scale: number;
    readonly paths: LanePath[];
    /** Route ids in drawing order: routes whose lanes end under other bundles come first. */
    readonly drawOrder: string[];
    /** Mercator bounds used for culling, if any. */
    readonly bounds: Bounds | null;
    /** Edges too short to draw at this zoom; their routes cross them on connectors. */
    readonly mergedEdges: number[];
    readonly stats: {edges: number; edgesBuilt: number; edgesMerged: number; nodes: number; vertices: number; ms: number};
}

/** Lane sizes at a given zoom, so spacing and widths can follow the zoom. */
export type SizesAtZoom = (zoom: number) => LaneSizes;

export interface LayoutOptions {
    /** Only build geometry intersecting these Mercator bounds. */
    bounds?: Bounds | null;
    /** Smooth centerlines with a spline. Default true. */
    smooth?: boolean;
    /**
     * Push apart the legs of a fold tighter than the bundle is wide, by at most half the bundle
     * width. Default true.
     */
    openFolds?: boolean;
    /** Only emit these routes' paths; the others still shape the geometry. */
    routes?: Iterable<string>;
    /** Per-edge look of a route's lane; a connector takes the look of the edge it arrives from. */
    laneStyle?: LaneStyle;
    /** Reuse zoom-dependent work between calls, as during a pan (see `LayoutCache`). */
    cache?: LayoutCache;
}

/**
 * Must be a pure function of edge and route: a callback cannot cross to a worker, so it is resolved
 * into a table per (edge, route) when set.
 */
export type LaneStyle = (edge: GraphEdge, route: string) => LaneAppearance | null | undefined;

/** A route's appearance with any per-edge override applied; paths that look alike share one object. */
export interface LaneLook {
    color: string;
    dash?: [number, number];
    dashColor?: string;
    dashCap?: 'butt' | 'round' | 'square';
}

const SIMPLIFY_TOLERANCE_PX = 0.25;
/** Simplification tolerance per px of widest offset: zigzags hidden under a bundle cross its lanes. */
const GENERALIZE_PER_OFFSET = 0.25;
const SMOOTH_SEGMENT_PX = 5;
const MIN_FRONT_MARGIN_LANES = 0.6;
const MAX_FRONT_FRACTION = 0.42;
/** Below this many lane pitches a clique's reference curve is not shared (see `buildGroup`). */
const CLIQUE_MIN_REF_LANES = 1.5;
/** Steepest connector slide, px of shift per px: the shortest room `junctionFronts` gives. */
const MAX_SLIDE_SLOPE = 0.4;
/** Solo lane ease length in lane pitches: half a lane of shift then turns under four degrees. */
const SOLO_EASE_LANES = 12;
const SOLO_EASE_STEPS = 6;
/** Merge edges shorter than this many widest bundles. On RAMBA, below 1.0 edges folded. */
const MERGE_BELOW_BUNDLE_WIDTHS = 1;
/** Rounds of merging; each round can change which lane changes cross which edges. */
const MAX_MERGE_PASSES = 4;
/** The spline keeps bends sharper than this as corners, rounded by `CORNER_RADIUS_LANES`. */
const CORNER_BEND_DEG = 60;
/**
 * A junction turn runs to where the two lines meet and rounds that corner, so a T looks like a T.
 * Turns under `CORNER_MIN_TURN_DEG`, or corners over `CORNER_MAX_REACH` chords away, keep the arc.
 * A smaller radius lets the mesh's miter limit decide the shape; a larger one leaves the road.
 */
const CORNER_RADIUS_LANES = 1.5;
const CORNER_MIN_TURN_DEG = 60;
const CORNER_MAX_REACH = 1.5;

/**
 * Zoom-dependent work and built pieces kept between rebuilds at one zoom. It resets itself when the
 * graph, zoom, sizes, `smooth`, `openFolds` or `laneStyle` changes. Use one cache per sequence of
 * builds: its layouts share `LanePath` objects, and every build rewrites their `startDistance`.
 */
export class LayoutCache {
    private state: ZoomState | null = null;

    clear(): void {
        this.state = null;
    }

    /** @internal */
    stateFor(g: LineGraph, zoom: number, style: LaneSizes, smooth: boolean, openFolds: boolean, laneStyle: LaneStyle | null): ZoomState {
        const s = this.state;
        if (s && s.graph === g && s.zoom === zoom && s.spacing === style.spacing && s.width === style.width &&
            s.casing === style.casingWidth && s.smooth === smooth && s.openFolds === openFolds && s.laneStyle === laneStyle) {
            return s;
        }
        return (this.state = zoomState(g, zoom, style, smooth, openFolds, laneStyle));
    }
}

interface Lane {
    points: Polyline;
    anchors: Polyline;
}

/** One route's connector across a junction, planned before any geometry. */
interface ConnMember {
    route: string;
    key: number;
    /** The same port for a tail. */
    pu: JunctionPort;
    pv: JunctionPort;
    /** Lane offset arriving, and leaving, px, signed in the direction of travel. */
    lateral: number;
    lateralOut: number;
    travel: 1 | -1 | 0;
    via: {edge: number; forward: boolean}[];
    /** The route crosses the same merged edge on another connector of this junction. */
    forked?: boolean;
    /** Set on the fallback connector of a route that starts or ends inside the junction. */
    plan?: TailPlan;
}

/** Connectors making the same turn between the same two edges: one clique (see `buildGroup`). */
interface ConnGroup {
    edgeU: number;
    edgeV: number;
    members: ConnMember[];
}

/** A route that starts or ends inside a junction, and how it is drawn there. */
interface TailPlan {
    tail: JunctionTail;
    port: JunctionPort;
    key: number;
    /** 0 before the geometry has decided, 1 one sliding piece, 2 plain lanes and a Bezier. */
    mode: 0 | 1 | 2;
}

interface ZoomState {
    graph: LineGraph;
    zoom: number;
    scale: number;
    spacing: number;
    width: number;
    casing: number;
    smooth: boolean;
    openFolds: boolean;
    laneStyle: LaneStyle | null;
    looks: Map<string, LaneLook>;
    /** A lane key is `edge * routeCount + routeIndex`. */
    routeIndex: Map<string, number>;
    routeCount: number;
    /** Signed lane offset per lane key, px. */
    offsets: Float64Array;
    /** Per edge: the centerline in px at this zoom, simplified but not smoothed. */
    simplePx: Polyline[];
    edgeLen: Float64Array;
    dirA: Vec[];
    dirB: Vec[];
    short: Uint8Array;
    junctions: Junction[];
    /** Per junction: its connector groups and its tails, planned on first use. */
    groups: (ConnGroup[] | undefined)[];
    tails: (TailPlan[] | undefined)[];
    /** Whether a route continues through an edge end, at `(edge * 2 + end) * routeCount + routeIndex`. */
    continues: Uint8Array;
    frontA: Float64Array;
    frontB: Float64Array;
    mergedEdges: number[];
    drawOrder: string[];
    preparedPx: (Polyline | undefined)[];
    /** Per lane key: the lane, and the path emitted for it; null where it has none. */
    lanes: (Lane | undefined)[];
    lanePaths: (LanePath | null | undefined)[];
    /** Per connector key, null once the geometry has refused it. */
    connPaths: Map<number, LanePath | null>;
}

/** @internal A classic-script page has no type checker; a misspelled size would become a NaN mesh. */
export function checkedSizes(sizesAt: SizesAtZoom, zoom: number): LaneSizes {
    requireSizesFunction(sizesAt);
    const s = sizesAt(zoom);
    const ok = (v: unknown, min: number) => typeof v === 'number' && Number.isFinite(v) && v >= min;
    if (!s || !ok(s.spacing, 0) || !ok(s.width, 0) || !ok(s.casingWidth, 0) || s.spacing === 0 || s.width === 0) {
        const got = s && typeof s === 'object' ? JSON.stringify({spacing: s.spacing, width: s.width, casingWidth: s.casingWidth}, (_k, v) => (v === undefined ? 'undefined' : typeof v === 'number' && !Number.isFinite(v) ? String(v) : v)) : String(s);
        throw new TypeError(`maplibre-gl-lanes: \`sizes(${zoom})\` must return {spacing, width, casingWidth} as finite numbers in px, with spacing and width above 0; got ${got}`);
    }
    return s;
}

/** @internal An options object takes any key, so a misspelled `sizes` arrives as `undefined`. */
export function requireSizesFunction(sizesAt: unknown): asserts sizesAt is SizesAtZoom {
    if (typeof sizesAt !== 'function') {
        throw new TypeError('maplibre-gl-lanes: `sizes` must be a function of the zoom that returns {spacing, width, casingWidth}');
    }
}

export function layoutAtZoom(g: LineGraph, zoom: number, styleAt: SizesAtZoom, opts: LayoutOptions = {}): Layout {
    const t0 = performance.now();
    const smooth = opts.smooth ?? true;
    const open = opts.openFolds ?? true;
    const laneStyle = opts.laneStyle ?? null;
    const style = checkedSizes(styleAt, zoom);
    const st = opts.cache ? opts.cache.stateFor(g, zoom, style, smooth, open, laneStyle) : zoomState(g, zoom, style, smooth, open, laneStyle);
    const bounds = opts.bounds ?? null;
    const only = opts.routes ? new Set(opts.routes) : null;

    // 0. The viewport decides only what is emitted, never a piece's shape: fronts need every edge.
    const inView = new Uint8Array(g.edges.length);
    for (const e of g.edges) {
        if (!bounds) {
            inView[e.id] = 1;
            continue;
        }
        if (!e.bounds) e.bounds = polylineBounds(e.coords);
        inView[e.id] = boundsIntersect(e.bounds, bounds) ? 1 : 0;
    }

    const paths: LanePath[] = [];
    const laneIndex = new Map<number, LanePath>();
    const connIndex = new Map<number, LanePath>();
    let vertices = 0;
    let edgesBuilt = 0;

    // 1. Lanes.
    for (const e of g.edges) {
        if (!inView[e.id] || st.short[e.id]) continue;
        edgesBuilt++;
        for (const r of e.routes) {
            if (only && !only.has(r)) continue;
            const path = lanePathOf(st, e.id, r);
            if (!path) continue;
            laneIndex.set(laneKey(st, e.id, r), path);
            vertices += path.coords.length / 2;
            paths.push(path);
        }
    }

    // 2. Tails: one piece sliding along the merged edges to the route's end, or where that would
    //    loop, plain lanes on the merged edges that a Bezier from step 3 joins.
    for (let ji = 0; ji < st.junctions.length; ji++) {
        if (!touchesView(st.junctions[ji], inView)) continue;
        const tails = planJunction(st, ji).tails;
        for (const plan of tails) {
            const t = plan.tail;
            if (!inView[plan.port.edge] && !t.edges.some((s) => inView[s.edge])) continue;
            resolveTail(st, plan);
            if (plan.mode !== 1 || (only && !only.has(t.route))) continue;
            const path = st.connPaths.get(plan.key)!;
            vertices += path.coords.length / 2;
            connIndex.set(plan.key, path);
            paths.push(path);
        }
        for (const plan of tails) {
            if (plan.mode === 1 || (only && !only.has(plan.tail.route))) continue;
            for (const {edge} of plan.tail.edges) {
                const k = laneKey(st, edge, plan.tail.route);
                if (!inView[edge] || laneIndex.has(k)) continue;
                const path = lanePathOf(st, edge, plan.tail.route);
                if (!path) continue;
                laneIndex.set(k, path);
                vertices += path.coords.length / 2;
                paths.push(path);
            }
        }
    }

    // 3. Connectors.
    for (let ji = 0; ji < st.junctions.length; ji++) {
        if (!touchesView(st.junctions[ji], inView)) continue;
        for (const grp of planJunction(st, ji).groups) {
            if (!inView[grp.edgeU] || !inView[grp.edgeV]) continue;
            buildGroup(st, grp);
            for (const m of grp.members) {
                // A tail that slides needs no connector: step 2 drew the slide.
                if (m.plan?.mode === 1 || (only && !only.has(m.route))) continue;
                const path = st.connPaths.get(m.key);
                if (!path) continue;
                vertices += path.coords.length / 2;
                connIndex.set(m.key, path);
                paths.push(path);
            }
        }
    }

    // 4. Dash phase. A merged edge has no lane; the connector across it covers it.
    for (const [rid, chains] of g.chains) {
        if (!g.routes.get(rid)?.dash) continue;
        for (const chain of chains) {
            const seq = chain.steps.filter((s) => !st.short[s.edge] || laneIndex.has(laneKey(st, s.edge, rid)));
            if (!seq.length) continue;
            let dist = 0;
            // A junction keys a crossing from whichever end met it first, not this chain's travel.
            const cross = (u: number, endU: 'a' | 'b', v: number, endV: 'a' | 'b'): boolean => {
                const along = connIndex.get(connKey(st, rid, u, endU, v, endV));
                const path = along ?? connIndex.get(connKey(st, rid, v, endV, u, endU));
                if (!path) return false;
                const len = polylineLength(path.coords);
                path.startDistance = along ? dist : -(dist + len);
                dist += len;
                return true;
            };
            const tail = (s: RouteStep) => (s.forward ? 'a' : 'b');
            const head = (s: RouteStep) => (s.forward ? 'b' : 'a');
            // A sliding tail's merged edges have no lanes and drop out of
            // `seq`; its slide runs from the route's far end to the port lane.
            const first = chain.steps[0], last = chain.steps[chain.steps.length - 1];
            if (!chain.closed && first !== seq[0]) cross(first.edge, tail(first), seq[0].edge, tail(seq[0]));
            for (let i = 0; i < seq.length; i++) {
                const s = seq[i];
                const e = g.edges[s.edge];
                const lane = laneIndex.get(laneKey(st, e.id, rid));
                const laneLen = lane ? polylineLength(lane.coords) : st.edgeLen[e.id];
                // A piece drawn against the route's travel takes a negative
                // start, which the tessellator reads from the piece's far end.
                if (lane) lane.startDistance = s.forward ? dist : -(dist + laneLen);
                dist += laneLen;
                const next = i + 1 < seq.length ? seq[i + 1] : chain.closed ? seq[0] : null;
                if (!next) {
                    if (!chain.closed && last !== s) cross(s.edge, head(s), last.edge, head(last));
                    break;
                }
                if (!cross(e.id, head(s), next.edge, tail(next))) dist += 2 * st.spacing;
            }
        }
    }

    return {
        zoom,
        scale: st.scale,
        paths,
        drawOrder: st.drawOrder,
        bounds,
        mergedEdges: st.mergedEdges,
        stats: {edges: g.edges.length, edgesBuilt, edgesMerged: st.mergedEdges.length, nodes: g.nodes.length, vertices, ms: performance.now() - t0},
    };
}

function zoomState(g: LineGraph, zoom: number, style: LaneSizes, smooth: boolean, openFolds: boolean, laneStyle: LaneStyle | null): ZoomState {
    const {spacing, width, casingWidth: casing} = style;
    const scale = 512 * Math.pow(2, zoom);
    const E = g.edges.length;

    const routeIndex = new Map<string, number>();
    for (const r of g.routes.keys()) routeIndex.set(r, routeIndex.size);
    for (const e of g.edges) for (const r of e.routes) if (!routeIndex.has(r)) routeIndex.set(r, routeIndex.size);
    const routeCount = Math.max(1, routeIndex.size);
    const offsets = new Float64Array(E * routeCount);
    for (const e of g.edges) {
        const k = e.order.length;
        for (let p = 0; p < k; p++) {
            const r = routeIndex.get(e.order[p]);
            if (r !== undefined) offsets[e.id * routeCount + r] = ((k - 1) / 2 - p + (e.baseline ?? 0)) * spacing;
        }
    }

    // Every edge is simplified up front, so the merge decisions below do not depend on which
    // viewport asked first.
    const simplePx: Polyline[] = new Array(E);
    const edgeLen = new Float64Array(E);
    const dirA: Vec[] = new Array(E);
    const dirB: Vec[] = new Array(E);
    for (const e of g.edges) {
        const widest = ((e.routes.length - 1) / 2 + Math.abs(e.baseline ?? 0)) * spacing;
        // Simplified in Mercator so only the surviving vertices are scaled.
        const p = simplify(e.coords, Math.max(SIMPLIFY_TOLERANCE_PX, GENERALIZE_PER_OFFSET * widest) / scale);
        for (let i = 0; i < p.length; i++) p[i] *= scale;
        simplePx[e.id] = p;
        edgeLen[e.id] = polylineLength(p);
        // The drawn line is the spline, so directions come from its ends.
        dirA[e.id] = smooth ? splineStartDirection(p, SMOOTH_SEGMENT_PX, 10, 3, CORNER_BEND_DEG) : startDirection(p);
        dirB[e.id] = (smooth ? splineEndDirection(p, SMOOTH_SEGMENT_PX, 10, 3, CORNER_BEND_DEG) : endDirection(p)).map((v) => -v) as Vec;
    }

    // An edge too short for its bundles or lane changes merges its nodes into one junction (LOOM's
    // meta node); left alone, the cut-backs from both ends fold into loops. Shallow-angle clearance
    // is deliberately not a trigger: it can exceed a whole hairpin. See docs/algorithms.md.
    const halfWidth = (e: GraphEdge) => ((e.routes.length - 1) / 2) * spacing + width / 2 + casing;
    const laneOffsetTravel = (e: GraphEdge, r: string, forward: boolean) => {
        const off = offsets[e.id * routeCount + routeIndex.get(r)!];
        return forward ? off : -off;
    };
    const short = new Uint8Array(E);
    const degree = (n: number) => g.nodes[n].ports.length;
    const bundleWidth = (n: number) => Math.max(...g.nodes[n].ports.map((p) => g.edges[p.edge].routes.length)) * spacing;
    let junctions: Junction[] = [];
    let need: Float64Array = new Float64Array(2 * E);
    let change: Float64Array = new Float64Array(2 * E);
    let continues: Uint8Array = new Uint8Array(2 * E * routeCount);
    for (let pass = 0; pass < MAX_MERGE_PASSES; pass++) {
        junctions = buildJunctions(g, short, edgeLen, dirA, dirB, halfWidth);
        ({need, change, continues} = junctionFronts(g, junctions, laneOffsetTravel, spacing, routeIndex, routeCount));
        let merged = false;
        for (const e of g.edges) {
            if (short[e.id] || e.a === e.b || degree(e.a) < 2 || degree(e.b) < 2) continue;
            const len = edgeLen[e.id];
            if (len < MERGE_BELOW_BUNDLE_WIDTHS * Math.max(bundleWidth(e.a), bundleWidth(e.b)) || len < change[2 * e.id] + change[2 * e.id + 1]) {
                short[e.id] = 1;
                merged = true;
            }
        }
        if (!merged) break;
    }
    const frontA = new Float64Array(E);
    const frontB = new Float64Array(E);
    const mergedEdges: number[] = [];
    for (const e of g.edges) {
        if (short[e.id]) {
            mergedEdges.push(e.id);
            continue;
        }
        const cap = edgeLen[e.id] * MAX_FRONT_FRACTION;
        frontA[e.id] = Math.min(need[2 * e.id], cap);
        frontB[e.id] = Math.min(need[2 * e.id + 1], cap);
    }

    // How often each route ends under another bundle; drives the draw order.
    const endsUnder = new Map<string, number>();
    for (const e of g.edges) {
        if (short[e.id]) continue;
        for (const r of e.routes) {
            const ri = routeIndex.get(r)!;
            for (const end of [0, 1]) {
                const node = g.nodes[end === 0 ? e.a : e.b];
                if (!continues[(2 * e.id + end) * routeCount + ri] && node.ports.some((p) => p.edge !== e.id && g.edges[p.edge].routes.some((o) => o !== r))) {
                    endsUnder.set(r, (endsUnder.get(r) ?? 0) + 1);
                }
            }
        }
    }
    const drawOrder = [...g.routes.keys()].sort((x, y) => (endsUnder.get(y) ?? 0) - (endsUnder.get(x) ?? 0) || (x < y ? -1 : x > y ? 1 : 0));

    const st: ZoomState = {
        graph: g, zoom, scale, spacing, width, casing, smooth, openFolds, laneStyle, looks: new Map(),
        routeIndex, routeCount, offsets,
        simplePx, edgeLen, dirA, dirB,
        short, junctions, groups: new Array(junctions.length), tails: new Array(junctions.length),
        continues, frontA, frontB, mergedEdges, drawOrder,
        preparedPx: new Array(E),
        lanes: new Array(E * routeCount),
        lanePaths: new Array(E * routeCount),
        connPaths: new Map(),
    };
    return st;
}

function touchesView(j: Junction, inView: Uint8Array): boolean {
    for (const edge of j.edges) if (inView[edge]) return true;
    return false;
}

/** A junction's cliques and tails, planned once per zoom: neither depends on geometry. */
function planJunction(st: ZoomState, ji: number): {groups: ConnGroup[]; tails: TailPlan[]} {
    const known = st.groups[ji];
    if (known) return {groups: known, tails: st.tails[ji]!};
    const g = st.graph;
    const j = st.junctions[ji];
    const byKey = new Map<string, ConnGroup>();
    const groups: ConnGroup[] = [];
    for (const t of j.transitions) {
        const pu = j.ports[t.u];
        const pv = j.ports[t.v];
        const lateral = offsetTravel(st, pu.edge, t.route, pu.end === 'b');
        const lateralOut = offsetTravel(st, pv.edge, t.route, pv.end === 'a');
        // The connector runs a->b along u when it arrives at u's b end, and
        // along v when it leaves from v's a end.
        const tu = travelSign(g.edges[pu.edge].direction.get(t.route)) * (pu.end === 'b' ? 1 : -1);
        const tv = travelSign(g.edges[pv.edge].direction.get(t.route)) * (pv.end === 'a' ? 1 : -1);
        const key = `${pu.edge}:${pv.edge}:${(lateral - lateralOut).toFixed(3)}`;
        let grp = byKey.get(key);
        if (!grp) {
            grp = {edgeU: pu.edge, edgeV: pv.edge, members: []};
            byKey.set(key, grp);
            groups.push(grp);
        }
        grp.members.push({
            route: t.route, key: connKey(st, t.route, pu.edge, pu.end, pv.edge, pv.end), pu, pv,
            lateral, lateralOut, travel: (tu || tv) as 1 | -1 | 0, via: t.via,
        });
    }
    // Forks inside the junction: one route on two connectors over one merged edge.
    const crossings = new Map<string, ConnMember[]>();
    for (const grp of groups) {
        for (const m of grp.members) {
            for (const step of m.via) {
                const k = `${m.route}|${step.edge}`;
                const list = crossings.get(k);
                if (list) list.push(m);
                else crossings.set(k, [m]);
            }
        }
    }
    for (const list of crossings.values()) if (list.length > 1) for (const m of list) m.forked = true;
    const tails: TailPlan[] = [];
    for (const t of j.tails) {
        const p = j.ports[t.port];
        const far = t.edges[t.side === 'end' ? t.edges.length - 1 : 0];
        const step = t.edges[t.side === 'end' ? 0 : t.edges.length - 1];
        const travel = (travelSign(g.edges[p.edge].direction.get(t.route)) * (t.side === 'end' ? (p.end === 'b' ? 1 : -1) : (p.end === 'a' ? 1 : -1))) as 1 | -1 | 0;
        // Keyed in travel order: the end left by, then the end entered by.
        const plan: TailPlan = {
            tail: t, port: p, mode: 0,
            key: t.side === 'end'
                ? connKey(st, t.route, p.edge, p.end, far.edge, far.forward ? 'b' : 'a')
                : connKey(st, t.route, far.edge, far.forward ? 'a' : 'b', p.edge, p.end),
        };
        tails.push(plan);
        // The fallback Bezier to the nearest merged edge is a group of its own.
        const u = t.side === 'end' ? p.edge : step.edge;
        const v = t.side === 'end' ? step.edge : p.edge;
        groups.push({
            edgeU: u, edgeV: v,
            members: [{
                route: t.route, pu: p, pv: p, lateral: 0, lateralOut: 0, travel, via: [], plan,
                key: t.side === 'end' ? connKey(st, t.route, u, p.end, v, step.forward ? 'a' : 'b') : connKey(st, t.route, u, step.forward ? 'b' : 'a', v, p.end),
            }],
        });
    }
    st.groups[ji] = groups;
    st.tails[ji] = tails;
    return {groups, tails};
}

function laneKey(st: ZoomState, edge: number, route: string): number {
    return edge * st.routeCount + st.routeIndex.get(route)!;
}

/** Keyed by edge ends, not edges: parallel edges meet twice, and each turn needs its own connector. */
function connKey(st: ZoomState, route: string, edgeU: number, endU: 'a' | 'b', edgeV: number, endV: 'a' | 'b'): number {
    const ends = 2 * st.graph.edges.length;
    return ((edgeU * 2 + (endU === 'b' ? 1 : 0)) * ends + edgeV * 2 + (endV === 'b' ? 1 : 0)) * st.routeCount + st.routeIndex.get(route)!;
}

/** Lane offset of a route on an edge, signed in its direction of travel. */
function offsetTravel(st: ZoomState, edge: number, route: string, forward: boolean): number {
    const off = st.offsets[laneKey(st, edge, route)];
    return forward ? off : -off;
}

/** Whether a route continues through one end (0 = a, 1 = b) of an edge. */
function continuesThrough(st: ZoomState, edge: number, end: 0 | 1, route: string): boolean {
    return st.continues[(2 * edge + end) * st.routeCount + st.routeIndex.get(route)!] !== 0;
}

/** Interned, so paths with the same look share one object. */
function lookOf(st: ZoomState, e: GraphEdge, r: string): LaneLook {
    const meta = st.graph.routes.get(r);
    const over = st.laneStyle ? st.laneStyle(e, r) : null;
    const color = over?.color || meta?.color || '#888';
    const dash = over?.dash ?? meta?.dash;
    const dashColor = over?.dashColor ?? meta?.dashColor;
    const dashCap = over?.dashCap ?? meta?.dashCap;
    const key = `${color}|${dash ? dash[0] + ',' + dash[1] : ''}|${dashColor ?? ''}|${dashCap ?? ''}`;
    let look = st.looks.get(key);
    if (!look) st.looks.set(key, (look = {color, dash, dashColor, dashCap}));
    return look;
}

/** An edge's centerline in px: smoothed, re-simplified, and opened at tight folds. */
function preparedPx(st: ZoomState, edge: number): Polyline {
    let px = st.preparedPx[edge];
    if (!px) {
        const simple = st.simplePx[edge];
        px = st.smooth ? simplify(smoothCatmullRom(simple, SMOOTH_SEGMENT_PX, 10, 3, CORNER_BEND_DEG, CORNER_RADIUS_LANES * st.spacing), SIMPLIFY_TOLERANCE_PX) : simple;
        // A merged edge only guides slides, and a single lane overlaps nothing.
        const e = st.graph.edges[edge];
        if (st.openFolds && e.routes.length > 1 && !st.short[edge]) {
            const widest = ((e.routes.length - 1) / 2 + Math.abs(e.baseline ?? 0)) * st.spacing;
            // Kept a lane clear of the node fronts, where connectors start.
            px = openFolds(px, 2 * widest + st.width + 2 * st.casing, st.frontA[edge] + st.spacing, st.frontB[edge] + st.spacing);
        }
        st.preparedPx[edge] = px;
    }
    return px;
}

function orientedPx(st: ZoomState, edge: number, forward: boolean): Polyline {
    const px = preparedPx(st, edge);
    return forward ? px : reversed(px);
}

/** A merged edge's lane keeps its whole length: it is only drawn for routes that end on it. */
function laneOf(st: ZoomState, edge: number, route: string): Lane {
    const k = laneKey(st, edge, route);
    const hit = st.lanes[k];
    if (hit !== undefined) return hit;
    const g = st.graph;
    const e = g.edges[edge];
    const px = preparedPx(st, edge);
    let lane: Lane;
    if (st.short[edge]) {
        lane = offsetPolylineAnchored(px, st.offsets[k]);
    } else {
        const cutA = continuesThrough(st, edge, 0, route) ? st.frontA[edge] : 0;
        const cutB = continuesThrough(st, edge, 1, route) ? st.frontB[edge] : 0;
        const trimmed = cutA > 0 || cutB > 0 ? trimPolyline(px, cutA, cutB) : px;
        lane = e.order.length === 1 && st.offsets[k] !== 0
            ? easedSoloLane(trimmed, st.offsets[k], continuesThrough(st, edge, 0, route), continuesThrough(st, edge, 1, route), SOLO_EASE_LANES * st.spacing, st.spacing)
            : offsetPolylineAnchored(trimmed, st.offsets[k]);
        // A cut end sits a fixed pixel distance from its node, so it anchors there.
        const na = g.nodes[e.a], nb = g.nodes[e.b];
        if (cutA > 0) {
            lane.anchors[0] = na.x * st.scale;
            lane.anchors[1] = na.y * st.scale;
        }
        if (cutB > 0) {
            lane.anchors[lane.anchors.length - 2] = nb.x * st.scale;
            lane.anchors[lane.anchors.length - 1] = nb.y * st.scale;
        }
    }
    st.lanes[k] = lane;
    return lane;
}

/**
 * A solo lane holds its baseline shift at the ends its route continues through, where the fronts
 * were measured with it, and eases onto the path over `ease` px between. Not from the cited papers;
 * worked out for this project (see docs/algorithms.md).
 */
function easedSoloLane(line: Polyline, offset: number, holdA: boolean, holdB: boolean, ease: number, flat: number): Lane {
    if (!holdA && !holdB) return offsetPolylineAnchored(line, 0);
    // A connector sets off along the lane's last segment, so `flat` px at a held end keep the shift.
    const flatA = holdA ? flat : 0;
    const flatB = holdB ? flat : 0;
    const len = polylineLength(line) - flatA - flatB;
    if (len < 1) return offsetPolylineAnchored(line, offset);
    const inner = trimPolyline(line, flatA, flatB, 0);
    // An end that holds nothing still has to be reached at zero.
    const easeA = holdB ? ease : Math.min(ease, len);
    const easeB = holdA ? ease : Math.min(ease, len);
    const held = (t: number) => 1 - t * t * (3 - 2 * t);
    const at = (s: number) => offset * Math.max(
        holdA ? held(Math.min(1, s / easeA)) : 0,
        holdB ? held(Math.min(1, (len - s) / easeB)) : 0,
    );
    const slide = (piece: Polyline, s0: number, s1: number): Lane => {
        const steps = Math.max(1, Math.ceil(((s1 - s0) / ease) * SOLO_EASE_STEPS));
        const via: number[] = [];
        for (let i = 1; i < steps; i++) via.push(i / steps, at(s0 + ((s1 - s0) * i) / steps));
        return offsetPolylineSlidingAnchored(piece, at(s0), at(s1), 4, via);
    };
    const parts: Lane[] = [];
    if (flatA > 0) parts.push(offsetPolylineAnchored(firstPortion(line, flatA), offset));
    const headLen = holdA ? easeA : 0;
    const tailLen = holdB ? easeB : 0;
    if (headLen + tailLen > len - 1) {
        parts.push(slide(inner, 0, len));
    } else {
        if (headLen > 0) parts.push(slide(firstPortion(inner, headLen), 0, headLen));
        parts.push(offsetPolylineAnchored(trimPolyline(inner, headLen, tailLen, 0), 0));
        if (tailLen > 0) parts.push(slide(lastPortion(inner, tailLen), len - tailLen, len));
    }
    if (flatB > 0) parts.push(offsetPolylineAnchored(lastPortion(line, flatB), offset));
    const points: Polyline = [], anchors: Polyline = [];
    parts.forEach((part, i) => {
        // Each piece ends where the next begins.
        for (let j = i > 0 ? 2 : 0; j < part.points.length; j++) {
            points.push(part.points[j]);
            anchors.push(part.anchors[j]);
        }
    });
    return {points, anchors};
}

/** Null where the lane is too short to draw. */
function lanePathOf(st: ZoomState, edge: number, route: string): LanePath | null {
    const k = laneKey(st, edge, route);
    const hit = st.lanePaths[k];
    if (hit !== undefined) return hit;
    const lane = laneOf(st, edge, route);
    if (lane.points.length < 4) {
        st.lanePaths[k] = null;
        return null;
    }
    const e = st.graph.edges[edge];
    const path: LanePath = {
        route, look: lookOf(st, e, route), coords: lane.points, anchors: lane.anchors,
        kind: 'lane', travel: travelSign(e.direction.get(route)), startDistance: 0, edge,
    };
    st.lanePaths[k] = path;
    return path;
}

function guideOf(st: ZoomState, parts: Polyline[]): Polyline {
    const out: Polyline = [];
    for (const p of parts) {
        for (let i = 0; i < p.length; i += 2) {
            if (out.length && Math.abs(out[out.length - 2] - p[i]) < 1e-6 && Math.abs(out[out.length - 1] - p[i + 1]) < 1e-6) continue;
            out.push(p[i], p[i + 1]);
        }
    }
    return st.smooth ? simplify(smoothCatmullRom(out, SMOOTH_SEGMENT_PX, 10, 3, CORNER_BEND_DEG, CORNER_RADIUS_LANES * st.spacing), SIMPLIFY_TOLERANCE_PX) : out;
}

/** A tail slides as one piece (mode 1), or where that loops, falls back to lanes and a Bezier (2). */
function resolveTail(st: ZoomState, plan: TailPlan): void {
    if (plan.mode) return;
    plan.mode = 2;
    const g = st.graph;
    const t = plan.tail;
    const p = plan.port;
    const portLane = laneOf(st, p.edge, t.route);
    const parts = t.edges.map((s) => orientedPx(st, s.edge, s.forward));
    const far = t.edges[t.side === 'end' ? t.edges.length - 1 : 0];
    const farOffset = offsetTravel(st, far.edge, t.route, far.forward);
    const portOffset = offsetTravel(st, p.edge, t.route, t.side === 'end' ? p.end === 'b' : p.end === 'a');
    const portPx = preparedPx(st, p.edge);
    const portPart = t.side === 'end'
        ? lastPortion(p.end === 'b' ? portPx : reversed(portPx), p.end === 'b' ? st.frontB[p.edge] : st.frontA[p.edge])
        : firstPortion(p.end === 'a' ? portPx : reversed(portPx), p.end === 'a' ? st.frontA[p.edge] : st.frontB[p.edge]);
    const guide = t.side === 'end' ? guideOf(st, [portPart, ...parts]) : guideOf(st, [...parts, portPart]);
    const slide = t.side === 'end' ? offsetPolylineSlidingAnchored(guide, portOffset, farOffset) : offsetPolylineSlidingAnchored(guide, farOffset, portOffset);
    if (slide.points.length < 4) return;
    const coords = slide.points;
    const lanePts = t.side === 'end' ? (p.end === 'b' ? portLane.points : reversed(portLane.points)) : (p.end === 'a' ? portLane.points : reversed(portLane.points));
    if (t.side === 'end') {
        coords[0] = lanePts[lanePts.length - 2];
        coords[1] = lanePts[lanePts.length - 1];
    } else {
        coords[coords.length - 2] = lanePts[0];
        coords[coords.length - 1] = lanePts[1];
    }
    if (selfIntersects(coords)) return;
    const travel = travelSign(g.edges[p.edge].direction.get(t.route)) * (t.side === 'end' ? (p.end === 'b' ? 1 : -1) : (p.end === 'a' ? 1 : -1));
    const between: [number, number] = t.side === 'end' ? [p.edge, far.edge] : [far.edge, p.edge];
    st.connPaths.set(plan.key, {
        route: t.route, look: lookOf(st, g.edges[p.edge], t.route), coords, anchors: slide.anchors,
        kind: 'connector', travel: travel as 1 | -1 | 0, startDistance: 0, edge: between[0], node: p.node, between,
    });
    plan.mode = 1;
}

/**
 * As in LOOM's renderer, a clique's connectors are offsets of its longest, so lanes do not pinch
 * mid-turn. The reference is derived with every member, so a filtered route gets the same curve.
 */
function buildGroup(st: ZoomState, grp: ConnGroup): void {
    const plan = grp.members[0].plan;
    if (plan) {
        // A tail decides first: where it slides, its group draws nothing.
        resolveTail(st, plan);
        if (plan.mode === 1) return;
    }
    let missing = false;
    for (const m of grp.members) if (!st.connPaths.has(m.key)) missing = true;
    if (!missing) return;
    const g = st.graph;
    const clique: {member: ConnMember; lateral: number; own: Polyline; coords: Polyline; corner: boolean}[] = [];
    for (const m of grp.members) {
        // A refusal is kept as null, so a group is never built twice.
        st.connPaths.set(m.key, null);
        if (m.plan) {
            buildTailConnector(st, m, clique);
            continue;
        }
        const laneU = laneOf(st, m.pu.edge, m.route);
        const laneV = laneOf(st, m.pv.edge, m.route);
        const from = m.pu.end === 'b' ? laneU.points : reversed(laneU.points);
        const to = m.pv.end === 'a' ? laneV.points : reversed(laneV.points);
        if (m.via.length && buildViaConnector(st, m, from, to)) continue;
        const made = connector(from, to, st.spacing);
        if (made.coords.length < 4) continue;
        clique.push({member: m, lateral: m.lateral, own: made.coords, coords: made.coords, corner: made.corner});
    }
    // An offset of a corner is an arc, the sweep corners exist to avoid, so only arcs share one.
    const arcs = clique.filter((c) => !c.corner);
    if (arcs.length > 1) deriveCliqueConnectors(arcs, st.spacing);
    for (const c of clique) {
        const m = c.member;
        const conn = c.coords;
        // A connector is a pixel-sized feature, so every vertex anchors to its node.
        const node = g.nodes[m.pu.node];
        const anchors: Polyline = new Array(conn.length);
        for (let i = 0; i < conn.length; i += 2) {
            anchors[i] = node.x * st.scale;
            anchors[i + 1] = node.y * st.scale;
        }
        st.connPaths.set(m.key, {
            route: m.route, look: lookOf(st, g.edges[grp.edgeU], m.route), coords: conn, anchors,
            kind: 'connector', travel: m.travel, startDistance: 0, edge: grp.edgeU, node: m.pu.node, between: [grp.edgeU, grp.edgeV],
        });
    }
}

/** The Bezier of a tail that does not slide (see `resolveTail`). */
function buildTailConnector(st: ZoomState, m: ConnMember, clique: {member: ConnMember; lateral: number; own: Polyline; coords: Polyline; corner: boolean}[]): void {
    const t = m.plan!.tail;
    const p = m.pu;
    const step = t.edges[t.side === 'end' ? 0 : t.edges.length - 1];
    const portLane = laneOf(st, p.edge, t.route);
    const lane = laneOf(st, step.edge, t.route);
    const tailPts = step.forward ? lane.points : reversed(lane.points);
    const from = t.side === 'end' ? (p.end === 'b' ? portLane.points : reversed(portLane.points)) : tailPts;
    const to = t.side === 'end' ? tailPts : (p.end === 'a' ? portLane.points : reversed(portLane.points));
    const made = connector(from, to, st.spacing);
    if (made.coords.length < 4) return;
    clique.push({member: m, lateral: 0, own: made.coords, coords: made.coords, corner: made.corner});
}

/**
 * A connector over merged edges slides along their geometry from cut end to cut end; a Bezier
 * there overshoots or cuts corners. False, where the slide loops in a hairpin, hands it to the
 * plain Bezier. The loop check runs after snapping, which can pull an end across the path.
 */
function buildViaConnector(st: ZoomState, m: ConnMember, from: Polyline, to: Polyline): boolean {
    const g = st.graph;
    const centerline: Polyline = [];
    const append = (pts: Polyline) => {
        for (let i = 0; i < pts.length; i += 2) {
            if (centerline.length && Math.abs(centerline[centerline.length - 2] - pts[i]) < 1e-6 && Math.abs(centerline[centerline.length - 1] - pts[i + 1]) < 1e-6) continue;
            centerline.push(pts[i], pts[i + 1]);
        }
    };
    const uPx = preparedPx(st, m.pu.edge);
    const vPx = preparedPx(st, m.pv.edge);
    const middles: number[] = [];
    append(lastPortion(m.pu.end === 'b' ? uPx : reversed(uPx), m.pu.end === 'b' ? st.frontB[m.pu.edge] : st.frontA[m.pu.edge]));
    for (const step of m.via) {
        const before = polylineLength(centerline);
        append(orientedPx(st, step.edge, step.forward));
        middles.push((before + polylineLength(centerline)) / 2);
    }
    append(firstPortion(m.pv.end === 'a' ? vPx : reversed(vPx), m.pv.end === 'a' ? st.frontA[m.pv.edge] : st.frontB[m.pv.edge]));
    // A forked route's two connectors would run side by side over the merged edge, so they slide
    // by way of its lane at its middle. Tried on unforked ones, this moved more than it mended.
    const knots: number[] = [];
    if (m.forked) {
        const total = polylineLength(centerline);
        m.via.forEach((step, i) => knots.push(middles[i] / total, offsetTravel(st, step.edge, m.route, step.forward)));
        // Pull the knots toward the straight slide by degrees, not outright, until no piece is
        // steeper than `MAX_SLIDE_SLOPE`, so the connector does not jump at the limiting zoom.
        const straight = (at: number) => m.lateral + (m.lateralOut - m.lateral) * at;
        const steepest = (share: number) => {
            let at = 0, offset = m.lateral, most = 0;
            for (let k = 0; k <= knots.length; k += 2) {
                const next = k < knots.length ? knots[k] : 1;
                const nextOffset = k < knots.length ? straight(next) + (knots[k + 1] - straight(next)) * share : m.lateralOut;
                if (next > at) most = Math.max(most, Math.abs(nextOffset - offset) / ((next - at) * total));
                at = next;
                offset = nextOffset;
            }
            return most;
        };
        let share = 1;
        if (steepest(1) > MAX_SLIDE_SLOPE) {
            let lo = 0, hi = 1;
            for (let i = 0; i < 12; i++) {
                const mid = (lo + hi) / 2;
                if (steepest(mid) > MAX_SLIDE_SLOPE) hi = mid;
                else lo = mid;
            }
            share = lo;
        }
        for (let k = 0; k < knots.length; k += 2) knots[k + 1] = straight(knots[k]) + (knots[k + 1] - straight(knots[k])) * share;
    }
    // The edges were smoothed but the joints between them were not.
    const guide = st.smooth ? simplify(smoothCatmullRom(centerline, SMOOTH_SEGMENT_PX, 10, 3, CORNER_BEND_DEG, CORNER_RADIUS_LANES * st.spacing), SIMPLIFY_TOLERANCE_PX) : centerline;
    const slide = offsetPolylineSlidingAnchored(guide, m.lateral, m.lateralOut, 4, knots);
    if (slide.points.length < 4) return false;
    const coords = slide.points;
    // Snapped: the ends differ only by the normal at the cut point.
    coords[0] = from[from.length - 2];
    coords[1] = from[from.length - 1];
    coords[coords.length - 2] = to[0];
    coords[coords.length - 1] = to[1];
    if (selfIntersects(coords)) return false;
    st.connPaths.set(m.key, {
        route: m.route, look: lookOf(st, g.edges[m.pu.edge], m.route), coords, anchors: slide.anchors,
        kind: 'connector', travel: m.travel, startDistance: 0, edge: m.pu.edge, node: m.pu.node, between: [m.pu.edge, m.pv.edge],
    });
    return true;
}

/** A port of a junction: one end of an edge that is drawn (not merged into the junction). */
interface JunctionPort {
    edge: number;
    end: 'a' | 'b';
    node: number;
    /** Outward unit direction, leaving the junction along the edge. */
    dir: Vec;
    /** Half the bundle width on the edge, px. */
    hw: number;
}

/** A route's passage through a junction, from one port to another. */
interface JunctionTransition {
    route: string;
    u: number;
    v: number;
    /** The merged edges crossed on the way, in travel order, with whether travel runs a-to-b. */
    via: {edge: number; forward: boolean}[];
}

/** One node, or several joined by merged edges; its ports are the drawn edge ends there. */
interface Junction {
    ports: JunctionPort[];
    transitions: JunctionTransition[];
    tails: JunctionTail[];
    /** Every edge at its nodes, drawn or merged, for the viewport test. */
    edges: number[];
}

/** A route that starts or ends inside a junction (see `resolveTail`). */
interface JunctionTail {
    route: string;
    port: number;
    /** The merged edges in travel order, with whether travel runs a-to-b. */
    edges: {edge: number; forward: boolean}[];
    side: 'start' | 'end';
}

/** Group nodes joined by short edges and lift each route's transitions across them. */
function buildJunctions(g: LineGraph, short: Uint8Array, edgeLen: Float64Array, dirA: Vec[], dirB: Vec[], halfWidth: (e: GraphEdge) => number): Junction[] {
    const N = g.nodes.length;
    const parent = new Int32Array(N);
    for (let n = 0; n < N; n++) parent[n] = n;
    const find = (x: number): number => {
        while (parent[x] !== x) x = parent[x] = parent[parent[x]];
        return x;
    };
    for (const e of g.edges) if (short[e.id]) parent[find(e.a)] = find(e.b);
    const byRoot = new Map<number, Junction>();
    const junctionOf: Junction[] = new Array(N);
    // Port index of an edge end, at `edge * 2 + end`; -1 where the edge is merged.
    const portIndex = new Int32Array(2 * g.edges.length).fill(-1);
    for (let n = 0; n < N; n++) {
        const root = find(n);
        let j = byRoot.get(root);
        if (!j) byRoot.set(root, (j = {ports: [], transitions: [], tails: [], edges: []}));
        junctionOf[n] = j;
        for (const p of g.nodes[n].ports) {
            j.edges.push(p.edge);
            if (short[p.edge]) continue;
            portIndex[p.edge * 2 + (p.end === 'a' ? 0 : 1)] = j.ports.length;
            j.ports.push({edge: p.edge, end: p.end, node: n, dir: p.end === 'a' ? dirA[p.edge] : dirB[p.edge], hw: halfWidth(g.edges[p.edge])});
        }
    }
    // Every drawn edge a route comes out on, down each fork; `edge` is -1 where it ends.
    type Walk = {edge: number; end: 'a' | 'b'; node: number; walked: {edge: number; entryNode: number}[]};
    const follow = (route: string, edge: number, entryNode: number): Walk[] => {
        const found: Walk[] = [];
        const visit = (cur: number, curNode: number, walked: {edge: number; entryNode: number}[]) => {
            if (walked.some((w) => w.edge === cur)) return;
            const path = [...walked, {edge: cur, entryNode: curNode}];
            const e = g.edges[cur];
            const far = e.a === curNode ? e.b : e.a;
            const at = g.nodes[far];
            let onward = false;
            for (const t2 of at.transitions) {
                if (t2.route !== route || t2.from < 0 || t2.to < 0) continue;
                const pa = at.ports[t2.from];
                const pb = at.ports[t2.to];
                const next = pa.edge === cur && pb.edge !== cur ? pb : pb.edge === cur && pa.edge !== cur ? pa : null;
                if (!next) continue;
                onward = true;
                if (short[next.edge]) visit(next.edge, far, path);
                else found.push({edge: next.edge, end: next.end, node: far, walked: path});
            }
            if (!onward) found.push({edge: -1, end: 'a', node: far, walked: path});
        };
        visit(edge, entryNode, []);
        return found;
    };
    // A crossing is met from both of its drawn ends and kept once.
    const lifted = new Map<string, {index: number; length: number}>();
    const tailsSeen = new Set<string>();
    for (const node of g.nodes) {
        const j = junctionOf[node.id];
        // Ports are numbered within a junction, so the keys below carry it.
        const root = find(node.id);
        for (const t of node.transitions) {
            if (t.from < 0 || t.to < 0) continue;
            const from = node.ports[t.from];
            const to = node.ports[t.to];
            if (!short[from.edge] && !short[to.edge]) {
                const u = portIndex[from.edge * 2 + (from.end === 'a' ? 0 : 1)];
                const v = portIndex[to.edge * 2 + (to.end === 'a' ? 0 : 1)];
                if (u >= 0 && v >= 0) j.transitions.push({route: t.route, u, v, via: []});
                continue;
            }
            if (short[from.edge] && short[to.edge]) continue;
            // The drawn side walks whether it is `from` or `to`: beside a merged edge the graph can
            // make that edge `from` at both ends, and then neither end would walk.
            const inward = !short[from.edge];
            const drawn = inward ? from : to;
            const here = portIndex[drawn.edge * 2 + (drawn.end === 'a' ? 0 : 1)];
            if (here < 0) continue;
            for (const out of follow(t.route, (inward ? to : from).edge, node.id)) {
                // In the transition's order: `from` first.
                const steps = out.walked.map((w) => ({edge: w.edge, forward: g.edges[w.edge].a === w.entryNode}));
                const via = inward ? steps : steps.reverse().map((w) => ({edge: w.edge, forward: !w.forward}));
                if (out.edge < 0) {
                    const key = `${root}|${t.route}|${here}|${via.map((w) => w.edge).join(',')}`;
                    if (tailsSeen.has(key)) continue;
                    tailsSeen.add(key);
                    j.tails.push({route: t.route, port: here, side: inward ? 'end' : 'start', edges: via});
                    continue;
                }
                const there = portIndex[out.edge * 2 + (out.end === 'a' ? 0 : 1)];
                if (there < 0 || junctionOf[out.node] !== j) continue;
                // One crossing per pair of ports: the shorter way is kept.
                const key = `${root}|${t.route}|${Math.min(here, there)}|${Math.max(here, there)}`;
                const length = via.reduce((sum, w) => sum + edgeLen[w.edge], 0);
                const crossing = inward ? {route: t.route, u: here, v: there, via} : {route: t.route, u: there, v: here, via};
                const known = lifted.get(key);
                if (known) {
                    if (length < known.length) {
                        j.transitions[known.index] = crossing;
                        known.length = length;
                    }
                    continue;
                }
                lifted.set(key, {index: j.transitions.length, length});
                j.transitions.push(crossing);
            }
        }
    }
    return [...byRoot.values()];
}

/**
 * Uncapped cut-back per port, so bundles meeting at an angle do not overlap and lane changes get
 * room. Only ports a route continues through count: a lane that ends is tucked under.
 */
function junctionFronts(g: LineGraph, junctions: Junction[], laneOffsetTravel: (e: GraphEdge, r: string, forward: boolean) => number, spacing: number, routeIndex: Map<string, number>, routeCount: number): {need: Float64Array; change: Float64Array; continues: Uint8Array} {
    const need = new Float64Array(2 * g.edges.length);
    const change = new Float64Array(2 * g.edges.length);
    const continues = new Uint8Array(2 * g.edges.length * routeCount);
    const markContinues = (p: JunctionPort, route: string) => {
        continues[(2 * p.edge + (p.end === 'a' ? 0 : 1)) * routeCount + routeIndex.get(route)!] = 1;
    };
    for (const j of junctions) {
        const ports = j.ports;
        const portNeed = new Float64Array(ports.length);
        const active = new Uint8Array(ports.length);
        for (const t of j.transitions) {
            active[t.u] = 1;
            active[t.v] = 1;
            markContinues(ports[t.u], t.route);
            markContinues(ports[t.v], t.route);
        }
        for (const t of j.tails) {
            active[t.port] = 1;
            markContinues(ports[t.port], t.route);
        }
        for (let i = 0; i < ports.length; i++) {
            if (!active[i]) continue;
            for (let k = 0; k < ports.length; k++) {
                if (k === i || !active[k]) continue;
                const cos = ports[i].dir[0] * ports[k].dir[0] + ports[i].dir[1] * ports[k].dir[1];
                const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
                let t: number;
                if (sin < 1e-3) t = cos > 0 ? 6 * spacing : 0;
                else t = (ports[k].hw + ports[i].hw * cos) / sin;
                t = Math.max(0, t);
                if (t > 0) t += MIN_FRONT_MARGIN_LANES * spacing;
                portNeed[i] = Math.max(portNeed[i], Math.min(t, 8 * spacing));
            }
        }
        const portChange = new Float64Array(ports.length);
        for (const t of j.transitions) {
            const u = ports[t.u];
            const v = ports[t.v];
            const oIn = laneOffsetTravel(g.edges[u.edge], t.route, u.end === 'b');
            const oOut = laneOffsetTravel(g.edges[v.edge], t.route, v.end === 'a');
            const shift = Math.abs(oIn - oOut);
            if (shift < 1e-6) continue;
            const len = Math.max(2.5 * shift, 3 * spacing);
            portChange[t.u] = Math.max(portChange[t.u], len / 2);
            portChange[t.v] = Math.max(portChange[t.v], len / 2);
        }
        for (let i = 0; i < ports.length; i++) portNeed[i] = Math.max(portNeed[i], portChange[i]);
        ports.forEach((p, i) => (change[2 * p.edge + (p.end === 'a' ? 0 : 1)] = portChange[i]));
        for (const t of j.tails) {
            const p = ports[t.port];
            const first = t.edges[t.side === 'end' ? 0 : t.edges.length - 1];
            const oIn = laneOffsetTravel(g.edges[p.edge], t.route, p.end === 'b');
            const oOut = laneOffsetTravel(g.edges[first.edge], t.route, first.forward);
            const shift = Math.abs(oIn - oOut);
            if (shift < 1e-6) continue;
            portNeed[t.port] = Math.max(portNeed[t.port], Math.max(2.5 * shift, 3 * spacing) / 2);
        }
        ports.forEach((p, i) => (need[2 * p.edge + (p.end === 'a' ? 0 : 1)] = portNeed[i]));
    }
    return {need, change, continues};
}

/** The last `dist` px of a polyline, from an interpolated point; just the end point when dist is 0. */
function lastPortion(p: Polyline, dist: number): Polyline {
    const n = p.length / 2;
    if (dist <= 0 || n < 2) return [p[p.length - 2], p[p.length - 1]];
    const out: Polyline = [];
    let remaining = dist;
    for (let i = n - 1; i > 0; i--) {
        const ax = p[i * 2 - 2], ay = p[i * 2 - 1], bx = p[i * 2], by = p[i * 2 + 1];
        const l = Math.hypot(bx - ax, by - ay);
        out.unshift(bx, by);
        if (l >= remaining) {
            const f = 1 - remaining / l;
            out.unshift(ax + (bx - ax) * f, ay + (by - ay) * f);
            return out;
        }
        remaining -= l;
    }
    out.unshift(p[0], p[1]);
    return out;
}

/** The first `dist` px of a polyline, to an interpolated point; just the start point when dist is 0. */
function firstPortion(p: Polyline, dist: number): Polyline {
    return reversed(lastPortion(reversed(p), dist));
}

function travelSign(d: number | undefined): 1 | -1 | 0 {
    return d === 1 ? 1 : d === -1 ? -1 : 0;
}

/** Signed lane offset (px) of route r on edge e, positive = left of a->b travel. */
export function laneOffset(e: GraphEdge, r: string, spacing: number): number {
    const k = e.order.length;
    const p = e.order.indexOf(r);
    if (p < 0) return 0;
    return ((k - 1) / 2 - p + (e.baseline ?? 0)) * spacing;
}

/**
 * A member keeps its own curve when its offset of the reference is not a clean parallel: one of
 * length L + d * turning. A leftover loop or a too-deep loop cut shows as a length off that.
 */
function deriveCliqueConnectors(clique: {lateral: number; own: Polyline; coords: Polyline}[], spacing: number): void {
    let ref = clique[0];
    let refLen = polylineLength(ref.own);
    for (const c of clique) {
        const len = polylineLength(c.own);
        if (len > refLen) {
            ref = c;
            refLen = len;
        }
    }
    if (ref.own.length <= 4 || refLen < CLIQUE_MIN_REF_LANES * spacing) return;
    const turning = signedTurning(ref.own);
    for (const c of clique) {
        if (c === ref) continue;
        const d = c.lateral - ref.lateral;
        const expected = refLen + d * turning;
        if (expected < 0.25 * refLen) continue;
        const off = offsetPolyline(ref.own, d);
        if (off.length < 4) continue;
        const ratio = polylineLength(off) / expected;
        if (ratio > 1.1 || ratio < 0.9) continue;
        // A reference lane cut elsewhere parallels a different path; snapping would leave a spike.
        const gapStart = Math.hypot(off[0] - c.own[0], off[1] - c.own[1]);
        const gapEnd = Math.hypot(off[off.length - 2] - c.own[c.own.length - 2], off[off.length - 1] - c.own[c.own.length - 1]);
        if (gapStart > spacing / 2 || gapEnd > spacing / 2) continue;
        off[0] = c.own[0];
        off[1] = c.own[1];
        off[off.length - 2] = c.own[c.own.length - 2];
        off[off.length - 1] = c.own[c.own.length - 1];
        c.coords = off;
    }
}

/** Positive for right turns in y-down, where a positive (left) offset lies outside and grows. */
function signedTurning(p: Polyline): number {
    let total = 0;
    for (let i = 4; i < p.length; i += 2) {
        const ax = p[i - 2] - p[i - 4], ay = p[i - 1] - p[i - 3];
        const bx = p[i] - p[i - 2], by = p[i + 1] - p[i - 1];
        total += Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    }
    return total;
}

function connector(from: Polyline, to: Polyline, spacing: number): {coords: Polyline; corner: boolean} {
    const P: Vec = [from[from.length - 2], from[from.length - 1]];
    const Q: Vec = [to[0], to[1]];
    const tp = endDirection(from);
    const tqIn = startDirection(to);
    const tq: Vec = [-tqIn[0], -tqIn[1]];
    const chord = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    if (chord < 1e-6) return {coords: [], corner: false};
    const straight = Math.abs((Q[0] - P[0]) * tp[1] - (Q[1] - P[1]) * tp[0]) < 0.05 && tp[0] * tqIn[0] + tp[1] * tqIn[1] > 0.9999;
    if (straight) return {coords: [P[0], P[1], Q[0], Q[1]], corner: false};
    const corner = cornerTurn(P, tp, Q, tq, chord, spacing);
    if (corner) return {coords: corner, corner: true};
    const samples = Math.max(4, Math.min(32, Math.round(chord / Math.max(2, spacing / 3))));
    let coords = connectorCurve(P, tp, Q, tq, samples);
    // Only a curve with an end behind the other's heading can cross itself; shorter handles fix it.
    const ahead = (Q[0] - P[0]) * tp[0] + (Q[1] - P[1]) * tp[1];
    const aheadBack = (P[0] - Q[0]) * tq[0] + (P[1] - Q[1]) * tq[1];
    if (ahead < 0 || aheadBack < 0) {
        for (let scale = 0.5; scale > 0.1 && selfIntersects(coords); scale /= 2) coords = connectorCurve(P, tp, Q, tq, samples, scale);
    }
    return {coords, corner: false};
}

/** Null when the turn is gentle or the corner is a detour (see `CORNER_RADIUS_LANES`). */
function cornerTurn(P: Vec, tp: Vec, Q: Vec, tq: Vec, chord: number, spacing: number): Polyline | null {
    const I = intersectLines(P[0], P[1], P[0] + tp[0], P[1] + tp[1], Q[0], Q[1], Q[0] + tq[0], Q[1] + tq[1]);
    if (!I) return null;
    const t = (I[0] - P[0]) * tp[0] + (I[1] - P[1]) * tp[1];
    const u = (I[0] - Q[0]) * tq[0] + (I[1] - Q[1]) * tq[1];
    if (t <= 0.01 || u <= 0.01 || t + u > CORNER_MAX_REACH * chord) return null;
    const turn = (Math.acos(Math.max(-1, Math.min(1, -(tp[0] * tq[0] + tp[1] * tq[1])))) * 180) / Math.PI;
    if (turn < CORNER_MIN_TURN_DEG) return null;
    // The fillet is a quadratic with the corner as control point: tangent
    // to both lines where it leaves them, and never beyond the corner.
    const L = Math.min(CORNER_RADIUS_LANES * spacing, 0.45 * t, 0.45 * u);
    const A: Vec = [I[0] - tp[0] * L, I[1] - tp[1] * L];
    const B: Vec = [I[0] - tq[0] * L, I[1] - tq[1] * L];
    const out: Polyline = [P[0], P[1], A[0], A[1]];
    const steps = 8;
    for (let i = 1; i < steps; i++) {
        const s = i / steps, m = 1 - s;
        out.push(m * m * A[0] + 2 * m * s * I[0] + s * s * B[0], m * m * A[1] + 2 * m * s * I[1] + s * s * B[1]);
    }
    out.push(B[0], B[1], Q[0], Q[1]);
    return out;
}
