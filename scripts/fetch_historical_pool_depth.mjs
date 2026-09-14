#!/usr/bin/env node
/**
 * Reconstruct a historical depth/liquidity time series for one Orca
 * Whirlpool (JTO-USDC), for feeding the Policy Engine's OracleSnapshot
 * (depth_usdc, spread_bps, buy_50k_bps, max_size_at_50bps).
 *
 * IMPORTANT — read before trusting this data quantitatively:
 *
 * The live Volume Oracle computes these fields by simulating trades against
 * the pool's LIVE concentrated-liquidity tick-array state via Orca's own
 * @orca-so/whirlpools-sdk (see src/liquidity/providers/orca_whirlpool.ts in
 * the OPSONCHAIN-Historic-Replay repo). That is fundamentally a "query
 * current on-chain state" operation. Solana RPC (including Alchemy's
 * archival methods) has no "give me this account's state as of slot X" call
 * for arbitrary past slots — only transaction/signature history is
 * archived, not point-in-time account snapshots. Reconstructing the true
 * historical tick-array liquidity distribution would require replaying
 * every liquidity-modifying instruction against the pool from its creation
 * (or a known checkpoint) forward — out of scope here.
 *
 * What this script actually does instead:
 *   1. Decodes the whirlpool's CURRENT account state (via the official
 *      @orca-so/whirlpools-sdk parser, not hand-rolled byte offsets) to get
 *      the vault token account addresses and the pool's static fee rate.
 *      Vault addresses and fee rate do not change over the pool's life, so
 *      reading them "now" for a pool that already existed during the target
 *      epoch is safe.
 *   2. Reconstructs each vault's HISTORICAL balance over time by walking
 *      its real transaction history (getSignaturesForAddress +
 *      getTransaction) and reading the vault's own postTokenBalance from
 *      each transaction's metadata - this part IS a faithful historical
 *      reconstruction, not an approximation, because Solana permanently
 *      records post-transaction balances.
 *   3. Approximates depth/slippage from those two reserve numbers using
 *      constant-product (xy=k) math. This is NOT how a concentrated-
 *      liquidity pool actually behaves - real Whirlpool liquidity is
 *      concentrated in a price range, not spread evenly across the full
 *      reserve like a classic AMM. This approximation's error direction is
 *      not known in advance (it can over- or under-state real slippage
 *      depending on how concentrated the pool's actual liquidity was at the
 *      time) - treat buy_50k_bps/max_size_at_50bps from this script as a
 *      rough non-zero placeholder, not a source of truth.
 *   4. spread_bps is the one field computed exactly (not approximated):
 *      it's read directly from the pool's static, on-chain fee-tier
 *      parameter, which does not change and has no historical-reconstruction
 *      problem.
 *
 * Usage:
 *   ALCHEMY_API_KEY=... node scripts/fetch_historical_pool_depth.mjs \
 *     --pool AwBhvNXf5X5hNbC1jAqrJ7Stx5xLuG97xDjJ9PNy1h65 \
 *     --from-slot 446256000 --to-slot 446687999 \
 *     --out data/jito_usdc_epoch1033_pool_depth_1m.csv
 */
import fs from 'fs';
import { parseArgs } from 'util';
import { PublicKey } from '@solana/web3.js';
import { ParsableWhirlpool, PriceMath } from '@orca-so/whirlpools-sdk';

const { values: args } = parseArgs({
  options: {
    pool: { type: 'string' },
    'from-slot': { type: 'string' },
    'to-slot': { type: 'string' },
    out: { type: 'string', default: 'data/pool_depth_1m.csv' },
  },
});

const API_KEY = process.env.ALCHEMY_API_KEY;
if (!API_KEY) {
  console.error('ALCHEMY_API_KEY env var is required');
  process.exit(1);
}
if (!args.pool || !args['from-slot'] || !args['to-slot']) {
  console.error('--pool, --from-slot, --to-slot are required');
  process.exit(1);
}

const FROM_SLOT = Number(args['from-slot']);
const TO_SLOT = Number(args['to-slot']);
const RPC_URL = `https://solana-mainnet.g.alchemy.com/v2/${API_KEY}`;

