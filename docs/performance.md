# Performance

What the plugin costs, so you can judge it against your own network before
you adopt it. The figures cover starting up, laying out a zoom, rebuilding
during a pan, and what any of that asks of the render thread. Phone figures
are included, because a layer that draws on every frame is judged on a
phone.

The desktop figures were taken in Node.js 22 on a Linux machine, against
the fixtures in `test/fixtures`. They use the demo's lane widths: a 2 px
fill at z10, growing to 7 px at z18, with spacing one pixel wider. Device
figures name their hardware where they appear. Every figure comes from the
code as it stands. "Reproducing", at the end, says how to take them again
on your own data and your own device.

## The fixtures

| Fixture | Features | Nodes | Edges | Shared edges | Routes | Widest bundle |
|---|---|---|---|---|---|---|
| RAMBA | 480 | 323 | 492 | 126 | 14 | 6 lanes |
| MFO | 332 | 30 | 43 | 27 | 4 | 4 lanes |
| example | 80 | 73 | 108 | 19 | 10 | 3 lanes |

RAMBA is a dense trail network with many switchbacks and a few long
shared corridors; it is the stress case. "Shared edges" carry more than
one route and are the only ones the lane ordering has to decide.

## Startup: graph and ordering

| Step | RAMBA | MFO | example |
|---|---|---|---|
| Build the line graph | 73 ms | 43 ms | 15 ms |
| Order the lanes (median of 5 seeds) | 107 ms | 17 ms | 6 ms |
| Stable-lane baselines | 2 ms | under 1 ms | under 1 ms |
| Seeded re-order after hiding the busiest route | 85 ms | 12 ms | 4 ms |

The ordering runs in a Web Worker by default, so the map stays
interactive while it runs, and the lanes appear when it finishes. Its
cost scales with the number of shared edges, at roughly a millisecond per
shared edge on this machine, because single-route edges take no decision
and the shared edges are solved as independent groups. The default
budget is 400 annealing moves per shared edge in the first pass. The
second pass, which removes lanes that swap sides mid-run, adds between a
few percent and about an eighth to the solve, depending on how many such
swaps the first pass left.

The solve lands close to the best order there is. `scripts/exact-order.py`
proves that order with an exact solver: RAMBA 45, MFO 47, example 7. The
solver reaches 47, 47 and 7 with the default seed.

On phones the solve is slower by a constant factor. On the RAMBA network
of trailmaps.app, which is a little larger than the fixture, a Pixel 8 in
Chrome ordered the lanes in about 0.45 s and an iPhone 16 in Safari in
about 0.9 s, in both cases inside the worker and with the page visible.
On the iPhone the worker round trip cost no more than the solve itself.

## Layout and mesh per zoom

A full layout covers every edge of the graph; the layer normally lays
out only the area around the viewport, plus half a viewport of margin on
each side, and rebuilds when the view leaves that area or the zoom moves
far enough. The culled column is that build for a 390 by 844 phone
viewport around the middle of the network. "Mesh size" is the three
buffers together: vertices, colors and indices.

RAMBA:

| Zoom | Full layout | Path vertices | Merged edges | Mesh build | Mesh vertices | Mesh size | Culled layout, phone view |
|---|---|---|---|---|---|---|---|
| 12 | 19 ms | 6315 | 199 | 5 ms | 33482 | 1.6 MB | 18 ms, 293 of 492 edges |
| 14 | 22 ms | 15700 | 71 | 9 ms | 62563 | 3.0 MB | 15 ms, 310 of 492 edges |
| 16 | 25 ms | 32843 | 9 | 15 ms | 102744 | 5.0 MB | 5 ms, 49 of 492 edges |
| 18 | 42 ms | 65606 | 1 | 24 ms | 169096 | 8.3 MB | 3 ms, 12 of 492 edges |

MFO:

| Zoom | Full layout | Path vertices | Merged edges | Mesh build | Mesh vertices | Mesh size | Culled layout, phone view |
|---|---|---|---|---|---|---|---|
| 12 | 24 ms | 5113 | 7 | 2 ms | 15779 | 0.8 MB | 25 ms, 36 of 43 edges |
| 14 | 43 ms | 12830 | 1 | 5 ms | 32016 | 1.6 MB | 1 ms, 4 of 43 edges |
| 16 | 43 ms | 29600 | 1 | 9 ms | 65001 | 3.2 MB | 2 ms, 4 of 43 edges |
| 18 | 56 ms | 64549 | 0 | 21 ms | 135010 | 6.7 MB | 1 ms, 0 of 43 edges |

