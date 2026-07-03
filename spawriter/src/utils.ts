import * as fs from 'node:fs';
import * as path from 'node:path';

export const VERSION = "1.0.0";

export const DEFAULT_PORT = 19989;

export function getEnv(key: string, defaultValue?: string): string | undefined {
  return process.env[key] ?? defaultValue;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getRelayPort(): number {
  const port = getEnv("SSPA_MCP_PORT");
  return port ? parseInt(port, 10) : DEFAULT_PORT;
}

export function getRelayToken(): string | undefined {
  return getEnv("SSPA_MCP_TOKEN");
}

export function getAllowedExtensionIds(): string[] {
  const raw = getEnv("SSPA_EXTENSION_IDS");
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

export function getCdpUrl(port: number, clientId?: string): string {
  const id = clientId ?? "default";
  return `ws://127.0.0.1:${port}/cdp/${id}`;
}

export function isLocalhost(address: string): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

// A bind host that keeps the relay reachable only from the local machine.
// Anything else (0.0.0.0, ::, a LAN IP) exposes the browser-control API to the
// network and must require a token before the server is allowed to start.
export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// Optional file sink: the relay is spawned with stdio:'ignore', so without
// this its stderr logs are lost and `spawriter logfile` points at nothing.
let logFilePath: string | null = null;
const LOG_FILE_MAX_BYTES = 5 * 1024 * 1024;

export function enableFileLog(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    try {
      if (fs.statSync(filePath).size > LOG_FILE_MAX_BYTES) fs.truncateSync(filePath, 0);
    } catch { /* file does not exist yet */ }
    logFilePath = filePath;
  } catch {
    logFilePath = null;
  }
}

function writeLine(line: string): void {
  // The relay is often spawned as a child; when its parent exits, the inherited
  // stderr pipe closes and a plain write() throws EPIPE synchronously, which
  // used to crash the process via uncaughtException. Logging must never be able
  // to kill the server, so swallow any stderr write failure.
  try {
    process.stderr.write(line);
  } catch { /* stderr pipe closed (parent gone) — ignore */ }
  if (logFilePath) {
    try {
      fs.appendFileSync(logFilePath, line);
    } catch { /* never let logging break the server */ }
  }
}

export function log(...args: unknown[]): void {
  writeLine(`[SPAWRITER] ${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
}

export function error(...args: unknown[]): void {
  writeLine(`[SPAWRITER ERROR] ${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
}

export function getAgentLabel(): string | undefined {
  return getEnv('SSPA_AGENT_LABEL') || undefined;
}

export function getProjectUrl(): string | undefined {
  return getEnv('SSPA_PROJECT_URL') || undefined;
}

export function generateMcpClientId(): string {
  return `mcp-${process.pid}-${Date.now().toString(36)}`;
}
