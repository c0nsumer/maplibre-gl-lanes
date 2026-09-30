/** Polylines are flat [x0, y0, x1, y1, ...] in a y-down frame, so left of d is (d.y, -d.x). */

export type Vec = [number, number];
export type Polyline = number[];

export function polylineLength(p: Polyline): number {
    let len = 0;
    for (let i = 2; i < p.length; i += 2) {
        len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    }
    return len;
}

export function reversed(p: Polyline): Polyline {
    const out: Polyline = new Array(p.length);
    for (let i = 0, j = p.length - 2; i < p.length; i += 2, j -= 2) {
        out[i] = p[j];
        out[i + 1] = p[j + 1];
    }
    return out;
}

export function startDirection(p: Polyline): Vec {
    for (let i = 2; i < p.length; i += 2) {
        const dx = p[i] - p[0];
        const dy = p[i + 1] - p[1];
        const l = Math.hypot(dx, dy);
        if (l > 0) return [dx / l, dy / l];
    }
    return [0, 0];
}

export function endDirection(p: Polyline): Vec {
    const n = p.length;
    for (let i = n - 4; i >= 0; i -= 2) {
        const dx = p[n - 2] - p[i];
        const dy = p[n - 1] - p[i + 1];
        const l = Math.hypot(dx, dy);
        if (l > 0) return [dx / l, dy / l];
    }
    return [0, 0];
}

/** Trim both ends by length; cuts that would leave less than `keepFraction` are scaled down together. */
export function trimPolyline(p: Polyline, fromStart: number, fromEnd: number, keepFraction = 0.2): Polyline {
    const total = polylineLength(p);
    if (total <= 0) return p.slice();
    const maxCut = total * (1 - keepFraction);
    if (fromStart + fromEnd > maxCut) {
        const s = maxCut / (fromStart + fromEnd);
        fromStart *= s;
        fromEnd *= s;
    }
    const startPt = pointAlong(p, fromStart);
    const endPt = pointAlong(p, total - fromEnd);
    const out: Polyline = [startPt.x, startPt.y];
    let acc = 0;
    for (let i = 2; i < p.length; i += 2) {
        acc += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
        if (acc > fromStart && acc < total - fromEnd) {
            out.push(p[i], p[i + 1]);
        }
    }
    out.push(endPt.x, endPt.y);
    return out;
}

export function pointAlong(p: Polyline, dist: number): {x: number; y: number} {
    if (dist <= 0) return {x: p[0], y: p[1]};
    let acc = 0;
    for (let i = 2; i < p.length; i += 2) {
        const seg = Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
        if (acc + seg >= dist) {
            const t = seg > 0 ? (dist - acc) / seg : 0;
            return {x: p[i - 2] + (p[i] - p[i - 2]) * t, y: p[i - 1] + (p[i + 1] - p[i - 1]) * t};
        }
        acc += seg;
    }
    return {x: p[p.length - 2], y: p[p.length - 1]};
}

export function simplify(p: Polyline, tolerance: number): Polyline {
    const n = p.length / 2;
    if (n <= 2 || tolerance <= 0) return p.slice();
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const tol2 = tolerance * tolerance;
    const stack: number[] = [0, n - 1];
    while (stack.length) {
        const last = stack.pop()!;
        const first = stack.pop()!;
        let maxD = 0;
        let idx = -1;
        const ax = p[first * 2], ay = p[first * 2 + 1];
        const bx = p[last * 2], by = p[last * 2 + 1];
        for (let i = first + 1; i < last; i++) {
            const d = segmentDistanceSq(p[i * 2], p[i * 2 + 1], ax, ay, bx, by);
            if (d > maxD) {
                maxD = d;
                idx = i;
            }
        }
        if (maxD > tol2 && idx > 0) {
            keep[idx] = 1;
            stack.push(first, idx, idx, last);
        }
    }
    const out: Polyline = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
    return out;
}

function segmentDistanceSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    let dx = bx - ax;
    let dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (l2 > 0) {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
        dx = ax + dx * t;
        dy = ay + dy * t;
    } else {
        dx = ax;
        dy = ay;
    }
    return (px - dx) * (px - dx) + (py - dy) * (py - dy);
}

