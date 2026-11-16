// The radar's model: one sealed snapshot in, one ranked board out.
//
// The board ranks the protocols that record no token yet and are not a wrapped, staked or bridged
// product of a token that already trades: the same line the snapshot's watchlist draws above its
// $50M floor, applied here to the whole snapshot, so the watchlist's 40 are the floor of the board
// and the pre-token protocols below the floor are the early rows the radar exists to find. Protocols
// whose token already trades are set aside and shown at the market's own values, never ranked.
//
// Implied value is a peer model, computed from the snapshot's own figures and nothing else:
//
//   peers      every protocol whose token trades with a market cap on record (outside the CEX
//              category, whose balances are not a product's value) gives a ratio mcap / TVL,
//              capped at the market's own 95th percentile before any median is taken: a ratio
//              of 400x is a tiny TVL denominator talking, not a price a category can launch at
//   multiple   the protocol's category median ratio, shrunk toward the global median by the
//              category's peer count: M = (n x med_cat + K x med_all) / (n + K), K = 6, so a
//              category with one loud peer cannot shout down the whole market's evidence
//   band       the estimate multiplied and divided by the square root of the peer spread (the
//              category's interquartile ratio, blended with the market's in log space by the
//              same peer-count shrinkage): the band widens exactly as the evidence thins, and
//              the spread is printed beside every row as its confidence
//   momentum   1 + clamp(change_7d, -50, 100) / 100 x 0.6, never below 0.55: a protocol whose
//              TVL is compounding would not launch into the same market as one that is leaking
//   age        0.75 + 0.45 x min(age_days, 1460) / 1460: four tokenless years of operation is
//              the strongest record a launch can stand on; a young protocol is discounted
//   chains     1 + 0.04 x min(chains - 1, 5): distribution across chains supports a launch
//   implied    round(TVL x M x momentum x age x chains), at least 1
//
// No protocol name is ever special-cased: one function scores every row, and the dashboard states
// the model and recomputes each row from the figures beside it.

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

/** The model's constants, stated in the dashboard so a reader can check every row by hand. */
export interface ModelConstants {
  winsor_quantile: number;
  shrink_k: number;
  momentum_weight: number;
  momentum_floor_pct: number;
  momentum_cap_pct: number;
  momentum_min_mult: number;
  age_base: number;
  age_range: number;
  age_cap_days: number;
  chain_step: number;
  chain_cap: number;
}

export const MODEL: ModelConstants = {
  winsor_quantile: 0.95,
  shrink_k: 6,
  momentum_weight: 0.6,
  momentum_floor_pct: -50,
  momentum_cap_pct: 100,
  momentum_min_mult: 0.55,
  age_base: 0.75,
  age_range: 0.45,
  age_cap_days: 1460,
  chain_step: 0.04,
  chain_cap: 5,
};

/** The model's version label: the dashboard names it and the detail view quotes it. */
export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Already trading view carries, by market cap. */
export const LIVE_ROWS = 24;

/** Categories that are a product of a token that already trades, or an exchange's own balances. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, and not a product of a trading token. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !PRODUCT_CATEGORIES.has(p.category ?? '') && !VERSIONED.test(p.name);
}

/** Whether a protocol's token already trades with a market cap on record: a peer for the model. */
function isPeer(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.tvl_usd > 0 && p.category !== 'CEX';
}

const DAY_MS = 86_400_000;

/** A whole day count from listing to the snapshot's date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a sorted copy of `values`; 0 for an empty set. */
function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The t-quantile of a sorted copy of `values` (nearest rank); 0 for an empty set. */
function quantileOf(values: number[], t: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(t * s.length))]!;
}

/** One category's peer evidence: how many tokenized peers, and their mcap/TVL quartiles. */
export interface PeerStats {
  peers: number;
  q25: number;
  median: number;
  q75: number;
}

