/**
 * Lane ordering. The objective is the metro-line node crossing minimization
 * (MLNCM) of Bast, Brosi & Storandt ("Efficient Generation of Geographically
 * Accurate Transit Maps", ACM TSAS 2019). The solver is this project's own
 * local search, which makes an ILP unnecessary at these sizes; see
 * docs/algorithms.md.
 */

import type {GraphEdge, LineGraph} from './graph.js';
import {startDirection, endDirection, ccwAngle, type Vec} from './geometry.js';

export interface OrderOptions {
    /** Two lines on the same edge swapping sides while continuing onto the same next edge. Default 4. */
    sameSegmentCrossing?: number;
    /** Two lines on one edge diverging onto different edges in the wrong order. Default 1. */
    diffSegmentCrossing?: number;
    /** Adjacent lines that continue together but are no longer adjacent. Default 3. */
    separation?: number;
    /** A line ending at a node while not being on the outside of its bundle. Default 0.5. */
    periphery?: number;
    /** Simulated-annealing moves before the descents, shared by the independent components in proportion to their size. Default: 400 per edge that carries more than one route, at least 10000; 0 disables. */
    annealMoves?: number;
    /** Seed for the deterministic PRNG. Default 42. */
    seed?: number;
    /** Order to start from, per edge id (see `seedFromSnapshot`). An entry may list only some of the edge's routes. */
    initial?: Map<number, string[]>;
    /** With `initial`: cost of each route pair that ends opposite to its initial order. Default 1. */
    stability?: number;
}

function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Cost terms per node, precomputed so the hot loop only reads lane positions.
 * Positions are seen looking outward, so an incoming edge (`out` 0) mirrors them.
 */
const SAME_NEXT = 0;
const DIFF_NEXT = 1;
const PERIPHERY = 2;

interface Terms {
    /** First term of each node; node n owns [start[n], start[n + 1]). */
    start: Int32Array;
    kind: Uint8Array;
    edge: Int32Array;
    out: Uint8Array;
    a: Int32Array;
    b: Int32Array;
    /** SAME_NEXT: the edge both routes continue onto, and whether it leaves the node. */
    next: Int32Array;
    nextOut: Uint8Array;
    /** DIFF_NEXT: 1 when route a must be on the left for the pair not to cross. */
    aLeft: Uint8Array;
}

interface TermBuf {
    kind: number[];
    edge: number[];
    out: number[];
    a: number[];
    b: number[];
    next: number[];
    nextOut: number[];
    aLeft: number[];
}

const permTables: number[][][] = [];
function permTable(k: number): number[][] {
    let t = permTables[k];
    if (t) return t;
    t = [];
    const rec = (rest: number[], m: number[]) => {
        if (!rest.length) {
            t.push(m);
            return;
        }
        for (let i = 0; i < rest.length; i++) rec(rest.slice(0, i).concat(rest.slice(i + 1)), m.concat(rest[i]));
    };
    rec(Array.from({length: k}, (_, i) => i), []);
    permTables[k] = t;
    return t;
}

export class LaneOrderer {
    private readonly g: LineGraph;
    private readonly w: Required<Pick<OrderOptions, 'sameSegmentCrossing' | 'diffSegmentCrossing' | 'separation' | 'periphery'>>;
    private readonly opts: OrderOptions;

    /** Route indices follow sorted ids, so comparing indices breaks ties as ids would. */
    private readonly routeIds: string[];
    private readonly routeIndex: Map<string, number>;
    private readonly lanes: Int32Array[];
    private readonly pos: (Int32Array | null)[];
    /** Port index of edge e at its a node (2e) and b node (2e + 1). */
    private readonly portAt: Int32Array;
    /** Per node and port, per route index: the ports the route continues to. */
    private readonly next: (number[] | undefined)[][][];
    private readonly terms: Terms;
    /** Per seeded edge: lane position of each route index in the initial order (-1 when unseeded). */
    private seedPos: (Int32Array | null)[] = [];
    private stability = 0;

