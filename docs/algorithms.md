# How maplibre-gl-lanes works, and where each idea comes from

This page maps every technique in the plugin to its source. The plugin is
an independent implementation written from the published papers. No code
from LOOM or any other GPL project was used, which is why the plugin can be
MIT licensed.

## The problem

Several routes travel along the same physical path. Drawing them on top of
each other hides all but one. Transit maps solve this by drawing each route
as its own lane, side by side, in a consistent order, with smooth curves
where routes join and leave. The academic name for choosing the order is
metro-line crossing minimization.

## Pipeline

### 1. Line graph

Every run of path shared by the same set of routes becomes one edge. Nodes
are the points where that set changes or paths meet. This is the "line
graph" of Bast, Brosi and Storandt [1], built here from GeoJSON by matching
shared vertex coordinates. Routes are traced into chains by always
continuing along the straightest unused edge, and a route that revisits a
junction gets its loop end merged back into the stem. The chain tracing and
the merge rule are this project's own.

Shared paths are found by exact vertex match, so the input has to be
digitized on a common network. LOOM's topology extraction [1, chapter 3
of 2] recovers that from geometry that is not, which is a problem in its
own right and out of this plugin's scope.

### 2. Lane ordering

The cost function is the metro-line node crossing minimization (MLNCM)
model of [1]: a single order per edge, crossings charged inside nodes
(weight 4 when two lines continue onto the same edge, 1 when they diverge),
and a separation penalty (weight 3) when lines that were adjacent stop
being adjacent. A small "periphery" hint (0.5) nudges lines that end at a
node to the outside of their bundle, after the periphery condition of
Bekos, Kaufmann, Potika and Symvonis [4].

The background for the crossing model is Benkert, Nöllenburg, Uno and
Wolff [3], who introduced the problem, and Fink and Pupyrev [5], who
settled which crossings are avoidable and proved the hardness results.

The solver is this project's own, and it runs in two passes.

The first pass starts with greedy propagation from the busiest edge. Then
it runs simulated annealing whose move swaps two adjacent lines and carries
the swap along every edge on which they stay adjacent. A per-edge
exhaustive descent finishes. Before the annealing, the edges that carry
more than one line are split into groups that share no node. Cost terms
only couple edges that meet at a node, and an edge with one line has no
terms of its own, so each group is an independent problem. Each group is
solved on its own with a share of the move budget in proportion to its
size. This has the effect of LOOM's graph simplification, which prunes
single-line edges and contracts degree-two nodes before solving [1, 2],
without rewriting the graph. Random restarts after the annealing were tried
and never beat it on the test networks, so the whole budget goes to the
annealing.

The first pass's move has a blind spot. Two lines can swap sides between
two edges they share, with nothing joining or leaving there. The move
flips both sides of such a swap together, so it can never remove one, and
the greedy start creates them where two of its fronts meet. The second
pass removes them. At each node where a pair swaps sides, it aligns one
side's run of edges to the other, as far along the run as that lowers the
cost, best gain first. Then it descends again, with the per-edge descent,
with the first pass's swaps and with one-way swaps. A one-way swap leaves
its start edge through one end only. Each pair of lines that leaves the
first pass's order costs 0.25 in this pass, a quarter of a diverging
crossing, so a lane moves only where that saves a crossing. The alignment
step charges 0.1 instead. It acts only where a pair swaps sides, so it
cannot disturb a junction that has no such swap.
This matters because the cost model counts events and cannot see how much
room a junction has: two orders of one cost can draw differently at a
cramped junction, and the first pass's order is the one that has been
looked at. The second pass is not from the cited papers. It was worked out
for this project.

LOOM uses an integer linear program with untangling rules. Neither was
ported. `scripts/exact-order.py` proves the best possible order of a
network with an exact solver, and the two passes land within a few percent
of it on the fixtures: RAMBA 47 against a proven 45, MFO 47 against 47,
example 7 against 7.

