export declare const PROTOCOL_VERSION = 1;
export declare const MAX_REQUEST_BYTES: number;
export declare function intervalMs(frequency: string): number;
export declare function parseLoop(text: string): {
    frequency: string;
    task: string;
};
/** Fixed cadence; coalesce missed ticks instead of replaying a backlog. */
export declare function nextDue(previous: number, interval: number, now: number): number;
export type CreateRequest = {
    action: "create";
    requestId: string;
    frequency: string;
    prompt: string;
    cwd: string;
    model: {
        provider: string;
        modelId: string;
    };
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};
export type Request = CreateRequest | {
    action: "ping";
} | {
    action: "list";
} | {
    action: "stop";
} | {
    action: "show" | "pause" | "resume" | "delete";
    id: string;
};
export declare function validateRequest(value: unknown): Request;
