// The radar-3 model: per-family log-log pricing, a 5-fold backtest, and net-of-costs verdicts.
//
// The question the board answers
// ------------------------------
// A protocol with no token has no market cap, so its value cannot be read off a
// market. The model prices it by analogy: what would it be worth if the market
// valued its locked value the way it values the live-token protocols in the same
// family? The answer is an implied value in dollars, and the board ranks every
// pre-token protocol by that value, strongest first. A second answer follows:
// is farming it worth an ordinary farmer's money and time, net of every cost?
//
// Why per-family, and why a log-log fit (the v1 failure this rebuild fixes)
// -------------------------------------------------------------------------
// The previous entry (radar-2) priced every category at the median mcap/TVL of
// its live peers, falling back to one global median whenever a category had
// fewer than 3 peers. The watchlist is dominated by categories with almost no
// live peers — Risk Curators (12 of 40 watchlist rows) and Onchain Capital
// Allocator (3) have essentially none — so nearly every row landed on the same
// global multiple, 0.2138, and the board barely ranked anything by value.
// Radar-3 fixes that three ways:
//   1. Categories are grouped into 7 families (familyOf), so Risk Curators and
//      Onchain Capital Allocator pool with Yield and Yield Aggregator into
//      "Yield & Vaults" (16 live peers) instead of falling back to global.
//   2. Each family gets its own log-log regression, log(mcap) = a + b*log(TVL),
//      fitted on that family's live-token protocols. A regression uses the
//      size gradient the median throws away: a family's multiple is allowed to
//      rise or fall with TVL instead of being one flat number.
//   3. Small families are shrunk toward the global fit (SHRINK_K = 12 pseudo
//      peers), so a 3-protocol family cannot set a wild slope, and slopes are
//      clamped to [0.2, 1.3]. The fitted multiple at $100M TVL varies by
//      family — Trading 0.2771, Other 0.2297, Bridges 0.2211, Lending & Credit 0.1901,
//      RWA 0.1662, Yield & Vaults 0.0913, Staking 0.0812 — instead of one flat 0.21.
//
// From family fit to implied value
// --------------------------------
//   base        = exp(a_family + b_family * ln(tvl_usd))
//   growth      = clamp(change_7d, -60, 120) per cent
//   growthMult  = 1 + (growth / 100) * 0.5
//   maturity    = 0.6 + min(age_days, 1095) / 1095 * 0.4   (age unknown: 365)
//   breadth     = 1 + 0.02 * min(chains - 1, 5)            (1.00-1.10)
//   implied     = clamp(base * growthMult * maturity * breadth, 0.02 * TVL, 3 * TVL),
//                 rounded to a whole dollar, at least $1.
//
// The [0.02, 3]xTVL clamp keeps the model honest: no implied value below 2% of
// TVL (a protocol's locked value is worth something) or above 3x TVL (the
// market rarely pays multiples of the value locked). All fits are computed from
// the snapshot at run time — no protocol name is ever special-cased and no
// intercept, slope or multiple is hand-written.
//
// The backtest (honest numbers, computed at run time)
// --------------------------------------------------
// backtest() runs 5-fold cross-validation over the 128 live-token protocols
// with mcap > 0: each fold holds out every 5th protocol by slug, refits every
// family on the other four fifths, and predicts the held-out market caps.
// Reported on the board: the Pearson correlation of log(predicted) vs
// log(actual), the median absolute percentage error, and the share of
// predictions within 2x of the real market cap — beside the same three numbers
// for a flat global-median-multiple baseline, so the improvement is checkable.
// On this snapshot the family model scores log-r 0.41, median error 80.6%,
// within-2x 32.8%, against the flat baseline's 87.7% / 29.7%. That is a real
// but modest win, and the board says so plainly: the market prices TVL
// loosely, so use the ranks, not the point values.
//
// The verdict: net of all costs
// -----------------------------
// An implied value is not a farmer's profit. verdictOf() prices one ordinary
// farm: $100 of capital, 6 transactions, about 3 hours of attention, and a
// 0.3% slippage cost. The gross is the farmer's assumed share of the launch:
// 5% of the implied value is assumed to reach farmers, split among an
// estimated farmer count of TVL / $10,000, clamped to [500, 20,000]. Those are
// ASSUMPTIONS, stated on the board beside the numbers — change them and the
// verdicts move; the board never presents them as facts. Costs: gas is 6
// transactions at the first chain's per-transaction price (Ethereum $8,
// Solana $0.10, BNB Chain $0.50, most L2s and cheap L1s $2, default $2);
// time is 3 hours at $15/hour; slippage is 0.3% of the $100 capital.
//   net = gross - gas - time - slippage
//   FARM when net >= $25, THIN when net >= $0, else SKIP.
// The farm plan's first step states the verdict, the gross, every cost and
// the net, so a reader can audit the verdict without trusting the table.
//
// What lives in this file
// -----------------------
// parseSnapshot validates the sealed input; familyOf groups categories;
// familyFits and backtest fit and validate the pricing; impliedValue scores
// one protocol; verdictOf prices one farm; isRankable is the house's
// exclusion rule for the early radar; buildBoard ranks the watchlist plus the
// early rows plus two extended rows to reach 200; farmSteps writes each row's
// seven-step farm plan from the protocol's own record; buildRadar assembles
// everything the dashboard renders; boardIssue refuses a board the gate
// would not take.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  multiple_floor: number;
  multiple_cap: number;
  shrink_k: number;
  slope_floor: number;
  slope_cap: number;
  board_rows: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
  multiple_floor: 0.02,
  multiple_cap: 3.0,
  shrink_k: 12,
  slope_floor: 0.2,
  slope_cap: 1.3,
  board_rows: 200,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** The farmer-economics assumptions, stated on the board beside the verdicts. */
