/**
 * Two workers run the same script: a re-order can take a second on a phone,
 * and a pan must not queue behind it. The build inlines the source and
 * spawns it from a Blob URL, as maplibre-contour does.
 */

import type {LayoutResponse, OrderResponse, WorkerRequest, WorkerResponse} from '../worker/lanes.worker.js';
import {spawnDevWorker} from './worker-dev.js';

declare const __LANES_WORKER_SOURCE__: string | undefined;

type Kind = 'order' | 'layout';

const workers: Record<Kind, Worker | null> = {order: null, layout: null};
const failed: Record<Kind, boolean> = {order: false, layout: false};
let blobUrl: string | null = null;
let nextId = 1;

/** Kept whole, so `settle` can answer it without the worker. */
interface Pending {
    worker: Kind;
    req: WorkerRequest;
    resolve: (r: WorkerResponse) => void;
}
const pending = new Map<number, Pending>();

const kindOf = (req: WorkerRequest): Kind => (req.kind === 'layout' || req.kind === 'dispose' ? 'layout' : 'order');

/**
 * Answer a request the worker never will; a caller left waiting freezes the
 * layer. On dispose, an ordering finishes on this thread rather than respawn
 * a worker, and a layout gets `needGraph` so a live layer resends the graph.
 */
function settle(p: Pending, error: string | null): void {
    const {req} = p;
    if (req.kind === 'layout') {
        const base = {kind: 'layout', id: req.id, session: req.session} as LayoutResponse;
        p.resolve(error === null ? {...base, needGraph: true} : {...base, error});
    } else if (req.kind === 'dispose') {
        p.resolve({kind: 'dispose', id: req.id});
    } else {
        const base = {kind: 'order', id: req.id} as OrderResponse;
        p.resolve(error === null ? {...base, disposed: true} : {...base, error});
    }
}

function settleAll(kind: Kind | null, error: string | null): void {
    for (const [id, p] of pending) {
        if (kind !== null && p.worker !== kind) continue;
        pending.delete(id);
        settle(p, error);
    }
}

function getWorker(kind: Kind): Worker | null {
    const have = workers[kind];
    if (have) return have;
    if (failed[kind] || typeof Worker === 'undefined') return null;
    let worker: Worker | null;
    try {
        if (typeof __LANES_WORKER_SOURCE__ === 'string') {
            if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([__LANES_WORKER_SOURCE__], {type: 'text/javascript'}));
            worker = new Worker(blobUrl);
        } else {
            worker = spawnDevWorker();
        }
    } catch {
        failed[kind] = true;
        return null;
    }
    if (!worker) {
        failed[kind] = true;
        return null;
    }
    worker.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        const p = pending.get(ev.data.id);
        if (p) {
            pending.delete(ev.data.id);
            p.resolve(ev.data);
        }
    };
    // A script that fails to load fires an error event with no message.
    const broken = (reason: string) => {
        if (workers[kind] !== worker) return;
        console.warn(`maplibre-gl-lanes: ${kind} worker failed, falling back to the main thread:`, reason);
        worker.terminate();
        workers[kind] = null;
        failed[kind] = true;
        settleAll(kind, reason);
    };
    worker.onerror = (ev) => broken(ev.message || 'the worker script failed');
    worker.onmessageerror = () => broken('a message from the worker could not be read');
    workers[kind] = worker;
    return worker;
}

export function nextRequestId(): number {
    return nextId++;
}

/** Resolves with the answer, or an `error` if the worker died. Null when there is no worker. */
export function sendToWorker<R extends WorkerResponse>(req: WorkerRequest, transfer?: Transferable[]): Promise<R> | null {
    const kind = kindOf(req);
    // A worker that never started holds no session to drop.
    if (req.kind === 'dispose' && !workers.layout) return null;
    const w = getWorker(kind);
    if (!w) return null;
    return new Promise<R>((resolve) => {
        pending.set(req.id, {worker: kind, req, resolve: resolve as (r: WorkerResponse) => void});
        w.postMessage(req, transfer ?? []);
    });
}

/**
 * Terminate the workers. Safe at any time: they respawn on the next request,
 * and an ordering in flight finishes on this thread.
 */
export function disposeWorkers(): void {
    for (const kind of ['order', 'layout'] as Kind[]) {
        workers[kind]?.terminate();
        workers[kind] = null;
        failed[kind] = false;
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    blobUrl = null;
    settleAll(null, null);
}
