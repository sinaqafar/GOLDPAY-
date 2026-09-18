/**
 * Admin panel build.
 *
 * esbuild rather than a framework toolchain: the panel is a handful of screens
 * over an API that already enforces every rule, so a bundler and nothing else
 * is the right amount of machinery.
 */

import { build, context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

await mkdir(new URL('./public/assets/', import.meta.url), { recursive: true });

const options = {
  entryPoints: [new URL('./src/main.tsx', import.meta.url).pathname],
  outfile: new URL('./public/assets/admin.js', import.meta.url).pathname,
  bundle: true,
  format: 'esm',
  target: 'es2022',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
  console.log('admin: watching');
} else {
  await build(options);
  console.log('admin: built');
}
