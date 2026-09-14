#!/usr/bin/env node
/**
 * Pull raw JTO-USDC swap transactions for a past Solana epoch via Alchemy's
 * Yellowstone gRPC "historical replay" feature.
 *
 * Alchemy (like other Yellowstone providers) can replay a live transaction
 * feed starting from any slot within roughly the last 432,000 slots (~48h).
 * Older than that, this approach cannot reach the data at all - Yellowstone
 * replay is a reconnection/backfill feature, not a general archive.
 *
 * Approach:
 *   1. Subscribe with `fromSlot` = the epoch's first slot, filtered to
 *      transactions that touch the JTO mint account.
 *   2. For each transaction, diff pre/post SPL token balances for JTO and
 *      USDC. A transaction where the same owner's JTO balance and USDC
 *      balance move in opposite directions is treated as a JTO<->USDC swap.
 *   3. Stream until we've observed a slot past the epoch's last slot, then
 *      close the stream and write out what was collected.
 *
 * This does NOT decode DEX-specific swap instructions (Raydium/Orca/Meteora/
 * Jupiter each encode differently) - it infers swaps purely from token
 * balance deltas, which is DEX-agnostic but will also catch multi-hop swaps
 * that pass through JTO and USDC as one leg of a longer route.
 *
 * Usage:
 *   ALCHEMY_API_KEY=... node scripts/fetch_jito_usdc_grpc.mjs \
 *     --from-slot 446256000 --to-slot 446687999 \
 *     --out data/jito_usdc_epoch1033_raw_swaps.jsonl
 */
import fs from 'fs';
import { parseArgs } from 'util';
import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';

const { values: args } = parseArgs({
  options: {
    'from-slot': { type: 'string' },
    'to-slot': { type: 'string' },
    out: { type: 'string', default: 'data/jito_usdc_epoch_raw_swaps.jsonl' },
    endpoint: { type: 'string', default: 'https://solana-mainnet.streaming.alchemy.com' },
    'idle-timeout-ms': { type: 'string', default: '120000' },
  },
});

const JTO_MINT = 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const API_KEY = process.env.ALCHEMY_API_KEY;
if (!API_KEY) {
  console.error('ALCHEMY_API_KEY env var is required');
  process.exit(1);
}
if (!args['from-slot'] || !args['to-slot']) {
  console.error('--from-slot and --to-slot are required (epoch slot range)');
  process.exit(1);
}

const FROM_SLOT = BigInt(args['from-slot']);
const TO_SLOT = BigInt(args['to-slot']);
const IDLE_TIMEOUT_MS = Number(args['idle-timeout-ms']);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(buf) {
  if (!buf || buf.length === 0) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let x = BigInt('0x' + bytes.toString('hex'));
  let out = '';
  while (x > 0n) {
    out = B58[Number(x % 58n)] + out;
    x /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) out = '1' + out;
  return out || '1';
}

function balancesByOwnerAndMint(tokenBalances) {
  const map = new Map();
  for (const b of tokenBalances ?? []) {
    if (!b.owner) continue;
    const key = `${b.owner}:${b.mint}`;
    const amount = Number(b.uiTokenAmount?.uiAmountString ?? b.uiTokenAmount?.uiAmount ?? 0);
    map.set(key, amount);
  }
  return map;
}

async function main() {
  const client = new Client(args.endpoint, API_KEY, undefined);
  const stream = await client.subscribe();

  const out = fs.createWriteStream(args.out, { flags: 'w' });
  let seenAny = false;
  let maxSlotSeen = 0n;
  let txCount = 0;
  let swapCount = 0;
  let lastMessageAt = Date.now();

  const idleTimer = setInterval(() => {
    if (Date.now() - lastMessageAt > IDLE_TIMEOUT_MS) {
      console.log(`No messages for ${IDLE_TIMEOUT_MS}ms — stopping.`);
      finish();
    }
  }, 5000);

  function finish() {
    clearInterval(idleTimer);
    out.end();
    stream.end();
    console.log(
      `Done. transactions_seen=${txCount} swaps_written=${swapCount} max_slot_seen=${maxSlotSeen} out=${args.out}`
    );
    process.exit(0);
  }

  stream.on('data', (update) => {
    lastMessageAt = Date.now();
    seenAny = true;

    const txUpdate = update.transaction;
    if (!txUpdate) return;

    const slot = BigInt(txUpdate.slot ?? 0);
    if (slot > maxSlotSeen) maxSlotSeen = slot;

    const info = txUpdate.transaction;
    const meta = info?.meta;
    if (!meta || meta.err) return;

    txCount++;

    const pre = balancesByOwnerAndMint(meta.preTokenBalances);
    const post = balancesByOwnerAndMint(meta.postTokenBalances);

    const owners = new Set(
      [...meta.preTokenBalances ?? [], ...meta.postTokenBalances ?? []]
        .map((b) => b.owner)
        .filter(Boolean)
    );

    for (const owner of owners) {
      const jtoPre = pre.get(`${owner}:${JTO_MINT}`) ?? 0;
      const jtoPost = post.get(`${owner}:${JTO_MINT}`) ?? 0;
      const usdcPre = pre.get(`${owner}:${USDC_MINT}`) ?? 0;
      const usdcPost = post.get(`${owner}:${USDC_MINT}`) ?? 0;

      const jtoDelta = jtoPost - jtoPre;
      const usdcDelta = usdcPost - usdcPre;

      // Real swap: both legs moved, in opposite directions.
      if (jtoDelta !== 0 && usdcDelta !== 0 && Math.sign(jtoDelta) !== Math.sign(usdcDelta)) {
        const sig = base58(info.signature);
        swapCount++;
        out.write(
          JSON.stringify({
            signature: sig,
            slot: Number(slot),
            owner,
            jtoDelta,
            usdcDelta,
            priceUsdcPerJto: Math.abs(usdcDelta / jtoDelta),
          }) + '\n'
        );
        break; // one swap record per tx per matching owner is enough for this pass
      }
    }

    if (slot > TO_SLOT) {
      console.log(`Reached slot ${slot} > target end ${TO_SLOT} — stopping.`);
      finish();
    }
  });

  stream.on('error', (err) => {
    console.error('Stream error:', err);
    finish();
  });
  stream.on('end', () => {
    console.log('Stream ended by server.');
    finish();
  });

  const request = {
    accounts: {},
    slots: {},
    transactions: {
      jtoUsdc: {
        vote: false,
        failed: false,
        accountInclude: [JTO_MINT],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
    fromSlot: FROM_SLOT.toString(),
  };

  stream.write(request);
  console.log(`Subscribed from slot ${FROM_SLOT} targeting end slot ${TO_SLOT}...`);

  setTimeout(() => {
    if (!seenAny) {
      console.error('No data received within idle timeout — check API key / replay window.');
      finish();
    }
  }, IDLE_TIMEOUT_MS);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
