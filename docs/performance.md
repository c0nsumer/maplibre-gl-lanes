# Performance

What the plugin costs, so you can judge it against your own network before
you adopt it. The figures cover starting up, laying out a zoom, rebuilding
during a pan, and what any of that asks of the render thread. Phone figures
are included, because a layer that draws on every frame is judged on a
phone.

The desktop figures were taken in Node.js 22 on a Linux machine, against
the fixtures in `test/fixtures`. They use the demo's lane widths: a 2 px
fill at z10, growing to 7 px at z18, with spacing one pixel wider. Device
figures name their hardware where they appear. Every figure comes from
the code as it stands, except the phone figures in "The draw", which were
taken at 1.0.0. The draw has not changed since. "Reproducing", at the
end, says how to take them again on your own data and your own device.

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
| Build the line graph | 41 ms | 27 ms | 7 ms |
| Order the lanes (median of 5 seeds) | 86 ms | 14 ms | 5 ms |
| Stable-lane baselines | 1 ms | under 1 ms | under 1 ms |
| Seeded re-order after hiding the busiest route | 90 ms | 11 ms | 3 ms |

The ordering runs in a Web Worker by default, so the map stays
interactive while it runs, and the lanes appear when it finishes. Its
cost scales with the number of shared edges, at under a millisecond per
shared edge on this machine, because single-route edges take no decision
and the shared edges are solved as independent groups. The default
budget is 400 annealing moves per shared edge in the first pass, and
never fewer than 10000. The second pass, which removes lanes that swap
sides mid-run, adds between a few percent and about an eighth to the
solve, depending on how many such swaps the first pass left.

The solve lands close to the best order there is. `scripts/exact-order.py`
proves that order with an exact solver: RAMBA 45, MFO 47, example 7. The
solver reaches 47, 47 and 7 with the default seed.

On phones the solve is slower by a constant factor, and the worker adds a
little on top. `scripts/order-probe.js` splits the two. It times the
graph build, a full solve in the layer's warm worker, the same solve on
the main thread, a solve seeded from a previous result with the busiest
route hidden (what a route toggle asks for), a worker solve while the
main thread spins for one second, and the first round trip of a freshly
made worker. The figures below are from the deployed RAMBA map of
trailmaps.app, which is larger than the fixture (597 edges, 147 shared),
on an iPhone 16 in Safari 27 and a Pixel 8 in Chrome 154, with the page
visible and the map at rest. Each is the median of the probe's runs.

| What | iPhone 16 | Pixel 8 |
|---|---|---|
| Build the line graph, main thread | 15 ms | 37 ms |
| Full solve in the worker, call to answer | 218 ms | 108 ms |
| The same solve on the main thread | 164 ms | 119 ms |
| Seeded re-solve with the busiest route hidden | 201 ms | 107 ms |
| Worker solve while the main thread spins for 1000 ms | 1001 ms | 1001 ms |
| A fresh worker's first round trip, the layer's own script | 8 ms | 28 ms |

The solve itself, on the main thread, is 164 ms in Safari's engine and
119 ms in Chrome's. What the worker adds on the iPhone is about 55 ms of
round trip on that solve, and spawning one costs 8 ms. On the Pixel the
solve in the worker came in under the one on the main thread, so its
round trip is inside the spread between runs. A solve keeps running while
the main thread is busy: the spinning main thread neither stalled it nor
added to it. So a re-order after a route toggle is done in about 0.2 s on
either phone.

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
| 12 | 16 ms | 6350 | 197 | 4 ms | 34051 | 1.6 MB | 16 ms, 295 of 492 edges |
| 14 | 19 ms | 15661 | 71 | 7 ms | 62532 | 3.0 MB | 15 ms, 310 of 492 edges |
| 16 | 20 ms | 32814 | 9 | 12 ms | 102685 | 5.0 MB | 5 ms, 49 of 492 edges |
| 18 | 29 ms | 65639 | 1 | 19 ms | 169162 | 8.3 MB | 3 ms, 12 of 492 edges |

MFO:

| Zoom | Full layout | Path vertices | Merged edges | Mesh build | Mesh vertices | Mesh size | Culled layout, phone view |
|---|---|---|---|---|---|---|---|
| 12 | 8 ms | 5103 | 7 | 2 ms | 15773 | 0.8 MB | 8 ms, 36 of 43 edges |
| 14 | 14 ms | 12824 | 1 | 3 ms | 32004 | 1.6 MB | 1 ms, 4 of 43 edges |
| 16 | 19 ms | 29576 | 1 | 7 ms | 64968 | 3.2 MB | 1 ms, 4 of 43 edges |
| 18 | 30 ms | 64549 | 0 | 14 ms | 135010 | 6.7 MB | under 1 ms, 0 of 43 edges |

