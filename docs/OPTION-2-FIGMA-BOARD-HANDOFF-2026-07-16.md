# CopyLab Option 2 Re-Audit — Figma Board Handoff

Date: 2026-07-16
Board title: **CopyLab Option 2 Visual Re-Audit — 2026-07-16**

## Verdict

**Conditional production pass — no P0/P1 findings and four remaining P2 visual-fidelity gaps.**

## Accepted screenshots

The reference and QA captures used for this handoff are local review evidence. They are intentionally excluded from the public repository. Place the locally retained Option 2 reference, fresh desktop capture, focused comparison, and mobile extension left to right with 200 px between them. Do not publish those source images as part of the code release.

## Notes to place below the screenshots

### Step 1 — Option 2 reference

- Health: source of truth
- Strength: clear holographic control-room hierarchy, bright cyan/lime lighting, dimensional podium, legible observatory routes, and strong chart deck.
- Evidence limit: generated concept values and provider marks are not authoritative live data.

### Step 2 — Fresh CopyLab desktop

- Health: strong functional and structural match
- Strength: header, three strategy cards, eight metrics, chart, five candidates, learning/risk row, provider observatory, activity stream, and PAPER disclosure all match the intended composition.
- Issue: podium reads flatter and more horizontally banded than the source.
- Issue: smallest labels and activity details are dimmer and smaller than the source.
- Accessibility risk: some microcopy and badges may be difficult to read at normal desktop viewing distance.

### Step 3 — Focused comparison

- Health: needs one visual-polish pass
- Issue: central observatory hub and packet routes need stronger bloom and dimensional lighting.
- Issue: chart grid, ticks, and lower deck need slightly more contrast.
- Expected difference: live values, token names, traces, provider status, clock time, and official provider marks should remain truthful rather than copied from the concept.

### Step 4 — Mobile extension

- Health: healthy responsive extension
- Strength: active strategy remains centered, metrics reflow, chart controls remain usable, and no page-level overflow was observed.
- Evidence limit: no mobile Option 2 reference exists for direct pixel comparison.

## Four P2 finding cards

1. **Podium material and silhouette**
   - Increase front-face height and midtone.
   - Reduce excess horizontal rim lines.
   - Separate the top deck, front face, and lower centered step more clearly.

2. **Observatory hub and route lighting**
   - Increase static cyan edge bloom.
   - Brighten idle route dots near the hub.
   - Keep live-event motion and official provider logos unchanged.

3. **Microcopy scale and contrast**
   - Increase the smallest labels by one visual step.
   - Raise muted-text and badge contrast.
   - Recheck truncation after resizing.

4. **Chart grid and deck visibility**
   - Raise grid and tick contrast slightly.
   - Brighten the chart platform's front edge.
   - Keep real stored traces and normalized values unchanged.

## Board layout

- Use one dark section titled **CopyLab Option 2 Visual Re-Audit — 2026-07-16**.
- Put the verdict card at the top.
- Put the four accepted screenshots in one left-to-right row.
- Put each screenshot's step title, health, and notes directly beneath it.
- Put the four numbered P2 finding cards in a second row.
- End with a small validation card:
  - Desktop: `1487 × 1058`
  - Mobile request: `390 × 844`
  - State: PAPER
  - P0: `0`
  - P1: `0`
  - P2: `4`
  - Functional structure: passed
  - Responsive extension: passed
  - Literal 100% screenshot parity: not yet passed

## Full audit

See `docs/OPTION-2-REAUDIT-2026-07-16.md`.