async function rpc(method, params, { retries = 6 } = {}) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (resp.status === 429 || resp.status >= 500) {
      const wait = Math.min(2000 * 2 ** attempt, 20000);
      console.log(`  ${method} got ${resp.status}, retrying in ${wait}ms...`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    const text = await resp.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`${method} returned non-JSON response (status ${resp.status}): ${text.slice(0, 200)}`);
    }
    if (body.error) throw new Error(`${method} RPC error: ${JSON.stringify(body.error)}`);
    return body.result;
  }
  throw new Error(`${method} failed after ${retries} retries`);
}

async function getWhirlpoolState(poolAddress) {
  const info = await rpc('getAccountInfo', [poolAddress, { encoding: 'base64' }]);
  if (!info?.value) throw new Error(`whirlpool account ${poolAddress} not found`);
  const data = Buffer.from(info.value.data[0], 'base64');
  const parsed = ParsableWhirlpool.parse(new PublicKey(poolAddress), {
    data,
    owner: new PublicKey(info.value.owner),
    lamports: info.value.lamports,
    executable: info.value.executable,
    rentEpoch: info.value.rentEpoch,
  });
  if (!parsed) throw new Error('failed to decode whirlpool account (SDK parser returned null)');
  return parsed;
}

async function getMintDecimals(mintAddress) {
  const info = await rpc('getAccountInfo', [mintAddress, { encoding: 'jsonParsed' }]);
  const decimals = info?.value?.data?.parsed?.info?.decimals;
  if (typeof decimals !== 'number') throw new Error(`could not read decimals for mint ${mintAddress}`);
  return decimals;
}

async function collectVaultBalanceHistory(vaultAddress) {
  const points = []; // {blockTime, slot, uiAmount}
  let before = undefined;
  let page = 0;
  let sawBelowRange = false;
  const sigsInRange = [];

  while (page < 5000) {
    page++;
    const results = await rpc('getSignaturesForAddress', [
      vaultAddress,
      { limit: 1000, before, commitment: 'confirmed' },
    ]);
    if (!results || results.length === 0) break;

    for (const r of results) {
      if (r.slot > TO_SLOT) continue;
      if (r.slot < FROM_SLOT) {
        sawBelowRange = true;
        break;
      }
      if (r.err == null) sigsInRange.push(r.signature);
    }
    if (sawBelowRange) break;
    before = results[results.length - 1].signature;
  }

  console.log(`  vault ${vaultAddress}: ${sigsInRange.length} transactions in range`);

  let processed = 0;
  for (const sig of sigsInRange) {
    const tx = await rpc('getTransaction', [
      sig,
      { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
    ]);
    processed++;
    if (processed % 200 === 0) console.log(`    ${processed}/${sigsInRange.length} vault txs fetched`);
    if (!tx || tx.meta?.err) continue;

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === 'string' ? k : k.pubkey
    );
    const vaultIndex = accountKeys.indexOf(vaultAddress);
    if (vaultIndex === -1) continue;

    const postBal = (tx.meta.postTokenBalances ?? []).find((b) => b.accountIndex === vaultIndex);
    if (!postBal) continue;

    points.push({
      blockTime: tx.blockTime,
      slot: tx.slot,
      uiAmount: Number(postBal.uiTokenAmount.uiAmount ?? 0),
    });
  }

  points.sort((a, b) => a.blockTime - b.blockTime);
  return points;
}

function forwardFillAtMinutes(points, fromSlotTime, toSlotTime) {
  // Returns a Map<minuteTs, reserveAmount> covering every minute in
  // [fromSlotTime, toSlotTime], using the most recent known reserve value
  // at or before that minute (forward-fill), which is the standard way to
  // represent "balance as of time T" from sparse event data.
  const startMin = Math.floor(fromSlotTime / 60) * 60;
  const endMin = Math.floor(toSlotTime / 60) * 60;
  const result = new Map();
  let idx = 0;
  let lastKnown = points.length > 0 ? points[0].uiAmount : null;

  for (let m = startMin; m <= endMin; m += 60) {
    while (idx < points.length && points[idx].blockTime <= m) {
      lastKnown = points[idx].uiAmount;
      idx++;
    }
    result.set(m, lastKnown);
  }
  return result;
}

