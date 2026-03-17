export declare const VERSION = "1.0.0";
export declare const DEFAULT_PORT = 19989;
export declare function getEnv(key: string, defaultValue?: string): string | undefined;
export declare function sleep(ms: number): Promise<void>;
export declare function getRelayPort(): number;
export declare function getRelayToken(): string | undefined;
export declare function getAllowedExtensionIds(): string[];
export declare function getCdpUrl(port: number, clientId?: string): string;
export declare function getExtensionUrl(port: number): string;
export declare function isLocalhost(address: string): boolean;
export declare function log(...args: unknown[]): void;
export declare function error(...args: unknown[]): void;
export declare function getAgentLabel(): string | undefined;
export declare function getProjectUrl(): string | undefined;
export declare function generateMcpClientId(): string;
//# sourceMappingURL=utils.d.ts.map