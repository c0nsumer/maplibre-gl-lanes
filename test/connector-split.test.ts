/**
 * A connector is cut at the node it crosses, and each piece belongs to the edge on its side. A
 * connector owned whole by the edge it arrived from carried that edge's look, highlight, hit and
 * feature a node front's length past the node, onto an edge of another name.
 */
import {describe, it, expect} from 'vitest';
import {buildLineGraph, lngLatToMercator, mercatorToLngLat} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom, type LanePath} from '../src/core/layout';
import {polylineLength} from '../src/core/geometry';
import {LaneLayer} from '../src/render/layer';
import {tessellate} from '../src/render/tessellate';
import {wholeConnectors} from './connectors';

function line(route: string, coords: number[][]): GeoJSON.Feature {
    return {type: 'Feature', properties: {route, color: '#000'}, geometry: {type: 'LineString', coordinates: coords}};
}
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

// A runs west to east through a node at the origin, where B joins from the north and runs on
// east beside it: one lane west of the node, two east of it.
const g = buildLineGraph([
    line('A', [[-0.002, 0], [-0.001, 0], [0, 0], [0.001, 0], [0.002, 0]]),
    line('B', [[0, 0.002], [0, 0.001], [0, 0], [0.001, 0], [0.002, 0]]),
]);
orderLanes(g);
const node = g.nodes.find((n) => n.ports.length === 3)!;
const west = g.edges.find((e) => e.routes.length === 1 && e.routes[0] === 'A')!.id;
const north = g.edges.find((e) => e.routes.length === 1 && e.routes[0] === 'B')!.id;
const east = g.edges.find((e) => e.routes.length === 2)!.id;
const Z = 17;
const scale = 512 * 2 ** Z;
const nx = node.x * scale, ny = node.y * scale;
/** A route's connector pieces, the one on `first` first: a connector runs in port order, not travel. */
const pieces = (paths: LanePath[], route: string, first: number) => {
    const out = paths.filter((p) => p.kind === 'connector' && p.route === route);
    return out[0]?.edge === first ? out : out.slice().reverse();
};