MFO is a small network of dense lines, so at z12 the phone view holds
almost all of it and the culled build is the full one. The example
fixture lays out in 1 to 5 ms at every zoom.

The full layout includes opening the fold backs of bundled edges (see
`docs/algorithms.md`, layout). With `openFolds` off, RAMBA's full layout
is up to 3 ms faster at each of these zooms. MFO's is up to 1 ms faster,
and 10 ms faster at z18, where its lines are longest in pixels. The culled
phone view does not change.

"Merged edges" are the edges too short for their junctions at that zoom,
which are drawn as part of the junction (see `docs/algorithms.md`,
layout). At overview zooms most short edges merge; by z18 almost none do.

## Rebuilds during a pan

A rebuild that the map triggers during a pan is the culled layout plus
the mesh build for that area plus a buffer upload, on the render thread.
Most of that work does not change while the zoom stays the same, so the
layer keeps it between rebuilds: which edges merge into their junctions,
the node fronts, every edge's centerline in pixels, each lane and
connector already built, and each path's triangles. A rebuild at an
unchanged zoom then only pays for the pieces the view has newly reached.

`scripts/bench-rebuild.ts` walks a 390 by 844 viewport across RAMBA on a
lawnmower path and rebuilds on the layer's own rule. Layout plus mesh
build per rebuild, in Node.js on the desktop machine:

| Pan | Rebuilds | Total before | Total now | Median before | Median now |
|---|---|---|---|---|---|
| At z15 | 92 | 639 ms | 133 ms | 6.4 ms | 0.5 ms |
| At z16 | 360 | 1225 ms | 99 ms | 3.0 ms | 0.1 ms |
| Zooming from z15 to z16 while panning | 143 | 663 ms | 790 ms | 3.8 ms | 4.6 ms |

"Before" is the code of 2026-09-17, which rebuilt everything on every
pan. At z15 the worst rebuild of the pan fell from 18 ms to 13 ms, and
the 90th percentile from 12 ms to 5 ms.

The third row moves the zoom as it pans, so almost every rebuild starts
a new zoom and the cache has nothing to give it. A caller that lays out
without a cache pays the same way. That is what
`laneFeatures({extent: 'full'})` and a direct `layoutAtZoom` do. The
per-zoom work now covers every edge rather than the ones in view, and
simplifying each centerline in Mercator pays for most of that back.
Opening fold backs is part of the per-zoom work. It adds about 8 percent
to this row, and nothing measurable to the first two.

## Off the render thread

None of the times above are paid on the render thread: the rebuild runs
in a worker (`worker: false` on the layer puts it back in the render
call). The layer sends the graph once and then one request per rebuild,
carrying the zoom, the style values at that zoom, and the Mercator bounds
to cover. The worker keeps the graph with its own layout and mesh caches,
so it reuses exactly what a rebuild on the main thread would, and sends
back the mesh and the lane paths as typed arrays that are handed over
rather than copied. The render thread uploads three buffers and draws.

The paths become objects again only when something asks for the geometry:
`getLayout`, `laneFeatures` or `queryLane`. `getBuildInfo` reports the
zoom, the bounds and the stats of the last build without that work, for a
readout that runs every frame.

Only one request is ever in flight, because a request cannot be called
back. A pan that outruns the worker waits for the answer it has coming,
then asks again from where it ended up, rather than queueing a request a
frame. Until an answer lands the map goes on drawing the mesh it has,
which is how its own tiles behave; that mesh stays pixel-exact for lane
spacing and width at the current zoom, since it is anchored (see
`docs/algorithms.md`).

Packing an answer costs the worker about a tenth of a rebuild. The same
pan run through the worker's message handler, which adds packing the
paths and copying the buffers out, takes 146 ms over the 92 rebuilds at
z15 instead of 133 ms, and 108 ms over the 360 rebuilds at z16 instead of
99 ms.

## The draw

The render thread's own share of a frame is the draw: uniforms and one draw
call per pass. On RAMBA, in a 390 by 844 view at z15.5, that is 28 draw
calls and about 0.05 ms of JavaScript a frame.

