import { defineConfig } from 'tsdown'

/** Bundle the tsc-emitted host code into a single ESM file; d.ts comes from tsc. */
export default defineConfig({
  entry: ['lib/types/index.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
