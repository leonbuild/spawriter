const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const extDir = path.resolve(__dirname, '..');
const buildDir = path.join(extDir, 'build');
const manifestPath = path.join(extDir, 'manifest.chrome.json');
let pending = null;
let isRunning = false;

function runBuild() {
  if (isRunning) {
    pending = true;
    return;
  }

  isRunning = true;
  const child = spawn('node', [path.join(__dirname, 'build-chrome.js')], {
    stdio: 'inherit',
  });

  child.on('exit', () => {
    isRunning = false;
    if (pending) {
      pending = false;
      runBuild();
    }
  });
}

function watchPath(targetPath, options = {}) {
  if (!fs.existsSync(targetPath)) {
    return;
  }

  fs.watch(targetPath, options, () => {
    scheduleBuild();
  });
}

let debounceTimer = null;
function scheduleBuild() {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    runBuild();
  }, 200);
}

runBuild();
watchPath(buildDir, { recursive: true });
watchPath(manifestPath);

console.log('[watch-build-chrome] Watching build output for Chrome dist updates...');
