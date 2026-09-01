# CopyLab Option 2 Design QA

Date: 2026-07-16

## Comparison target

- Source visual truth: `artifacts/option-2-redesign/option-2-holographic-market-floor.png`
- Implementation URL: `http://127.0.0.1:4310/`
- Final desktop implementation: `artifacts/option-2-observatory-desktop-final.png`
- Final mobile implementation: `artifacts/option-2-observatory-mobile-full-final.png`
- Full-view side-by-side evidence: `artifacts/option-2-observatory-side-by-side-final.png`
- Focused observatory evidence: `artifacts/option-2-observatory-focused-final.png`
- Focused strategy-stage evidence: `artifacts/option-2-parity-2026-07-16-stage-focused-final-v4.png`
- Focused observatory evidence: `artifacts/option-2-parity-2026-07-16-observatory-focused-final-v4.png`
- Settled 5D interaction evidence: `artifacts/option-2-parity-2026-07-16-interaction-5d-settled-final-v4.png`
- Desktop viewport: `1487 × 1058`, Stock Momentum selected, dark PAPER state, live provider data
- Mobile viewport: `390 × 844`, Stock Momentum selected, dark PAPER state, live provider data

## Findings

No actionable P0, P1, or P2 findings remain.

### Required fidelity surfaces

- Fonts and typography: passed. Rajdhani supplies the condensed command-center hierarchy and Space Grotesk supplies the CopyLab wordmark. The final comparison preserves the reference's uppercase labels, compact numeric hierarchy, weights, wrapping, and muted supporting text without clipped desktop copy.
- Spacing and layout rhythm: passed. The 68.5/31.5 desktop split, 63 px top bar, strategy stage, eight-part metric bar, chart deck, five candidate cards, learning/risk row, disclosure, provider topology, metric blocks, and activity rail all occupy the intended first-screen hierarchy. Desktop and mobile have no page-level horizontal overflow.
- Colors and visual tokens: passed. The implementation uses the reference's black-blue background, deep navy surfaces, cyan structure/data-flow light, lime healthy/positive state, amber caution, red rejection/emergency state, muted blue-gray borders, and restrained glow.
- Image quality and asset fidelity: passed. The podium and topology are rendered raster assets rather than CSS drawings. The final podium has a raised blue-steel deck, restrained cyan rims, a dark dimensional front face, a centered active-card plinth, a lower status step, and a perspective floor grid matching the reference. The desktop topology uses the supplied Option 2 source layer for its exact curved paths and cyan hex while opaque live provider cards and live Local Index values remain functional above it. Birdeye, Helius, Jupiter, and Alpaca use real provider marks. Standard UI icons use the Tabler icon library instead of handcrafted inline icon SVGs. The animated assets remain sharp at production size.
- Copy and content: passed. Static labels match the reference's command-center language while dynamic values remain truthful to CopyLab's current PAPER ledger, provider health, candidates, learning, and risk policy. Concept-only example values were not fabricated.
- Icons: passed. Header, metrics, controls, learning arms, risk, activity, and safety actions use one consistent outline family with aligned stroke weight and semantic color.
- States and interactions: passed. Strategy cards, previous/next arrows, Today/1D/5D/1M/YTD/All ranges, command drawer, Wallet Lab, Data Providers, Safety & Modes, Audit & Comparison, Stock Momentum return path, and full activity log were exercised. Selected, disabled, hover, focus-visible, PAPER, warning, degraded, positive, and negative states remain distinguishable.
- Responsiveness and accessibility: passed. The 390 px capture has no horizontal overflow. Active strategy cards remain centered, metrics become two columns, candidates use a rail, chart summary stacks, and the observatory moves below the primary workspace. Mobile range controls meet the 38 px touch-target minimum. Semantic buttons, `aria-pressed`, labels, alt text, visible focus rings, and reduced-motion rules are present.

## Comparison history

### Iteration 1

- Earlier evidence: `28-option-2-data-pulse-desktop.png`
- P2 findings:
  - The learning/risk row and disclosure sat too low for the reference first-screen composition.
  - The activity card was shorter than the reference and allowed the safety hold to intrude too early.
  - The platform was too dim to read as the intended layered market-floor asset.
  - Mobile range controls caused the chart title to wrap awkwardly.
- Fixes:
  - Reduced chart, candidate, and lower-panel vertical dimensions while preserving all data.
  - Increased the activity card height to match the reference rail.
  - Rebalanced rendered-platform opacity, brightness, and saturation.
  - Tightened mobile chart typography and control layout.
- Post-fix evidence: `30-option-2-final-desktop.png` and `31-option-2-final-mobile.png`

### Iteration 2

