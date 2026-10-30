import type { TSchema } from "typebox";
import { Value } from "typebox/value";

/** One line per schema violation, naming the JSON pointer, the rule and the offending value. */
export function mismatchLines(schema: TSchema, value: unknown, label: string): string[] {
  return [...Value.Errors(schema, value)].slice(0, 10).map(error => {
    const got = error.instancePath.split("/").slice(1)
      .reduce<unknown>((current, key) => (current as Record<string, unknown> | undefined)?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], value);
    return `${label}${error.instancePath}: ${error.message} (got ${JSON.stringify(got) ?? "undefined"})`;
  });
}

/** Explains why a signal value does not match the schema its waiting step declared. */
export function signalMismatch(key: string, schema: TSchema, value: unknown): string {
  const hint = typeof value === "string" ? " Pass the JSON value itself, not a JSON-encoded string." : "";
  return `Signal '${key}' expects ${JSON.stringify(schema)}; got ${JSON.stringify(value)}.${hint}\n${mismatchLines(schema, value, "value").join("\n")}`.slice(0, 2000);
}