A translucent casing costs more. The casing is then blended once per
pixel (see `docs/algorithms.md`, rendering). That takes a second draw of
each casing, a colorless draw after each fill, and one colorless draw of
the whole mesh at the start of the frame. The same view takes 47 draw
calls. The JavaScript time does not change. An opaque casing on an opaque
layer takes none of this.

On a phone the extra passes cost a few milliseconds of GPU time and no
frames. `scripts/draw-probe.js` draws one view with the casing made opaque
and with the casing as the page has it, and makes the GPU finish before
each reading. These figures are from the deployed RAMBA map with a casing of
`rgba(0, 0, 0, 0.5)`, on a Pixel 8 in Chrome (Mali-G715, a 1078 by 2121
canvas) and an iPhone on iOS 18.7 in Safari (Apple GPU, 1179 by 2085).

| What | Pixel 8 | iPhone |
|---|---|---|
| z15.5, draw calls, opaque and translucent | 17 and 35 | 17 and 35 |
| z15.5, what the translucent casing adds to the layer's draw | 2.0 ms | 0.7 ms |
| z13 with the whole network in view, draw calls | 21 and 43 | 21 and 43 |
| z13, what the translucent casing adds | 4.5 ms | 1.3 ms |
| Frame interval through a scripted pan and zoom at z15.5, median and p95, opaque | 16.7 and 18.6 ms | 17 and 17 ms |
| The same, translucent | 16.7 and 18.9 ms | 17 and 17 ms |
| Frame interval at z13, median and p95, opaque | 16.7 and 21.0 ms | 17 and 17 ms |
| The same, translucent | 16.7 and 19.4 ms | 17 and 17 ms |
| Frames over 32 ms with the translucent casing, of about 318 | none at either zoom | one of 34 ms at z15.5, none at z13 |

Both phones held their refresh interval with the translucent casing, as
they did with the opaque one. The added time is the difference between two
forced draws. Each forced draw also waits on a round trip to the GPU, which
is the same in both, so read the difference and not the totals. Safari
coarsens its timer to 1 ms, so the iPhone's figures are good to a few
tenths of a millisecond. The z13 view is the expensive one because the
whole network is on screen at once.

Ordering and layout run in two workers from one script. A re-order after
a route is toggled takes about a second on a phone, and a pan must not
queue behind it.

## Measured on a phone

Two Chrome performance traces from a Pixel 8 running the RAMBA map inside
a full map application, so the numbers include what the map itself does in
the same frames.

"Before" is 2026-09-17: 42 s of panning and pinching, with the layout and
the mesh built inside the render call. "Now" is 2026-09-18 with the plugin
at b403f97: 137 s of load, slow pans, fast flicks, pinches between z13 and
z17, taps on lanes and a route toggle. The second is longer and pinches
much more, so compare what a task or a rebuild cost, not the totals.

| What | Before | Now |
|---|---|---|
| Rebuilds | 89 | 233 |
| Where a rebuild runs | the render thread | a worker |
| Rebuild work on the render thread | median 18 ms inside a 31 ms task | 142 ms over the whole trace, about 0.6 ms a rebuild, of which the buffer upload is 10 ms |
| Rebuild tasks over 32 ms | 40 of 89 | none |
| Layout and mesh per rebuild | median 18 ms, longest 71 ms | in the worker: median 14.7 ms, p25 4.1 ms, p90 41.1 ms, longest 170.5 ms |
| Plugin work per main-thread task | | median 0.30 ms, p90 0.90 ms, p99 18.8 ms, longest 76.3 ms |
| Main-thread tasks with more than 8 ms of plugin work | | 25 of the 1073 that have any: 24 are full-extent lane features, one is the startup graph build |
| Lane ordering, in its own worker | about 0.9 s | 0.6 s, longest task 290 ms |
| Full-extent lane features | 0.33 s over the trace | 58 calls, 468 ms, median 5.9 ms, longest 54 ms |
| Hit test (`queryLane`) | | 17 calls, median 0.7 ms |
| Turning a worker's answer into paths | | 8 calls, median 0.4 ms |
| Draw | 3 ms a frame | 251 ms over 137 s of interaction |

