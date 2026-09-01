# Security policy

## Supported version

Security fixes are applied to the current `main` branch. This project is a local
PAPER-first research system; public CI contains no production credentials or
runtime data.

## Reporting a vulnerability

Please use the repository's private GitHub security-advisory reporting flow.
Do not post API keys, wallet material, database contents, local paths, or an
exploitable security report in a public issue.

## Credential response

If a credential is ever exposed, revoke it with the provider immediately,
replace it in CopyLab through the local setup screen, and inspect the local audit
ledger. Removing a credential from a later commit does not remove it from Git
history.
