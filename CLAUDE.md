# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A MapLibre GL JS plugin that draws routes sharing paths as ordered parallel lanes: the transit-map look, with crossing minimization, smooth junctions, and constant pixel spacing at every zoom. It is a `CustomLayerInterface` layer on top of a renderer-agnostic layout core. It was developed and tested in conjunction with the trailmaps.app map generator (`../trailmaps.app-map-generator`, a private sibling checkout), which is its first consumer, but this is a general public plugin, not a trailmaps.app-only one. Its docs show the plugin on its own terms; they do not compare it with what trailmaps.app did before it. `docs/algorithms.md` explains the algorithms and the research they build on; `docs/api.md` is the API reference; `docs/performance.md` holds measurements. The session log, open items, the v1.0 checklist and the original design study live in the untracked `.claude/plans/` (`worklog.md`, `feasibility.md`), not in `docs/`: they carry dated notes and consumer-specific planning that the public repository should not.

## Commands

Run from the repo root. Use `corepack pnpm`, not npm.

```bash
corepack pnpm install

# All three must pass before committing
corepack pnpm test        # vitest, offline, runs in seconds
corepack pnpm typecheck   # tsc --noEmit over src, demo, scripts, test
corepack pnpm lint        # oxlint, correctness rules only, no style rules

# Single test file
corepack pnpm exec vitest run test/order.test.ts

# Demo (http://127.0.0.1:5177/). Serves the fixtures from test/fixtures/ and
# the committed RAMBA basemap; ?basemap=0 hides it.
corepack pnpm dev

# Examples (http://127.0.0.1:5178/examples/). Needs `pnpm build` first:
# the pages load /dist, /node_modules and /test/fixtures from the repo root.
corepack pnpm examples

# Library build: dist/ (ESM + IIFE + types), then copies demo assets
corepack pnpm build
```

## Architecture

- **`src/core/`** is the layout pipeline and has no MapLibre or WebGL dependency: `graph.ts` (line graph from GeoJSON, shared-path detection), `order.ts` (LOOM-style lane ordering with simulated annealing; `order-async.ts` runs it in the inlined worker from `src/worker/`, spawned by `worker-client.ts`; `worker-dev.ts` holds the development spawn and the library build replaces it, because a shipped `new Worker(new URL(...))` breaks every consumer's bundler), `baselines.ts` (per-edge lateral shift that keeps lanes from jumping at transitions), `layout.ts` (per-zoom pixel geometry, culling, spline smoothing at junctions), `folds.ts` (opens a bundled edge's line where it folds back on itself more tightly than the bundle is wide, before any lane is offset from it), `geometry.ts` (polyline math), `serialize.ts` (worker transfer form).
- **`src/render/`** is the MapLibre side: `layer.ts` (`LaneLayer`, the custom layer: anchored zoom-invariant mesh, per-route draw passes, dashes, dots, casing, a translucent casing blended once through a mark in the depth buffer, `queryLane` hit-testing, globe projection through MapLibre's shader prelude) and `tessellate.ts` (mesh building, one quad per dot of a dotted look, CSS color parsing).
- **`demo/`** is a Vite app for development and visual review, with fixture switching, a native line-offset baseline toggle, and `demo/public/plain.html` for no-bundler use. The dev server serves `test/fixtures/<name>.src.geojson` as `/<name>.geojson`.
- **`test/`** is vitest, offline, against the fixtures in `test/fixtures/`. RAMBA (`ramba.src.geojson`) is the dense stress case.
- **`examples/`** is six pages, one per thing the plugin does, served by `scripts/serve-examples.mjs` from the repo root. `examples/bundler/` is its own npm project (`file:../..`) and type checks against the published declarations.
- **`scripts/`** holds the esbuild library build, the demo asset copy, the examples server, and the benchmarks `docs/performance.md` cites. `exact-order.py` (with `export-ordering.ts`) proves the best possible lane order of a network and compares the solver with it; it needs Python with `ortools` and is a development tool, never a test.
- **`.github/workflows/publish.yml`** publishes to npm when a GitHub release is published, through npm trusted publishing (no token). It stops if the tag is not `v` plus the `package.json` version, and skips a version already on npm. The manual steps are in `.claude/plans/release-1.0-plan.md`.
- **`.github/workflows/pages.yml`** builds the demo with `--base /maplibre-gl-lanes/` and deploys it to GitHub Pages on the same release event (or by hand); the README hero links there. Demo URLs must therefore stay base-relative: `import.meta.env.BASE_URL` in `demo/main.ts`, relative paths in `demo/public/plain.html`. `demo/vite.config.ts` emits the fixtures and MapLibre's worker files into the build, which the dev server serves on its own.

## Hard constraints

- LOOM (ad-freiburg/loom) is GPL-3. Never copy or port its code; reimplement from the papers cited in `CITATION.cff` and `docs/algorithms.md`. This package is MIT.
- Tests stay offline and fast; no network fixtures.
- American English in docs, comments, and messages. Literal external identifiers keep their canonical spelling (the OSM `colour=` tag, the CSS `grey` color name).
- No em dashes or en dashes anywhere: code, comments, docs, commit messages. Use a colon, comma, period, or a hyphen for ranges.
- Relative imports in `src/` carry a `.js` extension. `tsc` copies them into the published declarations, and `moduleResolution: node16` and `nodenext` reject them without one.
- Comments carry design rationale (why), not narration (what).
- No formatter. Format by hand: 4-space indent, single quotes in TypeScript, about 100 columns as a soft limit that long URLs and string literals may exceed. Do not reflow lines you are not otherwise changing.
- Lint is deliberately minimal (`.oxlintrc.json`). Do not add stylistic rules. oxlint, not typescript-eslint, because typescript-eslint does not support the TypeScript 7 compiler this repo uses.
- Commit only when asked, directly on `main`, no feature branches unless asked. Commit messages follow `type: summary` (`fix:`, `feat:`, `docs:`, `refactor:`), with a body that explains why and a final paragraph stating how the change was verified.
- `docs/performance.md` states figures, not a history. Re-measure it when the layout or the solver changes, rather than adding a dated entry beside the old one. `scripts/` holds the benchmarks it cites.
- `CHANGELOG.md` starts at 1.0.0. The pre-1.0 record is `.claude/plans/pre-1.0-changes.md`, which is for the first consumer, who vendored builds before the release.
- The layer never writes the stencil buffer. MapLibre keeps tile clipping masks there and reuses them from layer to layer, and a custom layer cannot invalidate them. `test/casing.test.ts` asserts it.
- 3D terrain is a documented limitation, not a planned feature. Do not build terrain support unless asked.
