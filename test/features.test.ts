import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph, lngLatToMercator, mercatorToLngLat} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {LaneLayer} from '../src/render/layer';
import {tessellate} from '../src/render/tessellate';

const fc = JSON.parse(readFileSync(new URL('./fixtures/ramba.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name'});
orderLanes(graph);
const style = () => ({spacing: 8, width: 6, casingWidth: 1});
const counts = new Map<string, number>();
for (const e of graph.edges) for (const r of e.routes) counts.set(r, (counts.get(r) ?? 0) + 1);
const busiest = [...counts].sort((a, b) => b[1] - a[1])[0][0];

describe('layout route filter', () => {
    it('emits only the requested routes, with the geometry they have among the others', () => {
        const all = layoutAtZoom(graph, 16, style);
        const one = layoutAtZoom(graph, 16, style, {routes: [busiest]});
        const expected = all.paths.filter((p) => p.route === busiest);
        expect(one.paths.length).toBe(expected.length);
        expect(one.paths.every((p) => p.route === busiest)).toBe(true);
        one.paths.forEach((p, i) => {
            expect(p.kind).toBe(expected[i].kind);
            expect(p.edge).toBe(expected[i].edge);
            expect(p.node).toBe(expected[i].node);
            expect(p.coords).toEqual(expected[i].coords);
        });
        expect(one.stats.vertices).toBeLessThan(all.stats.vertices / 2);
    });
});

describe('laneFeatures', () => {
    it('returns nothing before the first build, and every lane of a route over the whole graph on request', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        expect(layer.laneFeatures().features.length).toBe(0);
        const full = layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]});
        const paths = layoutAtZoom(graph, 16, style, {routes: [busiest]}).paths;
        expect(full.features.length).toBe(paths.length);
        // One lane feature per drawn edge the route travels: every edge not
        // merged into a junction at this zoom has exactly one, and a merged
        // edge has one only where the route starts or ends on it.
        const layout = layoutAtZoom(graph, 16, style, {routes: [busiest]});
        const merged = new Set(layout.mergedEdges);
        const lanesByEdge = new Map<number, number>();
        for (const f of full.features) if (f.properties!.kind === 'lane') lanesByEdge.set(f.properties!.edge as number, (lanesByEdge.get(f.properties!.edge as number) ?? 0) + 1);
        for (const e of graph.edges) {
            if (!e.routes.includes(busiest)) expect(lanesByEdge.get(e.id)).toBeUndefined();
            else if (!merged.has(e.id)) expect(lanesByEdge.get(e.id)).toBe(1);
            else expect(lanesByEdge.get(e.id) ?? 0).toBeLessThanOrEqual(1);
        }
        for (const f of full.features) {
            expect(f.properties!.route).toBe(busiest);
            expect(f.properties!.name).toBe(graph.routes.get(busiest)!.name);
            const [lng, lat] = (f.geometry as GeoJSON.LineString).coordinates[0];
            expect(lng).toBeGreaterThan(-88);
            expect(lng).toBeLessThan(-87);
            expect(lat).toBeGreaterThan(46);
            expect(lat).toBeLessThan(47);
        }
        // The same request is served from the cache; a different zoom is not.
        expect(layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]})).toBe(full);
        expect(layer.laneFeatures({zoom: 17, extent: 'full', routes: [busiest]})).not.toBe(full);
    });

    it('lays out the full extent for the zoom asked, so a highlight lands on the lanes', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const z16 = layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]});
        const z18 = layer.laneFeatures({zoom: 18, extent: 'full', routes: [busiest]});
        // Lane offsets are in pixels: at a higher zoom the same lane sits closer to the path in degrees.
        const spread = (f: GeoJSON.FeatureCollection) => {
            let sum = 0;
            for (const feat of f.features) {
                const c = (feat.geometry as GeoJSON.LineString).coordinates;
                sum += Math.hypot(c[c.length - 1][0] - c[0][0], c[c.length - 1][1] - c[0][1]);
            }
            return sum;
        };
        expect(spread(z16)).toBeGreaterThan(0);
        expect(z16.features.length).toBeGreaterThan(0);
        expect(z18.features.length).toBeGreaterThan(0);
        expect(spread(z16)).not.toBe(spread(z18));
    });
});

