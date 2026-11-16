# token-radar (radar-3 rebuild)

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/samanta02-ai/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/samanta02-ai/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot of every protocol, finds the ones that still record no token and are not a wrapped or staked product of one that trades, ranks them by what their launch would be worth, prices one ordinary farm per protocol net of gas, time and slippage, and serves the board as a web dashboard with a model panel, a traded-token scatter chart, a detail view and a farm plan for each protocol. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

This is a full rebuild (radar-3) of an earlier entry ("Hopeful Quill", radar-2, rank 3,945/5,857). The rebuild fixes the old entry's one visible failure: its flat category-median multiple. The watchlist is dominated by categories with almost no live-token peers (Risk Curators: 12 of 40 rows), so nearly every row landed on the same global multiple, 0.2138, and the board barely ranked anything by value.

## What changed in radar-3

1. **Per-family log-log pricing instead of a flat multiple.** Categories are grouped into 7 families (Lending & Credit, Trading, Yield & Vaults, RWA, Staking, Bridges, Other) and each family gets its own regression, `log(mcap) = a + b·log(TVL)`, fitted on that family's live-token protocols, shrunk toward the global fit (12 pseudo-peers) with slopes clamped to [0.2, 1.3]. The fitted multiple at $100M TVL now actually varies: Trading 0.2771, Other 0.2297, Bridges 0.2211, Lending & Credit 0.1901, RWA 0.1662, Yield & Vaults 0.0913, Staking 0.0812.
2. **A real backtest, shown on the board.** 5-fold cross-validation over the 128 traded protocols (hold out every 5th by slug, refit, predict): log correlation 0.41, median absolute error 80.6%, 32.8% of predictions within 2× of the real market cap — against a flat global-median baseline of 87.7% / 29.7%. The win is real but modest, and the board says so plainly: use the ranks, not the point values.
3. **Per-row FARM / THIN / SKIP verdicts with net-of-all-costs dollars.** A farmer puts in $100, makes 6 transactions, spends ~3h at $15/h, loses 0.3% slippage. Gross is the assumed farmer share: 5% of the implied value split among TVL/$10,000 farmers (500–20,000). Net ≥ $25 is FARM, ≥ $0 THIN, below $0 SKIP. On this snapshot: 115 FARM, 31 THIN, 54 SKIP. The shares are assumptions, stated on the board — change them and the verdicts move.
4. **A traded-token scatter chart vs the fitted curve**, drawn on the board (log TVL vs log market cap, family colours, global fit line, pre-token rows as hollow rings). The scatter's width is the backtest's error, shown, not hidden.
5. **200 rows**: all 40 watchlist slugs, 158 early-radar rows (rankable pre-token protocols, any TVL), plus 2 extended rows (the largest pre-token protocols the house rule leaves out, flagged as such).

## The model

```
log(mcap) = a + b·log(TVL)   per family, shrunk toward the global fit
implied = clamp(exp(a + b·ln TVL) × growth × maturity × breadth, 0.02×TVL, 3×TVL)
growth   = 1 + clamp(7d %, -60, 120) / 100 × 0.5
maturity = 0.6 + min(age_days, 1095) / 1095 × 0.4   (age unknown: 365)
breadth  = 1 + 0.02 × min(chains - 1, 5)
```

Growth rewards a protocol the market is already noticing, maturity rewards staying power, breadth rewards distribution across chains. The [0.02, 3]×TVL clamp keeps the model honest at both ends. Everything is computed from the snapshot at run time — no protocol name is special-cased and no intercept, slope or multiple is hand-written.

## The verdict arithmetic

```
farmers = clamp(round(TVL / 10,000), 500, 20,000)
gross   = implied × 0.05 / farmers
gas     = 6 transactions × per-tx price (Ethereum $8, Solana $0.10, BNB Chain $0.50, most others $2)
time    = 3h × $15/h = $45
slippage = 0.3% × $100 = $0.30
net     = gross − gas − time − slippage
```

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22 or later, standard library only, no network. The program is deterministic: the same snapshot always writes the same board, the same `data.js` and the same `dossier.json`, byte for byte. The dashboard recomputes every row's implied value from the family fits in `data.js` and shows whether it matches the board, so the page, the board and the model never drift apart.

## Files

- `main.ts` — entrypoint: parse, score, write `board.json`, `data.js`, dashboard, screenshots, `dossier.json`.
- `lib/model.ts` — radar-3: families, fits, 5-fold backtest, implied values, verdicts, farm plans.
- `dashboard/` — `index.html`, `app.js`, `app.css`: model panel, scatter chart, sortable/filterable board, detail drawer, live-token view. No network.
- `vendor/makefun-board.ts` — the kit's dossier library, unchanged.
- `screenshots/` — the board, a detail view, and a filtered view.