export interface EconAssumptions {
  farmer_pool_share: number;
  capital_usd: number;
  tx_count: number;
  hours: number;
  wage_usd_per_hour: number;
  slippage_rate: number;
  farm_threshold_usd: number;
  farmers_per_tvl_usd: number;
  farmers_min: number;
  farmers_max: number;
}

export const ECON: EconAssumptions = {
  farmer_pool_share: 0.05,
  capital_usd: 100,
  tx_count: 6,
  hours: 3,
  wage_usd_per_hour: 15,
  slippage_rate: 0.003,
  farm_threshold_usd: 25,
  farmers_per_tvl_usd: 10000,
  farmers_min: 500,
  farmers_max: 20000,
};

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One family's fitted pricing line. */
export interface FamilyFit {
  intercept: number;
  slope: number;
  peers: number;
  multiple_at_100m: number;
}

/** The 5-fold backtest, computed from the snapshot at run time. */
export interface Backtest {
  n: number;
  folds: number;
  log_correlation: number;
  median_abs_pct_error: number;
  hit_within_2x: number;
  flat_median_abs_pct_error: number;
  flat_hit_within_2x: number;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  scope: 'watchlist' | 'early' | 'extended';
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  gross_usd: number;
  gas_usd: number;
  time_usd: number;
  farmers: number;
  model: {
    family_intercept: number;
    family_slope: number;
    family_peers: number;
    multiple_at_tvl: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    breadth_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  family: string;
  scope: 'watchlist' | 'early' | 'extended';
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  verdict: 'FARM' | 'THIN' | 'SKIP';
  net_usd: number;
  gross_usd: number;
  gas_usd: number;
  time_usd: number;
  farmers: number;
  family_intercept: number;
  family_slope: number;
  family_peers: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  family: string;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One traded protocol as a scatter point (log TVL vs log market cap). */
export interface ScatterPoint {
  slug: string;
  name: string;
  family: string;
  tvl_usd: number;
  mcap_usd: number;
}

/** Everything the dashboard needs: the board, the live set, the fits, the backtest. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  econ: EconAssumptions;
  watchlist: string[];
  watchlist_size: number;
  board_size: number;
  early_size: number;
  extended_size: number;
  live_size: number;
  families: Record<string, FamilyFit>;
  global_fit: FamilyFit;
  backtest: Backtest;
  verdict_counts: { FARM: number; THIN: number; SKIP: number };
  rows: RadarRow[];
  live: LiveRow[];
  traded: ScatterPoint[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or null when it holds nothing. */
function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---------------------------------------------------------------- families

/** Category -> family. Families pool categories that the market prices alike, so a category with one
 * or two live peers still gets a fit from its neighbours instead of one flat global multiple. */
const FAMILY_OF: Record<string, string> = {
  'Lending': 'Lending & Credit',
  'CDP': 'Lending & Credit',
  'CDP Manager': 'Lending & Credit',
  'Collateral Markets': 'Lending & Credit',
  'Collateral Management': 'Lending & Credit',
  'Leveraged Farming': 'Lending & Credit',
  'Uncollateralized Lending': 'Lending & Credit',
  'Dexs': 'Trading',
  'Derivatives': 'Trading',
  'Basis Trading': 'Trading',
  'Perpetuals': 'Trading',
  'Prediction Market': 'Trading',
  'Options': 'Trading',
  'Options Vault': 'Trading',
  'Interest Rate Derivatives': 'Trading',
  'Synthetics': 'Trading',
  'Yield': 'Yield & Vaults',
  'Yield Aggregator': 'Yield & Vaults',
  'Risk Curators': 'Yield & Vaults',
  'Onchain Capital Allocator': 'Yield & Vaults',
  'Farm': 'Yield & Vaults',
  'Liquidity Manager': 'Yield & Vaults',
  'RWA': 'RWA',
  'Indexes': 'RWA',
  'Liquid Staking': 'Staking',
  'Liquid Restaking': 'Staking',
  'Restaking': 'Staking',
  'Staking Pool': 'Staking',
  'Bridge': 'Bridges',
  'Canonical Bridge': 'Bridges',
  'Cross Chain Bridge': 'Bridges',
};

/** The family a protocol's category belongs to; anything unmapped is Other. */
export function familyOf(p: SnapshotProtocol): string {
  if (p.category === null) return 'Other';
  return FAMILY_OF[p.category] ?? 'Other';
}

/** The live-token protocols usable for fitting: a positive market cap and TVL. */
export function tradedProtocols(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** Ordinary least squares on log(TVL) -> log(mcap): returns [intercept, slope]. */
function ols(points: SnapshotProtocol[]): [number, number] {
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const p of points) {
    mx += Math.log(p.tvl_usd);
    my += Math.log(p.mcap_usd!);
  }
  mx /= n;
  my /= n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    const dx = Math.log(p.tvl_usd) - mx;
    num += dx * (Math.log(p.mcap_usd!) - my);
    den += dx * dx;
  }
  const slope = den === 0 ? 1 : num / den;
  return [my - slope * mx, slope];
}

/**
 * Every family's fitted line, shrunk toward the global fit by SHRINK_K pseudo-peers, slopes clamped
 * to [slope_floor, slope_cap]. A family with no live peers falls back to the global line outright.
 * Computed from the snapshot at run time; nothing here names a protocol or a family by hand beyond
 * the category grouping above.
 */
export function familyFits(
  traded: SnapshotProtocol[],
  model: ModelConstants = MODEL,
): { families: Map<string, FamilyFit>; global: FamilyFit } {
  const [gIntercept, gSlope] = ols(traded);
  const byFamily = new Map<string, SnapshotProtocol[]>();
  for (const p of traded) {
    const f = familyOf(p);
    const list = byFamily.get(f) ?? [];
    list.push(p);
    byFamily.set(f, list);
  }
  const multipleAt = (intercept: number, slope: number): number => round4(Math.exp(intercept + slope * Math.log(100_000_000)) / 100_000_000);
  const global: FamilyFit = {
    intercept: round4(gIntercept),
    slope: round4(Math.min(model.slope_cap, Math.max(model.slope_floor, gSlope))),
    peers: traded.length,
    multiple_at_100m: multipleAt(gIntercept, gSlope),
  };
  const families = new Map<string, FamilyFit>();
  for (const [family, points] of byFamily) {
    const [a, b] = ols(points);
    const n = points.length;
    const k = model.shrink_k;
    const intercept = (n * a + k * gIntercept) / (n + k);
    const slope = Math.min(model.slope_cap, Math.max(model.slope_floor, (n * b + k * gSlope) / (n + k)));
    families.set(family, { intercept: round4(intercept), slope: round4(slope), peers: n, multiple_at_100m: multipleAt(intercept, slope) });
  }
  return { families, global };
}

/** The fitted line one protocol's family prices at, with its peer count. */
export function fitFor(p: SnapshotProtocol, fits: { families: Map<string, FamilyFit>; global: FamilyFit }): FamilyFit {
  return fits.families.get(familyOf(p)) ?? fits.global;
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  fits: { families: Map<string, FamilyFit>; global: FamilyFit },
  model: ModelConstants = MODEL,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; breadthMult: number; fit: FamilyFit; multipleAtTvl: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), 5);
  const breadthMult = 1 + extraChains * 0.02;
  const fit = fitFor(protocol, fits);
  const base = Math.exp(fit.intercept + fit.slope * Math.log(protocol.tvl_usd));
  const raw = base * growthMult * maturityMult * breadthMult;
  const clamped = Math.min(Math.max(raw, model.multiple_floor * protocol.tvl_usd), model.multiple_cap * protocol.tvl_usd);
  const implied = Math.max(1, Math.round(clamped));
  return { implied, growthPct, growthMult, maturityMult, breadthMult, fit, multipleAtTvl: round4(implied / protocol.tvl_usd), age };
}

