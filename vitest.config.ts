import { defineConfig } from 'vitest/config';

// Vitest's 5 s default is meant for unit tests, and this suite renders
// images: a bootstrap census, a few hundred passes of BDPT, sixty ReSTIR
// passes. Those run in a couple of seconds on an idle machine and two or
// three times that on a busy one — so with the default, a full run taken
// while a dev server or a build is going would fail a random slow test and
// pass on the retry, which is indistinguishable from a genuine flake in a
// codebase full of statistical tests. (Diagnosed 2026-08-04 after exactly
// that: one failure at 45 s wall, three clean runs at 27 s.)
//
// The statistical tests themselves are seeded and deterministic; nothing
// here is timing-dependent by design. This ceiling only has to be far
// enough above the slowest legitimate render.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
