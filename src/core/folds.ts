/**
 * Open the fold backs of a centerline so a bundle fits through them. The
 * defect is in the line, not the offsetting, so the line itself moves, by
 * the least that makes room. Not from the cited papers; see
 * docs/algorithms.md.
 */

import {simplify, type Polyline} from './geometry.js';

const STEP_PER_CLEARANCE = 1 / 5;
/** Within 60 degrees of opposite; a wider angle is a corner or a near miss, which draw well as they are. */
const MAX_LEG_COS = -0.5;
const TANGENT_SAMPLES = 2;
const SMOOTH_PER_CLEARANCE = 0.15;
const SIMPLIFY_TOLERANCE_PX = 0.1;
const MIN_PUSH_PX = 0.01;

/** Sample pairs across a fold, from the tip outward. */
interface Fold {
    ai: number[];
    bi: number[];
    /** -1 where the legs part again before they meet. */
    tip: number;
}

/** A hashed grid, so memory follows the sample count, not the area a long line spans at high zoom. */
function scanPairs(x: Float64Array, y: Float64Array, reach: number, minSep: number, found: (i: number, j: number, d2: number) => void): void {
    const n = x.length;
    let size = 16;
    while (size < 2 * n) size *= 2;
    const hash = (cx: number, cy: number) => (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & (size - 1);
    const bucket = new Int32Array(n);
    const start = new Int32Array(size + 1);
    for (let i = 0; i < n; i++) {
        bucket[i] = hash(Math.floor(x[i] / reach), Math.floor(y[i] / reach));
        start[bucket[i] + 1]++;
    }
    for (let b = 0; b < size; b++) start[b + 1] += start[b];
    const items = new Int32Array(n);
    const fill = start.slice(0, size);
    for (let i = 0; i < n; i++) items[fill[bucket[i]]++] = i;
    const r2 = reach * reach;
    const seen = new Int32Array(9);
    for (let i = 0; i < n - minSep; i++) {
        const cx = Math.floor(x[i] / reach), cy = Math.floor(y[i] / reach);
        let cells = 0;
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
            for (let gx = cx - 1; gx <= cx + 1; gx++) {
                const b = hash(gx, gy);
                let again = false;
                for (let q = 0; q < cells; q++) if (seen[q] === b) again = true;
                if (again) continue;
                seen[cells++] = b;
                // Items are in sample order, so the first j too close to i ends the walk.
                for (let q = start[b + 1] - 1; q >= start[b]; q--) {
                    const j = items[q];
                    if (j - i < minSep) break;
                    const dx = x[j] - x[i], dy = y[j] - y[i];
                    const d2 = dx * dx + dy * dy;
                    if (d2 < r2) found(i, j, d2);
                }
            }
        }
    }
}

/** Under a pixel, the push is invisible, and sampling at that pitch takes seconds on a long line. */
const MIN_CLEARANCE_PX = 1;

/**
 * Returns `p` itself where nothing moves. Nothing moves within `guardA` px
 * of the start or `guardB` px of the end, since junctions are measured from them.
 */
