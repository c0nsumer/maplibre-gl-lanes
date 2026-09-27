/**
 * The layer must work under MapLibre 5.x and 6.x. The two differ in how a
 * custom layer gets projection uniforms: 6.x hands `getProjectionData` to
 * `render` on its args, 5.x has the same computation on `map.transform`.
 * The peer range says >= 5.0.0, and 5.24 is what the first consumer runs,
 * so both paths are driven here, against each version's own types.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import type {CustomLayerInterface as CustomLayerInterface5, Map as Map5} from 'maplibre-gl-5';
import type {CustomLayerInterface as CustomLayerInterface6, Map as Map6, CustomRenderMethodInput} from 'maplibre-gl';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {LaneLayer} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(graph);
const style = () => ({spacing: 8, width: 6, casingWidth: 1});

/** Projection uniforms of the shape both versions return, with recognizable values. */
function projectionData(tag: number) {
    return {
        mainMatrix: new Float64Array(16).fill(tag),
        fallbackMatrix: new Float64Array(16).fill(tag + 1),
        tileMercatorCoords: [0, 0, 1, 1] as [number, number, number, number],
        clippingPlane: [0, 0, 0, 1] as [number, number, number, number],
        projectionTransition: 0,
    };
}

/** A WebGL2 context that records what it is asked to do. */
function recordingGl() {
    const calls: {name: string; args: unknown[]}[] = [];
    const gl = new Proxy({}, {
        get: (_, name: string) => {
            if (name === 'getProgramParameter' || name === 'getShaderParameter') return () => true;
            if (name === 'getAttribLocation') return () => 0;
            return (...args: unknown[]) => {
                calls.push({name, args});
                return {};
            };
        },
    }) as unknown as WebGL2RenderingContext;
    return {gl, calls};
}

const shaderData = {variantName: 'mercator', vertexShaderPrelude: '', define: ''};

function mapStub(zoom: number, transformProjection?: (p: unknown) => ReturnType<typeof projectionData>) {
    const transformCalls: unknown[] = [];
    const map = {
        getTerrain: () => null,
        getZoom: () => zoom,
        getPixelRatio: () => 1,
        triggerRepaint: () => {},
        getBounds: () => ({getWest: () => -180, getSouth: () => -85, getEast: () => 180, getNorth: () => 85}),
        transform: transformProjection ? {getProjectionData: (p: unknown) => (transformCalls.push(p), transformProjection(p))} : {},
    };
    return {map, transformCalls};
}

describe('MapLibre 5.x and 6.x', () => {
    it('is a custom layer under the types of both versions', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style});
        const five: CustomLayerInterface5 = layer;
        const six: CustomLayerInterface6 = layer;
        expect(five.type).toBe('custom');
        expect(six.renderingMode).toBe('2d');
    });

    it('renders through args.getProjectionData under 6.x', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, cull: false});
        const {gl, calls} = recordingGl();
        const {map, transformCalls} = mapStub(14);
        layer.onAdd(map as unknown as Map6, gl);
        const argCalls: unknown[] = [];
        const args = {shaderData, getProjectionData: (p: unknown) => (argCalls.push(p), projectionData(6))} as unknown as CustomRenderMethodInput;
        layer.render(gl, args);
        expect(argCalls.length).toBe(1);
        expect(transformCalls.length).toBe(0);
        expect((argCalls[0] as {tileID: {canonical: unknown}; applyGlobeMatrix: boolean}).applyGlobeMatrix).toBe(true);
        const matrices = calls.filter((c) => c.name === 'uniformMatrix4fv').map((c) => (c.args[2] as Float64Array)[0]);
        expect(matrices).toEqual([6, 7]);
        expect(calls.some((c) => c.name === 'drawElements')).toBe(true);
    });

    it('falls back to map.transform.getProjectionData under 5.x', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes: style, cull: false});
        const {gl, calls} = recordingGl();
        const {map, transformCalls} = mapStub(14, () => projectionData(5));
        // What 5.x's transform expects: the same call its own draw code makes.
        type Transform5 = Map5['transform'];
        const expectedShape: Parameters<Transform5['getProjectionData']>[0] = {overscaledTileID: {canonical: {z: 0, x: 0, y: 0}, wrap: 0} as never, applyGlobeMatrix: true};
        layer.onAdd(map as unknown as Map6, gl);
        layer.render(gl, {shaderData} as unknown as CustomRenderMethodInput);
        expect(transformCalls.length).toBe(1);
        const p = transformCalls[0] as typeof expectedShape;
        expect(p.applyGlobeMatrix).toBe(true);
        expect(p.overscaledTileID!.canonical).toBeDefined();
        const matrices = calls.filter((c) => c.name === 'uniformMatrix4fv').map((c) => (c.args[2] as Float64Array)[0]);
        expect(matrices).toEqual([5, 6]);
        expect(calls.some((c) => c.name === 'drawElements')).toBe(true);
    });
});
