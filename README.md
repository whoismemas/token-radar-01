# Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/whoismemas/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/whoismemas/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar for make.fun's token-radar-01: it reads the sealed DefiLlama snapshot
(`snapshot.json`, 758 protocols at or above $5M TVL) and ranks the protocols that record no
token yet by **implied value** — what a token would be worth if it launched at the protocol's
current record — each with a concrete farm plan.

## Run

```
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

Node 22.18+, standard library only, no network. The program runs deterministically: two runs
write the same bytes. It writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and
`dossier.json` (built with `vendor/makefun-board.ts`) into the output directory.

## The model (lib/model.ts, version radar-2)

- **Separation first.** The board ranks only protocols that record no token and are not a
  wrapped, staked or bridged product of a token that already trades — the watchlist's own line,
  applied to the whole snapshot. All 40 watchlist protocols are covered; the rest of the board
  is the pre-token field below the $50M floor. Trading protocols are shown separately at the
  market's own values.
- **Peer multiples.** Each category's tokenized peers give market-cap/TVL ratios, capped at
  the market's 95th percentile. A row's multiple is its category median shrunk toward the
  global median by peer count (K = 6).
- **Adjustments.** Momentum from 7-day TVL change, an age term that pays for years run with no
  token, and a chain-spread term.
- **Bands, not just points.** Each row carries a low–high band from the peer spread (blended
  in log space, so thin evidence widens the band) and a confidence label derived from it.
- **Farm plans** are generated per protocol from its category, chains, TVL, age and momentum:
  seven steps, each with a cost and a time. No protocol name is special-cased anywhere.

The dashboard (`dashboard/`) is a static, fully offline page: sortable and filterable board,
watchlist and chain filters, a per-protocol detail view that recomputes its row from the peer
ratios in its own data and lands on board.json's number, and the model stated in full.
