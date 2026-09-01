# Option 2 vs CopyLab — Fresh Visual Re-Audit

Date: 2026-07-16
Status: **production-quality match; literal 100% pixel parity still has visible differences**

## Audit scope

This is a new comparison using screenshots captured during this audit, not the earlier parity report.

- Surface: CopyLab Stock Momentum dashboard
- Reference: Option 2 holographic market floor
- Desktop viewport: `1487 × 1058`
- Mobile capture request: `390 × 844`
- State: PAPER mode with current live operational and market data
- Local URL: `http://127.0.0.1:4310/`

## Current evidence

The reference, desktop/mobile captures, and comparison composites are local QA evidence intentionally excluded from the public repository. This report preserves the measured findings without publishing those images.

## Overall verdict

CopyLab now matches the reference's main composition, dark navy/cyan/lime palette, strategy-card hierarchy, metric strip, financial-chart layout, five candidate cards, learning/risk row, provider observatory, activity rail, and PAPER disclosure.

It is a strong functional reproduction, but the fresh combined screenshot does **not** support a claim of literal 100% visual identity. Four visible fidelity areas remain if exact screenshot parity is the target.

## Severity

- **P0:** broken or unsafe core experience
- **P1:** major structural mismatch
- **P2:** clearly visible fidelity difference
- **P3:** small polish difference
- **Expected:** difference required by live data, official branding, real policy, or responsive behavior

## Region-by-region comparison

| Step | Surface | Health | Fresh finding |
|---|---|---|---|
| 1 | Header and safety actions | Healthy | Brand, PAPER state, live indicator, clock, Pause, and Emergency Exit closely match. Current time naturally differs. |
| 2 | Strategy cards and podium | Needs one fidelity pass | Card count, order, selection, angle, and active hierarchy match. The CopyLab podium remains flatter and more horizontally banded than the reference's visibly solid, beveled metal platform. |
| 3 | Eight-cell metric strip | Healthy | Layout, symbols, color semantics, and PAPER-only lock match. Values differ because CopyLab is live. |
| 4 | Equity chart | Healthy with polish gap | Title, info symbol, range controls, legend, real axes, two traces, summary card, and perspective deck are present. CopyLab's grid, ticks, and floor are darker and finer than the more legible reference treatment. |
| 5 | Top candidates | Healthy | Five ranked cards, detailed real sparklines, scores, prices, changes, and tags match the intended structure. Candidate names and traces are expected live differences. |
| 6 | Learning arms and risk envelope | Healthy | Four learning arms, matching semantic symbols, progress bars, sizing, and five-part risk structure are present. Actual high-risk limits correctly differ from the concept. |
| 7 | Observatory topology | Needs one fidelity pass | Correct four-provider topology, official marks, cyan hub, dotted routes, green states, and event motion exist. The reference hub has stronger bloom and its packet routes feel more luminous and dimensional in the idle frame. |
| 8 | Observatory health and totals | Healthy | Two metric rows, status colors, progress bar, and compact cards match. Live provider health and quota values are expected differences. |
| 9 | Activity stream | Healthy with readability gap | Timeline, event-specific symbols, semantic colors, exact times, details, badges, and full-log control match. Supporting text and badge contrast are visibly smaller/lower than the reference. |
| 10 | Mobile extension | Healthy | Active strategy remains centered; metrics reflow to two columns; chart controls remain usable; no page-level overflow or console error was observed. No mobile Option 2 source exists for direct pixel comparison. |

## Symbol comparison

### Matched symbol language

- CopyLab pulse brand
- PAPER and live status dots
- Pause and emergency warning
- Strategy navigation arrows
- Market clock
- Scan rocket
- Candidate settings
- NAV wallet
- P&L chart
- Cash/deployed coins
- Drawdown shield
- PAPER shield lock
- Chart information
- Learning chart, candlestick, pullback, and histogram
- Observatory heartbeat, database, and gauge
- Activity safety, fill, signal, market, and learning symbols
- Footer warning

The interface uses one Tabler outline family. The symbols are consistent and no longer look like unrelated generic icons.

### Intentional brand difference

CopyLab uses the official Birdeye, Helius, Jupiter, and Alpaca marks. The Option 2 concept contains stylized/generated versions of some provider marks. Official marks should remain even when their exact pixels differ from the concept.