/** Peer statistics: one row per category that has tokenized peers, and the global row apart. */
export function peerStats(snapshot: Snapshot, model: ModelConstants = MODEL): { byCategory: Map<string, PeerStats>; global: PeerStats; ratiosByCategory: Map<string, number[]>; allRatios: number[]; cap: number } {
  const raw: Array<{ category: string | null; ratio: number }> = [];
  for (const p of snapshot.protocols) {
    if (!isPeer(p)) continue;
    raw.push({ category: p.category, ratio: p.mcap_usd! / p.tvl_usd });
  }
  // Winsorize: no peer's ratio counts for more than the market's own 95th percentile.
  const cap = quantileOf(raw.map((r) => r.ratio), model.winsor_quantile);
  const lists = new Map<string, number[]>();
  const all: number[] = [];
  for (const r of raw) {
    const ratio = Math.min(r.ratio, cap);
    all.push(ratio);
    if (r.category !== null) {
      const list = lists.get(r.category) ?? [];
      list.push(ratio);
      lists.set(r.category, list);
    }
  }
  const byCategory = new Map<string, PeerStats>();
  for (const [key, ratios] of lists) {
    byCategory.set(key, { peers: ratios.length, q25: quantileOf(ratios, 0.25), median: medianOf(ratios), q75: quantileOf(ratios, 0.75) });
  }
  const global: PeerStats = { peers: all.length, q25: quantileOf(all, 0.25), median: medianOf(all), q75: quantileOf(all, 0.75) };
  const ratiosByCategory = new Map<string, number[]>();
  for (const [key, ratios] of lists) ratiosByCategory.set(key, [...ratios].sort((a, b) => a - b));
  return { byCategory, global, ratiosByCategory, allRatios: [...all].sort((a, b) => a - b), cap };
}

/** A category quartile shrunk toward the global one by the category's peer count. */
function shrunk(catValue: number, globalValue: number, peers: number, k: number): number {
  return (peers * catValue + k * globalValue) / (peers + k);
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The three adjustments one protocol gets, each from its own record. */
export interface Adjustments {
  momentum: number;
  age: number;
  chains: number;
}

function adjustments(p: SnapshotProtocol, age: number | null, unknownAgeDays: number, model: ModelConstants): Adjustments {
  const raw = p.change_7d ?? 0;
  const pct = Math.min(model.momentum_cap_pct, Math.max(model.momentum_floor_pct, raw));
  const momentum = Math.max(model.momentum_min_mult, 1 + (pct / 100) * model.momentum_weight);
  const ageForModel = age ?? unknownAgeDays;
  const ageMult = model.age_base + (Math.min(Math.max(ageForModel, 0), model.age_cap_days) / model.age_cap_days) * model.age_range;
  const chainMult = 1 + model.chain_step * Math.min(Math.max(p.chains.length - 1, 0), model.chain_cap);
  return { momentum, age: ageMult, chains: chainMult };
}

/** How much the board trusts a row's peer basis: many peers and a narrow spread earn trust. */
export type Confidence = 'high' | 'medium' | 'low';

function confidenceFor(peers: number, spread: number): Confidence {
  if (peers >= 8 && spread <= 16) return 'high';
  if (peers >= 3 && spread <= 35) return 'medium';
  return 'low';
}

/** A peer set's interquartile spread, q75 over q25, floored so a zero quartile cannot explode it. */
function spreadOf(stats: PeerStats): number {
  return stats.q75 / Math.max(stats.q25, 1e-4);
}

/** One scored protocol: the board row board.json carries, and the dashboard's whole dataset. */
export interface ScoredRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  token_status: 'pre-token';
  peer_category: string | null;
  peer_count: number;
  peer_multiple: number;
  band_low_usd: number;
  implied_value_usd: number;
  band_high_usd: number;
  confidence: Confidence;
  adj: Adjustments;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the dashboard shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  symbol: string | null;
}