export function dedupe(p: Polyline, eps = 1e-9): Polyline {
    const out: Polyline = [];
    for (let i = 0; i < p.length; i += 2) {
        const n = out.length;
        if (n >= 2 && Math.abs(out[n - 2] - p[i]) < eps && Math.abs(out[n - 1] - p[i + 1]) < eps) continue;
        out.push(p[i], p[i + 1]);
    }
    return out;
}

/** Loop removal's search window, in offsets: a hairpin's inside loop has a throat several offsets long. */
const LOOP_WINDOW_OFFSETS = 12;

/** Offset sideways by `d`, positive = left of travel, with the loops of tight bends removed. */
export function offsetPolyline(p: Polyline, d: number, arcStepRad = Math.PI / 9): Polyline {
    return offsetPolylineAnchored(p, d, arcStepRad).points;
}

/** `offsetPolyline` plus each output vertex's source vertex, which the renderer anchors to the ground. */
export function offsetPolylineAnchored(p: Polyline, d: number, arcStepRad = Math.PI / 9): {points: Polyline; anchors: Polyline} {
    const src = dedupe(p);
    const n = src.length / 2;
    if (n < 2 || d === 0) return {points: src.slice(), anchors: src.slice()};

    const segs: number[][] = [];
    for (let i = 0; i < n - 1; i++) {
        const ax = src[i * 2], ay = src[i * 2 + 1];
        const bx = src[i * 2 + 2], by = src[i * 2 + 3];
        const dx = bx - ax, dy = by - ay;
        const l = Math.hypot(dx, dy);
        const nx = dy / l, ny = -dx / l; // left normal
        segs.push([ax + nx * d, ay + ny * d, bx + nx * d, by + ny * d]);
    }

    const out: Polyline = [segs[0][0], segs[0][1]];
    const anchors: Polyline = [src[0], src[1]];
    for (let i = 1; i < segs.length; i++) {
        const s0 = segs[i - 1];
        const s1 = segs[i];
        const vx = src[i * 2], vy = src[i * 2 + 1];
        const cross = (s0[2] - s0[0]) * (s1[3] - s1[1]) - (s0[3] - s0[1]) * (s1[2] - s1[0]);
        const dot = (s0[2] - s0[0]) * (s1[2] - s1[0]) + (s0[3] - s0[1]) * (s1[3] - s1[1]);
        // A left offset (d > 0) is outside a right turn (cross > 0, y-down).
        const outside = (d > 0) === (cross > 0);
        const isNearlyStraight = Math.abs(cross) < 1e-9 * Math.max(1, Math.abs(dot));
        if (isNearlyStraight) {
            out.push(s1[0], s1[1]);
            anchors.push(vx, vy);
            continue;
        }
        if (!outside) {
            const ix = intersectLines(s0[0], s0[1], s0[2], s0[3], s1[0], s1[1], s1[2], s1[3]);
            if (ix) {
                out.push(ix[0], ix[1]);
                anchors.push(vx, vy);
            } else {
                out.push(s0[2], s0[3], s1[0], s1[1]);
                anchors.push(vx, vy, vx, vy);
            }
            continue;
        }
        const a0 = Math.atan2(s0[3] - vy, s0[2] - vx);
        const a1 = Math.atan2(s1[1] - vy, s1[0] - vx);
        let da = a1 - a0;
        while (da > Math.PI) da -= 2 * Math.PI;
        while (da < -Math.PI) da += 2 * Math.PI;
        const steps = Math.max(1, Math.ceil(Math.abs(da) / arcStepRad));
        const r = Math.abs(d);
        out.push(s0[2], s0[3]);
        anchors.push(vx, vy);
        for (let k = 1; k < steps; k++) {
            const a = a0 + (da * k) / steps;
            out.push(vx + Math.cos(a) * r, vy + Math.sin(a) * r);
            anchors.push(vx, vy);
        }
        out.push(s1[0], s1[1]);
        anchors.push(vx, vy);
    }
    const last = segs[segs.length - 1];
    out.push(last[2], last[3]);
    anchors.push(src[src.length - 2], src[src.length - 1]);
    const open = removeLoopsAnchored(out, anchors, Math.abs(d) * LOOP_WINDOW_OFFSETS);
    dropEndHook(open, src[2] - src[0], src[3] - src[1], 0, 2 * Math.abs(d));
    dropEndHook(open, src[src.length - 2] - src[src.length - 4], src[src.length - 1] - src[src.length - 3], 1, 2 * Math.abs(d));
    return open;
}

