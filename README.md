# solana-historic-data

## JTO-USDC last epoch data

`scripts/fetch_jito_last_epoch.py` pulls JTO price/volume/market-cap data for
the most recently completed Solana epoch:

1. Queries a Solana RPC endpoint for the current epoch info and epoch
   schedule to compute the slot range of the last completed epoch.
2. Resolves that slot range to a UTC time window via `getBlockTime`.
3. Fetches JTO/USD history for that window from CoinGecko's
   `market_chart/range` endpoint (no API key needed). USDC tracks USD 1:1,
   so this doubles as the JTO-USDC series.
4. Writes `data/jito_usdc_last_epoch.csv` with columns:
   `timestamp_ms, datetime_utc, price_usd, volume_usd, market_cap_usd`.

### Usage

```bash
pip install -r requirements.txt
python scripts/fetch_jito_last_epoch.py
```

> Note: this requires outbound network access to `api.mainnet-beta.solana.com`
> and `api.coingecko.com`. It was not executed in the sandbox that authored
> it because both hosts are blocked by that environment's egress policy —
> run it locally or in CI where those hosts are reachable.

## JTO-USDC raw swap transactions (not just aggregates)

The above pulls hourly *aggregated* price/volume from CoinGecko — it does not
contain individual transactions. `scripts/fetch_jito_usdc_grpc.mjs` pulls raw
per-transaction swap data instead, via Alchemy's Yellowstone gRPC "historical
replay" feature.

**Important limitation:** Yellowstone gRPC replay can only rewind roughly the
last 432,000 slots (~48 hours) from the current slot — it is a
reconnection/backfill mechanism, not a full archive. It cannot reach epochs
older than that window. If the target epoch has already aged out, this
script cannot get the data at all; you would need a full historical indexer
(e.g. Helius enhanced transaction history, or Birdeye's trade-history API)
instead.

The script:
1. Subscribes to Alchemy's gRPC feed starting at `--from-slot`, filtered to
   transactions that touch the JTO mint account.
2. For each transaction, diffs pre/post SPL token balances per owner. A
   transaction where the same owner's JTO and USDC balances move in opposite
   directions is recorded as a swap (signature, slot, owner, JTO delta, USDC
   delta, implied price).
3. Stops once it observes a slot past `--to-slot`.

This is DEX-agnostic (it doesn't decode Raydium/Orca/Meteora/Jupiter
instruction formats individually) but will also pick up JTO-USDC legs of
multi-hop routed swaps.

### Usage

```bash
npm install
ALCHEMY_API_KEY=your_key_here node scripts/fetch_jito_usdc_grpc.mjs \
  --from-slot 446256000 --to-slot 446687999 \
  --out data/jito_usdc_raw_swaps.jsonl
```

### Running via GitHub Actions

A workflow (`.github/workflows/fetch-jito-usdc-swaps-grpc.yml`) runs this on
GitHub's runners. Before triggering it:

1. Add a repository secret named `ALCHEMY_API_KEY` (Settings → Secrets and
   variables → Actions → New repository secret).
2. Run the workflow from the Actions tab, or via API, passing `from_slot` /
   `to_slot` inputs (defaults to epoch 1033's slot range).

Never commit the raw API key into any file — it must only live in the
`ALCHEMY_API_KEY` repository secret.

## Reaching an already-aged-out epoch: archival RPC instead of gRPC replay

Once an epoch falls outside the ~432,000-slot gRPC replay window, use
`scripts/fetch_jito_usdc_archive_rpc.mjs` instead. It uses Alchemy's standard
archival JSON-RPC (`getSignaturesForAddress` + `getTransaction`), which
serves full history back to genesis, so it can reach any past epoch. Same
balance-diff swap detection as the gRPC script, no extra npm dependency
(uses Node's built-in `fetch`).

```bash
ALCHEMY_API_KEY=your_key_here node scripts/fetch_jito_usdc_archive_rpc.mjs \
  --from-slot 446256000 --to-slot 446687999 \
  --out data/jito_usdc_epoch_raw_swaps.jsonl
```

Runs via `.github/workflows/fetch-jito-usdc-swaps-archive-rpc.yml` the same
way as the gRPC workflow (repo secret or one-off `api_key` input). For epoch
1033 this found 18,788 candidate transactions and 7,197 real swaps in about
90 seconds.

**Data-quality note:** the balance-diff heuristic (a transaction is a "swap"
if the same owner's JTO and USDC balances move in opposite directions) will
occasionally misfire on dust-amount residue transfers, producing nonsensical
implied prices. Filter these out downstream (see the OHLCV builder below) —
the raw JSONL intentionally keeps everything so no data is silently dropped
at collection time.

## Building OHLCV from the raw swap ledger

`scripts/build_ohlcv_from_swaps.mjs` rolls the raw per-transaction swap JSONL
into one-minute OHLCV buckets (open/high/low/close/volume), matching the
OPSONCHAIN Volume Oracle's `ohlcv:mint:dex:ts` minute-bucket shape. It runs
entirely offline against an already-fetched JSONL file — no API key or
network needed.

```bash
node scripts/build_ohlcv_from_swaps.mjs \
  --in data/jito_usdc_epoch_raw_swaps.jsonl \
  --out data/jito_usdc_epoch1033_ohlcv_1m.csv \
  --min-usdc-volume 0.01
```

`--min-usdc-volume` (default `0.01`) drops swaps whose USDC notional is
below the threshold before bucketing — this is the dust filter described
above. For epoch 1033: 7,197 raw records → 456 dropped as dust → 6,741 real
trades → 1,813 one-minute buckets, ~$334,583 total USDC volume, prices
consistent with the ~$0.42–0.45 range from the CoinGecko aggregate. A
handful of remaining outlier prices (a multi-instruction transaction whose
USDC and JTO legs may not actually belong to the same swap) can still slip
through — the heuristic is DEX-agnostic but not a full instruction decoder,
so treat isolated extreme values with suspicion rather than as certain.
