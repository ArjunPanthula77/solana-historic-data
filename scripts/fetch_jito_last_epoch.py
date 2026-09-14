#!/usr/bin/env python3
"""Pull JTO-USD(C) pair data covering the last completed Solana epoch.

Steps:
1. Ask a Solana RPC endpoint for the current epoch info + schedule to work
   out the slot range of the *previous* (last completed) epoch.
2. Resolve that slot range to a wall-clock time window via getBlockTime.
3. Pull JTO price/volume/market-cap history for that window from CoinGecko's
   market_chart/range endpoint (JTO is quoted in USD there; USDC tracks USD
   1:1 so this is the JTO-USDC series for practical purposes).
4. Write the result to data/jito_usdc_last_epoch.csv.

No API key required for either service. Requires the `requests` package.
"""
from __future__ import annotations

import csv
import sys
import time
from pathlib import Path

import requests

SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com"
COINGECKO_COIN_ID = "jito-governance-token"  # JTO
VS_CURRENCY = "usd"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "data" / "jito_usdc_last_epoch.csv"


def rpc_call(method: str, params: list | None = None) -> dict:
    resp = requests.post(
        SOLANA_RPC_URL,
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []},
        timeout=30,
    )
    resp.raise_for_status()
    payload = resp.json()
    if "error" in payload:
        raise RuntimeError(f"RPC error calling {method}: {payload['error']}")
    return payload["result"]


def get_last_epoch_slot_range() -> tuple[int, int]:
    """Return (first_slot, last_slot) of the last *completed* epoch."""
    epoch_info = rpc_call("getEpochInfo")
    current_epoch = epoch_info["epoch"]
    slots_in_current_epoch = epoch_info["slotsInEpoch"]
    absolute_slot = epoch_info["absoluteSlot"]
    slot_index = epoch_info["slotIndex"]

    # First slot of the *current* epoch.
    first_slot_current_epoch = absolute_slot - slot_index

    schedule = rpc_call("getEpochSchedule")
    # Post-warmup epochs are a fixed size; use it to step back one epoch.
    slots_per_epoch = schedule.get("slotsPerEpoch", slots_in_current_epoch)

    last_epoch_first_slot = max(first_slot_current_epoch - slots_per_epoch, 0)
    last_epoch_last_slot = first_slot_current_epoch - 1
    return last_epoch_first_slot, last_epoch_last_slot


def get_block_time_near(slot: int, search_forward: bool = True, max_tries: int = 20) -> int:
    """getBlockTime errors on skipped slots, so walk to the nearest real block."""
    step = 1 if search_forward else -1
    s = slot
    for _ in range(max_tries):
        try:
            block_time = rpc_call("getBlockTime", [s])
            if block_time is not None:
                return block_time
        except RuntimeError:
            pass
        s += step
    raise RuntimeError(f"Could not resolve a block time near slot {slot}")


def fetch_jto_market_chart(from_ts: int, to_ts: int) -> dict:
    url = f"https://api.coingecko.com/api/v3/coins/{COINGECKO_COIN_ID}/market_chart/range"
    resp = requests.get(
        url,
        params={"vs_currency": VS_CURRENCY, "from": from_ts, "to": to_ts},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def main() -> int:
    print("Fetching current Solana epoch info...")
    first_slot, last_slot = get_last_epoch_slot_range()
    print(f"Last completed epoch slot range: {first_slot} -> {last_slot}")

    start_ts = get_block_time_near(first_slot, search_forward=True)
    end_ts = get_block_time_near(last_slot, search_forward=False)
    print(f"Epoch time window: {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(start_ts))} UTC "
          f"-> {time.strftime('%Y-%m-%d %H:%M:%S', time.gmtime(end_ts))} UTC")

    print("Fetching JTO/USD market chart from CoinGecko...")
    chart = fetch_jto_market_chart(start_ts, end_ts)

    prices = chart.get("prices", [])
    volumes = dict(chart.get("total_volumes", []))
    market_caps = dict(chart.get("market_caps", []))

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["timestamp_ms", "datetime_utc", "price_usd", "volume_usd", "market_cap_usd"])
        for ts_ms, price in prices:
            writer.writerow([
                ts_ms,
                time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts_ms / 1000)),
                price,
                volumes.get(ts_ms, ""),
                market_caps.get(ts_ms, ""),
            ])

    print(f"Wrote {len(prices)} rows to {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