function line(route: string, coords: number[][], props: Record<string, unknown> = {}): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000', ...props}, geometry: {type: 'LineString', coordinates: coords}};
}

describe('uniformProperties', () => {
    it('ends an edge where a listed property changes, and keeps the values on the edge', () => {
        const west = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const east = [[0, 0], [0.001, 0], [0.002, 0]];
        const features = [line('A', west, {oneway: 'yes'}), line('A', east, {oneway: 'no'})];
        expect(buildLineGraph(features).edges.length).toBe(1);
        const g = buildLineGraph(features, {uniformProperties: ['oneway']});
        expect(g.edges.length).toBe(2);
        expect(g.edges.map((e) => e.properties!.oneway).sort()).toEqual(['no', 'yes']);
        expect(g.edges.every((e) => e.routes.length === 1)).toBe(true);
    });

    it('keeps RAMBA orderable with trail names uniform along every edge', () => {
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', uniformProperties: ['trail_name', 'oneway']});
        expect(g.edges.length).toBeGreaterThan(graph.edges.length);
        for (const e of g.edges) expect(typeof e.properties!.trail_name).toBe('string');
        expect(orderLanes(g)).toBeGreaterThanOrEqual(0);
        const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style});
        const f = layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]}).features;
        expect(f.every((x) => typeof x.properties!.trail_name === 'string')).toBe(true);
        expect(f.every((x) => x.properties!.route === busiest)).toBe(true);
    });
});

describe('direction of travel on lane features', () => {
    const path = [[-0.002, 0], [-0.001, 0.0002], [0, 0], [0.001, 0]];
    const reversed = path.slice().reverse();
    const lng = (f: GeoJSON.Feature, i: number) => (f.geometry as GeoJSON.LineString).coordinates.at(i)![0];

    it('runs each lane piece the way its route travels, and marks two-way routes 0', () => {
        // A eastbound, B westbound on the same path, C out and back over it.
        const g = buildLineGraph([line('A', path), line('B', reversed), line('C', [...path, ...reversed.slice(1)])]);
        orderLanes(g);
        const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style});
        const f = layer.laneFeatures({zoom: 16, extent: 'full'}).features;
        const of = (r: string) => f.filter((x) => x.properties!.route === r && x.properties!.kind === 'lane');
        expect(of('A').length).toBeGreaterThan(0);
        for (const x of of('A')) {
            expect(x.properties!.direction).toBe(1);
            expect(lng(x, 0)).toBeLessThan(lng(x, -1));
        }
        for (const x of of('B')) {
            expect(x.properties!.direction).toBe(1);
            expect(lng(x, 0)).toBeGreaterThan(lng(x, -1));
        }
        for (const x of of('C')) expect(x.properties!.direction).toBe(0);
    });

    for (const digitized of ['west to east', 'east to west'] as const) {
        it(`chains lanes and connectors end to start in travel order (${digitized})`, () => {
            // The Y: shared trunk, then A north, B straight, C south.
            const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
            const mk = (r: string, tail: number[]) => {
                const c = [...trunk, tail];
                return line(r, digitized === 'west to east' ? c : c.slice().reverse());
            };
            const g = buildLineGraph([mk('A', [0.001, 0.001]), mk('B', [0.001, 0]), mk('C', [0.001, -0.001])]);
            orderLanes(g);
            const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style});
            const f = layer.laneFeatures({zoom: 16, extent: 'full'}).features;
            expect(f.every((x) => x.properties!.direction === 1)).toBe(true);
            const connectors = f.filter((x) => x.properties!.kind === 'connector');
            expect(connectors.length).toBe(3);
            const same = (p: number[], q: number[]) => Math.abs(p[0] - q[0]) < 1e-9 && Math.abs(p[1] - q[1]) < 1e-9;
            for (const c of connectors) {
                const cc = (c.geometry as GeoJSON.LineString).coordinates;
                const lanes = f.filter((x) => x.properties!.route === c.properties!.route && x.properties!.kind === 'lane').map((x) => (x.geometry as GeoJSON.LineString).coordinates);
                // A lane ends where the connector starts, and another starts where it ends.
                expect(lanes.some((l) => same(l[l.length - 1], cc[0]))).toBe(true);
                expect(lanes.some((l) => same(l[0], cc[cc.length - 1]))).toBe(true);
                // Travel order: the trunk lies west of the branches.
                expect(cc[0][0] < cc[cc.length - 1][0]).toBe(digitized === 'west to east');
            }
        });
    }
});

