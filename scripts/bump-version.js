/**
 * Bump version across all files that contain version numbers.
 *
 * Usage:
 *   node scripts/bump-version.js <new-version>
 *   node scripts/bump-version.js patch|minor|major
 *
 * Files updated:
 *   - package.json
 *   - ext/manifest.json
 *   - ext/manifest.chrome.json
 *   - ext/package.json
 *   - mcp/package.json
 */

const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");

const VERSION_FILES = [
  path.join(rootDir, "package.json"),
  path.join(rootDir, "ext", "manifest.json"),
  path.join(rootDir, "ext", "manifest.chrome.json"),
  path.join(rootDir, "ext", "package.json"),
  path.join(rootDir, "mcp", "package.json"),
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function parseSemver(version) {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) {
    throw new Error(`Invalid semver: ${version}`);
  }
  return {
    major: parseInt(match[1], 10),
    minor: parseInt(match[2], 10),
    patch: parseInt(match[3], 10),
  };
}

function bumpSemver(current, level) {
  const v = parseSemver(current);
  switch (level) {
    case "major":
      return `${v.major + 1}.0.0`;
    case "minor":
      return `${v.major}.${v.minor + 1}.0`;
    case "patch":
      return `${v.major}.${v.minor}.${v.patch + 1}`;
    default:
      throw new Error(`Unknown bump level: ${level}`);
  }
}

function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help" || arg === "-h") {
    console.log(
      "Usage: node scripts/bump-version.js <new-version|patch|minor|major>"
    );
    console.log("");
    console.log("  patch   e.g. 4.0.0 -> 4.0.1");
    console.log("  minor   e.g. 4.0.0 -> 4.1.0");
    console.log("  major   e.g. 4.0.0 -> 5.0.0");
    console.log("  x.y.z   set explicit version");
    process.exit(arg ? 0 : 1);
  }

  const rootPkg = readJson(VERSION_FILES[0]);
  const currentVersion = rootPkg.version;

  let newVersion;
  if (["patch", "minor", "major"].includes(arg)) {
    newVersion = bumpSemver(currentVersion, arg);
  } else {
    parseSemver(arg);
    newVersion = arg;
  }

  console.log(`Bumping version: ${currentVersion} -> ${newVersion}\n`);

  for (const filePath of VERSION_FILES) {
    if (!fs.existsSync(filePath)) {
      console.warn(`  [skip] ${path.relative(rootDir, filePath)} (not found)`);
      continue;
    }

    const data = readJson(filePath);
    const oldVersion = data.version;
    data.version = newVersion;
    writeJson(filePath, data);

    const rel = path.relative(rootDir, filePath);
    console.log(`  [ok]   ${rel}  ${oldVersion} -> ${newVersion}`);
  }

  console.log(
    `\nDone. Run "npm run build" to generate the release with v${newVersion}.`
  );
}

main();
