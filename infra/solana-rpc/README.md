# CopyLab self-hosted Solana RPC node

This directory is the operator handoff for the standard Solana HTTP/WebSocket
endpoint consumed by CopyLab. It is intentionally a native Ubuntu deployment,
not Docker. Anza does not recommend Docker for live-cluster validators/RPC
nodes.

## What CopyLab requires

- Mainnet-beta Agave RPC node, non-voting and private.
- HTTP JSON-RPC and WebSocket PubSub reachable only over loopback or a private
  management network/VPN.
- `getHealth`, `getSlot`, `getBlockTime`, `getFirstAvailableBlock`,
  `getSignaturesForAddress`, `getTransaction`, `getBlock`, `getBalance`, and
  `getTokenAccountsByOwner` enabled.
- `logsSubscribe` with `confirmed` commitment.
- Transaction-history storage enabled with a genuinely proven 90-day local
  ledger (or a separately engineered archive backend). The supplied launch
  template deliberately does **not** set `--limit-ledger-size`; an arbitrary
  shred cap is incompatible with CopyLab's 90-day promotion contract.
- The SPL token-owner account index, which supports bot-wallet balance
  reconciliation.

CopyLab does not place the trading signer, recovery phrase, or bot wallet key on
this host. The RPC identity is a separate operational key.

## Hardware gate

Do not run mainnet production on the current CopyLab Windows PC. Anza's current
RPC guidance calls for at least 16 cores / 32 threads, 512 GB RAM when all
account indexes are used, separate high-write NVMe storage (at least 1 TB each
for accounts and ledger, plus 500 GB for snapshots), Ubuntu 24.04, and a stable
public IPv4 connection with at least 1 Gbit/s symmetric bandwidth for an
unstaked node. CopyLab uses only the `spl-token-owner` index, but 16 GB RAM is
still not a credible production configuration.

Use a dedicated bare-metal Ubuntu host. Keep the RPC ports off the public
Internet. If CopyLab remains on Windows, connect through a private WireGuard or
Tailscale address and restrict the node firewall to that one client.

## Installation sequence

1. Follow Anza's validator prerequisites, disk layout, system tuning, and Agave
   build/install instructions on Ubuntu 24.04.
2. Create a non-root `sol` service user and a dedicated RPC identity keypair.
   Never reuse the CopyLab bot wallet.
3. Mount accounts, ledger, and snapshots on three separate filesystem devices,
   backed by separate NVMe volumes. A second directory, bind mount, or symlink
   on the same filesystem does not satisfy this gate. Separate partitions on
   one physical drive can have different filesystem IDs, so also capture
   `lsblk -o NAME,PKNAME,SERIAL,MODEL,MOUNTPOINTS` as proof that the three mounts
   use separate NVMe hardware. Size the ledger from measured mainnet growth
   plus safety reserve; Anza's generic minimum is not a promise that 1 TB
   retains 90 days.
4. Copy `agave-rpc-mainnet.sh.example` to `/home/sol/bin/agave-rpc-mainnet.sh`,
   review every path/flag against `agave-validator --help` for the installed
   release, and make it executable.
5. Copy `copylab-rpc.service.example` to
   `/etc/systemd/system/copylab-rpc.service`, then run `systemctl daemon-reload`
   and `systemctl enable --now copylab-rpc`.
6. Choose a low-activity mainnet address with a known successful transaction at
   least 90 days old and export its address/signature as
   `ARCHIVE_PROBE_ADDRESS` / `ARCHIVE_PROBE_SIGNATURE`. Run `check-rpc.sh`
   locally on the node. It fails closed on less than 90
   days of proven archive depth, low ledger/accounts/snapshot disk reserves,
   ledger/accounts/snapshot paths that resolve to anything other than three
   distinct filesystem devices, an unavailable full historical probe
   transaction, missing Jupiter history, inactive service state, and (when
   `SOLANA_REFERENCE_HTTP_URL` is configured) excessive head-slot lag. Capture
   its JSON output as rollout evidence. Do not put a credential-bearing URL
   in a shell history; use a private, credential-free node URL or an environment
   variable.
7. Enter the private HTTP and WebSocket endpoints in CopyLab and select
   `SHADOW`. `SELF_HOSTED` remains unavailable until endpoint health, historical
   pricing, and seven continuous days of parity evidence pass.

## History and archive boundary

Anza explicitly notes that a normal RPC node cannot practically store the
entire Solana chain. Old history requires either sufficiently large local
ledger retention or an archive/Bigtable-compatible backend. CopyLab's launch
template chooses measured local retention for the required 90-day horizon; it
does not claim full-chain archival. CopyLab therefore uses two layers:

1. Agave supplies the live head, reconnect reads, and the proven 90-day
   qualification horizon.
2. CopyLab's crash-safe SQLite index retains every normalized signature,
   transaction, swap, checkpoint, and price snapshot it has ingested.

The first 90-day local cohort may be cross-checked during `SHADOW`, but managed
providers are not allowed to fill holes in the self-hosted corpus. Promotion
never assumes that a pruned node can answer data it has not retained;
incomplete history fails closed. New wallets cannot qualify until their full
90-day evidence exists locally.

## Upgrade and recovery drills

### Corruption is a rebuild event

The launch template intentionally does not use
`--wal-recovery-mode skip_any_corrupted_record`. Silently skipping a corrupted
accounts record can produce a node that looks available while serving
incomplete state, which cannot authorize CopyLab readiness. If Agave reports
ledger, accounts, snapshot, or WAL corruption:

1. Keep CopyLab out of `SELF_HOSTED` and stop `copylab-rpc.service`; preserve
   the Agave logs and the failed `check-rpc.sh` output for the incident record.
2. Do not add a permissive WAL-recovery flag. Unmount and inspect the affected
   device, replace failed hardware when indicated, and rebuild the RPC data
   from a trusted mainnet snapshot/genesis path using the installed Agave
   release's documented process. Treat the rebuilt corpus as new evidence.
3. Confirm with `stat -Lc %d`, `findmnt -T`, and `df -P` that ledger, accounts,
   and snapshots again resolve to three distinct filesystem devices; capture
   `lsblk` evidence that they remain on separate physical NVMe hardware. Run
   filesystem and NVMe health checks before restarting Agave.
4. After catch-up, rerun `check-rpc.sh` with the known 90-day archive probe and
   reference endpoint configured. Preserve its successful JSON output. Do not
   reselect `SHADOW` until archive depth, historical transaction retrieval,
   disk isolation/reserves, service health, and slot-lag checks all pass.
5. Restart the parity evidence window from zero. Prior soak evidence does not
   prove the rebuilt node's corpus and must not be reused for promotion.

This is deliberately fail closed: an automatic systemd restart loop is not a
readiness proof, and a node recovered by discarding corrupted records remains
ineligible even if `getHealth` later returns `ok`.

Before production promotion, record successful evidence for each drill:

- restart Agave and verify `logsSubscribe` reconnect plus gap repair;
- stop HTTP while WSS remains reachable, then the reverse;
- force a stale/unhealthy node and verify CopyLab pauses new entries;
- restore CopyLab from a copied SQLite database and reconcile all checkpoints;
- approach the configured ledger/disk threshold and verify alerting before
  pruning;
- upgrade Agave on a staging/testnet node before the mainnet host;
- rotate the RPC identity independently of the trading wallet;
- prove the RPC ports are unreachable from the public Internet.

Official references:

- https://docs.anza.xyz/operations/requirements
- https://docs.anza.xyz/operations/setup-an-rpc-node
- https://docs.anza.xyz/clusters/available