describe('colors', () => {
    it('parses hex, named, comma and slash rgb forms with alpha', async () => {
        const {parseColor} = await import('../src/render/tessellate');
        expect([...parseColor('#2a2a2a')]).toEqual([42, 42, 42, 255]);
        expect([...parseColor('#2a2a2a80')]).toEqual([42, 42, 42, 128]);
        expect([...parseColor('#08f')]).toEqual([0, 136, 255, 255]);
        expect([...parseColor('white')]).toEqual([255, 255, 255, 255]);
        expect([...parseColor('rgba(42, 42, 42, 0.5)')]).toEqual([42, 42, 42, 128]);
        expect([...parseColor('rgb(42 42 42 / 50%)')]).toEqual([42, 42, 42, 128]);
        expect([...parseColor('rgb(42 42 42)')]).toEqual([42, 42, 42, 255]);
        expect([...parseColor('rgb(300, -5, 50%)')]).toEqual([255, 0, 128, 255]);
    });

    it('reads any other CSS color through a canvas, and falls back to gray', async () => {
        const {parseColor} = await import('../src/render/tessellate');
        expect([...parseColor('darkgreen')]).toEqual([136, 136, 136, 255]);
        // A canvas context normalizes what it knows and ignores what it does not.
        const known: Record<string, string> = {darkgreen: '#006400', 'hsl(0 100% 50% / 0.5)': 'rgba(255, 0, 0, 0.5)'};
        class FakeCanvas {
            getContext() {
                let style = '#000000';
                return {
                    get fillStyle() { return style; },
                    set fillStyle(v: string) { if (/^#[0-9a-f]{6}$/.test(v) || known[v]) style = known[v] ?? v; },
                };
            }
        }
        vi.stubGlobal('OffscreenCanvas', FakeCanvas);
        try {
            expect([...parseColor('darkgreen')]).toEqual([0, 100, 0, 255]);
            expect([...parseColor('hsl(0 100% 50% / 0.5)')]).toEqual([255, 0, 0, 128]);
            expect([...parseColor('not-a-color')]).toEqual([136, 136, 136, 255]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('reads a color the canvas keeps in its own notation from the pixel it paints', async () => {
        const {parseColor} = await import('../src/render/tessellate');
        // Browsers hand oklch() back as oklch(); only the painted pixel is in sRGB bytes.
        const painted: Record<string, number[]> = {'oklch(70% 0.15 200)': [0, 185, 195, 255], 'oklch(70% 0.15 200 / 0.5)': [0, 185, 195, 128]};
        class FakeCanvas {
            getContext() {
                let style = '#000000';
                return {
                    get fillStyle() { return style; },
                    set fillStyle(v: string) { if (/^#[0-9a-f]{6}$/.test(v) || painted[v]) style = v; },
                    clearRect() {},
                    fillRect() {},
                    getImageData: () => ({data: Uint8ClampedArray.from(painted[style] ?? [0, 0, 0, 0])}),
                };
            }
        }
        vi.stubGlobal('OffscreenCanvas', FakeCanvas);
        try {
            expect([...parseColor('oklch(70% 0.15 200)')]).toEqual([0, 185, 195, 255]);
            expect([...parseColor('oklch(70% 0.15 200 / 0.5)')]).toEqual([0, 185, 195, 128]);
        } finally {
            vi.unstubAllGlobals();
        }
    });

    it('changes the casing after construction, keeping its alpha', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, casingColor: '#000'});
        const casing = () => (layer as unknown as {casing: Float32Array | null}).casing;
        expect(casing()![3]).toBe(1);
        layer.setCasingColor('rgba(255, 255, 255, 0.5)');
        expect([...casing()!].map((v) => Math.round(v * 100) / 100)).toEqual([1, 1, 1, 0.5]);
        layer.setCasingColor(null);
        expect(casing()).toBeNull();
    });
});

describe('route metadata', () => {
    it('carries the dash cap from the route overrides', () => {
        const trunk = [[-0.002, 0], [-0.001, 0], [0, 0]];
        const g = buildLineGraph([line('A', trunk), line('B', trunk)], {routes: {A: {dash: [1, 1], dashCap: 'round'}, B: {dash: [1, 2], dashCap: 'square', dashColor: 'red'}}});
        expect(g.routes.get('A')!.dashCap).toBe('round');
        expect(g.routes.get('B')!.dashCap).toBe('square');
        expect(g.routes.get('B')!.dashColor).toBe('red');
        const bare = buildLineGraph([line('A', trunk)], {routes: {A: {casing: false}}});
        expect(bare.routes.get('A')!.casing).toBe(false);
        expect(g.routes.get('A')!.casing).toBeUndefined();
    });
});

describe('lane count and route list on features', () => {
    it('tells solo edges from shared corridors and lists the corridor routes in lane order', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const f = layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]}).features;
        const solo = f.filter((x) => x.properties!.lanes === 1);
        const shared = f.filter((x) => (x.properties!.lanes as number) > 1);
        expect(solo.length).toBeGreaterThan(0);
        expect(shared.length).toBeGreaterThan(0);
        for (const x of f) {
            const e = graph.edges[x.properties!.edge as number];
            expect(x.properties!.lanes).toBe(e.routes.length);
            expect(x.properties!.routes).toEqual(e.order);
            expect((x.properties!.routes as string[]).includes(busiest)).toBe(true);
        }
    });
});

describe('queryLane', () => {
    it('reports the nearest route and everything on its edge', () => {
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name', uniformProperties: ['trail_name']});
        orderLanes(g);
        const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style, cull: false});
        // A WebGL context that accepts every call: the build uploads buffers it never draws.
        const gl = new Proxy({}, {get: () => () => ({})}) as unknown as WebGL2RenderingContext;
        layer.onAdd({getTerrain: () => null} as never, gl);
        (layer as unknown as {rebuild(z: number): void}).rebuild(16);
        // Aim at the middle of a shared corridor's lane, from its own feature geometry.
        const shared = layer.laneFeatures({zoom: 16, extent: 'full'}).features.find((f) => f.properties!.kind === 'lane' && (f.properties!.lanes as number) >= 3)!;
        const c = (shared.geometry as GeoJSON.LineString).coordinates;
        const mid = c[Math.floor(c.length / 2)] as [number, number];
        const hit = layer.queryLaneAt(mid, 16, 4)!;
        expect(hit).not.toBeNull();
        expect(hit.route).toBe(shared.properties!.route);
        expect(hit.edge).toBe(shared.properties!.edge);
        expect(hit.routes).toEqual(shared.properties!.routes);
        expect(hit.routes.length).toBe(shared.properties!.lanes);
        expect(hit.properties.trail_name).toBe(shared.properties!.trail_name);
        expect(hit.distancePx).toBeLessThan(1);
        // The hit point lies on the lane, next to the aimed point.
        expect(Math.abs(hit.lngLat[0] - mid[0])).toBeLessThan(1e-6);
        expect(Math.abs(hit.lngLat[1] - mid[1])).toBeLessThan(1e-6);
        // Aimed a little off the lane, the distance reported is the pixel
        // distance from the aimed point to the returned point on the lane.
        const scale = 512 * Math.pow(2, 16);
        const toPx = (ll: [number, number]) => lngLatToMercator(ll[0], ll[1]).map((v) => v * scale) as [number, number];
        const [p0, p1, p2] = [c[Math.floor(c.length / 2) - 1], mid, c[Math.floor(c.length / 2) + 1]].map((q) => toPx(q as [number, number]));
        const len = Math.hypot(p2[0] - p0[0], p2[1] - p0[1]);
        // Three pixels across the lane: nearer than the neighboring lanes at 8 px.
        const aimedPx: [number, number] = [p1[0] - ((p2[1] - p0[1]) / len) * 3, p1[1] + ((p2[0] - p0[0]) / len) * 3];
        const aimed = mercatorToLngLat(aimedPx[0] / scale, aimedPx[1] / scale);
        const off = layer.queryLaneAt(aimed, 16, 12)!;
        const b = toPx(off.lngLat);
        const px = Math.hypot(aimedPx[0] - b[0], aimedPx[1] - b[1]);
        expect(off.route).toBe(hit.route);
        expect(px).toBeGreaterThan(2);
        expect(Math.abs(px - off.distancePx)).toBeLessThan(0.05);
        // Far from any lane: nothing.
        expect(layer.queryLaneAt([mid[0] + 0.01, mid[1]], 16, 4)).toBeNull();
    });
});

