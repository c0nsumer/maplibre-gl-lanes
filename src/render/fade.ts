/**
 * The last build's dash phase, read at each vertex of a new mesh, so a dash fade can dissolve the
 * pattern that was on screen into the new one on the new mesh alone. Both builds measure distance
 * along the route's travel, continuous across seams, so the nearest point on the last build's lane
 * of the same route says where its pattern stood. This is not from the cited papers and was worked
 * out for this project.
 */

import type {LanePath} from '../core/layout.js';
import type {Mesh} from './tessellate.js';
import {FLOATS_PER_VERTEX} from './tessellate.js';

/** What reading a build's phase needs of it. */
export interface PhaseSource {
    /** Its lanes; only the dashed ones are read. */
    paths: readonly LanePath[];
    /** Its build zoom and pixels per Mercator unit there. */
    zoom: number;
    scale: number;
}

/** Search reach around a vertex, screen px: a lane that moved further than this does not fade. */
const REACH_PX = 24;
/**
 * Added to the distance, px, for a segment across the vertex's line rather than along it: a tie
 * breaker where two passes of a route cross. More, and a round cap's vertices, whose normals run
 * along the line, are pushed off their own segment.
 */
const CROSS_PX = 1;
/**
 * Added per px between a segment's distance along and the vertex's own, scaled to the source's
 * zoom: a tie breaker where a loop closes, or two parts of a route drawn apart meet, and two
 * pieces end at one point with distances far apart. Both are measured from the same root, so
 * the right one is near the scaled distance.
 */
const PHASE_WEIGHT = 0.002;
/** Numbers per segment in a route's list. */
const SEG = 9;

/** Every segment in a cell's 3 by 3 neighborhood, each once. */
function around(grid: Map<number, number[]>, gx: number, gy: number): Int32Array {
    const out: number[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const c = grid.get(keyOf(gx + dx, gy + dy));
        if (c) for (const k of c) out.push(k);
    }
    out.sort((a, b) => a - b);
    let n = 0;
    for (let i = 0; i < out.length; i++) if (!i || out[i] !== out[i - 1]) out[n++] = out[i];
    return Int32Array.from(out.slice(0, n));
}

/** Exact in a double for any cell count a graph tile can have, negative cells included. */
function keyOf(cx: number, cy: number): number {
    return (cx + 4194304) * 8388608 + (cy + 4194304);
}

/**
 * Per vertex of `mesh`: [distance along in the source's build pixels, 1], or [0, 0] where its
 * dashed lanes have no match. Null when nothing in the mesh is dashed.
 */
