/**
 * Lane polylines to a triangle mesh whose width is applied in the vertex
 * shader, as in MapLibre's line bucket. Caps are round, and so are joins
 * sharper than the miter limit.
 */

import type {LaneLook, LanePath} from '../core/layout.js';
import type {Polyline} from '../core/geometry.js';

export interface Mesh {
    /**
     * Interleaved per vertex: ax, ay (anchor, in tile-local units of the
     * layer's reference tile), dx, dy (anchor-to-vertex, px), ex, ey
     * (extrude, px per unit width), nx, ny (unit normal for anti-aliasing),
     * s (distance along the route, px).
     */
    vertices: Float32Array;
    colors: Uint8Array;
    indices: Uint32Array;
    vertexCount: number;
    indexCount: number;
    /** Index ranges per draw pass, in drawing order: [firstIndex, count]. */
    groups: [number, number][];
    /** Route id of each group. A route's groups are always next to each other. */
    groupRoutes: string[];
    groupLooks: LaneLook[];
    /** Per group, the index range of its dot quads, [start, 0] where it has none. */
    groupDots: [number, number][];
    /**
     * Per group, its index range cut by graph edge, in index order:
     * [firstIndex, count, edge]. The pieces tile `groups[gi]` exactly, so
     * a draw can leave some edges out, or draw them apart, without a seam
     * in the dashes, whose phase is in the vertices.
     */
    groupPieces: Piece[][];
    /** The same cut of `groupDots[gi]`; empty where the group has no dots. */
    groupDotPieces: Piece[][];
}

/** An index range and the graph edge its triangles belong to: [firstIndex, count, edge]. */
export type Piece = [number, number, number];

/** Appends a piece, merged into the last one when it continues the same edge. */
function addPiece(pieces: Piece[], first: number, count: number, edge: number): void {
    if (count <= 0) return;
    const last = pieces[pieces.length - 1];
    if (last && last[2] === edge && last[0] + last[1] === first) last[1] += count;
    else pieces.push([first, count, edge]);
}

/**
 * A group's index range split by whether each piece's edge is in `bright`,
 * with neighbors on the same side merged so each side is as few draws as it
 * can be. Without a bright piece the whole range is dimmed, untouched.
 */
export function splitRanges(group: [number, number], pieces: Piece[], bright: ReadonlySet<number>): {dimmed: [number, number][]; bright: [number, number][]} {
    if (!pieces.some((p) => bright.has(p[2]))) return {dimmed: group[1] ? [[group[0], group[1]]] : [], bright: []};
    const out = {dimmed: [] as [number, number][], bright: [] as [number, number][]};
    for (const [first, count, edge] of pieces) {
        const side = bright.has(edge) ? out.bright : out.dimmed;
        const last = side[side.length - 1];
        if (last && last[0] + last[1] === first) last[1] += count;
        else side.push([first, count]);
    }
    return out;
}

const MITER_LIMIT = 2;
const DEG_PER_TRIANGLE = 15;
export const FLOATS_PER_VERTEX = 9;

