import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom, laneOffset} from '../src/core/layout';
import {polylineLength, type Polyline} from '../src/core/geometry';

function load(name: string) {
    return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
}

function distToPolyline(x: number, y: number, p: Polyline): number {
    let best = Infinity;
    for (let i = 0; i + 3 < p.length; i += 2) {
        const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
        const dx = bx - ax, dy = by - ay;
        const l2 = dx * dx + dy * dy;
        const t = Math.max(0, Math.min(1, l2 > 0 ? ((x - ax) * dx + (y - ay) * dy) / l2 : 0));
        best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
    }
    return best;
}

/**
 * For every pair of routes that make the same turn in adjacent lanes,
 * measure how far their connectors stray from the lane pitch. A pair is
 * counted when its deviation exceeds `limitPx` anywhere along the curve.
 */
function pairsOffPitch(name: string, zoom: number, limitPx: number): {pairs: number; off: number; worst: number; closest: number} {
    const fc = load(name);
    const g = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
    orderLanes(g);
    const spacing = 8;
    const layout = layoutAtZoom(g, zoom, () => ({spacing, width: 6, casingWidth: 1}));
    const conns = new Map<string, Polyline>();
    for (const p of layout.paths) if (p.kind === 'connector') conns.set(`${p.node}:${p.route}:${p.between![0]}:${p.between![1]}`, p.coords);
    let pairs = 0, off = 0, worst = 0, closest = Infinity;
    for (const node of g.nodes) {
        const groups = new Map<string, {lateral: number; coords: Polyline}[]>();
        for (const t of node.transitions) {
            if (t.from < 0 || t.to < 0) continue;
            const pu = node.ports[t.from], pv = node.ports[t.to];
            const coords = conns.get(`${node.id}:${t.route}:${pu.edge}:${pv.edge}`);
            if (!coords) continue;
            const oIn = (pu.end === 'b' ? 1 : -1) * laneOffset(g.edges[pu.edge], t.route, spacing);
            const oOut = (pv.end === 'a' ? 1 : -1) * laneOffset(g.edges[pv.edge], t.route, spacing);
            const key = `${pu.edge}:${pv.edge}:${(oIn - oOut).toFixed(3)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key)!.push({lateral: oIn, coords});
        }
        for (const grp of groups.values()) {
            grp.sort((a, b) => a.lateral - b.lateral);
            for (let i = 1; i < grp.length; i++) {
                const a = grp[i - 1], b = grp[i];
                if (Math.abs(b.lateral - a.lateral - spacing) > 1e-6) continue;
                if (polylineLength(a.coords) < 2 * spacing) continue;
                pairs++;
                let dev = 0;
                for (let k = 0; k < a.coords.length; k += 2) {
                    const gap = distToPolyline(a.coords[k], a.coords[k + 1], b.coords);
                    dev = Math.max(dev, Math.abs(gap - spacing));
                    closest = Math.min(closest, gap);
                }
                worst = Math.max(worst, dev);
                if (dev > limitPx) off++;
            }
        }
    }
    return {pairs, off, worst, closest};
}

describe('connectors of routes turning together', () => {
    // Lanes turning together no longer hold the pitch exactly through a
    // turn, and should not: a lane turns at a corner on its own line, so
    // the corners of a bundle are staggered and the gap across the turn
    // opens by up to the diagonal of a pitch, about 0.41 of one for a
    // square corner. What must still hold is that the gap never closes or
    // opens far enough to pinch, which is what a shared reference curve
    // was introduced for on 2026-09-16: before it, RAMBA at z16 had 10 of
    // 41 adjacent pairs more than a pixel off the pitch, in both
    // directions, and lanes visibly converged mid-turn.
    it('keep a lane apart from its neighbor through the turn', () => {
        // The stagger itself is the 2 to 3 px seen at z18 and on MFO. The
        // one pair beyond that on RAMBA at z16 is a tight turn where the
        // lanes take different shapes, which the shared reference never
        // covered either: the old test allowed seven such pairs.
        const cases: [string, number, number][] = [
            ['ramba.src.geojson', 16, 2],
            ['ramba.src.geojson', 18, 0],
            ['mfo.src.geojson', 16, 0],
            ['mfo.src.geojson', 18, 0],
        ];
        for (const [name, zoom, allowed] of cases) {
            const r = pairsOffPitch(name, zoom, 0.6 * 8);
            expect(r.pairs).toBeGreaterThan(20);
            expect(r.off).toBeLessThanOrEqual(allowed);
            expect(r.closest).toBeGreaterThan(0.5 * 8);
        }
    }, 60000);
});
