import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { openDatabase } from "./database.js";
import { StockPaperRepository } from "./stock-paper-repository.js";

const requestedPath = process.argv[2];
if (!requestedPath || !isAbsolute(requestedPath)) {
  throw new Error("The stock PAPER database path must be absolute.");
}
const databasePath = resolve(requestedPath);
if (!existsSync(databasePath)) throw new Error("The CopyLab database does not exist.");

const targetNavUsd = Number(process.argv[3]);
if (!Number.isFinite(targetNavUsd) || targetNavUsd <= 0) {
  throw new Error("The stock PAPER target NAV must be a positive number.");
}

const db = openDatabase(databasePath);
try {
  const repository = new StockPaperRepository(db);
  const lane = repository.activeLane();
  if (!lane) throw new Error("CopyLab has no active stock PAPER lane to adjust.");
  const event = repository.adjustCapitalToTarget({
    laneId: lane.id,
    targetNavUsd,
    reason: "USER_REQUESTED_BANKROLL_INCREASE",
    createdAt: new Date().toISOString()
  });
  db.pragma("wal_checkpoint(TRUNCATE)");
  process.stdout.write(JSON.stringify({
    ok: true,
    paperOnly: true,
    targetNavUsd: event.targetNavUsd,
    deltaUsd: event.deltaUsd,
    adjustedInitialNavUsd: event.adjustedInitialNavUsd,
    tradingPnlUsd: event.tradingPnlUsdAfter,
    eventId: event.id,
    createdAt: event.createdAt
  }));
} finally {
  db.close();
}
