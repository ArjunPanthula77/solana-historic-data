#!/usr/bin/env node
/**
 * Build a per-minute OHLCV rollup from raw JTO-USDC swap records, matching
 * the OPSONCHAIN Volume Oracle's `ohlcv:mint:dex:ts` minute-bucket shape:
 * each minute gets open/high/low/close price plus USDC and JTO volume and
 * trade count, derived purely from the raw swap ledger (no external price
 * feed).
 *
 * Input: JSONL produced by fetch_jito_usdc_archive_rpc.mjs or
 * fetch_jito_usdc_grpc.mjs, one swap per line:
 *   {signature, slot, blockTime, owner, jtoDelta, usdcDelta, priceUsdcPerJto}
 *
 * Usage:
 *   node scripts/build_ohlcv_from_swaps.mjs \
 *     --in data/jito_usdc_epoch_raw_swaps.jsonl \
 *     --out data/jito_usdc_epoch_ohlcv_1m.csv
 */
import fs from 'fs';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    in: { type: 'string' },
    out: { type: 'string', default: 'data/ohlcv_1m.csv' },
    'min-usdc-volume': { type: 'string', default: '0.01' },
  },
});

if (!args.in) {
  console.error('--in <raw swaps jsonl> is required');
  process.exit(1);
}

const MIN_USDC_VOLUME = Number(args['min-usdc-volume']);

function loadSwaps(path) {
  const content = fs.readFileSync(path, 'utf8');
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const swaps = [];
  let skippedMalformed = 0;
  let skippedDust = 0;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      skippedMalformed++;
      continue;
    }
    if (
      typeof rec.blockTime !== 'number' ||
      typeof rec.priceUsdcPerJto !== 'number' ||
      !Number.isFinite(rec.priceUsdcPerJto)
    ) {
      skippedMalformed++;
      continue;
    }
    // Dust filter: the balance-diff heuristic that produced this data flags
    // any transaction where JTO and USDC both moved in opposite directions
    // as a "swap" - including dust-amount residue transfers where one leg
    // is a few lamports/atoms. Those produce nonsensical implied prices
    // (division by a near-zero amount) and are not economically meaningful
    // trades, so they're excluded from the OHLCV rather than silently
    // distorting the high/low range.
    if (Math.abs(rec.usdcDelta) < MIN_USDC_VOLUME) {
      skippedDust++;
      continue;
    }
    swaps.push(rec);
  }
  if (skippedMalformed > 0) console.warn(`Skipped ${skippedMalformed} malformed/unusable line(s).`);
  if (skippedDust > 0) {
    console.warn(
      `Skipped ${skippedDust} dust-amount record(s) below $${MIN_USDC_VOLUME} USDC notional (not real trades).`
    );
  }
  return swaps;
}

function buildBuckets(swaps) {
  // Stable chronological order is required so open/close reflect the first
  // and last trade actually seen in each minute, not JSONL write order
  // (which follows RPC-fetch completion order under concurrency, not time).
  swaps.sort((a, b) => a.blockTime - b.blockTime || a.slot - b.slot);

  const buckets = new Map(); // minuteStart(seconds) -> bucket

  for (const s of swaps) {
    const minute = Math.floor(s.blockTime / 60) * 60;
    const price = s.priceUsdcPerJto;
    const volUsdc = Math.abs(s.usdcDelta);
    const volJto = Math.abs(s.jtoDelta);

    let b = buckets.get(minute);
    if (!b) {
      b = {
        minute,
        open: price,
        high: price,
        low: price,
        close: price,
        volumeUsdc: 0,
        volumeJto: 0,
        trades: 0,
      };
      buckets.set(minute, b);
    }
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.close = price; // swaps are processed in chronological order, so last write wins
    b.volumeUsdc += volUsdc;
    b.volumeJto += volJto;
    b.trades += 1;
  }

  return Array.from(buckets.values()).sort((a, b) => a.minute - b.minute);
}

function main() {
  const swaps = loadSwaps(args.in);
  console.log(`Loaded ${swaps.length} usable swap records from ${args.in}`);

  const buckets = buildBuckets(swaps);
  console.log(`Built ${buckets.length} one-minute OHLCV buckets.`);

  const header = 'minute_ts,datetime_utc,open,high,low,close,volume_usdc,volume_jto,trades\n';
  const rows = buckets.map((b) =>
    [
      b.minute,
      new Date(b.minute * 1000).toISOString(),
      b.open,
      b.high,
      b.low,
      b.close,
      b.volumeUsdc,
      b.volumeJto,
      b.trades,
    ].join(',')
  );

  fs.writeFileSync(args.out, header + rows.join('\n') + '\n');
  console.log(`Wrote ${buckets.length} rows to ${args.out}`);

  if (buckets.length > 0) {
    const totalVolUsdc = buckets.reduce((sum, b) => sum + b.volumeUsdc, 0);
    const totalTrades = buckets.reduce((sum, b) => sum + b.trades, 0);
    console.log(
      `Summary: ${totalTrades} trades, $${totalVolUsdc.toFixed(2)} total USDC volume, ` +
        `price range $${Math.min(...buckets.map((b) => b.low)).toFixed(6)}-` +
        `$${Math.max(...buckets.map((b) => b.high)).toFixed(6)}`
    );
  }
}

main();
