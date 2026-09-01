# Option 2 vs CopyLab — Full Visual and Functional Parity Audit

Status: **completed — passed**

Date: 2026-07-16

## Source and evidence

The Option 2 source image, before/after captures, and comparison composites are local QA evidence intentionally excluded from the public repository. This report preserves the findings without redistributing those images.

- Comparison viewport: `1487 × 1058`
- Comparison state: Stock Momentum selected, PAPER mode, live provider data, current production values
- Implementation URL: `http://127.0.0.1:4310/`

This report is intentionally stricter than the earlier visual specification and QA report. It compares the visible reference and implementation region by region, identifies every meaningful difference, distinguishes truthful live-data differences from design drift, and records the code or asset owner for each fix.

## Severity definitions

- **P0** — broken core experience, unsafe control, or inaccessible primary task
- **P1** — major structural or visual mismatch
- **P2** — clearly visible fidelity, hierarchy, interaction, or responsive mismatch
- **P3** — minor polish difference that does not change the intended experience
- **Expected** — a necessary difference because CopyLab shows truthful live data or preserves an existing required control

## Executive comparison

| Surface | Option 2 | CopyLab final | Classification | Resolution |
|---|---|---|---|---|
| Overall split | 68.5% primary / 31.5% observatory | Same proportion | Passed | Preserved |
| Header | Exact clock, Pause and Emergency aligned at right | Exact local clock; safety actions retain the reference rhythm | Passed | Menu removed from the safety-action layout flow |
| Strategy cards | Four cards on a visibly beveled metallic podium | Four live cards on a narrower, layered blue-steel podium | Passed | Blender material, lighting, bevels, rims, and animation retuned |
| Metric strip | One continuous eight-cell strip | Same structure and real values | Passed | Preserved |
| Chart header | Title + information icon, Today selector, 1D–All controls | Matching title hierarchy, icon, selector, and segmented ranges | Passed | Rebuilt to the reference hierarchy |
| Chart legend/axes | `Strategy Equity`, `SPY (Benchmark)`, multiple real time labels | Matching legend language with truthful real-value axes | Passed | Labels generated from visible series |
| Candidates | Five cards, title followed by `(Momentum Score)` | Five live cards with the same left-aligned heading group | Passed | Heading hierarchy corrected |
| Learning/risk | Four arms plus compact risk envelope | Same structure with truthful high-risk limits | Passed | Preserved real policy values |
| Observatory topology | Bright cyan hub, official logos, visible green packets | Bright cyan hub, official logos, and event-driven packets | Passed | Static and motion layers rebalanced |
| Observatory metrics | Two compact metric rows | Same hierarchy with live operational values | Passed | Preserved truthful values |
| Activity stream | Exact event times, short human titles, supporting detail, badges | Exact times, concise semantic titles, original supporting detail, badges | Passed | Human-readable display layer added |
| Footer/disclosure | PAPER warning visible at first-screen bottom | Research disclosure visible at first-screen bottom | Passed | Preserved truthful wording |
| Mobile | Not explicitly shown in source | Responsive implementation at 390 × 844 | Passed extension | No page overflow; touch and focus states verified |

## Detailed region audit

### 1. Header

Reference measurements:

- Height: approximately `63 px`
- Brand starts near `x 20`
- PAPER pill begins near `x 208`
- Live status begins near `x 299`
- Exact time follows a thin divider
- Pause is approximately `116 px` wide
- Emergency Exit is approximately `176 px` wide
- Both actions align to the far-right edge

CopyLab before this pass:

- Header height, brand, PAPER badge, palette, and typography are close.
- `Updated 1 second ago` creates a different rhythm from the reference clock.
- The command-workspace menu participates in the flex row and pushes Pause/Emergency rightward.
- Pause and Emergency are slightly narrower than the reference.

Owner:

- `apps/web/src/components/HolographicMarketFloor.tsx`
- `apps/web/src/styles.css`

Fix:

- Display the current snapshot as a clock with local zone abbreviation.
- Absolutely position the compact command drawer so it remains reachable without shifting primary safety actions.
- Match the action widths more closely.

### 2. Strategy switcher

Reference:

- Centered label and fine cyan divider lines.
- Side cards angle toward a wide active card.
- Active card has cyan border, lime ACTIVE badge, live trace, and three primary metrics.
- Four cards sit on a broad layered metal platform with a visible top deck, bevel, recessed tier, two restrained light edges, and a central green status indicator.

CopyLab before this pass:

