/**
 * The highlight lifts one route or several, and its widths can follow the
 * zoom. The drawing itself is shaders, so what is checked here is what the
 * layer asks the context to do: which mesh groups are drawn, in which
 * order, and with which outset.
 */
import {describe, it, expect, vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {LaneLayer, type LaneRenderArgs} from '../src/render/layer';
import {tessellate, splitRanges, type Mesh, type Piece} from '../src/render/tessellate';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(graph);
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Records every draw call with the uniforms that were set for it. */
function recordingGl() {
    const draws: {outset: number; opacity: number; first: number; count: number}[] = [];
    const uniforms: Record<string, number> = {};
    const names = new Map<object, string>();
    const gl = new Proxy({}, {
        get: (_, name: string) => {
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return () => 0;
            if (name === 'getUniformLocation') return (_p: unknown, u: string) => {
                const key = {};
                names.set(key, u);
                return key;
            };
            if (name === 'uniform1f') return (loc: object, v: number) => {
                uniforms[names.get(loc) ?? '?'] = v;
            };
            if (name === 'drawElements') return (_m: number, count: number, _t: number, offset: number) => {
                draws.push({outset: uniforms.u_outset, opacity: uniforms.u_opacity, first: offset / 4, count});
            };
            return () => ({});
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, draws};
}

const args = {
    shaderData: {variantName: 'mercator', vertexShaderPrelude: '', define: ''},
    getProjectionData: () => ({
        mainMatrix: new Float64Array(16), fallbackMatrix: new Float64Array(16),
        tileMercatorCoords: [0, 0, 1, 1], clippingPlane: [0, 0, 0, 1],
        projectionTransition: 0, clipAntimeridian: false,
    }),
} as unknown as LaneRenderArgs;

function mapStub(zoom: number) {
    return {
        getTerrain: () => null, getZoom: () => zoom, getPixelRatio: () => 1, triggerRepaint: () => {},
        getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
        unproject: () => ({lng: 0, lat: 0}),
    };
}

/** A layer with its mesh already built, so render draws rather than waits. */
function drawn(zoom: number, highlight: string | string[] | null, style2 = {}) {
    const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
    const {gl, draws} = recordingGl();
    layer.onAdd(mapStub(zoom), gl);
    if (highlight !== null) layer.setHighlight(highlight, style2);
    layer.render(gl, args);
    return {layer, draws, gl};
}

describe('setHighlight', () => {
    it('takes one route or a list, and reports what is lit', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        expect(layer.getHighlight()).toEqual([]);
        layer.setHighlight('a');
        expect(layer.getHighlight()).toEqual(['a']);
        layer.setHighlight(['a', 'b', 'c']);
        expect(layer.getHighlight()).toEqual(['a', 'b', 'c']);
        layer.setHighlight(null);
        expect(layer.getHighlight()).toEqual([]);
        layer.setHighlight([]);
        expect(layer.getHighlight()).toEqual([]);
        // The caller's array is copied, in both directions.
        const routes = ['a'];
        layer.setHighlight(routes);
        routes.push('b');
        expect(layer.getHighlight()).toEqual(['a']);
        layer.getHighlight().push('z');
        expect(layer.getHighlight()).toEqual(['a']);
    });

    it('dims the rest and lifts every highlighted route', () => {
        const routes = [...graph.routes.keys()].slice(0, 3);
        const {draws} = drawn(16, routes, {dim: 0.5});
        const dimmed = draws.filter((d) => d.opacity === 0.5);
        const lit = draws.filter((d) => d.opacity === 1);
        expect(dimmed.length).toBeGreaterThan(0);
        expect(lit.length).toBeGreaterThan(0);
        // Every lit draw comes after every dimmed one: the highlight is on top.
        const lastDimmed = draws.map((d) => d.opacity).lastIndexOf(0.5);
        expect(draws.findIndex((d) => d.opacity === 1)).toBeGreaterThan(lastDimmed);
        // Three halos, then three outlines, then the lanes: a halo drawn per
        // route in turn would wash over the lane of the route beside it.
        const outsets = lit.map((d) => d.outset);
        const halo = Math.max(...outsets);
        const outline = Math.max(...outsets.filter((o) => o < halo));
        expect(outsets.slice(0, 3)).toEqual([halo, halo, halo]);
        expect(outsets.slice(3, 6)).toEqual([outline, outline, outline]);
    });

    it('dims every route in view though no highlighted route is in the build', () => {
        // A route panned out of view is missing from the build the same way.
        const {draws} = drawn(16, 'not-in-this-build', {dim: 0.4});
        expect(draws.length).toBeGreaterThan(0);
        expect(draws.every((d) => d.opacity === 0.4)).toBe(true);
    });

    it('reaches as far as the documented formula says', () => {
        // What HighlightStyle.haloWidth promises: a caller compares this
        // with the lane pitch to know whether a halo covers its neighbors.
        const routes = [...graph.routes.keys()].slice(0, 1);
        const {draws} = drawn(16, routes, {haloWidth: 5, outlineWidth: 2});
        const {width, casingWidth: casing} = style();
        const lit = draws.filter((d) => d.opacity === 1);
        const aa = 0.5;
        expect(Math.max(...lit.map((d) => d.outset))).toBeCloseTo(width / 2 + casing + 2 + 5 + aa, 5);
        // The outline's width counts toward the halo's reach even when no
        // outline is drawn, so the reach does not move when one is turned off.
        const bare = drawn(16, routes, {haloWidth: 5, outlineWidth: 2, outline: null}).draws.filter((d) => d.opacity === 1);
        expect(Math.max(...bare.map((d) => d.outset))).toBeCloseTo(width / 2 + casing + 2 + 5 + aa, 5);
    });

    it('takes its widths from the zoom when given a callback', () => {
        const routes = [...graph.routes.keys()].slice(0, 1);
        const flat = drawn(16, routes, {haloWidth: 4}).draws;
        const near = drawn(16, routes, {haloWidth: (z: number) => z}).draws;
        const far = drawn(12, routes, {haloWidth: (z: number) => z}).draws;
        const widest = (ds: {outset: number}[]) => Math.max(...ds.map((d) => d.outset));
        expect(widest(near)).toBeCloseTo(widest(flat) + 12, 5);
        expect(widest(near) - widest(far)).toBeCloseTo(4, 5);
    });
});

describe('mesh pieces', () => {
    /** Every index of `range`, once each, covered by `pieces` in order. */
    function tiles(range: [number, number], pieces: Piece[]): boolean {
        let at = range[0];
        for (const [first, count] of pieces) {
            if (first !== at || count <= 0) return false;
            at += count;
        }
        return at === range[0] + range[1];
    }

    it('cut every group, ribbon and dots, into ranges by edge that tile it exactly', () => {
        // One route dotted on half its edges, so dot quads and two looks per route both occur.
        const route = graph.edges[0].routes[0];
        const laneStyle = (e: {id: number}, r: string) => (r === route && e.id % 2 === 0 ? {dash: [0, 2] as [number, number]} : null);
        const layout = layoutAtZoom(graph, 16, style, {laneStyle});
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin: [0, 0], unitsPerMercator: 8192, drawOrder: layout.drawOrder, width: 6});
        expect(mesh.groupPieces).toHaveLength(mesh.groups.length);
        expect(mesh.groupDotPieces).toHaveLength(mesh.groups.length);
        let dotted = 0;
        for (let gi = 0; gi < mesh.groups.length; gi++) {
            expect(tiles(mesh.groups[gi], mesh.groupPieces[gi])).toBe(true);
            expect(tiles(mesh.groupDots[gi], mesh.groupDotPieces[gi])).toBe(true);
            if (mesh.groupDots[gi][1]) dotted++;
            for (const [, , edge] of [...mesh.groupPieces[gi], ...mesh.groupDotPieces[gi]]) {
                expect(graph.edges[edge]).toBeDefined();
                // The edge carries the group's route: a piece names its own edge, or the one a connector arrives from.
                expect(graph.edges[edge].routes).toContain(mesh.groupRoutes[gi]);
            }
            // Neighbors on one edge are merged, so a piece boundary is an edge boundary.
            const ps = mesh.groupPieces[gi];
            for (let k = 1; k < ps.length; k++) expect(ps[k][2]).not.toBe(ps[k - 1][2]);
        }
        expect(dotted).toBeGreaterThan(0);
    });
});

