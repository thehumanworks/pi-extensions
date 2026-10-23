import { readFile } from 'node:fs/promises';
import { hash, obj, pointer, type Obj, type Product } from './util.ts';
export interface Operation {
  operationId: string; product: Product; method: string; path: string; summary: string; write: boolean; deprecated: boolean; docs: string;
}
export interface OperationDetails extends Operation {
  apiPath?: string; parameters?: Obj[]; requestBody?: Obj; responses?: Obj;
}
const root = new URL('../docs/catalog/', import.meta.url);
let indexPromise: Promise<Operation[]> | undefined;
export function catalog(): Promise<Operation[]> {
  return indexPromise ??= readFile(new URL('index.json', root), 'utf8').then(s => JSON.parse(s) as Operation[]);
}
export async function operation(p: Product, operationId: string): Promise<OperationDetails> {
  const match = (await catalog()).find(x => x.product === p && x.operationId === operationId);
  if (!match) throw new Error('Unknown operationId; use discover kind=operations');
  return JSON.parse(await readFile(new URL(`${p}/operations/${hash(operationId)}.json`, root), 'utf8')) as OperationDetails;
}
export async function byRoute(p: Product, method: string, path: string): Promise<OperationDetails> {
  const match = (await catalog()).find(x => x.product === p && x.method === method && (x.path === path || (p === 'confluence' && '/wiki/api/v2' + x.path === path)) && !x.deprecated);
  if (!match) throw new Error(`Unsupported or deprecated ${p} operation: ${method} ${path}`);
  return operation(p, match.operationId);
}
export async function resolve(p: Product, ref: string): Promise<unknown> {
  const m = /^#\/components\/([A-Za-z]+)\/([^/]+)(\/.*)?$/.exec(ref);
  if (!m) throw new Error('Only local component schema references are supported; remote refs forbidden');
  const name = m[2]!.replace(/~1/g, '/').replace(/~0/g, '~');
  try {
    const value: unknown = JSON.parse(await readFile(new URL(`${p}/${m[1]}/${hash(name)}.json`, root), 'utf8'));
    return m[3] ? pointer(value, m[3]) : value;
  } catch { throw new Error('Unknown local schema reference'); }
}
export async function deref(p: Product, value: Obj): Promise<Obj> {
  return typeof value.$ref === 'string' ? obj(await resolve(p, value.$ref)) : value;
}
/** Structural validation only: types, enums, required properties and allOf; not full JSON Schema. */
export async function validate(p: Product, schemaValue: Obj, value: unknown, label: string, depth = 0): Promise<void> {
  if (depth > 24) throw new Error('Payload schema nesting exceeds supported validation depth');
  const schema = await deref(p, schemaValue);
  if (value === null && schema.nullable === true) return;
  const type = schema.type;
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) throw new Error(`${label} must be an object`);
  if (type === 'array' && !Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (type === 'string' && typeof value !== 'string') throw new Error(`${label} must be a string`);
  if ((type === 'integer' || type === 'number') && (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value)))) throw new Error(`${label} must be ${type}`);
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) throw new Error(`${label} is not an allowed enum value`);
  if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum) || (typeof schema.maximum === 'number' && value > schema.maximum))) throw new Error(`${label} exceeds schema bounds`);
  if (Array.isArray(schema.required)) for (const k of schema.required) if (typeof k === 'string' && !Object.hasOwn(obj(value), k)) throw new Error(`Required ${label}.${k} missing`);
  if (Array.isArray(schema.allOf)) for (const s of schema.allOf) await validate(p, obj(s), value, label, depth + 1);
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) for (const [k, s] of Object.entries(obj(schema.properties))) if (Object.hasOwn(value, k)) await validate(p, obj(s), obj(value)[k], `${label}.${k}`, depth + 1);
  if (Array.isArray(value) && schema.items) for (const v of value) await validate(p, obj(schema.items), v, `${label}[]`, depth + 1);
}