    constructor(g: LineGraph, opts: OrderOptions = {}) {
        this.g = g;
        this.opts = opts;
        this.w = {
            sameSegmentCrossing: opts.sameSegmentCrossing ?? 4,
            diffSegmentCrossing: opts.diffSegmentCrossing ?? 1,
            separation: opts.separation ?? 3,
            periphery: opts.periphery ?? 0.5,
        };
        const ids = new Set<string>();
        for (const e of g.edges) for (const r of e.routes) ids.add(r);
        this.routeIds = [...ids].sort();
        this.routeIndex = new Map(this.routeIds.map((r, i) => [r, i]));
        const R = this.routeIds.length;
        this.lanes = g.edges.map((e) => new Int32Array(e.routes.length));
        this.pos = g.edges.map((e) => (e.routes.length > 1 ? new Int32Array(R).fill(-1) : null));
        this.portAt = new Int32Array(2 * g.edges.length).fill(-1);
        for (const n of g.nodes) n.ports.forEach((p, i) => (this.portAt[2 * p.edge + (p.end === 'a' ? 0 : 1)] = i));
        this.next = g.nodes.map((node) => {
            const next: (number[] | undefined)[][] = node.ports.map(() => []);
            for (const t of node.transitions) {
                if (t.from < 0 || t.to < 0 || t.from === t.to) continue;
                const r = this.routeIndex.get(t.route);
                if (r === undefined) continue;
                for (const [a, b] of [[t.from, t.to], [t.to, t.from]]) {
                    const l = next[a][r] ?? (next[a][r] = []);
                    if (!l.includes(b)) l.push(b);
                }
            }
            return next;
        });
        this.terms = this.buildTerms();
        this.load();
    }

    private buildTerms(): Terms {
        const g = this.g;
        const buf: TermBuf = {kind: [], edge: [], out: [], a: [], b: [], next: [], nextOut: [], aLeft: []};
        const start = new Int32Array(g.nodes.length + 1);
        g.nodes.forEach((node, n) => {
            start[n] = buf.kind.length;
            const np = node.ports.length;
            const dirs: Vec[] = node.ports.map((p) => {
                const e = g.edges[p.edge];
                return p.end === 'a' ? startDirection(e.coords) : (endDirection(e.coords).map((v) => -v) as Vec);
            });
            const ccw = new Float64Array(np * np);
            for (let i = 0; i < np; i++) for (let j = 0; j < np; j++) ccw[i * np + j] = ccwAngle(dirs[i], dirs[j]);
            for (let pi = 0; pi < np; pi++) {
                const port = node.ports[pi];
                const e = g.edges[port.edge];
                const k = e.routes.length;
                if (k < 2) continue;
                const out = port.end === 'a' ? 1 : 0;
                const nextOf = this.next[n][pi];
                const routes = e.routes.map((r) => this.routeIndex.get(r)!);
                for (let i = 0; i < k; i++) {
                    const a = routes[i];
                    const aNexts = nextOf[a];
                    if (!aNexts || !aNexts.length) {
                        push(buf, PERIPHERY, e.id, out, a, -1, -1, 0, 0);
                        continue;
                    }
                    for (let j = i + 1; j < k; j++) {
                        const b = routes[j];
                        const bNexts = nextOf[b];
                        if (!bNexts || !bNexts.length) continue;
                        for (const aNext of aNexts) {
                            for (const bNext of bNexts) {
                                if (aNext === bNext) {
                                    // The pair is seen from both ports; charge it from the lower one.
                                    if (aNext < pi) continue;
                                    const f = node.ports[aNext];
                                    push(buf, SAME_NEXT, e.id, out, a, b, f.edge, f.end === 'a' ? 1 : 0, 0);
                                } else {
                                    // Looking outward, the route whose next edge is the smaller
                                    // counter-clockwise sweep away must be on the left.
                                    const aLeft = ccw[pi * np + aNext] < ccw[pi * np + bNext] ? 1 : 0;
                                    push(buf, DIFF_NEXT, e.id, out, a, b, -1, 0, aLeft);
                                }
                            }
                        }
                    }
                }
            }
        });
        start[g.nodes.length] = buf.kind.length;
        return {
            start,
            kind: Uint8Array.from(buf.kind),
            edge: Int32Array.from(buf.edge),
            out: Uint8Array.from(buf.out),
            a: Int32Array.from(buf.a),
            b: Int32Array.from(buf.b),
            next: Int32Array.from(buf.next),
            nextOut: Uint8Array.from(buf.nextOut),
            aLeft: Uint8Array.from(buf.aLeft),
        };
    }

