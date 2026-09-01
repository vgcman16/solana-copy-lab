#!/usr/bin/env bash

# Shared, side-effect-free validation for the RPC storage layout. The caller
# supplies the filesystem device ID reported by `stat -c %d` for ledger,
# accounts, and snapshots so aliases and bind mounts cannot masquerade as
# separate filesystems. Supplying the IDs keeps this function independently
# testable without mounting real volumes.
assert_distinct_rpc_filesystems() {
  if (( $# != 3 )); then
    echo "RPC disk-layout validation requires ledger, accounts, and snapshot device IDs." >&2
    return 1
  fi

  local ledger_device="$1"
  local accounts_device="$2"
  local snapshot_device="$3"

  if [[ -z "$ledger_device" || -z "$accounts_device" || -z "$snapshot_device" ]]; then
    echo "RPC disk-layout validation received an empty filesystem device ID." >&2
    return 1
  fi

  if [[ "$ledger_device" == "$accounts_device" ]]; then
    echo "RPC storage isolation failed: ledger and accounts share filesystem device ID $ledger_device." >&2
    return 1
  fi
  if [[ "$ledger_device" == "$snapshot_device" ]]; then
    echo "RPC storage isolation failed: ledger and snapshots share filesystem device ID $ledger_device." >&2
    return 1
  fi
  if [[ "$accounts_device" == "$snapshot_device" ]]; then
    echo "RPC storage isolation failed: accounts and snapshots share filesystem device ID $accounts_device." >&2
    return 1
  fi
}
