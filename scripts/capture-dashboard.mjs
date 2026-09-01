import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

const [
  url = "http://127.0.0.1:4310/",
  output = "dashboard.png",
  widthArg = "1440",
  heightArg = "1024",
  delayArg = "15000",
  targetText = "",
  clickTargetsArg = "",
] = process.argv.slice(2);

const width = Number.parseInt(widthArg, 10);
const height = Number.parseInt(heightArg, 10);
const delayMs = Number.parseInt(delayArg, 10);
const chromePath =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (![width, height, delayMs].every(Number.isFinite)) {
  throw new Error("Width, height, and delay must be finite integers.");
}

const sleep = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const reservePort = () =>
  new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a local debugging port."));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolvePromise(port);
      });
    });
  });

const connect = (webSocketDebuggerUrl) =>
  new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(webSocketDebuggerUrl);
    const pending = new Map();
    const notifications = [];
    let nextId = 1;

    socket.addEventListener("open", () => {
      resolvePromise({
        command(method, params = {}) {
          return new Promise((resolveCommand, rejectCommand) => {
            const id = nextId++;
            pending.set(id, { resolve: resolveCommand, reject: rejectCommand });
            socket.send(JSON.stringify({ id, method, params }));
          });
        },
        close() {
          socket.close();
        },
        notifications() {
          return [...notifications];
        },
      });
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) {
        notifications.push(message);
        return;
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result);
    });
    socket.addEventListener("error", () => {
      reject(new Error("Chrome debugging connection failed."));
    });
  });

const port = await reservePort();
const profile = mkdtempSync(join(tmpdir(), "copylab-capture-"));
const resolvedProfile = resolve(profile);
const resolvedTemp = `${resolve(tmpdir())}${sep}`;
if (
  !resolvedProfile.startsWith(resolvedTemp) ||
  !resolvedProfile.includes(`${sep}copylab-capture-`)
) {
  throw new Error("Refusing to use an unexpected Chrome profile directory.");
}

mkdirSync(dirname(resolve(output)), { recursive: true });

const chrome = spawn(
  chromePath,
  [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-sync",
    "--hide-scrollbars",
    "--no-first-run",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${resolvedProfile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore", windowsHide: true },
);

try {
  let target;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      target = targets.find(
        (candidate) =>
          candidate.type === "page" && candidate.webSocketDebuggerUrl,
      );
      if (target) break;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  if (!target) throw new Error("Chrome did not expose a page target.");

  const devtools = await connect(target.webSocketDebuggerUrl);
  try {
    await devtools.command("Page.enable");
    await devtools.command("Runtime.enable");
    await devtools.command("Log.enable");
    await devtools.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 700,
    });
    await devtools.command("Page.navigate", { url });
    await sleep(delayMs);
    const clickTargets = clickTargetsArg
      .split("||")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const clickTarget of clickTargets) {
      const encodedTarget = JSON.stringify(clickTarget);
      const clickResult = await devtools.command("Runtime.evaluate", {
        expression: `(() => {
          const target = Array.from(document.querySelectorAll("button, summary"))
            .find((element) => [
              element.textContent,
              element.getAttribute("aria-label"),
              element.getAttribute("title")
            ].some((value) => value?.replace(/\\s+/g, " ").trim().includes(${encodedTarget})));
          target?.click();
          return Boolean(target);
        })()`,
        returnByValue: true,
      });
      if (!clickResult.result?.value) {
        throw new Error(`Could not find dashboard button containing: ${clickTarget}`);
      }
      await sleep(750);
    }
    const diagnostic = await devtools.command("Runtime.evaluate", {
      expression: `(() => ({
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 500) ?? "",
        rootChildren: document.querySelector("#root")?.childElementCount ?? -1,
        readyState: document.readyState,
        scrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
        workspaceTitle: document.querySelector(".market-floor-section-title h1")?.textContent ?? "",
        topologyPulseSource: document.querySelector(".observatory-topology")?.getAttribute("data-active-source") ?? "",
        topologyMotionActive: Boolean(document.querySelector(".observatory-topology .topology-motion")),
        transmittingProvider: document.querySelector(".topology-source.transmitting strong")?.textContent ?? "",
        localIndexProcessing: Boolean(document.querySelector(".topology-hub.processing"))
      }))()`,
      returnByValue: true,
    });
    const errors = devtools.notifications()
      .filter((message) =>
        message.method === "Runtime.exceptionThrown" ||
        (
          message.method === "Log.entryAdded" &&
          ["error", "warning"].includes(message.params?.entry?.level)
        )
      )
      .slice(-20);
    if ((diagnostic.result?.value?.rootChildren ?? 0) <= 0 || errors.length > 0) {
      console.error(JSON.stringify({ diagnostic: diagnostic.result?.value, errors }, null, 2));
    }
    if (process.env.PRINT_DASHBOARD_DIAGNOSTIC === "1") {
      console.log(JSON.stringify({ diagnostic: diagnostic.result?.value, errors }, null, 2));
    }
    if (
      process.env.STRICT_DASHBOARD_QA === "1" &&
      (
        (diagnostic.result?.value?.rootChildren ?? 0) <= 0 ||
        errors.length > 0 ||
        (diagnostic.result?.value?.scrollWidth ?? 0) >
          (diagnostic.result?.value?.viewportWidth ?? 0) + 1
      )
    ) {
      throw new Error(`Dashboard QA failed: ${JSON.stringify(diagnostic.result?.value)}`);
    }
    if (targetText) {
      const encodedText = JSON.stringify(targetText);
      await devtools.command("Runtime.evaluate", {
        expression: `(() => {
          const target = Array.from(document.querySelectorAll("h1,h2,h3,strong"))
            .find((element) => element.textContent?.trim() === ${encodedText});
          target?.scrollIntoView({ block: "start", inline: "nearest" });
          return Boolean(target);
        })()`,
        returnByValue: true,
      });
      await sleep(750);
    }
    const result = await devtools.command("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
      fromSurface: true,
    });
    writeFileSync(resolve(output), Buffer.from(result.data, "base64"));
  } finally {
    devtools.close();
  }
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(resolvedProfile, { recursive: true, force: true });
}

console.log(resolve(output));
