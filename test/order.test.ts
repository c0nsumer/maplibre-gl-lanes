import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph, filterGraph, type LineGraph} from '../src/core/graph';
import {LaneOrderer, snapshotLaneOrders, seedFromSnapshot, applyLaneOrders} from '../src/core/order';
import type {Feature} from 'geojson';

// Tiny synthetic networks near the equator, coordinates in ~meters/1e5 deg.
function line(route: string, coords: number[][]): Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}
function setOrder(g: ReturnType<typeof buildLineGraph>, sharedRoutes: string[], order: string[]) {
    const e = g.edges.find((e) => e.routes.length === sharedRoutes.length && sharedRoutes.every((r) => e.routes.includes(r)))!;
    // order is given for west->east travel; flip if the edge runs the other way
    const west = e.coords[0] < e.coords[e.coords.length - 2];
    e.order = west ? order.slice() : order.slice().reverse();
    for (const o of g.edges) if (o !== e) o.order = o.routes.slice();
    return e;
}

describe('branching (different next edge) rule', () => {
    // Bundle from the west; at the junction A turns north, B turns south.
    // Correct: A on the north (left when traveling east) side.
    for (const reversed of [false, true]) {
        it(`A north / B south, shared edge digitized ${reversed ? 'east->west' : 'west->east'}`, () => {
            const shared = reversed ? [[0, 0], [-0.001, 0]] : [[-0.001, 0], [0, 0]];
            const g = buildLineGraph([
                line('A', reversed ? [[0, 0.001], ...shared] : [...shared, [0, 0.001]]),
                line('B', reversed ? [[0, -0.001], ...shared] : [...shared, [0, -0.001]]),
            ]);
            const o = new LaneOrderer(g, {periphery: 0});
            setOrder(g, ['A', 'B'], ['A', 'B']);
            expect(o.totalCost()).toBe(0);
            setOrder(g, ['A', 'B'], ['B', 'A']);
            expect(o.totalCost()).toBe(1);
        });
    }
});

describe('same next edge rule', () => {
    // A and B travel west->east through a bend; keeping [A,B] on both edges is free.
    for (const flipSecond of [false, true]) {
        it(`straight-through pair, second edge digitized ${flipSecond ? 'backwards' : 'forwards'}`, () => {
            const first = [[-0.001, 0], [0, 0]];
            const second = flipSecond ? [[0.001, 0.0005], [0, 0]] : [[0, 0], [0.001, 0.0005]];
            // Give the pair a reason to split the edge: C joins for the second half.
            const g = buildLineGraph([
                line('A', [...first, [0.001, 0.0005]]),
                line('B', [...first, [0.001, 0.0005]]),
                line('C', flipSecond ? second : second),
            ]);
            const o = new LaneOrderer(g, {periphery: 0, separation: 0});
            const e1 = g.edges.find((e) => e.routes.length === 2)!;
            const e2 = g.edges.find((e) => e.routes.length === 3)!;
            const orient = (e: typeof e1, westEast: string[]) => (e.coords[0] < e.coords[e.coords.length - 2] ? westEast : westEast.slice().reverse());
            e1.order = orient(e1, ['A', 'B']);
            e2.order = orient(e2, ['A', 'B', 'C']);
            g.edges.filter((e) => e.routes.length === 1).forEach((e) => (e.order = e.routes.slice()));
            expect(o.totalCost()).toBe(0);
            e2.order = orient(e2, ['B', 'A', 'C']);
            expect(o.totalCost()).toBe(4);
            e2.order = orient(e2, ['A', 'C', 'B']);
            expect(o.totalCost()).toBe(0); // no crossing; separation weight is 0 here
            const o2 = new LaneOrderer(g, {periphery: 0, separation: 3});
            expect(o2.totalCost()).toBe(3);
        });
    }
});

describe('solver', () => {
    it('finds a zero-cost order for a Y with three routes', () => {
        // Shared trunk from the west; A north, B straight, C south.
        const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const g = buildLineGraph([
            line('A', [...trunk, [0.001, 0.001]]),
            line('B', [...trunk, [0.001, 0]]),
            line('C', [...trunk, [0.001, -0.001]]),
        ]);
        const o = new LaneOrderer(g, {periphery: 0});
        const cost = o.solve();
        expect(cost).toBe(0);
        const e = g.edges.find((e) => e.routes.length === 3)!;
        const westEast = e.coords[0] < e.coords[e.coords.length - 2] ? e.order : e.order.slice().reverse();
        expect(westEast).toEqual(['A', 'B', 'C']);
    });
});

