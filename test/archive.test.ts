import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { canonical, readCaptures, snapshotCaptures, writeJson } from '../src/archive.ts';

function paths(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'ir-eval-archive-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  mkdirSync(source);
  return { source, destination: join(root, 'archive') };
}

test('archives unrecognized and malformed capture bytes without parsing them', t => {
  const { source, destination } = paths(t);
  const malformed = Buffer.from([0xff, 0x7b, 0x0a]);
  writeFileSync(join(source, 'malformed.json'), malformed);
  writeFileSync(join(source, 'unrecognized.dat'), 'abc');

  const hashes = snapshotCaptures(source, destination);

  assert.equal(hashes['unrecognized.dat'], 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.deepEqual(readCaptures(destination, hashes), new Map([
    ['malformed.json', malformed],
    ['unrecognized.dat', Buffer.from('abc')],
  ]));
});

test('capture source refuses symbolic links', t => {
  const { source, destination } = paths(t);
  const outside = join(source, '..', 'outside.json');
  writeFileSync(outside, '{}');
  symlinkSync(outside, join(source, 'linked.json'));

  assert.throws(() => snapshotCaptures(source, destination), /regular file/);
});

test('recompute refuses an archived capture whose bytes changed', t => {
  const { source, destination } = paths(t);
  writeFileSync(join(source, 'result.json'), '{}');
  const hashes = snapshotCaptures(source, destination);
  writeFileSync(join(destination, 'result.json'), '[]');

  assert.throws(() => readCaptures(destination, hashes), /hash mismatch: result.json/);
});

test('recompute refuses a symbolic link even when its target bytes match', t => {
  const { source, destination } = paths(t);
  const original = join(source, 'result.json');
  writeFileSync(original, '{}');
  const hashes = snapshotCaptures(source, destination);
  const archived = join(destination, 'result.json');
  rmSync(archived);
  symlinkSync(original, archived);

  assert.throws(() => readCaptures(destination, hashes), /regular file/);
});

test('recompute refuses an archive with extra or missing captures', t => {
  const { source, destination } = paths(t);
  writeFileSync(join(source, 'result.json'), '{}');
  const hashes = snapshotCaptures(source, destination);

  const extra = join(destination, 'extra.json');
  writeFileSync(extra, '{}');
  assert.throws(() => readCaptures(destination, hashes), /inventory mismatch/);
  rmSync(extra);
  rmSync(join(destination, 'result.json'));
  assert.throws(() => readCaptures(destination, hashes), /inventory mismatch/);
});

test('capture filenames reject whitespace and control characters', t => {
  const { source, destination } = paths(t);
  writeFileSync(join(source, 'looks-safe.json\n'), '{}');

  assert.throws(() => snapshotCaptures(source, destination), /Unsafe capture filename/);
});

test('canonical JSON sorts object keys recursively and preserves array order', () => {
  assert.equal(canonical({ z: [2, { b: 0, a: '"' }, 1], 2: false, 10: null }),
    '{"10":null,"2":false,"z":[2,{"a":"\\\"","b":0},1]}');
});

test('writing a frozen JSON record twice preserves the first write', t => {
  const { source } = paths(t);
  const file = join(source, 'manifest.json');
  writeJson(file, { version: 1 });

  assert.throws(() => writeJson(file, { version: 2 }), { code: 'EEXIST' });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1 });
});

test('snapshot never creates an archive inside the original captures', t => {
  const { source } = paths(t);
  const nested = join(source, 'archive');
  writeFileSync(join(source, 'result.json'), '{}');

  assert.throws(() => snapshotCaptures(source, nested), /inside the source/);
});
