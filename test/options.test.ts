/**
 * Wrong options are refused by name. A page that loads the classic script
 * has no type checker, so a renamed or misspelled option has to fail where
 * it is passed, not as NaN geometry inside the render loop.
 */
import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';
import {buildLineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {layoutAtZoom} from '../src/core/layout';
import {LaneLayer, type LaneLayerOptions} from '../src/render/layer';

const fc = JSON.parse(readFileSync(new URL('./fixtures/example.src.geojson', import.meta.url), 'utf8'));
const graph = buildLineGraph(fc.features, {routeProperty: 'route_id', colorProperty: 'route_colour'});
orderLanes(graph);
const sizes = () => ({spacing: 8, width: 6, casingWidth: 1});
/** Options as untyped JavaScript would pass them. */
const untyped = (o: object) => o as unknown as LaneLayerOptions;

describe('layer options', () => {
    it('refuses a missing sizes callback when the layer is made', () => {
        expect(() => new LaneLayer(untyped({id: 'lanes', graph, style: sizes}))).toThrow(/`sizes` must be a function/);
        expect(() => new LaneLayer(untyped({id: 'lanes', graph, sizes: {spacing: 8, width: 6, casingWidth: 1}}))).toThrow(/`sizes` must be a function/);
    });

    it('refuses a missing graph', () => {
        expect(() => new LaneLayer(untyped({id: 'lanes', sizes}))).toThrow(/`graph` must be a line graph/);
    });

    it('refuses setSizes without a function', () => {
        const layer = new LaneLayer({id: 'lanes', graph, sizes});
        expect(() => layer.setSizes(untyped({}) as never)).toThrow(/`sizes` must be a function/);
    });

    it('names the field when the sizes are not drawable', () => {
        const oldName = (() => ({spacing: 8, width: 6, casing: 1})) as never;
        expect(() => layoutAtZoom(graph, 15, oldName)).toThrow(/casingWidth.*got.*"casingWidth":"undefined"/);
        expect(() => layoutAtZoom(graph, 15, () => ({spacing: 0, width: 6, casingWidth: 1}))).toThrow(/spacing and width above 0/);
        expect(() => layoutAtZoom(graph, 15, () => ({spacing: 8, width: NaN, casingWidth: 1}))).toThrow(/"width":"NaN"/);
        expect(() => layoutAtZoom(graph, 15, (() => undefined) as never)).toThrow(/got undefined/);
    });

    it('accepts a casing width of 0', () => {
        expect(layoutAtZoom(graph, 15, () => ({spacing: 8, width: 6, casingWidth: 0})).paths.length).toBeGreaterThan(0);
    });
});