MFO is a small network of dense lines, so at z12 the phone view holds
almost all of it and the culled build is the full one. The example
fixture lays out in 2 to 5 ms at every zoom.

The full layout includes opening the fold backs of bundled edges (see
`docs/algorithms.md`, layout). With `openFolds` off, RAMBA's full layout
is up to 4 ms faster at each of these zooms. MFO's is up to 4 ms faster,
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

| Pan | Rebuilds | Total, no cache | Total, cached | Median, no cache | Median, cached |
|---|---|---|---|---|---|
| At z15 | 92 | 571 ms | 120 ms | 5.1 ms | 0.5 ms |
| At z16 | 360 | 1020 ms | 89 ms | 2.6 ms | 0.1 ms |
| Zooming from z15 to z16 while panning | 143 | 585 ms | 679 ms | 3.3 ms | 3.8 ms |

"No cache" rebuilds everything on every pan, which is what the layer did
before it kept its per-zoom work (`--no-cache` on the benchmark). At z15
the cache takes the worst rebuild of the pan from 19 ms to 9 ms, and the
90th percentile from 11 ms to 4 ms.

The third row moves the zoom as it pans, so almost every rebuild starts
a new zoom and the cache has nothing to give it. A caller that lays out
without a cache pays the same way. That is what
`laneFeatures({extent: 'full'})` and a direct `layoutAtZoom` do. The
per-zoom work covers every edge rather than the ones in view: it decides
which edges merge and where the fronts sit, which needs them all. Its
cost is the difference between this row and the culled builds of the
layout table. Opening fold backs is part of the per-zoom work and adds
nothing measurable to any row. The cached run of this row costs more than
the uncached one because the caches are filled for a zoom that is never
asked for again.

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

Packing an answer costs the worker about a quarter of a cached rebuild,
which is a fraction of a millisecond. The same pan run through the
worker's message handler, which adds packing the paths and copying the
buffers out, takes 154 ms over the 92 rebuilds at z15 instead of 120 ms,
and 111 ms over the 360 rebuilds at z16 instead of 89 ms.

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
a route is toggled takes about 0.2 s on a phone, and a pan must not queue
behind it.

## Measured on a phone

An iPhone 16 in Safari 27 and a Pixel 8 in Chrome 154, on the deployed
RAMBA map of trailmaps.app, each driven through the same run of
`scripts/device-probe.js`: two pans and three zoom changes over about
nine seconds, the layer sampled once per animation frame, then 200
`queryLane` calls. The map application runs in the same frames, so the
frame figures include what it does. The iPhone reports four cores, a
device pixel ratio of 3 and a 393 by 695 CSS viewport, with "Apple GPU"
as the renderer. The Pixel reports nine cores, a device pixel ratio of
2.625 and a 411 by 808 CSS viewport, on a Mali-G715. Both have WebGL2.
Safari coarsens `performance.now()` to 1 ms, so the iPhone's figures are
totals over many events rather than single readings. Chrome's timer is
good to 0.1 ms.

| What | iPhone 16 | Pixel 8 |
|---|---|---|
| Edges in the full graph | 597 | 597 |
| Vertices in the built extent | 4397 | 4884 |
| Builds in the run | 8 | 8 |
| Build work on the render thread | 3 ms in total | 1.8 ms in total |
| Layout, in the worker | 220 ms in total, longest 54 ms | 360 ms in total, longest 93 ms |
| Mesh, in the worker | 81 ms in total, longest 19 ms | 93 ms in total, longest 25 ms |
| Frames | 482 | 492 |
| Frame interval | median 17 ms, p95 20 ms | median 16.7 ms, p95 20.5 ms |
| Frames over 32 ms | 9 | 8 |
| Frames over 100 ms | 3 | 2 |
| Longest frame | 115 ms | 146 ms |
| Hit test (`queryLane`) | 200 calls, 93 ms, 0.47 ms each | 200 calls, 55 ms, 0.28 ms each |

The built extents differ because the viewports do. The work on the
render thread is the request, the buffer upload and the mesh swap, and it
came to under half a millisecond a build on both phones. The layout and
the mesh run in the worker and never touch a frame. The median frame is
the refresh interval on both phones, and the 95th percentile is within
four milliseconds of it, so the distribution is tight and only the tail
moves.

