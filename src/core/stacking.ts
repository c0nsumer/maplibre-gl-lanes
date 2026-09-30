/**
 * Which routes draw above which. The renderer draws each route in one pass, in one order for the
 * whole map, so a route that crosses a group of lanes turning together can fall between them in
 * that order, and then passes over one lane of the group and under the next. This picks the order
 * of the routes involved so each of them is above its whole group or below it. It is worked out
 * from the graph and its lane orders, not from drawn geometry, so it is the same at every zoom.
 * It does not come from the papers cited in docs/algorithms.md; it was worked out for this
 * project.
 */

import type {LineGraph} from './graph.js';
import {startDirection, endDirection, ccwAngle, type Vec} from './geometry.js';

/** The search doubles with every route involved; past this it is left to the base order. */
const MAX_ROUTES = 16;
/** One route woven through a group outweighs any number of lane ends drawn over a bundle. */
const WEAVE_COST = 1000;
const END_OVER_COST = 1;
/** Small enough to decide only between orders that are otherwise equal. */
const MOVE_COST = 0.001;

interface Stacking {
    signature: string;
    /** The routes involved, bottom first; empty where no route crosses a group. */
    order: string[];
}

const cache = new WeakMap<LineGraph, Stacking>();

/**
 * `base` with the routes that cross groups put in an order that weaves none of them, each in a
 * place one of them held in `base`. Every other route keeps its place.
 */
export function restack(g: LineGraph, base: string[]): string[] {
    const stack = stackingOf(g).order;
    if (!stack.length) return base;
    const involved = new Set(stack);
    let next = 0;
    return base.map((r) => (involved.has(r) ? stack[next++] : r));
}

function stackingOf(g: LineGraph): Stacking {
    // The lane orders decide which routes cross, so a re-order makes the answer stale.
    let signature = '';
    for (const e of g.edges) if (e.order.length > 1) signature += `${e.id}:${e.order.join(',')};`;
    const known = cache.get(g);
    if (known && known.signature === signature) return known;
    const made = {signature, order: solve(g)};
    cache.set(g, made);
    return made;
}

function solve(g: LineGraph): string[] {
    const weaves: {group: string[]; across: string}[] = [];
    const endsUnder: [string, string][] = [];
    const endsCount = new Map<string, number>();
    for (const node of g.nodes) {
        const np = node.ports.length;
        if (np < 2) continue;
        const dirs: Vec[] = node.ports.map((p) => {
            const e = g.edges[p.edge];
            return p.end === 'a' ? startDirection(e.coords) : (endDirection(e.coords).map((v) => -v) as Vec);
        });
        const sweep = (from: number, to: number) => ccwAngle(dirs[from], dirs[to]);
        // Lane position looking outward from the node, as the orderer reads it.
        const position = (port: number, route: string) => {
            const p = node.ports[port];
            const order = g.edges[p.edge].order;
            const i = order.indexOf(route);
            return p.end === 'a' ? i : order.length - 1 - i;
        };
        const turns = node.transitions.filter((t) => t.from >= 0 && t.to >= 0 && t.from !== t.to);
        const groups = new Map<string, {u: number; v: number; routes: string[]}>();
        for (const t of turns) {
            const u = Math.min(t.from, t.to), v = Math.max(t.from, t.to);
            const key = `${u}:${v}`;
            let grp = groups.get(key);
            if (!grp) groups.set(key, (grp = {u, v, routes: []}));
            if (!grp.routes.includes(t.route)) grp.routes.push(t.route);
        }
        for (const grp of groups.values()) {
            if (grp.routes.length < 2) continue;
            for (const t of turns) {
                if (grp.routes.includes(t.route)) continue;
                const shared = [t.from, t.to].filter((p) => p === grp.u || p === grp.v);
                let crossed: string[] = [];
                if (!shared.length) {
                    // A turn between other legs crosses the whole group where it parts the group's two.
                    const through = sweep(grp.u, grp.v);
                    if ((sweep(grp.u, t.from) < through) !== (sweep(grp.u, t.to) < through)) crossed = grp.routes;
                } else if (shared.length === 1) {
                    // Leaving a shared leg for another, it crosses the lanes on its wrong side.
                    const leg = shared[0];
                    const mine = t.from === leg ? t.to : t.from;
                    const theirs = grp.u === leg ? grp.v : grp.u;
                    const left = sweep(leg, mine) < sweep(leg, theirs);
                    const at = position(leg, t.route);
                    crossed = grp.routes.filter((r) => (at < position(leg, r)) !== left);
                }
                if (crossed.length > 1) weaves.push({group: crossed, across: t.route});
            }
        }
        // The layout's rule for lane ends, as pairs: a route that ends here goes under one passing through.
        const passing = new Set(turns.map((t) => t.route));
        node.ports.forEach((p, pi) => {
            for (const r of g.edges[p.edge].routes) {
                if (turns.some((t) => t.route === r && (t.from === pi || t.to === pi))) continue;
                let under = false;
                for (const o of passing) {
                    if (o === r || !node.ports.some((q, qi) => qi !== pi && g.edges[q.edge].routes.includes(o))) continue;
                    endsUnder.push([r, o]);
                    under = true;
                }
                if (under) endsCount.set(r, (endsCount.get(r) ?? 0) + 1);
            }
        });
    }
    if (!weaves.length) return [];
    const ids = new Set<string>();
    for (const w of weaves) {
        ids.add(w.across);
        for (const r of w.group) ids.add(r);
    }
    if (ids.size > MAX_ROUTES) return [];
    // Ranked as the layout ranks them, so an order that needs no change gets none.
    const routes = [...ids].sort((x, y) => (endsCount.get(y) ?? 0) - (endsCount.get(x) ?? 0) || (x < y ? -1 : x > y ? 1 : 0));
    const index = new Map(routes.map((r, i) => [r, i]));
    const n = routes.length;
    const groupsOf: number[][] = routes.map(() => []);
    for (const w of weaves) {
        let mask = 0;
        for (const r of w.group) mask |= 1 << index.get(r)!;
        const list = groupsOf[index.get(w.across)!];
        if (!list.includes(mask)) list.push(mask);
    }
    const over: number[] = routes.map(() => 0);
    for (const [r, o] of endsUnder) {
        const a = index.get(r), b = index.get(o);
        if (a !== undefined && b !== undefined) over[a] |= 1 << b;
    }
    // Cheapest way to have drawn each set of routes so far, bottom first.
    const full = (1 << n) - 1;
    const cost = new Float64Array(full + 1).fill(Infinity);
    const last = new Int8Array(full + 1).fill(-1);
    cost[0] = 0;
    for (let drawn = 0; drawn < full; drawn++) {
        if (cost[drawn] === Infinity) continue;
        let place = 0;
        for (let b = drawn; b; b &= b - 1) place++;
        for (let x = 0; x < n; x++) {
            if (drawn & (1 << x)) continue;
            let c = cost[drawn] + Math.abs(x - place) * MOVE_COST;
            for (const mask of groupsOf[x]) {
                const below = drawn & mask;
                if (below && below !== mask) c += WEAVE_COST;
            }
            for (let b = drawn & over[x]; b; b &= b - 1) c += END_OVER_COST;
            const then = drawn | (1 << x);
            if (c < cost[then] - 1e-12) {
                cost[then] = c;
                last[then] = x;
            }
        }
    }
    const order: string[] = [];
    for (let drawn = full; drawn; drawn ^= 1 << last[drawn]) order.push(routes[last[drawn]]);
    return order.reverse();
}
