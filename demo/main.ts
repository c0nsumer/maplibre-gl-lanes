import 'maplibre-gl/dist/maplibre-gl.css';
import * as maplibregl from 'maplibre-gl';
import {Protocol} from 'pmtiles';
import {layers, namedFlavor} from '@protomaps/basemaps';
import type {FeatureCollection, Feature} from 'geojson';
import {buildLineGraph, filterGraph, orderLanesAsync, snapshotLaneOrders, seedFromSnapshot, LaneLayer, type LineGraph, type SizesAtZoom} from 'maplibre-gl-lanes';
// Not part of the package: the native line-offset baseline needs a lane's
// offset, and the console probes need the worker's transfer form.
import {laneOffset} from '../src/core/layout';
import {toTransfer} from '../src/core/serialize';

// A hidden tab (remote Safari automation) never fires requestAnimationFrame,
// which MapLibre needs to load its style: drive frames with a timer instead.
if (document.hidden || new URLSearchParams(location.search).get('raf') === 'timer') {
    const nativeRaf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb: FrameRequestCallback) => (document.hidden ? (setTimeout(() => cb(performance.now()), 16) as unknown as number) : nativeRaf(cb));
}

const protocol = new Protocol();
maplibregl.addProtocol('pmtiles', protocol.tile);

const params = new URLSearchParams(location.search);
// Fixtures from test/fixtures: ramba (default), mfo, example. The basemap covers RAMBA only.
const dataset = params.get('data') ?? 'ramba';
const startZoom = parseFloat(params.get('z') ?? (dataset === 'ramba' ? '14.5' : '13'));
const startLat = parseFloat(params.get('lat') ?? (dataset === 'ramba' ? '46.4972' : 'NaN'));
const startLon = parseFloat(params.get('lon') ?? (dataset === 'ramba' ? '-87.6408' : 'NaN'));
const mode = params.get('mode') ?? 'lanes';
const showBasemap = params.get('basemap') !== '0';

// Spacing exceeds the fill width by 1 px, leaving a 1 px casing seam
// between adjacent lanes.
const styleAt: SizesAtZoom = (z: number) => {
    const width = z <= 10 ? 2 : z >= 18 ? 7 : z <= 14 ? 2 + ((z - 10) / 4) * 2 : 4 + ((z - 14) / 4) * 3;
    return {spacing: width + 1, width, casingWidth: 1};
};

const map = new maplibregl.Map({
    container: 'map',
    style: {
        version: 8,
        glyphs: 'https://protomaps.github.io/basemaps-assets/fonts/{fontstack}/{range}.pbf',
        sprite: 'https://protomaps.github.io/basemaps-assets/sprites/v4/light',
        sources: {
            // BASE_URL is '/' in development and the repository path on GitHub Pages.
            basemap: {type: 'vector', url: `pmtiles://${import.meta.env.BASE_URL}ramba-basemap.pmtiles`, attribution: '© OpenStreetMap contributors (ODbL) © Protomaps'},
        },
        layers: [
            {id: 'bg', type: 'background', paint: {'background-color': '#eeeeea'}},
            ...(showBasemap ? layers('basemap', namedFlavor('light'), {lang: 'en'}) : []),
        ],
    },
    center: [Number.isFinite(startLon) ? startLon : 0, Number.isFinite(startLat) ? startLat : 0],
    zoom: startZoom,
    maxZoom: 20,
    hash: false,
    canvasContextAttributes: {preserveDrawingBuffer: true},
});
(window as any).map = map;
if (params.get('globe') === '1') map.on('style.load', () => map.setProjection({type: 'globe'}));
(window as any).__errs = [];
map.on('error', (e: any) => (window as any).__errs.push(String(e?.error?.message ?? e?.error ?? e)));
window.addEventListener('error', (e) => (window as any).__errs.push(`window: ${e.message}`));
window.addEventListener('unhandledrejection', (e: any) => (window as any).__errs.push(`promise: ${e.reason?.message ?? e.reason}`));
// Posts the canvas to the dev server's shot sink (see vite.config.ts).
(window as any).snap = async (name: string) => {
    map.redraw();
    const blob: Blob = await new Promise((r) => map.getCanvas().toBlob((b) => r(b!), 'image/png'));
    await fetch(`/__shot?name=${encodeURIComponent(name)}`, {method: 'POST', body: blob});
    return `${name}: ${blob.size} bytes`;
};