class MeshBuilder {
    v: Float32Array;
    c: Uint8Array;
    i: Uint32Array;
    nv = 0;
    ni = 0;
    constructor(vertexCapacity: number, indexCapacity: number) {
        this.v = new Float32Array(vertexCapacity * FLOATS_PER_VERTEX);
        this.c = new Uint8Array(vertexCapacity * 4);
        this.i = new Uint32Array(indexCapacity);
    }
    reset() {
        this.nv = 0;
        this.ni = 0;
    }
    reserve(vertices: number, indices: number) {
        while ((this.nv + vertices) * FLOATS_PER_VERTEX > this.v.length) this.growV();
        while (this.ni + indices > this.i.length) this.growI();
    }
    private growV() {
        const v = new Float32Array(this.v.length * 2);
        v.set(this.v);
        this.v = v;
        const c = new Uint8Array(this.c.length * 2);
        c.set(this.c);
        this.c = c;
    }
    private growI() {
        const i = new Uint32Array(this.i.length * 2);
        i.set(this.i);
        this.i = i;
    }
    vertex(ax: number, ay: number, dx: number, dy: number, ex: number, ey: number, nx: number, ny: number, s: number, color: Uint8Array): number {
        if ((this.nv + 1) * FLOATS_PER_VERTEX > this.v.length) this.growV();
        const o = this.nv * FLOATS_PER_VERTEX;
        this.v[o] = ax;
        this.v[o + 1] = ay;
        this.v[o + 2] = dx;
        this.v[o + 3] = dy;
        this.v[o + 4] = ex;
        this.v[o + 5] = ey;
        this.v[o + 6] = nx;
        this.v[o + 7] = ny;
        this.v[o + 8] = s;
        // Four stores beat a typed-array `set` call for a color this short.
        const co = this.nv * 4;
        this.c[co] = color[0];
        this.c[co + 1] = color[1];
        this.c[co + 2] = color[2];
        this.c[co + 3] = color[3];
        return this.nv++;
    }
    tri(a: number, b: number, c: number) {
        if (this.ni + 3 > this.i.length) this.growI();
        this.i[this.ni++] = a;
        this.i[this.ni++] = b;
        this.i[this.ni++] = c;
    }
    quad(a1: number, a2: number, b1: number, b2: number) {
        this.tri(a1, a2, b1);
        this.tri(a2, b2, b1);
    }
}

/** The browser's normal form of a CSS color; null without a canvas (Node) or for a non-color. */
function normalizeColor(css: string): string | null {
    const ctx = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1).getContext('2d')
        : typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    if (!ctx) return null;
    // An invalid color leaves fillStyle as it was, so two different starts tell it apart.
    ctx.fillStyle = '#000000';
    ctx.fillStyle = css;
    const a = ctx.fillStyle;
    ctx.fillStyle = '#ffffff';
    ctx.fillStyle = css;
    return a === ctx.fillStyle && typeof a === 'string' ? a : null;
}

/** RGBA bytes of a CSS color; gray where it cannot be read. `normalized` stops a second canvas round. */
export function parseColor(css: string, normalized = false): Uint8Array {
    const out = new Uint8Array([136, 136, 136, 255]);
    const hex = css.trim();
    const m = /^#([0-9a-f]{3,8})$/i.exec(hex);
    if (m) {
        const h = m[1];
        if (h.length === 3 || h.length === 4) {
            out[0] = parseInt(h[0] + h[0], 16);
            out[1] = parseInt(h[1] + h[1], 16);
            out[2] = parseInt(h[2] + h[2], 16);
            out[3] = h.length === 4 ? parseInt(h[3] + h[3], 16) : 255;
        } else if (h.length === 6 || h.length === 8) {
            out[0] = parseInt(h.slice(0, 2), 16);
            out[1] = parseInt(h.slice(2, 4), 16);
            out[2] = parseInt(h.slice(4, 6), 16);
            out[3] = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
        }
        return out;
    }
    const named: Record<string, string> = {
        black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
        orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', navy: '#000080',
        magenta: '#ff00ff', fuchsia: '#ff00ff', lime: '#00ff00', brown: '#a52a2a', teal: '#008080', maroon: '#800000',
    };
    if (named[hex.toLowerCase()]) return parseColor(named[hex.toLowerCase()]);
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(hex);
    if (rgb) {
        const parts = rgb[1].split(/[\s,/]+/).filter((s) => s.length);
        for (let i = 0; i < 3 && i < parts.length; i++) {
            const v = parts[i].endsWith('%') ? parseFloat(parts[i]) * 255 / 100 : parseFloat(parts[i]);
            out[i] = Math.round(Math.max(0, Math.min(255, v || 0)));
        }
        if (parts.length > 3) {
            const a = parts[3].endsWith('%') ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
            out[3] = Math.round(Math.max(0, Math.min(1, a)) * 255);
        }
        return out;
    }
    const norm = normalized ? null : normalizeColor(hex);
    return norm ? parseColor(norm, true) : out;
}