describe('per-edge styling', () => {
    it('draws each lane piece by its edge, connectors by the edge they arrive from', () => {
        const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour', uniformProperties: ['trail_name']});
        orderLanes(g);
        const byTrail = (edge: {properties?: Record<string, unknown>}) =>
            (String(edge.properties?.trail_name).startsWith('M') ? {color: '#ff0000', dash: [1, 1] as [number, number]} : null);
        const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style, laneStyle: byTrail});
        const f = layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]}).features;
        const routeColor = g.routes.get(busiest)!.color;
        let red = 0, own = 0;
        for (const x of f) {
            const e = g.edges[x.properties!.edge as number];
            const expected = byTrail(e)?.color ?? routeColor;
            expect(x.properties!.color).toBe(expected);
            if (expected === '#ff0000') red++;
            else own++;
        }
        expect(red).toBeGreaterThan(0);
        expect(own).toBeGreaterThan(0);
        // The mesh carries the same colors per vertex.
        const layout = layoutAtZoom(g, 16, style, {routes: [busiest], laneStyle: byTrail});
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin: [0, 0]});
        const seen = new Set<string>();
        for (let i = 0; i < mesh.vertexCount; i++) seen.add(`${mesh.colors[i * 4]},${mesh.colors[i * 4 + 1]},${mesh.colors[i * 4 + 2]}`);
        expect(seen.has('255,0,0')).toBe(true);
        expect(seen.size).toBe(2);
        // The dash comes with it, and only on the overridden pieces.
        expect(layout.paths.some((p) => p.look.color === '#ff0000' && p.look.dash?.[0] === 1)).toBe(true);
        expect(layout.paths.every((p) => (p.look.dash ? p.look.color === '#ff0000' : true))).toBe(true);
        // One mesh group per look, so each can be drawn with its own dash.
        expect(mesh.groupLooks.length).toBe(2);
        expect(mesh.groupRoutes[0]).toBe(mesh.groupRoutes[1]);
        // Turning it off restores the route color everywhere.
        layer.setLaneStyle(null);
        expect(layer.laneFeatures({zoom: 16, extent: 'full', routes: [busiest]}).features.every((x) => x.properties!.color === routeColor)).toBe(true);
    });
});
