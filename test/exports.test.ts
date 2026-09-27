import {describe, it, expect} from 'vitest';
import * as api from '../src/index';

// The index is the promise made to consumers from 1.0.0 on: a name added
// here is supported for good, and a name removed breaks someone. Either
// should be a decision, so this list has to be edited by hand to match.
describe('package exports', () => {
    it('exports exactly the public API', () => {
        expect(Object.keys(api).sort()).toEqual([
            'LaneLayer',
            'LayoutCache',
            'applyLaneOrders',
            'buildLineGraph',
            'disposeWorkers',
            'filterGraph',
            'layoutAtZoom',
            'lngLatToMercator',
            'mercatorToLngLat',
            'orderLanes',
            'orderLanesAsync',
            'seedFromSnapshot',
            'snapshotLaneOrders',
            'stabilizeLanes',
        ]);
    });
});