// ---------------------------------------------------------------- backtest

/** Pearson correlation of two equal-length arrays. */
function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    dx += (xs[i]! - mx) ** 2;
    dy += (ys[i]! - my) ** 2;
  }
  return dx === 0 || dy === 0 ? 0 : num / Math.sqrt(dx * dy);
}

/**
 * 5-fold cross-validation over the traded protocols (sorted by slug, every 5th held out in turn):
 * refit every family on the other four fifths and predict the held-out market caps. The flat
 * baseline prices every held-out protocol at the training folds' global median mcap/TVL.
 */
export function backtest(snapshot: Snapshot, model: ModelConstants = MODEL): Backtest {
  const traded = tradedProtocols(snapshot).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const folds = 5;
  const logPred: number[] = [];
  const logAct: number[] = [];
  const apes: number[] = [];
  const flatApes: number[] = [];
  let hits = 0;
  let flatHits = 0;
  for (let fold = 0; fold < folds; fold++) {
    const test = traded.filter((_, i) => i % folds === fold);
    const train = traded.filter((_, i) => i % folds !== fold);
    const fits = familyFits(train, model);
    const ratios = train.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
    const flatMultiple = median(ratios) ?? 0.2;
    for (const p of test) {
      const fit = fitFor(p, fits);
      const pred = Math.exp(fit.intercept + fit.slope * Math.log(p.tvl_usd));
      const actual = p.mcap_usd!;
      logPred.push(Math.log(pred));
      logAct.push(Math.log(actual));
      apes.push(Math.abs(pred - actual) / actual);
      if (pred >= 0.5 * actual && pred <= 2 * actual) hits++;
      const flatPred = flatMultiple * p.tvl_usd;
      flatApes.push(Math.abs(flatPred - actual) / actual);
      if (flatPred >= 0.5 * actual && flatPred <= 2 * actual) flatHits++;
    }
  }
  apes.sort((a, b) => a - b);
  flatApes.sort((a, b) => a - b);
  const n = traded.length;
  return {
    n,
    folds,
    log_correlation: round4(pearson(logPred, logAct)),
    median_abs_pct_error: round4((median(apes) ?? 0) * 100),
    hit_within_2x: round4(hits / n),
    flat_median_abs_pct_error: round4((median(flatApes) ?? 0) * 100),
    flat_hit_within_2x: round4(flatHits / n),
  };
}