## Color comparison

### Passed

- Near-black blue page background
- Deep navy panels
- Cyan structure and selected-state borders
- Lime healthy/positive values
- Amber warning states
- Red rejection/emergency states
- Blue-gray supporting labels
- Green/cyan chart traces

### Remaining color/light differences

1. The reference podium has brighter silver-blue face highlights and clearer separation between its top deck, front face, and lower step.
2. The reference Local Index hub uses stronger cyan bloom.
3. CopyLab's smallest labels use darker blue-gray text and are harder to read at the comparison scale.
4. The CopyLab chart grid and lower deck are slightly too dark compared with the reference.

## Actionable differences

### P2-1 — Podium material and silhouette

The source reads as a solid three-tier metal platform. CopyLab still reads partly as a dark stage with several horizontal cyan/silver bands.

Recommended correction:

- Increase visible front-face height and midtone.
- Reduce the number and brightness of horizontal rim lines.
- Strengthen top-deck and front-face separation.
- Add a clearer lower centered step and restrained green status segment.
- Match the reference silhouette before retuning glow.

Primary owners:

- `scripts/render-market-floor-assets.py`
- `apps/web/public/assets/market-floor-platform.png`
- `apps/web/public/assets/market-floor-platform-loop.webp`
- `apps/web/src/styles.css`

### P2-2 — Observatory hub and route lighting

The topology structure matches, but the reference's central hub and packet routes have more depth and bloom.

Recommended correction:

- Increase static hub-edge bloom without turning the whole panel white.
- Make idle route dots slightly brighter near the hub.
- Ensure the small green packets are visible in more animation frames.
- Keep official provider logos and live-event triggering unchanged.

Primary owners:

- `apps/web/public/assets/observatory-topology.png`
- `apps/web/public/assets/observatory-topology-loop.webp`
- `apps/web/src/styles.css`

### P2-3 — Microcopy scale and contrast

Several secondary labels in candidates, metrics, provider cards, chart ticks, and activity details are smaller and dimmer than the reference.

Recommended correction:

- Increase the smallest desktop labels by approximately one visual step.
- Raise muted-text contrast while keeping it subordinate.
- Increase activity detail and badge legibility.
- Recheck truncation after changing type size.

Primary owner:

- `apps/web/src/styles.css`

### P2-4 — Chart grid/deck visibility

The chart hierarchy is correct, but the source has a brighter financial grid and more readable axis rhythm.

Recommended correction:

- Raise grid and tick contrast slightly.
- Brighten the front edge of the Blender chart deck.
- Keep real normalized-index values and real stored traces unchanged.

Primary owners:

- `apps/web/src/components/StockPaperPanel.tsx`
- `apps/web/public/assets/market-chart-platform.png`
- `apps/web/src/styles.css`

## Expected differences that should not be “fixed”

- Current NAV, P&L, drawdown, cash, and deployment
- Current market phase and eligibility
- Current candidate symbols, companies, scores, prices, and sparkline paths
- Current strategy and benchmark traces
- Current provider latency, status, quota pressure, and activity totals
- Actual high-risk PAPER policy values
- Official provider logos
- Exact clock times
- Responsive mobile behavior and accessibility additions

Replacing these with the reference's example values would make the dashboard less truthful.

## Accessibility observations

Confirmed from the fresh captures:

- Major controls have visible shapes and distinct states.
- Positive, warning, critical, and selected states use more than color alone.
- Mobile reflow is usable and does not show page-level horizontal overflow.

Risks visible in screenshots:

- Some microcopy and chart tick text may be difficult to read at normal desktop viewing distance.
- Several low-priority badges have low contrast against the dark activity panel.

Not proven by screenshots alone:

- Complete keyboard navigation
- Screen-reader reading order and labels
- Exact WCAG contrast ratios
- Zoom behavior above the captured viewport
- Reduced-motion behavior during every event animation

## Re-audit conclusion

- P0 findings: `0`
- P1 findings: `0`
- P2 visual-fidelity findings: `4`
- P3 findings: minor browser/raster-lighting differences only
- Functional structure: passed
- Live-data integrity: passed
- Responsive extension: passed
- Literal 100% screenshot parity: **not yet passed**

Final result: **conditional production pass; one more focused visual polish pass is required for a defensible 100% parity claim.**