export function alongFromSource(mesh: Mesh, src: PhaseSource, zoom: number, origin: [number, number], unitsPerMercator: number): Float32Array | null {
    const dashed = new Set<string>();
    for (let gi = 0; gi < mesh.groups.length; gi++) if (mesh.groupLooks[gi].dash) dashed.add(mesh.groupRoutes[gi]);
    if (!dashed.size) return null;
    // Anchors in tile units, deltas in screen px: both meshes put a lane center there at `zoom`.
    const upp = unitsPerMercator / (512 * Math.pow(2, zoom));
    // As wide as the reach, so a cell and its neighbors hold every segment in reach.
    const cell = REACH_PX * upp;
    // Segments by route, SEG numbers each: start x, y; extent x, y; 1 / length squared (0 for a
    // point); distance along at the start and its change over the segment; unit direction x, y.
    const segs = new Map<string, number[]>();
    const nears = new Map<string, Map<number, Int32Array>>();
    const grids = new Map<string, Map<number, number[]>>();
    for (const p of src.paths) {
        if (!p.look.dash || !dashed.has(p.route)) continue;
        let list = segs.get(p.route);
        if (!list) {
            segs.set(p.route, (list = []));
            grids.set(p.route, new Map());
        }
        const grid = grids.get(p.route)!;
        const px = p.coords, an = p.anchors;
        // As `tessellatePath` measures it: repeated points dropped, a negative start runs backward.
        let along = 0, lx = NaN, ly = NaN, lcx = 0, lcy = 0, ls = 0;
        const sd = p.startDistance;
        for (let i = 0; i < px.length; i += 2) {
            if (i > 0 && Math.abs(px[i] - lx) < 1e-6 && Math.abs(px[i + 1] - ly) < 1e-6) continue;
            if (i > 0) along += Math.hypot(px[i] - lx, px[i + 1] - ly);
            const s = sd < 0 ? -sd - along : sd + along;
            const cx = (an[i] / src.scale - origin[0]) * unitsPerMercator + (px[i] - an[i]) * upp;
            const cy = (an[i + 1] / src.scale - origin[1]) * unitsPerMercator + (px[i + 1] - an[i + 1]) * upp;
            if (i > 0) {
                const k = list.length / SEG;
                const ex = cx - lcx, ey = cy - lcy, l2 = ex * ex + ey * ey, l = Math.sqrt(l2);
                list.push(lcx, lcy, ex, ey, l2 > 0 ? 1 / l2 : 0, ls, s - ls, l > 0 ? ex / l : 0, l > 0 ? ey / l : 0);
                // A long straight segment crosses many cells: walked in half cells, it lands in
                // each, and not in every cell of its bounding box.
                const steps = Math.ceil(Math.sqrt((cx - lcx) * (cx - lcx) + (cy - lcy) * (cy - lcy)) / (cell / 2));
                let lastKey = NaN;
                for (let j = 0; j <= steps; j++) {
                    const f = steps ? j / steps : 0;
                    const key = keyOf(Math.floor((lcx + (cx - lcx) * f) / cell), Math.floor((lcy + (cy - lcy) * f) / cell));
                    if (key === lastKey) continue;
                    lastKey = key;
                    let c = grid.get(key);
                    if (!c) grid.set(key, (c = []));
                    if (c[c.length - 1] !== k) c.push(k);
                }
            }
            lx = px[i];
            ly = px[i + 1];
            lcx = cx;
            lcy = cy;
            ls = s;
        }
    }
    const out = new Float32Array(mesh.vertexCount * 2);
    const seen = new Uint8Array(mesh.vertexCount);
    const v = mesh.vertices, idx = mesh.indices;
    const reach = REACH_PX * upp, reach2 = reach * reach, cross = CROSS_PX * upp;
    const phase = PHASE_WEIGHT * upp;
    const toSource = Math.pow(2, src.zoom - zoom);
    for (let gi = 0; gi < mesh.groups.length; gi++) {
        if (!mesh.groupLooks[gi].dash) continue;
        const route = mesh.groupRoutes[gi];
        const list = segs.get(route);
        const grid = grids.get(route);
        if (!list || !grid) continue;
        // The segments of a cell and its eight neighbors, once each: a lane's vertices come in
        // runs through one cell, so the merge is shared.
        let near = nears.get(route);
        if (!near) nears.set(route, (near = new Map()));
        const [first, count] = mesh.groups[gi];
        for (let k = first; k < first + count; k++) {
            const vi = idx[k];
            if (seen[vi]) continue;
            seen[vi] = 1;
            const o = vi * FLOATS_PER_VERTEX;
            const x = v[o] + v[o + 2] * upp, y = v[o + 1] + v[o + 3] * upp;
            const nl = Math.sqrt(v[o + 6] * v[o + 6] + v[o + 7] * v[o + 7]);
            const nx = nl > 0 ? v[o + 6] / nl : 0, ny = nl > 0 ? v[o + 7] / nl : 0;
            const expect = v[o + 8] * toSource;
            const gx = Math.floor(x / cell), gy = Math.floor(y / cell);
            const key = keyOf(gx, gy);
            let c = near.get(key);
            if (!c) near.set(key, (c = around(grid, gx, gy)));
            let best = Infinity, bestS = 0;
            for (let j = 0; j < c.length; j++) {
                const b = c[j] * SEG;
                const ax = list[b], ay = list[b + 1], ex = list[b + 2], ey = list[b + 3], il2 = list[b + 4];
                let t = ((x - ax) * ex + (y - ay) * ey) * il2;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const qx = x - ax - ex * t, qy = y - ay - ey * t;
                const q2 = qx * qx + qy * qy;
                if (q2 > reach2) continue;
                let d = Math.sqrt(q2);
                // A ribbon vertex's normal is across its line: a segment along the normal
                // belongs to another pass of the route, such as a crossing.
                if (nl > 0) d += cross * Math.abs(list[b + 7] * nx + list[b + 8] * ny);
                const s = list[b + 5] + list[b + 6] * t;
                d += phase * Math.abs(s - expect);
                if (d < best) {
                    best = d;
                    bestS = s;
                }
            }
            if (best < Infinity) {
                out[vi * 2] = bestS;
                out[vi * 2 + 1] = 1;
            }
        }
    }
    return out;
}
