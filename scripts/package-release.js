const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const rootPkgPath = path.join(rootDir, "package.json");
const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, "utf8"));

const releaseDir = path.join(
  rootDir,
  "release",
  `${rootPkg.name}-v${rootPkg.version}`
);

const chromeZipName = `${rootPkg.name}-chrome-${rootPkg.version}.zip`;
const chromeZipSource = path.join(rootDir, "web-ext-artifacts", chromeZipName);

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function copyFileIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    console.warn(`[bundle] Missing file, skipped: ${sourcePath}`);
    return;
  }
  ensureDir(path.dirname(targetPath));
  fs.copyFileSync(sourcePath, targetPath);
  console.log(`[bundle] Copied file: ${targetPath}`);
}

function copyDirIfExists(sourceDir, targetDir) {
  if (!fs.existsSync(sourceDir)) {
    console.warn(`[bundle] Missing directory, skipped: ${sourceDir}`);
    return;
  }
  ensureDir(path.dirname(targetDir));
  fs.cpSync(sourceDir, targetDir, { recursive: true });
  console.log(`[bundle] Copied directory: ${targetDir}`);
}

function writeStartHereFile(targetDir) {
  const filePath = path.join(targetDir, "START_HERE.md");
  const content = `# ${rootPkg.name} unified distribution

This folder is a single distribution package for:

1. Extension install
2. MCP server startup
3. Skill copy/import

## 1) Install extension

- Zip file: \`extension/${chromeZipName}\`
- Unpacked dir: \`extension/dist-chrome/\`

## 2) Start MCP server

From this distribution root:

\`\`\`bash
cd mcp
npm install
node dist/cli.js serve
\`\`\`

Or from this distribution root:

\`\`\`bash
node dist/cli.js serve
\`\`\`

Note: this root command still requires dependencies installed in \`mcp/\` once.

## 3) Cursor Rule (for Cursor IDE)

Copy to your workspace:

\`\`\`bash
mkdir -p /path/to/workspace/.cursor/rules
cp cursor-rules/spawriter.mdc /path/to/workspace/.cursor/rules/
\`\`\`

## 4) Skill (for other AI Agent systems)

- Copy from: \`skills/spawriter/\`
`;

  fs.writeFileSync(filePath, content, "utf8");
  console.log(`[bundle] Wrote file: ${filePath}`);
}

function rmSafe(targetDir) {
  if (!fs.existsSync(targetDir)) return;

  try {
    fs.rmSync(targetDir, { recursive: true, force: true });
    return;
  } catch (err) {
    if (err.code !== "EBUSY" && err.code !== "EPERM") throw err;
  }

  const tmpName = targetDir + ".__old_" + Date.now();
  try {
    fs.renameSync(targetDir, tmpName);
    console.log(`[bundle] Renamed locked dir to ${path.basename(tmpName)} (will clean up later)`);
    try { fs.rmSync(tmpName, { recursive: true, force: true }); } catch (_) {}
  } catch (renameErr) {
    console.warn(`[bundle] Cannot remove or rename ${targetDir}: ${renameErr.message}`);
    console.warn("[bundle] Proceeding with in-place overwrite...");
  }
}

function main() {
  rmSafe(releaseDir);
  ensureDir(releaseDir);

  // Extension artifacts
  copyFileIfExists(
    chromeZipSource,
    path.join(releaseDir, "extension", chromeZipName)
  );
  copyDirIfExists(
    path.join(rootDir, "dist-chrome"),
    path.join(releaseDir, "extension", "dist-chrome")
  );

  // MCP runtime artifacts
  copyDirIfExists(
    path.join(rootDir, "mcp", "dist"),
    path.join(releaseDir, "mcp", "dist")
  );
  copyFileIfExists(
    path.join(rootDir, "mcp", "package.json"),
    path.join(releaseDir, "mcp", "package.json")
  );
  copyFileIfExists(
    path.join(rootDir, "mcp", "package-lock.json"),
    path.join(releaseDir, "mcp", "package-lock.json")
  );
  copyFileIfExists(
    path.join(rootDir, "mcp", "bin.js"),
    path.join(releaseDir, "mcp", "bin.js")
  );

  // Root CLI compatibility shim
  copyFileIfExists(
    path.join(rootDir, "dist", "cli.js"),
    path.join(releaseDir, "dist", "cli.js")
  );

  // Skill + Cursor rules + docs
  copyDirIfExists(
    path.join(rootDir, "skills", "spawriter"),
    path.join(releaseDir, "skills", "spawriter")
  );
  copyDirIfExists(
    path.join(rootDir, "cursor-rules"),
    path.join(releaseDir, "cursor-rules")
  );
  copyFileIfExists(
    path.join(rootDir, "README.md"),
    path.join(releaseDir, "README.md")
  );
  copyFileIfExists(
    path.join(rootDir, "doc", "CHROME_INSTALL_TEST_GUIDE.md"),
    path.join(releaseDir, "doc", "CHROME_INSTALL_TEST_GUIDE.md")
  );
  copyFileIfExists(
    path.join(rootDir, "doc", "MCP_DEV_GUIDE.md"),
    path.join(releaseDir, "doc", "MCP_DEV_GUIDE.md")
  );

  writeStartHereFile(releaseDir);
  console.log(`[bundle] Unified output ready: ${releaseDir}`);
}

main();