    /** Read every edge's `order` into the solver state (sorted route ids where it is unusable). */
    private load(): void {
        this.g.edges.forEach((e, i) => {
            const order = e.order.length === e.routes.length && sameSet(e.order, e.routes) ? e.order : e.routes.slice().sort();
            this.setLanes(i, order.map((r) => this.routeIndex.get(r)!));
        });
    }

    private store(): void {
        this.g.edges.forEach((e, i) => (e.order = Array.from(this.lanes[i], (r) => this.routeIds[r])));
    }

    private setLanes(e: number, routes: ArrayLike<number>): void {
        const lanes = this.lanes[e];
        lanes.set(routes);
        const pos = this.pos[e];
        if (pos) for (let i = 0; i < lanes.length; i++) pos[lanes[i]] = i;
    }

    /** Cost contributed by one node under the current edge orders. */
    nodeCost(nodeId: number): number {
        this.load();
        return this.evalNode(nodeId);
    }

    totalCost(): number {
        this.load();
        return this.evalAll();
    }

    private evalAll(): number {
        let c = 0;
        for (let i = 0; i < this.g.nodes.length; i++) c += this.evalNode(i);
        return c;
    }

    private evalNode(n: number): number {
        const t = this.terms;
        const w = this.w;
        let cost = 0;
        for (let i = t.start[n], end = t.start[n + 1]; i < end; i++) {
            const e = t.edge[i];
            const pos = this.pos[e]!;
            const k = this.lanes[e].length;
            let pa = pos[t.a[i]];
            if (!t.out[i]) pa = k - 1 - pa;
            const kind = t.kind[i];
            if (kind === PERIPHERY) {
                if (pa !== 0 && pa !== k - 1) cost += w.periphery;
                continue;
            }
            let pb = pos[t.b[i]];
            if (!t.out[i]) pb = k - 1 - pb;
            const aLeft = pa < pb;
            if (kind === DIFF_NEXT) {
                if ((t.aLeft[i] === 1) !== aLeft) cost += w.diffSegmentCrossing;
                continue;
            }
            const f = t.next[i];
            const fpos = this.pos[f]!;
            let fa = fpos[t.a[i]];
            let fb = fpos[t.b[i]];
            if (!t.nextOut[i]) {
                const kf = this.lanes[f].length;
                fa = kf - 1 - fa;
                fb = kf - 1 - fb;
            }
            // Seen outward from both ports, a pair that keeps its sides has
            // flipped order, so the same order is a crossing.
            if ((fa < fb) === aLeft) cost += w.sameSegmentCrossing;
            else if (Math.abs(pa - pb) === 1 && Math.abs(fa - fb) !== 1) cost += w.separation;
        }
        return cost;
    }

    private edgeLocalCost(e: number): number {
        const edge = this.g.edges[e];
        const nodes = edge.a === edge.b ? this.evalNode(edge.a) : this.evalNode(edge.a) + this.evalNode(edge.b);
        return nodes + this.edgePenalty(e);
    }

    private edgePenalty(e: number): number {
        const sp = this.seedPos[e];
        if (!sp) return 0;
        const lanes = this.lanes[e];
        let inversions = 0;
        for (let i = 0; i < lanes.length; i++) {
            const sa = sp[lanes[i]];
            if (sa < 0) continue;
            for (let j = i + 1; j < lanes.length; j++) {
                const sb = sp[lanes[j]];
                if (sb >= 0 && sb < sa) inversions++;
            }
        }
        return inversions * this.stability;
    }

