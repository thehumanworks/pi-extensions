import { type Request } from "./protocol.ts";
export declare function rpc(request: Request, timeout?: number): Promise<unknown>;
export declare function ensureWorker(): Promise<void>;
export declare function requestWorker(request: Request): Promise<unknown>;
