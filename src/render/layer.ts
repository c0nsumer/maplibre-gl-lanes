/**
 * MapLibre custom layer that draws the lane mesh. Width and anti-aliasing
 * are applied in the shaders, as in MapLibre's line layer.
 */

import type {CustomLayerInterface, CustomRenderMethodInput} from 'maplibre-gl';
import type GeoJSON from 'geojson';
import type {LaneAppearance, LineGraph} from '../core/graph.js';
import {checkedSizes, requireSizesFunction, layoutAtZoom, LayoutCache, type LaneLook, type LanePath, type LaneStyle, type Layout, type SizesAtZoom} from '../core/layout.js';
import {lngLatToMercator, mercatorToLngLat} from '../core/graph.js';
import {toTransfer, unpackPaths} from '../core/serialize.js';
import {nextRequestId, sendToWorker} from '../core/worker-client.js';
import type {LayoutRequest, LayoutResponse} from '../worker/lanes.worker.js';
import type {Bounds} from '../core/geometry.js';
import {tessellate, parseColor, splitRanges, TessellateCache, FLOATS_PER_VERTEX, type Mesh} from './tessellate.js';

// Comments stay out of the shader strings, which ship as written.

/**
 * MapLibre's projection prelude, prepended at compile time, provides `projectTile` and
 * `projectLineThickness`. The delta is in pixels, so spacing is exact even when the mesh was
 * built for another zoom.
 */
const VERTEX_SHADER_BODY = `
in vec2 a_anchor;
in vec2 a_delta;
in vec2 a_extrude;
in vec2 a_normal;
in float a_along;
in vec4 a_color;
uniform float u_units_per_px;
uniform float u_outset;
out vec2 v_normal;
out vec4 v_color;
out float v_along;
out float v_depth;
void main() {
    v_along = a_along;
    float thickness = projectLineThickness(a_anchor.y);
    vec2 p = a_anchor + (a_delta + a_extrude * u_outset) * (u_units_per_px * thickness);
    gl_Position = projectTile(p);
    v_depth = gl_Position.z / gl_Position.w;
    v_normal = a_normal;
    v_color = a_color;
}`;

/**
 * - `u_override`: rgba; a < 0 means use the vertex color.
 * - `u_dash`: dash and gap length, px at the layout zoom; y <= 0 disables, x == 0 draws round dots.
 * - `u_cap`: dash ends, 0 butt or square, 1 round. Round caps reach into the gap, so a neighbor
 *   period's cap may be the nearest.
 * - `u_along_scale`: layout pixels to screen pixels, for the distance along the line.
 * - `u_cover`: which fragments are kept, by coverage (see `COVER_ALL` and the rest).
 */
const FRAGMENT_SHADER_BODY = `
in vec2 v_normal;
in vec4 v_color;
in float v_along;
in float v_depth;
uniform float u_outset;
uniform float u_blur;
uniform vec4 u_override;
uniform float u_opacity;
uniform vec2 u_dash;
uniform float u_cap;
uniform float u_along_scale;
uniform float u_cover;
out vec4 fragColor;
void main() {
#ifdef GLOBE
    if (v_depth > 1.0) discard;
#endif
    float dist = length(v_normal) * u_outset;
    float alpha = clamp((u_outset - dist) / u_blur, 0.0, 1.0);
    if (u_dash.y > 0.0) {
        if (u_dash.x > 0.0) {
            float period = u_dash.x + u_dash.y;
            float t = mod(v_along, period);
            if (u_cap < 0.5) {
                float edge = min(t, u_dash.x - t) * u_along_scale;
                alpha *= clamp(edge / u_blur + 0.5, 0.0, 1.0);
            } else {
                float r = u_outset - 0.5 * u_blur;
                float best = 1e9;
                for (int k = -1; k <= 1; k++) {
                    float tk = t - float(k) * period;
                    float c = clamp(tk, 0.0, u_dash.x);
                    best = min(best, length(vec2((tk - c) * u_along_scale, dist)) - r);
                }
                alpha *= clamp(-best / u_blur + 0.5, 0.0, 1.0);
            }
        } else {
            float period = u_dash.y;
            float t = mod(v_along, period) - period * 0.5;
            float r = u_outset - 0.5 * u_blur;
            float d = length(vec2(t * u_along_scale, dist));
            alpha = clamp((r - d) / u_blur + 0.5, 0.0, 1.0);
        }
    }
    if (u_cover > 0.5) {
        if (u_cover < 1.5) {
            if (alpha < 1.0) discard;
        } else if (u_cover < 2.5) {
            if (alpha <= 0.0 || alpha >= 1.0) discard;
        } else if (alpha < 0.5) discard;
    }
    vec4 c = u_override.a < 0.0 ? v_color : u_override;
    fragColor = vec4(c.rgb, 1.0) * (c.a * alpha * u_opacity);
}`;

/**
 * A translucent casing is blended once through a per-pixel "casing showing"
 * mark that a casing sets and tests and a fill clears (docs/algorithms.md,
 * Rendering). The mark lives in the depth buffer, never the stencil buffer:
 * MapLibre reuses its tile clipping masks there across layers. Both values
 * sit at or beyond MapLibre's farthest layer depth, so later layers pass
 * over them. Clearing writes a farther value over a nearer one, so the
 * depth of opaque fills above this layer is lost under the lanes. Only full
 * coverage sets the mark; marking soft edges leaves pale threads.
 */
const DEPTH_CLEAR = 1;
const DEPTH_MARK = 1 - 1 / (1 << 17);
/** Two depth values a hair apart need more than the 16 bits some buffers have. */
const MIN_DEPTH_BITS = 24;
/** Values of `u_cover`: which fragments a draw keeps, by pixel coverage. */
const COVER_ALL = 0;
const COVER_FULL = 1;
const COVER_PARTIAL = 2;
const COVER_HALF = 3;

export interface LaneLayerOptions {
    id: string;
    graph: LineGraph;
    /**
     * Sizes per zoom, in px: lane spacing, fill width and casing width.
     * Color and dashes are the route's own, or `laneStyle`'s.
     */
    sizes: SizesAtZoom;
    /** Casing color (CSS). Default '#333'. Alpha is honored; null skips the casing pass. */
    casingColor?: string | null;
    /** Opacity of the whole layer, 0 to 1. Default 1. See `setOpacity`. */
    opacity?: number;
    /** Re-layout when the zoom moves out by more than this, or in by twice it. Default 0.25. */
    zoomEpsilon?: number;
    /** Smooth centerlines with a spline. Default true. */
    smooth?: boolean;
    /** Open folds tighter than the bundle is wide (see `LayoutOptions.openFolds`). Default true. */
    openFolds?: boolean;
    /**
     * Style lanes per edge and route (see `LayoutOptions.laneStyle`); a
     * field left out keeps the route's own. It is read only when set and
     * when the graph is replaced, so keep it pure and call `setLaneStyle`
     * to have it read again.
     */
    laneStyle?: LaneStyle;
    /** Only lay out what is near the viewport. Default true. */
    cull?: boolean;
    /** With `cull`: margin beyond the viewport, in viewport widths and heights. Default 0.5. */
    cullMargin?: number;
    /**
     * Build in a worker when the browser has one. Default true. False
     * builds inside the render call, so the lanes are drawn by `idle`,
     * which suits headless screenshots and tests.
     */
    worker?: boolean;
    /** Called after every finished build (see `setOnBuild`). */
    onBuild?: (info: LaneBuildInfo) => void;
}

