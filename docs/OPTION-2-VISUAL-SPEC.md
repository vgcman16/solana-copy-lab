# CopyLab Option 2 Visual and Motion Specification

Status: **authoritative build contract**

Reference image: local design evidence intentionally excluded from the public repository.

Reference viewport: **1487 × 1058**

This document records the complete visible design, behavior, and acceptance criteria for the Option 2 Holographic Market Floor. The locally retained reference image—not a generic interpretation of it—is the source of truth.

## 1. Overall composition

| Region | Reference position | Approximate share | Required behavior |
|---|---:|---:|---|
| Header | `x 0–1487`, `y 0–63` | 100% × 6% | Sticky, compact, no horizontal overflow |
| Primary workspace | `x 0–1018`, `y 63–1058` | 68.5% width | Stock workspace remains visible without opening another page |
| Live observatory | `x 1018–1487`, `y 63–1058` | 31.5% width | Sticky desktop rail, stacked below the workspace on smaller screens |
| Strategy stage | `x 0–1018`, `y 63–299` | 236 px high | Four strategies on a dimensional illuminated podium |
| Metric strip | `x 13–1004`, `y 310–357` | 47 px high | Eight compact segmented metrics |
| Performance deck | `x 13–1004`, `y 366–644` | 278 px high | Main chart plus narrow outperformance panel |
| Candidates | `x 13–1004`, `y 653–823` | 170 px high | Five equal candidate cards |
| Learning/risk | `x 13–1004`, `y 832–1014` | 182 px high | Learning arms left, risk envelope right |
| Disclosure | `x 0–1018`, `y 1016–1058` | 42 px high | Always visible on desktop first screen |

## 2. Color and material system

Measured background family:

- Page/header black-blue: `#06101B`
- Main canvas: `#01131F`
- Raised panel: `#051724`
- Deep card face: `#071722`
- Panel border: `rgba(108, 190, 221, 0.18)`
- Strong cyan border: `#58D9FF`
- Primary lime: `#A9F66F`
- Positive green: `#91E56B`
- Cyan information: `#65DCE8`
- Warning amber: `#F4BE63`
- Rejection/emergency red: `#FF716B`
- Main text: `#EDF5F7`
- Secondary text: `#92A6AE`
- Tertiary text: `#536A74`

Material rules:

- The page is dark navy, not neutral gray or pure black.
- Panels have thin blue-gray borders and slightly brighter top edges.
- Cards use subtle internal gradients, soft shadows, and edge highlights.
- Cyan glow is reserved for selection, data flow, and primary structural edges.
- Lime glow is reserved for healthy/positive/live state.
- Amber and red must remain semantic rather than decorative.
- Background gradients must be subtle; no colorful fog that competes with data.

## 3. Typography

- Primary command-center font: **Rajdhani**
- CopyLab wordmark: **Space Grotesk**
- Headings: Rajdhani 600–700, slightly condensed, uppercase where shown
- Numeric values: Rajdhani 600–700 with tabular alignment where supported
- Labels: uppercase, 0.06–0.14 em letter spacing
- Body/supporting text: Rajdhani 400–500

Minimum desktop visual sizes:

| Text type | Size |
|---|---:|
| CopyLab wordmark | 18–19 px |
| Active strategy title | 20–22 px |
| Side strategy title | 14–15 px |
| Major panel heading | 13–15 px |
| Primary metric value | 15–18 px |
| Candidate symbol | 10–12 px |
| Candidate score | 17–19 px |
| Right-rail major value | 15–18 px |
| Activity title | 8–10 px |
| Micro label | 7–8 px |

Text should never look like tiny debugging output. Supporting labels may be compact but must remain legible at the 1487 × 1058 reference viewport.

## 4. Header

Required left-to-right structure:

1. CopyLab illuminated rounded-square mark
2. `Copy` white + `Lab` lime wordmark
3. PAPER mode pill
4. Lime live-update dot and `LIVE UPDATES`
5. Updated time with a thin vertical divider
6. Pause button with pause icon
7. Emergency Exit button with warning icon

Details:

- Header height: 62–64 px.
- Brand stays at far left.
- Status group begins left-of-center, not perfectly centered.
- Pause button is dark, outlined, about 115 px wide in the reference.
- Emergency Exit is wider, red outlined, and visually strongest.
- The utility workspace drawer may exist as a compact icon but must not visually dominate.
- Mobile keeps brand mark, PAPER pill, and compact icon actions; noncritical text may collapse.