    /** Try every permutation (k <= 6) or pairwise swaps (larger k) of one edge; keep the best. */
    private optimizeEdge(e: number): boolean {
        const lanes = this.lanes[e];
        const k = lanes.length;
        if (k < 2) return false;
        const startCost = this.edgeLocalCost(e);
        let best = lanes.slice();
        let bestCost = startCost;
        if (k <= 6) {
            const base = lanes.slice();
            const scratch = new Int32Array(k);
            for (const p of permTable(k)) {
                for (let i = 0; i < k; i++) scratch[i] = base[p[i]];
                this.setLanes(e, scratch);
                const c = this.edgeLocalCost(e);
                if (c < bestCost - 1e-9 || (Math.abs(c - bestCost) < 1e-9 && lexLess(scratch, best))) {
                    bestCost = c;
                    best = scratch.slice();
                }
            }
        } else {
            let improved = true;
            while (improved) {
                improved = false;
                for (let i = 0; i < k; i++) {
                    for (let j = i + 1; j < k; j++) {
                        const p = best.slice();
                        const tmp = p[i];
                        p[i] = p[j];
                        p[j] = tmp;
                        this.setLanes(e, p);
                        const c = this.edgeLocalCost(e);
                        if (c < bestCost - 1e-9) {
                            bestCost = c;
                            best = p;
                            improved = true;
                        }
                    }
                }
            }
        }
        this.setLanes(e, best);
        return bestCost < startCost - 1e-9;
    }

    private descend(comp: Component): number {
        let changed = true;
        let rounds = 0;
        while (changed && rounds++ < 100) {
            changed = false;
            for (const e of comp.edges) if (this.optimizeEdge(e)) changed = true;
        }
        return this.componentCost(comp);
    }

    private componentCost(comp: Component): number {
        let c = 0;
        for (const n of comp.nodes) c += this.evalNode(n);
        if (this.seedPos.length) for (const e of comp.edges) c += this.edgePenalty(e);
        return c;
    }

    /** Swap along every connected edge where the pair stays adjacent, so a crossing moves as a whole. */
    private swapAlong(e: number, i: number, touched: number[], stamp: number): void {
        const g = this.g;
        const a = this.lanes[e][i];
        const b = this.lanes[e][i + 1];
        const stack = this.stack;
        const edgeStamp = this.edgeStamp;
        stack.length = 0;
        stack.push(e);
        while (stack.length) {
            const cur = stack.pop()!;
            const pos = this.pos[cur];
            if (!pos || edgeStamp[cur] === stamp) continue;
            edgeStamp[cur] = stamp;
            const ia = pos[a];
            const ib = pos[b];
            if (ia < 0 || ib < 0 || Math.abs(ia - ib) !== 1) continue;
            touched.push(cur);
            this.swapPair(cur, a, b);
            const edge = g.edges[cur];
            for (let end = 0; end < 2; end++) {
                const nodeId = end === 0 ? edge.a : edge.b;
                const pi = this.portAt[2 * cur + end];
                if (pi < 0) continue;
                const nextOf = this.next[nodeId][pi];
                const na = nextOf[a];
                const nb = nextOf[b];
                if (!na || !nb) continue;
                for (const p of na) if (nb.includes(p)) stack.push(g.nodes[nodeId].ports[p].edge);
            }
        }
    }

    private swapPair(e: number, a: number, b: number): void {
        const pos = this.pos[e]!;
        const lanes = this.lanes[e];
        const ia = pos[a];
        const ib = pos[b];
        lanes[ia] = b;
        lanes[ib] = a;
        pos[a] = ib;
        pos[b] = ia;
    }

    private stack: number[] = [];
    private edgeStamp = new Uint32Array(0);
    private nodeStamp = new Uint32Array(0);
    private stamp = 0;
    private nodeCache = new Float64Array(0);
    private nodeFresh = new Float64Array(0);