- Earlier evidence: `35-live-packet-final.png`
- P2 findings:
  - Standard interface icons still used locally handcrafted inline SVG paths, which did not satisfy the asset-fidelity bar.
  - Several compact chart and navigation controls did not have an explicit shared focus-visible treatment; mobile range targets were below 38 px.
- Fixes:
  - Replaced the handcrafted interface icon set with `@tabler/icons-react`.
  - Added cyan focus-visible rings to the carousel, range controls, utility navigation, and activity-log action.
  - Raised mobile range controls to 38 × 38 px minimum targets.
- Post-fix evidence: `45-option-2-release-desktop.png`, `46-option-2-release-mobile.png`, and `47-option-2-release-side-by-side.png`

### Iteration 3

- Earlier evidence: `49-preaudit-current.png`
- P2 findings:
  - The podium read as bright flat bands rather than a restrained dimensional metal platform.
  - Relative header/activity times and raw audit summaries did not match the reference instrument-panel hierarchy.
  - The command menu shifted Pause and Emergency away from their reference alignment.
  - The chart title, information affordance, Today selector, legend, and axes were too simplified.
  - Candidate-heading grouping and observatory glow/motion emphasis visibly differed.
- Fixes:
  - Re-rendered the Blender platform and animation with brighter blue-steel materials, clearer bevels, thinner cyan rims, and reduced idle emission.
  - Added exact local clocks and concise semantic activity titles while preserving original live details.
  - Removed the compact menu from the safety-action layout flow and matched action widths.
  - Added the information-circle icon, reference-style Today selector, truthful legend labels, and real y/time axes.
  - Corrected candidate-heading alignment and rebalanced static topology brightness against live packet motion.
- Post-fix evidence: `56-parity-qa-desktop-stable.png`, `55-parity-qa-mobile.png`, `57-option-2-parity-side-by-side.png`, and `58-option-2-parity-focused.png`

### Iteration 4

- Earlier evidence: `66-pixel-parity-desktop-retry.png`
- P2 findings:
  - Candidate sparklines were built from only four score anchors and could read as straight or simplified lines.
  - The chart used a simplified percentage-axis presentation and did not include the reference's dimensional deck.
  - Several metric, learning, risk, activity, and provider-health symbols did not match the reference semantics closely enough.
  - The strategy podium's metal faces rendered too dark, leaving the bright horizontal rims more visible than the physical platform.
  - The observatory did not show the same enclosing-panel hierarchy and retained an extra inner topology boundary.
- Fixes:
  - Added persisted one-minute candidate histories and render up to 48 real closing-price points.
  - Rebuilt the chart around truthful normalized-index values and added a Blender-rendered perspective deck/grid.
  - Expanded the Tabler icon mapping and assigned reference-matching semantic symbols throughout the screen.
  - Reworked Blender podium materials, bevel widths, tier geometry, lighting, static asset, and animated asset.
  - Added the observatory enclosure, removed the redundant topology frame, and aligned provider cards, hub, and metric density.
- Post-fix evidence: `75-pixel-parity-release-desktop-stable.png`, `74-pixel-parity-release-mobile.png`, `76-option-2-pixel-parity-side-by-side.png`, and `77-option-2-pixel-parity-focused.png`

### Iteration 5

- Earlier evidence: `artifacts/option-2-parity-2026-07-16-desktop-final-v2.png`
- P2 findings:
  - The podium camera showed too much of a bright rectangular front face and too little of the stepped top deck.
  - The strategy-card track sat slightly left of the reference.
  - Provider labels and lower-panel microcopy were too faint at the exact reference viewport.
  - The Birdeye tile used an older approximation rather than the current official transparent mark.
- Fixes:
  - Reframed the Blender camera higher, darkened the front steel, reduced direct face lighting, exposed the tiered upper surface, and regenerated both the static podium and its live glow loop.
  - Shifted the desktop strategy-card track into source alignment while preserving the centered mobile card.
  - Increased observatory topology contrast and compact metric typography without changing the live hierarchy.
  - Replaced the Birdeye approximation with its official transparent brand asset.
- Post-fix evidence: `artifacts/option-2-parity-2026-07-16-desktop-final-v4.png`, `artifacts/option-2-parity-2026-07-16-mobile-final-v4.png`, `artifacts/option-2-parity-2026-07-16-side-by-side-final-v4.png`, `artifacts/option-2-parity-2026-07-16-stage-focused-final-v4.png`, and `artifacts/option-2-parity-2026-07-16-observatory-focused-final-v4.png`

### Iteration 6

