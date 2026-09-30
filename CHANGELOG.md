# Changelog

All notable changes to maplibre-gl-lanes are recorded here. The format
follows Keep a Changelog, and the project uses semantic versioning.

## Unreleased

### Changed

- Lane ordering runs a second pass that removes routes swapping sides
  while running together. The first pass could not remove them, and on a
  dense network it left a dozen. Lane orders change on existing maps
  where that happened. A stored snapshot keeps its old order until the map
  is solved again. The solve takes a few percent longer.
- A connector follows the mapped path where a corner or curve would leave
  it by more than one lane, which happened at low zoom where a path bends
  inside the cut-back of a bundle.
- The drawing order no longer weaves a route through a group of lanes it
  crosses. Maps without such a crossing keep their order.

### Added

- `scripts/exact-order.py` proves the best possible lane order of a
  network with an exact solver, for checking the solver. It is a
  development tool that needs Python and OR-Tools; the library does not
  depend on it.

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