    private anneal(comp: Component, moves: number, rand: () => number): void {
        const g = this.g;
        const candidates = comp.edges;
        if (moves <= 0) return;
        // Measured on the fixtures: a hot start and a warm finish both lower
        // the final cost, but the budget matters more than either.
        const T0 = 5;
        const T1 = 0.3;
        const decay = Math.pow(T1 / T0, 1 / moves);
        const cache = this.nodeCache;
        const fresh = this.nodeFresh;
        const nodeStamp = this.nodeStamp;
        for (const n of comp.nodes) cache[n] = this.evalNode(n);
        const touched: number[] = [];
        const touchedNodes: number[] = [];
        let T = T0;
        for (let m = 0; m < moves; m++, T *= decay) {
            const e = candidates[Math.floor(rand() * candidates.length)];
            const i = Math.floor(rand() * (this.lanes[e].length - 1));
            const a = this.lanes[e][i];
            const b = this.lanes[e][i + 1];
            const stamp = ++this.stamp;
            touched.length = 0;
            this.swapAlong(e, i, touched, stamp);
            touchedNodes.length = 0;
            for (const t of touched) {
                const edge = g.edges[t];
                if (nodeStamp[edge.a] !== stamp) {
                    nodeStamp[edge.a] = stamp;
                    touchedNodes.push(edge.a);
                }
                if (nodeStamp[edge.b] !== stamp) {
                    nodeStamp[edge.b] = stamp;
                    touchedNodes.push(edge.b);
                }
            }
            let delta = 0;
            for (const n of touchedNodes) {
                fresh[n] = this.evalNode(n);
                delta += fresh[n] - cache[n];
            }
            if (this.stability > 0) {
                // Each swapped edge gains or loses one inversion against its seed.
                for (const t of touched) {
                    const sp = this.seedPos[t];
                    if (!sp || sp[a] < 0 || sp[b] < 0) continue;
                    const pos = this.pos[t]!;
                    delta += (pos[a] < pos[b]) === (sp[a] < sp[b]) ? -this.stability : this.stability;
                }
            }
            if (delta <= 0 || rand() < Math.exp(-delta / T)) {
                for (const n of touchedNodes) cache[n] = fresh[n];
            } else {
                for (const t of touched) this.swapPair(t, a, b);
            }
        }
    }

    /** Multi-route edges in groups that share no node, each an independent problem; sorted for determinism. */
    private components(): Component[] {
        const g = this.g;
        const E = g.edges.length;
        const parent = new Int32Array(E);
        for (let e = 0; e < E; e++) parent[e] = e;
        const find = (x: number): number => {
            while (parent[x] !== x) x = parent[x] = parent[parent[x]];
            return x;
        };
        for (const node of g.nodes) {
            let first = -1;
            for (const p of node.ports) {
                if (this.lanes[p.edge].length < 2) continue;
                if (first < 0) first = p.edge;
                else parent[find(p.edge)] = find(first);
            }
        }
        const byRoot = new Map<number, Component>();
        for (let e = 0; e < E; e++) {
            if (this.lanes[e].length < 2) continue;
            const r = find(e);
            let c = byRoot.get(r);
            if (!c) byRoot.set(r, (c = {edges: [], nodes: []}));
            c.edges.push(e);
        }
        const comps = [...byRoot.values()];
        for (const c of comps) {
            const nodes = new Set<number>();
            for (const e of c.edges) {
                nodes.add(g.edges[e].a);
                nodes.add(g.edges[e].b);
            }
            c.nodes = [...nodes].sort((x, y) => x - y);
        }
        return comps.sort((x, y) => y.edges.length - x.edges.length || x.edges[0] - y.edges[0]);
    }

    /** Timing of the last solve, ms, for diagnostics. */
    timings = {greedy: 0, anneal: 0, descend: 0};

