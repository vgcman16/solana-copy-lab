import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactSensitiveText } from "@copylab/providers";
import { AppService } from "./app-service.js";
import { buildApp } from "./app.js";
import { openDatabase } from "./database.js";
import { openLearningDatabase } from "./learning-database.js";
import { EventBus } from "./events.js";
import { ModeManager } from "./mode.js";
import { Repository } from "./repository.js";
import { TradingRuntime } from "./runtime.js";
import { SecretVault } from "./vault.js";
import {
  ActiveDataProviderRpcConnectionResolver,
  DpapiTransactionSigner,
  WalletManager
} from "./wallet.js";

const host = "127.0.0.1";
const port = Number.parseInt(process.env.COPYLAB_PORT ?? "4310", 10);
if (!Number.isInteger(port) || port < 1024 || port > 65_535) {
  throw new Error("COPYLAB_PORT must be an integer between 1024 and 65535.");
}

const db = openDatabase();
const learningDb = openLearningDatabase();
const repository = new Repository(db);
const vault = new SecretVault(repository);
const wallet = new WalletManager(vault, repository);
const modes = new ModeManager(repository, wallet);
const events = new EventBus();
const signer = new DpapiTransactionSigner(vault, repository, {
  rpcConnectionResolver: new ActiveDataProviderRpcConnectionResolver(vault)
});
const pythBenchmarksApiKey = process.env.PYTH_API_KEY?.trim();
const runtime = new TradingRuntime(repository, vault, modes, events, signer, {
  learningDatabase: learningDb,
  ...(pythBenchmarksApiKey ? { pythBenchmarksApiKey } : {})
});
const service = new AppService(repository, vault, wallet, modes, events, runtime);
const app = await buildApp(service);

const dataDir = resolve(process.env.COPYLAB_DATA_DIR ?? resolve(process.cwd(), "data"));
const pidFile = resolve(dataDir, "server.pid");
const stopRequestFile = resolve(dataDir, "stop.request");
mkdirSync(dataDir, { recursive: true });
rmSync(stopRequestFile, { force: true });

let closing = false;
let stopRequestTimer: ReturnType<typeof setInterval> | undefined;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  if (stopRequestTimer) clearInterval(stopRequestTimer);
  repository.audit("server_stopping", `Local service is stopping after ${signal}.`);
  await runtime.stop().catch(() => undefined);
  await app.close().catch(() => undefined);
  learningDb.close();
  db.close();
  rmSync(pidFile, { force: true });
  rmSync(stopRequestFile, { force: true });
}

process.once("SIGINT", () => void shutdown("SIGINT").then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown("SIGTERM").then(() => process.exit(0)));
process.once("SIGHUP", () => void shutdown("SIGHUP").then(() => process.exit(0)));

await app.listen({ host, port });
writeFileSync(pidFile, String(process.pid), { encoding: "utf8", flag: "w" });
stopRequestTimer = setInterval(() => {
  if (!closing && existsSync(stopRequestFile)) {
    void shutdown("launcher stop request").then(() => process.exit(0));
  }
}, 500);
repository.audit("server_started", "Loopback service started.", { host, port, pid: process.pid });

try {
  await runtime.start();
} catch (error) {
  const message = redactSensitiveText(
    error instanceof Error ? error.message : "runtime initialization failed"
  );
  repository.audit("runtime_start_failed", message, undefined, "warning");
  app.log.warn("Runtime initialization failed closed; the setup dashboard remains available.");
}
