import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const visualRoot =
  process.env.COPYLAB_VISUAL_ROOT ?? path.join(workspace, "artifacts", "option-2-redesign");
const outputDir = path.join(workspace, "docs", "figma");
const outputPath = path.join(
  outputDir,
  "CopyLab-Option-2-Visual-Reaudit-2026-07-16.svg",
);

const imagePaths = {
  reference: path.join(visualRoot, "option-2-holographic-market-floor.png"),
  desktop: path.join(visualRoot, "78-option-2-reaudit-desktop.png"),
  focused: path.join(visualRoot, "81-option-2-reaudit-focused.png"),
  mobile: path.join(visualRoot, "79-option-2-reaudit-mobile.png"),
};

const imageData = Object.fromEntries(
  await Promise.all(
    Object.entries(imagePaths).map(async ([key, filePath]) => [
      key,
      `data:image/png;base64,${(await readFile(filePath)).toString("base64")}`,
    ]),
  ),
);

const escapeXml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const textLines = ({
  x,
  y,
  lines,
  size = 25,
  fill = "#aabbd0",
  weight = 500,
  lineHeight = 1.38,
  maxWidth,
}) => {
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${x}" dy="${index === 0 ? 0 : size * lineHeight}">${escapeXml(line)}</tspan>`,
    )
    .join("");

  return `<text x="${x}" y="${y}" class="body" font-size="${size}" font-weight="${weight}" fill="${fill}"${
    maxWidth ? ` textLength="${maxWidth}" lengthAdjust="spacingAndGlyphs"` : ""
  }>${tspans}</text>`;
};

const pill = ({ x, y, width, label, color = "#6cffb0", fill = "#0b281f" }) => `
  <g>
    <rect x="${x}" y="${y}" width="${width}" height="44" rx="22" fill="${fill}" stroke="${color}" stroke-opacity=".55"/>
    <circle cx="${x + 24}" cy="${y + 22}" r="6" fill="${color}" filter="url(#softGlow)"/>
    <text x="${x + 41}" y="${y + 29}" class="label" font-size="19" font-weight="800" fill="${color}">${escapeXml(label)}</text>
  </g>`;

const imageCard = ({
  x,
  y,
  width,
  height,
  image,
  imageWidth,
  imageHeight,
  step,
  title,
  status,
  statusColor,
  statusFill,
  summary,
  notes,
}) => {
  const imageX = x + 30;
  const imageY = y + 108;
  const imageBoxWidth = width - 60;
  const imageBoxHeight = height;
  const noteY = imageY + imageBoxHeight + 56;
  const pillWidth = Math.max(170, status.length * 14 + 58);

  return `
  <g>
    <rect x="${x}" y="${y}" width="${width}" height="${height + 430}" rx="34" class="panel" filter="url(#panelShadow)"/>
    <text x="${x + 32}" y="${y + 54}" class="eyebrow" font-size="18" font-weight="850" fill="#63deff">STEP ${escapeXml(step)}</text>
    <text x="${x + 32}" y="${y + 88}" class="heading" font-size="28" font-weight="760" fill="#f2f8ff">${escapeXml(title)}</text>
    ${pill({
      x: x + width - pillWidth - 30,
      y: y + 28,
      width: pillWidth,
      label: status,
      color: statusColor,
      fill: statusFill,
    })}
    <rect x="${imageX - 1}" y="${imageY - 1}" width="${imageBoxWidth + 2}" height="${imageBoxHeight + 2}" rx="24" fill="#07131f" stroke="#2c5570" stroke-width="2"/>
    <image href="${image}" x="${imageX}" y="${imageY}" width="${imageBoxWidth}" height="${imageBoxHeight}" preserveAspectRatio="xMidYMid meet" clip-path="url(#clip-${step})"/>
    <clipPath id="clip-${step}"><rect x="${imageX}" y="${imageY}" width="${imageBoxWidth}" height="${imageBoxHeight}" rx="23"/></clipPath>
    <text x="${x + 32}" y="${noteY}" class="heading" font-size="24" font-weight="760" fill="#f2f8ff">${escapeXml(summary)}</text>
    ${textLines({
      x: x + 32,
      y: noteY + 44,
      lines: notes,
      size: 22,
      fill: "#9fb4c9",
      weight: 520,
      lineHeight: 1.44,
    })}
  </g>`;
};