- Earlier evidence: `artifacts/option-2-graph-rework-desktop-v1.png`
- P2 findings:
  - Wide or stale IEX quotes created false one-minute NAV crashes in the displayed strategy line.
  - The SVG preserved its aspect ratio inside a wider panel and visually letterboxed the plot.
  - Strategy and SPY used inconsistent selected-range baselines, and the legacy-to-robust benchmark transition could kink at the newest edge.
  - Chart labels, lower-card microcopy, and the rendered podium were too faint.
- Fixes:
  - Separated conservative executable bid valuation from robust portfolio marking, using the median of quote midpoint, latest trade, and minute close for future NAV marks.
  - Added bounded local impulse repair, light smoothing, smooth cubic paths, full-width plotting, and a stable normalized index scale.
  - Rebased both lines to the selected range and joined legacy benchmark returns to robust benchmark prices with continuity.
  - Increased chart hierarchy, lower-card readability, and podium/deck visibility.
- Post-fix evidence: `artifacts/option-2-graph-rework-desktop-v6.png`, `artifacts/option-2-graph-rework-mobile-v6.png`, and `artifacts/option-2-graph-rework-graph-focus-v6.png`

### Iteration 7

- Earlier evidence: `artifacts/option-2-observatory-compare-v1.png`
- P2 findings:
  - The observatory topology used a close approximation but its dotted paths and central hex did not match the supplied crop.
  - Provider, health, usage, pressure, total, and activity-card surfaces lacked the reference's depth and readable density.
  - The activity stream was missing the separate colored timeline nodes and reference-style status pills.
  - Narrow mobile topology cards crowded the Local Index hub.
- Fixes:
  - Added the supplied Option 2 source as the exact desktop connector-and-hex layer while preserving live provider cards, dynamic values, sanitized packet activation, and the existing mobile fallback.
  - Matched the two metric rows, glow, borders, spacing, type sizes, progress bar, activity card height, timeline, event icons, and tone-aware pills.
  - Added responsive provider widths and hub spacing at 430 px and below.
- Post-fix evidence: `artifacts/option-2-observatory-desktop-final.png`, `artifacts/option-2-observatory-mobile-full-final.png`, `artifacts/option-2-observatory-side-by-side-final.png`, and `artifacts/option-2-observatory-focused-final.png`

### Iteration 8

- Earlier evidence: the live observatory appeared to move pale route dots while its green data indicators looked stationary.
- P2 findings:
  - The animated WebP repeated the complete topology instead of containing only packet motion.
  - Transparent frame composition retained pixels from earlier frames, creating pale trails that made the stationary route appear animated.
  - Packet paths spent too much of their loop hidden beneath provider cards or the Local Index hub.
- Fixes:
  - Split the animation into a packet-only Blender render so the cyan-white topology remains part of the stationary base layer.
  - Re-encoded the 48-frame motion layer as an APNG with source replacement and explicit frame disposal to prevent accumulated trails.
  - Shortened each motion path to the visible connector span and rendered saturated lime packets at the reference scale.
  - Kept all routes visibly alive during a data pulse while the transmitting provider card remains the source-attribution highlight.
- Post-fix evidence: `artifacts/topology-green-dot-live-final-1.png`, `artifacts/topology-green-dot-live-final-2.png`, `artifacts/topology-green-dot-live-final-focus-1.png`, and `artifacts/topology-green-dot-live-final-focus-2.png`

## Primary interaction and runtime checks

- Desktop 5D range selection and settled render: passed.
- Mobile range controls: passed.
- Live provider packet activation: passed; saturated green packets move across stationary cyan-white routes while provider-card highlighting preserves source attribution.
- Console errors/warnings during strict desktop capture: none.
- Console errors/warnings during strict mobile capture: none.
- Desktop document width: `1487`; viewport width: `1487`.
- Mobile capture request: `390 × 844`; Chrome's mobile emulation reported an effective layout viewport of `413 px`, with document width also `413 px` and no overflow.
- Full workspace typecheck: passed.
- Full workspace build: passed.
- Automated tests: `106` files and `911` tests passed.

## Expected production differences

- The concept is a baked cinematic raster while CopyLab is a live responsive interface, so subpixel text rasterization and specular highlights can vary by browser frame.
- Provider latency, health, candidate symbols, prices, P&L, chart paths, activity text, and safety banners differ because the dashboard shows current truth instead of illustrative mock values.
- Official provider marks are retained where the concept uses stylized brand approximations.
- Existing workspaces remain reachable through the CopyLab brand command target without adding the extra visible menu symbol.

## Implementation checklist

- [x] Desktop composition matches the Option 2 hierarchy and proportions.
- [x] Mobile layout is usable at 390 × 844 with no horizontal overflow.
- [x] Official provider marks and rendered visual assets are present.
- [x] Data packets animate only from sanitized live-event triggers.
- [x] Local Index processing pulse is synchronized with event handling.
- [x] Existing workspaces and controls remain reachable.
- [x] Focus, reduced-motion, semantic labeling, and touch sizing are covered.
- [x] Browser captures have no console errors.
- [x] Typecheck, build, and all automated tests pass.

