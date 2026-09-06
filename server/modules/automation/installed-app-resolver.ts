import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';

import { managedInstalledApplicationSchema, managedInstalledBundleIdSchema, type ManagedInstalledApplication } from '../../../shared/herdr-managed-protocol.js';

export type { ManagedInstalledApplication } from '../../../shared/herdr-managed-protocol.js';

// NSWorkspace's read-only all-candidates API (macOS 12+). Never use its preferred-app API.
const LOOKUP_SCRIPT = `ObjC.import('AppKit'); ObjC.import('Foundation');
function run(argv) {
  var urls = $.NSWorkspace.sharedWorkspace.URLsForApplicationsWithBundleIdentifier(argv[0]);
  var paths = [];
  for (var i = 0; i < urls.count; i++) paths.push(ObjC.unwrap(urls.objectAtIndex(i).path));
  return JSON.stringify(paths);
}`;
const MAX_OUTPUT = 1024 * 1024;
const MAX_INFO = 1024 * 1024;
const MAX_EXECUTABLE = 512 * 1024 * 1024;
const MAX_CANDIDATES = 128;
const FAILURE = 'Installed application lookup failed.';

type Runner = (file: string, args: readonly string[], signal: AbortSignal) => Promise<string>;
type FileSystem = { open: typeof open; realpath: typeof realpath; stat: typeof stat };
/** Constructor-only test seam. Production executable, script and argv are fixed below. */
export type InstalledAppResolverDependencies = { runner?: Runner; filesystem?: FileSystem };

const run: Runner = (file, args, signal) => new Promise((resolve, reject) => {
  execFile(file, [...args], { signal, timeout: 5_000, maxBuffer: MAX_OUTPUT, encoding: 'utf8' }, (error, stdout) => {
    if (error) reject(new Error(FAILURE));
    else resolve(stdout);
  });
});

function identity(stats: BigIntStats): string[] {
  return [stats.dev, stats.ino, stats.uid, stats.gid, stats.mode, stats.size, stats.mtimeNs, stats.ctimeNs].map(value => value.toString());
}
function same(left: BigIntStats, right: BigIntStats): boolean {
  return JSON.stringify(identity(left)) === JSON.stringify(identity(right));
}

export class InstalledAppResolver {
  private readonly runner: Runner;
  private readonly fs: FileSystem;

  constructor(dependencies: InstalledAppResolverDependencies = {}) {
    this.runner = dependencies.runner ?? run;
    this.fs = dependencies.filesystem ?? { open, realpath, stat };
  }

  private async command(file: string, args: readonly string[], signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    const result = await this.runner(file, args, signal);
    signal.throwIfAborted();
    if (Buffer.byteLength(result) > MAX_OUTPUT) throw new Error(FAILURE);
    return result;
  }

