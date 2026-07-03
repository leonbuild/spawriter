// Loads pre-bundled browser IIFEs (built by scripts/build-client-bundles.mjs
// into dist/assets/) for injection into pages via Runtime.evaluate.
// Resolution works from both src/runtime (tsx dev) and dist/runtime (built):
// each is two levels below the package root.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const bundleCache = new Map<string, string>();

export function getClientBundle(name: 'readability' | 'bippy'): string {
  const cached = bundleCache.get(name);
  if (cached) return cached;
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const bundlePath = path.join(currentDir, '..', '..', 'dist', 'assets', `${name}.js`);
  let code: string;
  try {
    code = fs.readFileSync(bundlePath, 'utf-8');
  } catch {
    throw new Error(`Client bundle missing: ${bundlePath}. Run: npm run build:assets`);
  }
  bundleCache.set(name, code);
  return code;
}
