// Writes openapi.json at the package root, so the description ships with the package and
// clients can be generated without starting the server. Run by `npm run build`.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openapiDocument } from "./openapi.ts";

const root = new URL("../../", import.meta.url);
const { version } = JSON.parse(await readFile(new URL("package.json", root), "utf8")) as { version: string };
const target = fileURLToPath(new URL("openapi.json", root));
await writeFile(target, `${JSON.stringify(openapiDocument(version), null, 2)}\n`);
console.log(`wrote ${target}`);
