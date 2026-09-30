/* maplibre-gl-lanes: device performance probe.
 *
 * Paste into a Web Inspector or DevTools console attached to a page that
 * runs the layer, with that page VISIBLE on the device: a hidden tab
 * suspends requestAnimationFrame, and the layer only builds while it
 * renders, so a hidden page reports nothing.
 *
 * It takes about eleven seconds and prints one JSON object. Do not touch
 * the device while it runs: the script drives a fixed sequence of pans and
 * zooms, so runs are comparable.
 *
 * It expects the page to expose `laneLayer` and `map`; rename them at the
 * top of the function if the host application uses others.
 *
 * Safari coarsens performance.now() to 1 ms, so everything is totalled
 * over many events. `timerGranularityMs` reports what the engine gave.
 */
(async () => {
    if (typeof laneLayer === 'undefined' || !laneLayer) return 'FAIL: no laneLayer on this page';
    if (typeof map === 'undefined' || !map.getZoom) return 'FAIL: no map on this page';
    if (document.visibilityState !== 'visible') return 'FAIL: page is hidden; wake the phone and show the map, then rerun';
    const L = laneLayer, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), res = {};

    const c = map.getCanvas();
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    res.device = {
        ua: navigator.userAgent, dpr: devicePixelRatio,
        screen: [screen.width, screen.height], css: [innerWidth, innerHeight],
        cores: navigator.hardwareConcurrency,
        webgl2: !!c.getContext('webgl2'),
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a',
    };

    let g = Infinity, p = performance.now();
    for (let i = 0; i < 200000; i++) { const t = performance.now(); if (t > p) { if (t - p < g) g = t - p; p = t; } }
    res.timerGranularityMs = g;

    // Sampled per frame rather than through setOnBuild: the layer holds one
    // listener, and the app owns it.
    let frames = [], builds = [], slow = [], last = performance.now(), run = true, phase = 'warm-up', t00 = last;
    let lastBuild = L.getBuildInfo() ? L.getBuildInfo().build : -1;
    (function tick() {
        if (!run) return;
        const t = performance.now(); frames.push(t - last);
        // A long frame is placed by motion and by time, so a recording taken
        // during the run can be read at the same spot.
        if (t - last > 32) slow.push({phase, atMs: Math.round(t - t00), ms: +(t - last).toFixed(1)});
        last = t;
        const bi = L.getBuildInfo();
        if (bi && bi.build !== lastBuild) {
            lastBuild = bi.build;
            builds.push({layout: bi.timings.layoutMs, tess: bi.timings.meshMs, build: bi.timings.renderThreadMs, verts: bi.stats.vertices});
        }
        requestAnimationFrame(tick);
    })();

    const start = map.getCenter(), z0 = map.getZoom();
    await sleep(500); frames = []; builds = []; slow = []; t00 = performance.now();   // discard warm-up
    phase = 'pan right'; map.panBy([innerWidth * 0.8, 0], {duration: 1200}); await sleep(1600);
    phase = 'pan down'; map.panBy([0, innerHeight * 0.6], {duration: 1200}); await sleep(1600);
    phase = 'zoom in 2'; map.easeTo({zoom: z0 + 2, duration: 1500}); await sleep(1900);
    phase = 'zoom out 3'; map.easeTo({zoom: z0 - 1, duration: 1500}); await sleep(1900);
    phase = 'return'; map.easeTo({center: start, zoom: z0, duration: 1200}); await sleep(1600);
    run = false;

    const s = frames.slice(1).sort((a, b) => a - b);
    const pct = (q) => (s.length ? +s[Math.floor(q * (s.length - 1))].toFixed(1) : null);
    res.frames = {
        n: s.length, medianMs: pct(0.5), p95Ms: pct(0.95),
        worstMs: +(s[s.length - 1] || 0).toFixed(1),
        over32ms: s.filter((x) => x > 32).length, over100ms: s.filter((x) => x > 100).length,
        slow,
    };
    const sum = (k) => builds.reduce((a, b) => a + b[k], 0);
    res.builds = {
        n: builds.length, layoutTotalMs: sum('layout'), tessTotalMs: sum('tess'), buildTotalMs: sum('build'),
        worstLayoutMs: Math.max(0, ...builds.map((b) => b.layout)),
        worstTessMs: Math.max(0, ...builds.map((b) => b.tess)),
        vertices: builds.length ? builds[builds.length - 1].verts : null,
    };

    // 200 taps, totalled so a 1 ms timer averages out. `hits` only confirms
    // that lanes are found.
    const t0 = performance.now(); let hits = 0;
    for (let i = 0; i < 200; i++) if (L.queryLane({x: (i * 37) % innerWidth, y: (i * 53) % innerHeight}, 8)) hits++;
    res.queryLane = {calls: 200, hits, totalMs: +(performance.now() - t0).toFixed(1)};

    return JSON.stringify(res, null, 1);
})().then((r) => console.log(r), (e) => console.log('FAIL: ' + e));
