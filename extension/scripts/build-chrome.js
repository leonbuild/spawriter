/**
 * Chrome extension build: swap manifest, zip, restore.
 * web-ext-config.cjs already excludes src/, node_modules/, etc.
 * No intermediate directory needed.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const extDir = path.resolve(__dirname, '..');
const manifestPath = path.join(extDir, 'manifest.json');
const chromeManifestPath = path.join(extDir, 'manifest.chrome.json');

const firefoxManifest = fs.readFileSync(manifestPath, 'utf8');
const chromeManifest = fs.readFileSync(chromeManifestPath, 'utf8');

try {
  fs.writeFileSync(manifestPath, chromeManifest);
  console.log('Swapped manifest.json -> Chrome variant');

  execSync(
    'npx web-ext build --overwrite-dest --filename spawriter-chrome-{version}.zip',
    { cwd: extDir, stdio: 'inherit' }
  );
} finally {
  fs.writeFileSync(manifestPath, firefoxManifest);
  console.log('Restored manifest.json -> Firefox variant');
}
