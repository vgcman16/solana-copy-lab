#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./disk-layout.sh
source "$SCRIPT_DIR/disk-layout.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

expect_rejection() {
  local expected="$1"
  shift
  local output
  if output="$(assert_distinct_rpc_filesystems "$@" 2>&1)"; then
    fail "accepted a same-device RPC storage layout: $*"
  fi
  [[ "$output" == *"$expected"* ]] ||
    fail "rejection did not identify the shared device: $output"
}

expect_rejection "ledger and accounts share filesystem device ID 2049" \
  2049 2049 2051
expect_rejection "ledger and snapshots share filesystem device ID 2049" \
  2049 2050 2049
expect_rejection "accounts and snapshots share filesystem device ID 2050" \
  2049 2050 2050
expect_rejection "empty filesystem device ID" \
  2049 "" 2051

assert_distinct_rpc_filesystems \
  2049 2050 2051 ||
  fail "rejected three distinct filesystem devices"

echo "PASS: RPC disk-layout validation rejects shared devices and accepts three distinct devices."
