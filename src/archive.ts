import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function digest(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`;
  if (typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  throw new Error('Cannot canonicalize non-JSON data');
}

export function writeJson(path: string, value: unknown): void {
  const json = JSON.stringify(value, null, 2);
  if (json === undefined) throw new Error('Cannot write non-JSON data');
  writeFileSync(path, `${json}\n`, { flag: 'wx', mode: 0o600 });
}

function listCaptures(dir: string): string[] {
  if (!lstatSync(dir).isDirectory()) throw new Error('Capture root must be a regular directory');
  const names = readdirSync(dir).sort();
  if (names.some(name => /[^A-Za-z0-9._-]/u.test(name))) throw new Error('Unsafe capture filename');
  return names;
}

function readCapture(dir: string, name: string): Buffer {
  const path = join(dir, name);
  if (!lstatSync(path).isFile()) throw new Error(`Capture is not a regular file: ${name}`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error(`Capture is not a regular file: ${name}`);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function snapshotCaptures(source: string, destination: string): Record<string, string> {
  source = resolve(source);
  const names = listCaptures(source);
  destination = resolve(destination);
  const destinationParent = relative(realpathSync(source), realpathSync(dirname(destination)));
  if (!isAbsolute(destinationParent) && destinationParent !== '..' && !destinationParent.startsWith(`..${sep}`)) {
    throw new Error('Capture archive cannot be inside the source directory');
  }
  mkdirSync(destination, { mode: 0o700 });
  return Object.fromEntries(names.map(name => {
    const bytes = readCapture(source, name);
    writeFileSync(join(destination, name), bytes, { flag: 'wx', mode: 0o600 });
    return [name, digest(bytes)];
  }));
}

export function readCaptures(dir: string, expected: Record<string, string>): Map<string, Buffer> {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw new Error('Invalid capture inventory');
  dir = resolve(dir);
  const names = listCaptures(dir);
  const frozenNames = Object.keys(expected).sort();
  if (names.length !== frozenNames.length || names.some((name, index) => name !== frozenNames[index])) {
    throw new Error('Capture inventory mismatch');
  }
  return new Map(names.map(name => {
    const bytes = readCapture(dir, name);
    if (digest(bytes) !== expected[name]) throw new Error(`Capture hash mismatch: ${name}`);
    return [name, bytes];
  }));
}
