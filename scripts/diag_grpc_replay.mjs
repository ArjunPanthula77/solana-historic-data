#!/usr/bin/env node
/**
 * One-off diagnostic: confirm whether Alchemy's Yellowstone gRPC replay
 * works at all, and how far back it actually reaches, by trying several
 * from-slot offsets behind the current slot.
 */
import Client, { CommitmentLevel } from '@triton-one/yellowstone-grpc';

const API_KEY = process.env.ALCHEMY_API_KEY;
const endpoint = process.argv[2] ?? 'https://solana-mainnet.streaming.alchemy.com';

async function tryReplay(client, fromSlot) {
  return new Promise(async (resolve) => {
    let settled = false;
    const stream = await client.subscribe();
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        stream.end();
        resolve({ fromSlot, ok: false, reason: 'timeout (no error, no data within 8s)' });
      }
    }, 8000);

    stream.on('data', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        stream.end();
        resolve({ fromSlot, ok: true });
      }
    });
    stream.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ fromSlot, ok: false, reason: err?.cause?.message ?? err.message });
      }
    });

    stream.write({
      accounts: {},
      slots: {},
      transactions: {
        any: { vote: false, failed: false, accountInclude: [], accountExclude: [], accountRequired: [] },
      },
      transactionsStatus: {},
      blocks: {},
      blocksMeta: {},
      entry: {},
      accountsDataSlice: [],
      commitment: CommitmentLevel.CONFIRMED,
      fromSlot: fromSlot.toString(),
    });
  });
}

async function main() {
  const client = new Client(endpoint, API_KEY, undefined);
  await client.connect();

  const slotResp = await client.getSlot();
  const current = BigInt(slotResp.slot);
  console.log(`Current slot: ${current}`);

  const offsets = [1000n, 50_000n, 200_000n, 432_000n, 500_000n, 700_000n];
  for (const off of offsets) {
    const target = current - off;
    const result = await tryReplay(client, target);
    console.log(`offset=${off} from_slot=${target} ->`, result);
  }

  console.log('Target epoch 1033 first slot: 446256000');
  const epochResult = await tryReplay(client, 446256000n);
  console.log('epoch 1033 from_slot=446256000 ->', epochResult);

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