/** A category's peer row for the dashboard's model panel. */
export interface CategoryPeers {
  category: string;
  peers: number;
  q25: number;
  median: number;
  q75: number;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  unknown_age_days: number;
  /** The winsorizing cap applied to every peer ratio before any median was taken. */
  peer_cap: number;
  global_peers: PeerStats;
  stats: {
    protocols: number;
    pre_token: number;
    board_size: number;
    watchlist_size: number;
    live_size: number;
    set_aside: number;
  };
  categories: CategoryPeers[];
  /** Every peer ratio by category, and all of them: the page recomputes each row from these. */
  peer_ratios: Record<string, number[]>;
  all_ratios: number[];
  rows: ScoredRow[];
  live: LiveRow[];
  live_total: number;
}

/** The age the model gives a protocol whose listing date the snapshot does not carry: the board's own median. */
function unknownAgeDays(snapshot: Snapshot): number {
  const ages = snapshot.protocols
    .filter((p) => isRankable(p))
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null);
  return Math.round(medianOf(ages));
}

/** Score every rankable protocol and rank them, strongest implied value first. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): ScoredRow[] {
  const { byCategory, global } = peerStats(snapshot, model);
  const unknownAge = unknownAgeDays(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter((p) => isRankable(p))
    .map((p) => {
      // No category on record, or a category with no tokenized peer: the global basis, unshrunk.
      const cat = (p.category !== null ? byCategory.get(p.category) : undefined) ?? { peers: 0, q25: global.q25, median: global.median, q75: global.q75 };
      const multiple = shrunk(cat.median, global.median, cat.peers, model.shrink_k);
      // The band: the category's interquartile spread blended with the market's in log space,
      // so a thin category's band widens instead of collapsing onto its single peer.
      const logSpread = (cat.peers * Math.log(spreadOf(cat)) + model.shrink_k * Math.log(spreadOf(global))) / (cat.peers + model.shrink_k);
      const spread = Math.exp(logSpread);
      const half = Math.sqrt(spread);
      const age = ageDays(snapshot.as_of, p.listed_at);
      const adj = adjustments(p, age, unknownAge, model);
      const factor = adj.momentum * adj.age * adj.chains;
      const implied = Math.max(1, Math.round(p.tvl_usd * multiple * factor));
      const low = Math.min(implied, Math.max(1, Math.round(p.tvl_usd * (multiple / half) * factor)));
      const high = Math.max(implied, Math.max(1, Math.round(p.tvl_usd * (multiple * half) * factor)));
      return { p, age, cat, multiple, spread, low, implied, high, adj };
    });
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    watchlist: watch.has(s.p.slug),
    token_status: 'pre-token' as const,
    peer_category: s.p.category,
    peer_count: s.cat.peers,
    peer_multiple: round4(s.multiple),
    band_low_usd: s.low,
    implied_value_usd: s.implied,
    band_high_usd: s.high,
    confidence: confidenceFor(s.cat.peers, s.spread),
    adj: { momentum: round4(s.adj.momentum), age: round4(s.adj.age), chains: round4(s.adj.chains) },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's Already trading view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      symbol: p.symbol,
    }));
}

/** Everything the dashboard renders: the board, the live set, the peer table and the model. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: ScoredRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const { byCategory, global, ratiosByCategory, allRatios, cap } = peerStats(snapshot, model);
  const liveAll = snapshot.protocols.filter((p) => !isPreToken(p));
  const categories: CategoryPeers[] = [...byCategory.entries()]
    .map(([key, v]) => ({ category: key, peers: v.peers, q25: round4(v.q25), median: round4(v.median), q75: round4(v.q75) }))
    .sort((a, b) => b.peers - a.peers || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    unknown_age_days: unknownAgeDays(snapshot),
    peer_cap: round4(cap),
    global_peers: { peers: global.peers, q25: round4(global.q25), median: round4(global.median), q75: round4(global.q75) },
    stats: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter((p) => isPreToken(p)).length,
      board_size: board.length,
      watchlist_size: snapshot.watchlist.length,
      live_size: liveAll.length,
      set_aside: snapshot.protocols.filter((p) => isPreToken(p) && !isRankable(p)).length,
    },
    categories,
    peer_ratios: Object.fromEntries(ratiosByCategory),
    all_ratios: allRatios,
    rows: board,
    live: liveRows(snapshot),
    live_total: liveAll.length,
  };
  return { board, radar };
}

// ------------------------------------------------------------------ farm plans

/** The gas climate of a chain: Ethereum mainnet is dear, most other chains are not. */
type GasTier = 'high' | 'mid' | 'low';