The rebuild is off the render thread and stays off it: no main-thread task
in the second trace carries rebuild work beyond posting the request and
uploading the buffers. In the worker, a rebuild at an unchanged zoom is
the p25 figure and below, a few milliseconds; the median and the tail are
the pinches, where every rebuild starts a new zoom and the cache has
nothing to give it. The layer's own `timings.renderThreadMs` read 0.2 ms on the
device against 59.7 ms of layout and 17 ms of mesh in the worker for the
first, cold build, and 0.8 ms of layout for a rebuild after a pan at an
unchanged zoom.

What was left on the main thread in that trace is
`laneFeatures({extent: 'full'})`, which lays out every lane of a route
over the whole graph and is what a highlight source under one route is
usually fed from. It is cached per zoom and route set, and a pinch ends on
a zoom it has not seen, so the 58 calls there are mostly one per
`zoomend`: 468 ms in total and up to 54 ms in one task, which made it the
plugin's longest main-thread task by a wide margin.

`laneFeaturesAsync` has since moved that build to the worker as well. The
work is the same size, a median of 24 ms against 25 ms for one RAMBA route
over seven zooms in Node, but none of it lands on the thread that draws.
The synchronous call is still there for callers without a worker, and is
what `laneFeaturesAsync` falls back to.

A third trace on 2026-09-18 confirms it on the device: 96 s of load,
pinches with a route selected, pans and a route switch, on a build whose
highlight source asks for its features with `laneFeaturesAsync`. A fourth,
an hour later against the deployed site rather than a local test build,
says the same: 62 s of interaction, one main-thread task over 8 ms of
plugin work (the graph build at load, 50 ms inside a 264 ms load task),
none with a finger on the glass, and plugin work per task at a median of
0.36 ms, a p90 of 1.04 and a p99 of 4.63.

| What | Before the ribbon moved | After |
|---|---|---|
| Main-thread tasks over 8 ms of plugin work | 25, of which 20 with a finger on the glass | 1, the startup graph build, while idle |
| Plugin work per main-thread task | median 0.30 ms, p90 0.90, p99 18.8, longest 76.3 | median 0.36 ms, p90 1.35, p99 4.43, longest 52.8 |
| Full-extent lane features, on the render thread | 58 calls, 468 ms, about 8 ms a call, longest 54 ms | 15 calls, 13 ms, a median of 0.6 ms a call, longest 2.6 ms |
| Layout worker | 233 tasks, median 14.7 ms, p90 41.1 | 153 tasks, median 15.3 ms, p90 49.2, the ribbon builds among them |

What the render thread still pays for a full extent is the request and
turning the paths into GeoJSON. The longest plugin task left is the graph
build at load, 52.8 ms inside the application's 237 ms load task;
`buildLineGraph` runs where it is called, and the caller chooses when.
That meets the bar this work set itself: no main-thread task carries more
than 8 ms of plugin work while the map is being panned.

The long main-thread tasks that remain during a gesture belong to the map
application, not to the layer. In the fourth trace the longest of them was
51.6 ms and carried 1.0 ms of plugin work; the next five carried between
0.2 and 5.7 ms. The layer's own share of a frame is now the draw, which
came to 135 ms over 62 s of interaction.

## Measured on an iPhone

An iPhone on iOS 18.7 in Safari, on the deployed RAMBA and Glacial Hills
maps, taken 2026-09-19 with the plugin at 34a0aa3. The device reports
four cores, a device pixel ratio of 3, and a 393 by 695 CSS viewport.
WebGL2 is there and the renderer is "Apple GPU". These are the first
numbers from a WebKit engine; everything above is V8.

They come from a script rather than a trace. It drives the map through a
fixed sequence of two pans and three zoom changes over about nine
seconds, samples the layer once per animation frame, and then times 200
`queryLane` calls. Safari coarsens `performance.now()` to 1 ms, so every
figure here is a total over many events rather than a single reading.

| What | RAMBA | Glacial Hills |
|---|---|---|
| Edges in the full graph | 492 | 172 |
| Vertices in the built extent | 4054 | 4640 |
| Builds in the run | 9 | 8 |
| Build work on the render thread | 1 ms in total | 2 ms in total |
| Layout, in the worker | 245 ms in total, longest 77 ms | 183 ms in total, longest 36 ms |
| Mesh, in the worker | 72 ms in total, longest 24 ms | 47 ms in total, longest 13 ms |
| Frames | 488 | 512 |
| Frame interval | median 17 ms, p95 17 ms | median 17 ms, p95 17 ms |
| Frames over 32 ms | 9 | 3 |
| Frames over 100 ms | 3 | none |
| Longest frame | 128 ms | 60 ms |
| Hit test (`queryLane`) | 200 calls, 82 ms, 0.41 ms each | 200 calls, 86 ms, 0.43 ms each |

