const API_KEY = process.env.ALCHEMY_API_KEY;
const RPC_URL = `https://solana-mainnet.g.alchemy.com/v2/${API_KEY}`;
const ADDR = '8ekCy2jHHUbW2yeNGFWYJT9Hm9FW7SvZcZK66dSZCDiF';

const KNOWN = {
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C': 'Raydium CPMM',
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK': 'Raydium CLMM',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc': 'Orca Whirlpool (CLMM)',
  '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP': 'Orca legacy AMM',
  'LBUZKhRxPF3XUpBCjp4YzTKkgLccjZhTSDM9YuVaPwxo': 'Meteora DLMM',
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB': 'Meteora Pools (dynamic)',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA': 'SPL Token Program',
};

const resp = await fetch(RPC_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [ADDR, { encoding: 'jsonParsed' }] }),
});
const body = await resp.json();
if (body.error) { console.error('RPC error:', body.error); process.exit(1); }
const owner = body.result?.value?.owner;
console.log('Account:', ADDR);
console.log('Owner program:', owner);
console.log('Known as:', KNOWN[owner] ?? '(not in known-program list)');
console.log('Full account info:', JSON.stringify(body.result?.value, null, 2).slice(0, 2000));