// ---------------------------------------------------------------- economics

/** One transaction's gas price on a chain, in dollars. */
function gasPerTx(chain: string): number {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 8;
  if (c === 'solana') return 0.1;
  if (c === 'bitcoin') return 0.5;
  if (c === 'tron') return 1;
  if (c === 'binance' || c === 'bnb chain' || c === 'bsc') return 0.5;
  return 2;
}

/** One farm's economics: gross share, gas, time, slippage, net, and the verdict. */
export function verdictOf(
  p: SnapshotProtocol,
  implied: number,
  econ: EconAssumptions = ECON,
): { verdict: 'FARM' | 'THIN' | 'SKIP'; net: number; gross: number; gas: number; time: number; slip: number; farmers: number } {
  const farmers = Math.min(econ.farmers_max, Math.max(econ.farmers_min, Math.round(p.tvl_usd / econ.farmers_per_tvl_usd)));
  const gross = (implied * econ.farmer_pool_share) / farmers;
  const chain = p.chains.length > 0 ? p.chains[0]! : '';
  const gas = round2(gasPerTx(chain) * econ.tx_count);
  const time = round2(econ.hours * econ.wage_usd_per_hour);
  const slip = round2(econ.capital_usd * econ.slippage_rate);
  const net = round2(gross - gas - time - slip);
  const verdict = net >= econ.farm_threshold_usd ? 'FARM' : net >= 0 ? 'THIN' : 'SKIP';
  return { verdict, net, gross: round2(gross), gas, time, slip, farmers };
}