Final result: passed

---

# Pilot Marketplace QA — 2026-07-18

## Scope and visual sources

- Capability references supplied by the user:
  - `artifacts/autopilot-reference/reference-1.jpg`
  - `artifacts/autopilot-reference/reference-2.jpg`
  - `artifacts/autopilot-reference/reference-3.jpg`
- CopyLab visual-system source truth: `artifacts/option-2-redesign/option-2-holographic-market-floor.png`
- Final marketplace evidence:
  - `artifacts/pilot-marketplace-desktop-final-v2.png`
  - `artifacts/pilot-marketplace-active-detail.png`
  - `artifacts/pilot-marketplace-brokers.png`
  - `artifacts/pilot-marketplace-option-2-side-by-side.png`

The supplied phone screenshots are capability references, not a visual design target. The Option 2 market floor remains the design-system source. The marketplace is intentionally a separate discovery and management workspace, so it inherits the shell, palette, typography, density, borders, status colors, icon language, and live-state treatment without duplicating the operational dashboard's strategy stage, charts, or observatory rail.

## Browser-rendered checks

- Chosen-browser viewport: `1028 × 802`; rendered document width: `1013`; device pixel ratio: `1.25`.
- Marketplace navigation and return to the main market floor: passed.
- Search for `13F`, one-result state, research-detail drawer, and non-enrollable research state: passed.
- US Stock Momentum active-pilot detail, recorded performance chart/table, evidence/risk sections, and PAPER-only enrollment disclosure: passed.
- Percentage allocation preview: `10%` of an explicitly entered `$1,000` reference PAPER NAV produced a `$100.00` isolated PAPER allocation; enrollment remained disabled without the acknowledgment and was not submitted.
- Asset filter: `US stocks` returned `4 of 7`, then reset to `7 of 7`: passed.
- My Pilots empty state and Explore pilots return path: passed.
- Provider and routing view: local CopyLab PAPER is separated from external-provider counts; Alpaca is data/local-simulation only; Schwab and both Robinhood entries remain unavailable or disconnected; every external-order and live-order flag remains disabled.
- Browser console warnings/errors during final interaction pass: `0`.
- No enrollment, rebalance, switch, broker order, live-order unlock, safety-hold clear, or trading-state mutation was performed during QA.

## Visual comparison judgment

- The side-by-side comparison confirms the same CopyLab Option 2 shell, near-black navy surfaces, lime/cyan state colors, Rajdhani technical typography, compact status pills, restrained glow, thin borders, and control hierarchy.
- The marketplace uses a catalog grid and detail drawer because its job is strategy discovery, evidence review, and isolated PAPER allocation. The reference market floor uses an operational strategy stage, equity chart, candidates, learning panels, and observatory rail. Those information-architecture differences are intentional and are not a visual-parity defect.
- No P0 or P1 visual defect was found within the requested marketplace workflow. The final pass corrected capability-language drift: implemented pilots now say `PAPER engine available`; proposed thematic, 13F, and public-official concepts are explicitly research-only and non-enrollable; the local simulator is not counted as an external broker connection.
- The selected browser extension did not expose viewport emulation, so a fresh synthetic mobile capture was not created in this pass. Responsive CSS and the web test suite remained green, and the existing Option 2 mobile shell evidence is preserved earlier in this document.

## Runtime and regression evidence

- Full workspace typecheck: passed.
- Automated tests: `153` files and `1,367` tests passed.
- Full production build: passed.
- Fresh post-restart marketplace read: `324 ms`; a second expired-cache read: `601 ms`.
- Marketplace read-model TTL: `15 seconds`; optional Alpaca UI diagnostic wait budget: `1 second`; mutation paths invalidate the read model immediately; safety and trading decisions do not use the UI cache.
- Live runtime after restart: schema `45`, mode `PAPER`, primary NAV `$141.00`, `0` open positions, `7` catalog entries, `2` implemented/enrollable PAPER pilots, `5` research-only concepts, and `0` marketplace enrollments.
- All broker `liveExecutionSupported` and `automaticOrderSubmissionEnabled` flags: `false`.
- Existing operational hold remains active for `HELIUS_OUTAGE`, `HISTORY_GAP_REPAIR`, and `LOCAL_DATA_UNHEALTHY`; it was not cleared.
- `data\server-error.log`: `0` bytes.

Final result: passed for the internal PAPER marketplace MVP and Option 2 design-system consistency. Exact scene parity with the operational market-floor dashboard is not applicable because this is a distinct workspace with a different user task.