The tail is not the plugin's. Its render-thread work over the whole run
was 3 ms on the iPhone and 1.8 ms on the Pixel, so it cannot account for
one frame of 115 or 146 ms. Every frame over 32 ms fell in the first
frame of the run or where a zoom settled: on the iPhone six in the second
zoom-in and two in the zoom-out, on the Pixel four and one, with two more
of 32 to 40 ms as the Pixel returned to the start. How many frames pass
100 ms varies from run to run: eight earlier runs at 1.0.0, four on each
phone, had none.

Recordings of the same run at 1.0.0 show what those frames hold. On the
iPhone the run's worst were four frames in a row of 41 to 56 ms as the
zoom-in settled, each holding one promise callback of 24 to 42 ms and a
composite of about the same length, right after a worker's message. That
is a worker's answer being applied when a zoom ends, and the plugin's
builds in that run were 17 ms at the longest, in its worker. Over the
run, WebKit's sampler attributed 347 ms of main-thread time to MapLibre,
66 ms to the plugin and 17 ms to the contour layer. The Pixel's CPU
profile over its 9.4 s run reads the same way: 2.1 s in MapLibre, 83 ms
in the plugin, 79 ms in the map application, with the longest
main-thread task during the motion at 34 ms. In those recordings no
main-thread task carried more than 8 ms of plugin work while the map was
being panned. The longest plugin task on the main thread is the graph
build at load, in the "Startup" table; `buildLineGraph` runs where it is
called, and the caller chooses when.

Two things this does not cover. The script drives the map with `easeTo`,
which is not a pinch. And a `queryLane` timing says nothing about whether
a finger hits the lane it was aimed at. Pinch behavior and touch accuracy
are checked by hand.

## Lane features

`laneFeatures({extent: 'full'})` lays out every lane of the requested
routes for one zoom: 16 to 29 ms for all of RAMBA depending on zoom on
the desktop. The result is cached per zoom and route set. A single route's full extent is
the same layout with only that route's pieces emitted, so it costs about
the same. `laneFeatures` runs it on the thread that calls it;
`laneFeaturesAsync` asks the worker for it and resolves when it is ready,
which is what a map with a worker should use.

## Reproducing

The startup table comes from `node scripts/run-ts.mjs
scripts/bench-startup.ts`: five runs of each step, the median kept, with
the ordering itself the median over seeds 1 to 5 and the re-order seeded
from the solved graph with the route on the most edges hidden. The layout
and mesh table comes from `node scripts/run-ts.mjs scripts/bench-layout.ts`,
which lays each fixture out five times per zoom and keeps the median. The
pan table comes from `node scripts/run-ts.mjs scripts/bench-rebuild.ts`,
with `--no-cache` for the uncached columns and `--worker` for what a
rebuild costs the worker; the pan table holds the median of three runs
of it. Run all three from the repo root.

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
pass the path of its GeoJSON file. If its route id is not in a `route_id`
property, name the property with `--route-property`. If the map sets
`uniformProperties`, pass the same names with `--uniform`, because they
split edges and so change the problem.

For a phone, open a console attached to the page (Safari's Web Inspector
for an iPhone, `chrome://inspect` for an Android phone) and paste
`scripts/device-probe.js`, with the page visible on the device. It prints
the table in "Measured on a phone", and lists every frame over 32 ms
with the motion it fell in and its time since the run started, so a
recording taken during the run can be read at that spot. A backgrounded
tab suspends `requestAnimationFrame`, and the layer only builds inside
the render call, so a hidden page reports zero frames and zero builds.

For where a lane ordering's time goes, paste `scripts/order-probe.js`
into the same console with the map at rest. It prints the ordering table
under "Startup", on private copies of the page's graph, so the page's
own layer is not disturbed.

To record a Safari timeline of the probe's run, enable only JavaScript
& Events, CPU, Layout & Rendering and Network, start recording, open the
split console with Esc and paste the probe there. The Screenshots
instrument must stay off: on the device it captures a frame every 90 ms
and holds the page to about 11 frames a second for the whole recording,
so every frame reads as 80 to 95 ms whatever the page does. With it off
the recording does not move the probe's figures.

To record a Chrome trace of the probe's run on an Android phone, with
`adb` on the tethered machine:

    adb forward tcp:9222 localabstract:chrome_devtools_remote
    node scripts/pixel-trace.mjs ramba scripts/device-probe.js out/pixel

It pastes the probe, stops when the probe prints, and writes the trace
beside the probe's output. The trace is what the Performance panel's
"Save profile" would have given, which a DevTools window attached
through `chrome://inspect` does not always manage. Recording this way
did not move the probe's figures either.

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
reports the worker's ordering time.
