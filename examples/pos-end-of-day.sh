#!/usr/bin/env bash
# End-of-day POS sync: push the day's sales in one idempotent call.
# Re-running this script for the same day is safe — the Idempotency-Key
# makes the server replay the original response instead of double-counting.
set -euo pipefail

BASE="${INVENTORY_URL:-http://localhost:4173}"
KEY="${INVENTORY_API_KEY:-}"
DAY="$(date +%F)"

curl -sS -X POST "$BASE/api/sales/bulk" \
  -H "Content-Type: application/json" \
  ${KEY:+-H "Authorization: Bearer $KEY"} \
  -H "Idempotency-Key: pos-sync-$DAY" \
  -d '{
    "sales": [
      {"sku": "COFFEE-HOT",   "qty": 214},
      {"sku": "ONIGIRI-TUNA", "qty": 167},
      {"sku": "WATER-500",    "qty": 88}
    ]
  }'
echo