/**
 * A bend within the offset of an end leaves an open loop there that no
 * crossing reveals; it runs against the source direction (`dx`, `dy`).
 * Left in, even a subpixel hook sets the direction a connector leaves by.
 * The end point stays put, so lane ends stay in line across a bundle front.
 */
function dropEndHook(line: {points: Polyline; anchors: Polyline}, dx: number, dy: number, end: 0 | 1, reach: number): void {
    const {points, anchors} = line;
    // Beyond `reach`, running against the end is a real turn, not a hook.
    const e = end ? points.length - 2 : 0;
    const step = end ? -2 : 2;
    let hook = 0;
    for (let v = e + step; v >= 0 && v < points.length; v += step) {
        const ex = points[e] - points[v], ey = points[e + 1] - points[v + 1];
        if (Math.hypot(ex, ey) > reach || (end ? 1 : -1) * (ex * dx + ey * dy) > 0) break;
        hook++;
    }
    hook = Math.min(hook, points.length / 2 - 2);
    if (hook <= 0) return;
    const from = end ? e - 2 * hook : 2;
    points.splice(from, 2 * hook);
    anchors.splice(from, 2 * hook);
}

/**
 * Offset sliding from `d0` to `d1` by arc length, through the `via` knots,
 * flat [fraction of length, offset] pairs. Vertices move along miter-limited
 * bisectors, so joins stay simple.
 */
export function offsetPolylineSlidingAnchored(p: Polyline, d0: number, d1: number, stepPx = 4, via: number[] = []): {points: Polyline; anchors: Polyline} {
    const src = dedupe(p);
    const n = src.length / 2;
    if (n < 2) return {points: src.slice(), anchors: src.slice()};
    const dense: Polyline = [src[0], src[1]];
    for (let i = 1; i < n; i++) {
        const ax = src[i * 2 - 2], ay = src[i * 2 - 1], bx = src[i * 2], by = src[i * 2 + 1];
        const l = Math.hypot(bx - ax, by - ay);
        const k = Math.max(1, Math.ceil(l / stepPx));
        for (let j = 1; j <= k; j++) dense.push(ax + ((bx - ax) * j) / k, ay + ((by - ay) * j) / k);
    }
    const m = dense.length / 2;
    const total = polylineLength(dense);
    const out: Polyline = new Array(dense.length);
    let s = 0;
    for (let i = 0; i < m; i++) {
        const x = dense[i * 2], y = dense[i * 2 + 1];
        if (i > 0) s += Math.hypot(x - dense[i * 2 - 2], y - dense[i * 2 - 1]);
        let d = d0;
        if (total > 0) {
            let s0 = 0, o0 = d0, s1 = total, o1 = d1;
            for (let k = 0; k < via.length; k += 2) {
                const at = via[k] * total;
                if (at <= s) {
                    s0 = at;
                    o0 = via[k + 1];
                } else {
                    s1 = at;
                    o1 = via[k + 1];
                    break;
                }
            }
            d = s1 > s0 ? o0 + ((o1 - o0) * (s - s0)) / (s1 - s0) : o1;
        }
        let t0x = 0, t0y = 0, t1x = 0, t1y = 0;
        if (i > 0) {
            t0x = x - dense[i * 2 - 2];
            t0y = y - dense[i * 2 - 1];
            const l = Math.hypot(t0x, t0y) || 1;
            t0x /= l;
            t0y /= l;
        }
        if (i < m - 1) {
            t1x = dense[i * 2 + 2] - x;
            t1y = dense[i * 2 + 3] - y;
            const l = Math.hypot(t1x, t1y) || 1;
            t1x /= l;
            t1y /= l;
        }
        if (i === 0) [t0x, t0y] = [t1x, t1y];
        if (i === m - 1) [t1x, t1y] = [t0x, t0y];
        const n0x = t0y, n0y = -t0x, n1x = t1y, n1y = -t1x;
        let mx = n0x + n1x, my = n0y + n1y;
        const ml = Math.hypot(mx, my);
        if (ml < 1e-9) {
            mx = n0x;
            my = n0y;
        } else {
            // Miter limited to 2 so a sharp turn cannot spike.
            const cosHalf = Math.min(1, Math.max(0.5, ml / 2));
            mx = (mx / ml) / cosHalf;
            my = (my / ml) / cosHalf;
        }
        out[i * 2] = x + mx * d;
        out[i * 2 + 1] = y + my * d;
    }
    let widest = Math.max(Math.abs(d0), Math.abs(d1), 1);
    for (let k = 1; k < via.length; k += 2) widest = Math.max(widest, Math.abs(via[k]));
    return removeLoopsAnchored(out, dense, widest * LOOP_WINDOW_OFFSETS);
}