const HIGH_GAS = new Set(['Ethereum']);
const MID_GAS = new Set(['BNB Chain', 'Avalanche', 'Polygon', 'Tron', 'Gnosis', 'Fantom', 'Celo', 'Moonbeam']);

function gasTier(chain: string): GasTier {
  if (HIGH_GAS.has(chain)) return 'high';
  if (MID_GAS.has(chain)) return 'mid';
  return 'low';
}

const GAS_ACTION: Record<GasTier, string> = {
  high: 'about $6-12 of gas at normal mainnet fees',
  mid: 'about $0.50-2 of gas',
  low: 'under $0.50 of gas',
};
const GAS_WEEK: Record<GasTier, string> = {
  high: '$6-12 of gas a week',
  mid: 'about $1 of gas a week',
  low: 'a few cents of gas a week',
};

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category's core action, in the words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = p.category ?? '';
  const n = p.name;
  if (c === 'Lending') return `Supply $${capital} of USDC to ${n}'s ${chain} market, then borrow 30-40% against it and re-supply the borrowed funds once, so the wallet shows both sides of the book.`;
  if (c === 'CDP') return `Deposit $${capital} of collateral into a ${n} vault on ${chain} and mint its stablecoin at a conservative ratio, keeping the health factor above 2.`;
  if (c === 'Dexs') return `Open a $${capital} USDC and native-asset position in ${n}'s deepest pool on ${chain}, in range, and keep the LP position open.`;
  if (c === 'Risk Curators' || c === 'Onchain Capital Allocator') return `Deposit $${capital} of USDC into one of ${n}'s curated vaults on ${chain} and hold the vault shares; the vault, not a manual loop, is the position.`;
  if (c === 'Yield' || c === 'Yield Aggregator' || c === 'Farm') return `Deposit $${capital} of USDC into ${n}'s main vault on ${chain} with auto-compounding on, and hold the receipt shares.`;
  if (c === 'Derivatives') return `Deposit $${capital} of USDC as margin on ${n} and hold one small hedged position (long one market, short the same size elsewhere) so the account stays active without directional risk.`;
  if (c === 'RWA') return `Mint $${capital} of ${n}'s yield-bearing asset on ${chain} and hold it in the farming wallet past the next distribution date.`;
  if (c === 'Basis Trading') return `Fund $${capital} on ${n} and let its basis vault take the position; hold the shares rather than trading the legs yourself.`;
  if (c === 'Indexes') return `Buy $${capital} of ${n}'s index token on ${chain} and hold it; rebalance only when the index does.`;
  if (c === 'Prediction Market') return `Fund $${capital} on ${n} and hold one position in a liquid market until it settles; trade size matters less than a settled history.`;
  if (c === 'Insurance') return `Buy $${capital} of cover from ${n} on ${chain} for a real position you hold elsewhere, and keep the policy to expiry.`;
  if (c === 'Chain') return `Bridge $${capital} to ${n}'s chain, hold the native asset in the farming wallet and make the chain's own apps the weekly activity below.`;
  if (c === 'Launchpad') return `Commit $${capital} to one open sale on ${n} and hold the allocation in the farming wallet rather than flipping it on day one.`;
  return `Deposit $${capital} of USDC into ${n} on ${chain} through its main product page and keep the position open.`;
}

