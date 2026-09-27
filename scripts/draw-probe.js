/* maplibre-gl-lanes: what the layer's draw costs a GPU, and what a
 * translucent casing adds to it.
 *
 * Paste into a Web Inspector or DevTools console attached to a page that
 * runs the layer, VISIBLE on the device and framed on the view to measure.
 * It takes about half a minute and prints one JSON object; do not touch
 * the device while it runs. Like `device-probe.js`, it expects the page to
 * expose `laneLayer` and `map`.
 *
 * A trace cannot answer this: a translucent casing adds GPU passes over
 * the same mesh, not render-thread work, and a trace does not split GPU
 * time by layer. So this draws the same view three ways, with the GPU made
 * to finish:
 *
 *   opaque        the casing with alpha 1: one casing and one fill draw
 *                 per group
 *   once          the casing as set, blended once per pixel: the passes
 *                 a translucent casing takes
 *   twice         the same casing where overlaps blend twice, reached
 *                 through a private field and skipped where it is absent
 *
 * `layerMs` brackets the layer's `render` with a one-pixel `readPixels`,
 * because `gl.finish()` does not wait in Chrome. `frameMs` is a whole
 * forced frame, basemap included, timed over a batch. The modes are
 * interleaved over three rounds so device drift (heat, background tasks)
 * spreads evenly. `pacing` replays one motion per mode and reports the
 * frame intervals a person would see.
 *
 * Safari coarsens performance.now() to 1 ms, so read its `layerMs` to
 * about a tenth of a millisecond; `frameMs` and `pacing` are unaffected.
 */
(async () => {
    if (typeof laneLayer === 'undefined' || !laneLayer) return 'FAIL: no laneLayer on this page';
    if (typeof map === 'undefined' || !map.getZoom) return 'FAIL: no map on this page';
    if (document.visibilityState !== 'visible') return 'FAIL: page is hidden; wake the phone and show the map, then rerun';
    const L = laneLayer, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), res = {};
    if (!L.casing) return 'FAIL: this layer has no casing, so there is nothing to compare';

    const c = map.getCanvas();
    const gl = c.getContext('webgl2');
    if (!gl) return 'FAIL: no WebGL2 context';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const info = L.getBuildInfo();
    const center = map.getCenter();
    res.device = {
        ua: navigator.userAgent, dpr: devicePixelRatio, css: [innerWidth, innerHeight], canvas: [c.width, c.height],
        renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'n/a', depthBits: gl.getParameter(gl.DEPTH_BITS),
    };
    res.view = {zoom: +map.getZoom().toFixed(2), center: [+center.lng.toFixed(5), +center.lat.toFixed(5)], meshVertices: info ? info.stats.vertices : null};

    // The casing as the page set it, and the same color made opaque.
    const [r, g, b, a] = Array.from(L.casing).map((v, i) => (i < 3 ? Math.round(v * 255) : v));
    const asIs = `rgba(${r}, ${g}, ${b}, ${a})`, opaque = `rgba(${r}, ${g}, ${b}, 1)`;
    res.casing = {asFound: asIs, translucent: a < 1 || L.opacity < 1};
    if (!res.casing.translucent) res.note = 'The casing here is opaque already, so "once" and "twice" draw as "opaque" does. Set a translucent casing to measure the difference.';
    const canMark = L.canMark;
    const modes = [['opaque', opaque, canMark], ['once', asIs, canMark]];
    if (typeof canMark === 'boolean' && canMark) modes.push(['twice', asIs, false]);
    else res.twiceSkipped = typeof canMark === 'boolean' ? 'the depth buffer is under 24 bits, so this device draws the old path anyway' : 'no canMark field on this build';
    const use = ([, css, mark]) => {
        L.setCasingColor(css);
        if (typeof canMark === 'boolean') L.canMark = mark;
    };

    const px = new Uint8Array(4);
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const render = L.render;
    let layerMs = 0, layerFrames = 0, draws = 0, timing = false;
    L.render = function (ctx, args) {
        if (!timing) return render.call(L, ctx, args);
        sync();
        const t0 = performance.now();
        render.call(L, ctx, args);
        sync();
        layerMs += performance.now() - t0;
        layerFrames++;
    };
    const drawElements = gl.drawElements;
    const out = {};
    try {
        // Draw calls per frame, counted once per mode.
        for (const m of modes) {
            use(m);
            map.redraw();
            draws = 0;
            gl.drawElements = function (...x) { draws++; return drawElements.apply(gl, x); };
            let inLayer = 0;
            const counted = L.render;
            L.render = function (ctx, args) { const d = draws; render.call(L, ctx, args); inLayer = draws - d; };
            map.redraw();
            L.render = counted;
            gl.drawElements = drawElements;
            out[m[0]] = {drawCalls: inLayer, layerMs: [], frameMs: []};
        }
        // Forced frames, the modes interleaved.
        const FRAMES = 60;
        for (let round = 0; round < 3; round++) {
            for (const m of modes) {
                use(m);
                for (let i = 0; i < 10; i++) map.redraw();
                sync();
                layerMs = 0; layerFrames = 0; timing = true;
                const t0 = performance.now();
                for (let i = 0; i < FRAMES; i++) map.redraw();
                sync();
                const total = performance.now() - t0;
                timing = false;
                out[m[0]].layerMs.push(+(layerMs / Math.max(1, layerFrames)).toFixed(3));
                out[m[0]].frameMs.push(+(total / FRAMES).toFixed(3));
                await sleep(50);
            }
        }
        // What a person sees: the same motion in each mode, frame by frame.
        const start = map.getCenter(), z0 = map.getZoom();
        for (const m of modes) {
            use(m);
            await sleep(400);
            let frames = [], last = performance.now(), run = true;
            (function tick() {
                if (!run) return;
                const t = performance.now(); frames.push(t - last); last = t;
                requestAnimationFrame(tick);
            })();
            map.panBy([innerWidth * 0.6, 0], {duration: 1000}); await sleep(1200);
            map.easeTo({zoom: z0 + 1, duration: 1200}); await sleep(1400);
            map.easeTo({zoom: z0 - 1, duration: 1200}); await sleep(1400);
            map.easeTo({center: start, zoom: z0, duration: 1000}); await sleep(1300);
            run = false;
            const s = frames.slice(2).sort((x, y) => x - y);
            const pct = (q) => (s.length ? +s[Math.floor(q * (s.length - 1))].toFixed(1) : null);
            out[m[0]].pacing = {frames: s.length, medianMs: pct(0.5), p95Ms: pct(0.95), worstMs: pct(1), over20ms: s.filter((v) => v > 20).length, over32ms: s.filter((v) => v > 32).length};
        }
    } finally {
        L.render = render;
        gl.drawElements = drawElements;
        L.setCasingColor(asIs);
        if (typeof canMark === 'boolean') L.canMark = canMark;
        map.redraw();
    }
    const mean = (v) => +(v.reduce((x, y) => x + y, 0) / v.length).toFixed(3);
    for (const k of Object.keys(out)) {
        out[k].layerMsMean = mean(out[k].layerMs);
        out[k].frameMsMean = mean(out[k].frameMs);
    }
    res.modes = out;
    if (out.once && out.opaque) res.translucentCasingAddsMs = {layer: +(out.once.layerMsMean - out.opaque.layerMsMean).toFixed(3), frame: +(out.once.frameMsMean - out.opaque.frameMsMean).toFixed(3)};
    return JSON.stringify(res, null, 1);
})().then((r) => console.log(r), (e) => console.log('FAIL: ' + e));
