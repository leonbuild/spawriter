export const VERSION = "1.0.0";
export const DEFAULT_PORT = 19989;
export function getEnv(key, defaultValue) {
    return process.env[key] ?? defaultValue;
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
export function getRelayPort() {
    const port = getEnv("SSPA_MCP_PORT");
    return port ? parseInt(port, 10) : DEFAULT_PORT;
}
export function getRelayToken() {
    return getEnv("SSPA_MCP_TOKEN");
}
export function getAllowedExtensionIds() {
    const raw = getEnv("SSPA_EXTENSION_IDS");
    if (!raw) {
        return [];
    }
    return raw
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0);
}
export function getCdpUrl(port, clientId) {
    const id = clientId ?? "default";
    return `ws://127.0.0.1:${port}/cdp/${id}`;
}
export function getExtensionUrl(port) {
    return `ws://127.0.0.1:${port}/extension`;
}
export function isLocalhost(address) {
    return (address === "127.0.0.1" ||
        address === "::1" ||
        address === "::ffff:127.0.0.1");
}
export function log(...args) {
    process.stderr.write(`[SPAWRITER] ${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
}
export function error(...args) {
    process.stderr.write(`[SPAWRITER ERROR] ${new Date().toISOString()} ${args.map(String).join(' ')}\n`);
}
export function getAgentLabel() {
    return getEnv('SSPA_AGENT_LABEL') || undefined;
}
export function getProjectUrl() {
    return getEnv('SSPA_PROJECT_URL') || undefined;
}
export function generateMcpClientId() {
    return `mcp-${process.pid}-${Date.now().toString(36)}`;
}
//# sourceMappingURL=utils.js.map