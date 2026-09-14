#!/usr/bin/env node
/**
 * Pull raw JTO<->USDC swap transactions for a past Solana epoch via Alchemy's
 * standard archival JSON-RPC (getSignaturesForAddress + getTransaction).
 *
 * Unlike the Yellowstone gRPC replay path (limited to ~432,000 slots / ~48h),
 * Alchemy's archival RPC methods serve full history back to genesis, so this
 * can reach any past epoch.
 *
 * Approach:
 *   1. Page backward through getSignaturesForAddress for the JTO mint,
 *      newest-first, using the `before` cursor, until the returned slots
 *      fall below the epoch's first slot.
 *   2. Keep only signatures whose slot falls within [fromSlot, toSlot].
 *   3. For each kept signature, fetch the parsed transaction and diff
 *      pre/post SPL token balances per owner. A transaction where the same
 *      owner's JTO and USDC balances move in opposite directions is
 *      recorded as a swap - this catches any DEX/route, not just one pool.
 *
 * Usage:
 *   ALCHEMY_API_KEY=... node scripts/fetch_jito_usdc_archive_rpc.mjs \
 *     --from-slot 446256000 --to-slot 446687999 \
 *     --out data/jito_usdc_epoch1033_raw_swaps.jsonl
 */
import fs from 'fs';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    'from-slot': { type: 'string' },
    'to-slot': { type: 'string' },
    out: { type: 'string', default: 'data/jito_usdc_raw_swaps.jsonl' },
    'tx-concurrency': { type: 'string', default: '8' },
    'max-pages': { type: 'string', default: '5000' },
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

const FROM_SLOT = Number(args['from-slot']);
const TO_SLOT = Number(args['to-slot']);
const MAX_PAGES = Number(args['max-pages']);
const TX_CONCURRENCY = Number(args['tx-concurrency']);
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
    const body = await resp.json();
    if (body.error) {
      throw new Error(`${method} RPC error: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
  throw new Error(`${method} failed after ${retries} retries`);
}

async function collectSignaturesInRange() {
  const kept = [];
  let before = undefined;
  let page = 0;
  let sawBelowRange = false;

  while (page < MAX_PAGES) {
    page++;
    const results = await rpc('getSignaturesForAddress', [
      JTO_MINT,
      { limit: 1000, before, commitment: 'confirmed' },
    ]);
    if (!results || results.length === 0) break;

    for (const r of results) {
      if (r.slot > TO_SLOT) continue; // still newer than our epoch, skip
      if (r.slot < FROM_SLOT) {
        sawBelowRange = true;
        break;
      }
      if (r.err == null) kept.push(r.signature);
    }

    console.log(
      `page ${page}: got ${results.length} sigs, newest_slot=${results[0].slot}, oldest_slot=${
        results[results.length - 1].slot
      }, kept_so_far=${kept.length}`
    );

    if (sawBelowRange) break;
    before = results[results.length - 1].signature;
  }

  return kept;
}

function balancesByOwnerAndMint(tokenBalances) {
  const map = new Map();
  for (const b of tokenBalances ?? []) {
    if (!b.owner) continue;
    const key = `${b.owner}:${b.mint}`;
    const amount = Number(b.uiTokenAmount?.uiAmount ?? 0);
    map.set(key, amount);
  }
  return map;
}

async function processSignature(sig, out) {
  const tx = await rpc('getTransaction', [
    sig,
    { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0, commitment: 'confirmed' },
  ]);
  if (!tx || tx.meta?.err) return 0;

  const pre = balancesByOwnerAndMint(tx.meta.preTokenBalances);
  const post = balancesByOwnerAndMint(tx.meta.postTokenBalances);
  const owners = new Set(
    [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])]
      .map((b) => b.owner)
      .filter(Boolean)
  );

  let written = 0;
  for (const owner of owners) {
    const jtoPre = pre.get(`${owner}:${JTO_MINT}`) ?? 0;
    const jtoPost = post.get(`${owner}:${JTO_MINT}`) ?? 0;
    const usdcPre = pre.get(`${owner}:${USDC_MINT}`) ?? 0;
    const usdcPost = post.get(`${owner}:${USDC_MINT}`) ?? 0;

    const jtoDelta = jtoPost - jtoPre;
    const usdcDelta = usdcPost - usdcPre;

    if (jtoDelta !== 0 && usdcDelta !== 0 && Math.sign(jtoDelta) !== Math.sign(usdcDelta)) {
      out.write(
        JSON.stringify({
          signature: sig,
          slot: tx.slot,
          blockTime: tx.blockTime,
          owner,
          jtoDelta,
          usdcDelta,
          priceUsdcPerJto: Math.abs(usdcDelta / jtoDelta),
        }) + '\n'
      );
      written++;
      break;
    }
  }
  return written;
}

async function runPool(items, worker, concurrency) {
  // `processed`/`written` are plain counters incremented synchronously right
  // after each `await worker(...)` resolves. JS's single-threaded event loop
  // makes each increment atomic, so this is safe across concurrent `next()`
  // loops - unlike an earlier version of this function, whose reported total
  // silently diverged from the number of lines actually written to disk.
  // To make that class of bug impossible to reintroduce silently, the final
  // count returned here is cross-checked against the output file's real
  // line count in main() before being trusted.
  let index = 0;
  let written = 0;
  let processed = 0;

  async function next() {
    while (index < items.length) {
      const i = index++;
      let result = 0;
      try {
        result = await worker(items[i]);
      } catch (err) {
        console.error(`tx ${items[i]} failed:`, err.message);
      }
      written += result;
      processed++;
      if (processed % 200 === 0) {
        console.log(`  processed ${processed}/${items.length} txs, swaps_found=${written}`);
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, next));
  return written;
}

async function main() {
  console.log(`Collecting signatures touching JTO mint for slots [${FROM_SLOT}, ${TO_SLOT}]...`);
  const signatures = await collectSignaturesInRange();
  console.log(`Found ${signatures.length} successful signatures in range.`);

  const out = fs.createWriteStream(args.out, { flags: 'w' });
  const reportedCount = await runPool(
    signatures,
    (sig) => processSignature(sig, out),
    TX_CONCURRENCY
  );
  await new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : resolve()));
  });

  // Authoritative count: the file itself, not the in-memory accumulator.
  const fileContent = fs.readFileSync(args.out, 'utf8');
  const actualLines = fileContent.length === 0 ? 0 : fileContent.trimEnd().split('\n').length;
  if (actualLines !== reportedCount) {
    console.warn(
      `WARNING: in-memory count (${reportedCount}) != actual file line count (${actualLines}). Using file count.`
    );
  }

  console.log(
    `Done. transactions_scanned=${signatures.length} swaps_written=${actualLines} out=${args.out}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