async function main() {
    const fc = await (await fetch(`${import.meta.env.BASE_URL}${dataset}.geojson`)).json();
    if (!Number.isFinite(startLat)) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const f of fc.features) for (const c of f.geometry.coordinates) {
            minX = Math.min(minX, c[0]); maxX = Math.max(maxX, c[0]); minY = Math.min(minY, c[1]); maxY = Math.max(maxY, c[1]);
        }
        map.fitBounds([[minX, minY], [maxX, maxY]], {padding: 40, duration: 0});
        if (params.get('z')) map.setZoom(startZoom);
    }
    const routesMeta: Record<string, {color: string; name: string; dash?: [number, number]; dashColor?: string; dashCap?: 'butt' | 'round' | 'square'; casing?: boolean}> = {};
    for (const f of fc.features) {
        const p = f.properties;
        routesMeta[String(p.route_id)] = {color: p.route_colour || '#808080', name: p.route_name};
    }
    // Dashed RAMBA relations, to exercise dashes and dots.
    Object.assign(routesMeta['13213211'] ?? {}, {dash: [0, 2] as [number, number]});
    // Dashes take `color`, gaps take `dashColor`.
    Object.assign(routesMeta['15258749'] ?? {}, {color: 'red', dash: [2, 2] as [number, number], dashColor: 'silver', dashCap: 'round' as const});
    Object.assign(routesMeta['15258750'] ?? {}, {color: 'navy', dash: [2, 1] as [number, number], dashColor: 'silver', dashCap: 'square' as const});
    Object.assign(routesMeta['15260960'] ?? {}, {color: 'gray', dash: [1, 1] as [number, number], dashColor: 'yellow'});
    // Summer mode (default) hides the winter-only relations; ?season=winter shows everything.
    const winterOnly = new Set(['15258749', '15258750', '15260960', '12426672']);
    const season = params.get('season') ?? 'summer';
    const seasonFeatures = fc.features.filter((f: any) => season === 'winter' || !winterOnly.has(String(f.properties.route_id)));

    const full = buildLineGraph(seasonFeatures, {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name', routes: routesMeta, uniformProperties: ['oneway', 'trail_name']});
    (window as any).lanes = {orderLanesAsync, toTransfer, full};
    const t0 = performance.now();
    const cost = await orderLanesAsync(full, {stabilize: params.get('stable') === '0' ? false : {}});
    const orderMs = performance.now() - t0;

    const panel = document.getElementById('routes')!;
    const visible = new Set<string>(full.routes.keys());
    for (const [id, meta] of full.routes) {
        const l = document.createElement('label');
        l.innerHTML = `<input type="checkbox" checked data-route="${id}" /> <span style="display:inline-block;width:10px;height:10px;background:${meta.color};border:1px solid #333"></span> ${meta.name ?? id}`;
        panel.appendChild(l);
    }

    let graph: LineGraph = full;
    // ?color=trail colors each edge by its trail name, exercising per-edge
    // styling; an unnamed edge is dashed, like an unrated difficulty grade.
    const trailPalette = ['#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d', '#666666'];
    const byTrail = (edge: {properties?: Record<string, unknown>}) => {
        const name = String(edge.properties?.trail_name ?? '');
        if (!name) return {color: '#9a9a9a', dash: [2, 2] as [number, number], dashCap: 'butt' as const};
        let h = 0;
        for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
        return {color: trailPalette[h % trailPalette.length]};
    };
    const layer = new LaneLayer({id: 'lanes', graph, sizes: styleAt, casingColor: '#2a2a2a', smooth: params.get('smooth') !== '0', cull: params.get('cull') !== '0', worker: params.get('worker') !== '0', laneStyle: params.get('color') === 'trail' ? byTrail : undefined});

    const stats = document.getElementById('stats')!;
    const where = params.get('worker') !== '0' ? 'worker' : 'render thread';
    const updateStats = () => {
        // getBuildInfo, not getLayout: this runs every frame, and getLayout
        // turns a worker build into paths.
        const lay = layer.getBuildInfo();
        stats.textContent =
            `nodes ${graph.nodes.length} edges ${graph.edges.length}\n` +
            `order cost ${cost} (${orderMs.toFixed(0)} ms)\n` +
            (lay ? `layout z${lay.zoom.toFixed(2)} ${lay.stats.vertices} verts, ${lay.stats.edgesBuilt}/${lay.stats.edges} edges\n` +
                `build in the ${where}: ${lay.timings.layoutMs.toFixed(1)} ms layout, ${lay.timings.meshMs.toFixed(1)} ms mesh, ${lay.timings.renderThreadMs.toFixed(1)} ms on the render thread` : '');
    };

    async function applyVisibility() {
        const seed = snapshotLaneOrders(graph);
        graph = filterGraph(full, (r: string) => visible.has(r));
        await orderLanesAsync(graph, {stabilize: params.get('stable') === '0' ? false : {}, seed});
        const prev = seedFromSnapshot(graph, seed);
        let kept = 0;
        for (const e of graph.edges) if (prev.get(e.id)?.join() === e.order.join()) kept++;
        console.log(`toggle: ${kept}/${graph.edges.length} edges kept their lane order`);
        (window as any).__lastToggle = {kept, edges: graph.edges.length};
        layer.setGraph(graph);
        updateNative();
        updateStats();
    }
    panel.addEventListener('change', (ev) => {
        const t = ev.target as HTMLInputElement;
        if (!t.dataset.route) return;
        if (t.checked) visible.add(t.dataset.route);
        else visible.delete(t.dataset.route);
        applyVisibility();
    });

    // Baseline for comparison: native line layers with a data-driven
    // line-offset, one feature per (edge, route), at the same lane offsets.
    function nativeGeoJSON(): FeatureCollection {
        const features: Feature[] = [];
        for (const e of graph.edges) {
            const coords: [number, number][] = [];
            for (let i = 0; i < e.coords.length; i += 2) {
                const x = e.coords[i], y = e.coords[i + 1];
                const lng = x * 360 - 180;
                const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
                coords.push([lng, lat]);
            }
            for (const r of e.routes) {
                // MapLibre: positive line-offset = right of travel; ours: positive = left.
                const lanes = -laneOffset(e, r, 1);
                features.push({type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties: {route: r, color: graph.routes.get(r)!.color, lanes}});
            }
        }
        return {type: 'FeatureCollection', features};
    }
    const spacingExpr = (z: number) => styleAt(z).spacing;
    const widthExpr = (z: number) => styleAt(z).width;
    const zoomInterp = (f: (z: number) => number, mul: any = null): any => {
        const stops: any[] = [];
        for (const z of [10, 12, 14, 16, 18]) stops.push(z, mul ? ['*', mul, f(z)] : f(z));
        return ['interpolate', ['linear'], ['zoom'], ...stops];
    };
    function updateNative() {
        const src = map.getSource('native-lanes') as maplibregl.GeoJSONSource | undefined;
        if (src) src.setData(nativeGeoJSON());
    }

    const onLoad = () => {
        map.addSource('native-lanes', {type: 'geojson', data: nativeGeoJSON(), attribution: 'Routes © OpenStreetMap contributors (ODbL), via trailmaps.app'});
        const vis = mode === 'native' ? 'visible' : 'none';
        map.addLayer({
            id: 'native-casing', type: 'line', source: 'native-lanes',
            layout: {'line-join': 'round', 'line-cap': 'round', visibility: vis},
            paint: {'line-color': '#2a2a2a', 'line-width': zoomInterp((z) => widthExpr(z) + 2), 'line-offset': zoomInterp(spacingExpr, ['get', 'lanes'])},
        });
        map.addLayer({
            id: 'native-fill', type: 'line', source: 'native-lanes',
            layout: {'line-join': 'round', 'line-cap': 'round', visibility: vis},
            paint: {'line-color': ['get', 'color'], 'line-width': zoomInterp(widthExpr), 'line-offset': zoomInterp(spacingExpr, ['get', 'lanes'])},
        });
        map.addLayer(layer as any);
        // Labels follow the lanes through a GeoJSON source refreshed after each build.
        map.addSource('lane-labels', {type: 'geojson', data: {type: 'FeatureCollection', features: []}});
        map.addLayer({
            id: 'lane-labels', type: 'symbol', source: 'lane-labels',
            minzoom: 15,
            layout: {'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 11, 'symbol-spacing': 400, 'text-max-angle': 25},
            paint: {'text-color': '#111', 'text-halo-color': 'rgba(255,255,255,0.9)', 'text-halo-width': 1.5},
        });
        // Lane features run in the direction of travel, so a line-placed
        // chevron points the right way; two-way pieces carry direction 0.
        map.addLayer({
            id: 'lane-chevrons', type: 'symbol', source: 'lane-labels',
            minzoom: 14,
            filter: ['==', ['get', 'direction'], 1],
            layout: {'symbol-placement': 'line', 'text-field': '\u203a', 'text-font': ['Noto Sans Regular'], 'text-size': 16, 'symbol-spacing': 90, 'text-keep-upright': false, 'text-allow-overlap': true, 'text-offset': [0, -0.15]},
            paint: {'text-color': '#ffffff', 'text-halo-color': 'rgba(0,0,0,0.6)', 'text-halo-width': 0.8},
        });
        // moveend covers moves too small to rebuild; setOnBuild covers a
        // worker build that lands after the map stopped.
        const refreshLabels = () => (map.getSource('lane-labels') as maplibregl.GeoJSONSource).setData(layer.laneFeatures());
        layer.setOnBuild(() => map.isMoving() || refreshLabels());
        map.on('moveend', refreshLabels);
        if (mode === 'native') map.setLayoutProperty('lanes', 'visibility', 'none');
        (document.querySelector(`input[name=mode][value=${mode}]`) as HTMLInputElement).checked = true;
        map.on('render', updateStats);
        // Click a lane to see its route and lift it; click elsewhere to clear.
        const popup = new maplibregl.Popup({closeButton: false, closeOnClick: true});
        (window as any).laneLayer = layer;
        map.on('click', (ev) => {
            const hit = layer.queryLane(ev.point, 8);
            if (hit) {
                const others = hit.routes.filter((r) => r !== hit.route).map((r) => full.routes.get(r)?.name ?? r);
                const trail = typeof hit.properties.trail_name === 'string' && hit.properties.trail_name ? `<br><small>${hit.properties.trail_name}</small>` : '';
                popup.setLngLat(hit.lngLat).setHTML(`<b>${hit.name ?? hit.route}</b>${trail}${others.length ? `<br><small>shares this path with ${others.join(', ')}</small>` : ''}<br><small>${hit.distancePx.toFixed(1)} px from lane</small>`).addTo(map);
            }
            else popup.remove();
            // Shift-click lifts every route on the path, such as a road that
            // several relations share.
            const lift = !hit ? null : ev.originalEvent.shiftKey ? hit.routes : hit.route;
            layer.setHighlight(lift, {dim: 0.6, haloWidth: (z) => (z <= 12 ? 3 : z >= 18 ? 9 : 3 + (z - 12)) });
        });
        map.on('mousemove', (ev) => {
            map.getCanvas().style.cursor = layer.queryLane(ev.point, 8) ? 'pointer' : '';
        });
    };
    // Ordering ran in a worker, so the map may already have loaded.
    if (map.loaded()) onLoad();
    else map.once('load', onLoad);

    document.querySelectorAll('input[name=mode]').forEach((el) =>
        el.addEventListener('change', (ev) => {
            const v = (ev.target as HTMLInputElement).value;
            map.setLayoutProperty('lanes', 'visibility', v === 'lanes' ? 'visible' : 'none');
            for (const id of ['native-casing', 'native-fill']) map.setLayoutProperty(id, 'visibility', v === 'native' ? 'visible' : 'none');
        }));
    (document.getElementById('basemap') as HTMLInputElement).addEventListener('change', (ev) => {
        const on = (ev.target as HTMLInputElement).checked;
        for (const l of map.getStyle().layers) {
            if (l.id === 'bg' || l.id.startsWith('native') || l.id === 'lanes') continue;
            map.setLayoutProperty(l.id, 'visibility', on ? 'visible' : 'none');
        }
    });
}
main();