    /** Assign orders on all edges. Returns the final cost. */
    solve(): number {
        const tStart = performance.now();
        const g = this.g;
        const rand = mulberry32(this.opts.seed ?? 42);
        const seeded = !!this.opts.initial && this.opts.initial.size > 0;
        this.seedPos = g.edges.map(() => null);
        this.stability = seeded ? (this.opts.stability ?? 1) : 0;
        for (const e of g.edges) {
            const init = this.opts.initial?.get(e.id)?.filter((r) => e.routes.includes(r));
            if (!init || !init.length) {
                e.order = e.routes.slice().sort();
                continue;
            }
            e.order = init.concat(e.routes.filter((r) => !init.includes(r)).sort());
            if (e.routes.length > 1) {
                const sp = new Int32Array(this.routeIds.length).fill(-1);
                init.forEach((r, i) => (sp[this.routeIndex.get(r)!] = i));
                this.seedPos[e.id] = sp;
            }
        }
        this.load();
        this.edgeStamp = new Uint32Array(g.edges.length);
        this.nodeStamp = new Uint32Array(g.nodes.length);
        this.nodeCache = new Float64Array(g.nodes.length);
        this.nodeFresh = new Float64Array(g.nodes.length);
        this.stamp = 0;
        // A seed is already a coherent arrangement, so it skips greedy propagation.
        const seen = new Set<number>(seeded ? g.edges.map((e) => e.id) : []);
        const queue = g.edges.slice().sort((x, y) => y.routes.length - x.routes.length || x.id - y.id);
        const frontier: number[] = [];
        for (const start of queue) {
            if (seen.has(start.id)) continue;
            frontier.push(start.id);
            while (frontier.length) {
                const id = frontier.shift()!;
                if (seen.has(id)) continue;
                seen.add(id);
                this.optimizeEdge(id);
                const e = g.edges[id];
                for (const n of [e.a, e.b]) for (const p of g.nodes[n].ports) if (!seen.has(p.edge)) frontier.push(p.edge);
            }
        }
        const timings = {greedy: performance.now() - tStart, anneal: 0, descend: 0};
        const comps = this.components();
        const candidates = comps.reduce((s, c) => s + c.edges.length, 0);
        const totalMoves = this.opts.annealMoves ?? Math.max(10000, 400 * candidates);
        for (const comp of comps) {
            let t = performance.now();
            // A seeded solve must not end worse than its seed, so the descended
            // seed is kept unless the annealing beats it.
            let bestCost = Infinity;
            let best: Int32Array[] = [];
            if (seeded) {
                bestCost = this.descend(comp);
                best = comp.edges.map((e) => this.lanes[e].slice());
            }
            timings.descend += performance.now() - t;
            t = performance.now();
            if (bestCost > 0) this.anneal(comp, Math.ceil((totalMoves * comp.edges.length) / candidates), rand);
            timings.anneal += performance.now() - t;
            t = performance.now();
            const c = this.descend(comp);
            if (c < bestCost - 1e-9) {
                bestCost = c;
                best = comp.edges.map((e) => this.lanes[e].slice());
            } else {
                best.forEach((l, i) => this.setLanes(comp.edges[i], l));
            }
            timings.descend += performance.now() - t;
        }
        this.store();
        this.timings = timings;
        return this.evalAll();
    }
}

interface Component {
    /** Edge ids, ascending. */
    edges: number[];
    /** Nodes the edges touch, ascending. */
    nodes: number[];
}

function push(buf: TermBuf, kind: number, edge: number, out: number, a: number, b: number, next: number, nextOut: number, aLeft: number): void {
    buf.kind.push(kind);
    buf.edge.push(edge);
    buf.out.push(out);
    buf.a.push(a);
    buf.b.push(b);
    buf.next.push(next);
    buf.nextOut.push(nextOut);
    buf.aLeft.push(aLeft);
}

function sameSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    const s = new Set(a);
    return b.every((x) => s.has(x));
}

function lexLess(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
    for (let i = 0; i < a.length; i++) {
        if (a[i] < b[i]) return true;
        if (a[i] > b[i]) return false;
    }
    return false;
}