interface Chunk {
    vertices: Float32Array;
    colors: Uint8Array;
    /** Local to this chunk, from 0. */
    indices: Uint32Array;
    vertexCount: number;
    startDistance: number;
    color: string;
}

/**
 * Per-path meshes kept between builds, keyed on the `LanePath` object a
 * `LayoutCache` hands back unchanged. A cached build's mesh is a view into
 * buffers the cache reuses: upload or copy it before the next call.
 */
export class TessellateCache {
    /** null marks a path met once: its triangles are kept from the second build on. */
    private chunks = new WeakMap<LanePath, Chunk | null>();
    private out: MeshBuilder | null = null;
    private key = '';

    clear(): void {
        this.chunks = new WeakMap();
        this.out = null;
        this.key = '';
    }

    /** @internal */
    builderFor(opts: TessellateOptions, estimate: number): MeshBuilder {
        const key = `${opts.scale}|${opts.origin[0]}|${opts.origin[1]}|${opts.unitsPerMercator ?? 1}`;
        if (key !== this.key) {
            this.chunks = new WeakMap();
            this.key = key;
        }
        if (!this.out) this.out = new MeshBuilder(Math.max(64, estimate * 3), Math.max(192, estimate * 9));
        this.out.reset();
        return this.out;
    }

    /** @internal */
    emit(b: MeshBuilder, p: LanePath, color: Uint8Array, opts: TessellateOptions): void {
        const hit = this.chunks.get(p);
        if (hit && hit.startDistance === p.startDistance && hit.color === p.look.color) {
            appendChunk(b, hit);
            return;
        }
        const nv = b.nv;
        const ni = b.ni;
        tessellatePath(b, p.coords, p.anchors, color, p.startDistance, opts);
        if (hit === undefined) {
            this.chunks.set(p, null);
            return;
        }
        const indices = new Uint32Array(b.ni - ni);
        for (let k = 0; k < indices.length; k++) indices[k] = b.i[ni + k] - nv;
        this.chunks.set(p, {
            vertices: b.v.slice(nv * FLOATS_PER_VERTEX, b.nv * FLOATS_PER_VERTEX),
            colors: b.c.slice(nv * 4, b.nv * 4),
            indices,
            vertexCount: b.nv - nv,
            startDistance: p.startDistance,
            color: p.look.color,
        });
    }
}

function appendChunk(b: MeshBuilder, chunk: Chunk): void {
    b.reserve(chunk.vertexCount, chunk.indices.length);
    b.v.set(chunk.vertices, b.nv * FLOATS_PER_VERTEX);
    b.c.set(chunk.colors, b.nv * 4);
    const base = b.nv;
    for (let k = 0; k < chunk.indices.length; k++) b.i[b.ni + k] = chunk.indices[k] + base;
    b.nv += chunk.vertexCount;
    b.ni += chunk.indices.length;
}

export interface TessellateOptions {
    /** Pixels per Mercator unit at the layout zoom. */
    scale: number;
    /** Mercator position mapped to anchor (0, 0): the reference tile's corner. */
    origin: [number, number];
    /** Anchor units per Mercator unit (EXTENT * 2^tileZoom). Default 1. */
    unitsPerMercator?: number;
    /** Route ids in drawing order; each becomes one index range. Default: one range for everything. */
    drawOrder?: string[];
    /**
     * Lane fill width at the layout zoom, px. With it, a dotted look gets
     * one quad per dot, which stays round at a bend.
     */
    width?: number;
    cache?: TessellateCache;
}

