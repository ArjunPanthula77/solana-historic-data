#!/usr/bin/env node
/**
 * Seed a local Redis instance with `ohlcv:<mint>:<dex>:<minuteTs>` keys in the
 * exact shape opsonchain-engine's ReplaySnapshotSource expects
 * ({vwapNumer, vwapDenom, volumeUsdc}), computed from our real, already
 * dust-filtered JTO-USDC swap ledger - so the Policy Engine replay gets a
 * genuine historical VWAP/volume signal for epoch 1033.
 *
 * Usage:
 *   node scripts/seed_redis_from_swaps.mjs \
 *     --swaps data/jito_usdc_epoch_raw_swaps.jsonl \
 *     --mint jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL \
 *     --min-usdc-volume 0.01 \
 *     --redis-url redis://127.0.0.1:6379
 */
import fs from 'fs';
import { parseArgs } from 'util';
import { createClient } from 'redis';

const { values: args } = parseArgs({
  options: {
    swaps: { type: 'string' },
    mint: { type: 'string' },
    dex: { type: 'string', default: 'aggregated' },
    'min-usdc-volume': { type: 'string', default: '0.01' },
    'redis-url': { type: 'string', default: 'redis://127.0.0.1:6379' },
  },
});

if (!args.swaps || !args.mint) {
  console.error('--swaps and --mint are required');
  process.exit(1);
}

const MIN_USDC_VOLUME = Number(args['min-usdc-volume']);

function loadSwaps(path) {
  const lines = fs.readFileSync(path, 'utf8').split('\n').filter((l) => l.trim());
  const swaps = [];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      if (typeof r.blockTime === 'number' && Number.isFinite(r.priceUsdcPerJto) && Math.abs(r.usdcDelta) >= MIN_USDC_VOLUME) {
        swaps.push(r);
      }
    } catch {
      /* skip malformed line */
    }
  }
  return swaps;
}

function buildMinuteBuckets(swaps) {
  const buckets = new Map();
  for (const s of swaps) {
    const minute = Math.floor(s.blockTime / 60) * 60;
    const price = s.priceUsdcPerJto;
    const usdcVol = Math.abs(s.usdcDelta);
    let b = buckets.get(minute);
    if (!b) {
      b = { vwapNumer: 0, vwapDenom: 0, volumeUsdc: 0 };
      buckets.set(minute, b);
    }
    // vwapNumer/vwapDenom convention (matches Volume Oracle's own OHLCVBucket):
    // VWAP = sum(price * notionalUsdc) / sum(notionalUsdc).
    b.vwapNumer += price * usdcVol;
    b.vwapDenom += usdcVol;
    b.volumeUsdc += usdcVol;
  }
  return buckets;
}

async function main() {
  const swaps = loadSwaps(args.swaps);
  console.log(`Loaded ${swaps.length} usable swaps from ${args.swaps}`);

  const buckets = buildMinuteBuckets(swaps);
  console.log(`Built ${buckets.size} one-minute VWAP/volume buckets`);

  const client = createClient({ url: args['redis-url'] });
  await client.connect();

  let written = 0;
  for (const [minute, b] of buckets) {
    const key = `ohlcv:${args.mint}:${args.dex}:${minute}`;
    const value = JSON.stringify({
      vwapNumer: b.vwapNumer.toString(),
      vwapDenom: b.vwapDenom.toString(),
      volumeUsdc: b.volumeUsdc.toString(),
    });
    await client.set(key, value);
    written++;
  }

  console.log(`Wrote ${written} ohlcv keys to Redis at ${args['redis-url']}`);

  const minutes = Array.from(buckets.keys()).sort((a, b) => a - b);
  console.log(`Minute range: ${minutes[0]} (${new Date(minutes[0] * 1000).toISOString()}) -> ${minutes[minutes.length - 1]} (${new Date(minutes[minutes.length - 1] * 1000).toISOString()})`);

  await client.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