/** What one finished build covers (see `LaneLayer.getBuildInfo`). */
export interface LaneBuildInfo {
    /** Counts the layer's finished builds, from 1. */
    readonly build: number;
    /** The zoom the mesh was built for. */
    readonly zoom: number;
    /** The Mercator bounds it was culled to, or null when it covers everything. */
    readonly bounds: Bounds | null;
    readonly stats: Layout['stats'];
    /** What the build cost, ms. `renderThreadMs` is only the upload after a worker build. */
    readonly timings: {layoutMs: number; meshMs: number; renderThreadMs: number};
}

export interface LaneFeatureOptions {
    /** Zoom the lane positions are computed for. Default: the map's current zoom, else the last build's. */
    zoom?: number;
    /** Only these routes. Default: every route. */
    routes?: Iterable<string>;
    /**
     * 'built' (default): the last build's lanes, culled around the viewport.
     * 'full': every lane of the graph, laid out for `zoom`, cached per zoom
     * and routes.
     */
    extent?: 'built' | 'full';
}

/** A width in pixels, or a width per zoom. */
export type HighlightWidth = number | ((zoom: number) => number);

export interface HighlightStyle {
    /** Halo around the highlighted lanes (CSS color). Default '#ffb700'; null draws none. */
    halo?: string | null;
    /**
     * Halo width beyond the outline, px per side. Default 4. The halo covers
     * any lane within `width / 2 + casingWidth + outlineWidth + haloWidth`
     * of the lane's center; a reach wider than `spacing` hides neighbors.
     */
    haloWidth?: HighlightWidth;
    /** Width of the halo's soft outer edge, px. Default 3. */
    haloBlur?: HighlightWidth;
    /** Outline between the halo and the lane (CSS color). Default '#000'; null draws none. */
    outline?: string | null;
    /** Outline width beyond the casing, px per side. Default 1.5. */
    outlineWidth?: HighlightWidth;
    /** Opacity factor for the routes that are not highlighted. Default 1 (unchanged). */
    dim?: number;
    /**
     * Graph edges whose lanes keep full opacity under `dim`, though their
     * routes are not highlighted. They get no halo and no outline, and stay
     * where they are in the drawing order. Default none.
     */
    bright?: Iterable<number>;
}

interface ResolvedHighlight {
    halo: Float32Array | null;
    haloWidth: HighlightWidth;
    haloBlur: HighlightWidth;
    outline: Float32Array | null;
    outlineWidth: HighlightWidth;
    dim: number;
    bright: Set<number>;
}

/** Per group of a run, the index ranges drawn dimmed and bright, ribbon and dots. */
interface RunSplit {
    dimmed: [number, number][];
    bright: [number, number][];
    dotsDimmed: [number, number][];
    dotsBright: [number, number][];
}

function widthAt(w: HighlightWidth, zoom: number): number {
    return typeof w === 'function' ? w(zoom) : w;
}

/** The render arguments common to MapLibre 5.x (no `getProjectionData`) and 6.x. */
export interface LaneRenderArgs {
    shaderData: CustomRenderMethodInput['shaderData'];
    getProjectionData?: CustomRenderMethodInput['getProjectionData'];
}

/** A WebGL context as either MapLibre version hands it to a custom layer; the layer needs WebGL2. */
export type AnyGlContext = WebGLRenderingContext | WebGL2RenderingContext;

/** What the layer uses of the map, structural so a MapLibre 5.x or 6.x `Map` fits. */
export interface LaneMap {
    getZoom(): number;
    getPixelRatio(): number;
    triggerRepaint(): void;
    getTerrain(): unknown;
    getBounds(): {getWest(): number; getSouth(): number; getEast(): number; getNorth(): number};
    unproject(point: [number, number] | {x: number; y: number}): {lng: number; lat: number};
}

export interface LaneHit {
    /** The route whose lane is nearest. */
    readonly route: string;
    readonly name?: string;
    readonly distancePx: number;
    /** The nearest point on that lane, for anchoring a popup on the lane itself. */
    readonly lngLat: [number, number];
    /** Whether the nearest piece is an edge's lane or a connector across a node. */
    readonly kind: 'lane' | 'connector';
    /** The graph edge (for a connector, the edge it arrives from). */
    readonly edge: number;
    /** Every route on that edge, in lane order from left to right traveling a-to-b. */
    readonly routes: string[];
    /** The edge's `uniformProperties` values, if the graph was built with any. */
    readonly properties: Record<string, unknown>;
}

export class LaneLayer implements CustomLayerInterface {
    readonly id: string;
    readonly type = 'custom' as const;
    readonly renderingMode = '2d' as const;

    private map: LaneMap | null = null;
    private gl: WebGL2RenderingContext | null = null;
    private canMark = false;
    /** Per projection variant; null for one that failed to build, so it is not tried every frame. */
    private programs = new Map<string, {program: WebGLProgram; vao: WebGLVertexArrayObject; uniforms: Record<string, WebGLUniformLocation | null>} | null>();
    private vbo: WebGLBuffer | null = null;
    private cbo: WebGLBuffer | null = null;
    private ibo: WebGLBuffer | null = null;
    private mesh: Mesh | null = null;
    /** Materialized from `packed` on demand. */
    private layout: Layout | null = null;
    /** A worker's answer, kept as typed arrays until something asks for paths. */
    private packed: LayoutResponse | null = null;
    private built: {zoom: number; bounds: Bounds | null} | null = null;
    private inFlight: {id: number} | null = null;
    private session = nextSession++;
    private sentGraph = false;
    private looksDirty = true;
    private layoutCache = new LayoutCache();
    private meshCache = new TessellateCache();
    /**
     * The smallest tile containing the whole graph. Anchors are in its local
     * units, so float32 keeps sub-pixel precision at high zoom.
     */
    private tile = {z: 0, x: 0, y: 0};
    private origin: [number, number] = [0, 0];
    private unitsPerMercator = EXTENT;
    private dirty = true;
    private graph: LineGraph;
    private sizes: SizesAtZoom;
    private casing: Float32Array | null;
    private opacity: number;
    private zoomEpsilon: number;
    private smooth: boolean;
    private openFolds: boolean;
    private laneStyle: LaneStyle | null;
    private cull: boolean;
    private cullMargin: number;
    private useWorker: boolean;
    private onBuild: ((info: LaneBuildInfo) => void) | null;
    private builds = 0;
    private fullFeatures: {graph: LineGraph; key: string; fc: GeoJSON.FeatureCollection} | null = null;
    /** By cache key, so repeat calls share one request. */
    private fullPending = new Map<string, Promise<GeoJSON.FeatureCollection>>();
    private highlight: string[] = [];
    private highlightStyle: ResolvedHighlight | null = null;
    /** Each group's bright split, kept until the mesh or the highlight changes. */
    private brightSplit: {mesh: Mesh; style: ResolvedHighlight; groups: (RunSplit | null)[]} | null = null;
    private timings = {layoutMs: 0, meshMs: 0, renderThreadMs: 0};

