/**
 * Degenerate and extreme input must still give finite geometry: one NaN
 * vertex spoils a whole mesh draw, and nothing downstream reports it.
 */
import {describe, it, expect} from 'vitest';
import {buildLineGraph, type LineGraph} from '../src/core/graph';
import {orderLanes} from '../src/core/order';
import {stabilizeLanes} from '../src/core/baselines';
import {layoutAtZoom, type Layout} from '../src/core/layout';
import {offsetPolylineAnchored, offsetPolylineSlidingAnchored, smoothCatmullRom, trimPolyline, type Polyline} from '../src/core/geometry';
import {openFolds} from '../src/core/folds';
import {tessellate, FLOATS_PER_VERTEX} from '../src/render/tessellate';

type Line = {route: string; coords: number[][]};
function graphOf(lines: Line[]): LineGraph {
    const features = lines.map((l) => ({type: 'Feature', properties: {route: l.route, color: '#123456'}, geometry: {type: 'LineString', coordinates: l.coords}}));
    const g = buildLineGraph(features as never);
    orderLanes(g);
    stabilizeLanes(g);
    return g;
}

function checkFinite(name: string, layout: Layout): string[] {
    const bad: string[] = [];
    for (const p of layout.paths) {
        if (p.coords.length !== p.anchors.length) bad.push(`${name}: ${p.kind} ${p.route} e${p.edge}: coords ${p.coords.length} vs anchors ${p.anchors.length}`);
        if (p.coords.length < 4) bad.push(`${name}: ${p.kind} ${p.route} e${p.edge}: only ${p.coords.length / 2} points`);
        for (let i = 0; i < p.coords.length; i++) {
            if (!Number.isFinite(p.coords[i])) {
                bad.push(`${name}: ${p.kind} ${p.route} e${p.edge} node ${p.node}: coords[${i}]=${p.coords[i]}`);
                break;
            }
        }
        for (let i = 0; i < p.anchors.length; i++) {
            if (!Number.isFinite(p.anchors[i])) {
                bad.push(`${name}: ${p.kind} ${p.route} e${p.edge}: anchors[${i}]=${p.anchors[i]}`);
                break;
            }
        }
        if (!Number.isFinite(p.startDistance)) bad.push(`${name}: ${p.kind} ${p.route}: startDistance ${p.startDistance}`);
    }
    return bad;
}

// Degrees for px at zoom 15 on the equator.
const deg15 = 360 / (512 * 2 ** 15);
const m = 1 / 111320; // roughly one meter in degrees at the equator

