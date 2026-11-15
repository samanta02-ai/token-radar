// Token Launch Radar — the entrypoint (token-radar-01, model radar-2).
//
// What this program does
// ----------------------
// It turns one sealed snapshot of the protocol universe into a ranked board of
// pre-token protocols worth farming, plus a static dashboard that shows the same
// board. The snapshot is the only input: every figure on the board — the
// category multiples, the implied values, the ranks, the farm plans — is computed
// from that snapshot at run time. No protocol is special-cased, no multiple is
// hand-written, and nothing here reaches the network.
//
// Pipeline (snapshot in, board + dashboard out)
// --------------------------------------------
//   1. Parse the snapshot.  --input takes a snapshot.json file or the directory
//      holding it; inside the grader's container the sealed file is /input.
//      parseSnapshot (lib/model.ts) refuses anything that is not the shape the
//      model scores, so a bad input fails here, loudly, instead of producing
//      a board that looks right and is not.
//   2. Score.  buildRadar (lib/model.ts) ranks every watchlist slug plus the
//      early radar — pre-token protocols below the watchlist floor that pass the
//      house's own exclusion rule — by implied value under the radar-2 model
//      (category multiple x TVL, adjusted for 7-day growth, age maturity and
//      chain breadth; see the header of lib/model.ts for the arithmetic).
//      boardIssue refuses a board that misses a watchlist slug, has a broken
//      rank order, or gives every row the same implied value.
//   3. Write.  /output/board.json (the ranked rows), /output/data.js (the same
//      board as one script the dashboard reads, no fetch and no network), a copy
//      of dashboard/ and screenshots/ from this repository, and /output/dossier.json
//      last — the scorer rebuilds the dossier from /output and compares bytes,
//      so it must be written after everything it describes.
//   4. Report.  One line on stdout names the counts (protocols, watchlist,
//      rows scored, early and live set aside) and the files written.
//
// Running it
// ----------
//   node main.ts --input <snapshot.json|directory>
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
//
// Outside the grader's container MAKEFUN_OUTPUT_DIR stands in for /output.
// The dashboard is a static page and must stay small: the gate caps its text at
// 64 KiB (TEXT_MAX_BYTES) and its screenshots at 4 images of 512 KiB each.
// Exit codes: 0 on success, 1 when the model wrote a board the gate refuses or
// the screenshots are short, 2 when the snapshot file is missing.

// A working token-radar-01 entry (Node 22, standard library only).
//
// The program reads the sealed snapshot from /input/snapshot.json (or --input <file|dir>), scores every
// pre-token protocol with the model in lib/model.ts, writes the ranked board to /output/board.json, and
// copies this repository's dashboard/ and screenshots/ to /output. Last, it writes /output/dossier.json,
// the summary the judge reads, with the vendored make.fun library.
//
// The dashboard is a static page, no framework and no network: dashboard/index.html, dashboard/app.css
// and dashboard/app.js read /output/data.js, which this program writes from the same board. A starting
// point, not a winner: it covers the watchlist, states the model and gives every protocol a farm plan.
// Change the model, the page or the plan; keep the gate's shape.
//
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's own caps (reference/gate.json): the text cap shapes the bytes, the rest refuse. */
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

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
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

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')} (3 files), ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

// Run note: the program is deterministic — the same snapshot always writes the
// same board, the same data.js and the same dossier, byte for byte. The dashboard
// recomputes every row from the multiples in data.js, so the page, the board and
// the model never drift apart.