  private async fingerprintFile(path: string, maximum: number, executable: boolean, signal: AbortSignal) {
    signal.throwIfAborted();
    const handle = await this.fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum)
        || (executable && (before.mode & 0o111n) === 0n)) throw new Error(FAILURE);
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let total = 0;
      while (true) {
        signal.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > maximum) throw new Error(FAILURE);
        hash.update(buffer.subarray(0, bytesRead));
      }
      const after = await handle.stat({ bigint: true });
      const current = await this.fs.stat(path, { bigint: true });
      if (BigInt(total) !== before.size || !same(before, after) || !same(before, current)) throw new Error(FAILURE);
      return { stat: identity(before), hash: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  private async inspect(canonicalPath: string, bundleId: string, signal: AbortSignal): Promise<ManagedInstalledApplication> {
    const bundle = await this.fs.stat(canonicalPath, { bigint: true });
    if (!bundle.isDirectory()) throw new Error(FAILURE);
    const infoPath = join(canonicalPath, 'Contents', 'Info.plist');
    if (await this.fs.realpath(infoPath) !== infoPath) throw new Error(FAILURE);
    const info = await this.fingerprintFile(infoPath, MAX_INFO, false, signal);
    const metadata: unknown = JSON.parse(await this.command('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', infoPath], signal));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error(FAILURE);
    const { CFBundleIdentifier: actualId, CFBundleExecutable: executable, CFBundlePackageType: packageType } = metadata as Record<string, unknown>;
    if (actualId !== bundleId || packageType !== 'APPL' || typeof executable !== 'string'
      || executable.length === 0 || executable.length > 255 || executable === '.' || executable === '..'
      || /[/\\\0]/.test(executable)) throw new Error(FAILURE);
    const executablePath = join(canonicalPath, 'Contents', 'MacOS', executable);
    if (await this.fs.realpath(executablePath) !== executablePath || dirname(executablePath) !== join(canonicalPath, 'Contents', 'MacOS')) throw new Error(FAILURE);
    const binary = await this.fingerprintFile(executablePath, MAX_EXECUTABLE, true, signal);
    // Detect changes during plutil, hashing, and path traversal, not only across approval.
    const infoAfter = await this.fingerprintFile(infoPath, MAX_INFO, false, signal);
    if (JSON.stringify(info) !== JSON.stringify(infoAfter) || !same(bundle, await this.fs.stat(canonicalPath, { bigint: true }))
      || JSON.stringify(binary.stat) !== JSON.stringify(identity(await this.fs.stat(executablePath, { bigint: true })))
      || await this.fs.realpath(canonicalPath) !== canonicalPath
      || await this.fs.realpath(infoPath) !== infoPath || await this.fs.realpath(executablePath) !== executablePath) throw new Error(FAILURE);
    signal.throwIfAborted();
    return managedInstalledApplicationSchema.parse({
      kind: 'cua-installed-application', bundleId, canonicalPath,
      identity: createHash('sha256').update(JSON.stringify({ canonicalPath, bundle: identity(bundle), infoPath, info, executablePath, binary })).digest('hex'),
    });
  }

  async resolve(bundleId: string, signal: AbortSignal): Promise<ManagedInstalledApplication> {
    if (!managedInstalledBundleIdSchema.safeParse(bundleId).success) throw new Error('An exact installed application bundle identifier is required.');
    try {
      const paths: unknown = JSON.parse(await this.command('/usr/bin/osascript', ['-l', 'JavaScript', '-e', LOOKUP_SCRIPT, '--', bundleId], signal));
      if (!Array.isArray(paths) || paths.length > MAX_CANDIDATES) throw new Error(FAILURE);
      if (paths.length === 0) throw new Error('Installed application not found.');
      const candidates = new Set<string>();
      for (const path of paths) {
        signal.throwIfAborted();
        if (typeof path !== 'string' || !path.startsWith('/') || path.length > 4096 || path.includes('\0')) throw new Error(FAILURE);
        const canonical = await this.fs.realpath(path);
        if (!managedInstalledApplicationSchema.shape.canonicalPath.safeParse(canonical).success) throw new Error(FAILURE);
        candidates.add(canonical);
      }
      if (candidates.size !== 1) throw new Error('Installed application is ambiguous.');
      return await this.inspect([...candidates][0], bundleId, signal);
    } catch (error) {
      if (signal.aborted) throw new Error('Installed application lookup cancelled.');
      if (error instanceof Error && ['Installed application not found.', 'Installed application is ambiguous.'].includes(error.message)) throw error;
      throw new Error(FAILURE);
    }
  }

  async revalidate(expected: ManagedInstalledApplication, signal: AbortSignal): Promise<void> {
    const parsed = managedInstalledApplicationSchema.safeParse(expected);
    if (!parsed.success) throw new Error('Invalid installed application binding.');
    const binding = parsed.data;
    const current = await this.resolve(binding.bundleId, signal);
    if (current.canonicalPath !== binding.canonicalPath || current.identity !== binding.identity) {
      throw new Error('Installed application binding changed.');
    }
  }
}