function constantProductSlippageBps(reserveQuoteUsdc, reserveBaseToken, midPrice, sizeUsdc) {
  // xy=k approximation. See module docstring for why this is a rough
  // placeholder for a concentrated-liquidity pool, not a faithful model.
  if (!(reserveQuoteUsdc > 0) || !(reserveBaseToken > 0) || !(midPrice > 0)) return null;
  const k = reserveQuoteUsdc * reserveBaseToken;
  const newQuote = reserveQuoteUsdc + sizeUsdc;
  const newBase = k / newQuote;
  const baseOut = reserveBaseToken - newBase;
  if (!(baseOut > 0)) return null;
  const effectivePrice = sizeUsdc / baseOut;
  return ((effectivePrice / midPrice - 1) * 10_000);
}

async function main() {
  console.log(`Decoding whirlpool ${args.pool}...`);
  const pool = await getWhirlpoolState(args.pool);

  const mintA = pool.tokenMintA.toBase58();
  const mintB = pool.tokenMintB.toBase58();
  const vaultA = pool.tokenVaultA.toBase58();
  const vaultB = pool.tokenVaultB.toBase58();

  const [decimalsA, decimalsB] = await Promise.all([getMintDecimals(mintA), getMintDecimals(mintB)]);

  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const aIsUsdc = mintA === USDC_MINT;
  const bIsUsdc = mintB === USDC_MINT;
  if (!aIsUsdc && !bIsUsdc) throw new Error('neither pool token is USDC - wrong pool for this script');

  const usdcVault = aIsUsdc ? vaultA : vaultB;
  const tokenVault = aIsUsdc ? vaultB : vaultA;
  console.log(`Mint A=${mintA} (dec ${decimalsA}), Mint B=${mintB} (dec ${decimalsB})`);
  console.log(`USDC vault=${usdcVault}, token vault=${tokenVault}`);

  // feeRate is stored in hundredths of a basis point (per Whirlpool convention).
  const feeBps = pool.feeRate / 100;
  console.log(`Static pool fee: ${feeBps} bps (this part is exact, not approximated)`);

  console.log('Reconstructing historical vault balances...');
  const [usdcPoints, tokenPoints] = await Promise.all([
    collectVaultBalanceHistory(usdcVault),
    collectVaultBalanceHistory(tokenVault),
  ]);

  if (usdcPoints.length === 0 || tokenPoints.length === 0) {
    throw new Error('no historical balance points found for one or both vaults in this slot range');
  }

  const fromTime = usdcPoints[0].blockTime;
  const toTime = usdcPoints[usdcPoints.length - 1].blockTime;
  const usdcByMinute = forwardFillAtMinutes(usdcPoints, fromTime, toTime);
  const tokenByMinute = forwardFillAtMinutes(tokenPoints, fromTime, toTime);

  const header =
    'minute_ts,datetime_utc,usdc_reserve,token_reserve,mid_price_usdc,depth_usdc_tvl,fee_bps,buy_50k_bps_approx,max_size_at_50bps_approx\n';
  const rows = [];

  for (const [minute, usdcReserve] of usdcByMinute) {
    const tokenReserve = tokenByMinute.get(minute);
    if (usdcReserve == null || tokenReserve == null || tokenReserve === 0) continue;

    const midPrice = usdcReserve / tokenReserve;
    const depthUsdcTvl = usdcReserve + tokenReserve * midPrice; // simple TVL, see docstring
    const buy50kBps = constantProductSlippageBps(usdcReserve, tokenReserve, midPrice, 50_000);

    // Binary search the USDC size whose constant-product slippage crosses 50bps.
    let lo = 0;
    let hi = usdcReserve * 0.99;
    let maxSizeAt50 = 0;
    for (let i = 0; i < 40 && hi - lo > 1; i++) {
      const mid = (lo + hi) / 2;
      const bps = constantProductSlippageBps(usdcReserve, tokenReserve, midPrice, mid);
      if (bps != null && bps <= 50) {
        maxSizeAt50 = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }

    rows.push(
      [
        minute,
        new Date(minute * 1000).toISOString(),
        usdcReserve,
        tokenReserve,
        midPrice,
        depthUsdcTvl,
        feeBps,
        buy50kBps == null ? '' : buy50kBps,
        maxSizeAt50,
      ].join(',')
    );
  }

  fs.writeFileSync(args.out, header + rows.join('\n') + '\n');
  console.log(`Wrote ${rows.length} rows to ${args.out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
