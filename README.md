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
