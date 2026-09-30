#!/usr/bin/env python3
"""Find the best possible lane order of a network, and say how close the
library's solver gets to it.

The library orders lanes with a local search, which is fast and cannot
prove anything. This script hands the same problem to an exact solver
(OR-Tools CP-SAT), which can: it returns the lowest cost any lane order
reaches, and says whether it proved that. Use it after a change to
`src/core/order.ts`, and to get the costs a test pins.

    python3 scripts/exact-order.py [options] [file ...]

    --route-property NAME   feature property holding the route id
                            (default route_id)
    --uniform A,B           the uniformProperties the map is built with;
                            they split edges, so they change the problem
    --time-limit SECONDS    per group of edges that share nodes
                            (default 120)

A bare file name is a fixture in test/fixtures/; anything with a slash is
a path. With no files, the three fixtures. Run it from the repo root.

It needs Node.js, because it runs scripts/export-ordering.ts to build the
graph and the cost terms with the library's own code, and the `ortools`
package, which is not a dependency of the library:

    python3 -m venv .venv
    .venv/bin/pip install ortools
    .venv/bin/python scripts/exact-order.py

This is a development tool. Nothing here runs when a map is drawn, and
`corepack pnpm test` does not need it.

The cost model below restates `evalNode` in src/core/order.ts. Before it
solves anything, the script scores the library's own order with this
model and stops if the result differs from the cost the library
reported, so the two cannot drift apart unnoticed.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

try:
    from ortools.sat.python import cp_model
except ImportError:
    sys.exit('exact-order: the ortools package is missing. See the top of this file for the install.')

SAME_NEXT, DIFF_NEXT, PERIPHERY = 0, 1, 2
# Weights are halves at the finest (periphery is 0.5), and CP-SAT wants integers.
SCALE = 2
WORKERS = os.cpu_count() or 4


def weights(problem):
    w = {k: v * SCALE for k, v in problem['weights'].items()}
    for k, v in w.items():
        if abs(v - round(v)) > 1e-9:
            sys.exit(f'exact-order: weight {k} is not a multiple of {1 / SCALE}')
    return {k: round(v) for k, v in w.items()}


def score(problem, orders):
    """Cost of a lane order, and how many of each kind of event it has."""
    w = weights(problem)
    pos = {e: {r: i for i, r in enumerate(o)} for e, o in orders.items()}
    total = 0
    counts = {'same': 0, 'diff': 0, 'separation': 0, 'periphery': 0}
    for _node, kind, e, out, a, b, f, f_out, a_left in problem['terms']:
        k = len(orders[e])
        pa = pos[e][a]
        if not out:
            pa = k - 1 - pa
        if kind == PERIPHERY:
            if pa != 0 and pa != k - 1:
                total += w['periphery']
                counts['periphery'] += 1
            continue
        pb = pos[e][b]
        if not out:
            pb = k - 1 - pb
        left = pa < pb
        if kind == DIFF_NEXT:
            if (a_left == 1) != left:
                total += w['diffSegmentCrossing']
                counts['diff'] += 1
            continue
        fa, fb = pos[f][a], pos[f][b]
        if not f_out:
            kf = len(orders[f])
            fa, fb = kf - 1 - fa, kf - 1 - fb
        if (fa < fb) == left:
            total += w['sameSegmentCrossing']
            counts['same'] += 1
        elif abs(pa - pb) == 1 and abs(fa - fb) != 1:
            total += w['separation']
            counts['separation'] += 1
    return total / SCALE, counts


def solve(problem, group, hint, limit):
    """The best order of one group of edges. Groups share no node, so each is its own problem."""
    w = weights(problem)
    routes = {e['id']: e['routes'] for e in problem['edges']}
    inside = set(group)
    m = cp_model.CpModel()
    pos, left, adjacent = {}, {}, {}
    for e in group:
        on = routes[e]
        for r in on:
            pos[e, r] = m.NewIntVar(0, len(on) - 1, f'pos_{e}_{r}')
        m.AddAllDifferent([pos[e, r] for r in on])
        for i, a in enumerate(on):
            for b in on[i + 1:]:
                v = m.NewBoolVar(f'left_{e}_{a}_{b}')
                m.Add(pos[e, a] < pos[e, b]).OnlyEnforceIf(v)
                m.Add(pos[e, a] > pos[e, b]).OnlyEnforceIf(v.Not())
                left[e, a, b] = v
                left[e, b, a] = v.Not()

    def next_to(e, a, b):
        key = (e, min(a, b), max(a, b))
        if key not in adjacent:
            v = m.NewBoolVar(f'adjacent_{key}')
            d = m.NewIntVar(-64, 64, '')
            m.Add(d == pos[e, a] - pos[e, b])
            apart = m.NewIntVar(0, 64, '')
            m.AddAbsEquality(apart, d)
            m.Add(apart == 1).OnlyEnforceIf(v)
            m.Add(apart >= 2).OnlyEnforceIf(v.Not())
            adjacent[key] = v
        return adjacent[key]

    cost = []
    for _node, kind, e, out, a, b, f, f_out, a_left in problem['terms']:
        if e not in inside:
            continue
        k = len(routes[e])
        if kind == PERIPHERY:
            if k <= 2:
                continue
            first, last, inner = m.NewBoolVar(''), m.NewBoolVar(''), m.NewBoolVar('')
            m.Add(pos[e, a] == 0).OnlyEnforceIf(first)
            m.Add(pos[e, a] != 0).OnlyEnforceIf(first.Not())
            m.Add(pos[e, a] == k - 1).OnlyEnforceIf(last)
            m.Add(pos[e, a] != k - 1).OnlyEnforceIf(last.Not())
            m.AddBoolOr([first, last, inner])
            m.AddImplication(first, inner.Not())
            m.AddImplication(last, inner.Not())
            cost.append(w['periphery'] * inner)
            continue
        here = left[e, a, b] if out else left[e, b, a]
        if kind == DIFF_NEXT:
            cost.append(w['diffSegmentCrossing'] * (here.Not() if a_left == 1 else here))
            continue
        there = left[f, a, b] if f_out else left[f, b, a]
        # Seen outward from both ends, a pair that keeps its sides has flipped, so equal is a crossing.
        crossing = m.NewBoolVar('')
        m.AddBoolOr([here, there, crossing])
        m.AddBoolOr([here.Not(), there.Not(), crossing])
        m.AddBoolOr([here, there.Not(), crossing.Not()])
        m.AddBoolOr([here.Not(), there, crossing.Not()])
        cost.append(w['sameSegmentCrossing'] * crossing)
        near, far = next_to(e, a, b), next_to(f, a, b)
        separated = m.NewBoolVar('')
        m.AddBoolAnd([crossing.Not(), near, far.Not()]).OnlyEnforceIf(separated)
        m.AddBoolOr([crossing, near.Not(), far, separated])
        cost.append(w['separation'] * separated)
    m.Minimize(sum(cost))
    # The library's order is a good place to start, and costs nothing to offer.
    for e in group:
        for i, r in enumerate(hint[e]):
            m.AddHint(pos[e, r], i)
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = limit
    solver.parameters.num_workers = WORKERS
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {e: list(hint[e]) for e in group}, False, solver.WallTime()
    orders = {e: sorted(routes[e], key=lambda r: solver.Value(pos[e, r])) for e in group}
    return orders, status == cp_model.OPTIMAL, solver.WallTime()


def main():
    p = argparse.ArgumentParser(description='Best possible lane order of a network, against the library solver.')
    p.add_argument('files', nargs='*')
    p.add_argument('--route-property', default='route_id')
    p.add_argument('--uniform', default='')
    p.add_argument('--time-limit', type=float, default=120)
    args = p.parse_args()
    if not os.path.exists('scripts/run-ts.mjs'):
        sys.exit('exact-order: run it from the repo root')

    with tempfile.TemporaryDirectory(prefix='lanes-exact-') as tmp:
        cmd = ['node', 'scripts/run-ts.mjs', 'scripts/export-ordering.ts', tmp, '--route-property', args.route_property]
        if args.uniform:
            cmd += ['--uniform', args.uniform]
        subprocess.run(cmd + args.files, check=True)
        problems = [json.load(open(os.path.join(tmp, f))) for f in sorted(os.listdir(tmp))]

    print(f"{'network':<24}{'shared edges':>13}{'solver':>9}{'best':>8}{'over':>7}  {'same-segment crossings':<24}{'proved':<8}{'time':>7}")
    for problem in problems:
        name = problem['name']
        ours = {e['id']: e['order'] for e in problem['edges']}
        if not ours:
            print(f'{name:<24}{0:>13}{0:>9}{0:>8}{"":>7}  {"no shared edges":<24}')
            continue
        ours_cost, ours_counts = score(problem, ours)
        if abs(ours_cost - problem['solverCost']) > 1e-9:
            sys.exit(f"exact-order: {name}: this script scores the library's order at {ours_cost}, the library at "
                     f"{problem['solverCost']}. The cost model here no longer matches evalNode in src/core/order.ts.")
        best, proved, seconds = {}, True, 0.0
        for group in problem['groups']:
            orders, ok, wall = solve(problem, group, ours, args.time_limit)
            best.update(orders)
            proved = proved and ok
            seconds += wall
        best_cost, best_counts = score(problem, best)
        over = f'{(ours_cost - best_cost) / best_cost:.0%}' if best_cost else ('0%' if not ours_cost else 'n/a')
        crossings = f"{ours_counts['same']} against {best_counts['same']}"
        print(f"{name:<24}{len(ours):>13}{ours_cost:>9g}{best_cost:>8g}{over:>7}  {crossings:<24}{'yes' if proved else 'no':<8}{seconds:>6.1f}s")
    print('\nWhere "proved" says no, "best" is the best order found within the time limit.')


if __name__ == '__main__':
    main()