/** The category's second surface: one more thing the same protocol counts, beyond the core action. */
function secondAction(p: SnapshotProtocol, chain: string): string {
  const c = p.category ?? '';
  const n = p.name;
  if (c === 'Lending') return `Also open one small position in a second ${n} market on ${chain} (a different collateral or the isolated market), so the wallet is not a one-market account.`;
  if (c === 'Dexs') return `Also make two or three ordinary swaps through ${n}'s own interface on ${chain} in separate weeks; volume through the router is a second signal beside the LP position.`;
  if (c === 'Risk Curators' || c === 'Onchain Capital Allocator') return `Also hold a second, smaller vault from a different strategy inside ${n}, so the wallet's history spans more than one curator's book.`;
  if (c === 'CDP') return `Also hold a small amount of the minted stablecoin in the wallet instead of selling it all; a holder's balance is a second signal beside the vault.`;
  if (c === 'Derivatives') return `Also trade a second, smaller contract on ${n} in a later week, so the account shows a pattern of use rather than one deposit.`;
  if (p.chains.length > 1) return `Also repeat a small version of the core action on ${p.chains[1]}, ${n}'s second chain: multi-chain use is the cheapest second signal there is.`;
  return `Also use one more surface of ${n} on ${chain} (its second product, its vote page or its rewards page) so the wallet's history is not a single deposit.`;
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and re-check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, derived from the
 * protocol's own record (category, chains, TVL, age, momentum) and from no list of names. The
 * wording, the capital, the gas and the hold all move with the record, so two protocols in
 * different categories on different chains never read the same plan twice.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const tier = gasTier(chain);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const steps: Array<[string, string, string]> = [
    [
      `Set up a fresh wallet for ${p.name} alone, fund it only with what this plan uses, and keep its seed phrase offline.`,
      'no fee to create; the first funding transaction carries the gas',
      '10 minutes',
    ],
    [
      p.chains.length > 1
        ? `Bring $${capital} of USDC to ${chain}, the first of ${p.name}'s ${p.chains.length} chains on record: withdraw from an exchange straight to ${chain} where it is offered, or bridge from Ethereum.`
        : `Bring $${capital} of USDC to ${chain}: withdraw from an exchange straight to the chain where it is offered, or bridge from Ethereum.`,
      `${GAS_ACTION[tier]} for the move`,
      '15 minutes',
    ],
    [coreAction(p, capital, chain), `$${capital} of capital and ${GAS_ACTION[tier]}`, '20 minutes to set up'],
    [secondAction(p, chain), `${GAS_ACTION[tier]}`, '15 minutes'],
    [
      `Repeat one qualifying action every week (a deposit top-up, a rebalance, a swap or a vote through ${p.name}'s own interface), in separate weeks rather than one busy day.`,
      GAS_WEEK[tier],
      '10 minutes a week',
    ],
    [
      p.change_7d !== null && p.change_7d <= -10
        ? `Hold the position at least ${hold} days, and because ${p.name}'s TVL fell ${round2(Math.abs(p.change_7d))}% this week, add nothing more until the trend flattens: keep what is placed, sized as it is.`
        : p.change_7d !== null && p.change_7d >= 25
          ? `Hold the position at least ${hold} days; ${p.name}'s TVL rose ${round2(p.change_7d)}% this week, so size in over two or three weeks instead of all at once, since hot inflows are often mercenary.`
          : `Hold the position at least ${hold} days so the activity lands in more than one weekly snapshot, checking the health of the position (range, collateral ratio) once a week.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ],
    [
      `Before withdrawing, open ${p.name}'s own points or rewards page and claim only from the link it publishes; never pay a third party to claim. Then write the wallet, the dates and every transaction hash into a farm log.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ],
  ];
  return steps.map(([text, cost, time]) => stepText(text, cost, time));
}

// ------------------------------------------------------------------ snapshot in, board checked

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
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

/** Why a board is not one the gate will take, or null: size, coverage, ranks, order, values, farm steps. */
export function boardIssue(board: ScoredRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'a slug appears on the board twice';
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${i + 1} outranks rank ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters once trimmed`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