export function selfIntersects(p: Polyline): boolean {
    const n = p.length / 2;
    for (let i = 0; i + 1 < n; i++) {
        for (let j = i + 2; j + 1 < n; j++) {
            if (intersectSegments(p[i * 2], p[i * 2 + 1], p[i * 2 + 2], p[i * 2 + 3], p[j * 2], p[j * 2 + 1], p[j * 2 + 2], p[j * 2 + 3])) return true;
        }
    }
    return false;
}

export function intersectLines(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): Vec | null {
    const r = [bx - ax, by - ay];
    const s = [dx - cx, dy - cy];
    const denom = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(denom) < 1e-12) return null;
    const t = ((cx - ax) * s[1] - (cy - ay) * s[0]) / denom;
    return [ax + r[0] * t, ay + r[1] * t];
}

/** Proper crossing of two segments, with parameters along each; endpoints touching do not count. */
export function intersectSegments(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): {x: number; y: number; t: number; u: number} | null {
    const rX = bx - ax, rY = by - ay;
    const sX = dx - cx, sY = dy - cy;
    const denom = rX * sY - rY * sX;
    if (Math.abs(denom) < 1e-12) return null;
    const qpX = cx - ax, qpY = cy - ay;
    const t = (qpX * sY - qpY * sX) / denom;
    const u = (qpX * rY - qpY * rX) / denom;
    if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
    return {x: ax + rX * t, y: ay + rY * t, t, u};
}

/** Offset loops are local, so only segments within `window` of path length are tested. */
export function removeLoopsAnchored(p: Polyline, anchors: Polyline, window: number): {points: Polyline; anchors: Polyline} {
    let pts = p;
    let anc = anchors;
    let guard = 0;
    for (;;) {
        if (guard++ > 1000) break;
        const n = pts.length / 2;
        // Segment lengths once per pass: the window scan reads each many times.
        const len = new Float64Array(Math.max(0, n - 1));
        for (let k = 0; k < n - 1; k++) len[k] = Math.hypot(pts[k * 2 + 2] - pts[k * 2], pts[k * 2 + 3] - pts[k * 2 + 1]);
        let found: {i: number; j: number; x: number; y: number} | null = null;
        outer: for (let i = 0; i < n - 1 && !found; i++) {
            const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[i * 2 + 2], by = pts[i * 2 + 3];
            const minX = ax < bx ? ax : bx, maxX = ax < bx ? bx : ax;
            const minY = ay < by ? ay : by, maxY = ay < by ? by : ay;
            let acc = 0;
            for (let j = i + 2; j < n - 1; j++) {
                acc += len[j - 1];
                if (acc > window) break;
                const cx = pts[j * 2], cy = pts[j * 2 + 1], dx = pts[j * 2 + 2], dy = pts[j * 2 + 3];
                // Two segments whose boxes are apart cannot cross; this is nearly every pair.
                if ((cx < minX && dx < minX) || (cx > maxX && dx > maxX) || (cy < minY && dy < minY) || (cy > maxY && dy > maxY)) continue;
                const hit = intersectSegments(ax, ay, bx, by, cx, cy, dx, dy);
                if (hit) {
                    found = {i, j, x: hit.x, y: hit.y};
                    break outer;
                }
            }
        }
        if (!found) break;
        const cut = (found.i + 1) * 2;
        const keep = (found.j + 1) * 2;
        pts = pts.slice(0, cut).concat([found.x, found.y], pts.slice(keep));
        anc = anc.slice(0, cut).concat([anc[found.i * 2], anc[found.i * 2 + 1]], anc.slice(keep));
    }
    return {points: pts, anchors: anc};
}

