import { AsyncLocalStorage } from "node:async_hooks";
import { syncBuiltinESMExports } from "node:module";
import timers from "node:timers";
import timersPromises from "node:timers/promises";
import { WorkflowError } from "../errors.ts";

type Claim = (slot: string, key: string, kind: string) => void;
type Scope = { path: string; position: { next: number }; guarded: boolean; signal?: AbortSignal; claim?: Claim };
const scopes = new AsyncLocalStorage<Scope>();
const clock = Date.now.bind(Date);
const random = Math.random.bind(Math);
let installed = false;

/** Guard only authored script code; provider, task and side-effect callbacks run outside it. */
export function installDeterminismGuard(): void {
  if (installed) return;
  installed = true;
  const reject = (name: string) => {
    if (scopes.getStore()?.guarded)
      throw new WorkflowError("nondeterministic_call", `${name} is not replay-safe. Use ctx.now(), ctx.random(), ctx.sleep(), or ctx.step().`);
  };
  const OriginalDate = globalThis.Date;
  globalThis.Date = new Proxy(OriginalDate, {
    construct(target, args, newTarget) {
      if (!args.length) reject("new Date()");
      return Reflect.construct(target, args, newTarget);
    },
    apply(target, thisArg, args) { reject("Date()"); return Reflect.apply(target, thisArg, args); },
    get(target, key, receiver) {
      if (key === "now") return () => { reject("Date.now()"); return clock(); };
      return Reflect.get(target, key, receiver);
    },
  });
  Math.random = () => { reject("Math.random()"); return random(); };
  const timeout = globalThis.setTimeout;
  globalThis.setTimeout = new Proxy(timeout, {
    apply(target, thisArg, args) { reject("setTimeout()"); return Reflect.apply(target, thisArg, args); },
  });
  timers.setTimeout = globalThis.setTimeout;
  const promiseTimeout = timersPromises.setTimeout;
  timersPromises.setTimeout = new Proxy(promiseTimeout, {
    apply(target, thisArg, args) { reject("timers/promises.setTimeout()"); return Reflect.apply(target, thisArg, args); },
  });
  for (const name of ["setInterval", "setImmediate"] as const) {
    const original = globalThis[name];
    const guarded = new Proxy(original, {
      apply(target, thisArg, args) { reject(`${name}()`); return Reflect.apply(target, thisArg, args); },
    });
    Object.assign(globalThis, { [name]: guarded });
    Object.assign(timers, { [name]: guarded });
    const promiseTimer = timersPromises[name];
    Object.assign(timersPromises, { [name]: new Proxy(promiseTimer, {
      apply(target, thisArg, args) { reject(`timers/promises.${name}()`); return Reflect.apply(target, thisArg, args); },
    }) });
  }
  syncBuiltinESMExports();
}

export const wallNow = clock;
export const randomValue = random;

export function scriptScope<T>(path: string, fn: () => T, signal?: AbortSignal, claim?: Claim): T {
  return scopes.run({ path, position: { next: 0 }, guarded: true,
    signal: signal ?? scopes.getStore()?.signal, claim: claim ?? scopes.getStore()?.claim }, fn);
}

export function scopedSignal(fallback: AbortSignal): AbortSignal { return scopes.getStore()?.signal ?? fallback; }

export function outsideScript<T>(fn: () => T): T {
  const scope = scopes.getStore();
  return scope ? scopes.run({ ...scope, guarded: false }, fn) : fn();
}

export function structuralKey(kind: string, explicit?: string): string {
  const scope = scopes.getStore();
  if (!scope) throw new Error("Workflow operation used outside its script.");
  const ordinal = scope.position.next++;
  if (explicit !== undefined && (!explicit || explicit.includes("\0")))
    throw new WorkflowError("invalid_key", "A journal key must be a nonempty string without NUL characters.");
  const key = `${scope.path}/${explicit === undefined ? `${kind}#${ordinal}` : explicit}`;
  // Display keys include the operation name, but identity is the call's ordinal.
  // Otherwise changing an agent into a sleep would silently create a new key.
  scope.claim?.(`${scope.path}/${ordinal}`, key, kind);
  return key;
}
