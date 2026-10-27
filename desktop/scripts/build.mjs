// Bundles main, preload and renderer with esbuild and copies static assets into dist/.
// Type checking is done separately by `npm run typecheck` (tsc).
//
//   node scripts/build.mjs            one-off development build
//   node scripts/build.mjs --watch    rebuild on change (pair with the Alt+. relaunch)
//   node scripts/build.mjs --release  minified build for packaging

import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');

const watch = process.argv.includes('--watch');
const release = process.argv.includes('--release');

// Electron 32 ships Node 20 and Chromium 128.
const common = {
  bundle: true,
  sourcemap: release ? false : 'linked',
  minify: release,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(release ? 'production' : 'development') },
};

/** @type {esbuild.BuildOptions[]} */
const targets = [
  {
    ...common,
    entryPoints: { 'main/index': path.join(src, 'main/index.ts') },
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outdir: dist,
  },
  {
    ...common,
    entryPoints: { 'preload/index': path.join(src, 'preload/index.ts') },
    // Sandboxed preloads can only require('electron'), so everything else is bundled in.
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    external: ['electron'],
    outdir: dist,
  },
  {
    ...common,
    entryPoints: {
      'renderer/main': path.join(src, 'renderer/main.ts'),
      'renderer/pcm-tap.worklet': path.join(src, 'renderer/audio/pcm-tap.worklet.ts'),
    },
    platform: 'browser',
    target: 'chrome128',
    format: 'iife',
    outdir: dist,
  },
];

const staticAssets = ['renderer/index.html', 'renderer/styles.css'];

async function copyStatic() {
  await Promise.all(
    staticAssets.map(async (file) => {
      await mkdir(path.dirname(path.join(dist, file)), { recursive: true });
      await cp(path.join(src, file), path.join(dist, file));
    }),
  );
}

/** esbuild plugin that re-copies static assets after each rebuild in watch mode. */
const copyStaticPlugin = {
  name: 'copy-static',
  setup(build) {
    build.onEnd(async (result) => {
      if (result.errors.length === 0) await copyStatic();
    });
  },
};

await rm(dist, { recursive: true, force: true });

if (watch) {
  const contexts = await Promise.all(
    targets.map((options, i) => esbuild.context(i === targets.length - 1 ? { ...options, plugins: [copyStaticPlugin] } : options)),
  );
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log('Watching for changes… (static HTML/CSS is copied on each renderer rebuild)');
} else {
  await Promise.all(targets.map((options) => esbuild.build(options)));
  await copyStatic();
}