export function sampleCubicBezier(p0: Vec, p1: Vec, p2: Vec, p3: Vec, n: number): Polyline {
    const out: Polyline = [];
    for (let i = 0; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
        out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
    }
    return out;
}

/**
 * Tangents tp and tq both point into the gap. Handle length follows LOOM's
 * renderer: a circular arc where the tangent rays meet, otherwise an S-curve.
 */
export function connectorCurve(P: Vec, tp: Vec, Q: Vec, tq: Vec, samples: number, handleScale = 1): Polyline {
    const K = 0.5523 * handleScale; // 4/3 (sqrt(2) - 1): a cubic Bezier's quarter circle
    const chord = Math.hypot(Q[0] - P[0], Q[1] - P[1]);
    let h = K * chord;
    const I = intersectLines(P[0], P[1], P[0] + tp[0], P[1] + tp[1], Q[0], Q[1], Q[0] + tq[0], Q[1] + tq[1]);
    if (I) {
        const t = (I[0] - P[0]) * tp[0] + (I[1] - P[1]) * tp[1];
        const u = (I[0] - Q[0]) * tq[0] + (I[1] - Q[1]) * tq[1];
        if (t > 0 && u > 0) {
            const delta = (Math.hypot(I[0] - P[0], I[1] - P[1]) + Math.hypot(I[0] - Q[0], I[1] - Q[1])) / 2;
            h = K * Math.min(delta, chord * 1.5);
        }
    }
    const c1: Vec = [P[0] + tp[0] * h, P[1] + tp[1] * h];
    const c2: Vec = [Q[0] + tq[0] * h, Q[1] + tq[1] * h];
    return sampleCubicBezier(P, c1, c2, Q, samples);
}

/** On-screen counter-clockwise sweep from a to b, in [0, 2PI); negated because the frame is y-down. */
export function ccwAngle(a: Vec, b: Vec): number {
    let d = -(Math.atan2(b[1], b[0]) - Math.atan2(a[1], a[0]));
    while (d < 0) d += 2 * Math.PI;
    while (d >= 2 * Math.PI) d -= 2 * Math.PI;
    return d;
}

/**
 * Centripetal Catmull-Rom through every vertex. A bend sharper than
 * `maxBendDeg` is a corner: the spline would swing wide of the road on both
 * approaches, so runs between corners are smoothed apart and each corner is
 * rounded by `cornerPx` instead.
 */