const cases: Record<string, Line[]> = {
    twoVertexTiny: [{route: 'a', coords: [[0, 0], [0.05 * m, 0]]}, {route: 'b', coords: [[0, 0], [0.05 * m, 0]]}, {route: 'a', coords: [[0.05 * m, 0], [0.05 * m, 100 * m]]}, {route: 'b', coords: [[0.05 * m, 0], [100 * m, 0]]}],
    repeatedVertices: [{route: 'a', coords: [[0, 0], [0, 0], [10 * m, 0], [10 * m, 0], [10 * m, 10 * m]]}, {route: 'b', coords: [[0, 0], [10 * m, 0], [20 * m, 0]]}],
    doubleBack: [{route: 'a', coords: [[0, 0], [100 * m, 0], [0, 0]]}, {route: 'b', coords: [[0, 0], [100 * m, 0], [100 * m, 100 * m]]}],
    doubleBackFar: [{route: 'a', coords: [[0, 0], [100 * m, 0], [200 * m, 0], [100 * m, 0], [100 * m, 100 * m]]}, {route: 'b', coords: [[0, 0], [100 * m, 0], [200 * m, 0]]}],
    colinear: [{route: 'a', coords: [[0, 0], [10 * m, 0], [20 * m, 0], [30 * m, 0], [40 * m, 0]]}, {route: 'b', coords: [[10 * m, 0], [20 * m, 0], [30 * m, 0]]}, {route: 'c', coords: [[20 * m, 0], [30 * m, 0], [40 * m, 0], [40 * m, 10 * m]]}],
    closedLoop: [{route: 'a', coords: [[0, 0], [100 * m, 0], [100 * m, 100 * m], [0, 100 * m], [0, 0]]}, {route: 'b', coords: [[0, 0], [100 * m, 0], [100 * m, 100 * m], [0, 100 * m], [0, 0]]}],
    lollipop: [{route: 'a', coords: [[-200 * m, 0], [0, 0], [100 * m, 0], [100 * m, 100 * m], [0, 100 * m], [0, 0]]}, {route: 'b', coords: [[-200 * m, 0], [0, 0], [0, -100 * m]]}],
    tinyLoop: [{route: 'a', coords: [[-200 * m, 0], [0, 0], [1 * m, 0], [1 * m, 1 * m], [0, 1 * m], [0, 0], [200 * m, 0]]}, {route: 'b', coords: [[-200 * m, 0], [0, 0], [200 * m, 0]]}],
    oneEdgeNode: [{route: 'a', coords: [[0, 0], [100 * m, 0]]}],
    parallelEdges: [
        {route: 'a', coords: [[0, 0], [100 * m, 0]]},
        {route: 'b', coords: [[0, 0], [50 * m, 30 * m], [100 * m, 0]]},
        {route: 'a', coords: [[100 * m, 0], [200 * m, 0]]},
        {route: 'b', coords: [[100 * m, 0], [200 * m, 0]]},
        {route: 'c', coords: [[0, 0], [100 * m, 0], [200 * m, 0]]},
        {route: 'c', coords: [[0, 0], [50 * m, 30 * m], [100 * m, 0]]},
    ],
    shortBetweenJunctions: [
        {route: 'a', coords: [[-100 * m, 0], [0, 0], [0.3 * m, 0], [100 * m, 0]]},
        {route: 'b', coords: [[-100 * m, 50 * m], [0, 0], [0.3 * m, 0], [100 * m, 50 * m]]},
        {route: 'c', coords: [[-100 * m, -50 * m], [0, 0], [0.3 * m, 0], [100 * m, -50 * m]]},
        {route: 'd', coords: [[0, -100 * m], [0, 0], [0.3 * m, 0], [0.3 * m, 100 * m]]},
    ],
    hairpinTiny: [
        ...['a', 'b', 'c', 'd', 'e'].map((r) => ({route: r, coords: [[0, 0], [200 * m, 0], [200 * m, 0.2 * m], [0, 0.2 * m]]})),
        {route: 'a', coords: [[0, 0.2 * m], [-100 * m, 0.2 * m]]},
    ],
    nearPole: [{route: 'a', coords: [[10, 85], [10.001, 85.0005], [10.002, 85.001]]}, {route: 'b', coords: [[10, 85], [10.001, 85.0005], [10.003, 85]]}],
    antimeridian: [{route: 'a', coords: [[179.999, 0], [-179.999, 0], [-179.998, 0.001]]}, {route: 'b', coords: [[179.999, 0], [-179.999, 0], [-179.999, 0.001]]}],
    farFromOrigin: [{route: 'a', coords: [[170, -80], [170.0001, -80], [170.0002, -80.0001]]}, {route: 'b', coords: [[170, -80], [170.0001, -80], [170.0001, -80.0002]]}],
};
{
    // A star: 24 edges at one node, each pair of spokes carrying a through route.
    const star: Line[] = [];
    for (let k = 0; k < 24; k++) {
        const a = (2 * Math.PI * k) / 24, b = (2 * Math.PI * ((k + 7) % 24)) / 24;
        star.push({route: `r${k}`, coords: [[Math.cos(a) * 100 * m, Math.sin(a) * 100 * m], [0, 0], [Math.cos(b) * 100 * m, Math.sin(b) * 100 * m]]});
    }
    cases.star24 = star;
    // Many routes through one hairpin at pixel scale.
    const px: Polyline = [0, 0, 200, 0];
    for (let k = 1; k < 12; k++) px.push(200 + Math.sin((Math.PI * k) / 12) * 2.5, 2.5 - Math.cos((Math.PI * k) / 12) * 2.5);
    px.push(200, 5, 0, 5);
    const coords: number[][] = [];
    for (let i = 0; i < px.length; i += 2) coords.push([px[i] * deg15, -px[i + 1] * deg15]);
    cases.hairpin12 = Array.from({length: 12}, (_, i) => ({route: `h${i}`, coords}));
}

const sizeSets: Record<string, () => {spacing: number; width: number; casingWidth: number}> = {
    normal: () => ({spacing: 8, width: 6, casingWidth: 1}),
    tiny: () => ({spacing: 0.001, width: 0.001, casingWidth: 0}),
    huge: () => ({spacing: 1000, width: 500, casingWidth: 50}),
};

