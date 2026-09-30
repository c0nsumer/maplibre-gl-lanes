# maplibre-gl-lanes

This plugin draws routes that share paths as ordered parallel lanes in
MapLibre GL JS. The goal is a transit-map look for any route network:
where several routes traverse a single trail, each one is visible in its
own lane. It was initially developed for [trailmaps.app](https://trailmaps.app),
to be used by its map generator, [c0nsumer/trailmaps.app-map-generator](https://github.com/c0nsumer/trailmaps.app-map-generator).

Routes that travel together are drawn side by side, each in its own lane.
Their order is consistent across the network, and it keeps crossings to a
minimum. Lane spacing is constant in screen pixels at every zoom. Where a
route joins or leaves a bundle it does so with a smooth curve on the
correct side. It works for trail systems, bus and rail lines, cycling
routes, or anything else that shares geometry.

[![Five routes sharing a path as ordered parallel lanes on the RAMBA trail network in Ishpeming, Michigan. At the junction the bundle fans out, each route curving to its own trail; two routes carry on together through a set of switchbacks, holding their spacing around every corner.](docs/images/junction.png)](https://c0nsumer.github.io/maplibre-gl-lanes/)

- `docs/api.md` is the API reference: every export, with its defaults.
- `docs/algorithms.md` explains how it works and the research it builds on.
- `docs/performance.md` holds the measurements.

## Examples

The demo draws the RAMBA trail network in Ishpeming and Negaunee, Michigan,
over a basemap that ships with the repository. It runs live at
[c0nsumer.github.io/maplibre-gl-lanes](https://c0nsumer.github.io/maplibre-gl-lanes/).
To run it locally:

```bash
corepack pnpm install
corepack pnpm dev        # http://127.0.0.1:5177/
```

RAMBA is a good test: 14 routes share 126 stretches of trail, up to six at
once. Its route data is a snapshot exported from OpenStreetMap in September
2026, and it does not follow later changes to the trails. Open the demo
with `?basemap=0` to run without the basemap.

`examples/` has six smaller pages, one per thing the plugin does: the
minimal app with a bundler and without one, labels and direction arrows,
click-to-highlight with a popup, coloring by a property of the path
rather than the route, and caching the lane order. Each is self-contained,
so you can copy one into your own project. They load the built library, so
build first:

```bash
corepack pnpm build
corepack pnpm examples   # http://127.0.0.1:5178/examples/
```

`examples/README.md` describes each page and the order to read them in.

## Install

```bash
npm install maplibre-gl-lanes
```

The package works with MapLibre GL JS 5 and later.

Without a bundler, load the classic script. It defines the global
`maplibreLanes` and does not care how MapLibre itself is loaded:

```html
<script src="https://unpkg.com/maplibre-gl-lanes@1/dist/maplibre-gl-lanes.js"></script>
```

That URL floats to the newest 1.x, so pin the version you tested against.
The ES module build, `dist/maplibre-gl-lanes.mjs`, also works without a
bundler when loaded next to MapLibre's own. `examples/script/` and
`demo/public/plain.html` are working pages for each. The workers are
inlined into both builds, so there is nothing else to ship.

## Use

Three calls: build a graph, order its lanes, add the layer.

```ts
import {buildLineGraph, orderLanesAsync, LaneLayer} from 'maplibre-gl-lanes';

const graph = buildLineGraph(geojson.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
await orderLanesAsync(graph);   // lane ordering and stable lanes, in a worker
const layer = new LaneLayer({
    id: 'routes',
    graph,
    sizes: (zoom) => ({spacing: 8, width: 7, casingWidth: 1}),   // pixels, per zoom
    casingColor: '#2a2a2a',   // any CSS color; alpha shows the map through the casing
});
map.addLayer(layer);
```

The layer lays out the lanes for the area around the viewport and rebuilds
when the map leaves it. Builds run in a worker, and the map keeps drawing
the lanes it has until the new ones arrive, so a pan never stalls a frame.
It draws under the mercator and globe projections.

### Input data

Each feature is one LineString belonging to one route, with the route id
in a property. Routes that share a path must share its vertex coordinates
exactly. Data derived from OpenStreetMap ways already does, because routes
are relations over shared ways. GPX tracks and GTFS shapes do not: two
recordings of one trail are two lines a few meters apart.

The graph tells you which you have. Every edge lists the routes on it, so
count the edges that more than one route travels:

```ts
const shared = graph.edges.filter((e) => e.routes.length > 1).length;
```

Zero is correct for routes that never travel together. Zero for routes you
know run down the same trails means they are not sharing vertices, and the
layer will draw them on top of each other. Getting such data onto a common
network is conflation, and this plugin does not do it. Prepare the data
first with a tool built for it, such as map matching against a trail
network, or JOSM and PostGIS for a one-time cleanup.

### Styling

A route's look is its metadata: `color`, `name`, `dash`, `dashColor`,
`dashCap` and `casing`. `buildLineGraph` reads them from feature
properties, or from its `routes` option. `dash` and `dashCap` follow
MapLibre's [`line-dasharray`](https://maplibre.org/maplibre-style-spec/layers/#line-dasharray)
and [`line-cap`](https://maplibre.org/maplibre-style-spec/layers/#line-cap):
`dash: [dash, gap]` is measured in lane widths, and `dashCap` gives a
dash the ends that `line-cap` gives a dashed line. It shapes dashes only:
the ends of a solid lane are always round. A dash length of 0 draws dots,
so `[0, 2]` is a dotted route. `dashColor` fills the gaps, which makes a
two-color pattern.

To draw by the path instead of by the route, for example by a difficulty grade,
give the layer a `laneStyle` callback. It runs for every edge and route,
and returns any of `color`, `dash`, `dashColor` and `dashCap`. Fields it
leaves out keep the route's own. It must be a pure function of the edge
and the route, because the layer resolves it once per graph, not per build.

```ts
const layer = new LaneLayer({..., laneStyle: (edge) => {
    const grade = edge.properties?.difficulty;
    // Test the property rather than compare it: '' >= 0 is true in JavaScript.
    return typeof grade === 'string' && /^[0-5]$/.test(grade)
        ? {color: gradeColors[grade]}
        : {color: '#9a9a9a', dash: [2, 2]};
}});
```

Properties of the path itself, rather than of the route, reach the lanes
through `uniformProperties`. Name the feature properties that must stay
the same along an edge, such as a one-way tag or a trail name. The edge
ends where one of them changes, and lane features and hit results carry
the values under their own names:

```ts
const graph = buildLineGraph(features, {routeProperty: 'route_id', uniformProperties: ['oneway', 'trail_name']});
```

### Lanes as data

`laneFeatures()` returns the drawn lanes as GeoJSON, for labels and
direction arrows in ordinary symbol layers. `queryLane` hit-tests a screen
point, and `setHighlight` lifts a route above the others.

```ts
import type {GeoJSONSource} from 'maplibre-gl';

// Lanes move when the zoom changes and when a build finishes, so refresh
// on `moveend` and on a build that lands after the map has stopped.
map.addSource('lanes', {type: 'geojson', data: layer.laneFeatures()});
const refresh = () => map.getSource<GeoJSONSource>('lanes')!.setData(layer.laneFeatures());
layer.setOnBuild(() => map.isMoving() || refresh());
map.on('moveend', refresh);

map.on('click', (e) => {
    const hit = layer.queryLane(e.point, 8);   // {route, name, kind, lngLat, edge, routes, properties, distancePx}
    layer.setHighlight(hit ? hit.route : null, {dim: 0.6});
});
```

Each feature is one piece of a lane. Its properties name the route, its
name and color, the direction of travel, and the routes sharing that edge
in lane order, so a symbol layer can filter on any of them.
`examples/labels/` and `examples/highlight/` are working pages for both
uses. `docs/api.md` covers the rest: every option and setter, build
timing, `laneFeaturesAsync` for a whole route regardless of the viewport,
`getLayout` and `getBuildInfo`, the snapshot calls that cache a lane
order, and the renderer-agnostic layout core.

## Limitations

The layer needs WebGL2. Where MapLibre 5 falls back to WebGL1 on a very
old browser, the layer draws nothing and says so on the console once.

3D terrain is not supported. MapLibre drapes its own line layers over
terrain, but it draws a custom layer straight to the screen at sea level,
so the lanes sink under raised ground. The layer warns on the console when
it is added to a map that has terrain on.

MapLibre Native, the mobile SDK, cannot load a JavaScript custom layer.

A hairpin narrower than the bundle running through it is opened to make
room: the two legs are pushed apart and the apex rounded, by at most half
the bundle's width, and only while the zoom keeps the hairpin that tight.
`openFolds: false` turns this off. Three cases are left as they are: a
stack of switchbacks, a hairpin whose apex is a junction, and a hairpin
within a few lane widths of a junction. At low zoom their lanes overlap
and read as one mass, and they draw correctly once the zoom opens the gaps
past the bundle width.

Routes that share a path must share its vertex coordinates. Conflating
data that does not is out of scope, as described under Input data.

## Credits

The layout follows the LOOM work of Hannah Bast, Patrick Brosi and Sabine
Storandt at the University of Freiburg: the node-crossing cost model for
ordering lines, and the node-front and Bezier construction for junctions
(ACM TSAS 2019; Brosi's PhD thesis, 2022). The crossing-minimization
background is due to Benkert, Nöllenburg, Uno and Wolff (2006), Bekos,
Kaufmann, Potika and Symvonis (2007), and Fink and Pupyrev (2013). The
renderer is modeled on MapLibre GL JS's own line layer. Full citations,
and what this project adds to them, are in `docs/algorithms.md` and
`CITATION.cff`.

The LOOM software itself (https://github.com/ad-freiburg/loom) and
Transport for Cairo's QGIS front end for it
(https://github.com/transportforcairo/loom_qgis) were studied as
references for how the published design is applied in practice. Both are
GPL-3.0. Everything here was reimplemented from the published papers and
thesis; no source from LOOM, loom_qgis, or any other copyleft project was
used.

## License

MIT. Test fixtures are OpenStreetMap data under the ODbL; see
`test/fixtures/README.md`.
The demo's basemap, `demo/public/ramba-basemap.pmtiles`, is also
OpenStreetMap data under the ODbL.
