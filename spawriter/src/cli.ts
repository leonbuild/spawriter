import { startRelayServer } from "./relay.js";
import { startMcpServer } from "./mcp.js";
import { VERSION, getRelayPort } from "./utils.js";

const args = process.argv.slice(2);
const command = args[0];
const portFlagIndex = args.indexOf("--port");
const parsedPort =
  portFlagIndex >= 0 && args[portFlagIndex + 1]
    ? parseInt(args[portFlagIndex + 1], 10)
    : NaN;
const port = Number.isFinite(parsedPort) ? parsedPort : getRelayPort();
const help = args.includes("--help") || args.includes("-h");
const version = args.includes("--version") || args.includes("-v");

if (command !== 'serve' && command !== 'relay') {
  process.stderr.write(`spawriter v${VERSION}\n`);
}

if (help) {
  console.log(`
Usage: spawriter <command> [options]

Commands:
  relay    Start the CDP Relay server
  serve    Start the MCP server (includes relay if not running)

Options:
  --port <port>  Port to listen on (default: 19989)
  --help, -h     Show this help
  --version, -v  Show version
`);
  process.exit(0);
}

if (version) {
  process.exit(0);
}

switch (command) {
  case "relay":
    process.env.SSPA_MCP_PORT = String(port);
    startRelayServer().catch((e) => {
      console.error("Failed to start relay server:", e);
      process.exit(1);
    });
    break;

  case "serve":
    process.env.SSPA_MCP_PORT = String(port);
    startMcpServer().catch((e) => {
      console.error("Failed to start MCP server:", e);
      process.exit(1);
    });
    break;

  default:
    if (command) {
      console.error(`Unknown command: ${command}`);
    } else {
      console.error("No command specified");
    }
    console.error("Run spawriter --help for usage");
    process.exit(1);
}
