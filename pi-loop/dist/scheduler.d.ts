import type { Models } from "@earendil-works/pi-ai";
import { Harness, type ConversationId, type TaskId, type Storage } from "@earendil-works/pi-durable";
import { type CreateRequest, type Request } from "./protocol.ts";
type Run = {
    due: number;
    finishedAt: number;
    conversationId: ConversationId;
    status: string;
    output: string;
};
export type Schedule = {
    id: string;
    requestId: string;
    frequency: string;
    interval: number;
    prompt: string;
    cwd: string;
    model: CreateRequest["model"];
    thinkingLevel: CreateRequest["thinkingLevel"];
    createdAt: number;
    nextRunAt: number;
    status: "active" | "paused" | "deleted";
    taskId: TaskId | null;
    runs: Run[];
};
type State = {
    schedules: Record<string, Schedule>;
};
export declare const Schedules: import("@earendil-works/pi-durable").SessionDocToken<State>;
type TickState = {
    phase: "sleep";
    due: number;
} | {
    phase: "run";
    due: number;
    conversationId: ConversationId;
};
export declare const LoopTask: import("@earendil-works/pi-durable").Task<{
    id: string;
    due: number;
}, TickState, null, object>;
export type Scheduler = {
    harness: Harness;
    request(request: Request): Promise<unknown>;
    close(): Promise<void>;
};
export declare function openScheduler(storage: Storage, models: Models): Promise<Scheduler>;
export {};
