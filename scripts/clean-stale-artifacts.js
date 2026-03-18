const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const rootPkgPath = path.join(rootDir, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

const releaseBaseDir = path.join(rootDir, "release");
const currentReleaseName = `${rootPkg.name}-v${rootPkg.version}`;

const intermediateDirs = [
  path.join(rootDir, "ext", "build"),
  path.join(rootDir, "ext", "dist-chrome"),
  path.join(rootDir, "ext", "web-ext-artifacts"),
];

function removeDirIfExists(targetDir) {
  if (!fs.existsSync(targetDir)) {
    return;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  console.log(`[clean] Removed: ${targetDir}`);
}

function cleanupIntermediateDirs() {
  for (const dirPath of intermediateDirs) {
    removeDirIfExists(dirPath);
  }
}

function cleanupOldReleaseDirs() {
  if (!fs.existsSync(releaseBaseDir)) {
    return;
  }

  const entries = fs.readdirSync(releaseBaseDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name === currentReleaseName) {
      continue;
    }
    removeDirIfExists(path.join(releaseBaseDir, entry.name));
  }
}

function main() {
  cleanupIntermediateDirs();
  cleanupOldReleaseDirs();
  console.log(
    `[clean] Done. Kept release directory: ${path.join(
      releaseBaseDir,
      currentReleaseName
    )}`
  );
}

main();
