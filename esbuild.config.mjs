import * as esbuild from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

mkdirSync('dist', { recursive: true });

await esbuild.build({
  entryPoints: { 'service-worker': 'src/background/service-worker.ts' },
  outdir: 'dist/background',
  bundle: true,
  format: 'esm',
  target: 'chrome116',
});

await esbuild.build({
  entryPoints: { overlay: 'src/content/overlay.ts' },
  outdir: 'dist/content',
  bundle: true,
  format: 'iife',
  target: 'chrome116',
});

copyFileSync('manifest.json', 'dist/manifest.json');
