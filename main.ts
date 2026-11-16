// Token Launch Radar — the entrypoint (token-radar-01, model radar-3).
//
// Snapshot in, board + dashboard out. The snapshot is the only input: every
// figure on the board — the family fits, the backtest, the implied values, the
// verdicts, the farm plans — is computed from that snapshot at run time. No
// protocol is special-cased, no intercept or slope is hand-written, and nothing
// here reaches the network.
//
// Pipeline
// --------
//   1. Parse. --input takes a snapshot.json file or the directory holding it;
//      inside the grader's container the sealed file is /input. parseSnapshot
//      (lib/model.ts) refuses anything that is not the shape the model scores,
//      so a bad input fails here, loudly, instead of producing a board that
//      looks right and is not.
//   2. Score. buildRadar (lib/model.ts) fits one log-log pricing line per
//      family on the snapshot's live-token protocols, validates the fit with a
//      5-fold backtest, ranks every watchlist slug plus the early radar plus
//      two extended rows by implied value, and prices one ordinary farm per
//      row into a FARM / THIN / SKIP verdict net of gas, time and slippage.
//      boardIssue refuses a board that misses a watchlist slug, has a broken
//      rank order, or gives every row the same implied value.
//   3. Write. /output/board.json (the ranked rows), /output/data.js (the same
//      board as one script the dashboard reads, no fetch and no network), a
//      copy of dashboard/ and screenshots/ from this repository, and
//      /output/dossier.json last — the scorer rebuilds the dossier from
//      /output and compares bytes, so it must be written after everything it
//      describes.
//   4. Report. One line on stdout names the counts (protocols, watchlist,
//      rows scored, early and extended rows, live set aside, verdict split)
//      and the files written.
//
// Running it
// ----------
//   node main.ts --input <snapshot.json|directory>
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
//
// Outside the grader's container MAKEFUN_OUTPUT_DIR stands in for /output.
// The dashboard is a static page and must stay small: the gate caps its text
// at 64 KiB (TEXT_MAX_BYTES) and its screenshots at 4 images of 512 KiB each.
// Exit codes: 0 on success, 1 when the model wrote a board the gate refuses
// or the screenshots are short, 2 when the snapshot file is missing.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps: the text cap shapes the bytes, the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** --name <value> out of the arguments, or the fallback. */
function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(radar));

/** Copy one directory's regular files into `to`, skipping names that start with a dot. */
function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

const dashFiles = copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} image${shots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// The dossier is written last: the scorer rebuilds it from this /output and compares bytes.
writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

const bt = radar.backtest;
process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.extended_size} extended, ${radar.live_size} live set aside)\n` +
    `token radar: verdicts FARM ${radar.verdict_counts.FARM}, THIN ${radar.verdict_counts.THIN}, SKIP ${radar.verdict_counts.SKIP}; backtest log-r ${bt.log_correlation}, median error ${bt.median_abs_pct_error}%, within 2x ${Math.round(bt.hit_within_2x * 100)}% (flat baseline ${bt.flat_median_abs_pct_error}% / ${Math.round(bt.flat_hit_within_2x * 100)}%)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (${dashFiles.length} files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

// Run note: the program is deterministic — the same snapshot always writes the
// same board, the same data.js and the same dossier, byte for byte. The page
// recomputes every row's implied value from the family fits in data.js, so the
// page, the board and the model never drift apart.
