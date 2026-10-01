# Changelog

All notable changes to maplibre-gl-lanes are recorded here. The format
follows Keep a Changelog, and the project uses semantic versioning.

## 1.2.0 - 2026-09-30

### Added

- `HighlightStyle.bright` keeps the lanes on some graph edges at full
  opacity while a highlight dims the rest, such as a path picked off the
  highlighted route to read it. Those lanes get no halo and no outline,
  and keep their place in the drawing order. A translucent casing stays
  blended once where a bright lane meets a dimmed piece of its own route.

### Fixed

- A lane below full opacity, through `setOpacity` or a highlight's `dim`,
  no longer shows bright spots at its joints. Its pieces overlap there, and
  each overlap was blended twice. The fill is now blended once per pixel,
  as a translucent casing already was. On a two-color dashed lane, the dash
  color no longer shows through the dashes.
- A highlight's `dim` now applies wherever the map is. Before, it stopped
  when no highlighted route was in the area last built, such as after
  panning away from the route.

## 1.1.0 - 2026-09-30

### Changed

- Lane ordering runs a second pass that removes routes swapping sides
  while running together. The first pass could not remove them, and on a
  dense network it left a dozen. Lane orders change on existing maps
  where that happened. A stored snapshot keeps its old order until the map
  is solved again. The second pass adds between a few percent and an
  eighth to a solve, and the speedups below more than make up for it.
- A connector follows the mapped path where a corner or curve would leave
  it by more than one lane, which happened at low zoom where a path bends
  inside the cut-back of a bundle.
- The drawing order no longer weaves a route through a group of lanes it
  crosses. Maps without such a crossing keep their order.
- Faster: a cold layout of a zoom takes about a quarter less, its mesh a
  fifth less, a lane ordering a fifth less and the graph build a seventh
  less than without the speedups, measured in Node on the RAMBA network of
  trailmaps.app. With the second ordering pass included, a lane ordering
  of the RAMBA fixture still takes about a sixth less than in 1.0.0. The
  speedups change no output: every lane, connector and mesh is the same to
  the last bit as without them. `scripts/layout-dump.ts` is the check.
  On an iPhone 16 the graph build of that network takes a third less than
  in 1.0.0 and on a Pixel 8 a quarter less; a lane ordering there, second
  pass included, takes about as long as in 1.0.0.

### Added

- `scripts/exact-order.py` proves the best possible lane order of a
  network with an exact solver, for checking the solver. It is a
  development tool that needs Python and OR-Tools; the library does not
  depend on it.
- Measurement scripts, described in `docs/performance.md`:
  `scripts/bench-startup.ts` times the graph build and the lane ordering
  in Node, `scripts/order-probe.js` times the lane ordering on a device,
  and `scripts/pixel-trace.mjs` records a performance trace from an
  Android phone. `scripts/device-probe.js` now tags every frame over
  32 ms with the motion it fell in.

### Fixed

- The demo's native line-offset baseline draws dashed and dotted routes
  as dashed and dotted lines, so the comparison with the lanes is only
  about the lanes. Its stats fit the panel.

## 1.0.0 - 2026-09-27

The first release. Nothing was published before it, so there is no
upgrade to describe.

### Added

- `buildLineGraph` builds a line graph from GeoJSON routes and finds the
  paths they share. `filterGraph` hides routes without rebuilding it.
- `orderLanes` and `orderLanesAsync` order the lanes of every bundle to
  keep crossings low. The async form runs in a worker. `stabilizeLanes`
  shifts bundles sideways so lanes do not jump where a route joins or
  leaves. A lane that runs alone eases back onto its path after the
  junction, and ends on the path where its route ends.
- `snapshotLaneOrders`, `applyLaneOrders` and `seedFromSnapshot` cache a
  lane order between sessions.
- `LaneLayer` is a MapLibre custom layer that draws the lanes at a
  constant pixel spacing at every zoom. It supports the mercator and globe
  projections.
- Lane looks: solid, dashed and dotted lanes, a dash underlay color, a
  casing, and a `laneStyle` hook that styles a lane by the properties of
  the path under it. A translucent casing blends once where casings
  overlap.
- `setHighlight` highlights one or more routes with a halo, an outline
  and a dim for the rest.
- `queryLane` hit-tests a screen point. `laneFeatures` and
  `laneFeaturesAsync` return the drawn lanes as GeoJSON, for labels and
  arrows in ordinary MapLibre layers.
- Short edges merge into their junctions at low zoom, and routes cross a
  merged junction on one continuous lane.
- A hairpin narrower than its bundle is opened to fit it. `openFolds:
  false` turns that off.
- Layout rebuilds run in a worker, and pieces that depend only on the
  zoom are kept between rebuilds.
- `layoutAtZoom` and `LayoutCache` expose the layout core without
  MapLibre.
- ESM and script-tag builds with type declarations, six examples, and
  documentation of the API, the algorithms and the measured performance.