    constructor(opts: LaneLayerOptions) {
        this.id = opts.id;
        this.graph = opts.graph;
        // Refused here so a bad option does not surface inside MapLibre's render loop.
        if (!opts.graph || !Array.isArray(opts.graph.edges)) throw new TypeError('maplibre-gl-lanes: `graph` must be a line graph from `buildLineGraph`');
        requireSizesFunction(opts.sizes);
        this.sizes = opts.sizes;
        this.opacity = Math.max(0, Math.min(1, opts.opacity ?? 1));
        this.zoomEpsilon = opts.zoomEpsilon ?? 0.25;
        this.smooth = opts.smooth ?? true;
        this.openFolds = opts.openFolds ?? true;
        this.laneStyle = opts.laneStyle ?? null;
        this.cull = opts.cull ?? true;
        this.cullMargin = opts.cullMargin ?? 0.5;
        this.useWorker = opts.worker ?? true;
        this.onBuild = opts.onBuild ?? null;
        const casingCss = opts.casingColor === undefined ? '#333333' : opts.casingColor;
        this.casing = casingCss === null ? null : rgba(parseColor(casingCss));
        this.computeOrigin();
    }

    /** Replace the graph (e.g. after re-ordering or filtering routes). */
    setGraph(graph: LineGraph): void {
        this.graph = graph;
        this.layoutCache.clear();
        this.meshCache.clear();
        this.fullFeatures = null;
        this.fullPending.clear();
        this.closeSession();
        this.session = nextSession++;
        this.sentGraph = false;
        this.looksDirty = true;
        this.computeOrigin();
        this.dirty = true;
        this.map?.triggerRepaint();
    }

    /** Change the sizes per zoom (see `LaneLayerOptions.sizes`). */
    setSizes(sizes: SizesAtZoom): void {
        requireSizesFunction(sizes);
        this.sizes = sizes;
        this.fullFeatures = null;
        this.fullPending.clear();
        this.dirty = true;
        this.map?.triggerRepaint();
    }

    /** Change or remove the per-edge styling (see `LaneLayerOptions.laneStyle`). */
    setLaneStyle(laneStyle: LaneStyle | null): void {
        this.laneStyle = laneStyle;
        this.fullFeatures = null;
        this.fullPending.clear();
        this.looksDirty = true;
        this.dirty = true;
        this.map?.triggerRepaint();
    }

    /** Change the opacity of the whole layer, 0 to 1, without a rebuild. */
    setOpacity(opacity: number): void {
        this.opacity = Math.max(0, Math.min(1, opacity));
        this.map?.triggerRepaint();
    }

    /** Change the casing color (see `LaneLayerOptions.casingColor`); null removes the casing. */
    setCasingColor(css: string | null): void {
        this.casing = css === null ? null : rgba(parseColor(css));
        this.map?.triggerRepaint();
    }

    /**
     * Lift one route, or several: their lanes are drawn last, with a halo
     * and an outline, and the rest can be dimmed. It draws inside this
     * layer, so layers above it cover it. Pass null, or an empty list, to
     * clear.
     */
    setHighlight(route: string | string[] | null, style: HighlightStyle = {}): void {
        this.highlight = route === null ? [] : typeof route === 'string' ? [route] : [...route];
        this.highlightStyle = this.highlight.length === 0 ? null : {
            halo: style.halo === null ? null : rgba(parseColor(style.halo ?? '#ffb700')),
            haloWidth: style.haloWidth ?? 4,
            haloBlur: style.haloBlur ?? 3,
            outline: style.outline === null ? null : rgba(parseColor(style.outline ?? '#000000')),
            outlineWidth: style.outlineWidth ?? 1.5,
            dim: style.dim ?? 1,
            bright: new Set(style.bright ?? []),
        };
        this.map?.triggerRepaint();
    }

    /** The highlighted routes, in the order they were given; empty when none. */
    getHighlight(): string[] {
        return [...this.highlight];
    }

    /**
     * What the last build covers, without its geometry. Cheap enough to call
     * every frame, unlike `getLayout`.
     */
    getBuildInfo(): LaneBuildInfo | null {
        const l = this.layout ?? this.packed;
        return l ? {build: this.builds, zoom: l.zoom, bounds: l.bounds, stats: l.stats, timings: this.timings} : null;
    }

    /**
     * Listen for finished builds; refresh sources derived from
     * `laneFeatures` here, not on `idle`, which can arrive before a worker
     * build. One listener, which this replaces; null clears it.
     */
    setOnBuild(listener: ((info: LaneBuildInfo) => void) | null): void {
        this.onBuild = listener;
    }

    /**
     * The lane geometry of the last build, in world pixels at `layout.zoom`.
     * The first call after a worker build unpacks it, so do not call it
     * every frame.
     */
    getLayout(): Layout | null {
        if (this.layout) return this.layout;
        const p = this.packed;
        if (!p) return null;
        this.layout = {
            zoom: p.zoom, scale: p.scale, paths: unpackPaths(p.paths), drawOrder: p.drawOrder,
            bounds: p.bounds, mergedEdges: p.mergedEdges, stats: p.stats,
        };
        return this.layout;
    }

    /**
     * Lane geometry as GeoJSON LineStrings, one per lane piece, with
     * properties `route`, `name`, `color`, `direction`, `kind`, `edge`,
     * `lanes`, `routes` and the graph's `uniformProperties` (see
     * docs/api.md). Lane positions depend on the zoom and on the build,
     * so refresh on `moveend` and from `setOnBuild`.
     */
    laneFeatures(opts: LaneFeatureOptions = {}): GeoJSON.FeatureCollection {
        if (opts.extent === 'full') return this.fullLaneFeatures(opts);
        const layout = this.getLayout();
        const features: GeoJSON.Feature[] = [];
        if (!layout) return {type: 'FeatureCollection', features};
        const z = opts.zoom ?? this.map?.getZoom() ?? layout.zoom;
        const only = opts.routes ? new Set(opts.routes) : null;
        const {scale} = layout;
        const nowScale = 512 * Math.pow(2, z);
        for (const p of layout.paths) {
            if (only && !only.has(p.route)) continue;
            const coords: [number, number][] = [];
            for (let i = 0; i < p.coords.length; i += 2) {
                const x = (p.anchors[i] + (p.coords[i] - p.anchors[i]) * (scale / nowScale)) / scale;
                const y = (p.anchors[i + 1] + (p.coords[i + 1] - p.anchors[i + 1]) * (scale / nowScale)) / scale;
                coords.push([x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI]);
            }
            if (coords.length < 2) continue;
            features.push(this.laneFeature(p, coords));
        }
        return {type: 'FeatureCollection', features};
    }