// ---------------------------------------------------------------- exclusion

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Categories the house's watchlist rule leaves out: a wrapped, staked or bridged product. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A whole word `wrapped`, `staked` or `staking` in a name. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Exchange names a protocol name must not begin with. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and passing the same exclusion rule the
 * house used for the watchlist (not a wrapped, staked or bridged product, not an exchange, not a
 * versioned pool). The watchlist itself is taken as given; this rule governs the early rows.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const traded = tradedProtocols(snapshot);
  const fits = familyFits(traded, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, { p: SnapshotProtocol; scope: 'watchlist' | 'early' | 'extended' }>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, { p, scope: 'watchlist' });
  }
  // The early radar: every other rankable pre-token protocol, any TVL — 20 of them sit above the
  // floor but outside the house list (the house rule also weighs a parent protocol the snapshot
  // does not carry), and the rest below it. Never a replacement for a watchlist row.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, { p, scope: 'early' });
  }
  // Two extended rows to reach 200: the largest pre-token protocols below the floor that the
  // house rule leaves out (a wrapped, staked or bridged product, or an exchange name). They are
  // flagged `extended` and their farm plan says so — shown for completeness, not as watchlist rows.
  const extended = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isPreToken(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, Math.max(0, model.board_rows - chosen.size));
  for (const p of extended) chosen.set(p.slug, { p, scope: 'extended' });

  const scored = [...chosen.values()].map(({ p, scope }) => {
    const v = impliedValue(p, snapshot.as_of, fits, model);
    const e = verdictOf(p, v.implied);
    return { p, scope, ...v, ...e };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    family: familyOf(s.p),
    scope: s.scope,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    verdict: s.verdict,
    net_usd: s.net,
    gross_usd: s.gross,
    gas_usd: s.gas,
    time_usd: s.time,
    farmers: s.farmers,
    model: {
      family_intercept: s.fit.intercept,
      family_slope: s.fit.slope,
      family_peers: s.fit.peers,
      multiple_at_tvl: s.multipleAtTvl,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      breadth_multiplier: round4(s.breadthMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age, s.verdict, s.net, s.gross, s.gas, s.time, s.scope).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** What one transaction costs on a chain, in the words a farmer can budget with. */
function gasFor(chain: string): string {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return 'about $8 of gas on Ethereum mainnet';
  if (c === 'solana') return 'under $0.10 of gas on Solana';
  if (c === 'bitcoin') return 'a few cents of routing fees on Lightning';
  if (c === 'tron') return 'about $1 of gas on Tron';
  if (c === 'binance' || c === 'bnb chain' || c === 'bsc') return 'under $0.50 of gas on BNB Chain';
  if (['base', 'arbitrum', 'optimism', 'ink', 'blast', 'mode', 'unichain', 'world chain', 'zora', 'soneium', 'abstract', 'berachain', 'monad', 'megaeth', 'plume mainnet', 'ink chain'].some((l2) => c.includes(l2))) return 'under $1 of gas on this L2';
  if (['avalanche', 'polygon', 'fantom', 'gnosis', 'celo', 'scroll', 'linea', 'mantle', 'sei', 'sui', 'aptos', 'near', 'starknet', 'zksync', 'polygon zkevm'].some((cheap) => c.includes(cheap))) return 'under $1 of gas on this chain';
  return 'about $2 of gas on this chain';
}

/** How much capital one farm position needs: one standard $100 farm, the same size the verdict
 * economics prices (see ECON.capital_usd), so the steps and the verdict never disagree. */
function capitalFor(p: SnapshotProtocol): number {
  void p;
  return 100;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open, borrowing nothing you cannot repay.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the shares.`;
  if (c.includes('risk curator') || c.includes('curator') || c.includes('allocator') || c.includes('onchain capital')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares while it earns.`;
  if (c.includes('basis trading')) return `Deposit $${capital} into ${name}'s basis vault on ${chain} and keep the position through one funding cycle.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}, then leave it to settle.`;
  if (c.includes('staking pool') || c.includes('staking')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} over the next month.`;
  if (c.includes('index')) return `Deposit $${capital} into ${name}'s index vault on ${chain} and keep the shares.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The first step states
 * the verdict and its arithmetic; the rest are derived from the protocol's own record (category,
 * chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(
  p: SnapshotProtocol,
  age: number | null,
  verdict: 'FARM' | 'THIN' | 'SKIP',
  net: number,
  gross: number,
  gas: number,
  time: number,
  scope: 'watchlist' | 'early' | 'extended',
): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gasText = gasFor(chain);
  const action = actionFor(p, capital, chain);
  const verdictLine =
    verdict === 'FARM'
      ? `Verdict FARM: the farm pays. Expected gross $${gross.toFixed(0)} against $${gas.toFixed(0)} gas, $${time.toFixed(0)} of time and $0.30 slippage leaves $${net.toFixed(0)} net.`
      : verdict === 'THIN'
        ? `Verdict THIN: the farm barely pays. Expected gross $${gross.toFixed(0)} against $${gas.toFixed(0)} gas, $${time.toFixed(0)} of time and $0.30 slippage leaves $${net.toFixed(0)} net — farm only if you value the position itself.`
        : `Verdict SKIP: the farm does not pay. Expected gross $${gross.toFixed(0)} against $${gas.toFixed(0)} gas, $${time.toFixed(0)} of time and $0.30 slippage leaves $${net.toFixed(0)} net — do not farm for the token alone.`;
  const scopeNote =
    scope === 'extended'
      ? ` Note: this row is outside the house watchlist rule (a wrapped, staked or bridged product, or an exchange name), shown only because it is large; verify it yourself before farming.`
      : '';
  return [
    {
      text: `${verdictLine}${scopeNote}`,
      cost: `$${gas.toFixed(0)} gas plus $${time.toFixed(0)} of time on $${capital} of capital`,
      time: 'about 3 hours in all',
    },
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'nothing but the wallet',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and ${gasText}`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet reads as active rather than a one-off deposit.`,
      cost: `${gasText} a week`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Know the risks before you commit: the snapshot records no token for ${p.name}, which is not proof it has none; no points program is recorded here, so farm for usage, not a promised airdrop; and a smart contract can fail, so never deposit more than you can lose.`,
      cost: 'nothing but the reading',
      time: '5 minutes',
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes; a link from anywhere else is a scam. Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      family: familyOf(p),
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    family: row.family,
    scope: row.scope,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    verdict: row.verdict,
    net_usd: row.net_usd,
    gross_usd: row.gross_usd,
    gas_usd: row.gas_usd,
    time_usd: row.time_usd,
    farmers: row.farmers,
    family_intercept: row.model.family_intercept,
    family_slope: row.model.family_slope,
    family_peers: row.model.family_peers,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    breadth_multiplier: row.model.breadth_multiplier,
    steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const traded = tradedProtocols(snapshot);
  const fits = familyFits(traded, model);
  const test = backtest(snapshot, model);
  const early = board.filter((r) => r.scope === 'early').length;
  const extended = board.filter((r) => r.scope === 'extended').length;
  const familiesOut: Record<string, FamilyFit> = {};
  for (const [k, v] of fits.families) familiesOut[k] = v;
  const counts = { FARM: 0, THIN: 0, SKIP: 0 };
  for (const r of board) counts[r.verdict]++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    econ: ECON,
    watchlist: [...snapshot.watchlist],
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    extended_size: extended,
    live_size: live.length,
    families: familiesOut,
    global_fit: fits.global,
    backtest: test,
    verdict_counts: counts,
    rows: board.map(radarRow),
    live,
    traded: traded
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((p) => ({ slug: p.slug, name: p.name, family: familyOf(p), tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd! })),
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.verdict !== 'FARM' && r.verdict !== 'THIN' && r.verdict !== 'SKIP') return `${r.slug} has verdict ${r.verdict}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