A seeded solve starts from a previous result, so that hiding or showing a
line keeps the other lanes where they were. It adds a stability term to the
cost: a fixed amount (default 1, a quarter of a same-edge crossing) for each
pair of lines that ends in the opposite order to the seed. It is one pass:
annealing with the full budget on this combined objective, with the
one-way swaps among its moves, then the descents. The result is kept only
if it beats the seed itself after a descent. Lanes move only where
the crossings saved are worth it. On the RAMBA fixture without its four
winter routes, hiding the busiest of the other ten moves no lane, and
showing it again moves none.

### 3. Stable lanes

With centered bundles, a route leaving a five-lane corridor shifts every
other lane by half a lane. The stable-lane pass chooses a per-edge sideways
baseline that cancels those shifts, subject to a clamp, by minimizing the
total lateral movement across all transitions. This pass does not come
from the papers cited here. It was worked out for this project. It may
exist elsewhere in the transit-map literature under another name; the
author has not found it there.

A lane that runs alone takes that shift only where it meets a bundle. It
holds the shift at each junction its route continues through. From there it
eases back onto the path over twelve lane spacings, and it follows the path
itself for the rest of the edge. Where its route ends, it ends on the path.
If an edge is too short for both eases, the lane moves toward the path only
as far as the same gentle slope allows. Without this, a solo lane would run
half a lane beside the path for its whole length. That shows over a basemap
that draws the path, and beside a marker placed on the path. A bundle keeps
its shift for its whole length, because half a lane does not show on a
bundle. This step is also not from the cited papers, and was worked out for
this project.

### 4. Layout

The geometric construction follows LOOM's renderer [1, section 5; 2,
chapter 6]:

- Each lane is a parallel offset of the edge centerline. Offsetting joins
  consecutive shifted segments by intersection on the inside of a turn and
  by a circular arc on the outside, then removes the loops that offsetting
  creates on tight bends, as LOOM does. Loop removal looks twelve offsets
  ahead along the path: the loop on the inside of a hairpin has a throat
  several offsets long, and a shorter window left it as a spike. Before
  offsetting, the centerline is simplified with a tolerance of a quarter
  of the edge's widest lane offset, so zigzags too small to show under the
  bundle at that zoom do not throw the lanes of both legs across each
  other. Switchbacks whose legs run closer together than one lane pitch
  still overlap: at that zoom there is no room to draw them apart.
- Each bundle is cut back from its nodes by a "node front" distance so that
  bundles arriving at different angles do not overlap.
- Every route is reconnected across a node from its lane on one edge to its
  lane on the next. Where the two meet at a real angle the lane runs to the
  point their lines cross and rounds that corner by 1.5 lane pitches, so
  the legs of a junction keep their own geometry: a T reads as a T rather
  than as one leg swung into another. The radius is in lane pitches, so it
  is the same on the screen at every zoom. Where the turn is gentle, or
  where the legs meet so obliquely that their lines cross far away, the
  connector is a cubic Bezier instead. The control-handle rule there is
  LOOM's: when the tangent rays meet at a point, the handles are scaled so
  the curve approximates a circular arc (k = 4/3 (sqrt 2 - 1)); otherwise
  the curve is an S.
- Routes that make the same turn between the same two edges, keeping their
  relative lane positions, get connectors that are parallel offsets of the
  longest connector in the group, as in LOOM's renderer [2, chapter 6].
  Separate Beziers through each route's own end points are concentric only
  for a symmetric turn; anywhere else the lanes pinch or spread mid-turn.
  A route keeps its own curve when the offset loses much of its length to
  loop removal on the inside of a tight turn. Only the arcs are derived
  this way. A parallel offset of a corner is an arc of radius equal to the
  offset, which is the sweep a corner exists to avoid, so a lane that turns
  at a corner keeps its own: the corners of a bundle are staggered, each on
  its own line, the way a hand-drawn junction stacks them.
- A corner or a curve is built between the two cut ends of a lane, which
  at low zoom can be eight lanes from the node. Where the path bends inside
  that cut, the curve would leave the mapped line. Where it would leave it
  by more than one lane beyond the lane's own offset, the whole group of
  connectors follows the line instead, the way connectors over merged edges
  do. This rule is not from the cited papers. It was worked out for this
  project.
