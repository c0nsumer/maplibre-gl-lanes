/**
 * A connector is emitted as one piece per edge it lies along, cut at each node it crosses. Tests
 * about a connector's shape read it whole: the pieces of one connector come one after another,
 * share their `between` array, and each starts where the last ended.
 */

import type {LanePath} from '../src/core/layout';

export function wholeConnectors(paths: readonly LanePath[]): LanePath[] {
    const out: LanePath[] = [];
    for (const p of paths) {
        const last = out[out.length - 1];
        if (p.kind === 'connector' && last?.kind === 'connector' && last.between === p.between && last.route === p.route
            && last.coords[last.coords.length - 2] === p.coords[0] && last.coords[last.coords.length - 1] === p.coords[1]) {
            // A cut inside a segment added its point; without it the line is the one that was cut.
            const c = last.coords, n = c.length;
            const inside = n >= 4 && p.coords.length >= 4
                && Math.abs((c[n - 2] - c[n - 4]) * (p.coords[3] - c[n - 3]) - (c[n - 1] - c[n - 3]) * (p.coords[2] - c[n - 4])) < 1e-9 * Math.hypot(p.coords[2] - c[n - 4], p.coords[3] - c[n - 3]) ** 2;
            const drop = inside ? 2 : 0;
            out[out.length - 1] = {
                ...last,
                coords: c.slice(0, n - drop).concat(p.coords.slice(2)),
                anchors: last.anchors.slice(0, n - drop).concat(p.anchors.slice(2)),
            };
            continue;
        }
        out.push(p);
    }
    return out;
}
