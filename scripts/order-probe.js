/* maplibre-gl-lanes: where the time of a lane ordering goes on a device.
 *
 * Paste into a Web Inspector or DevTools console attached to a page that
 * runs the layer, with the page VISIBLE on the device and the map at rest.
 * It takes ten to twenty seconds and prints one JSON object. Do not touch
 * the device while it runs.
 *
 * A stopwatch around `orderLanesAsync` at load cannot tell the solver from
 * the worker it runs in or from the main thread the answer waits on, so
 * this times each on its own, all on private copies of the page's graph:
 *
 * - graphBuild: `buildLineGraph` on the main thread, as the page does it.
 * - solveWorker: a full solve in the page's warm ordering worker, wall
 *   time from the call to the answer.
 * - solveMain: the same solve on the main thread (`sync: true`), which is
 *   the solver's own time in this engine.
 * - resolveSeeded: a solve seeded from a previous result with the busiest
 *   route hidden, which is what a route toggle costs.
 * - solveWhileMainBusy: a worker solve with the main thread spinning for
 *   one second right after the request is posted. Near the spin means the
 *   worker ran alongside it; near spin plus solve means it did not.
 * - spawn: a fresh worker's first round trip, once for a trivial script
 *   and once for the layer's own worker script, so the platform's spawn
 *   latency and this script's compile time show separately.
 *
 * It expects the page to expose `routesData`, `laneRouteMeta` and
 * `laneGraphFull` or `difficultyVisibleFeatures`, as trailmaps.app does;
 * change `pageGraphInput` for another host.
 *
 * Safari coarsens performance.now() to 1 ms; every figure here is long
 * enough for that not to matter.
 */
