# Option 2 Pixel-Parity Audit

Status: **completed — passed**

Date: 2026-07-16

## Visual truth and final evidence

The reference, initial capture, final desktop/mobile captures, and comparison composites are local QA evidence intentionally excluded from the public repository. This durable report records the findings without redistributing those images.

- Desktop comparison viewport: `1487 × 1058`
- Implementation URL: `http://127.0.0.1:4310/`

The comparison uses the real PAPER ledger and current provider data. Structure, symbols, icon language, surfaces, color system, proportions, and motion match the reference. Values that naturally change—prices, candidate symbols, P&L, health, latency, quota, activity, and chart traces—remain truthful rather than being replaced with the concept's illustrative numbers.

## Severity

- **P0:** broken or unsafe core experience
- **P1:** major structural mismatch
- **P2:** clearly visible fidelity or interaction mismatch
- **P3:** minor polish difference
- **Expected:** required difference caused by live data, actual policy, accessibility, or official branding

## Strict comparison results

| Surface | Difference found at start of pass | Correction | Final |
|---|---|---|---|
| Candidate sparklines | Some graphs were built from only four score anchors, producing visibly straight/simple segments | Added real persisted one-minute closing-price history to the dashboard contract and render up to 48 real points per candidate | Passed |
| Candidate ordering/content | Visual order could follow provider order rather than the visible score ranking | Sort the visible top five by score and retain real price, change, company, score, and two compact tags | Passed |
| Main equity chart | Y-axis read like a simplified percent chart and the floor lacked the reference's dimensional trading deck | Render truthful normalized-index values around 100, real time labels, thinner series, the reference legend, and a Blender-rendered perspective platform/grid | Passed |
| Main chart line shape | Live series could include flat periods, but the component did not clearly separate that truth from simplified presentation | Preserve every stored real point; no smoothing or fabricated jitter was introduced | Passed / expected live shape |
| Header | An extra visible workspace-menu symbol was not present in the reference | Kept the existing workspaces reachable through an invisible brand-aligned command target with a visible focus ring | Passed |
| Header controls | Pause/Emergency rhythm and disabled danger treatment differed | Matched dimensions, spacing, border color, background color, and visible disabled-danger state | Passed |
| Strategy cards | Side-card angle, active-card elevation, and surface colors were slightly flatter | Increased perspective, aligned active/side elevations, and retuned navy/cyan/green surface tokens | Passed |
| Strategy podium | Correct geometry rendered too close to black, making the platform look like several bright straight strips | Reworked Blender materials, narrowed bevels, simplified tier heights, brightened the metal face, reduced animated overlay opacity, and re-rendered static and animated assets | Passed |
| Metric icons | Several symbols used generic meanings rather than the reference's clock, launch, settings, wallet, chart, coin, and shield language | Expanded the Tabler icon map and assigned reference-matching semantic icons | Passed |
| Candidate card density | Cards contained an extra lower line and the graph area was too shallow | Removed the redundant line, increased graph height, tightened header/rank spacing, and retained real stored history | Passed |
| Learning arms | Icons and vertical density did not match the four compact reference arms | Assigned chart, candlestick, pullback, and histogram symbols; increased title/P&L hierarchy and filled the reference-height cards | Passed |
| Risk envelope | Six independent blocks created a different lower-grid rhythm | Condensed to three top limits and two wide lower limits while preserving the actual high-risk policy | Passed |
| Observatory container | The implementation lacked the reference's single enclosing observatory panel and showed an extra inner topology frame | Added the enclosing inset panel boundary and removed the unnecessary inner frame while preserving section cards | Passed |
| Observatory topology | Hub/source scale, source positions, symbol sizes, and green packet emphasis differed | Repositioned four provider cards, enlarged official provider marks, strengthened the cyan hub, and kept provider-specific packet animation event-driven | Passed |
| Observatory metric symbols | Health, usage, and rate-pressure symbols were too generic | Switched to heartbeat, database, and gauge symbols with reference-like semantic colors | Passed |
| Activity stream | Event icons and titles were machine-oriented and visually uniform | Added event-specific symbols, exact clock times, concise semantic titles, supporting detail, and success/warning/critical colors | Passed |
| Footer disclosure | Warning treatment and copy hierarchy differed | Added the amber warning symbol and compact PAPER-only truthful disclosure | Passed |
| Mobile | Desktop reference did not define a mobile state | Verified centered active card, horizontal rails, two-column metrics, stacked chart, touch controls, and no page overflow | Passed extension |

