#!/usr/bin/env node
// Build a streaming-LOD `.rad` from a source splat (`.spz` / `.ply` / …) using Spark's
// `build-lod` tool, and drop it in `public/`. The runtime loads the `.rad` with paged
// streaming (see src/world.ts), so the big splat streams coarse-to-fine over HTTP Range
// requests instead of blocking the first frame on a full download.
//
// Spark's `build-lod` is a Rust binary that isn't published to npm, so this wrapper finds
// it one of three ways (first hit wins):
//   1. $SPARK_BUILD_LOD        — path to a prebuilt `build-lod` binary
//   2. tools/build-lod         — a binary vendored into this repo
//   3. $SPARK_DIR              — a Spark checkout; we `cargo run` its build-lod crate
//
// Usage:  node scripts/build-lod.mjs [input] [--quick|--quality] [extra build-lod args…]
//         (default input: public/attic.spz; default method: --quality)

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const input = resolve(repoRoot, args.find((a) => !a.startsWith('-')) ?? 'public/attic.spz');
const passthrough = args.filter((a) => a.startsWith('-'));
if (!passthrough.some((a) => a === '--quick' || a === '--quality')) passthrough.push('--quality');

if (!existsSync(input)) {
    console.error(`input splat not found: ${input}`);
    process.exit(1);
}

// build-lod writes `<name>-lod.rad` right next to its input, so pointing it at
// public/attic.spz drops public/attic-lod.rad in place.
function run(cmd, cmdArgs) {
    console.log(`> ${cmd} ${cmdArgs.join(' ')}`);
    execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
}

const vendored = join(repoRoot, 'tools', process.platform === 'win32' ? 'build-lod.exe' : 'build-lod');
const envBin = process.env.SPARK_BUILD_LOD;
const sparkDir = process.env.SPARK_DIR;

if (envBin && existsSync(envBin)) {
    run(envBin, [input, ...passthrough]);
} else if (existsSync(vendored)) {
    run(vendored, [input, ...passthrough]);
} else if (sparkDir && existsSync(join(sparkDir, 'rust', 'Cargo.toml'))) {
    run('cargo', [
        'run',
        '--release',
        '--manifest-path',
        join(sparkDir, 'rust', 'build-lod', 'Cargo.toml'),
        '--',
        input,
        ...passthrough,
    ]);
} else {
    console.error(
        [
            'Could not find Spark’s build-lod tool. Provide one of:',
            '  - $SPARK_BUILD_LOD = path to a prebuilt build-lod binary',
            '  - tools/build-lod  = vendor the binary into this repo',
            '  - $SPARK_DIR       = a Spark checkout (https://github.com/sparkjsdev/spark); we cargo-run it',
            '',
            'To build it once from a Spark checkout:',
            '  git clone https://github.com/sparkjsdev/spark',
            '  cd spark/rust && cargo build --release -p build-lod',
            '  # then: SPARK_BUILD_LOD=spark/rust/target/release/build-lod pnpm build:lod',
        ].join('\n'),
    );
    process.exit(1);
}

const dest = join(dirname(input), `${basename(input, extname(input))}-lod.rad`);
if (!existsSync(dest)) {
    console.error(`build-lod ran but ${dest} was not produced`);
    process.exit(1);
}
console.log(`\nwrote ${dest}`);
