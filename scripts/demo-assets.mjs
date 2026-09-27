// Copy the built bundle and MapLibre's dist files into demo/public for
// plain.html, which loads them without a bundler.
import {mkdirSync, copyFileSync, readdirSync} from 'node:fs';
mkdirSync('demo/public/vendor-maplibre', {recursive: true});
mkdirSync('demo/public/dist', {recursive: true});
for (const f of readdirSync('node_modules/maplibre-gl/dist')) if (/\.(mjs|css)$/.test(f)) copyFileSync(`node_modules/maplibre-gl/dist/${f}`, `demo/public/vendor-maplibre/${f}`);
for (const f of ['maplibre-gl-lanes.js', 'maplibre-gl-lanes.mjs']) copyFileSync(`dist/${f}`, `demo/public/dist/${f}`);
