/**
 * Development spawn under Vite. Bundlers resolve `new Worker(new URL(...))`
 * even in dead branches, and the .ts source is not shipped, so the library
 * build replaces this module with one that returns null.
 */

export function spawnDevWorker(): Worker | null {
    return new Worker(new URL('../worker/lanes.worker.ts', import.meta.url), {type: 'module'});
}
