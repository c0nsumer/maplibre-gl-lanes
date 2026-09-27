/** Lane ordering in the worker, or on this thread where workers are unavailable. */

import type {LineGraph} from './graph.js';
import {LaneOrderer, seedFromSnapshot, type OrderOptions, type LaneOrderSnapshot} from './order.js';
import {stabilizeLanes, type StabilizeOptions} from './baselines.js';
import {toTransfer} from './serialize.js';
import {nextRequestId, sendToWorker} from './worker-client.js';
import type {OrderRequest, OrderResponse} from '../worker/lanes.worker.js';

export interface OrderAsyncOptions {
    order?: OrderOptions;
    /** A previous result (see `snapshotLaneOrders`) to start from, so the other lanes stay put. */
    seed?: LaneOrderSnapshot;
    /** Stable-lane baselines after ordering. Default on; pass false to skip. */
    stabilize?: StabilizeOptions | false;
    /** Force the synchronous path (for tests). */
    sync?: boolean;
}

/** Order and stabilize the graph's lanes in a worker, in place. Resolves to the ordering cost. */
export async function orderLanesAsync(g: LineGraph, opts: OrderAsyncOptions = {}): Promise<number> {
    const order: OrderOptions = {...opts.order};
    if (opts.seed) order.initial = seedFromSnapshot(g, opts.seed);
    const id = nextRequestId();
    const req: OrderRequest = {kind: 'order', id, graph: toTransfer(g), order, stabilize: opts.stabilize};
    const sent = opts.sync ? null : sendToWorker<OrderResponse>(req);
    if (!sent) {
        const cost = new LaneOrderer(g, order).solve();
        if (opts.stabilize !== false) stabilizeLanes(g, opts.stabilize ?? {});
        return cost;
    }
    const res = await sent;
    if (res.disposed) return orderLanesAsync(g, {...opts, sync: true});
    if (res.error) {
        console.warn('maplibre-gl-lanes: ordering in worker failed, running on main thread:', res.error);
        return orderLanesAsync(g, {...opts, sync: true});
    }
    g.edges.forEach((e, i) => {
        e.order = res.orders[i];
        e.baseline = res.baselines[i];
    });
    return res.cost;
}
