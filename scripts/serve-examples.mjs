// Serves the repository root over http, so the plain-file pages in
// examples/ can fetch /dist, /node_modules and /test/fixtures with no
// bundler or staging step.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname, join, normalize, resolve} from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const port = Number(process.env.PORT ?? 5178);
const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.geojson': 'application/json',
    '.map': 'application/json',
    '.png': 'image/png',
};

createServer(async (req, res) => {
    let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (path.endsWith('/')) path += 'index.html';
    // Keep '..' in the request from escaping the repository.
    const file = join(root, normalize(path));
    if (!file.startsWith(root)) {
        res.writeHead(403).end('forbidden');
        return;
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, {'content-type': types[extname(file)] ?? 'application/octet-stream'});
        res.end(body);
    } catch {
        res.writeHead(404).end(`not found: ${path}`);
    }
}).listen(port, () => console.log(`examples on http://127.0.0.1:${port}/examples/`));
