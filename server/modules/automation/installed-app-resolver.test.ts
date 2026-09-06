import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, realpath, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { herdrManagedTargetBindingSchema } from '../../../shared/herdr-managed-protocol.js';

import { InstalledAppResolver } from './installed-app-resolver.js';

const bundleId = 'org.example.ManagedTest';
const signal = () => new AbortController().signal;

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'installed-resolver-')));
  const app = join(root, 'Example.app');
  const info = join(app, 'Contents', 'Info.plist');
  const executable = join(app, 'Contents', 'MacOS', 'Example');
  await mkdir(join(app, 'Contents', 'MacOS'), { recursive: true });
  await writeFile(info, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.example.ManagedTest</string><key>CFBundleExecutable</key><string>Example</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  await writeFile(executable, 'test executable bytes');
  await chmod(executable, 0o755);
  let paths = [app];
  let metadata: Record<string, unknown> = { CFBundleIdentifier: bundleId, CFBundleExecutable: 'Example', CFBundlePackageType: 'APPL' };
  const calls: { file: string; args: readonly string[] }[] = [];
  const resolver = new InstalledAppResolver({ runner: async (file, args) => {
    calls.push({ file, args });
    if (file === '/usr/bin/osascript') return JSON.stringify(paths);
    assert.equal(file, '/usr/bin/plutil');
    assert.deepEqual(args, ['-convert', 'json', '-o', '-', '--', info]);
    return JSON.stringify(metadata);
  } });
  return { root, app, info, executable, calls, resolver, setPaths: (value: string[]) => { paths = value; },
    setMetadata: (value: Record<string, unknown>) => { metadata = value; }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('exact bundle ID uses fixed read-only program, binds a canonical app and strictly parses private target', async () => {
  const f = await fixture();
  try {
    const binding = await f.resolver.resolve(bundleId, signal());
    assert.equal(binding.canonicalPath, f.app);
    assert.equal(binding.bundleId, bundleId);
    assert.match(binding.identity, /^[a-f0-9]{64}$/);
    assert.deepEqual(herdrManagedTargetBindingSchema.parse(binding), binding);
    assert.equal(herdrManagedTargetBindingSchema.safeParse({ ...binding, name: 'Example' }).success, false);
    assert.equal(herdrManagedTargetBindingSchema.safeParse({ ...binding, canonicalPath: '/a/../Example.app' }).success, false);
    await f.resolver.revalidate(binding, signal());
    const lookup = f.calls[0];
    assert.equal(lookup.file, '/usr/bin/osascript');
    assert.deepEqual(lookup.args.slice(0, 3), ['-l', 'JavaScript', '-e']);
    assert.deepEqual(lookup.args.slice(4), ['--', bundleId]);
    assert.ok(lookup.args[3].includes('URLsForApplicationsWithBundleIdentifier'));
    assert.ok(!lookup.args[3].includes(bundleId));
    assert.ok(f.calls.every(call => ['/usr/bin/osascript', '/usr/bin/plutil'].includes(call.file)));
    assert.ok(!lookup.args[3].includes('launchApplication'));
  } finally { await f.cleanup(); }
});

test('name-only, path, malformed and injected bundle IDs reject before any OS call', async () => {
  const f = await fixture();
  try {
    for (const id of ['', 'Example', '/Applications/Example.app', ' org.example.App', 'org.example.App;doShellScript()', 'org.example.App\n', undefined]) {
      await assert.rejects(f.resolver.resolve(id as string, signal()), /exact.*bundle identifier/);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.cleanup(); }
});

test('absence and distinct candidate ambiguity fail closed; canonical symlink duplicates deduplicate', async () => {
  const f = await fixture();
  try {
    f.setPaths([]);
    await assert.rejects(f.resolver.resolve(bundleId, signal()), /not found/);
    const alias = join(f.root, 'Alias.app');
    await symlink(f.app, alias);
    f.setPaths([f.app, alias, f.app]);
    assert.equal((await f.resolver.resolve(bundleId, signal())).canonicalPath, f.app);
    const other = join(f.root, 'Other.app');
    await mkdir(other);
    f.setPaths([f.app, other]);
    await assert.rejects(f.resolver.resolve(bundleId, signal()), /ambiguous/);
  } finally { await f.cleanup(); }
});

test('actual metadata must match exact ID and safe executable name', async () => {
  const f = await fixture();
  try {
    for (const metadata of [
      { CFBundleIdentifier: 'org.example.Other', CFBundleExecutable: 'Example', CFBundlePackageType: 'APPL' },
      { CFBundleIdentifier: bundleId, CFBundleExecutable: '../Example', CFBundlePackageType: 'APPL' },
      { CFBundleIdentifier: bundleId, CFBundleExecutable: 'Example', CFBundlePackageType: 'BNDL' },
    ]) {
      f.setMetadata(metadata);
      await assert.rejects(f.resolver.resolve(bundleId, signal()), /lookup failed/);
    }
  } finally { await f.cleanup(); }
});

for (const mutation of ['info-content', 'executable-content', 'executable-replaced', 'info-replaced', 'bundle-replaced', 'executable-removed', 'non-executable', 'symlink-executable'] as const) {
  test(`revalidation refuses ${mutation}`, async () => {
    const f = await fixture();
    try {
      const binding = await f.resolver.resolve(bundleId, signal());
      if (mutation === 'info-content') await writeFile(f.info, 'changed metadata');
      if (mutation === 'executable-content') await writeFile(f.executable, 'changed executable');
      if (mutation === 'executable-replaced' || mutation === 'info-replaced') {
        const path = mutation === 'info-replaced' ? f.info : f.executable;
        await rename(path, `${path}.old`);
        await writeFile(path, 'replacement');
        await chmod(path, 0o755);
      }
      if (mutation === 'bundle-replaced') {
        await rename(f.app, `${f.app}.old`);
        await mkdir(join(f.app, 'Contents', 'MacOS'), { recursive: true });
        await rename(join(`${f.app}.old`, 'Contents', 'Info.plist'), f.info);
        await rename(join(`${f.app}.old`, 'Contents', 'MacOS', 'Example'), f.executable);
      }
      if (mutation === 'executable-removed') await rm(f.executable);
      if (mutation === 'non-executable') await chmod(f.executable, 0o644);
      if (mutation === 'symlink-executable') {
        await rename(f.executable, `${f.executable}.old`);
        await symlink(`${f.executable}.old`, f.executable);
      }
      await assert.rejects(f.resolver.revalidate(binding, signal()), /changed|lookup failed/);
    } finally { await f.cleanup(); }
  });
}

test('revalidation also repeats registry resolution, rejecting new ambiguity', async () => {
  const f = await fixture();
  try {
    const binding = await f.resolver.resolve(bundleId, signal());
    const other = join(f.root, 'Other.app');
    await mkdir(other);
    f.setPaths([f.app, other]);
    await assert.rejects(f.resolver.revalidate(binding, signal()), /ambiguous/);
  } finally { await f.cleanup(); }
});

test('cancelled, malformed, oversized and private OS failures are sanitized', async () => {
  for (const output of ['not json', '{}', JSON.stringify(['/private/secret/Missing.app']), ' '.repeat(1024 * 1024 + 1)]) {
    const resolver = new InstalledAppResolver({ runner: async () => output });
    await assert.rejects(resolver.resolve(bundleId, signal()), error => error instanceof Error && error.message === 'Installed application lookup failed.');
  }
  const resolver = new InstalledAppResolver({ runner: async () => { throw new Error('/private/secret registry dump'); } });
  await assert.rejects(resolver.resolve(bundleId, signal()), error => error instanceof Error && !error.message.includes('private'));
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(resolver.resolve(bundleId, aborted.signal), /cancelled/);
});