const findingCard = ({ x, y, number, title, body, color = "#63deff" }) => `
  <g>
    <rect x="${x}" y="${y}" width="1030" height="390" rx="30" class="panel" filter="url(#panelShadow)"/>
    <circle cx="${x + 64}" cy="${y + 68}" r="32" fill="#092335" stroke="${color}" stroke-width="2"/>
    <text x="${x + 64}" y="${y + 77}" class="heading" text-anchor="middle" font-size="24" font-weight="850" fill="${color}">${number}</text>
    <text x="${x + 116}" y="${y + 61}" class="heading" font-size="26" font-weight="780" fill="#f2f8ff">${escapeXml(title)}</text>
    <text x="${x + 116}" y="${y + 91}" class="eyebrow" font-size="17" font-weight="850" fill="${color}">P2 VISUAL FIDELITY</text>
    ${textLines({
      x: x + 42,
      y: y + 154,
      lines: body,
      size: 22,
      fill: "#9fb4c9",
      weight: 520,
      lineHeight: 1.48,
    })}
  </g>`;

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="4600" height="3100" viewBox="0 0 4600 3100">
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#020813"/>
      <stop offset=".54" stop-color="#06121f"/>
      <stop offset="1" stop-color="#03101a"/>
    </linearGradient>
    <radialGradient id="cyanAura" cx=".5" cy=".5" r=".5">
      <stop offset="0" stop-color="#39d8ff" stop-opacity=".19"/>
      <stop offset="1" stop-color="#39d8ff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="verdict" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="#082536"/>
      <stop offset=".52" stop-color="#09202c"/>
      <stop offset="1" stop-color="#11251d"/>
    </linearGradient>
    <pattern id="grid" width="72" height="72" patternUnits="userSpaceOnUse">
      <path d="M72 0H0V72" fill="none" stroke="#123047" stroke-width="1" opacity=".38"/>
      <circle cx="0" cy="0" r="1.5" fill="#63deff" opacity=".22"/>
    </pattern>
    <filter id="panelShadow" x="-20%" y="-20%" width="140%" height="160%">
      <feDropShadow dx="0" dy="20" stdDeviation="24" flood-color="#000711" flood-opacity=".68"/>
    </filter>
    <filter id="softGlow" x="-300%" y="-300%" width="700%" height="700%">
      <feGaussianBlur stdDeviation="5" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .body, .heading, .eyebrow, .label { font-family: Inter, "Segoe UI", Arial, sans-serif; }
      .panel { fill: #071522; stroke: #1d3b50; stroke-width: 2; }
      .eyebrow { letter-spacing: 2.5px; }
    </style>
  </defs>

  <rect width="4600" height="3100" fill="url(#background)"/>
  <rect width="4600" height="3100" fill="url(#grid)"/>
  <ellipse cx="820" cy="180" rx="900" ry="430" fill="url(#cyanAura)"/>
  <ellipse cx="3920" cy="2800" rx="880" ry="500" fill="url(#cyanAura)" opacity=".56"/>

  <g>
    <rect x="150" y="120" width="12" height="124" rx="6" fill="#5ee8ff" filter="url(#softGlow)"/>
    <text x="202" y="168" class="eyebrow" font-size="21" font-weight="850" fill="#62ddff">COPYLAB / DESIGN PARITY BOARD</text>
    <text x="202" y="224" class="heading" font-size="51" font-weight="820" fill="#f4f9ff">Option 2 Visual Re-Audit</text>
    <text x="202" y="270" class="body" font-size="24" font-weight="560" fill="#91a9be">Fresh evidence • 16 July 2026 • PAPER state • truth-preserving comparison</text>
    ${pill({
      x: 3792,
      y: 144,
      width: 650,
      label: "CONDITIONAL PRODUCTION PASS",
      color: "#7dff86",
      fill: "#0b2b20",
    })}
  </g>

  <g>
    <rect x="150" y="330" width="4290" height="190" rx="34" fill="url(#verdict)" stroke="#58d8ff" stroke-opacity=".5" stroke-width="2" filter="url(#panelShadow)"/>
    <text x="196" y="387" class="eyebrow" font-size="19" font-weight="850" fill="#6cecff">VERDICT</text>
    <text x="196" y="442" class="heading" font-size="35" font-weight="800" fill="#f4f9ff">No P0 or P1 findings. Four P2 visual-fidelity gaps remain.</text>
    <text x="196" y="482" class="body" font-size="23" font-weight="540" fill="#a8bbcc">Composition, functionality, live-data integrity, and responsive behavior pass. Literal 100% screenshot parity needs one focused polish pass.</text>
    <g transform="translate(3460 372)">
      <text x="0" y="0" class="eyebrow" font-size="17" font-weight="850" fill="#8ca7bb">SEVERITY</text>
      <text x="0" y="58" class="heading" font-size="39" font-weight="850" fill="#76ff9a">P0 0</text>
      <text x="168" y="58" class="heading" font-size="39" font-weight="850" fill="#76ff9a">P1 0</text>
      <text x="336" y="58" class="heading" font-size="39" font-weight="850" fill="#ffc85e">P2 4</text>
    </g>
  </g>

  ${imageCard({
    x: 150,
    y: 580,
    width: 1040,
    height: 740,
    image: imageData.reference,
    step: "01",
    title: "Option 2 reference",
    status: "SOURCE OF TRUTH",
    statusColor: "#63deff",
    statusFill: "#092436",
    summary: "Holographic control-room target",
    notes: [
      "Strong cyan/lime hierarchy and dimensional podium.",
      "Luminous observatory routes and readable chart deck.",
      "Concept values and generated provider marks are illustrative.",
    ],
  })}

  ${imageCard({
    x: 1260,
    y: 580,
    width: 1040,
    height: 740,
    image: imageData.desktop,
    step: "02",
    title: "Fresh CopyLab desktop",
    status: "STRONG MATCH",
    statusColor: "#78ff97",
    statusFill: "#0b2b20",
    summary: "Functional and structural parity",
    notes: [
      "Header, strategies, metrics, chart, candidates and risk match.",
      "Podium is flatter and more horizontally banded.",
      "Small labels and activity details need more contrast.",
    ],
  })}

  ${imageCard({
    x: 2370,
    y: 580,
    width: 1390,
    height: 900,
    image: imageData.focused,
    step: "03",
    title: "Focused comparison",
    status: "POLISH PASS",
    statusColor: "#ffc85e",
    statusFill: "#2c2412",
    summary: "Lighting and depth remain",
    notes: [
      "Hub and route bloom need stronger idle-frame presence.",
      "Chart grid, ticks and lower deck need more contrast.",
      "Live values and official provider marks stay truthful.",
    ],
  })}

  ${imageCard({
    x: 3830,
    y: 580,
    width: 610,
    height: 900,
    image: imageData.mobile,
    step: "04",
    title: "Mobile extension",
    status: "HEALTHY",
    statusColor: "#78ff97",
    statusFill: "#0b2b20",
    summary: "Responsive behavior passes",
    notes: [
      "Active strategy remains centered.",
      "Metrics reflow without page overflow.",
      "No mobile source exists for pixel parity.",
    ],
  })}

  <text x="150" y="2070" class="eyebrow" font-size="19" font-weight="850" fill="#63deff">REMAINING VISUAL-FIDELITY WORK</text>
  <text x="150" y="2120" class="heading" font-size="37" font-weight="820" fill="#f4f9ff">Four bounded P2 corrections</text>

  ${findingCard({
    x: 150,
    y: 2175,
    number: "1",
    title: "Podium material and silhouette",
    body: [
      "Increase front-face height and midtone.",
      "Reduce excess horizontal rim lines.",
      "Separate top deck, face and lower centered step.",
    ],
    color: "#63deff",
  })}

  ${findingCard({
    x: 1260,
    y: 2175,
    number: "2",
    title: "Observatory hub and routes",
    body: [
      "Increase static cyan edge bloom.",
      "Brighten idle route dots near the hub.",
      "Keep live-event motion and official logos unchanged.",
    ],
    color: "#63deff",
  })}

  ${findingCard({
    x: 2370,
    y: 2175,
    number: "3",
    title: "Microcopy scale and contrast",
    body: [
      "Raise the smallest labels one visual step.",
      "Increase muted text and badge contrast.",
      "Recheck truncation after type-size changes.",
    ],
    color: "#ffc85e",
  })}

  ${findingCard({
    x: 3480,
    y: 2175,
    number: "4",
    title: "Chart grid and deck visibility",
    body: [
      "Raise grid and tick contrast slightly.",
      "Brighten the chart platform front edge.",
      "Preserve real traces and normalized values.",
    ],
    color: "#ffc85e",
  })}

  <g>
    <rect x="150" y="2635" width="4290" height="300" rx="34" class="panel" filter="url(#panelShadow)"/>
    <text x="194" y="2692" class="eyebrow" font-size="19" font-weight="850" fill="#63deff">VALIDATION SNAPSHOT</text>
    <text x="194" y="2742" class="heading" font-size="31" font-weight="800" fill="#f4f9ff">What is already proven</text>
    ${pill({ x: 194, y: 2782, width: 330, label: "DESKTOP 1487 × 1058", color: "#63deff", fill: "#092436" })}
    ${pill({ x: 548, y: 2782, width: 295, label: "MOBILE 390 × 844", color: "#63deff", fill: "#092436" })}
    ${pill({ x: 867, y: 2782, width: 195, label: "PAPER STATE", color: "#63deff", fill: "#092436" })}
    ${pill({ x: 1086, y: 2782, width: 370, label: "FUNCTIONAL STRUCTURE PASS", color: "#78ff97", fill: "#0b2b20" })}
    ${pill({ x: 1480, y: 2782, width: 362, label: "RESPONSIVE EXTENSION PASS", color: "#78ff97", fill: "#0b2b20" })}
    ${pill({ x: 1866, y: 2782, width: 362, label: "LIVE-DATA INTEGRITY PASS", color: "#78ff97", fill: "#0b2b20" })}
    ${pill({ x: 2252, y: 2782, width: 425, label: "100% SCREENSHOT PARITY OPEN", color: "#ffc85e", fill: "#2c2412" })}
    <text x="194" y="2890" class="body" font-size="21" font-weight="520" fill="#829bad">Source: fresh local captures and the full audit in docs/OPTION-2-REAUDIT-2026-07-16.md</text>
  </g>

  <text x="150" y="3048" class="body" font-size="19" font-weight="540" fill="#668197">CopyLab • Option 2 parity evidence • Figma-ready self-contained SVG</text>
  <text x="4440" y="3048" class="body" text-anchor="end" font-size="19" font-weight="700" fill="#6cecff">AUDIT BOARD / 2026-07-16</text>
</svg>`;

await mkdir(outputDir, { recursive: true });
await writeFile(outputPath, svg, "utf8");
console.log(outputPath);
