import {describe, it, expect} from 'vitest';
import {readFileSync} from 'node:fs';

// `docs/api.md` is the reference a reader is sent to from the README, so an
// export it does not mention is an export nobody can look up. The index is
// already pinned by exports.test.ts; this pins the documentation to it.
describe('API reference', () => {
    it('documents every name the index exports', () => {
        const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
        const doc = readFileSync(new URL('../docs/api.md', import.meta.url), 'utf8');
        const names = new Set<string>();
        for (const m of index.matchAll(/export (?:type )?\{([^}]*)\}/g)) {
            for (const name of m[1].split(',')) names.add(name.trim());
        }
        expect(names.size).toBeGreaterThan(40);
        expect([...names].filter((n) => !doc.includes(n))).toEqual([]);
    });
});
