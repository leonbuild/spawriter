// Bundles npm packages into self-contained browser IIFEs (dist/assets/*.js)
// that the executor injects into pages via Runtime.evaluate. Mirrors
// playwriter's scripts/build-client-bundles.ts, using esbuild instead of Bun.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(rootDir, 'dist', 'assets');

const BUNDLES = [
  {
    name: 'readability',
    code: `
import { Readability, isProbablyReaderable } from '@mozilla/readability'
globalThis.__readability = { Readability, isProbablyReaderable }
`,
  },
  {
    name: 'bippy',
    code: `
import { getFiberFromHostInstance, getDisplayName, traverseFiber, isCompositeFiber, isHostFiber } from 'bippy'
import { getSource, getOwnerStack, normalizeFileName, isSourceFile } from 'bippy/source'
globalThis.__bippy = {
  getFiberFromHostInstance,
  getDisplayName,
  traverseFiber,
  isCompositeFiber,
  isHostFiber,
  getSource,
  getOwnerStack,
  normalizeFileName,
  isSourceFile,
}
`,
  },
];

fs.mkdirSync(assetsDir, { recursive: true });

for (const bundle of BUNDLES) {
  const start = Date.now();
  const result = await build({
    stdin: {
      contents: bundle.code,
      resolveDir: rootDir,
      loader: 'js',
    },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    define: { 'process.env.NODE_ENV': '"development"' },
  });
  const code = result.outputFiles[0].text;
  fs.writeFileSync(path.join(assetsDir, `${bundle.name}.js`), code);
  console.log(`  ${bundle.name}.js (${Math.round(code.length / 1024)}kb) [${Date.now() - start}ms]`);
}
console.log(`Built ${BUNDLES.length} client bundles into ${assetsDir}`);