The bar holds on iOS as it does on Android. The work on the render thread
is the buffer upload and the mesh swap, and it came to about a tenth of a
millisecond a build on both maps. The layout and the mesh run in the
worker and never touch a frame.

Both maps held the refresh interval for 95 percent of their frames. The
median and the p95 are the same 17 ms, so the distribution is tight and
only the tail moves.

That tail belongs to RAMBA rather than to iOS. RAMBA dropped three frames
past 100 ms and Glacial Hills dropped none, while the two had a similar
number of vertices in view. What differs is the size of the whole graph,
492 edges against 172, and that is what a cold layout after a zoom change
costs: 77 ms against 36 ms. The plugin's own render-thread work over each
run was 1 ms and 2 ms, so it cannot account for a frame of 128 ms. What
does account for it is not established. That needs a Safari timeline
recording rather than a counter.

Against the Pixel 8 above, on the same RAMBA map: the cold layout was 77
ms here and 59.7 ms there, the mesh 24 ms and 17 ms, and the cost per
build on the render thread about 0.11 ms and 0.2 ms. iOS is a little
slower where the work is and a little cheaper on the thread that matters.

Two things this does not cover. The script drives the map with `easeTo`,
which is not a pinch. And a `queryLane` timing says nothing about whether
a finger hits the lane it was aimed at. Pinch behavior and touch accuracy
are still to be checked by hand.

## Lane features

`laneFeatures({extent: 'full'})` lays out every lane of the requested
routes for one zoom: 13 to 29 ms for all of RAMBA depending on zoom on
the desktop, a median of 5.9 ms and up to 54 ms on the Pixel 8 above. The
result is cached per zoom and route set. A single route's full extent is
the same layout with only that route's pieces emitted, so it costs about
the same. `laneFeatures` runs it on the thread that calls it;
`laneFeaturesAsync` asks the worker for it and resolves when it is ready,
which is what a map with a worker should use.

## Reproducing

`corepack pnpm test` runs the layout and ordering on the fixtures and
prints timings with `--silent=false`. The layout and mesh table comes
from `node scripts/run-ts.mjs scripts/bench-layout.ts`, which lays each
fixture out five times per zoom and keeps the median. The pan table
comes from `node scripts/run-ts.mjs scripts/bench-rebuild.ts`, with
`--no-cache` for the uncached column and `--worker` for what a rebuild
costs the worker. Run both from the repo root.

To check the lane ordering against the best possible order, run
`scripts/exact-order.py` from the repo root. The library orders lanes with
a local search, which is fast and proves nothing. The script gives the
same problem to an exact solver, OR-Tools CP-SAT. For each fixture it
prints the cost the library reached, the lowest cost any order can reach,
and whether that lowest cost was proved. Run it after a change to
`src/core/order.ts`.

The script is a development tool. No map runs it, and `corepack pnpm
test` does not need it. It needs Node.js and the Python package
`ortools`, which is not a dependency of the library. The install is three
lines, and they are at the top of the script. To check another network,
pass the path of its GeoJSON file. If the map sets `uniformProperties`,
pass the same names with `--uniform`, because they split edges and so
change the problem.

For a device on WebKit, open a Web Inspector console on the page and
paste `scripts/device-probe.js`, with the page visible on the device. It
prints the iPhone table above. A backgrounded tab suspends
`requestAnimationFrame`, and the layer only builds inside the render
call, so a hidden page reports zero frames and zero builds.

For the cost of the draw on a device, frame the view, then paste
`scripts/draw-probe.js` into the same console. It draws that view with an
opaque casing and with the page's own, makes the GPU finish before each
reading, and then moves the map the same way under each to report frame
intervals. It prints the table in "The draw". A performance trace cannot
give that figure: a translucent casing costs the render thread nothing,
and a trace does not split GPU time by layer.

For a Chrome device trace, record a performance trace of a page running
the published `dist/maplibre-gl-lanes.js` and run
`scripts/profile-trace.py` on it with the matching source map. It
attributes the profile to the plugin's source functions, splits every
main-thread task with plugin work into layout, mesh and draw, and
reports the worker's ordering time; the phone table above is its
output.