export function tessellate(paths: LanePath[], opts: TessellateOptions): Mesh {
    let est = 0;
    for (const p of paths) est += p.coords.length;
    const cache = opts.cache ?? null;
    const b = cache ? cache.builderFor(opts, est) : new MeshBuilder(Math.max(64, est * 3), Math.max(192, est * 9));
    const colorCache = new Map<string, Uint8Array>();
    const groups: [number, number][] = [];
    const groupRoutes: string[] = [];
    const groupLooks: LaneLook[] = [];
    const groupDots: [number, number][] = [];
    const groupPieces: Piece[][] = [];
    const groupDotPieces: Piece[][] = [];
    // A group per look, since the dash is a uniform; a route's groups stay
    // adjacent so all its casings can draw before any fill.
    const byRoute = new Map<string, Map<LaneLook, LanePath[]>>();
    for (const p of paths) {
        let byLook = byRoute.get(p.route);
        if (!byLook) byRoute.set(p.route, (byLook = new Map()));
        let l = byLook.get(p.look);
        if (!l) byLook.set(p.look, (l = []));
        l.push(p);
    }
    const order = opts.drawOrder ?? [...byRoute.keys()];
    for (const rid of order) {
        const byLook = byRoute.get(rid);
        if (!byLook) continue;
        for (const [look, list] of byLook) {
            const start = b.ni;
            let c = colorCache.get(look.color);
            if (!c) colorCache.set(look.color, (c = parseColor(look.color)));
            const pieces: Piece[] = [];
            for (const p of list) {
                const from = b.ni;
                if (cache) cache.emit(b, p, c, opts);
                else tessellatePath(b, p.coords, p.anchors, c, p.startDistance, opts);
                addPiece(pieces, from, b.ni - from, p.edge);
            }
            if (b.ni > start) {
                groups.push([start, b.ni - start]);
                groupRoutes.push(rid);
                groupLooks.push(look);
                groupPieces.push(pieces);
                const dots = b.ni;
                const dotPieces: Piece[] = [];
                if (opts.width && look.dash && look.dash[0] === 0 && look.dash[1] > 0) {
                    for (const p of list) {
                        const from = b.ni;
                        dotsOnPath(b, p.coords, p.anchors, c, p.startDistance, look.dash[1] * opts.width, opts);
                        addPiece(dotPieces, from, b.ni - from, p.edge);
                    }
                }
                groupDots.push([dots, b.ni - dots]);
                groupDotPieces.push(dotPieces);
            }
        }
    }
    return {
        vertices: b.v.subarray(0, b.nv * FLOATS_PER_VERTEX),
        colors: b.c.subarray(0, b.nv * 4),
        indices: b.i.subarray(0, b.ni),
        vertexCount: b.nv,
        indexCount: b.ni,
        groups,
        groupRoutes,
        groupLooks,
        groupDots,
        groupPieces,
        groupDotPieces,
    };
}

/**
 * One quad per dot, centered where the fragment shader would put it so
 * consecutive pieces keep one rhythm. Corner normals are the unit square's
 * corners, so the shader draws a disc however the path bends.
 */
