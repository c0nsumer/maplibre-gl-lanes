# Changelog

All notable changes to maplibre-gl-lanes are recorded here. The format
follows Keep a Changelog, and the project uses semantic versioning.

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