- Junctions closer together than a bundle is wide merge into one junction,
  LOOM's "meta node" [2, chapter 6]. At each zoom, an edge is merged into
  the junctions at its ends when it is shorter than the widest bundle
  meeting there, or shorter than the room the lane changes across it need.
  Its own lanes are not drawn. Each route crosses the merged junction on
  one piece that follows the merged edges' geometry, with its offset
  sliding from the lane it arrives on to the lane it leaves by, so the
  trail's shape stays visible and nothing cuts a corner. A route that
  starts or ends inside the merged junction gets one such piece from its
  lane to its end point. A route that forks inside the merged junction
  crosses one merged edge on two pieces. Each of those slides by way of
  the lane the route holds on that edge, so the two share one line across
  it and the route stays one lane wide. Left alone, the cut-backs and lane-change
  curves at the two ends of such an edge overlap and fold into loops and
  blobs, which is what dense networks showed at overview zooms. The
  clearance two bundles need to pass each other at a shallow angle is not
  a trigger: it can exceed a whole hairpin, and merging that replaces a
  smooth turn with a corner. Where the sliding lane would loop through a
  hairpin, the plain Bezier connector takes over.

Differences from LOOM: the layout is computed in screen pixels for the
current zoom rather than in map units for a fixed scale; lanes of routes
that end where other routes pass are not cut back; centerlines are
optionally smoothed with a centripetal Catmull-Rom spline, which stops at
any bend sharper than 60 degrees and rounds that bend by 1.5 lane pitches
instead, so a corner in the path stays a corner; and the whole thing is
culled to the viewport.

A bundle drawn along a line needs the line to keep clear of itself. Two
legs of a hairpin closer together than the bundle is wide put the lanes of
one leg over the lanes of the other. An apex tighter than the bundle's
half width does worse. The inner lanes' offset meets itself short of the
apex while the outer lanes go round it, so a lane cuts the turn short or
drops out of it. The layout therefore opens such folds on the centerline,
before any lane is offset from it. Two points are folded back when they
are closer than the bundle's width, their directions are within 60 degrees
of opposite, and they are further apart along the line than the half
circle a bend of that width would put between them. A bend the bundle fits
round cannot meet all three, and neither can a corner. The pairs across a
fold are matched outward from its tip. Each leg is pushed away from the
other by half of what the gap lacks, which tapers to nothing where the
legs part. The apex becomes a half circle of the bundle's width that still
passes through the tip. Every lane is then offset from the one moved line,
so the lane pitch holds through the turn. A leg with a neighbor on both
sides would be pushed both ways, so a stack of switchbacks is left alone,
as is anything within a lane of a node front. This step does not come
from the papers cited here either. It was worked out for this project.

Everything above the culling depends on the zoom alone, not on the
viewport: the merge decisions, the junctions, the node fronts and each
edge's centerline in pixels. The layer keeps them, and each lane and
connector it has built, from one rebuild to the next, so panning at one
zoom only lays out the pieces the view has newly reached. The viewport
decides what is emitted, never the shape of a piece. The simplification of
a centerline (Douglas-Peucker) makes the same splits at every zoom. Each
edge therefore ranks its vertices once, by the tolerance at which each one
survives, and every zoom filters that ranking instead of simplifying again.

### 5. Rendering

The renderer is this project's own, modeled on MapLibre GL JS's line
layer [6]: triangle strips whose width is applied in the vertex shader from
a per-vertex extrude vector, with anti-aliasing computed from a unit normal
in the fragment shader. Three additions:

- Each vertex stores a ground anchor plus a pixel-space vector, so a mesh
  built for one zoom stays pixel-exact at nearby zooms and rebuilds are
  rare. A rebuild runs in a worker, which keeps the graph and the caches
  above, and the map draws the mesh it has until the new one arrives.
