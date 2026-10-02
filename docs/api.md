# API reference

Everything the package exports, with its defaults. The source of truth is
the type declarations in `dist/types/`, which carry the same documentation
as comments; this page is the readable form of them.

The package exports 14 runtime values and the types their signatures name.
Nothing else is public. `test/exports.test.ts` pins the list, so an export
cannot be added or removed by accident.

The exports fall into two halves.

- The **layout core** builds a line graph from GeoJSON, orders the lanes
  and turns the result into geometry. It has no MapLibre and no WebGL
  dependency, so it runs in Node as well as in a browser.
- The **layer** draws that geometry on a MapLibre map, as a
  `CustomLayerInterface`.

A map author needs three calls: `buildLineGraph`, `orderLanesAsync` and
`new LaneLayer(...)`. The rest of this page is what to reach for after
that.

## Building the graph

### `buildLineGraph(features, options?): LineGraph`

Builds the line graph from GeoJSON features.

Each feature is one LineString belonging to one route. The route's id comes
from a feature property. The function merges every run of path where the
same set of routes travels together into one edge. Nodes are the points
where that set changes, or where paths meet.

Routes that share a path must share its vertex coordinates. Data derived
from OpenStreetMap ways already does, because routes are relations over
shared ways. GPX tracks and GTFS shapes do not.

#### `LineGraphOptions`

| Field | Default | What it does |
|---|---|---|
| `routeProperty` | `'route'` | Feature property holding the route id. |
| `colorProperty` | `'color'` | Feature property holding the route color. `routes` overrides it. |
| `nameProperty` | `'name'` | Feature property holding the route name. |
| `routes` | none | Route metadata by id (`Record<string, Partial<RouteMeta>>`). It overrides the per-feature properties. |
| `snapDegrees` | `1e-7` | Coordinate rounding used to match shared vertices, in degrees. |
| `uniformProperties` | none | Feature properties that must stay the same along an edge, by name. |

`uniformProperties` is how facts about the path itself, rather than the
route, reach the lanes. Name a property
and the edge ends wherever its value changes, exactly as it ends where the
set of routes changes. The values are kept on `GraphEdge.properties`, and
they appear on lane features and on hit results under their own names.
Where routes sharing a path disagree, the first feature wins.

### `filterGraph(graph, visible): LineGraph`

Returns a new graph with only the routes `visible(routeId)` accepts. Edges
left with no routes are dropped. Use it to show a subset without rebuilding
from the features.

### `LineGraph`

| Field | Type | What it holds |
|---|---|---|
| `nodes` | `GraphNode[]` | The junctions. |
| `edges` | `GraphEdge[]` | The runs of shared path. |
| `routes` | `Map<string, RouteMeta>` | Route metadata by id. |
| `chains` | `Map<string, RouteChain[]>` | Each route's edges in travel order. |

The graph is mutated in place by design: `orderLanes` writes each edge's
`order`, and `stabilizeLanes` writes its `baseline`.

### `GraphEdge`

| Field | Type | What it holds |
|---|---|---|
| `id` | `number` | Its index in `edges`. |
| `a`, `b` | `number` | The nodes at its ends. |
| `coords` | `Polyline` | Its centerline in Mercator units, flat `[x, y, ...]`. |
| `routes` | `string[]` | The routes traveling on it, each at most once. |
| `direction` | `Map<string, number>` | Per route: `1` for a to b, `-1` for b to a, `0` where the route's features cross the edge in both directions. |
| `order` | `string[]` | The lane order, left to right traveling a to b. `orderLanes` fills it. |
| `baseline` | `number?` | Sideways shift of the whole bundle, in lanes, positive to the left of a to b. `stabilizeLanes` fills it. A lane that runs alone holds this shift only next to a junction its route continues through, and follows the path elsewhere. |
| `properties` | `Record<string, unknown>?` | The `uniformProperties` values along this edge. |

### `GraphNode`

| Field | Type | What it holds |
|---|---|---|
| `id` | `number` | Its index in `nodes`. |
| `x`, `y` | `number` | Web Mercator position in `[0, 1]` world units. |
| `ports` | `Port[]` | One per incident edge end, in no particular order. |
| `transitions` | `NodeTransition[]` | Every route's pass through the node, as port index pairs. |