describe('snapshots', () => {
    it('round-trips orders through a snapshot', async () => {
        const {snapshotLaneOrders, applyLaneOrders} = await import('../src/core/order');
        const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const build = () => buildLineGraph([
            line('A', [...trunk, [0.001, 0.001]]),
            line('B', [...trunk, [0.001, 0]]),
            line('C', [...trunk, [0.001, -0.001]]),
        ]);
        const g1 = build();
        new LaneOrderer(g1, {periphery: 0}).solve();
        const snap = snapshotLaneOrders(g1);
        const g2 = build();
        expect(applyLaneOrders(g2, snap)).toBe(g2.edges.length);
        expect(g2.edges.map((e) => e.order)).toEqual(g1.edges.map((e) => e.order));
    });
});

/** Edges whose order differs from the seed, and pairs in the opposite order to it. */
function movement(g: LineGraph, initial: Map<number, string[]>): {changed: number; inversions: number} {
    let changed = 0;
    let inversions = 0;
    for (const e of g.edges) {
        const seed = initial.get(e.id);
        if (!seed) continue;
        const pos = new Map(e.order.map((r, i) => [r, i]));
        let inv = 0;
        for (let i = 0; i < seed.length; i++) for (let j = i + 1; j < seed.length; j++) if (pos.get(seed[i])! > pos.get(seed[j])!) inv++;
        inversions += inv;
        if (inv) changed++;
    }
    return {changed, inversions};
}

describe('seeded solves', () => {
    const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const build = () => buildLineGraph(fc.features.filter((f: any) => !winterOnly.has(String(f.properties.route_id))), {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});

    it('hides a route without reshuffling the others, and shows it again without moving them', () => {
        const g = build();
        new LaneOrderer(g, {seed: 42}).solve();
        const snap = snapshotLaneOrders(g);
        const counts = new Map<string, number>();
        for (const e of g.edges) for (const r of e.routes) counts.set(r, (counts.get(r) ?? 0) + 1);
        const busiest = [...counts].sort((a, b) => b[1] - a[1])[0][0];

        const hidden = filterGraph(g, (r) => r !== busiest);
        const initial = seedFromSnapshot(hidden, snap);
        expect(initial.size).toBe(hidden.edges.length);
        // The seed's own cost is the bar: the solve trades crossings against
        // moved pairs one for one and must not end worse than where it started.
        const probe = new LaneOrderer(hidden);
        for (const e of hidden.edges) e.order = initial.get(e.id)!;
        const seedCost = probe.totalCost();
        const cost = new LaneOrderer(hidden, {seed: 42, initial}).solve();
        const m = movement(hidden, initial);
        expect(cost + m.inversions).toBeLessThanOrEqual(seedCost);
        const multi = hidden.edges.filter((e) => e.routes.length > 1).length;
        expect(m.changed).toBeLessThanOrEqual(multi / 10);

        const shown = build();
        const initial2 = seedFromSnapshot(shown, snapshotLaneOrders(hidden));
        // Edges the hidden route rejoins get a partial seed: the other routes' order.
        expect(initial2.size).toBe(shown.edges.filter((e) => e.routes.some((r) => r !== busiest)).length);
        new LaneOrderer(shown, {seed: 42, initial: initial2}).solve();
        expect(movement(shown, initial2).changed).toBeLessThanOrEqual(2);
        for (const e of shown.edges) expect(e.order.slice().sort()).toEqual(e.routes.slice().sort());
    });

    it('places routes a partial seed does not list, and keeps the listed order while it is worth it', () => {
        // The Y from the solver test: A north, B straight, C south, so west-east A, B, C costs nothing.
        const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const build = () => buildLineGraph([
            line('A', [...trunk, [0.001, 0.001]]),
            line('B', [...trunk, [0.001, 0]]),
            line('C', [...trunk, [0.001, -0.001]]),
        ]);
        const seedFor = (g: LineGraph, westEast: string[]) => {
            const e = g.edges.find((e) => e.routes.length === 3)!;
            const forward = e.coords[0] < e.coords[e.coords.length - 2];
            return {e, initial: new Map([[e.id, forward ? westEast : westEast.slice().reverse()]])};
        };
        const westEastOrder = (e: {coords: number[]; order: string[]}) => (e.coords[0] < e.coords[e.coords.length - 2] ? e.order : e.order.slice().reverse());
        // C before A costs two diverging crossings at best; undoing that one pair costs 1.
        const g = build();
        const s = seedFor(g, ['C', 'A']);
        expect(new LaneOrderer(g, {periphery: 0, initial: s.initial}).solve()).toBe(0);
        expect(westEastOrder(s.e)).toEqual(['A', 'B', 'C']);
        // With a high stability weight the pair stays put and B is placed around it.
        const g2 = build();
        const s2 = seedFor(g2, ['C', 'A']);
        expect(new LaneOrderer(g2, {periphery: 0, initial: s2.initial, stability: 10}).solve()).toBe(2);
        const order = westEastOrder(s2.e);
        expect(order.indexOf('C')).toBeLessThan(order.indexOf('A'));
        expect(order.slice().sort()).toEqual(['A', 'B', 'C']);
    });

    it('applies a snapshot to a graph that gained a route, keeping the known order first', () => {
        const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const two = buildLineGraph([line('A', [...trunk, [0.001, 0.001]]), line('C', [...trunk, [0.001, -0.001]])]);
        new LaneOrderer(two, {periphery: 0}).solve();
        const snap = snapshotLaneOrders(two);
        const three = buildLineGraph([line('A', [...trunk, [0.001, 0.001]]), line('B', [...trunk, [0.001, 0]]), line('C', [...trunk, [0.001, -0.001]])]);
        // Only the branch edges of A and C are complete matches; the trunk gained B.
        expect(applyLaneOrders(three, snap)).toBe(2);
        const e = three.edges.find((e) => e.routes.length === 3)!;
        const trunkTwo = two.edges.find((e) => e.routes.length === 2)!;
        expect(e.order.slice(0, 2)).toEqual(trunkTwo.order);
        expect(e.order[2]).toBe('B');
        expect(e.baseline).toBeUndefined();
    });
});