export function smoothCatmullRom(p: Polyline, segmentPx: number, maxPerSegment = 10, minBendDeg = 3, maxBendDeg = 180, cornerPx = 0): Polyline {
    const n = p.length / 2;
    if (n < 3) return p.slice();
    if (maxBendDeg < 180) {
        const cosMax = Math.cos((maxBendDeg * Math.PI) / 180);
        let corners: number[] | null = null;
        for (let i = 1; i < n - 1; i++) if (bendAt(p, i) < cosMax) (corners ??= []).push(i);
        if (corners) {
            const out: Polyline = [];
            let from = 0;
            for (const c of [...corners, n - 1]) {
                const run = smoothCatmullRom(p.slice(from * 2, (c + 1) * 2), segmentPx, maxPerSegment, minBendDeg);
                for (let k = out.length ? 2 : 0; k < run.length; k += 2) out.push(run[k], run[k + 1]);
                from = c;
            }
            return cornerPx > 0 ? roundCorners(out, p, corners, cornerPx) : out;
        }
    }
    const X = (i: number) => p[i * 2];
    const Y = (i: number) => p[i * 2 + 1];
    const bend = new Float64Array(n);
    const cosMin = Math.cos((minBendDeg * Math.PI) / 180);
    for (let i = 1; i < n - 1; i++) {
        const ax = X(i) - X(i - 1), ay = Y(i) - Y(i - 1);
        const bx = X(i + 1) - X(i), by = Y(i + 1) - Y(i);
        const la = Math.hypot(ax, ay) || 1, lb = Math.hypot(bx, by) || 1;
        bend[i] = (ax * bx + ay * by) / (la * lb);
    }
    const out: Polyline = [X(0), Y(0)];
    for (let i = 0; i < n - 1; i++) {
        const curved = (i > 0 && bend[i] < cosMin) || (i + 1 < n - 1 && bend[i + 1] < cosMin);
        const len = Math.hypot(X(i + 1) - X(i), Y(i + 1) - Y(i));
        const steps = curved ? Math.max(1, Math.min(maxPerSegment, Math.round(len / segmentPx))) : 1;
        if (steps === 1) {
            out.push(X(i + 1), Y(i + 1));
            continue;
        }
        // Phantom control points reflected through the endpoints keep the end tangents.
        const p0x = i > 0 ? X(i - 1) : 2 * X(0) - X(1);
        const p0y = i > 0 ? Y(i - 1) : 2 * Y(0) - Y(1);
        const p1x = X(i), p1y = Y(i);
        const p2x = X(i + 1), p2y = Y(i + 1);
        const p3x = i + 2 < n ? X(i + 2) : 2 * X(n - 1) - X(n - 2);
        const p3y = i + 2 < n ? Y(i + 2) : 2 * Y(n - 1) - Y(n - 2);
        const t0 = 0;
        const t1 = t0 + Math.sqrt(Math.hypot(p1x - p0x, p1y - p0y)) || 1e-6;
        const t2 = t1 + Math.sqrt(Math.hypot(p2x - p1x, p2y - p1y)) || t1 + 1e-6;
        const t3 = t2 + Math.sqrt(Math.hypot(p3x - p2x, p3y - p2y)) || t2 + 1e-6;
        for (let s = 1; s < steps; s++) {
            const t = t1 + ((t2 - t1) * s) / steps;
            const a1x = ((t1 - t) / (t1 - t0)) * p0x + ((t - t0) / (t1 - t0)) * p1x;
            const a1y = ((t1 - t) / (t1 - t0)) * p0y + ((t - t0) / (t1 - t0)) * p1y;
            const a2x = ((t2 - t) / (t2 - t1)) * p1x + ((t - t1) / (t2 - t1)) * p2x;
            const a2y = ((t2 - t) / (t2 - t1)) * p1y + ((t - t1) / (t2 - t1)) * p2y;
            const a3x = ((t3 - t) / (t3 - t2)) * p2x + ((t - t2) / (t3 - t2)) * p3x;
            const a3y = ((t3 - t) / (t3 - t2)) * p2y + ((t - t2) / (t3 - t2)) * p3y;
            const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
            const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
            const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
            const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
            out.push(((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x, ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y);
        }
        out.push(p2x, p2y);
    }
    return out;
}

/**
 * Where the smoothed line leaves its first vertex, without smoothing the
 * edge. Its subdivision rules must stay in step with `smoothCatmullRom`.
 */
export function splineStartDirection(p: Polyline, segmentPx: number, maxPerSegment = 10, minBendDeg = 3, maxBendDeg = 180): Vec {
    const n = p.length / 2;
    if (n < 3) return startDirection(p);
    if (maxBendDeg < 180 && bendAt(p, 1) < Math.cos((maxBendDeg * Math.PI) / 180)) return startDirection(p);
    const steps = splineSteps(p, 0, segmentPx, maxPerSegment, minBendDeg);
    if (steps < 2) return startDirection(p);
    const [x, y] = centripetalPoint(2 * p[0] - p[2], 2 * p[1] - p[3], p[0], p[1], p[2], p[3], p[4], p[5], 1 / steps);
    const dx = x - p[0], dy = y - p[1];
    const l = Math.hypot(dx, dy);
    return l > 0 ? [dx / l, dy / l] : startDirection(p);
}

/** Where the smoothed line arrives at its last vertex; see `splineStartDirection`. */
export function splineEndDirection(p: Polyline, segmentPx: number, maxPerSegment = 10, minBendDeg = 3, maxBendDeg = 180): Vec {
    const n = p.length / 2;
    if (n < 3) return endDirection(p);
    if (maxBendDeg < 180 && bendAt(p, n - 2) < Math.cos((maxBendDeg * Math.PI) / 180)) return endDirection(p);
    const steps = splineSteps(p, n - 2, segmentPx, maxPerSegment, minBendDeg);
    if (steps < 2) return endDirection(p);
    const o = (n - 1) * 2;
    const [x, y] = centripetalPoint(p[o - 4], p[o - 3], p[o - 2], p[o - 1], p[o], p[o + 1], 2 * p[o] - p[o - 2], 2 * p[o + 1] - p[o - 1], (steps - 1) / steps);
    const dx = p[o] - x, dy = p[o + 1] - y;
    const l = Math.hypot(dx, dy);
    return l > 0 ? [dx / l, dy / l] : endDirection(p);
}

function splineSteps(p: Polyline, i: number, segmentPx: number, maxPerSegment: number, minBendDeg: number): number {
    const n = p.length / 2;
    const cosMin = Math.cos((minBendDeg * Math.PI) / 180);
    const curved = (i > 0 && bendAt(p, i) < cosMin) || (i + 1 < n - 1 && bendAt(p, i + 1) < cosMin);
    if (!curved) return 1;
    const len = Math.hypot(p[i * 2 + 2] - p[i * 2], p[i * 2 + 3] - p[i * 2 + 1]);
    return Math.max(1, Math.min(maxPerSegment, Math.round(len / segmentPx)));
}

/**
 * Quadratic fillets with the corner as control point. Tangent points are
 * walked to, since the spline leaves vertices a few pixels apart. A corner
 * takes at most 0.4 of each adjacent run, so close corners keep their own arcs.
 */
function roundCorners(out: Polyline, src: Polyline, corners: number[], radiusPx: number): Polyline {
    const n = src.length / 2;
    const cum = new Float64Array(n);
    for (let i = 1; i < n; i++) {
        cum[i] = cum[i - 1] + Math.hypot(src[i * 2] - src[i * 2 - 2], src[i * 2 + 1] - src[i * 2 - 1]);
    }
    let done = out;
    for (let ci = 0; ci < corners.length; ci++) {
        const c = corners[ci];
        const prev = ci > 0 ? corners[ci - 1] : 0;
        const next = ci + 1 < corners.length ? corners[ci + 1] : n - 1;
        let r = Math.min(radiusPx, 0.4 * (cum[c] - cum[prev]), 0.4 * (cum[next] - cum[c]));
        if (r < 0.05) continue;
        const cx = src[c * 2], cy = src[c * 2 + 1];
        let at = -1;
        for (let i = 0; i < done.length; i += 2) {
            if (Math.abs(done[i] - cx) < 1e-6 && Math.abs(done[i + 1] - cy) < 1e-6) {
                at = i;
                break;
            }
        }
        if (at <= 0 || at >= done.length - 2) continue;
        const back = walkAlong(done, at, -2, r), fwd = walkAlong(done, at, 2, r);
        r = Math.min(r, back.got, fwd.got);
        if (r < 0.05) continue;
        const steps = Math.max(4, Math.min(12, Math.round(r / 2)));
        const arc: Polyline = [];
        for (let i = 0; i <= steps; i++) {
            const t = i / steps, m = 1 - t;
            arc.push(m * m * back.x + 2 * m * t * cx + t * t * fwd.x, m * m * back.y + 2 * m * t * cy + t * t * fwd.y);
        }
        done = [...done.slice(0, back.idx + 2), ...arc, ...done.slice(fwd.idx)];
    }
    return done;
}

/** `step` is 2 forward or -2 back; `got` falls short of `dist` only at the line's end. */
function walkAlong(p: Polyline, at: number, step: number, dist: number): {x: number; y: number; idx: number; got: number} {
    let acc = 0, i = at;
    for (;;) {
        const j = i + step;
        if (j < 0 || j + 1 >= p.length) return {x: p[i], y: p[i + 1], idx: i, got: acc};
        const seg = Math.hypot(p[j] - p[i], p[j + 1] - p[i + 1]);
        if (acc + seg >= dist) {
            const t = seg > 1e-12 ? (dist - acc) / seg : 0;
            return {x: p[i] + (p[j] - p[i]) * t, y: p[i + 1] + (p[j + 1] - p[i + 1]) * t, idx: j, got: dist};
        }
        acc += seg;
        i = j;
    }
}

/** Cosine of the turn: 1 straight, -1 folded back. */
function bendAt(p: Polyline, k: number): number {
    const ax = p[k * 2] - p[k * 2 - 2], ay = p[k * 2 + 1] - p[k * 2 - 1];
    const bx = p[k * 2 + 2] - p[k * 2], by = p[k * 2 + 3] - p[k * 2 + 1];
    return (ax * bx + ay * by) / ((Math.hypot(ax, ay) || 1) * (Math.hypot(bx, by) || 1));
}

/** Must match the arithmetic in `smoothCatmullRom`. */
function centripetalPoint(p0x: number, p0y: number, p1x: number, p1y: number, p2x: number, p2y: number, p3x: number, p3y: number, u: number): Vec {
    const t0 = 0;
    const t1 = t0 + Math.sqrt(Math.hypot(p1x - p0x, p1y - p0y)) || 1e-6;
    const t2 = t1 + Math.sqrt(Math.hypot(p2x - p1x, p2y - p1y)) || t1 + 1e-6;
    const t3 = t2 + Math.sqrt(Math.hypot(p3x - p2x, p3y - p2y)) || t2 + 1e-6;
    const t = t1 + (t2 - t1) * u;
    const a1x = ((t1 - t) / (t1 - t0)) * p0x + ((t - t0) / (t1 - t0)) * p1x;
    const a1y = ((t1 - t) / (t1 - t0)) * p0y + ((t - t0) / (t1 - t0)) * p1y;
    const a2x = ((t2 - t) / (t2 - t1)) * p1x + ((t - t1) / (t2 - t1)) * p2x;
    const a2y = ((t2 - t) / (t2 - t1)) * p1y + ((t - t1) / (t2 - t1)) * p2y;
    const a3x = ((t3 - t) / (t3 - t2)) * p2x + ((t - t2) / (t3 - t2)) * p3x;
    const a3y = ((t3 - t) / (t3 - t2)) * p2y + ((t - t2) / (t3 - t2)) * p3y;
    const b1x = ((t2 - t) / (t2 - t0)) * a1x + ((t - t0) / (t2 - t0)) * a2x;
    const b1y = ((t2 - t) / (t2 - t0)) * a1y + ((t - t0) / (t2 - t0)) * a2y;
    const b2x = ((t3 - t) / (t3 - t1)) * a2x + ((t - t1) / (t3 - t1)) * a3x;
    const b2y = ((t3 - t) / (t3 - t1)) * a2y + ((t - t1) / (t3 - t1)) * a3y;
    return [((t2 - t) / (t2 - t1)) * b1x + ((t - t1) / (t2 - t1)) * b2x, ((t2 - t) / (t2 - t1)) * b1y + ((t - t1) / (t2 - t1)) * b2y];
}

export interface Bounds {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
}

export function polylineBounds(p: Polyline): Bounds {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < p.length; i += 2) {
        if (p[i] < minX) minX = p[i];
        if (p[i] > maxX) maxX = p[i];
        if (p[i + 1] < minY) minY = p[i + 1];
        if (p[i + 1] > maxY) maxY = p[i + 1];
    }
    return {minX, minY, maxX, maxY};
}

export function boundsIntersect(a: Bounds, b: Bounds): boolean {
    return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}
