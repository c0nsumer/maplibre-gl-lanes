#!/usr/bin/env python3
"""Attribute a Chrome performance trace to the plugin's source functions.

Record a trace in Chrome DevTools (Performance panel, or chrome://tracing
on a phone through remote debugging) of a page that runs the published
dist/maplibre-gl-lanes.js, then run:

    python3 scripts/profile-trace.py trace.json[.gz] dist/maplibre-gl-lanes.js.map

The map must be the one built alongside the exact file the page ran. The
report lists the plugin's inclusive and self time per source function on
the main thread, what each worker was busy with and how long its tasks
took (one task per rebuild in the layout worker), every main-thread task
with plugin work in it split into layout, mesh and draw, and the
distribution of task lengths during touch input. Standard library only;
no install.
"""

import bisect
import collections
import gzip
import json
import statistics
import sys

B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'


def vlq(s):
    vals, shift, val = [], 0, 0
    for ch in s:
        c = B64.index(ch)
        val |= (c & 31) << shift
        if c & 32:
            shift += 5
        else:
            vals.append(-(val >> 1) if val & 1 else val >> 1)
            val, shift = 0, 0
    return vals


def load_map(path):
    sm = json.load(open(path))
    by_line = {}
    si = sl = sc = ni = 0
    for line_no, line in enumerate(sm['mappings'].split(';')):
        gc, segs = 0, []
        for seg in line.split(','):
            if not seg:
                continue
            v = vlq(seg)
            gc += v[0]
            if len(v) > 1:
                si += v[1]
                sl += v[2]
                sc += v[3]
            if len(v) > 4:
                ni += v[4]
            segs.append((gc, si, sl, ni if len(v) > 4 else -1))
        segs.sort()
        by_line[line_no] = ([x[0] for x in segs], segs)
    return sm, by_line


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    trace_path, map_path = sys.argv[1], sys.argv[2]
    opener = gzip.open if trace_path.endswith('.gz') else open
    d = json.load(opener(trace_path, 'rt'))
    ev = d['traceEvents'] if isinstance(d, dict) else d
    sm, by_line = load_map(map_path)

    def resolve(cf):
        if 'maplibre-gl-lanes' not in cf.get('url', ''):
            return None
        cols, segs = by_line.get(cf.get('lineNumber', 0), ([], []))
        i = bisect.bisect_right(cols, cf.get('columnNumber', 0)) - 1
        if i < 0:
            return ('?', cf.get('functionName') or '?', 0)
        _, si, sl, ni = segs[i]
        name = sm['names'][ni] if ni >= 0 else (cf.get('functionName') or '?')
        return (sm['sources'][si].split('/')[-1], name, sl + 1)

    tnames = {(e['pid'], e['tid']): e['args']['name'] for e in ev if e.get('ph') == 'M' and e.get('name') == 'thread_name'}
    main_thread = next(k for k, v in tnames.items() if v == 'CrRendererMain')
    t0 = min(e['ts'] for e in ev if 'ts' in e)

    profiles = collections.defaultdict(lambda: {'nodes': {}, 'samples': [], 'deltas': [], 'start': None, 'thread': None})
    for e in ev:
        if e.get('name') == 'Profile' and e.get('ph') == 'P':
            profiles[e['id']]['start'] = e['args']['data']['startTime']
            profiles[e['id']]['thread'] = (e['pid'], e['tid'])
        if e.get('name') == 'ProfileChunk':
            p = profiles[e['id']]
            cp = e['args']['data'].get('cpuProfile', {})
            for n in cp.get('nodes', []):
                p['nodes'][n['id']] = n
            p['samples'] += cp.get('samples', [])
            p['deltas'] += e['args']['data'].get('timeDeltas', [])
            if p['thread'] is None:
                p['thread'] = (e['pid'], e['tid'])

    for p in profiles.values():
        parent = {}
        for n in p['nodes'].values():
            if 'parent' in n:
                parent[n['id']] = n['parent']
            for c in n.get('children', []):
                parent[c] = n['id']
        p['parent'] = parent
        t = p['start'] or 0
        p['times'] = []
        for dlt in p['deltas']:
            t += dlt
            p['times'].append(t)

    def stack(p, n):
        out = []
        while n in p['nodes']:
            out.append(n)
            n = p['parent'].get(n)
        return out

    # Worker profiles. The worker source is minified, so a worker is
    # recognized by the method names that survive: the solver's in the
    # ordering worker, the caches' and the mesh builder's in the layout one.
    ORDERING = ('evalNode', 'anneal', 'swapAlong')
    LAYOUT = ('stateFor', 'builderFor', 'emit', 'vertex', 'tri', 'quad')
    for p in profiles.values():
        tid = p['thread']
        if tnames.get(tid) != 'DedicatedWorker thread':
            continue
        selfc = collections.Counter()
        for s, dlt in zip(p['samples'], p['deltas']):
            cf = p['nodes'][s]['callFrame']
            selfc[cf.get('functionName') or '(anon)'] += dlt
        busy = sum(v for k, v in selfc.items() if k != '(idle)') / 1000
        if busy < 1:
            continue
        # A page has other workers too (the map's own tile worker, say);
        # they are reported as 'other' rather than hidden.
        kind = 'ordering' if any(k in selfc for k in ORDERING) else 'layout' if any(k in selfc for k in LAYOUT) else 'other'
        durs = sorted(e['dur'] / 1000 for e in ev
                      if e.get('ph') == 'X' and (e['pid'], e['tid']) == tid and e.get('name') == 'RunTask' and e['dur'] > 1000)
        line = f"{kind} worker: {busy:.0f} ms busy"
        if durs:
            line += (f", {len(durs)} tasks over 1 ms (median {statistics.median(durs):.1f} ms, "
                     f"p90 {durs[int(len(durs) * 0.9)]:.1f}, max {durs[-1]:.1f})")
        print(line + '; top: ' + ', '.join(f"{k} {v / 1000:.0f}" for k, v in selfc.most_common(6) if k != '(idle)'))

    p = next(p for p in profiles.values() if p['thread'] == main_thread)
    incl, selfc = collections.Counter(), collections.Counter()
    for s, dlt in zip(p['samples'], p['deltas']):
        seen = set()
        for n in stack(p, s):
            r = resolve(p['nodes'][n]['callFrame'])
            if r and r not in seen:
                seen.add(r)
                incl[r] += dlt
        top = resolve(p['nodes'][s]['callFrame'])
        if top:
            selfc[top] += dlt
    fmt = lambda r: f"{r[1]} ({r[0]}:{r[2]})"
    print('\nplugin on the main thread, inclusive ms:')
    for r, v in incl.most_common(16):
        print(f"  {v / 1000:7.0f}  {fmt(r)}")
    print('plugin on the main thread, self ms:')
    for r, v in selfc.most_common(12):
        print(f"  {v / 1000:7.0f}  {fmt(r)}")

    tasks = [e for e in ev if e.get('ph') == 'X' and (e['pid'], e['tid']) == main_thread and e.get('name') == 'RunTask' and e['dur'] > 4000]
    times = p['times']
    rows = []
    for e in tasks:
        a, b = e['ts'], e['ts'] + e['dur']
        i, j = bisect.bisect_left(times, a), bisect.bisect_right(times, b)
        plug = layout = mesh = draw = 0
        for k in range(i, j):
            names = {r[1] for r in (resolve(p['nodes'][n]['callFrame']) for n in stack(p, p['samples'][k])) if r}
            dlt = p['deltas'][k]
            if names:
                plug += dlt
            if 'layoutAtZoom' in names:
                layout += dlt
            elif 'tessellate' in names:
                mesh += dlt
            elif 'render' in names:
                draw += dlt
        if plug > 2000:
            rows.append((e['dur'] / 1000, plug / 1000, layout / 1000, mesh / 1000, draw / 1000, (a - t0) / 1e6))
    rows.sort(reverse=True)
    print(f"\nmain-thread tasks with plugin work: {len(rows)}; longest (task ms, plugin ms, layout, mesh, draw, at s):")
    for r in rows[:12]:
        print('  ' + ' '.join(f"{x:6.1f}" for x in r))
    rebuilds = [r for r in rows if r[2] > 3]
    if rebuilds:
        print(f"rebuild tasks: {len(rebuilds)}, task ms median {statistics.median(r[0] for r in rebuilds):.0f}, plugin ms median {statistics.median(r[1] for r in rebuilds):.0f}, over 32 ms {sum(1 for r in rebuilds if r[0] > 32)}, over 50 ms {sum(1 for r in rebuilds if r[0] > 50)}")

    touch = [e['ts'] for e in ev if e.get('name') == 'InputLatency::TouchMove' and 'ts' in e]
    if touch:
        ta, tb = min(touch), max(touch)
        hist = collections.Counter()
        for e in ev:
            if e.get('ph') == 'X' and (e['pid'], e['tid']) == main_thread and e.get('name') == 'RunTask' and ta <= e['ts'] <= tb:
                ms = e['dur'] / 1000
                hist['>50' if ms > 50 else '>32' if ms > 32 else '>16' if ms > 16 else '<=16'] += 1
        print(f"\nmain-thread tasks during touch input ({(tb - ta) / 1e6:.0f} s): {dict(hist)}")


if __name__ == '__main__':
    main()
