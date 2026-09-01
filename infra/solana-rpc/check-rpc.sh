#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./disk-layout.sh
source "$SCRIPT_DIR/disk-layout.sh"

: "${SOLANA_HTTP_URL:=http://127.0.0.1:8899}"
: "${LEDGER_DIR:=/mnt/ledger}"
: "${ACCOUNTS_DIR:=/mnt/accounts}"
: "${SNAPSHOT_DIR:=/mnt/snapshots}"
: "${MINIMUM_ARCHIVE_DAYS:=90}"
: "${MINIMUM_FREE_GIB:=100}"
: "${MINIMUM_FREE_PERCENT:=10}"
: "${MAXIMUM_REFERENCE_SLOT_LAG:=256}"
: "${ARCHIVE_PROBE_ADDRESS:?Set ARCHIVE_PROBE_ADDRESS to a low-activity address with a known 90-day transaction}"
: "${ARCHIVE_PROBE_SIGNATURE:?Set ARCHIVE_PROBE_SIGNATURE to that successful 90-day transaction signature}"
JUPITER_V6_PROGRAM="JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"

rpc_at() {
  local endpoint="$1"
  local method="$2"
  local params="$3"
  curl --fail --silent --show-error \
    -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"${method}\",\"params\":${params}}" \
    "$endpoint"
}

rpc() {
  rpc_at "$SOLANA_HTTP_URL" "$1" "$2"
}

disk_json() {
  local label="$1"
  local path="$2"
  [[ -d "$path" ]]
  local row
  row="$(df -Pk "$path" | awk 'NR==2 { print $1 " " $2 " " $4 " " $5 }')"
  local device total_kib available_kib used_percent
  read -r device total_kib available_kib used_percent <<<"$row"
  local filesystem_device_id
  filesystem_device_id="$(stat -Lc '%d' -- "$path")"
  local available_gib=$((available_kib / 1024 / 1024))
  local free_percent=$((100 - ${used_percent%%%}))
  if (( available_gib < MINIMUM_FREE_GIB || free_percent < MINIMUM_FREE_PERCENT )); then
    echo "$label disk reserve is unsafe: ${available_gib} GiB / ${free_percent}% free" >&2
    return 1
  fi
  jq -n \
    --arg label "$label" \
    --arg path "$path" \
    --arg device "$device" \
    --arg filesystemDeviceId "$filesystem_device_id" \
    --argjson totalBytes "$((total_kib * 1024))" \
    --argjson availableBytes "$((available_kib * 1024))" \
    --argjson freePercent "$free_percent" \
    '{label:$label,path:$path,device:$device,filesystemDeviceId:$filesystemDeviceId,totalBytes:$totalBytes,availableBytes:$availableBytes,freePercent:$freePercent}'
}

command -v curl >/dev/null
command -v jq >/dev/null
command -v df >/dev/null
command -v stat >/dev/null

health="$(rpc getHealth '[]')"
[[ "$(jq -r '.result // empty' <<<"$health")" == "ok" ]]

version="$(rpc getVersion '[]')"
slot_response="$(rpc getSlot '[{"commitment":"confirmed"}]')"
slot="$(jq -r '.result' <<<"$slot_response")"
[[ "$slot" =~ ^[0-9]+$ ]]
first_response="$(rpc getFirstAvailableBlock '[]')"
first="$(jq -r '.result' <<<"$first_response")"
[[ "$first" =~ ^[0-9]+$ ]]
signatures="$(rpc getSignaturesForAddress "[\"$JUPITER_V6_PROGRAM\",{\"commitment\":\"confirmed\",\"limit\":1}]")"
if [[ "$(jq '.result | length' <<<"$signatures")" -lt 1 ]]; then
  echo "RPC is healthy but did not return a Jupiter program signature." >&2
  exit 1
fi

# First-available slots can be skipped. Scan a small bounded range and require
# a real timestamp so a nominal ledger boundary cannot masquerade as history.
archive_start_time=""
archive_start_slot=""
for offset in $(seq 0 63); do
  candidate=$((first + offset))
  candidate_response="$(rpc getBlockTime "[$candidate]")"
  candidate_time="$(jq -r '.result // empty' <<<"$candidate_response")"
  if [[ "$candidate_time" =~ ^[0-9]+$ ]]; then
    archive_start_slot="$candidate"
    archive_start_time="$candidate_time"
    break
  fi
done
if [[ -z "$archive_start_time" ]]; then
  echo "RPC could not prove its archive boundary within 64 slots." >&2
  exit 1
fi

head_time_response="$(rpc getBlockTime "[$slot]")"
head_time="$(jq -r '.result // empty' <<<"$head_time_response")"
if [[ ! "$head_time" =~ ^[0-9]+$ ]]; then
  echo "RPC confirmed head has no block time." >&2
  exit 1
fi
archive_days=$(( (head_time - archive_start_time) / 86400 ))
if (( archive_days < MINIMUM_ARCHIVE_DAYS )); then
  echo "RPC archive is only ${archive_days} days; ${MINIMUM_ARCHIVE_DAYS} are required." >&2
  exit 1