    /**
     * `laneFeatures` with `extent: 'full'` laid out in the worker. Without a
     * worker, or for the built extent, it resolves with `laneFeatures`.
     */
    laneFeaturesAsync(opts: LaneFeatureOptions = {}): Promise<GeoJSON.FeatureCollection> {
        if (opts.extent !== 'full' || !this.useWorker) return Promise.resolve(this.laneFeatures(opts));
        const z = opts.zoom ?? this.map?.getZoom() ?? this.built?.zoom ?? 0;
        const routes = opts.routes ? [...opts.routes].sort() : null;
        const key = `${z}|${routes ? routes.join('\0') : '*'}`;
        const cached = this.fullFeatures;
        if (cached && cached.graph === this.graph && cached.key === key) return Promise.resolve(cached.fc);
        const waiting = this.fullPending.get(key);
        if (waiting) return waiting;
        const wanted = this.requestFullFeatures(z, routes, key);
        this.fullPending.set(key, wanted);
        void wanted.then(() => this.fullPending.delete(key), () => this.fullPending.delete(key));
        return wanted;
    }

    private async requestFullFeatures(z: number, routes: string[] | null, key: string): Promise<GeoJSON.FeatureCollection> {
        let graph = this.graph;
        // A second try covers a worker that lost the graph, or a graph replaced meanwhile.
        for (let attempt = 0; attempt < 2; attempt++) {
            const req = this.layoutRequest(z, null, 'full', routes);
            const sent = sendToWorker<LayoutResponse>(req);
            if (!sent) {
                this.unsent(req);
                break;
            }
            const res = await sent;
            if (res.needGraph) {
                this.sentGraph = false;
                continue;
            }
            if (res.error) {
                console.warn('maplibre-gl-lanes: lane features in the worker failed, building on this thread:', res.error);
                break;
            }
            if (res.session !== this.session || graph !== this.graph) {
                graph = this.graph;
                continue;
            }
            const fc = this.featureCollection(unpackPaths(res.paths), res.scale);
            this.fullFeatures = {graph, key, fc};
            return fc;
        }
        return this.fullLaneFeatures({zoom: z, routes: routes ?? undefined, extent: 'full'});
    }

    private laneFeature(p: LanePath, coords: [number, number][]): GeoJSON.Feature {
        const meta = this.graph.routes.get(p.route);
        const edge = p.edge;
        const e = this.graph.edges[edge];
        if (p.travel === -1) coords.reverse();
        const properties: GeoJSON.GeoJsonProperties = {
            ...e?.properties,
            route: p.route,
            name: meta?.name ?? p.route,
            color: p.look.color,
            direction: p.travel === 0 ? 0 : 1,
            kind: p.kind,
            edge,
            lanes: e?.routes.length ?? 1,
            routes: e ? (e.order.length === e.routes.length ? e.order : e.routes).slice() : [p.route],
        };
        return {type: 'Feature', geometry: {type: 'LineString', coordinates: coords}, properties};
    }

    private fullLaneFeatures(opts: LaneFeatureOptions): GeoJSON.FeatureCollection {
        const z = opts.zoom ?? this.map?.getZoom() ?? this.built?.zoom ?? 0;
        const routes = opts.routes ? [...opts.routes].sort() : null;
        const key = `${z}|${routes ? routes.join('\0') : '*'}`;
        const cached = this.fullFeatures;
        if (cached && cached.graph === this.graph && cached.key === key) return cached.fc;
        const layout = layoutAtZoom(this.graph, z, this.sizes, {smooth: this.smooth, openFolds: this.openFolds, routes: routes ?? undefined, laneStyle: this.laneStyle ?? undefined});
        const fc = this.featureCollection(layout.paths, layout.scale);
        this.fullFeatures = {graph: this.graph, key, fc};
        return fc;
    }

    private featureCollection(paths: LanePath[], scale: number): GeoJSON.FeatureCollection {
        const features: GeoJSON.Feature[] = [];
        for (const p of paths) {
            const coords: [number, number][] = [];
            for (let i = 0; i < p.coords.length; i += 2) {
                const x = p.coords[i] / scale;
                const y = p.coords[i + 1] / scale;
                coords.push([x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI]);
            }
            if (coords.length < 2) continue;
            features.push(this.laneFeature(p, coords));
        }
        return {type: 'FeatureCollection', features};
    }

    /**
     * The lane nearest to a screen point, within `tolerancePx` (default 6),
     * or null. Only the last build is searched.
     */
    queryLane(point: {x: number; y: number}, tolerancePx = 6): LaneHit | null {
        if (!this.map) return null;
        const lngLat = this.map.unproject([point.x, point.y]);
        return this.queryLaneAt([lngLat.lng, lngLat.lat], this.map.getZoom(), tolerancePx);
    }

    /** `queryLane` for a geographic point, with the zoom that sets the pixel tolerance. */
    queryLaneAt(lngLat: [number, number], zoom: number, tolerancePx = 6): LaneHit | null {
        const layout = this.getLayout();
        if (!layout) return null;
        const merc = lngLatToMercator(lngLat[0], lngLat[1]);
        const nowScale = 512 * Math.pow(2, zoom);
        const px: [number, number] = [merc[0] * nowScale, merc[1] * nowScale];
        const ratio = layout.scale / nowScale;
        let best: LanePath | null = null;
        let bestD2 = tolerancePx * tolerancePx;
        let bestX = 0, bestY = 0;
        for (const p of layout.paths) {
            const c = p.coords, a = p.anchors;
            let prevX = 0, prevY = 0;
            for (let i = 0; i < c.length; i += 2) {
                const x = a[i] / ratio + (c[i] - a[i]);
                const y = a[i + 1] / ratio + (c[i + 1] - a[i + 1]);
                if (i > 0) {
                    const [d2, cx, cy] = segNearest(px[0], px[1], prevX, prevY, x, y);
                    if (d2 < bestD2) {
                        bestD2 = d2;
                        best = p;
                        bestX = cx;
                        bestY = cy;
                    }
                }
                prevX = x;
                prevY = y;
            }
        }
        if (!best) return null;
        const edgeId = best.edge;
        const e = this.graph.edges[edgeId];
        return {
            route: best.route,
            name: this.graph.routes.get(best.route)?.name,
            distancePx: Math.sqrt(bestD2),
            lngLat: mercatorToLngLat(bestX / nowScale, bestY / nowScale),
            kind: best.kind,
            edge: edgeId,
            routes: e ? (e.order.length === e.routes.length ? e.order : e.routes).slice() : [best.route],
            properties: e?.properties ?? {},
        };
    }

