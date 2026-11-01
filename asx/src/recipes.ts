import type { WorkflowContext } from "./index.ts";

export interface DagNode<T> {
  dependsOn?: string[];
  run: (deps: Record<string, unknown>) => Promise<T>;
  label?: string;
  phase?: string;
}
export type DagResult<N> = N extends DagNode<infer T> ? T : never;

/** Start every node as soon as its dependencies settle; validate the whole graph first. */
export async function dag<N extends Record<string, DagNode<unknown>>>(ctx: WorkflowContext, nodes: N): Promise<{ [K in keyof N]: DagResult<N[K]> | null }> {
  const names = Object.keys(nodes);
  const visited = new Set<string>();
  const visiting = new Set<string>();
  function visit(name: string): void {
    if (!Object.hasOwn(nodes, name)) throw new Error(`DAG dependency '${name}' does not exist.`);
    if (visiting.has(name)) throw new Error(`DAG cycle includes '${name}'.`);
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dependency of nodes[name].dependsOn ?? []) visit(dependency);
    visiting.delete(name); visited.add(name);
  }
  for (const name of names) visit(name);
  const completions = new Map<string, { promise: Promise<unknown>; resolve(value: unknown): void }>();
  for (const name of names) {
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>(done => { resolve = done; });
    completions.set(name, { promise, resolve });
  }
  const results = await ctx.parallel(names.map(name => async () => {
    let result: unknown = null;
    try {
      const dependencies = nodes[name].dependsOn ?? [];
      const values = await Promise.all(dependencies.map(dep => completions.get(dep)!.promise));
      if (values.some(value => value === null)) return null;
      result = await nodes[name].run(Object.fromEntries(dependencies.map((dep, index) => [dep, values[index]])));
      return result;
    } finally { completions.get(name)!.resolve(result); }
  }));
  return Object.fromEntries(names.map((name, index) => [name, results[index]])) as { [K in keyof N]: DagResult<N[K]> | null };
}

export async function bestOf<T>(
  ctx: WorkflowContext,
  n: number,
  generate: (index: number) => Promise<T>,
  select: { judge: (candidates: Array<T | null>) => Promise<number> } | { score: (candidate: T, index: number) => Promise<number> | number; pick?: "max" | "min" },
): Promise<{ winner: T; winnerIndex: number; candidates: Array<T | null> }> {
  if (!Number.isSafeInteger(n) || n < 1) throw new Error("bestOf requires a positive integer candidate count.");
  const candidates = await ctx.parallel(Array.from({ length: n }, (_, index) => () => generate(index)));
  let winnerIndex = -1;
  if ("judge" in select) winnerIndex = await select.judge(candidates);
  else {
    let winningScore = select.pick === "min" ? Infinity : -Infinity;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      if (candidate === null) continue;
      const score = await select.score(candidate, index);
      if (!Number.isFinite(score)) throw new Error(`bestOf scorer returned a non-finite score for candidate ${index}.`);
      if (winnerIndex === -1 || (select.pick === "min" ? score < winningScore : score > winningScore)) {
        winningScore = score; winnerIndex = index;
      }
    }
  }
  if (!Number.isInteger(winnerIndex) || winnerIndex < 0 || winnerIndex >= n || candidates[winnerIndex] === null) {
    throw new Error(`bestOf selected unavailable candidate ${winnerIndex}. Select a successful candidate index.`);
  }
  return { winner: candidates[winnerIndex] as T, winnerIndex, candidates };
}

export async function untilDry<T>(ctx: WorkflowContext, round: (seen: ReadonlySet<string>, roundIndex: number) => Promise<T[]>, options: { keyOf: (item: T) => string; consecutiveEmpty?: number; maxRounds?: number }): Promise<T[]> {
  const consecutiveEmpty = options.consecutiveEmpty ?? 2;
  const maxRounds = options.maxRounds ?? 20;
  if (![consecutiveEmpty, maxRounds].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error("untilDry limits must be positive integers.");
  const seen = new Set<string>();
  const findings: T[] = [];
  let empty = 0;
  for (let index = 0; index < maxRounds && empty < consecutiveEmpty; index++) {
    // A single indexed branch gives each round a stable structural scope.
    const [items] = await ctx.parallel([() => round(new Set(seen), index)], { failure: "failFast" });
    let added = 0;
    for (const item of items ?? []) {
      const key = options.keyOf(item);
      if (seen.has(key)) continue;
      seen.add(key); findings.push(item); added++;
    }
    empty = added === 0 ? empty + 1 : 0;
  }
  return findings;
}
