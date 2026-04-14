/**
 * Converts SVG icons to PNG files for Chrome extension manifest compatibility.
 * Chrome Manifest V3 requires PNG icons — SVG is not supported.
 *
 * Run: node extension/scripts/convert-icons.js
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const iconsDir = path.resolve(__dirname, '..', 'src', 'icons');

async function convert() {
  const svgFiles = fs.readdirSync(iconsDir).filter(f => f.endsWith('.svg'));

  for (const svgFile of svgFiles) {
    const pngFile = svgFile.replace('.svg', '.png');
    const size = parseInt(svgFile.match(/(\d+)/)?.[1] || '48', 10);
    const svgPath = path.join(iconsDir, svgFile);
    const pngPath = path.join(iconsDir, pngFile);

    await sharp(svgPath)
      .resize(size, size)
      .png()
      .toFile(pngPath);
  }

  console.log(`Converted ${svgFiles.length} SVG icons to PNG`);
}

convert().catch(err => {
  console.error('Icon conversion failed:', err);
  process.exit(1);
});