function dotsOnPath(b: MeshBuilder, px: Polyline, anchorsPx: Polyline, color: Uint8Array, startDistance: number, period: number, opts: TessellateOptions): void {
    const n = px.length / 2;
    if (n < 2) return;
    let total = 0;
    for (let i = 1; i < n; i++) total += Math.hypot(px[i * 2] - px[i * 2 - 2], px[i * 2 + 1] - px[i * 2 - 1]);
    if (total <= 0) return;
    const back = startDistance < 0;
    const s0 = Math.abs(startDistance);
    const lo = back ? s0 - total : s0;
    const {scale, origin} = opts;
    const upm = opts.unitsPerMercator ?? 1;
    let seg = 1, before = 0, len = Math.hypot(px[2] - px[0], px[3] - px[1]);
    // Half open, so a dot on the joint of two pieces belongs to one of them.
    const first = Math.ceil((lo - period / 2) / period);
    const count = Math.max(0, Math.ceil((lo + total - period / 2) / period) - first);
    for (let k = 0; k < count; k++) {
        const center = period / 2 + (back ? first + count - 1 - k : first + k) * period;
        const at = back ? s0 - center : center - s0;
        while (seg < n - 1 && at > before + len) {
            before += len;
            seg++;
            len = Math.hypot(px[seg * 2] - px[seg * 2 - 2], px[seg * 2 + 1] - px[seg * 2 - 1]);
        }
        const t = len > 0 ? Math.max(0, Math.min(1, (at - before) / len)) : 0;
        const i = (seg - 1) * 2, j = seg * 2;
        const x = px[i] + (px[j] - px[i]) * t, y = px[i + 1] + (px[j + 1] - px[i + 1]) * t;
        const gx = anchorsPx[i] + (anchorsPx[j] - anchorsPx[i]) * t, gy = anchorsPx[i + 1] + (anchorsPx[j + 1] - anchorsPx[i + 1]) * t;
        const ax = (gx / scale - origin[0]) * upm, ay = (gy / scale - origin[1]) * upm;
        const v0 = b.vertex(ax, ay, x - gx, y - gy, -1, -1, -1, -1, center, color);
        const v1 = b.vertex(ax, ay, x - gx, y - gy, 1, -1, 1, -1, center, color);
        const v2 = b.vertex(ax, ay, x - gx, y - gy, 1, 1, 1, 1, center, color);
        const v3 = b.vertex(ax, ay, x - gx, y - gy, -1, 1, -1, 1, center, color);
        b.tri(v0, v1, v2);
        b.tri(v0, v2, v3);
    }
}

