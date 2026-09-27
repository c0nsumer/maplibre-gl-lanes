# Contributing

This is a personal project, built and maintained by one person in spare time.
Contributions are welcome with that context in mind:

- **Issues** are the best way to help. Bug reports with a GeoJSON file that
  reproduces the problem, or pointers to incorrect docs, are genuinely useful.
- **Pull requests** may sit for a while. If a change doesn't fit the project's
  direction (small, no runtime dependencies beyond MapLibre, layout core kept
  independent of the renderer), it may be declined. For anything bigger than a
  typo fix, opening an issue to discuss first is a good idea.

## Before submitting a change

Run the checks from the repo root:

```bash
corepack pnpm test        # no network needed, runs in seconds
corepack pnpm typecheck
corepack pnpm lint
```

All three must pass. The test suite runs entirely offline against the
fixtures in `test/fixtures/`.

## Conventions

- American English in docs, comments, and messages. Literal external
  identifiers keep their canonical spelling: the OSM `colour=` tag, the CSS
  `grey` color name.
- Comments in this codebase carry design rationale, not narration. Keep that
  standard: explain why, not what.
- No em dashes. Use a colon, a comma, a period, or a hyphen for ranges.
- There is no formatter. Match the surrounding code: 4-space indent, single
  quotes, about 100 columns. Do not reflow lines you are not changing.
- Do not copy or port code from LOOM. It is GPL-3 and this project is MIT.
  Reimplement from the papers listed in `CITATION.cff`.
