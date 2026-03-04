export declare const VERSION = 1;
export interface ForwardCDPCommand {
    id: number;
    method: string;
    params: {
        method: string;
        sessionId?: string;
        params?: Record<string, unknown>;
    };
}
export interface ExtensionResponseMessage {
    id: number;
    method?: undefined;
    result?: unknown;
    error?: string;
}
export interface ExtensionEventMessage {
    id?: undefined;
    method: string;
    params: {
        method: string;
        sessionId?: string;
        params?: Record<string, unknown>;
    };
}
export interface ExtensionLogMessage {
    id?: undefined;
    method: string;
    params: {
        level: 'log' | 'debug' | 'info' | 'warn' | 'error';
        args: string[];
    };
}
export interface ExtensionPongMessage {
    id?: undefined;
    method: string;
}
export interface ServerPingMessage {
    method: string;
    id?: undefined;
}
export type ExtensionMessage = ExtensionResponseMessage | ExtensionEventMessage | ExtensionLogMessage | ExtensionPongMessage;
export type ExtensionCommand = ForwardCDPCommand;
export interface CDPCommand {
    id: number;
    method: string;
    params?: Record<string, unknown>;
}
export interface CDPResponse {
    id: number;
    result?: Record<string, unknown>;
    error?: {
        code: number;
        message: string;
    };
}
export interface CDPEvent {
    method: string;
    params?: Record<string, unknown>;
}
//# sourceMappingURL=protocol.d.ts.map