describe('independent components', () => {
    it('solves clusters that share no node each to their optimum', () => {
        // Two Y junctions a degree apart with their own routes; both trunks must come out A, B, C / D, E, F.
        const y = (dx: number, names: [string, string, string]) => {
            const trunk = [[dx - 0.002, 0], [dx - 0.001, 0], [dx, 0]];
            return [line(names[0], [...trunk, [dx + 0.001, 0.001]]), line(names[1], [...trunk, [dx + 0.001, 0]]), line(names[2], [...trunk, [dx + 0.001, -0.001]])];
        };
        const g = buildLineGraph([...y(0, ['A', 'B', 'C']), ...y(1, ['D', 'E', 'F'])]);
        expect(new LaneOrderer(g, {periphery: 0}).solve()).toBe(0);
        for (const e of g.edges.filter((e) => e.routes.length === 3)) {
            const westEast = e.coords[0] < e.coords[e.coords.length - 2] ? e.order : e.order.slice().reverse();
            expect(westEast).toEqual(e.routes.includes('A') ? ['A', 'B', 'C'] : ['D', 'E', 'F']);
        }
    });
});

describe('against the proven best order', () => {
    // The best possible costs come from scripts/exact-order.py, which solves the fixtures'
    // ordering problems exactly. The solver is a local search, so it is held to within a
    // tenth of them rather than to equality.
    const proven: [string, number][] = [['example', 7], ['mfo', 47], ['ramba', 45]];
    for (const [name, best] of proven) {
        it(`lands within a tenth of the best order on the ${name} fixture`, () => {
            const fc = JSON.parse(readFileSync(new URL(`./fixtures/${name}.src.geojson`, import.meta.url), 'utf8'));
            const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
            expect(new LaneOrderer(g).solve()).toBeLessThanOrEqual(best * 1.1);
        });
    }
});
