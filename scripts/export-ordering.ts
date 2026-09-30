/**
 * Writes each network's lane-ordering problem as JSON, for
 * `scripts/exact-order.py`, which finds the order no solver can beat. That
 * script runs this one; there is seldom a reason to run it by hand.
 *
 *   node scripts/run-ts.mjs scripts/export-ordering.ts <out-dir> [options] [file ...]
 *
 *   --route-property <name>   feature property holding the route id (default route_id)
 *   --uniform <a,b,...>       the `uniformProperties` the map is built with
 *
 * A bare file name is a fixture in `test/fixtures/`; anything with a slash
 * is a path. With no files, the three fixtures. Run it from the repo root.
 */

import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {basename, join} from 'node:path';
import {buildLineGraph} from '../src/core/graph';
import {LaneOrderer} from '../src/core/order';

/**
 * What this script reads of the solver. The cost terms are private because no
 * map needs them, so they are reached through a cast, and `internals` refuses
 * to go on if a rename in `order.ts` has left one of them behind.
 */
interface SolverInternals {
    routeIds: string[];
    routeIndex: Map<string, number>;
    terms: {
        start: Int32Array;
        kind: Uint8Array;
        edge: Int32Array;
        out: Uint8Array;
        a: Int32Array;
        b: Int32Array;
        next: Int32Array;
        nextOut: Uint8Array;
        aLeft: Uint8Array;
    };
    w: {sameSegmentCrossing: number; diffSegmentCrossing: number; separation: number; periphery: number};
    components(): {edges: number[]}[];
}

function internals(orderer: LaneOrderer): SolverInternals {
    const s = orderer as unknown as SolverInternals;
    const present = s.routeIds && s.routeIndex && s.w && s.terms && s.terms.start && s.terms.aLeft && typeof s.components === 'function';
    if (!present) throw new Error('export-ordering: LaneOrderer no longer has the fields this script reads; see SolverInternals');
    return s;
}

const args = process.argv.slice(3);
const outDir = args.shift();
if (!outDir) {
    console.error('usage: node scripts/run-ts.mjs scripts/export-ordering.ts <out-dir> [--route-property name] [--uniform a,b] [file ...]');
    process.exit(1);
}
let routeProperty = 'route_id';
let uniformProperties: string[] | undefined;
const files: string[] = [];
while (args.length) {
    const arg = args.shift()!;
    if (arg === '--route-property') routeProperty = args.shift() ?? routeProperty;
    else if (arg === '--uniform') uniformProperties = (args.shift() ?? '').split(',').filter(Boolean);
    else files.push(arg);
}
if (!files.length) files.push('ramba.src.geojson', 'mfo.src.geojson', 'example.src.geojson');
mkdirSync(outDir, {recursive: true});

for (const file of files) {
    const path = file.includes('/') ? file : `test/fixtures/${file}`;
    const fc = JSON.parse(readFileSync(path, 'utf8'));
    const g = buildLineGraph(fc.features, {routeProperty, uniformProperties});
    // The order and cost to beat are what the library does by default.
    const solver = new LaneOrderer(g);
    const t0 = performance.now();
    const solverCost = solver.solve();
    const solverMs = performance.now() - t0;
    const s = internals(solver);
    const t = s.terms;
    const terms: number[][] = [];
    for (let n = 0; n < g.nodes.length; n++) {
        for (let i = t.start[n]; i < t.start[n + 1]; i++) {
            terms.push([n, t.kind[i], t.edge[i], t.out[i], t.a[i], t.b[i], t.next[i], t.nextOut[i], t.aLeft[i]]);
        }
    }
    const edges = g.edges.filter((e) => e.routes.length > 1).map((e) => ({
        id: e.id,
        routes: e.routes.map((r) => s.routeIndex.get(r)!),
        order: e.order.map((r) => s.routeIndex.get(r)!),
    }));
    // Parent directory and file name, so two maps that share a file name stay apart.
    const parts = path.split('/');
    const parent = parts.length > 1 ? parts[parts.length - 2] : '';
    const stem = basename(path).replace(/(\.src)?\.geojson$/, '');
    const name = parent && parent !== 'fixtures' ? `${parent}-${stem}` : stem;
    writeFileSync(join(outDir, `${name}.json`), JSON.stringify({
        name, path, routes: s.routeIds, weights: s.w, edges, terms,
        groups: s.components().map((c) => c.edges),
        legs: g.nodes.map((n) => n.ports.length),
        solverCost, solverMs,
    }));
}