## Symbol and asset inventory

### Matching interface symbols

- Brand pulse
- PAPER status dot
- Live status dot
- Pause
- Emergency warning
- Strategy arrows
- Market clock
- Symbols-scanned rocket
- Candidate settings
- NAV wallet
- P&L line chart
- Cash/deployed coins
- Drawdown shield
- PAPER shield lock
- Chart information
- Learning chart/candlestick/pullback/histogram
- Observatory health/database/gauge
- Activity safety/fill/signal/market/learning symbols
- Footer warning

All standard UI symbols use the same Tabler outline family. No emoji, text glyph approximation, or handcrafted interface SVG was added.

### Rendered and official assets

- Blender-rendered strategy podium: `apps/web/public/assets/market-floor-platform.png`
- Blender-rendered podium motion: `apps/web/public/assets/market-floor-platform-loop.webp`
- Blender-rendered chart deck: `apps/web/public/assets/market-chart-platform.png`
- Rendered observatory topology and event motion
- Official Birdeye, Helius, Jupiter, and Alpaca provider marks

The implementation intentionally keeps official provider marks even where the concept image uses a stylized or generated approximation of a brand symbol.

## Color comparison

| Role | Final treatment |
|---|---|
| Page background | Near-black blue |
| Primary surface | Deep navy |
| Observatory surface | Slightly brighter blue-navy |
| Structural line | Muted cyan |
| Selected/active edge | Bright cyan |
| Positive/healthy | Lime green |
| Warning/caution | Amber |
| Negative/emergency | Red |
| Supporting text | Blue-gray |
| Metal deck | Dark blue steel with silver-blue bevel |

The final capture preserves the source's restrained glow. Motion layers remain lower-opacity than static structure so the screen does not turn into a neon animation when idle.

## Expected differences that must remain

- Current candidate symbols and companies are selected from the live stock-paper research set.
- Candidate sparkline shapes are real stored market bars.
- Strategy and benchmark traces are real stored index points, so flat or volatile intervals may differ from the concept.
- NAV, P&L, deployed cash, drawdown, eligibility, and learning evidence are live PAPER values.
- Provider status, latency, usage, rate pressure, and activity totals are live operational values.
- The actual high-risk PAPER policy is shown instead of copying safer illustrative limits from the concept.
- Official provider logos are retained instead of imitating concept-generated trademarks.
- Focus-visible rings, semantic labels, reduced-motion behavior, and mobile responsiveness are production additions.

These are data and product-truth differences, not unresolved visual defects.

## Verification

- Full typecheck: passed
- Automated tests: `105` files and `907` tests passed
- Full production build: passed
- Focused candidate-history tests: passed
- Desktop strict capture: no console errors; document width equals viewport width
- Mobile strict capture: no console errors; document width equals effective mobile viewport width
- Local dashboard after production restart: HTTP 200
- Final comparison reviewed at the same `1487 × 1058` viewport

## Completion gate

- [x] Compare the reference and implementation together.
- [x] Replace simplified candidate lines with real detailed histories.
- [x] Match the icon and symbol language.
- [x] Match the chart hierarchy, axis treatment, and dimensional deck.
- [x] Match the podium materials, geometry, color, and restrained motion.
- [x] Match the observatory enclosure, topology, metrics, and activity hierarchy.
- [x] Preserve truthful live values and official provider marks.
- [x] Verify desktop and mobile.
- [x] Run the complete typecheck, test, and build gate.
- [x] Produce new final comparison evidence.

No actionable P0, P1, or P2 mismatch remains.

Final result: passed