describe('a connector across a node', () => {
    it('is cut there into a piece on each edge, which together are the whole', () => {
        const layout = layoutAtZoom(g, Z, style);
        for (const [route, from] of [['A', west], ['B', north]] as const) {
            const [a, b, ...rest] = pieces(layout.paths, route, from);
            expect(rest).toEqual([]);
            expect([a.edge, b.edge]).toEqual([from, east]);
            expect([...a.between!].sort()).toEqual([from, east].sort());
            expect(b.between).toBe(a.between);
            // One starts at the very point where the other ends, so the seam is exact.
            const seam = a.coords.slice(-2).join() === b.coords.slice(0, 2).join() ? b.coords : a.coords;
            expect(a.coords.slice(-2).join() === b.coords.slice(0, 2).join() || b.coords.slice(-2).join() === a.coords.slice(0, 2).join()).toBe(true);
            const whole = wholeConnectors(layout.paths).find((p) => p.kind === 'connector' && p.route === route)!;
            expect(polylineLength(a.coords) + polylineLength(b.coords)).toBeCloseTo(polylineLength(whole.coords), 9);
            // The cut is at the node, give or take the lane's offset from the line.
            const [cx, cy] = seam;
            expect(Math.hypot(cx - nx, cy - ny)).toBeLessThan(style().spacing);
        }
        // A goes straight on, so its cut is square across the line at the node.
        const [a, b] = pieces(layout.paths, 'A', west);
        for (let i = 0; i < a.coords.length; i += 2) expect(a.coords[i]).toBeLessThanOrEqual(nx + 1e-6);
        for (let i = 0; i < b.coords.length; i += 2) expect(b.coords[i]).toBeGreaterThanOrEqual(nx - 1e-6);
    });

    it('takes each edge\'s look on its own side of the node', () => {
        const laneStyle = (e: {id: number}, r: string) => (r === 'A' && e.id === east ? {color: '#ff0000'} : null);
        const layout = layoutAtZoom(g, Z, style, {laneStyle});
        const [a, b] = pieces(layout.paths, 'A', west);
        expect(a.look.color).toBe('#000');
        expect(b.look.color).toBe('#ff0000');
        // The color changes at the node, not a node front past it.
        const seamX = a.coords[0] < nx ? a.coords[a.coords.length - 2] : a.coords[0];
        expect(Math.abs(seamX - nx)).toBeLessThan(1e-6);
    });

    it('is drawn across the cut as one line: no caps there, only the cut point\'s own vertices', () => {
        const layout = layoutAtZoom(g, Z, style);
        const opts = {scale: layout.scale, origin: [0, 0] as [number, number]};
        for (const route of ['A', 'B']) {
            const split = layout.paths.filter((p) => p.route === route && p.kind === 'connector');
            const whole = wholeConnectors(split);
            expect(whole).toHaveLength(1);
            // A cut inside a segment adds one vertex pair to each piece; caps would add two fans.
            expect(tessellate(split, opts).vertexCount - tessellate(whole, opts).vertexCount).toBeLessThanOrEqual(4);
        }
    });

    it('is hit, and listed in the lane features, as the edge on each side', () => {
        const layer = new LaneLayer({id: 'lanes', graph: g, sizes: style, cull: false, worker: false});
        const gl = new Proxy({}, {get: () => () => ({})}) as unknown as WebGL2RenderingContext;
        layer.onAdd({getTerrain: () => null} as never, gl);
        (layer as unknown as {rebuild(z: number): void}).rebuild(Z);
        // Two pixels either side of the cut, along A's pieces.
        const [a, b] = pieces(layoutAtZoom(g, Z, style).paths, 'A', west);
        const fromCut = (p: LanePath) => {
            const c = p.coords;
            // The cut is the piece's end nearest the node.
            const atEnd = Math.hypot(c[c.length - 2] - nx, c[c.length - 1] - ny) < Math.hypot(c[0] - nx, c[1] - ny);
            const [x0, y0, x1, y1] = atEnd ? [c[c.length - 2], c[c.length - 1], c[c.length - 4], c[c.length - 3]] : [c[0], c[1], c[2], c[3]];
            const l = Math.hypot(x1 - x0, y1 - y0), d = Math.min(2, l / 2);
            return mercatorToLngLat((x0 + ((x1 - x0) / l) * d) / scale, (y0 + ((y1 - y0) / l) * d) / scale);
        };
        const before = layer.queryLaneAt(fromCut(a), Z, 1)!;
        const after = layer.queryLaneAt(fromCut(b), Z, 1)!;
        expect([before.route, before.kind, before.edge]).toEqual(['A', 'connector', west]);
        expect([after.route, after.kind, after.edge]).toEqual(['A', 'connector', east]);
        const f = layer.laneFeatures({zoom: Z, extent: 'full', routes: ['A']}).features.filter((x) => x.properties!.kind === 'connector');
        expect(f.map((x) => x.properties!.edge)).toEqual([west, east]);
        const [x0, y0] = (f[1].geometry as GeoJSON.LineString).coordinates[0];
        const [mx, my] = lngLatToMercator(x0, y0);
        expect(Math.abs(mx * scale - nx)).toBeLessThan(1e-6);
        expect(Math.abs(my * scale - ny)).toBeLessThan(style().spacing);
    });
});

describe('a lane that curves into the node', () => {
    // The Pines at Lakeshore Park: a lane alone on its edge bends through the node front and
    // turns at the node. Its cut end's offset was read against a straight line through the node,
    // so the bend read as an offset change and moved the cut past the node: 27 px there, 8 px
    // here. What is left is the corner's own rounding.
    const deg = 360 / (512 * 2 ** 17);
    const arc: number[][] = [];
    for (let k = 0; k <= 12; k++) {
        // 1.5 radians of a 20 px circle, arriving at the node, at the origin, heading east.
        const t = 1.5 * (1 - k / 12);
        arc.push([-20 * Math.sin(t) * deg, (20 - 20 * Math.cos(t)) * deg]);
    }
    const g2 = buildLineGraph([
        line('A', [[arc[0][0] - 300 * Math.cos(1.5) * deg, arc[0][1] + 300 * Math.sin(1.5) * deg], ...arc, [0, -300 * deg]]),
        line('B', [[300 * deg, 0], [0, 0], [-300 * deg, -100 * deg]]),
        line('C', [[300 * deg, 20 * deg], [0, 0], [-300 * deg, -120 * deg]]),
    ]);
    orderLanes(g2);
    it('is cut at the node, not a front past it', () => {
        const z = 17, scale = 512 * 2 ** z;
        const layout = layoutAtZoom(g2, z, style);
        const n = g2.nodes.find((x) => x.ports.length >= 4)!;
        const [a, b] = layout.paths.filter((p) => p.kind === 'connector' && p.route === 'A');
        expect(a.edge).not.toBe(b.edge);
        const [cx, cy] = b.coords.slice(0, 2).join() === a.coords.slice(-2).join() ? b.coords : a.coords;
        expect(Math.hypot(cx - n.x * scale, cy - n.y * scale)).toBeLessThan(style().spacing / 2);
    });
});