describe('splitRanges', () => {
    const pieces: Piece[] = [[10, 6, 1], [16, 3, 2], [19, 9, 3], [28, 3, 2], [31, 6, 4]];
    const group: [number, number] = [10, 27];

    it('leaves the group whole when none of its edges is bright', () => {
        expect(splitRanges(group, pieces, new Set([9]))).toEqual({dimmed: [[10, 27]], bright: []});
        expect(splitRanges(group, pieces, new Set())).toEqual({dimmed: [[10, 27]], bright: []});
    });

    it('cuts the bright edges out and merges what stays on one side', () => {
        expect(splitRanges(group, pieces, new Set([2]))).toEqual({dimmed: [[10, 6], [19, 9], [31, 6]], bright: [[16, 3], [28, 3]]});
        expect(splitRanges(group, pieces, new Set([2, 3]))).toEqual({dimmed: [[10, 6], [31, 6]], bright: [[16, 15]]});
        expect(splitRanges(group, pieces, new Set([1, 2, 3, 4]))).toEqual({dimmed: [], bright: [[10, 27]]});
    });

    it('treats an empty group as nothing to draw', () => {
        expect(splitRanges([5, 0], [], new Set([1]))).toEqual({dimmed: [], bright: []});
    });
});

describe('bright edges under a highlight', () => {
    const meshOf = (layer: LaneLayer) => (layer as unknown as {mesh: Mesh}).mesh;
    /** Index ranges drawn at an opacity, with the dimmed ones expanded to single indices. */
    const covered = (draws: {opacity: number; first: number; count: number}[], opacity: number) => {
        const out = new Set<number>();
        for (const d of draws) if (d.opacity === opacity) for (let k = 0; k < d.count; k++) out.add(d.first + k);
        return out;
    };

    /** A lifted route, and an edge that does not carry it, with its pieces on other routes. */
    function scene() {
        const lifted = [...graph.routes.keys()][0];
        const edge = graph.edges.find((e) => !e.routes.includes(lifted) && e.routes.length > 0)!;
        return {lifted, edge: edge.id};
    }

    it('draws the bright edge at full opacity in its route\'s own place, and never dimmed', () => {
        const {lifted, edge} = scene();
        const {layer, draws} = drawn(16, lifted, {dim: 0.4, bright: [edge]});
        const mesh = meshOf(layer);
        const brightIdx = new Set<number>();
        for (let gi = 0; gi < mesh.groups.length; gi++) {
            for (const [first, count, e] of mesh.groupPieces[gi]) if (e === edge) for (let k = 0; k < count; k++) brightIdx.add(first + k);
        }
        expect(brightIdx.size).toBeGreaterThan(0);
        const dimmed = covered(draws, 0.4);
        const full = covered(draws, 1);
        for (const i of brightIdx) {
            expect(dimmed.has(i)).toBe(false);
            expect(full.has(i)).toBe(true);
        }
        // The bright draws sit among the dimmed ones, not after them with the lift.
        const lastDimmed = draws.map((d) => d.opacity).lastIndexOf(0.4);
        const firstBright = draws.findIndex((d) => d.opacity === 1 && brightIdx.has(d.first));
        expect(firstBright).toBeGreaterThanOrEqual(0);
        expect(firstBright).toBeLessThan(lastDimmed);
        // No halo or outline: every full-opacity draw of a bright piece is a casing or a fill.
        const {width, casingWidth} = style();
        const outsets = new Set(draws.filter((d) => d.opacity === 1 && brightIdx.has(d.first)).map((d) => d.outset));
        expect([...outsets].sort()).toEqual([width / 2 + 0.5, width / 2 + casingWidth + 0.5].sort());
    });

    it('changes nothing without a dim, without edges, or once the highlight is cleared', () => {
        const {lifted, edge} = scene();
        const plain = drawn(16, lifted, {dim: 0.4}).draws;
        expect(drawn(16, lifted, {dim: 0.4, bright: []}).draws).toEqual(plain);
        expect(drawn(16, lifted, {dim: 1, bright: [edge]}).draws).toEqual(drawn(16, lifted, {dim: 1}).draws);
        const {layer, draws, gl} = drawn(16, lifted, {dim: 0.4, bright: [edge]});
        layer.setHighlight(null);
        draws.length = 0;
        layer.render(gl, args);
        expect(draws).toEqual(drawn(16, null).draws);
    });
});

describe('a program that fails to build', () => {
    it('logs once and draws nothing, rather than throwing every frame', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, worker: false});
        const {gl, draws} = recordingGl();
        const broken = new Proxy(gl, {get: (t, name: string) => (name === 'getShaderParameter' ? () => false : Reflect.get(t, name))});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        layer.onAdd(mapStub(14), broken);
        expect(() => layer.render(broken, args)).not.toThrow();
        expect(() => layer.render(broken, args)).not.toThrow();
        expect(error).toHaveBeenCalledTimes(1);
        expect(draws).toEqual([]);
        error.mockRestore();
    });
});