/** Order the graph's lanes in place. Returns the final cost. */
export function orderLanes(g: LineGraph, opts?: OrderOptions): number {
    return new LaneOrderer(g, opts).solve();
}

/** Lane orders and baselines keyed by edge geometry, reapplicable to a graph built from the same data. */
export interface LaneOrderSnapshot {
    version: 3;
    edges: Record<string, {order: string[]; baseline?: number}>;
}

/**
 * The middle vertex separates parallel edges, such as two loops on one node.
 * The key reads from the lesser end because which end is `a` follows input
 * feature order; a `flipped` edge stores its order reversed and baseline negated.
 */
function snapshotKey(e: GraphEdge): {key: string; flipped: boolean} {
    const c = e.coords;
    const n = c.length / 2;
    const cmp = (i: number, j: number) => c[2 * i] - c[2 * j] || c[2 * i + 1] - c[2 * j + 1];
    // A loop starts and ends at one node: its second vertex decides.
    const d = cmp(0, n - 1) || (n > 2 ? cmp(1, n - 2) : 0);
    const flipped = d > 0;
    const v = (i: number) => {
        const k = flipped ? n - 1 - i : i;
        return `${c[2 * k].toFixed(9)},${c[2 * k + 1].toFixed(9)}`;
    };
    return {key: `${v(0)}|${v(Math.floor(n / 2))}|${v(n - 1)}`, flipped};
}

export function snapshotLaneOrders(g: LineGraph): LaneOrderSnapshot {
    const edges: LaneOrderSnapshot['edges'] = {};
    for (const e of g.edges) {
        const {key, flipped} = snapshotKey(e);
        const baseline = e.baseline === undefined ? undefined : flipped ? -e.baseline : e.baseline;
        edges[key] = {order: flipped ? e.order.slice().reverse() : e.order.slice(), baseline};
    }
    return {version: 3, edges};
}

/** A snapshot may come from storage or another version, so its shape is not trusted. */
function snapshotEntry(snap: LaneOrderSnapshot, e: GraphEdge): {order: string[]; baseline?: number} | null {
    const edges = (snap as Partial<LaneOrderSnapshot> | null)?.version === 3 ? snap.edges : null;
    if (!edges || typeof edges !== 'object') return null;
    const {key, flipped} = snapshotKey(e);
    const hit: unknown = Object.hasOwn(edges, key) ? edges[key] : null;
    const order = (hit as {order?: unknown} | null)?.order;
    if (!Array.isArray(order) || !order.every((r) => typeof r === 'string') || new Set(order).size !== order.length) return null;
    const b = (hit as {baseline?: unknown}).baseline;
    const baseline = typeof b === 'number' && Number.isFinite(b) ? (flipped ? -b : b) : undefined;
    return {order: flipped ? order.slice().reverse() : order, baseline};
}

/**
 * Apply a snapshot. Returns the number of edges restored exactly. An edge
 * whose route set shrank keeps the relative order of the remaining routes.
 */
export function applyLaneOrders(g: LineGraph, snap: LaneOrderSnapshot): number {
    let n = 0;
    for (const e of g.edges) {
        const hit = snapshotEntry(snap, e);
        const kept = hit ? hit.order.filter((r) => e.routes.includes(r)) : [];
        e.order = kept.concat(e.routes.filter((r) => !kept.includes(r)).sort());
        const exact = kept.length === e.routes.length && kept.length === hit?.order.length;
        e.baseline = exact ? hit!.baseline : undefined;
        if (exact) n++;
    }
    return n;
}

/** An `OrderOptions.initial` map from a snapshot. */
export function seedFromSnapshot(g: LineGraph, snap: LaneOrderSnapshot): Map<number, string[]> {
    const initial = new Map<number, string[]>();
    for (const e of g.edges) {
        const hit = snapshotEntry(snap, e);
        if (!hit) continue;
        const kept = hit.order.filter((r) => e.routes.includes(r));
        if (kept.length) initial.set(e.id, kept);
    }
    return initial;
}
