/**
 * Stable lanes: a clamped per-edge baseline (in lanes) that cancels the jog
 * a centered bundle makes when it gains or loses a route. Minimizes L1
 * lateral movement by coordinate descent with weighted medians. Not from
 * the cited papers; see docs/algorithms.md.
 */

import type {LineGraph} from './graph.js';

export interface StabilizeOptions {
    /** Max |baseline| in lanes. Default 0.5, which absorbs a parity change without moving any lane. */
    maxDrift?: number;
    /** Weight of the pull toward the centered position. Default 0.001. */
    driftWeight?: number;
    /** Rounds of coordinate descent; it stops early once nothing moves. Default 60. */
    iterations?: number;
}

/** Position of route r on an edge in lanes before the baseline, positive = left of a->b. */
function centredPos(order: string[], r: string): number {
    const k = order.length;
    return (k - 1) / 2 - order.indexOf(r);
}

export function stabilizeLanes(g: LineGraph, opts: StabilizeOptions = {}): void {
    const maxDrift = opts.maxDrift ?? 0.5;
    const driftWeight = opts.driftWeight ?? 0.001;
    const iterations = opts.iterations ?? 60;
    const E = g.edges.length;
    const b = new Float64Array(E);

    // Per transition u -> v: s_u * (pos_u + b_u) = s_v * (pos_v + b_v), s = +1 when traveling a->b.
    interface Term {
        other: number;
        coef: number;
        constant: number;
    }
    const terms: Term[][] = g.edges.map(() => []);
    for (const node of g.nodes) {
        for (const t of node.transitions) {
            if (t.from < 0 || t.to < 0) continue;
            const pu = node.ports[t.from];
            const pv = node.ports[t.to];
            const u = g.edges[pu.edge];
            const v = g.edges[pv.edge];
            if (u === v) continue;
            const su = pu.end === 'b' ? 1 : -1; // arrives traveling a->b
            const sv = pv.end === 'a' ? 1 : -1; // leaves traveling a->b
            const posU = centredPos(u.order, t.route);
            const posV = centredPos(v.order, t.route);
            terms[u.id].push({other: v.id, coef: sv / su, constant: (sv * posV - su * posU) / su});
            terms[v.id].push({other: u.id, coef: su / sv, constant: (su * posU - sv * posV) / sv});
        }
    }

    const clamp = (x: number) => Math.max(-maxDrift, Math.min(maxDrift, x));
    for (let it = 0; it < iterations; it++) {
        let moved = 0;
        for (let e = 0; e < E; e++) {
            const ts = terms[e];
            if (!ts.length) {
                b[e] = 0;
                continue;
            }
            // Weighted median of the targets: each transition weighs 1, the center driftWeight.
            const targets: {v: number; w: number}[] = ts.map((t) => ({v: t.coef * b[t.other] + t.constant, w: 1}));
            targets.push({v: 0, w: driftWeight});
            targets.sort((x, y) => x.v - y.v);
            const total = targets.reduce((s, t) => s + t.w, 0);
            let acc = 0;
            let median = 0;
            for (const t of targets) {
                acc += t.w;
                if (acc >= total / 2) {
                    median = t.v;
                    break;
                }
            }
            const next = clamp(median);
            moved += Math.abs(next - b[e]);
            b[e] = next;
        }
        if (moved < 1e-9) break;
    }
    g.edges.forEach((e, i) => (e.baseline = b[i]));
}

/** Total lateral movement in lanes over all transitions, for diagnostics. */
export function lateralMovement(g: LineGraph): number {
    let sum = 0;
    for (const node of g.nodes) {
        for (const t of node.transitions) {
            if (t.from < 0 || t.to < 0) continue;
            const pu = node.ports[t.from];
            const pv = node.ports[t.to];
            const u = g.edges[pu.edge];
            const v = g.edges[pv.edge];
            const su = pu.end === 'b' ? 1 : -1;
            const sv = pv.end === 'a' ? 1 : -1;
            sum += Math.abs(su * (centredPos(u.order, t.route) + (u.baseline ?? 0)) - sv * (centredPos(v.order, t.route) + (v.baseline ?? 0)));
        }
    }
    return sum;
}