## 5. Strategy switcher and podium

### Structure

- Centered `STRATEGY SWITCHER` label between two thin cyan rules.
- Left and right chevrons align vertically with the strategy cards.
- Four visible cards:
  - Strict Copy
  - High-Risk Copy
  - Stock Momentum
  - Autonomous Crypto
- Stock Momentum is the reference active card.

### Active card

- Approximately twice the width of a side card.
- Cyan outline, cyan bottom edge, and soft cyan halo.
- Larger title, visible mini performance trace, and larger NAV/P&L/DD values.
- Small lime `ACTIVE` badge at top right.
- Small strategy/provider eyebrow above the title.

### Side cards

- Narrower, dimmer, and slightly angled toward the active card.
- No fake ACTIVE badges.
- Still readable and clickable.
- Real status may be exposed through tone, tooltip, or expanded view without contradicting the reference.

### Podium

- Must read as a real layered dark-metal platform:
  - broad upper deck
  - beveled front edge
  - cyan illuminated rim
  - lower recessed tier
  - central green status light
  - visible perspective and depth
- Platform animation is a quiet light sweep/pulse only.
- Card selection changes must be animated with restrained depth movement.

## 6. Stock metric strip

Eight equal segments:

1. Market phase
2. Symbols scanned
3. Candidates ranked
4. Normalized NAV
5. Total P&L
6. Cash / deployed
7. Drawdown
8. PAPER ONLY / NO ORDERS

Rules:

- One shared outer container with internal vertical separators.
- Each metric has a real icon in a small rounded square.
- Label above, strong value center, supporting detail below.
- The final PAPER-only segment has an amber/red outline and lock/shield icon.
- Metric values use live data only.

## 7. Performance chart

### Header

- `EQUITY VS SPY` title on left with a small information icon.
- Legend directly below/near title:
  - lime solid: strategy
  - muted cyan/gray: SPY benchmark
- Range controls on right:
  - Today selector
  - 1D, 5D, 1M, YTD, All
- Active range has cyan outline/glow.

### Plot

- Dark cyan grid.
- Strategy line: solid lime with a restrained glow.
- Benchmark line: thin muted cyan/gray.
- Real marks only; never fabricate a smoother history.
- Sparse real data may use interpolation for rendering between real points, but cannot invent additional values or change the series.
- Axis/time labels remain muted.

### Side summary

- Narrow green-tinted panel.
- Outperformance is the largest number.
- `vs SPY` label beneath.
- Correlation below a divider.

## 8. Top candidates

- Five equal cards in one row.
- Rank badge at upper left.
- Symbol and company name beside rank.
- Large momentum score at upper right.
- Lime sparkline through the middle.
- Price lower left and recent percent change lower right.
- Small semantic tags at the bottom:
  - strategy arm
  - conviction
  - eligible/watch state
- Selected/eligible candidates receive a subtle green border, not a heavy glow.
- All values remain derived from the current IEX candidate record.

## 9. Learning arms

Four cards:

- Breakout
- Opening Range
- Pullback Recovery
- Volume Surge

Each card contains:

- Small strategy icon/avatar treatment
- Arm name
- Realized P&L
- Trade and win-rate summary
- Thin lime progress/evidence bar
- Next-size multiplier

The learning section must show bounded adaptation, not imply an unrestricted self-modifying live broker.

## 10. Risk envelope

Visible fields:

- Risk budget
- Maximum drawdown
- Maximum position
- Position capacity
- Deployment ceiling
- Liquidity buffer

Rules:

- Two or three-column compact layout depending on width.
- Each field has label, actual limit/value, and a thin progress bar.
- Values must reflect the frozen high-risk PAPER policy and current account state.
- Do not replace real high-risk limits with the safer placeholder values shown in the concept image.

## 11. Live Data Observatory

### Header

- Small glowing lime dot.
- `LIVE DATA OBSERVATORY` uppercase label.
- Compact PAPER lock seal at upper right.
- No duplicate oversized heading.

### Provider topology

Provider cards must use official brand marks/logos, not generic database icons:

- Birdeye official colorful icon
- Helius official logomark
- Jupiter official colorful mark
- Alpaca official dark-background symbol
- Local Index uses the CopyLab/local engine hex mark

Official brand sources:

- Birdeye: `https://docs.birdeye.so/docs/brand-assets`
- Helius: `https://www.helius.dev/brand`
- Alpaca: `https://alpaca.markets/newsroom`
- Jupiter: official Jupiter/Jup brand asset source only

Topology layout:

- Birdeye, Helius, and Jupiter stack on the left.
- Local Index glowing hex occupies the center.
- Alpaca IEX sits on the right.
- Dotted cyan paths connect every provider to the Local Index.
- Green packets travel on the paths.

### Data-triggered motion

The packets represent real data and therefore must not loop continuously.

| Event source | Animation |
|---|---|
| Birdeye | Top-left path lights and packets travel into Local Index |
| Helius/Solana RPC | Middle-left path lights and packets travel into Local Index |
| Jupiter | Bottom-left path lights and packets travel into Local Index |
| Alpaca IEX | Right path lights and packets travel into Local Index |
| Local Index | Hex brightens/pulses without falsely attributing the event to a provider |

On every new sanitized SSE event:

1. Highlight the matching provider card.
2. Restart the one-shot packet animation.
3. Pulse the Local Index while it processes the event.
4. Fade back to the static topology after about four seconds.

Animation must respect `prefers-reduced-motion`.

## 12. Observatory metrics

First row:

- Health
- Monthly usage
- Rate pressure

Second row:

- Last event
- Accepted signals
- Rejected signals
- Simulated fills/actions

Details:

- Health uses lime when all are healthy and amber when degraded.
- Monthly usage shows a numeric percent and a lime progress line.
- Rate pressure uses a gauge icon and LOW/MEDIUM/HIGH semantic color.
- Values are live operational data, not illustrative numbers from the concept.

## 13. Activity stream

The activity stream is a designed timeline, not a compressed log dump.

Each row contains:

1. Relative time in a narrow left column
2. Colored circular event node
3. Strong event summary
4. Small supporting detail
5. Right-aligned status badge

Tone mapping:

- Accepted/success: lime
- Simulated fill: cyan
- Rejected/failure: red
- Market/provider update: blue-gray
- Safety hold/warning: amber
- Learning: cyan/lime

Visible first-screen activity:

- Maximum six rows at the reference viewport.
- Consistent 46–52 px row height.
- Thin vertical timeline through event nodes.
- Footer link/button: `View full activity log →`
- Full history opens the existing Audit workspace.

## 14. Buttons and interaction polish

- Buttons use real icons, not text symbols.
- Hover: brighter border and 1 px lift at most.
- Active: slight compression/no lift.
- Focus: visible cyan or lime focus ring.
- Disabled controls remain readable and explain why via title/accessible name.
- Emergency controls remain red and cannot be mistaken for ordinary navigation.
- Range buttons, strategy cards, carousel arrows, command drawer, and full activity link must work.

## 15. Mobile behavior

- No page-level horizontal overflow.
- Strategy cards use horizontal snap/scroll with active card centered.
- Metric strip becomes two columns.
- Chart summary moves below the chart.
- Candidate cards become a horizontal card rail.
- Right observatory moves below the primary workspace.
- Provider topology keeps the same logical arrangement and remains legible.
- Activity stream hides nonessential badge text only when necessary.
- Touch targets should be at least 38 px.

## 16. Acceptance checklist

- [x] Same 68.5/31.5 desktop split as the reference
- [x] Header elements align and size like Option 2
- [x] Rajdhani/Space Grotesk typography is loaded locally
- [x] Active strategy card and podium match the reference depth and proportions
- [x] Side cards are angled/dimmed without fake ACTIVE labels
- [x] Metric strip is one continuous eight-part bar
- [x] Chart composition, legend, range buttons, grid, and side summary match
- [x] Five candidate cards match the density and hierarchy
- [x] Learning and risk panels occupy the visible lower row
- [x] Disclosure is visible at the bottom of the first desktop screen
- [x] Official Birdeye, Helius, Jupiter, and Alpaca marks are used
- [x] Provider packet animation is triggered by real incoming data
- [x] Local Index pulse is synchronized with data processing
- [x] Observatory metrics match the reference hierarchy
- [x] Activity stream shows five designed reference-state rows, supports up to six, and includes a full-log button
- [x] All existing controls remain reachable
- [x] Desktop screenshot has no horizontal overflow or console errors
- [x] Mobile screenshot has no horizontal overflow or console errors
- [x] Reference and implementation are reviewed side by side at 1487 × 1058
- [x] `design-qa.md` ends with `Final result: passed`