describe('degenerate graphs', () => {
    it('lay out to finite geometry at every zoom and size', () => {
        const bad: string[] = [];
        for (const [name, lines] of Object.entries(cases)) {
            const g = graphOf(lines);
            for (const [sname, sizes] of Object.entries(sizeSets)) {
                for (const z of [0, 12, 16, 22]) bad.push(...checkFinite(`${name}/${sname}/z${z}`, layoutAtZoom(g, z, sizes)));
            }
            bad.push(...checkFinite(`${name}/raw`, layoutAtZoom(g, 16, sizeSets.normal, {smooth: false, openFolds: false})));
        }
        expect(bad).toEqual([]);
    });
});

describe('geometry primitives', () => {
    it('give finite output for degenerate input', () => {
        const bad: string[] = [];
        const fin = (n: string, p: Polyline) => {
            if (p.some((v) => !Number.isFinite(v))) bad.push(`${n}: ${p.join(',')}`);
        };
        fin('offset dup', offsetPolylineAnchored([0, 0, 0, 0, 1, 0, 1, 0, 1, 1], 3).points);
        fin('offset single', offsetPolylineAnchored([0, 0], 3).points);
        fin('offset back', offsetPolylineAnchored([0, 0, 10, 0, 0, 0], 3).points);
        fin('offset back2', offsetPolylineAnchored([0, 0, 10, 0, 0, 0, 10, 0], 3).points);
        fin('offset tiny seg', offsetPolylineAnchored([0, 0, 1e-8, 0, 10, 10], 3).points);
        fin('offset huge', offsetPolylineAnchored([8e9, 8e9, 8e9 + 1e-7, 8e9, 8e9 + 10, 8e9 + 10], 3).points);
        fin('slide back', offsetPolylineSlidingAnchored([0, 0, 10, 0, 0, 0], 3, -3).points);
        fin('slide single', offsetPolylineSlidingAnchored([0, 0], 3, -3).points);
        fin('slide two same', offsetPolylineSlidingAnchored([0, 0, 0, 0], 3, -3).points);
        fin('slide zero total', offsetPolylineSlidingAnchored([0, 0, 1e-12, 0], 3, -3).points);
        fin('smooth back', smoothCatmullRom([0, 0, 10, 0, 0, 0], 5, 10, 3, 60, 12));
        fin('smooth dup', smoothCatmullRom([0, 0, 0, 0, 10, 0, 10, 0, 10, 10], 5, 10, 3, 60, 12));
        fin('smooth dup inside', smoothCatmullRom([0, 0, 10, 0, 20, 5, 20, 5, 30, 0], 1));
        fin('trim zero', trimPolyline([0, 0, 0, 0], 3, 3));
        fin('trim big', trimPolyline([0, 0, 10, 0], 30, 30));
        fin('folds back', openFolds([0, 0, 100, 0, 0, 0], 12, 0, 0));
        fin('folds back2', openFolds([0, 0, 100, 0, 100, 0, 0, 0, 0, 0, 100, 0], 12, 0, 0));
        fin('folds spike', openFolds([0, 0, 100, 0, 0, 0.001], 12, 0, 0));
        fin('folds stack', openFolds([0, 0, 100, 0, 0, 0.001, 100, 0.002, 0, 0.003], 12, 0, 0));
        expect(bad).toEqual([]);
    });
});

describe('a round join at a hairpin', () => {
    // A turn within 1e-6 rad of a full reversal is a semicircle with no short
    // side, so the fan's sweep is chosen; a left turn swept the back of the lane.
    for (const h of [1e-5, -1e-5, 0]) {
        it(`reaches round past the tip (turn ${h > 0 ? 'right' : h < 0 ? 'left' : 'straight back'})`, () => {
            const coords = [0, 0, 100, 0, 0, h];
            const mesh = tessellate([{route: 'r', look: {color: '#f00'}, coords, anchors: coords.slice(), kind: 'lane', travel: 1, startDistance: 0, edge: 0}], {scale: 1, origin: [0, 0]});
            let reach = -Infinity;
            for (let k = 0; k < mesh.vertexCount; k++) {
                const o = k * FLOATS_PER_VERTEX;
                if (Math.abs(mesh.vertices[o] + mesh.vertices[o + 2] - 100) < 1e-3) reach = Math.max(reach, mesh.vertices[o + 4]);
            }
            expect(reach).toBeCloseTo(1, 6);
        });
    }
});