- MapLibre's projection shader prelude is compiled in, so the same mesh
  renders under mercator and globe projections.
- A translucent casing is blended once per pixel. Every lane draws its
  casing as a ribbon under its fill, so casings overlap: along the seam
  between adjacent lanes, and where one path's round cap lies over the
  next path's casing. Blended twice, a translucent casing reads stronger
  there than on the outside of the bundle. The layer keeps a mark per pixel
  that says a casing is showing. A casing draws only where the mark is not
  set, and sets it. A fill clears it, because a later lane's casing does
  belong over an earlier lane's fill where the two cross. The mark is a
  depth value at the far plane, which every later MapLibre layer passes
  over. It is not in the stencil buffer, where MapLibre keeps tile clipping
  masks that a custom layer has no way to invalidate.

Each route is drawn in one pass, in one order for the whole map. Routes
whose lanes end under other bundles are drawn first, so the bundles cover
their ends. Where a route crosses a group of lanes that turn together, it
must not be drawn between them, or it passes over one lane of the group
and under the next. The drawing order is chosen so that every such route
is above its whole group or below it, by an exact search over the routes
involved, from the graph and its lane orders rather than from drawn
geometry, so it is the same at every zoom. The search doubles with every
route involved. If more than 16 routes are involved, the search is
skipped, and they keep the order by lane ends alone. This is not from the
cited papers either. It was worked out for this project.

Dash patterns are computed per fragment from a per-vertex distance along
the route, with the phase carried through junctions. Dots are geometry
instead, one quad per dot at the same positions along the route. A dot
computed per fragment is only a disc where the ribbon is straight.

## References

1. Hannah Bast, Patrick Brosi, Sabine Storandt. Efficient Generation of
   Geographically Accurate Transit Maps. ACM Transactions on Spatial
   Algorithms and Systems 5(4), article 25, 2019.
   https://doi.org/10.1145/3337790 (preprint: https://arxiv.org/abs/1710.02226)
2. Patrick Brosi. Automated Generation of Transit Maps. PhD thesis,
   University of Freiburg, 2022.
   https://ad-publications.cs.uni-freiburg.de/theses/PhD_Thesis_Patrick_Brosi.pdf
3. Marc Benkert, Martin Nöllenburg, Takeaki Uno, Alexander Wolff.
   Minimizing Intra-Edge Crossings in Wiring Diagrams and Public
   Transportation Maps. Graph Drawing 2006, LNCS 4372, pp. 270-281.
   https://doi.org/10.1007/978-3-540-70904-6_27
4. Michael A. Bekos, Michael Kaufmann, Katerina Potika, Antonios Symvonis.
   Line Crossing Minimization on Metro Maps. Graph Drawing 2007, LNCS 4875,
   pp. 231-242. https://doi.org/10.1007/978-3-540-77537-9_24
5. Martin Fink, Sergey Pupyrev. Metro-Line Crossing Minimization: Hardness,
   Approximations, and Tractable Cases. Graph Drawing 2013.
   https://arxiv.org/abs/1306.2079
6. MapLibre GL JS, line bucket and line shaders (BSD-3-Clause).
   https://github.com/maplibre/maplibre-gl-js
7. LOOM, the software suite behind [1] and [2]. Patrick Brosi, Hannah
   Bast, Sabine Storandt, University of Freiburg. GPL-3.0.
   https://github.com/ad-freiburg/loom
   Its design was studied for the topology, ordering, and rendering
   stages, and the parallel-offset connectors and merged junctions of
   section 4 follow its renderer's construction. No code was used.
8. QGIS LOOM Transit Map Generator. Transport for Cairo, 2026. GPL-3.0.
   https://github.com/transportforcairo/loom_qgis
   A QGIS front end for LOOM, reviewed for how the pipeline is used in
   practice and which parameters it exposes.

Further reading: Wu, Niedermann, Takahashi, Roberts, Nöllenburg. A Survey
on Transit Map Layout. Computer Graphics Forum 39(3), 2020.
https://doi.org/10.1111/cgf.14030
