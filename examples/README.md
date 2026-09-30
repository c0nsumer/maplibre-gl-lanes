# Examples

Six small pages, each showing one thing the plugin does. Every example is
self-contained: copy one into your own project and change the data URL.

## Running them

Build the library first. The pages load it from `/dist`.

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm examples     # http://127.0.0.1:5178/examples/
```

`corepack pnpm examples` serves the repository root over http. The pages
need an http origin because they fetch their data; opening the files
directly does not work.

The pages load three things by path, which is what to change when you copy
one into your own project:

- `/dist/maplibre-gl-lanes.mjs` (or `.js` for the classic script). In your
  own project this is `maplibre-gl-lanes`, or a CDN address.
- `/node_modules/maplibre-gl/dist/maplibre-gl.mjs` and its CSS.
- `/test/fixtures/example.src.geojson`, the sample data. It is a trail
  network from OpenStreetMap: 10 routes in 80 LineString features, with
  route colors, route names and a one-way tag. `path-colors/` loads
  `/test/fixtures/mfo.src.geojson` instead, the fixture whose paths carry
  a difficulty grade.

## The examples

| Directory | Shows |
|---|---|
| `bundler/` | The smallest app that draws lanes, with a bundler and TypeScript. |
| `script/` | The same, as a classic `<script>` tag with no bundler. |
| `labels/` | Route names and direction arrows along the lanes, from `laneFeatures`. |
| `highlight/` | `queryLane` on a click, `setHighlight` to lift the route, a popup on the lane. |
| `path-colors/` | `laneStyle` coloring lanes by a property of the path, not by route. |
| `snapshot-cache/` | `snapshotLaneOrders` stored in localStorage and reapplied. |

### bundler

This one has its own install, because it is a real bundler project:

```bash
cd examples/bundler
corepack pnpm install
corepack pnpm dev        # http://127.0.0.1:5173/
```

It depends on `"maplibre-gl-lanes": "file:../.."`, so it uses the copy in
this repository. Your own project depends on the published package instead.
`corepack pnpm check` type checks it, which is also a check that the
published type declarations work from outside the package.

## Reading order

`bundler/src/main.ts` is the whole API in three calls: build a graph, order
it, add the layer. Read it first. `labels/` and `highlight/` then show the
two things that need care, and both are about timing:

- Lane geometry moves when the zoom changes and when a build finishes, so
  anything derived from `laneFeatures` has to be refreshed on `moveend` and
  on `setOnBuild`. `labels/` has the rule and why each half is needed.
- A tap while the map is moving never reaches a click handler. MapLibre
  spends it on stopping the motion. On a phone the first tap after a pan
  stops the map and the second one selects.
