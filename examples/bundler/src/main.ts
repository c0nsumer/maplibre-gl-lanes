// The smallest app that draws lanes: build a graph, order it, add the layer.
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import {buildLineGraph, orderLanesAsync, LaneLayer} from 'maplibre-gl-lanes';

// Your app ships its own data; this is the repository's test fixture, and
// `?url` asks the bundler for its served address.
import routesUrl from '../../../test/fixtures/example.src.geojson?url';

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        sources: {},
        layers: [{id: 'bg', type: 'background', paint: {'background-color': '#eeeeea'}}],
    },
    center: [-83.1625, 42.8046],
    zoom: 15,
});

map.on('load', async () => {
    const data = await (await fetch(routesUrl)).json();

    // One feature per run of path, with the route id in a property.
    // Routes that share a path must share its vertex coordinates exactly.
    const graph = buildLineGraph(data.features, {
        routeProperty: 'route_id',
        colorProperty: 'route_colour',
        nameProperty: 'route_name',
    });

    // Decides each edge's left-to-right lane order, in a worker.
    await orderLanesAsync(graph);

    map.addLayer(new LaneLayer({
        id: 'routes',
        graph,
        // Screen pixels, per zoom: lanes can thin out zoomed out and widen
        // close in.
        sizes: (zoom) => {
            const width = zoom <= 12 ? 3 : zoom >= 17 ? 8 : 3 + ((zoom - 12) / 5) * 5;
            return {spacing: width + 1, width, casingWidth: 1};
        },
        casingColor: '#2a2a2a',
    }));
});