function tessellatePath(b: MeshBuilder, px: Polyline, anchorsPx: Polyline, color: Uint8Array, startDistance: number, opts: TessellateOptions): void {
    const pts: number[] = [];
    const anc: number[] = [];
    for (let i = 0; i < px.length; i += 2) {
        const n = pts.length;
        if (n >= 2 && Math.abs(pts[n - 2] - px[i]) < 1e-6 && Math.abs(pts[n - 1] - px[i + 1]) < 1e-6) continue;
        pts.push(px[i], px[i + 1]);
        anc.push(anchorsPx[i], anchorsPx[i + 1]);
    }
    const n = pts.length / 2;
    if (n < 2) return;
    const {scale, origin} = opts;
    const upm = opts.unitsPerMercator ?? 1;
    const AX = (i: number) => (anc[i * 2] / scale - origin[0]) * upm;
    const AY = (i: number) => (anc[i * 2 + 1] / scale - origin[1]) * upm;
    const DX = (i: number) => pts[i * 2] - anc[i * 2];
    const DY = (i: number) => pts[i * 2 + 1] - anc[i * 2 + 1];
    // A negative startDistance means the route travels this piece backward.
    const along = new Float64Array(n);
    for (let i = 1; i < n; i++) along[i] = along[i - 1] + Math.hypot(pts[i * 2] - pts[i * 2 - 2], pts[i * 2 + 1] - pts[i * 2 - 1]);
    const S = (i: number) => (startDistance < 0 ? -startDistance - along[i] : startDistance + along[i]);

    let lastL = -1;
    let lastR = -1;
    const pair = (i: number, ex: number, ey: number, nx: number, ny: number, connect: boolean) => {
        const ax = AX(i), ay = AY(i), dx = DX(i), dy = DY(i), s = S(i);
        const l = b.vertex(ax, ay, dx, dy, ex, ey, nx, ny, s, color);
        const r = b.vertex(ax, ay, dx, dy, -ex, -ey, -nx, -ny, s, color);
        if (connect && lastL >= 0) b.quad(lastL, lastR, l, r);
        lastL = l;
        lastR = r;
    };
    const fan = (i: number, fromX: number, fromY: number, toX: number, toY: number, ccwOnScreen: boolean) => {
        const ax = AX(i), ay = AY(i), dx = DX(i), dy = DY(i), s = S(i);
        const c = b.vertex(ax, ay, dx, dy, 0, 0, 0, 0, s, color);
        const a0 = Math.atan2(fromY, fromX);
        let da = Math.atan2(toY, toX) - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        // For a semicircle the short side is ambiguous; ccwOnScreen picks it.
        if (Math.abs(Math.abs(da) - Math.PI) < 1e-6) da = ccwOnScreen ? -Math.PI : Math.PI;
        const steps = Math.max(1, Math.ceil((Math.abs(da) * 180) / Math.PI / DEG_PER_TRIANGLE));
        let prev = b.vertex(ax, ay, dx, dy, fromX, fromY, fromX, fromY, s, color);
        for (let k = 1; k <= steps; k++) {
            const a = a0 + (da * k) / steps;
            const vx = Math.cos(a), vy = Math.sin(a);
            const cur = b.vertex(ax, ay, dx, dy, vx, vy, vx, vy, s, color);
            b.tri(c, prev, cur);
            prev = cur;
        }
    };

    // Each segment's unit direction once: a vertex reads the segment before it and after it.
    const sdx = new Float64Array(n - 1);
    const sdy = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
        const dx = pts[i * 2 + 2] - pts[i * 2];
        const dy = pts[i * 2 + 3] - pts[i * 2 + 1];
        const l = Math.hypot(dx, dy) || 1;
        sdx[i] = dx / l;
        sdy[i] = dy / l;
    }

    for (let i = 0; i < n; i++) {
        const hasPrev = i > 0;
        const hasNext = i < n - 1;
        const dPrevX = hasPrev ? sdx[i - 1] : 0, dPrevY = hasPrev ? sdy[i - 1] : 0;
        const dNextX = hasNext ? sdx[i] : 0, dNextY = hasNext ? sdy[i] : 0;
        const nPrevX = dPrevY, nPrevY = -dPrevX;
        const nNextX = dNextY, nNextY = -dNextX;

        if (!hasPrev) {
            fan(i, nNextX, nNextY, -nNextX, -nNextY, true);
            pair(i, nNextX, nNextY, nNextX, nNextY, false);
            continue;
        }
        if (!hasNext) {
            pair(i, nPrevX, nPrevY, nPrevX, nPrevY, true);
            fan(i, nPrevX, nPrevY, -nPrevX, -nPrevY, false);
            continue;
        }
        let jx = nPrevX + nNextX;
        let jy = nPrevY + nNextY;
        const jl = Math.hypot(jx, jy);
        if (jl < 1e-9) {
            pair(i, nPrevX, nPrevY, nPrevX, nPrevY, true);
            fan(i, nPrevX, nPrevY, -nPrevX, -nPrevY, false);
            pair(i, nNextX, nNextY, nNextX, nNextY, false);
            continue;
        }
        jx /= jl;
        jy /= jl;
        const cosHalf = jx * nNextX + jy * nNextY;
        const miterLen = cosHalf > 1e-6 ? 1 / cosHalf : Infinity;
        if (miterLen <= MITER_LIMIT) {
            pair(i, jx * miterLen, jy * miterLen, jx, jy, true);
        } else {
            const cross = dPrevX * dNextY - dPrevY * dNextX;
            // Right turn on screen (cross > 0 in y-down): outside is the left side.
            const outsideLeft = cross > 0;
            pair(i, nPrevX, nPrevY, nPrevX, nPrevY, true);
            if (outsideLeft) fan(i, nPrevX, nPrevY, nNextX, nNextY, false);
            else fan(i, -nPrevX, -nPrevY, -nNextX, -nNextY, false);
            pair(i, nNextX, nNextY, nNextX, nNextY, false);
        }
    }
}