- Card count, ordering, selection behavior, width hierarchy, cyan selection, and live values match.
- The rendered platform exists but its top surface is too dark.
- Multiple bright horizontal cyan/green bands dominate the scene, making it read like a striped background rather than a physical platform.
- The animation layer is too visible when idle.

Owner:

- `scripts/render-market-floor-assets.py`
- `apps/web/public/assets/market-floor-platform.png`
- `apps/web/public/assets/market-floor-platform-loop.webp`
- `apps/web/src/styles.css`

Fix:

- Re-render a brighter blue-steel upper deck with clearer bevel/specular separation.
- Reduce cyan emission and animation overlay intensity.
- Keep the current live selection trace and truthful strategy metrics.

### 3. Stock metric strip

Reference and CopyLab both provide:

1. Market phase
2. Symbols scanned
3. Candidates ranked
4. Normalized NAV
5. Total P&L
6. Cash/deployed
7. Drawdown
8. PAPER-only lock

Expected live-data differences:

- Reference shows PREMARKET and zero deployed; CopyLab currently shows the actual session, NAV, P&L, cash, deployed balance, and drawdown.
- These values must not be changed to match a concept screenshot.

Result: passed.

### 4. Performance chart

Reference:

- `EQUITY VS SPY` with an information icon.
- `Today` behaves visually like the primary range selector.
- 1D, 5D, 1M, YTD, and All are compact segmented controls.
- Legend uses `Strategy Equity` and `SPY (Benchmark)`.
- Multiple y/time labels create a financial-chart rhythm.

CopyLab before this pass:

- The real strategy and SPY lines, grid, fill, range behavior, outperformance, and correlation are present.
- A `PRIMARY PERFORMANCE` eyebrow replaces the reference information icon.
- `Today` is visually indistinguishable from the other tiny buttons.
- Legend and time labels are simplified.

Owner:

- `apps/web/src/components/HolographicMarketFloor.tsx`
- `apps/web/src/components/StockPaperPanel.tsx`
- `apps/web/src/components/Icon.tsx`
- `apps/web/src/styles.css`

Fix:

- Add a library-provided information-circle icon.
- Render Today as the wider selector with a caret.
- Rename the legend without changing data.
- Generate y-axis and time labels from the visible real series.

### 5. Top candidates

Reference:

- Title and `(Momentum Score)` read as one left-aligned heading group.
- Five ranked cards with symbol, company, score, sparkline, price, change, and tags.

CopyLab before this pass:

- Five real IEX candidates and all essential card content are present.
- The explanatory label is aligned to the far right and uses different copy.
- Sparkline direction and values differ because they are live; this is expected.

Owner:

- `apps/web/src/components/HolographicMarketFloor.tsx`
- `apps/web/src/styles.css`

Fix:

- Use the reference heading grouping and `(Momentum Score)` label.

### 6. Learning arms and risk envelope

Reference:

- Four learning arms with icon/avatar, P&L, evidence bar, and next size.
- Compact risk limits.

CopyLab:

- Four real learning arms with consistent Tabler icons.
- P&L, win rate, bounded size multiplier, high-risk budget, drawdown lock, maximum position, capacity, deployment ceiling, and liquidity buffer are present.
- CopyLab shows the actual high-risk policy rather than the safer illustrative reference values.

Result: passed; preserve actual policy.

### 7. Live Data Observatory topology

Reference:

- Official provider marks.
- Bright central cyan hex with a green status light.
- Dotted cyan routes and small green packets.
- Provider cards remain visible but secondary to the Local Index.

CopyLab before this pass:

- Official Birdeye, Helius, Jupiter, and Alpaca assets are used.
- Source-specific one-shot animation is driven by sanitized live events.
- Static hub is less luminous than the reference.
- Some event frames make a large white/cyan hub edge more prominent than the green packet.

Owner:

- `apps/web/src/components/HolographicMarketFloor.tsx`
- `apps/web/src/styles.css`
- `apps/web/public/assets/observatory-topology.png`
- `apps/web/public/assets/observatory-topology-loop.webp`

Fix:

- Increase static cyan hub presence.
- Reduce motion-layer opacity so packets remain the focus.
- Preserve source-specific clipping and real-event triggering.

### 8. Observatory health and totals

Expected differences:

- The reference displays illustrative healthy usage and signal totals.
- CopyLab displays live provider status, actual quota pressure, accepted/rejected signal evidence, and simulated action totals.
- A degraded Local Index or high rate pressure must remain visible rather than being cosmetically changed to green.

Result: passed.

### 9. Activity stream

Reference:

- Exact clock time in the left column.
- Short human title such as `Signal accepted`.
- Supporting line such as symbol, strategy, and interval.
- Semantic badge at right.

CopyLab before this pass:

- Timeline, source icons, semantic colors, badges, and full-log control are present.
- Relative times (`1 second ago`) do not match the instrument-panel style.
- Raw audit summaries can be long and truncate before the meaning is clear.
- Learning entries repeat machine-oriented wording.

Owner:

- `apps/web/src/components/HolographicMarketFloor.tsx`
- `apps/web/src/styles.css`

Fix:

- Show exact local clock times.
- Derive concise, truthful display titles from event kind and tone.
- Preserve the original summary/detail as the supporting line.

### 10. Responsive behavior and accessibility

CopyLab adds behavior not shown in the desktop-only source:

- Horizontal strategy/candidate rails
- Two-column metrics
- Stacked chart summary
- Observatory below primary content
- 38 px range-control touch targets
- `aria-pressed`, semantic labels, focus-visible rings, and reduced motion

Required verification after fixes:

- Strict desktop capture at `1487 × 1058`
- Strict mobile capture at `390 × 844`
- No console errors
- No horizontal overflow
- Strategy, range, command drawer, workspace, and activity-log controls exercised

## Fix implementation record

| Initial P2 finding | Implemented correction | Verification result |
|---|---|---|
| Podium material and animation did not read as the same dimensional market floor | Re-rendered the Blender platform with brighter blue-steel surfaces, clearer upper/front bevels, thinner cyan rims, reduced emission, restrained green fill, and a quieter motion overlay | Passed in the focused and full-page comparisons; the remaining lighting difference is P3 polish |
| Header clock and action alignment visibly differed | Replaced relative update copy with the exact local clock, matched safety-action widths, and absolutely positioned the compact workspace menu outside the action flow | Passed; Pause and Emergency remain aligned and reachable |
| Chart title, Today control, legend, and axes were simplified | Added the information-circle icon, widened Today into a selector with a caret, renamed the legend, and generated real y/time tick labels from the visible data | Passed; no illustrative values were fabricated |
| Candidate heading hierarchy differed | Grouped `TOP CANDIDATES` and `(Momentum Score)` on the left while preserving the five live ranked cards | Passed |
| Static topology glow and motion emphasis differed | Increased the static cyan hub presence and reduced the motion-layer opacity so live provider packets—not a white flash—carry the event emphasis | Passed |
| Activity time and content hierarchy differed | Added exact local clock times, semantic human titles, original supporting detail, and retained source/tone badges | Passed |

## Final difference classification

No actionable P0, P1, or P2 mismatch remains.

- **Expected:** NAV, profit, drawdown, provider latency, quota pressure, candidates, chart traces, learning evidence, and activity entries differ because CopyLab displays current production PAPER data.
- **Expected:** The active risk envelope reflects the actual high-risk policy rather than the safer illustrative values in the concept.
- **P3:** The production podium is slightly flatter and less cinematic than the baked concept lighting, but its layered physical geometry, metal deck, cyan edge light, green status accent, and animation are present.
- **P3:** The compact workspace menu is an additional control retained so existing CopyLab workspaces remain reachable.
- **Product extension:** Mobile behavior, focus-visible treatment, reduced-motion support, semantic labels, and touch sizing are production additions not depicted in the desktop concept.

## Verified implementation owners

- `apps/web/src/components/HolographicMarketFloor.tsx`
  - Exact clocks, semantic activity titles, chart heading, candidate hierarchy, observatory presentation
- `apps/web/src/components/StockPaperPanel.tsx`
  - Real chart tick generation, time-axis labels, and reference legend language
- `apps/web/src/components/Icon.tsx`
  - Tabler information-circle icon
- `apps/web/src/styles.css`
  - Header flow, podium layering, chart controls/axes, candidate alignment, topology brightness, activity spacing, mobile behavior
- `scripts/render-market-floor-assets.py`
  - Blender platform materials, geometry, lighting, static render, and animated render
- `apps/web/public/assets/market-floor-platform.png`
- `apps/web/public/assets/market-floor-platform-loop.webp`

## Completion gate

- [x] Implement every P2 fix above.
- [x] Capture revised desktop and mobile states.
- [x] Build a new same-viewport side-by-side comparison.
- [x] Recheck typography, spacing, colors, assets, icons, content, interactions, responsiveness, and accessibility.
- [x] Run typecheck, build, and automated tests.
- [x] Verify local and Tailscale URLs.
- [x] End this document with `Final result: passed`.

Final result: passed
