# Upstream lockstep lift plan

Branch: `lockstep/29-08-vcc-om`

This is a manual adaptation plan for the heavily diverged pi-blackhole fork.
The upstream commits are evidence and change references, not literal
cherry-pick targets.

## Candidate decisions

| Candidate | Decision | Caveat / adaptation |
| --- | --- | --- |
| [OM 77d3cc1](https://github.com/elpapi42/pi-observational-memory/commit/77d3cc12b169770cb3224a1e33a4e2069850dc2c) | Superseded | Its env/baseUrl forwarding is included by `5d6afe0`, then `ce9fc98`. |
| [OM PR #39](https://github.com/elpapi42/pi-observational-memory/pull/39) | Selective lift | Port empty-projection fallback only. Preserve Blackhole's `agent_end`, `turn_end`, inline-resume, append-mode, and own-cut behavior. |
| [OM 699ccc7](https://github.com/elpapi42/pi-observational-memory/commit/699ccc7dd5536814f5476542dae93acbb5237b01) | Adapted | Add bounded, rate-limited stale availability refresh for request-time-signed providers. |
| [OM 5d6afe0](https://github.com/elpapi42/pi-observational-memory/commit/5d6afe017cc4d7aca517210fc03168a34cb1392b) | Superseded | Merge containing `77d3cc1`; do not apply independently. |
| [OM ce9fc98](https://github.com/elpapi42/pi-observational-memory/commit/ce9fc982b3a219a7839f07c9f4a3e054e81a2b21) | Umbrella reference | Manually adapted env forwarding and stale-auth behavior. Blackhole already has a custom base-URL resolver; retain it. |
| [OM e6c0fd9](https://github.com/elpapi42/pi-observational-memory/commit/e6c0fd9d8e43ffb5d3c1a271bf1ec4a4640bde02) | Adapted | Accept `max` in unified config validation and OM allowed values. Worker mapping already forwards levels directly as provider reasoning. |
| [VCC f7b80bb](https://github.com/sting8k/pi-vcc/commit/f7b80bbbe22315acf9f7925c0c3be2d4ae9feee5) | Adapted | Add generic bounded tool-argument indexing and self-search protection. Use unified tool name `recall`, not upstream `vcc_recall`. |
| [VCC f749afe](https://github.com/sting8k/pi-vcc/commit/f749afe9773d4794a4dfb03f8bd4a35079e1a8c9) | Overlapping | Generic argument extraction is included/overlapped by the later recall-quality merge; do not lift separately. |
| [VCC 4bb7115](https://github.com/sting8k/pi-vcc/commit/4bb7115ca1a2ce73e61c6bf672a16335fc1f6520) | Adapted | Add detailed result metadata, multi-term BM25 relative floor, 50-result cap, and honest pagination errors. |
| [VCC fb8e58d](https://github.com/sting8k/pi-vcc/commit/fb8e58dca322f89d68bdc2b857386b3c8cd81a76) | Deferred | It replaces an older automatic hidden continuation message. Blackhole's explicit `/blackhole continue working` already sends a real persisted user message after `onComplete`; only revisit this if that automatic path returns. |

## Implementation sequence

1. Thinking-level compatibility (`max`).
2. OM provider auth: env propagation and stale availability recovery.
3. Recall indexing, result filtering/capping, and pagination reporting.
4. Empty Blackhole compaction summaries delegate to Pi's native compactor.
5. Verify against the normal CI gates and Pi 0.81.1 compatibility.

## Implemented on this branch

- Added `max` to config parsing and documentation.
- Forwarded auth environment variables through OM resolution and all three
  worker agents.
- Added a 5-second, per-provider 60-second availability re-check for stale
  ambient/request-time credentials; failures retain the existing skip path.
- Added generic, aggregate-bounded tool-call argument search while excluding
  the unified `recall` tool's own invocation/result.
- Added a 20% relative BM25 floor for distinct multi-term queries and a hard
  50-result cap for BM25 and regex searches.
- Updated recall pagination to report truncation and reject unreachable pages
  explicitly.
- Added the empty replacement-summary fallback to Pi native compaction.
- Confirmed `/blackhole <text>` follow-ups are intentionally real user turns;
  `/blackhole configure` and other recognized subcommands are intercepted
  before follow-up extraction and do not consume transcript tokens.

## Verification requirements

- `pnpm build`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm format:check`
- Pi 0.81.1 compatibility typecheck/test, especially auth refresh and event
  lifecycle behavior.

The unrelated pre-existing work-tree note, if present, must remain untouched.