    private dashColor(css: string): Float32Array {
        let c = dashColorCache.get(css);
        if (!c) dashColorCache.set(css, (c = rgba(parseColor(css))));
        return c;
    }

    private computeOrigin(): void {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const node of this.graph.nodes) {
            if (node.x < minX) minX = node.x;
            if (node.x > maxX) maxX = node.x;
            if (node.y < minY) minY = node.y;
            if (node.y > maxY) maxY = node.y;
        }
        if (!Number.isFinite(minX)) {
            this.tile = {z: 0, x: 0, y: 0};
            this.origin = [0, 0];
            this.unitsPerMercator = EXTENT;
            return;
        }
        let z = 0;
        for (; z < 22; z++) {
            const n = Math.pow(2, z + 1);
            if (Math.floor(minX * n) !== Math.floor(maxX * n) || Math.floor(minY * n) !== Math.floor(maxY * n)) break;
        }
        const n = Math.pow(2, z);
        this.tile = {z, x: Math.min(n - 1, Math.floor(minX * n)), y: Math.min(n - 1, Math.floor(minY * n))};
        this.origin = [this.tile.x / n, this.tile.y / n];
        this.unitsPerMercator = EXTENT * n;
    }

    onAdd(map: LaneMap, anyGl: AnyGlContext): void {
        // MapLibre 5.x can still hand over WebGL1 on very old browsers.
        if (!isWebGL2(anyGl)) {
            console.error('maplibre-gl-lanes: this map has a WebGL1 context; the lane layer needs WebGL2 and will not draw.');
            this.map = map;
            return;
        }
        const gl = anyGl;
        this.map = map;
        this.gl = gl;
        this.canMark = (gl.getParameter(gl.DEPTH_BITS) as number) >= MIN_DEPTH_BITS;
        if (map.getTerrain()) {
            console.warn('maplibre-gl-lanes: 3D terrain is enabled; lanes are drawn at ' +
                'sea level and will be hidden under raised terrain.');
        }
        this.vbo = gl.createBuffer();
        this.cbo = gl.createBuffer();
        this.ibo = gl.createBuffer();
        this.dirty = true;
    }

    onRemove(_map: LaneMap, anyGl: AnyGlContext): void {
        const gl = this.gl;
        if (!gl) {
            this.map = null;
            return;
        }
        void anyGl;
        for (const p of this.programs.values()) {
            if (!p) continue;
            gl.deleteProgram(p.program);
            gl.deleteVertexArray(p.vao);
        }
        this.programs.clear();
        for (const b of [this.vbo, this.cbo, this.ibo]) if (b) gl.deleteBuffer(b);
        this.vbo = this.cbo = this.ibo = null;
        this.layoutCache.clear();
        this.meshCache.clear();
        this.closeSession();
        this.mesh = null;
        this.map = null;
        this.gl = null;
    }

    /** A failure is logged once and draws nothing, rather than throwing every frame. */
    private programFor(gl: WebGL2RenderingContext, shaderData: CustomRenderMethodInput['shaderData']) {
        const name = shaderData.variantName;
        if (this.programs.has(name)) return this.programs.get(name)!;
        let entry = null;
        try {
            entry = this.buildProgram(gl, shaderData);
        } catch (err) {
            console.error(`maplibre-gl-lanes: lanes will not draw in the ${name} projection:`, err);
        }
        this.programs.set(name, entry);
        return entry;
    }

    private buildProgram(gl: WebGL2RenderingContext, shaderData: CustomRenderMethodInput['shaderData']) {
        const vsSource = `#version 300 es\nprecision highp float;\n${shaderData.vertexShaderPrelude}\n${shaderData.define}\n${VERTEX_SHADER_BODY}`;
        const fsSource = `#version 300 es\nprecision highp float;\n${shaderData.define}\n${FRAGMENT_SHADER_BODY}`;
        const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
        const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program);
            gl.deleteProgram(program);
            throw new Error(`program link failed: ${log}`);
        }
        const uniforms: Record<string, WebGLUniformLocation | null> = {};
        for (const u of ['u_units_per_px', 'u_outset', 'u_blur', 'u_override', 'u_opacity', 'u_dash', 'u_cap', 'u_along_scale', 'u_cover',
            'u_projection_matrix', 'u_projection_tile_mercator_coords', 'u_projection_clipping_plane', 'u_projection_transition', 'u_projection_fallback_matrix']) {
            uniforms[u] = gl.getUniformLocation(program, u);
        }
        const vao = gl.createVertexArray()!;
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        const stride = FLOATS_PER_VERTEX * 4;
        const attribs: [string, number, number][] = [['a_anchor', 0, 2], ['a_delta', 8, 2], ['a_extrude', 16, 2], ['a_normal', 24, 2], ['a_along', 32, 1]];
        for (const [name, offset, size] of attribs) {
            const loc = gl.getAttribLocation(program, name);
            if (loc < 0) continue;
            gl.enableVertexAttribArray(loc);
            gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
        }
        const aCol = gl.getAttribLocation(program, 'a_color');
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cbo);
        gl.enableVertexAttribArray(aCol);
        gl.vertexAttribPointer(aCol, 4, gl.UNSIGNED_BYTE, true, 4, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bindVertexArray(null);
        return {program, vao, uniforms};
    }

    private viewBounds(): Bounds | null {
        if (!this.cull || !this.map) return null;
        const b = this.map.getBounds();
        const sw = lngLatToMercator(b.getWest(), b.getSouth());
        const ne = lngLatToMercator(b.getEast(), b.getNorth());
        const minX = Math.min(sw[0], ne[0]), maxX = Math.max(sw[0], ne[0]);
        const minY = Math.min(sw[1], ne[1]), maxY = Math.max(sw[1], ne[1]);
        const mx = (maxX - minX) * this.cullMargin;
        const my = (maxY - minY) * this.cullMargin;
        return {minX: minX - mx, minY: minY - my, maxX: maxX + mx, maxY: maxY + my};
    }

    private viewInside(built: Bounds | null): boolean {
        if (!built) return true;
        const b = this.map!.getBounds();
        const sw = lngLatToMercator(b.getWest(), b.getSouth());
        const ne = lngLatToMercator(b.getEast(), b.getNorth());
        return Math.min(sw[0], ne[0]) >= built.minX && Math.max(sw[0], ne[0]) <= built.maxX &&
            Math.min(sw[1], ne[1]) >= built.minY && Math.max(sw[1], ne[1]) <= built.maxY;
    }

    private serves(build: {zoom: number; bounds: Bounds | null}, zoom: number): boolean {
        const dz = zoom - build.zoom;
        return dz >= -this.zoomEpsilon && dz <= 2 * this.zoomEpsilon && this.viewInside(build.bounds);
    }

    /**
     * Only one build is ever in flight: a pan that outruns the worker asks
     * again once its answer lands, rather than queueing a request per frame.
     */
    private rebuild(zoom: number): void {
        if (this.inFlight) return;
        const bounds = this.viewBounds();
        if (this.useWorker && this.sendLayout(zoom, bounds)) {
            this.dirty = false;
            return;
        }
        const t0 = performance.now();
        const layout = layoutAtZoom(this.graph, zoom, this.sizes, {bounds, smooth: this.smooth, openFolds: this.openFolds, laneStyle: this.laneStyle ?? undefined, cache: this.layoutCache});
        const t1 = performance.now();
        // A view into buffers the cache reuses: upload now, never read again.
        const mesh = tessellate(layout.paths, {scale: layout.scale, origin: this.origin, unitsPerMercator: this.unitsPerMercator, drawOrder: layout.drawOrder, width: checkedSizes(this.sizes, zoom).width, cache: this.meshCache});
        const t2 = performance.now();
        this.upload(mesh);
        this.layout = layout;
        this.packed = null;
        this.built = {zoom, bounds};
        this.dirty = false;
        this.timings = {layoutMs: t1 - t0, meshMs: t2 - t1, renderThreadMs: performance.now() - t0};
        this.finished();
    }

    private layoutRequest(zoom: number, bounds: Bounds | null, extent: 'built' | 'full', routes?: string[] | null): LayoutRequest {
        const req: LayoutRequest = {
            kind: 'layout', id: nextRequestId(), session: this.session, zoom, style: checkedSizes(this.sizes, zoom),
            smooth: this.smooth, openFolds: this.openFolds, bounds, extent,
        };
        if (routes) req.routes = routes;
        if (!this.sentGraph) {
            req.graph = toTransfer(this.graph);
            req.origin = this.origin;
            req.unitsPerMercator = this.unitsPerMercator;
            // A fresh session starts without looks, so they go with the graph.
            this.looksDirty = true;
            this.sentGraph = true;
        }
        if (this.looksDirty) {
            req.looks = this.lookTable();
            this.looksDirty = false;
        }
        return req;
    }

    private unsent(req: LayoutRequest): void {
        if (req.graph) this.sentGraph = false;
        if (req.looks !== undefined) this.looksDirty = true;
    }

    private sendLayout(zoom: number, bounds: Bounds | null): boolean {
        const req = this.layoutRequest(zoom, bounds, 'built');
        const sent = sendToWorker<LayoutResponse>(req);
        if (!sent) {
            // Stay on this thread rather than serialize the graph on every rebuild.
            this.unsent(req);
            this.useWorker = false;
            return false;
        }
        this.inFlight = {id: req.id};
        sent.then((res) => this.onLayout(res));
        return true;
    }

    private onLayout(res: LayoutResponse): void {
        if (!this.inFlight || res.id !== this.inFlight.id) return;
        this.inFlight = null;
        if (res.session !== this.session) {
            // Overtaken by a new graph; nothing else will ask again.
            this.dirty = true;
            this.map?.triggerRepaint();
            return;
        }
        if (res.needGraph) {
            this.sentGraph = false;
            this.dirty = true;
            this.map?.triggerRepaint();
            return;
        }
        if (res.error) {
            console.warn('maplibre-gl-lanes: layout in the worker failed, building on the main thread:', res.error);
            this.useWorker = false;
            this.dirty = true;
            this.map?.triggerRepaint();
            return;
        }
        if (this.dirty) {
            // Changed while in flight: the next frame asks again.
            this.map?.triggerRepaint();
            return;
        }
        if (!this.gl) return;
        const t0 = performance.now();
        this.upload(res);
        this.packed = res;
        this.layout = null;
        this.built = {zoom: res.zoom, bounds: res.bounds};
        this.timings = {layoutMs: res.layoutMs, meshMs: res.meshMs, renderThreadMs: performance.now() - t0};
        this.finished();
        this.map?.triggerRepaint();
    }

    /** The listener runs in a microtask, never inside the render call. */
    private finished(): void {
        this.builds++;
        const listener = this.onBuild;
        if (!listener) return;
        const info = this.getBuildInfo()!;
        queueMicrotask(() => {
            if (this.map) listener(info);
        });
    }

    /** In the worker's reading order: edges, then each edge's routes. */
    private lookTable(): (LaneAppearance | null)[] | null {
        const laneStyle = this.laneStyle;
        if (!laneStyle) return null;
        const out: (LaneAppearance | null)[] = [];
        for (const e of this.graph.edges) for (const r of e.routes) out.push(laneStyle(e, r) ?? null);
        return out;
    }

    private closeSession(): void {
        this.fullPending.clear();
        this.inFlight = null;
        if (!this.sentGraph) return;
        this.sentGraph = false;
        sendToWorker({kind: 'dispose', id: nextRequestId(), session: this.session});
    }

    private upload(mesh: Mesh): void {
        const gl = this.gl!;
        // Between frames MapLibre's last VAO is still bound and would take the index buffer.
        gl.bindVertexArray(null);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cbo);
        gl.bufferData(gl.ARRAY_BUFFER, mesh.colors, gl.DYNAMIC_DRAW);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.DYNAMIC_DRAW);
        this.mesh = mesh;
    }

    render(anyGl: AnyGlContext, args: LaneRenderArgs): void {
        const gl = this.gl;
        if (!this.map || !this.vbo || !gl) return;
        void anyGl;
        const zoom = this.map.getZoom();
        if (this.dirty || !this.built || !this.serves(this.built, zoom)) this.rebuild(zoom);
        const mesh = this.mesh;
        if (!mesh || !mesh.indexCount) return;

        const entry = this.programFor(gl, args.shaderData);
        if (!entry) return;
        const {program, vao, uniforms} = entry;
        // MapLibre 6 passes `getProjectionData`; 5.x has it on the transform.
        // Both read only `canonical` and `wrap`, so a literal tile id serves.
        type ProjectionData = ReturnType<CustomRenderMethodInput['getProjectionData']>;
        const tileID = {canonical: this.tile, wrap: 0};
        const pd: ProjectionData = args.getProjectionData
            ? args.getProjectionData({tileID, applyGlobeMatrix: true})
            : (this.map as unknown as {transform: {getProjectionData: (p: object) => ProjectionData}}).transform
                .getProjectionData({overscaledTileID: tileID, applyGlobeMatrix: true});
        const dpr = this.map.getPixelRatio();
        const style = checkedSizes(this.sizes, zoom);
        // Dashes are sized at the build zoom, as the mesh's distance along is,
        // or the pattern would slide as the zoom moved between rebuilds.
        const built = this.built ? this.built.zoom : zoom;
        const dashStyle = built === zoom ? style : checkedSizes(this.sizes, built);
        const alongScale = Math.pow(2, zoom - built);
        const unitsPerPx = this.unitsPerMercator / (512 * Math.pow(2, zoom));

        gl.useProgram(program);
        gl.bindVertexArray(vao);
        gl.uniformMatrix4fv(uniforms.u_projection_matrix, false, pd.mainMatrix as Float32List);
        gl.uniformMatrix4fv(uniforms.u_projection_fallback_matrix, false, pd.fallbackMatrix as Float32List);
        gl.uniform4f(uniforms.u_projection_tile_mercator_coords, ...pd.tileMercatorCoords);
        gl.uniform4f(uniforms.u_projection_clipping_plane, ...pd.clippingPlane);
        gl.uniform1f(uniforms.u_projection_transition, pd.projectionTransition);
        gl.uniform1f(uniforms.u_units_per_px, unitsPerPx);
        gl.uniform1f(uniforms.u_along_scale, alongScale);
        gl.uniform1f(uniforms.u_blur, 1 / dpr);
        gl.uniform1f(uniforms.u_opacity, this.opacity);
        gl.uniform1f(uniforms.u_cover, COVER_ALL);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.CULL_FACE);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        const aa = 0.5 / dpr;
        // A route is a run of adjacent groups, one per look, drawn together
        // so its own pieces never show seams. Highlighted routes go last.
        gl.uniform2f(uniforms.u_dash, 0, 0);
        gl.uniform1f(uniforms.u_cap, 0);
        const runs: number[][] = [];
        for (let gi = 0; gi < mesh.groupRoutes.length; ) {
            const route = mesh.groupRoutes[gi];
            const run: number[] = [];
            while (gi < mesh.groupRoutes.length && mesh.groupRoutes[gi] === route) {
                if (mesh.groups[gi][1]) run.push(gi);
                gi++;
            }
            if (run.length) runs.push(run);
        }
        const hl = this.highlightStyle;
        const liftedRuns: number[][] = [];
        const lifted = new Set<number>();
        if (hl) {
            for (const route of this.highlight) {
                const run = runs.find((r) => mesh.groupRoutes[r[0]] === route);
                if (!run) continue;
                liftedRuns.push(run);
                for (const gi of run) lifted.add(gi);
            }
        }
        const dimmed = !!hl && liftedRuns.length > 0;
        // Only a casing that lets the map through needs blending once.
        const once = this.canMark && !!this.casing && (this.casing[3] < 1 || this.opacity < 1 || (dimmed && hl!.dim < 1));
        if (once) {
            // Assume nothing about incoming depth: clear under every casing pixel.
            gl.enable(gl.DEPTH_TEST);
            gl.depthFunc(gl.ALWAYS);
            gl.depthMask(true);
            gl.depthRange(DEPTH_CLEAR, DEPTH_CLEAR);
            gl.colorMask(false, false, false, false);
            gl.uniform1f(uniforms.u_outset, style.width / 2 + style.casingWidth + aa);
            gl.uniform4fv(uniforms.u_override, this.casing!);
            gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
            gl.colorMask(true, true, true, true);
            gl.depthMask(false);
        }
        const split = dimmed && hl!.dim < 1 && hl!.bright.size > 0 ? this.splitFor(mesh, hl!) : null;
        const opacities = split ? {dimmed: this.opacity * hl!.dim, bright: this.opacity, split} : null;
        if (dimmed) gl.uniform1f(uniforms.u_opacity, this.opacity * hl!.dim);
        for (const run of runs) {
            if (!lifted.has(run[0])) this.drawRoute(gl, uniforms, run, style, dashStyle, aa, once, opacities);
        }
        if (hl && liftedRuns.length) {
            gl.uniform1f(uniforms.u_opacity, this.opacity);
            const outlineEdge = style.width / 2 + style.casingWidth + widthAt(hl.outlineWidth, zoom);
            // Every halo, then every outline, then the lanes, or one route's
            // halo would wash over the next lifted lane. Both clear the mark.
            if (once && (hl.halo || hl.outline)) {
                gl.depthFunc(gl.ALWAYS);
                gl.depthMask(true);
                gl.depthRange(DEPTH_CLEAR, DEPTH_CLEAR);
            }
            if (hl.halo) {
                // The blur spans the fade, so the opaque core never doubles on overlap.
                gl.uniform1f(uniforms.u_blur, Math.max(1 / dpr, widthAt(hl.haloBlur, zoom)));
                gl.uniform1f(uniforms.u_outset, outlineEdge + widthAt(hl.haloWidth, zoom) + aa);
                gl.uniform4fv(uniforms.u_override, hl.halo);
                for (const gi of lifted) gl.drawElements(gl.TRIANGLES, mesh.groups[gi][1], gl.UNSIGNED_INT, mesh.groups[gi][0] * 4);
                gl.uniform1f(uniforms.u_blur, 1 / dpr);
            }
            if (hl.outline) {
                gl.uniform1f(uniforms.u_outset, outlineEdge + aa);
                gl.uniform4fv(uniforms.u_override, hl.outline);
                for (const gi of lifted) gl.drawElements(gl.TRIANGLES, mesh.groups[gi][1], gl.UNSIGNED_INT, mesh.groups[gi][0] * 4);
            }
            if (once) gl.depthMask(false);
            for (const run of liftedRuns) this.drawRoute(gl, uniforms, run, style, dashStyle, aa, once);
        }
        if (once) {
            // The next layer may be another custom layer, which MapLibre does not reset for.
            gl.disable(gl.DEPTH_TEST);
            gl.depthFunc(gl.LEQUAL);
            gl.depthRange(0, 1);
        }
        gl.bindVertexArray(null);
    }

    /** The bright split of every group, worked out once per mesh and highlight. */
    private splitFor(mesh: Mesh, hl: ResolvedHighlight): (RunSplit | null)[] {
        const cached = this.brightSplit;
        if (cached && cached.mesh === mesh && cached.style === hl) return cached.groups;
        const groups: (RunSplit | null)[] = [];
        for (let gi = 0; gi < mesh.groups.length; gi++) {
            const ribbon = splitRanges(mesh.groups[gi], mesh.groupPieces[gi], hl.bright);
            const dots = splitRanges(mesh.groupDots[gi], mesh.groupDotPieces[gi], hl.bright);
            groups.push(ribbon.bright.length || dots.bright.length
                ? {dimmed: ribbon.dimmed, bright: ribbon.bright, dotsDimmed: dots.dimmed, dotsBright: dots.bright}
                : null);
        }
        this.brightSplit = {mesh, style: hl, groups};
        return groups;
    }

    /**
     * Every casing before any fill, or a group's casing would seam over its
     * neighbor's fill. `dashStyle` is in the mesh's build pixels.
     *
     * With `opacities`, the pieces on bright edges draw at full opacity in
     * the same passes as the rest of the route, so they keep its place in
     * the drawing order and its once-only casing. Their casings go after
     * the dimmed ones: where a bright cap reaches into a dimmed neighbor,
     * the neighbor's own casing already holds the mark, so a full-strength
     * casing never shows through the neighbor's translucent fill. Their
     * fills go last, so they cover the dimmed caps that reach into them.
     */
    private drawRoute(gl: WebGL2RenderingContext, uniforms: Record<string, WebGLUniformLocation | null>, run: number[], style: {width: number; casingWidth: number}, dashStyle: {width: number}, aa: number, once: boolean,
        opacities: {dimmed: number; bright: number; split: (RunSplit | null)[]} | null = null): void {
        const mesh = this.mesh!;
        const meta = this.graph.routes.get(mesh.groupRoutes[run[0]]);
        const periodOf = (look: LaneLook): [number, number] =>
            look.dash ? [look.dash[0] * dashStyle.width, look.dash[1] * dashStyle.width] : [0, 0];
        // A pass is one side of the bright split, or the whole route when nothing is bright.
        type Pass = 'all' | 'dimmed' | 'bright';
        const split = opacities ? opacities.split : null;
        const ribbon = (gi: number, pass: Pass): [number, number][] => {
            const sp = split && split[gi];
            if (!sp) return pass === 'bright' ? [] : [mesh.groups[gi]];
            return pass === 'bright' ? sp.bright : sp.dimmed;
        };
        const dotRanges = (gi: number, pass: Pass): [number, number][] => {
            const sp = split && split[gi];
            if (!sp) return pass === 'bright' ? [] : [mesh.groupDots[gi]];
            return pass === 'bright' ? sp.dotsBright : sp.dotsDimmed;
        };
        const drawAll = (ranges: [number, number][]) => {
            for (const [first, count] of ranges) if (count) gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
        };
        const draw = (gi: number, pass: Pass) => drawAll(ribbon(gi, pass));
        // Dots are the mesh's own quads: cut from the ribbon they are round only where it is straight.
        const drawDashes = (gi: number, look: LaneLook, pass: Pass) => {
            const dots = mesh.groupDots[gi];
            if (look.dash![0] === 0 && dots && dots[1]) {
                drawAll(dotRanges(gi, pass));
                return;
            }
            const period = periodOf(look);
            gl.uniform2f(uniforms.u_dash, period[0], period[1]);
            draw(gi, pass);
            gl.uniform2f(uniforms.u_dash, 0, 0);
        };
        const lit = !!split && run.some((gi) => split[gi]);
        const passes: Pass[] = lit ? ['dimmed', 'bright'] : ['all'];
        const setOpacity = (pass: Pass) => {
            if (lit) gl.uniform1f(uniforms.u_opacity, pass === 'bright' ? opacities!.bright : opacities!.dimmed);
        };
        if (this.casing && meta?.casing !== false) {
            gl.uniform1f(uniforms.u_outset, style.width / 2 + style.casingWidth + aa);
            gl.uniform4fv(uniforms.u_override, this.casing);
            for (const pass of passes) for (const gi of run) {
                if (pass === 'bright' && !split![gi]) continue;
                setOpacity(pass);
                const look = mesh.groupLooks[gi];
                // Dots with no color between them are cased dot by dot.
                const dotted = !!look.dash && look.dash[0] === 0 && !look.dashColor;
                const drawCasing = dotted ? () => drawDashes(gi, look, pass) : () => draw(gi, pass);
                if (once) {
                    // Full fragments set the mark, partial ones only test it.
                    gl.depthFunc(gl.LESS);
                    gl.depthRange(DEPTH_MARK, DEPTH_MARK);
                    gl.depthMask(true);
                    gl.uniform1f(uniforms.u_cover, COVER_FULL);
                    drawCasing();
                    gl.depthMask(false);
                    gl.uniform1f(uniforms.u_cover, COVER_PARTIAL);
                    drawCasing();
                    gl.uniform1f(uniforms.u_cover, COVER_ALL);
                } else {
                    drawCasing();
                }
            }
        }
        if (once) gl.depthFunc(gl.ALWAYS);
        gl.uniform1f(uniforms.u_outset, style.width / 2 + aa);
        const fillPasses: Pass[] = lit ? ['dimmed', 'bright'] : ['all'];
        for (const pass of fillPasses) for (const gi of run) {
            if (pass === 'bright' && !split![gi]) continue;
            setOpacity(pass);
            const look = mesh.groupLooks[gi];
            const dash = look.dash;
            gl.uniform1f(uniforms.u_cap, look.dashCap === 'round' ? 1 : 0);
            if (dash && look.dashColor) {
                gl.uniform4fv(uniforms.u_override, this.dashColor(look.dashColor));
                draw(gi, pass);
                gl.uniform4f(uniforms.u_override, 0, 0, 0, -1);
                drawDashes(gi, look, pass);
            } else if (dash) {
                gl.uniform4f(uniforms.u_override, 0, 0, 0, -1);
                drawDashes(gi, look, pass);
            } else {
                gl.uniform4f(uniforms.u_override, 0, 0, 0, -1);
                draw(gi, pass);
            }
            if (once) {
                // Clear the mark in the fill's shape; uncolored dash gaps still show casing.
                gl.colorMask(false, false, false, false);
                gl.depthMask(true);
                gl.depthRange(DEPTH_CLEAR, DEPTH_CLEAR);
                gl.uniform1f(uniforms.u_cover, COVER_HALF);
                if (dash && !look.dashColor) drawDashes(gi, look, pass);
                else draw(gi, pass);
                gl.uniform1f(uniforms.u_cover, COVER_ALL);
                gl.depthMask(false);
                gl.colorMask(true, true, true, true);
            }
        }
        // The caller draws the next route at the dimmed opacity it set.
        if (lit) gl.uniform1f(uniforms.u_opacity, opacities!.dimmed);
    }

}

const EXTENT = 8192;
let nextSession = 1;
const dashColorCache = new Map<string, Float32Array>();

/** Squared distance from p to segment ab, and the nearest point. */
function segNearest(px: number, py: number, ax: number, ay: number, bx: number, by: number): [number, number, number] {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
    const x = ax + dx * t, y = ay + dy * t;
    return [(px - x) * (px - x) + (py - y) * (py - y), x, y];
}

function isWebGL2(gl: AnyGlContext): gl is WebGL2RenderingContext {
    return typeof (gl as WebGL2RenderingContext).createVertexArray === 'function';
}

function rgba(c: Uint8Array): Float32Array {
    return new Float32Array([c[0] / 255, c[1] / 255, c[2] / 255, c[3] / 255]);
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`shader compile failed: ${log}`);
    }
    return s;
}
