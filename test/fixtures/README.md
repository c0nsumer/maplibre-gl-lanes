# Test fixtures

`ramba.src.geojson`, `mfo.src.geojson` and `example.src.geojson` are trail
route networks exported from OpenStreetMap by the trailmaps.app map
generator. The data is © OpenStreetMap contributors and is licensed under the
Open Database License (ODbL), https://www.openstreetmap.org/copyright.

Each feature is one run of path used by one route (`route_id`), with the
routes that share that run listed in `shared_routes`. The plugin only needs
`route_id`; it detects shared paths from the coordinates.