(async () => {
    const L = window.maplibreLanes;
    if (!L || !L.orderLanesAsync) return 'FAIL: no maplibreLanes on this page';
    if (document.visibilityState !== 'visible') return 'FAIL: page is hidden; wake the phone and show the map, then rerun';
    const res = {}, now = () => performance.now();
    const stats = (xs) => {
        const s = xs.slice().sort((a, b) => a - b);
        return {n: s.length, medianMs: +s[s.length >> 1].toFixed(1), maxMs: +s[s.length - 1].toFixed(1), allMs: s.map((x) => +x.toFixed(1))};
    };

    // A worker that dies makes orderLanesAsync fall back to the main thread
    // with only a console warning, which would make solveWorker look like
    // solveMain; keep the warnings so that shows.
    const warnings = [], warn = console.warn;
    console.warn = (...a) => { warnings.push(a.map(String).join(' ')); warn.apply(console, a); };

    const pageGraphInput = () => {
        const opts = {routeProperty: 'route_id', colorProperty: 'route_colour', nameProperty: 'route_name',
            routes: laneRouteMeta(), uniformProperties: ['oneway', 'trail_name', 'imba_difficulty']};
        if (typeof laneGraphFull !== 'undefined' && laneGraphFull) return {features: routesData.features, opts};
        opts.uniformProperties.push('color_key', 'reverses_by_day');
        return {features: difficultyVisibleFeatures, opts};
    };
    const input = pageGraphInput();
    if (!input.features) return 'FAIL: no route features on this page';

    res.device = {ua: navigator.userAgent, cores: navigator.hardwareConcurrency, visible: document.visibilityState};

    const N = 7, graphs = [], build = [];
    for (let i = 0; i < N + 3; i++) {
        const t0 = now();
        graphs.push(L.buildLineGraph(input.features, input.opts));
        build.push(now() - t0);
    }
    const g0 = graphs[0];
    res.graph = {nodes: g0.nodes.length, edges: g0.edges.length,
        sharedEdges: g0.edges.filter((e) => e.routes.length > 1).length,
        routes: new Set(g0.edges.flatMap((e) => e.routes)).size};
    res.graphBuild = stats(build);

    const worker = [], costs = [];
    for (let i = 0; i < N; i++) {
        const t0 = now();
        costs.push(await L.orderLanesAsync(graphs[i]));
        worker.push(now() - t0);
    }
    res.solveWorker = stats(worker);
    res.solveWorker.costs = costs;

    const main = [];
    for (let i = N; i < N + 3; i++) {
        const t0 = now();
        await L.orderLanesAsync(graphs[i], {sync: true});
        main.push(now() - t0);
    }
    res.solveMain = stats(main);

    // The route on the most shared edges, hidden and seeded from the solved
    // full graph: the same request the page makes when a route is toggled.
    const onShared = {};
    for (const e of g0.edges) if (e.routes.length > 1) for (const r of e.routes) onShared[r] = (onShared[r] || 0) + 1;
    const busiest = Object.keys(onShared).sort((a, b) => onShared[b] - onShared[a])[0];
    const seed = L.snapshotLaneOrders(g0), seeded = [];
    for (let i = 0; i < 5; i++) {
        const next = L.filterGraph(g0, (id) => id !== busiest);
        const t0 = now();
        await L.orderLanesAsync(next, {seed});
        seeded.push(now() - t0);
    }
    res.resolveSeeded = stats(seeded);
    res.resolveSeeded.hidden = busiest;

    const busy = [], spinMs = 1000;
    for (let i = 0; i < 3; i++) {
        const g = L.buildLineGraph(input.features, input.opts);
        const t0 = now();
        const p = L.orderLanesAsync(g);
        while (now() - t0 < spinMs) { /* hold the main thread */ }
        await p;
        busy.push(now() - t0);
    }
    res.solveWhileMainBusy = stats(busy);
    res.solveWhileMainBusy.spinMs = spinMs;

    // First round trip of a worker made from a script: the platform's cost
    // to start one, plus the time to compile and run the script.
    const roundTrip = (src, msg) => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([src], {type: 'text/javascript'}));
        const t0 = now(), w = new Worker(url);
        const done = (v) => { w.terminate(); URL.revokeObjectURL(url); resolve(v); };
        w.onmessage = () => done(now() - t0);
        w.onerror = (e) => { done(null); reject(new Error(e.message || 'worker failed')); };
        w.postMessage(msg);
    });
    const trivial = [];
    for (let i = 0; i < 3; i++) trivial.push(await roundTrip('self.onmessage=(e)=>self.postMessage(e.data)', 0));
    res.spawn = {trivialScript: stats(trivial)};

    // The layer's worker script is a string literal in its bundle, at the
    // Blob the client spawns from; the bundle's own URL is on the script tag.
    // A `dispose` request is the smallest one the worker answers.
    try {
        const tag = [...document.scripts].find((s) => /maplibre-gl-lanes/.test(s.src));
        if (!tag) throw new Error('no maplibre-gl-lanes script tag');
        const text = await (await fetch(tag.src)).text();
        const at = text.indexOf('new Blob([');
        if (at < 0) throw new Error('no inlined worker in the bundle');
        let i = at + 'new Blob(['.length;
        const quote = text[i++];
        for (; i < text.length && text[i] !== quote; i++) if (text[i] === '\\') i++;
        const literal = text.slice(at + 'new Blob(['.length, i + 1);
        const src = new Function('return ' + literal)();
        const lanes = [];
        for (let k = 0; k < 3; k++) lanes.push(await roundTrip(src, {kind: 'dispose', id: 1, session: 0}));
        res.spawn.lanesWorkerScript = stats(lanes);
        res.spawn.lanesWorkerScriptKB = Math.round(src.length / 1024);
    } catch (e) {
        res.spawn.lanesWorkerScript = 'not measured: ' + e.message;
    }

    console.warn = warn;
    res.warnings = warnings;
    return JSON.stringify(res, null, 1);
})().then((r) => console.log(r), (e) => console.log('FAIL: ' + e));