A `Port` is `{edge: number, end: 'a' | 'b'}`. A `NodeTransition` is
`{route: string, from: number, to: number}`, where `from` and `to` index
into `ports`.

### `RouteMeta`

The per-route look and label. `buildLineGraph` reads it from the feature
properties, or from the `routes` option.

| Field | Type | What it does |
|---|---|---|
| `id` | `string` | The route id. |
| `color` | `string` | The lane fill color, as any CSS color. |
| `name` | `string?` | The route name. It lands on lane features and hit results. |
| `casing` | `boolean?` | Default `true`. `false` draws the route without its casing. |

`RouteMeta` also carries every field of `LaneAppearance`.

### `LaneAppearance`

How a lane is drawn, apart from its width. A `LaneStyle` callback returns
the same fields, so this is the one vocabulary for a route's look and for a
per-edge override.

| Field | Type | What it does |
|---|---|---|
| `color` | `string?` | CSS color of the lane fill. |
| `dash` | `[number, number]?` | Dash pattern as `[dash, gap]`, in lane widths. |
| `dashColor` | `string?` | Fills the gaps, which makes a two-color pattern. Without it the casing shows through. |
| `dashCap` | `'butt' \| 'round' \| 'square'?` | Default `'butt'`. The ends of each dash. |

`dash` and `dashCap` follow MapLibre's
[`line-dasharray`](https://maplibre.org/maplibre-style-spec/layers/#line-dasharray)
and [`line-cap`](https://maplibre.org/maplibre-style-spec/layers/#line-cap).
Lengths are in lane widths, and `'round'` caps reach half a lane width into
each gap, as they do on a dashed line layer. Unlike `line-cap`, `dashCap`
shapes dashes only: the ends of a solid lane are always round.

A dash length of `0` draws round dots, so `[0, 2]` is a dot every two lane
widths. Each dot is a disc of the lane's width, drawn from geometry of its
own, so it stays round where the path bends and at every zoom.

The pattern runs unbroken along each of a route's chains (see
`RouteChain`), through the junctions on the way. Where a route forks or
meets itself, it splits into separate chains, and the pattern restarts at
the start of each one.

### `RouteChain` and `RouteStep`

`graph.chains` decomposes each route into chains of `{edge, forward}`
steps, in travel order. `closed` marks a chain that returns to its start.
`mergeStart` and `mergeEnd` name the edge an open chain's end merges into,
which is how a lollipop route's loop rejoins its stem.

## Lane ordering

Ordering decides, for every edge, the left-to-right order of the routes on
it. The goal is that routes cross each other as rarely as possible inside
nodes, and that routes traveling together stay adjacent. `docs/algorithms.md`
explains the model and the solver.

### `orderLanesAsync(graph, options?): Promise<number>`

Orders the graph in a worker and applies the result in place. It resolves
with the final cost. If the browser has no worker, it orders on the calling
thread instead.

This is the call to use. It also stabilizes the lanes, which the
synchronous `orderLanes` does not.

#### `OrderAsyncOptions`

| Field | Default | What it does |
|---|---|---|
| `order` | none | `OrderOptions` for the solver. |
| `seed` | none | A `LaneOrderSnapshot` to start from, so showing or hiding a route keeps the others in their lanes. |
| `stabilize` | on | `StabilizeOptions`, or `false` to skip stabilizing. |
| `sync` | `false` | Forces the synchronous path. Meant for tests. |

### `orderLanes(graph, options?): number`

Orders the graph on the calling thread and returns the cost. It does not
stabilize; call `stabilizeLanes` after it if you want stable lanes.

#### `OrderOptions`

| Field | Default | What it costs |
|---|---|---|
| `sameSegmentCrossing` | `4` | Two routes on one edge swapping sides while continuing onto the same next edge. |
| `diffSegmentCrossing` | `1` | Two routes on one edge diverging onto different edges in the wrong order. |
| `separation` | `3` | Adjacent routes that continue together but are no longer adjacent. |
| `periphery` | `0.5` | A route ending at a node while not on the outside of its bundle. |
| `annealMoves` | see below | Simulated-annealing moves in the first pass, and in a seeded solve. `0` disables annealing. |
| `seed` | `42` | Seed for the deterministic PRNG. |
| `initial` | none | Order to start from, per edge id. See `seedFromSnapshot`. |
| `stability` | `1` | With `initial`: cost of each pair that ends in the opposite order to the initial one. |

`annealMoves` defaults to 400 per edge that carries more than one route,
and never less than 10000. The moves are shared between the independent
components in proportion to their size.

An unseeded solve runs a second pass after the annealing. It removes
routes that swap sides while running together, and moves a lane only where
that saves a crossing. `docs/algorithms.md` describes it. It uses no
annealing moves.

A solve is deterministic: the same graph and options give the same orders
every time.

### `stabilizeLanes(graph, options?): void`

Shifts each edge's bundle sideways so routes move as little as possible
where a bundle gains or loses a route. Without it, a route leaving a
five-lane corridor re-centers the remaining four, and every other route
jogs sideways at the junction.

| Field | Default | What it does |
|---|---|---|
| `maxDrift` | `0.5` | Largest shift, in lanes. Half a lane absorbs a parity change without moving any lane. |
| `driftWeight` | `0.001` | Weight of the pull back toward the centered position. |
| `iterations` | `60` | Rounds of coordinate descent. It stops early once nothing moves. |

## Caching the lane order

Ordering only depends on the data, so its result can be stored and reused.
`examples/snapshot-cache/` does this in localStorage.

### `snapshotLaneOrders(graph): LaneOrderSnapshot`

Returns the lane orders and baselines, keyed by each edge's geometry. The
snapshot is plain JSON.

### `applyLaneOrders(graph, snapshot): number`

Applies a snapshot to a graph built from the same data. It returns the
number of edges restored exactly: the same routes, in their stored order,
with their baseline.

An edge whose route set shrank keeps the relative order of the routes that
remain, so hiding a route does not reshuffle the others. Routes the
snapshot does not know go after the ones it does. An exact match also
restores the edge's baseline, so a graph the snapshot covers needs no
`stabilizeLanes`.

### `seedFromSnapshot(graph, snapshot): Map<number, string[]>`

Returns an `OrderOptions.initial` map from a snapshot. Use it when calling
`orderLanes` directly. `orderLanesAsync` takes the snapshot itself, as
`seed`.

## The layer

### `new LaneLayer(options)`

A MapLibre `CustomLayerInterface`. Pass it to `map.addLayer`.

The constructor refuses a missing or wrong `graph` and a `sizes` that is
not a function, by name, rather than failing later inside MapLibre's render
loop. An options object accepts any key, so a misspelled option would
otherwise pass unnoticed.

#### `LaneLayerOptions`

| Field | Default | What it does |
|---|---|---|
| `id` | required | The layer id. |
| `graph` | required | The ordered `LineGraph` to draw. |
| `sizes` | required | `(zoom) => {spacing, width, casingWidth}`, in pixels. |
| `casingColor` | `'#333'` | CSS color of the casing. `null` skips the casing pass. |
| `opacity` | `1` | Opacity of the whole layer. |
| `zoomEpsilon` | `0.25` | Re-lay out when the zoom moves out by more than this. |
| `smooth` | `true` | Smooth centerlines with a spline, keeping corners. |
| `openFolds` | `true` | Make room where a path folds back on itself more tightly than its bundle is wide. See `LayoutOptions`. |
| `laneStyle` | none | Per-edge look. See `LaneStyle`. |
| `cull` | `true` | Only lay out what is near the viewport. |
| `cullMargin` | `0.5` | How far the built area extends beyond the visible one, in viewport widths and heights. |
| `worker` | `true` | Build in a worker. |
| `onBuild` | none | Called after every finished build. See `setOnBuild`. |

Sizes are in screen pixels and are asked for per zoom, so lane spacing and
width can follow the camera. `spacing` is the center-to-center distance
between adjacent lanes, `width` the lane fill width, and `casingWidth` the
casing width on each side. Setting `spacing` one pixel wider than `width`
leaves a casing seam between adjacent lanes.

Alpha in `casingColor` is honored. The casing is drawn under the fill, so a
translucent casing shows the map through its outer rim. It is blended once
per pixel, so it reads the same along the seam between two lanes, where
their casings overlap, as on the outside of the bundle. The same holds when
`opacity` is below 1. A lane below full opacity, through `opacity` or a
highlight's `dim`, is also blended once per pixel. It does not brighten
where its own pieces overlap. Lanes of different routes still blend where
they cross. The layer uses the depth buffer for this, and needs
one of at least 24 bits. It never writes the stencil buffer. An opaque
fill layer above the lane layer covers the lanes. One consequence applies
if the casing is translucent or `opacity` is below 1. Clearing the mark
then overwrites the fill's depth under each route's lanes. Where a later
route's lanes overlap that route, they show over the fill, and so does a
translucent layer between the two. Put the lane layer above the basemap's
fills.

`zoomEpsilon` bounds how stale the geometry may get between rebuilds.
Between them the mesh stays pixel-exact for lane spacing and widths; only
the spline sampling density and the node-front positions age. Zooming in is
tolerated up to twice the value.

Pass `worker: false` to build inside the render call. Two reasons to want
that: the lanes are then drawn by the time the map fires `idle`, which is
what a headless screenshot usually waits for, and a build is then as
deterministic as the render loop, which suits a test.

#### Setters

| Method | What it changes |
|---|---|
| `setGraph(graph)` | The graph. |
| `setSizes(sizes)` | The sizes callback. |
| `setLaneStyle(laneStyle \| null)` | The per-edge look, and has the callback read again. |
| `setOpacity(opacity)` | The layer opacity, on the next frame, without a rebuild. |
| `setCasingColor(css \| null)` | The casing color. `null` removes the casing. |
| `setHighlight(route \| routes \| null, style?)` | Which routes are lifted. |
| `setOnBuild(listener \| null)` | The build listener. |

#### `setHighlight(route, style?)`

Lifts one route, or several: their lanes are drawn last, on top of the
others, with a halo and an outline around them. The rest can be dimmed.
Pass a list to lift several routes as one thing, such as a road carried by
three route relations. Pass `null`, or an empty list, to clear.

The highlight is part of the mesh. It needs no source and no refresh, and
it stays on the lane at every zoom and through every pan.

It draws inside this layer. Anything the map draws above the layer, such as
a tint over the whole map, covers the highlight too. To lift a route above
that, draw it from `laneFeatures` in a layer of your own.

`getHighlight()` returns the highlighted routes, in the order they were
given.

`bright` keeps some graph edges at full opacity under `dim`, though their
routes are not lifted. Use it to show a path picked off the highlighted
route: pass the edge from `queryLane` (`hit.edge`), or the `edge` property
of its `laneFeatures`. Those lanes get no halo and no outline. They stay in
their place in the drawing order, so lanes drawn above them stay above
them, dimmed. A connector counts as part of the edge it arrives from.
`setHighlight(null)` clears `bright` with the rest of the highlight.
Edge ids belong to one graph, and `setGraph` keeps the highlight. After
`setGraph`, pass `bright` again with ids from the new graph.

##### `HighlightStyle`

| Field | Default | What it does |
|---|---|---|
| `halo` | `'#ffb700'` | Halo color. `null` draws none. |
| `haloWidth` | `4` | Halo width beyond the outline, px per side. |
| `haloBlur` | `3` | Width of the halo's soft outer edge, px. |
| `outline` | `'#000'` | Outline between the halo and the lane. `null` draws none. |
| `outlineWidth` | `1.5` | Outline width beyond the casing, px per side. |
| `dim` | `1` | Opacity factor for the routes that are not highlighted. |
| `bright` | none | Graph edge ids whose lanes keep full opacity under `dim`. Has no effect without a `dim` below 1. |

`haloWidth`, `haloBlur` and `outlineWidth` are each a `HighlightWidth`: a
number, or a `(zoom) => number`. They take a callback because lane widths
follow the zoom, and a halo fixed in pixels is a glow at an overview zoom
and a rim close in.

The halo covers the lanes it reaches, highlighted or not, which is what
lifts a route out of a bundle. It reaches
`width / 2 + casingWidth + outlineWidth + haloWidth` from the lane's
center, counting `outlineWidth` whether or not an outline is drawn. Compare
that with `spacing`, the lane pitch. At a wider reach than the pitch,
highlighting one route in a bundle hides the route either side of it.

#### Reading the lanes

| Method | What it returns |
|---|---|
| `getBuildInfo()` | `LaneBuildInfo \| null`: what the last build covers, without its geometry. |
| `getLayout()` | `Layout \| null`: the lane geometry of the last build. |
| `laneFeatures(options?)` | The lane geometry as GeoJSON. |
| `laneFeaturesAsync(options?)` | The same, laid out in the worker. |
| `queryLane(point, tolerancePx?)` | `LaneHit \| null` for a screen point. |
| `queryLaneAt(lngLat, zoom, tolerancePx?)` | `LaneHit \| null` for a geographic point. |

`getBuildInfo` is the cheap readout, for something that runs every frame.
`getLayout` turns a worker's answer into lane paths the first time
something asks for them, so call it when you need the geometry, not on
every frame.

#### `setOnBuild(listener)`

Calls `listener(info)` after every finished build. That is the moment the
lanes it produced become the ones `laneFeatures` and `queryLane` answer
from, so anything derived from the lanes needs this signal.

`moveend`, `zoomend` and `idle` are not enough on their own. Builds run in
a worker, so each of those can arrive while the build the gesture asked for
is still out, and the lanes read then are the previous ones. They are still
needed as well, because `laneFeatures` places its coordinates at the
current zoom: a zoom too small to trigger a rebuild still moves the lanes.
Refreshing on `moveend` and on a build that lands once the map has stopped
covers both, and converts the features once a gesture rather than once a
rebuild.

The first call after `setGraph`, `setSizes` or `setLaneStyle` is always for
the new one. An answer that was already in flight when they were called is
dropped. The listener runs after the render call, never inside it.

There is one listener, and a second call replaces it. Two parts of an
application that both need to know should share one listener. This is a
considered limit, in keeping with the rest of the layer's setters.

#### `laneFeatures(options?)`

Returns the lane geometry as a GeoJSON `FeatureCollection`. Each feature is
one lane piece: an edge's lane, or a connector across a node.

Feed it to a GeoJSON source to place labels or direction arrows along
lanes, to draw a highlight under one route, or to hit-test with a
transparent line layer.

| Property | What it is |
|---|---|
| `route` | The route id. |
| `name` | The route name, or the route id when the route has no name. |
| `color` | The lane color. |
| `direction` | `1` when the coordinates run in the direction of travel, `0` where the route's features cross the edge in both directions. |
| `kind` | `'lane'` or `'connector'`. |
| `edge` | The graph edge. For a connector, the edge it arrives from. |
| `lanes` | How many routes share that edge. `1` where the route travels alone. |
| `routes` | Their ids, in lane order from left to right traveling a to b. |

The graph's `uniformProperties` also appear, under their own names.

The direction of travel comes from the order of the route's own
coordinates, not from a one-way tag. A route travels the way its features
are drawn, so a loop drawn one way round has a direction on every edge.
To draw arrows on one-way paths only, keep the tag in `uniformProperties`
and filter on it as well. `examples/labels/` does this.

##### `LaneFeatureOptions`

| Field | Default | What it does |
|---|---|---|
| `zoom` | the map's current zoom | The zoom the lane positions are computed for. |
| `routes` | every route | Only these routes. |
| `extent` | `'built'` | `'built'` is the last build, culled to the area around the viewport. `'full'` is every lane of the graph. |

`'full'` lays out the whole graph on the spot, which is the most expensive
thing the layer does. Its result stays valid while the map pans and only
needs refreshing when the zoom changes, so it suits a highlight ribbon over
a whole route.

#### `laneFeaturesAsync(options?)`

`laneFeatures` without laying them out on the thread that asks. It asks the
worker, which already holds the graph and a cache for the zoom, and
resolves when the features are ready.

Prefer it for `extent: 'full'`. Results are cached per zoom and route set,
as the synchronous call's are, and two calls for the same one share a
single request. Without a worker, and for the default built extent, it
resolves with what `laneFeatures` returns.

#### `queryLane(point, tolerancePx?)`

Finds the lane nearest to a screen point, within `tolerancePx`, which
defaults to 6. It returns `null` when nothing is within the tolerance.

The nearest lane wins, so a wider tolerance adds reach without costing
accuracy. Only what the last build laid out is searched.

`queryLane` answers while the map moves, too. It reads the lanes of the
last finished build and rescales them to the current zoom. A tap on a
moving map is different: MapLibre spends it on stopping the motion and
delivers no `click`. So a click handler only hit-tests a settled map. If
the handler never fires, that does not mean the layer has nothing there.

`queryLaneAt(lngLat, zoom, tolerancePx?)` is the same for a geographic
point, with the zoom that sets the pixel tolerance.

##### `LaneHit`

| Field | What it is |
|---|---|
| `route` | The route whose lane is nearest. |
| `name` | That route's name. |
| `distancePx` | How far the point is from the lane. |
| `lngLat` | The nearest point on the lane, for anchoring a popup on the lane itself. |
| `kind` | `'lane'` or `'connector'`. |
| `edge` | The graph edge. For a connector, the edge it arrives from. |
| `routes` | Every route on that edge, in lane order from left to right traveling a to b. |
| `properties` | The edge's `uniformProperties` values. |

One tap can therefore both select a route and list everything under the
finger.

##### `LaneBuildInfo`

| Field | What it is |
|---|---|
| `build` | Counts the layer's finished builds, from 1. |
| `zoom` | The zoom the mesh was built for. |
| `bounds` | The Mercator bounds it was culled to, or `null` when it covers everything. |
| `stats` | The layout's stats: edges, edges built, edges merged, nodes, vertices, ms. |
| `timings` | `{layoutMs, meshMs, renderThreadMs}`. |

`layoutMs` and `meshMs` are the layout and the mesh build, wherever they
ran. `renderThreadMs` is what the render thread paid: the buffer upload
alone when the build ran in a worker, and the layout and mesh build as well
when it ran there.

### `LaneStyle`

```ts
type LaneStyle = (edge: GraphEdge, route: string) => LaneAppearance | null | undefined;
```

Draws lanes by the path under them rather than by route, for example by a difficulty
kept in the graph's `uniformProperties`. It may return any of `color`,
`dash`, `dashColor` and `dashCap`. Every field left out keeps the route's
own, and returning nothing keeps the route's look entirely. Casing,
highlight and dimming stay per route.

It must be a pure function of the edge and the route. A callback cannot
cross to a worker, so the layer resolves it into a table per edge and route
when it is set and when the graph is replaced, not on every build. Call
`setLaneStyle` to have it read again.

A route drawn with more than one look becomes more than one draw pass,
since the dash pattern is a uniform. Two appearances over a whole network
is two passes for the routes that carry both, not one per edge.

### Structural types

The layer types as a custom layer under both MapLibre 5.x and 6.x, so it
names what it uses structurally rather than importing MapLibre's classes.

- `LaneMap` is what the layer uses of the map it is added to.
- `LaneRenderArgs` is what `render` reads from MapLibre's render arguments.
- `AnyGlContext` is a WebGL context as either version hands it to a custom
  layer. The layer needs WebGL2.

Applications do not construct these. They exist so that `LaneLayer`
satisfies `CustomLayerInterface` under either version.

## Layout without MapLibre

The layout core is renderer-agnostic. These exports are for drawing lanes
somewhere other than a MapLibre map, or for inspecting the geometry.

### `layoutAtZoom(graph, zoom, sizes, options?): Layout`

Turns an ordered line graph into drawable lane polylines for one zoom.

All sizes are screen pixels. The graph's Mercator coordinates are scaled to
pixels at the requested zoom, so lane spacing, line widths and junction
geometry are pixel-exact for that zoom. Output coordinates are world pixel
coordinates at that zoom.

#### `LayoutOptions`

| Field | Default | What it does |
|---|---|---|
| `bounds` | none | Only build geometry intersecting these Mercator bounds. |
| `smooth` | `true` | Smooth centerlines with a spline through the path vertices. |
| `openFolds` | `true` | Make room where an edge's line folds back on itself more tightly than its bundle is wide. |
| `routes` | every route | Only emit the lanes and connectors of these routes. |
| `laneStyle` | none | Per-edge look. See `LaneStyle`. |
| `cache` | none | A `LayoutCache` to reuse work between rebuilds. |

`openFolds` moves the line, by the least that lets the bundle through.
The legs of the fold are pushed apart and its apex is rounded. No point
moves by more than half the bundle's width. The push is in pixels, so it
fades as the zoom opens the fold. If it is off, every lane stays on its own
offset of the path, and the lanes of such a fold overlap.

Restricting `routes` does not change the geometry. The other routes still
shape lane positions, node fronts and shared turn curves exactly as when
everything is emitted.

### `LayoutCache`

Work kept between rebuilds at one zoom. Most of what a rebuild costs does
not depend on the viewport, so a pan at one zoom only pays for the pieces
it has not reached yet.

Pass the same cache on every call. It resets itself when the graph, the
zoom, the sizes, `smooth`, `openFolds` or the style callback changes. `clear()` drops
everything it holds.

One cache belongs to one sequence of builds. The layouts it produces share
their `LanePath` objects. A dashed route's `startDistance` is set once per
zoom, from every piece of the route, in view or not. So the dash phase does
not move with the viewport, and it is continuous at every seam a route can
make continuous. Do not drive two independent layouts of one graph from a
single cache.

### `Layout`

| Field | What it holds |
|---|---|
| `zoom` | The zoom it was built for. |
| `scale` | Pixels per Mercator unit at that zoom. |
| `paths` | `LanePath[]`: one per lane and per connector. |
| `drawOrder` | Route ids in drawing order. |
| `bounds` | The Mercator bounds used for culling, if any. |
| `mergedEdges` | Edges too short for their junctions at this zoom. |
| `stats` | Counts and the time the layout took. |

`drawOrder` puts routes whose lanes end under other bundles first, so the
through-bundles cover their ends. A route that crosses a group of lanes
turning together is placed above the whole group or below it, never between
two of its lanes. The order is the same at every zoom. Every path of one
route is drawn in one pass, so a route never shows seams between its own
pieces.

An edge in `mergedEdges` has no lane paths. The routes on it cross the
merged junction on one connector, from the edge before to the edge after.

### `LanePath`

| Field | What it holds |
|---|---|
| `route` | The route this piece belongs to. |
| `look` | Its `LaneLook`, with any per-edge override applied. |
| `coords` | World pixel coordinates at the layout zoom, flat `[x, y, ...]`. |
| `anchors` | Per vertex, the ground point it is measured from. |
| `kind` | `'lane'` or `'connector'`. |
| `travel` | The direction of travel along `coords`: `1` with them, `-1` against, `0` where the route's features cross the edge in both directions. |
| `startDistance` | Distance along the route where this path starts, which keeps the dash phase continuous. |
| `edge` | The graph edge. For a connector, the edge it arrives from. |
| `node` | Connectors only: the node they cross. |
| `between` | Connectors only: the edges arrived on and left on. |

`coords - anchors` is a pixel-space vector that stays the same at other
zooms. That is what lets a mesh built at one zoom render correctly at
nearby zooms.

### `LaneLook`

What one path is drawn as: the route's appearance with any per-edge override
applied, field by field. Paths that look alike share one of these, so the
renderer can group by identity. Its fields are `color`, `dash`, `dashColor`
and `dashCap`.

### `LaneSizes` and `SizesAtZoom`

`LaneSizes` is `{spacing, width, casingWidth}`, in pixels. `SizesAtZoom` is
`(zoom: number) => LaneSizes`.

### `lngLatToMercator(lng, lat)` and `mercatorToLngLat(x, y)`

Convert between geographic coordinates and the Web Mercator `[0, 1]` world
units the graph holds. `layoutAtZoom` works in those units, so these are
what turn its output back into coordinates.

### `Bounds` and `Polyline`

`Bounds` is `{minX, minY, maxX, maxY}` in Mercator units. `Polyline` is
`number[]`, a flat `[x, y, x, y, ...]`.

## Workers

### `disposeWorkers(): void`

Terminates the ordering worker and the layout worker, for example when
tearing down a map. They are spawned again on the next request, so this is
safe to call at any time. An ordering in flight finishes on the main
thread.

The plugin keeps the two apart because a re-order after a route is toggled
takes about a second on a phone, and a pan must not queue behind it. The
worker source is inlined into the published bundles and spawned from a Blob
URL, so there is no separate file to serve. Where workers are unavailable,
every caller falls back to doing the work itself.