fi

# A boundary block alone does not prove address-history indexing or full
# transaction retrieval at the qualification cutoff. Require an operator-owned
# low-activity probe whose known signature fits in one bounded address page.
archive_probe_signatures="$(rpc getSignaturesForAddress "[\"$ARCHIVE_PROBE_ADDRESS\",{\"commitment\":\"confirmed\",\"limit\":1000}]")"
if ! jq -e --arg signature "$ARCHIVE_PROBE_SIGNATURE" '.result[] | select(.signature == $signature)' \
  <<<"$archive_probe_signatures" >/dev/null; then
  echo "The configured archive signature was not returned for its probe address." >&2
  exit 1
fi
archive_probe_transaction="$(rpc getTransaction "[\"$ARCHIVE_PROBE_SIGNATURE\",{\"encoding\":\"jsonParsed\",\"commitment\":\"confirmed\",\"maxSupportedTransactionVersion\":0}]")"
archive_probe_time="$(jq -r '.result.blockTime // empty' <<<"$archive_probe_transaction")"
archive_probe_error="$(jq -c '.result.meta.err' <<<"$archive_probe_transaction")"
if [[ ! "$archive_probe_time" =~ ^[0-9]+$ ]] || [[ "$archive_probe_error" != "null" ]]; then
  echo "The configured archive transaction is unavailable, malformed, or failed." >&2
  exit 1
fi
archive_probe_age_days=$(( (head_time - archive_probe_time) / 86400 ))
if (( archive_probe_age_days < MINIMUM_ARCHIVE_DAYS )); then
  echo "The configured archive transaction is only ${archive_probe_age_days} days old." >&2
  exit 1
fi

ledger_disk="$(disk_json ledger "$LEDGER_DIR")"
accounts_disk="$(disk_json accounts "$ACCOUNTS_DIR")"
snapshot_disk="$(disk_json snapshots "$SNAPSHOT_DIR")"
assert_distinct_rpc_filesystems \
  "$(jq -r '.filesystemDeviceId' <<<"$ledger_disk")" \
  "$(jq -r '.filesystemDeviceId' <<<"$accounts_disk")" \
  "$(jq -r '.filesystemDeviceId' <<<"$snapshot_disk")"

slot_lag_json="null"
if [[ -n "${SOLANA_REFERENCE_HTTP_URL:-}" ]]; then
  reference_response="$(rpc_at "$SOLANA_REFERENCE_HTTP_URL" getSlot '[{"commitment":"confirmed"}]')"
  reference_slot="$(jq -r '.result' <<<"$reference_response")"
  [[ "$reference_slot" =~ ^[0-9]+$ ]]
  slot_lag=$((reference_slot > slot ? reference_slot - slot : 0))
  if (( slot_lag > MAXIMUM_REFERENCE_SLOT_LAG )); then
    echo "RPC is ${slot_lag} slots behind the configured reference; maximum is ${MAXIMUM_REFERENCE_SLOT_LAG}." >&2
    exit 1
  fi
  slot_lag_json="$slot_lag"
fi

service_active="unknown"
if command -v systemctl >/dev/null && systemctl list-unit-files copylab-rpc.service >/dev/null 2>&1; then
  service_active="$(systemctl is-active copylab-rpc.service || true)"
  [[ "$service_active" == "active" ]]
fi

jq -n \
  --arg checkedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg health "$(jq -r '.result' <<<"$health")" \
  --arg version "$(jq -r '.result["solana-core"] // "unknown"' <<<"$version")" \
  --arg service "$service_active" \
  --arg newestJupiterSignature "$(jq -r '.result[0].signature' <<<"$signatures")" \
  --arg archiveProbeAddress "$ARCHIVE_PROBE_ADDRESS" \
  --arg archiveProbeSignature "$ARCHIVE_PROBE_SIGNATURE" \
  --argjson slot "$slot" \
  --argjson slotLag "$slot_lag_json" \
  --argjson firstAvailableBlock "$first" \
  --argjson archiveStartSlot "$archive_start_slot" \
  --argjson archiveDays "$archive_days" \
  --argjson archiveProbeAgeDays "$archive_probe_age_days" \
  --argjson ledger "$ledger_disk" \
  --argjson accounts "$accounts_disk" \
  --argjson snapshots "$snapshot_disk" \
  '{checkedAt:$checkedAt,health:$health,version:$version,service:$service,slot:$slot,slotLag:$slotLag,firstAvailableBlock:$firstAvailableBlock,archiveStartSlot:$archiveStartSlot,archiveDays:$archiveDays,archiveProbeAddress:$archiveProbeAddress,archiveProbeSignature:$archiveProbeSignature,archiveProbeAgeDays:$archiveProbeAgeDays,newestJupiterSignature:$newestJupiterSignature,disks:[$ledger,$accounts,$snapshots]}'
