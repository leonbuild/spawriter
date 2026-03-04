/**
 * Build script for Chrome extension
 * Copies necessary files to dist-chrome directory with Chrome-specific manifest
 */

const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist-chrome');

// Files and directories to copy
const filesToCopy = [
  'build',
];

// Clean and create dist directory
if (fs.existsSync(distDir)) {
  fs.rmSync(distDir, { recursive: true });
}
fs.mkdirSync(distDir);

// Copy files
filesToCopy.forEach(file => {
  const src = path.join(rootDir, file);
  const dest = path.join(distDir, file);
  
  if (fs.existsSync(src)) {
    if (fs.statSync(src).isDirectory()) {
      copyDir(src, dest);
    } else {
      fs.copyFileSync(src, dest);
    }
    console.log(`Copied: ${file}`);
  } else {
    console.warn(`Warning: ${file} not found`);
  }
});

// Copy icons (only PNGs)
const iconsSrcDir = path.join(rootDir, 'src', 'icons');
const iconsDestDir = path.join(distDir, 'icons');
if (fs.existsSync(iconsSrcDir)) {
  fs.mkdirSync(iconsDestDir, { recursive: true });
  for (const f of fs.readdirSync(iconsSrcDir)) {
    if (f.endsWith('.png')) {
      fs.copyFileSync(path.join(iconsSrcDir, f), path.join(iconsDestDir, f));
    }
  }
  console.log('Copied: icons/ (PNG files)');
}

// Copy Chrome-specific manifest
const chromeManifest = path.join(rootDir, 'manifest.chrome.json');
const destManifest = path.join(distDir, 'manifest.json');
fs.copyFileSync(chromeManifest, destManifest);
console.log('Copied: manifest.chrome.json -> manifest.json');

console.log('\nChrome build prepared in dist-chrome/');

// Helper function to copy directory recursively
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