export function openFolds(p: Polyline, clearance: number, guardA: number, guardB: number): Polyline {
    const n0 = p.length / 2;
    if (n0 < 3 || !(clearance >= MIN_CLEARANCE_PX)) return p;
    // A bend the bundle fits round never puts two points this far apart along the line within the clearance.
    const arcMin = (Math.PI / 2) * clearance;
    let total = 0;
    for (let i = 2; i < p.length; i += 2) total += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
    if (total - guardA - guardB <= arcMin) return p;
    // Most lines never swing through 120 degrees, and this spares them the sampling.
    {
        let heading = 0, lo = 0, hi = 0, last = Math.atan2(p[3] - p[1], p[2] - p[0]);
        for (let i = 4; i < p.length; i += 2) {
            const a = Math.atan2(p[i + 1] - p[i - 1], p[i] - p[i - 2]);
            let turn = a - last;
            if (turn > Math.PI) turn -= 2 * Math.PI;
            else if (turn < -Math.PI) turn += 2 * Math.PI;
            heading += turn;
            if (heading < lo) lo = heading;
            if (heading > hi) hi = heading;
            last = a;
        }
        if (hi - lo < Math.acos(MAX_LEG_COS)) return p;
    }

    const count = Math.max(2, Math.ceil(total / (clearance * STEP_PER_CLEARANCE)));
    const step = total / count;
    const n = count + 1;
    const x = new Float64Array(n), y = new Float64Array(n);
    {
        let seg = 1, segStart = 0, segLen = Math.hypot(p[2] - p[0], p[3] - p[1]);
        for (let i = 0; i < n; i++) {
            const s = i === count ? total : i * step;
            while (seg < n0 - 1 && s > segStart + segLen) {
                segStart += segLen;
                seg++;
                segLen = Math.hypot(p[seg * 2] - p[seg * 2 - 2], p[seg * 2 + 1] - p[seg * 2 - 1]);
            }
            const t = segLen > 0 ? Math.min(1, (s - segStart) / segLen) : 0;
            x[i] = p[seg * 2 - 2] + (p[seg * 2] - p[seg * 2 - 2]) * t;
            y[i] = p[seg * 2 - 1] + (p[seg * 2 + 1] - p[seg * 2 - 1]) * t;
        }
    }

    const side = new Uint8Array(n);
    const seeds: number[] = [];
    scanPairs(x, y, clearance, Math.floor(arcMin / step) + 1, (i, j, d2) => {
        const i0 = Math.max(0, i - TANGENT_SAMPLES), i1 = Math.min(n - 1, i + TANGENT_SAMPLES);
        const j0 = Math.max(0, j - TANGENT_SAMPLES), j1 = Math.min(n - 1, j + TANGENT_SAMPLES);
        const tix = x[i1] - x[i0], tiy = y[i1] - y[i0], tjx = x[j1] - x[j0], tjy = y[j1] - y[j0];
        if (tix * tjx + tiy * tjy > MAX_LEG_COS * Math.hypot(tix, tiy) * Math.hypot(tjx, tjy)) return;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        seeds.push(i, j, d2);
        side[i] |= tix * dy - tiy * dx > 0 ? 1 : 2;
        side[j] |= tjy * dx - tjx * dy > 0 ? 1 : 2;
    });
    if (!seeds.length) return p;

    // Walk inward to the tip, then pair outward, so the pairing does not
    // depend on the seed; advancing the closer leg keeps unequal legs square.
    const order: number[] = [];
    for (let s = 0; s < seeds.length; s += 3) order.push(s);
    order.sort((a, b) => seeds[a + 2] - seeds[b + 2]);
    const c2 = clearance * clearance;
    const dist2 = (i: number, j: number) => (x[i] - x[j]) * (x[i] - x[j]) + (y[i] - y[j]) * (y[i] - y[j]);
    // 1: held by a fold. 2: a walk from it led nowhere.
    const taken = new Uint8Array(n);
    const folds: Fold[] = [];
    for (const s of order) {
        let i = seeds[s], j = seeds[s + 1];
        if (taken[i] === 1 || taken[j] === 1 || (taken[i] && taken[j])) continue;
        const seedI = i, seedJ = j;
        let tip = -1;
        for (;;) {
            if (j - i <= 2) {
                tip = (i + j) >> 1;
                break;
            }
            const both = dist2(i + 1, j - 1), a = dist2(i + 1, j), b = dist2(i, j - 1);
            const best = Math.min(both, a, b);
            if (best >= c2) break;
            if (both === best) {
                i++;
                j--;
            } else if (a === best) i++;
            else j--;
        }
        if (tip >= 0) {
            i = tip - 1;
            j = tip + 1;
        }
        const fold: Fold = {ai: [], bi: [], tip};
        let blocked = i < 0 || j > n - 1;
        while (!blocked) {
            if (taken[i] === 1 || taken[j] === 1) {
                blocked = true;
                break;
            }
            fold.ai.push(i);
            fold.bi.push(j);
            const both = i > 0 && j < n - 1 ? dist2(i - 1, j + 1) : Infinity;
            const a = i > 0 ? dist2(i - 1, j) : Infinity;
            const b = j < n - 1 ? dist2(i, j + 1) : Infinity;
            const best = Math.min(both, a, b);
            if (best >= c2) break;
            if (both === best) {
                i--;
                j++;
            } else if (a === best) i--;
            else j++;
        }
        // Running into a leg another fold holds means a stack of three legs.
        if (blocked || !fold.ai.length) {
            if (!taken[seedI]) taken[seedI] = 2;
            if (!taken[seedJ]) taken[seedJ] = 2;
            continue;
        }
        const lo = fold.ai[fold.ai.length - 1], hi = fold.bi[fold.bi.length - 1];
        if (tip >= 0) taken.fill(1, lo, hi + 1);
        else {
            taken.fill(1, lo, fold.ai[0] + 1);
            taken.fill(1, fold.bi[0], hi + 1);
        }
        folds.push(fold);
    }

    // One displacement per sample, smoothed later, or pushes on wandering legs jump about.
    const R = clearance / 2;
    const ramp = (i: number) => {
        const s = i * step;
        const t = Math.min((s - guardA) / clearance, (total - s - guardB) / clearance);
        return t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t);
    };
    const dx = new Float64Array(n), dy = new Float64Array(n);
    const capped = new Uint8Array(n);
    let moved = false;
    for (const f of folds) {
        // A leg between two others would be pushed both ways, so a stack is left alone.
        let stack = false;
        for (let k = 0; k < f.ai.length && !stack; k++) stack = side[f.ai[k]] === 3 || side[f.bi[k]] === 3;
        if (stack) continue;
        let from = 0;
        if (f.tip >= 0) {
            // Centered one radius from the tip, so the cap passes through it.
            const tx = x[f.tip], ty = y[f.tip];
            let k = 0, mx = tx, my = ty, reached = 0;
            for (; k < f.ai.length; k++) {
                const qx = (x[f.ai[k]] + x[f.bi[k]]) / 2, qy = (y[f.ai[k]] + y[f.bi[k]]) / 2;
                const far = Math.hypot(qx - tx, qy - ty);
                if (far >= R) {
                    const t = (R - reached) / (far - reached);
                    mx += (qx - mx) * t;
                    my += (qy - my) * t;
                    break;
                }
                mx = qx;
                my = qy;
                reached = far;
            }
            // A fold too short to hold a cap, or too near an end to move freely, is left alone.
            if (k >= f.ai.length || ramp(f.ai[k]) < 1 || ramp(f.bi[k]) < 1) continue;
            const a = f.ai[k], b = f.bi[k];
            const h = Math.hypot(x[a] - x[b], y[a] - y[b]) / 2;
            if (h < 1e-6) continue;
            const ux = (x[a] - x[b]) / (2 * h), uy = (y[a] - y[b]) / (2 * h);
            const sweep = (ux * (ty - my) - uy * (tx - mx) > 0 ? 1 : -1) * Math.PI;
            const a0 = Math.atan2(uy, ux);
            for (let q = a; q <= b; q++) {
                const ang = a0 + (sweep * (q - a)) / (b - a);
                dx[q] = mx + Math.cos(ang) * R - x[q];
                dy[q] = my + Math.sin(ang) * R - y[q];
                capped[q] = 1;
            }
            moved = true;
            from = k + 1;
        }
        for (let k = from; k < f.ai.length; k++) {
            const a = f.ai[k], b = f.bi[k];
            const d = Math.hypot(x[a] - x[b], y[a] - y[b]);
            if (d >= clearance || d < 1e-6) continue;
            const push = (clearance - d) / 2;
            const ux = (x[a] - x[b]) / d, uy = (y[a] - y[b]) / d;
            if (!capped[a] && Math.hypot(dx[a], dy[a]) < push) {
                dx[a] = ux * push;
                dy[a] = uy * push;
            }
            if (!capped[b] && Math.hypot(dx[b], dy[b]) < push) {
                dx[b] = -ux * push;
                dy[b] = -uy * push;
            }
            moved = true;
        }
    }
    if (!moved) return p;
    // Averaging flattens the peak, which would leave the legs short of the
    // clearance, so each sample keeps the larger magnitude. Caps are kept as made.
    const half = Math.max(1, Math.round((SMOOTH_PER_CLEARANCE * clearance) / step));
    const sx = Float64Array.from(dx), sy = Float64Array.from(dy);
    for (const d of [sx, sy]) {
        for (let pass = 0; pass < 2; pass++) {
            const src = Float64Array.from(d);
            let sum = 0;
            for (let i = -half; i <= half; i++) sum += src[Math.min(n - 1, Math.max(0, i))];
            for (let i = 0; i < n; i++) {
                d[i] = sum / (2 * half + 1);
                sum += src[Math.min(n - 1, i + half + 1)] - src[Math.max(0, i - half)];
            }
        }
    }
    for (let i = 0; i < n; i++) {
        if (capped[i]) continue;
        const given = Math.hypot(dx[i], dy[i]), averaged = Math.hypot(sx[i], sy[i]);
        const scale = averaged > 1e-9 ? Math.max(given, averaged) / averaged : 0;
        dx[i] = sx[i] * scale;
        dy[i] = sy[i] * scale;
    }
    const live = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        const w = ramp(i);
        // The running sums leave rounding residue along the whole line.
        if (Math.abs(dx[i] * w) < MIN_PUSH_PX && Math.abs(dy[i] * w) < MIN_PUSH_PX) {
            dx[i] = dy[i] = 0;
            continue;
        }
        dx[i] *= w;
        dy[i] *= w;
        live.fill(1, Math.max(0, i - 1), Math.min(n, i + 2));
    }

    // The original vertices where nothing moved, so the line is untouched there.
    const out: Polyline = [];
    let vertex = 0, cum = 0;
    const flush = (upTo: number) => {
        for (; vertex < n0; vertex++) {
            if (vertex > 0) {
                const l = Math.hypot(p[vertex * 2] - p[vertex * 2 - 2], p[vertex * 2 + 1] - p[vertex * 2 - 1]);
                if (cum + l > upTo) return;
                cum += l;
            }
            const at = Math.min(n - 1, Math.floor(cum / step));
            if (!live[at] && !live[Math.min(n - 1, at + 1)]) out.push(p[vertex * 2], p[vertex * 2 + 1]);
        }
    };
    for (let i = 0; i < n; i++) {
        if (!live[i]) continue;
        flush(i * step);
        const run: Polyline = [];
        for (; i < n && live[i]; i++) run.push(x[i] + dx[i], y[i] + dy[i]);
        for (const v of simplify(run, SIMPLIFY_TOLERANCE_PX)) out.push(v);
    }
    flush(Infinity);
    return out;
}
