/**
 * The startup table in `docs/performance.md`: building the line graph, ordering
 * the lanes (the median over seeds 1 to 5), the stable-lane baselines, and a
 * seeded re-order after hiding the route on the most edges, as a route toggle
 * asks for. Each figure is the median of five runs.
 *
 *   node scripts/run-ts.mjs scripts/bench-startup.ts [fixture ...]
 *
 * Run it from the repo root: fixtures are read relative to the working
 * directory.
 */

import {readFileSync} from 'node:fs';
import {buildLineGraph, filterGraph} from '../src/core/graph';
import {LaneOrderer, snapshotLaneOrders, seedFromSnapshot} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';

const fixtures = process.argv.slice(3);
if (!fixtures.length) fixtures.push('ramba.src.geojson', 'mfo.src.geojson', 'example.src.geojson');
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[xs.length >> 1];
const fmt = (ms: number) => (ms < 1 ? 'under 1 ms' : `${ms.toFixed(0)} ms`);
console.log('| Step | ' + fixtures.map((f) => f.replace('.src.geojson', '')).join(' | ') + ' |');
const rows: string[][] = [['Build the line graph'], ['Order the lanes (median of 5 seeds)'], ['Stable-lane baselines'], ['Seeded re-order after hiding the busiest route']];
for (const name of fixtures) {
    const fc = JSON.parse(readFileSync(`test/fixtures/${name}`, 'utf8'));
    const opts = {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'};
    const graph: number[] = [], order: number[] = [], stab: number[] = [], seeded: number[] = [];
    for (let run = 0; run < 5; run++) {
        let t = performance.now();
        const g = buildLineGraph(fc.features, opts);
        graph.push(performance.now() - t);
        const perSeed: number[] = [];
        for (let seed = 1; seed <= 5; seed++) {
            for (const e of g.edges) e.order = [];
            t = performance.now();
            new LaneOrderer(g, {seed}).solve();
            perSeed.push(performance.now() - t);
        }
        order.push(med(perSeed));
        for (const e of g.edges) e.order = [];
        new LaneOrderer(g, {seed: 42}).solve();
        t = performance.now();
        stabilizeLanes(g, {});
        stab.push(performance.now() - t);
        const snap = snapshotLaneOrders(g);
        const counts = new Map<string, number>();
        for (const e of g.edges) for (const r of e.routes) counts.set(r, (counts.get(r) ?? 0) + 1);
        const busiest = [...counts].sort((a, b) => b[1] - a[1])[0][0];
        const hidden = filterGraph(g, (r) => r !== busiest);
        const initial = seedFromSnapshot(hidden, snap);
        t = performance.now();
        new LaneOrderer(hidden, {seed: 42, initial}).solve();
        seeded.push(performance.now() - t);
    }
    rows[0].push(fmt(med(graph)));
    rows[1].push(fmt(med(order)));
    rows[2].push(fmt(med(stab)));
    rows[3].push(fmt(med(seeded)));
}
console.log('|---|' + fixtures.map(() => '---').join('|') + '|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
