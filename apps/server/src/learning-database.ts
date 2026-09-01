import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type {
  AutonomousPaperStrategyArm,
  ChampionPromotionDecision,
  LearningAdmissionDecision,
  LearningPathObservation,
  MarketRegime,
  ModelArtifact,
  OutcomeLabel,
  PolicyChallenger,
  ShadowEpisode,
  StrategyArmScore,
  TradeAttribution,
  WalkForwardResult
} from "@copylab/shared";

export type LearningDatabase = Database.Database;
export const LEARNING_SCHEMA_VERSION = 4;

interface JsonRow { payload_json: string }

function encode(value: unknown): string {
  return JSON.stringify(value);
}

function decode<T>(row: JsonRow | undefined): T | undefined {
  return row ? JSON.parse(row.payload_json) as T : undefined;
}

function migrateLearningDatabase(db: LearningDatabase): void {
  const version = db.pragma("user_version", { simple: true }) as number;
  if (version > LEARNING_SCHEMA_VERSION) {
    throw new Error(`Learning database schema ${version} is newer than supported ${LEARNING_SCHEMA_VERSION}.`);
  }
  const foreignKeysWereEnabled = db.pragma("foreign_keys", { simple: true }) === 1;
  if (version < LEARNING_SCHEMA_VERSION && foreignKeysWereEnabled) db.pragma("foreign_keys = OFF");
  try {
    if (version < LEARNING_SCHEMA_VERSION) db.exec("BEGIN IMMEDIATE");
    db.exec(`
    CREATE TABLE IF NOT EXISTS learning_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS learning_universe_cycles (
      source_key TEXT PRIMARY KEY,
      lane_id TEXT NOT NULL,
      policy_version TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      regime TEXT NOT NULL,
      candidate_count INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_universe_cycles_captured
      ON learning_universe_cycles(captured_at DESC);

    CREATE TABLE IF NOT EXISTS learning_shadow_episodes (
      id TEXT PRIMARY KEY,
      source_key TEXT NOT NULL UNIQUE,
      lane_id TEXT NOT NULL,
      mint TEXT NOT NULL,
      strategy_arm TEXT NOT NULL,
      regime TEXT NOT NULL,
      status TEXT NOT NULL,
      shadow_only INTEGER NOT NULL CHECK (shadow_only IN (0, 1)),
      execution_tier TEXT NOT NULL DEFAULT 'SHADOW' CHECK (execution_tier IN ('SHADOW', 'CHAMPION')),
      created_day TEXT NOT NULL,
      opened_at TEXT,
      horizon_ends_at TEXT,
      last_observed_at TEXT,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_shadow_episodes_work
      ON learning_shadow_episodes(status, updated_at, id);
    CREATE INDEX IF NOT EXISTS learning_shadow_episodes_mint_day
      ON learning_shadow_episodes(mint, created_day, id);
    CREATE INDEX IF NOT EXISTS learning_shadow_episodes_arm_regime
      ON learning_shadow_episodes(strategy_arm, regime, status);

    CREATE TABLE IF NOT EXISTS learning_outcome_labels (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      horizon_minutes INTEGER NOT NULL CHECK (horizon_minutes IN (15, 45, 180)),
      dataset_eligible INTEGER NOT NULL CHECK (dataset_eligible IN (0, 1)),
      observed_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      UNIQUE(episode_id, horizon_minutes),
      FOREIGN KEY(episode_id) REFERENCES learning_shadow_episodes(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS learning_outcome_labels_dataset
      ON learning_outcome_labels(dataset_eligible, horizon_minutes, observed_at, episode_id);

    CREATE TABLE IF NOT EXISTS learning_path_observations (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      phase TEXT NOT NULL CHECK (phase IN ('ENTRY', 'MARK', 'HORIZON')),
      observed_at TEXT NOT NULL,
      elapsed_minutes REAL NOT NULL CHECK (elapsed_minutes >= 0),
      dataset_eligible INTEGER NOT NULL CHECK (dataset_eligible IN (0, 1)),
      payload_json TEXT NOT NULL,
      UNIQUE(episode_id, observed_at),
      FOREIGN KEY(episode_id) REFERENCES learning_shadow_episodes(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS learning_path_observations_episode
      ON learning_path_observations(episode_id, elapsed_minutes, observed_at);

    CREATE TABLE IF NOT EXISTS learning_model_artifacts (
      id TEXT PRIMARY KEY,
      model_kind TEXT NOT NULL,
      training_cutoff_at TEXT NOT NULL,
      dataset_digest TEXT NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_model_artifacts_active
      ON learning_model_artifacts(active, model_kind, created_at DESC);

    CREATE TABLE IF NOT EXISTS learning_arm_scores (
      strategy_arm TEXT NOT NULL,
      regime TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(strategy_arm, regime)
    );

    CREATE TABLE IF NOT EXISTS learning_trade_attributions (
      id TEXT PRIMARY KEY,
      episode_id TEXT NOT NULL,
      trade_id TEXT,
      primary_cause TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(episode_id) REFERENCES learning_shadow_episodes(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS learning_trade_attributions_created
      ON learning_trade_attributions(created_at DESC, id);

    CREATE TABLE IF NOT EXISTS learning_policy_challengers (
      id TEXT PRIMARY KEY,
      rank INTEGER NOT NULL,
      status TEXT NOT NULL,
      dataset_digest TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_policy_challengers_rank
      ON learning_policy_challengers(status, rank, created_at DESC);

    CREATE TABLE IF NOT EXISTS learning_walk_forward_results (
      id TEXT PRIMARY KEY,
      challenger_id TEXT NOT NULL,
      fold INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(challenger_id, fold),
      FOREIGN KEY(challenger_id) REFERENCES learning_policy_challengers(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS learning_promotion_decisions (
      id TEXT PRIMARY KEY,
      challenger_id TEXT,
      allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
      payload_json TEXT NOT NULL,
      decided_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_promotion_decisions_latest
      ON learning_promotion_decisions(decided_at DESC, id);

    CREATE TABLE IF NOT EXISTS learning_admission_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      strategy_arm TEXT NOT NULL,
      regime TEXT NOT NULL,
      allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
      decided_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS learning_admission_decisions_latest
      ON learning_admission_decisions(decided_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS learning_processed_outbox (
      outbox_id INTEGER PRIMARY KEY,
      event_key TEXT NOT NULL UNIQUE,
      processed_at TEXT NOT NULL
    );
    `);
    if (version < 2) {
      const columns = db.pragma("table_info(learning_shadow_episodes)") as Array<{ name: string }>;
      if (!columns.some((column) => column.name === "execution_tier")) {
        db.exec("ALTER TABLE learning_shadow_episodes ADD COLUMN execution_tier TEXT NOT NULL DEFAULT 'SHADOW'");
      }
      db.exec(`
        UPDATE learning_shadow_episodes
        SET execution_tier = CASE WHEN shadow_only = 1 THEN 'SHADOW' ELSE 'CHAMPION' END
      `);
    }
    if (version < 4) {
      const episodesBefore = (db.prepare(`
        SELECT COUNT(*) AS count FROM learning_shadow_episodes
      `).get() as { count: number }).count;
      // v2 added execution_tier with ALTER TABLE. SQLite appends ALTERed
      // columns, so upgraded v3 databases had a different physical column
      // order from fresh v3 databases. Rebuild the parent table into one
      // canonical v4 layout while foreign-key enforcement is temporarily off;
      // foreign_key_check below still runs before this transaction can commit.
      db.exec(`
        DROP TABLE IF EXISTS learning_shadow_episodes_v4;
        CREATE TABLE learning_shadow_episodes_v4 (
          id TEXT PRIMARY KEY,
          source_key TEXT NOT NULL UNIQUE,
          lane_id TEXT NOT NULL,
          mint TEXT NOT NULL,
          strategy_arm TEXT NOT NULL,
          regime TEXT NOT NULL,
          status TEXT NOT NULL,
          shadow_only INTEGER NOT NULL CHECK (shadow_only IN (0, 1)),
          execution_tier TEXT NOT NULL DEFAULT 'SHADOW' CHECK (execution_tier IN ('SHADOW', 'CHAMPION')),
          created_day TEXT NOT NULL,
          opened_at TEXT,
          horizon_ends_at TEXT,
          last_observed_at TEXT,
          payload_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO learning_shadow_episodes_v4(
          id, source_key, lane_id, mint, strategy_arm, regime, status,
          shadow_only, execution_tier, created_day, opened_at, horizon_ends_at,
          last_observed_at, payload_json, updated_at
        )
        SELECT
          id, source_key, lane_id, mint, strategy_arm, regime, status,
          shadow_only, execution_tier, created_day, opened_at, horizon_ends_at,
          last_observed_at, payload_json, updated_at
        FROM learning_shadow_episodes;
        DROP TABLE learning_shadow_episodes;
        ALTER TABLE learning_shadow_episodes_v4 RENAME TO learning_shadow_episodes;
        CREATE INDEX learning_shadow_episodes_work
          ON learning_shadow_episodes(status, updated_at, id);
        CREATE INDEX learning_shadow_episodes_mint_day
          ON learning_shadow_episodes(mint, created_day, id);
        CREATE INDEX learning_shadow_episodes_arm_regime
          ON learning_shadow_episodes(strategy_arm, regime, status);
      `);
      const episodesAfter = (db.prepare(`
        SELECT COUNT(*) AS count FROM learning_shadow_episodes
      `).get() as { count: number }).count;
      if (episodesAfter !== episodesBefore) {
        throw new Error("The learning schema-v4 migration did not preserve every shadow episode.");
      }
      if ((db.pragma("foreign_key_check") as unknown[]).length > 0) {
        throw new Error("The learning schema-v4 migration failed foreign-key validation.");
      }
    }
    db.pragma(`user_version = ${LEARNING_SCHEMA_VERSION}`);
    if (version < LEARNING_SCHEMA_VERSION) db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (version < LEARNING_SCHEMA_VERSION && foreignKeysWereEnabled) db.pragma("foreign_keys = ON");
  }
}

export function openLearningDatabase(databasePath?: string): LearningDatabase {
  const requested = databasePath ?? process.env.COPYLAB_LEARNING_DB_PATH ??
    resolve(process.cwd(), "data", "learning.db");
  const resolved = requested === ":memory:" ? requested : resolve(requested);
  if (resolved !== ":memory:") mkdirSync(dirname(resolved), { recursive: true });
  const db = new Database(resolved);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    migrateLearningDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export class AutonomousLearningRepository {
  constructor(readonly db: LearningDatabase) {}

  setMeta(key: string, value: unknown, at = new Date().toISOString()): void {
    this.db.prepare(`
      INSERT INTO learning_meta(key, value_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
    `).run(key, encode(value), at);
  }

  getMeta<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json AS payload_json FROM learning_meta WHERE key = ?")
      .get(key) as JsonRow | undefined;
    return decode<T>(row);
  }

  saveUniverseCycle(input: {
    sourceKey: string;
    laneId: string;
    policyVersion: string;
    capturedAt: string;
    regime: MarketRegime;
    candidateCount: number;
    payload: unknown;
  }): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO learning_universe_cycles(
        source_key, lane_id, policy_version, captured_at, regime,
        candidate_count, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.sourceKey,
      input.laneId,
      input.policyVersion,
      input.capturedAt,
      input.regime,
      input.candidateCount,
      encode(input.payload),
      new Date().toISOString()
    );
    return result.changes === 1;
  }

  upsertEpisode(episode: ShadowEpisode): void {
    this.db.prepare(`
      INSERT INTO learning_shadow_episodes(
        id, source_key, lane_id, mint, strategy_arm, regime, status,
        shadow_only, execution_tier, created_day, opened_at, horizon_ends_at,
        last_observed_at, payload_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        opened_at = excluded.opened_at,
        horizon_ends_at = excluded.horizon_ends_at,
        last_observed_at = excluded.last_observed_at,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at
    `).run(
      episode.id,
      episode.sourceKey,
      episode.laneId,
      episode.mint,
      episode.strategyArm,
      episode.regime,
      episode.status,
      episode.shadowOnly ? 1 : 0,
      episode.executionTier ?? (episode.shadowOnly ? "SHADOW" : "CHAMPION"),
      episode.createdAt.slice(0, 10),
      episode.openedAt ?? null,
      episode.horizonEndsAt ?? null,
      episode.lastObservedAt ?? null,
      encode(episode),
      episode.updatedAt
    );
  }

  getEpisode(id: string): ShadowEpisode | undefined {
    return decode<ShadowEpisode>(this.db.prepare(`
      SELECT payload_json FROM learning_shadow_episodes WHERE id = ?
    `).get(id) as JsonRow | undefined);
  }

  listEpisodes(statuses: readonly ShadowEpisode["status"][], limit = 100): ShadowEpisode[] {
    if (statuses.length === 0) return [];
    const placeholders = statuses.map(() => "?").join(", ");
    const rows = this.db.prepare(`
      SELECT payload_json FROM learning_shadow_episodes
      WHERE status IN (${placeholders})
      ORDER BY updated_at, id
      LIMIT ?
    `).all(...statuses, Math.max(1, Math.min(1_000, limit))) as JsonRow[];
    return rows.map((row) => decode<ShadowEpisode>(row)!);
  }

  countEpisodesForMintDay(mint: string, day: string, policyVersion?: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count FROM learning_shadow_episodes
      WHERE mint = ? AND created_day = ?
        AND (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
    `).get(mint, day, policyVersion ?? null, policyVersion ?? null) as { count: number };
    return row.count;
  }

  episodeMintsForDay(day: string, policyVersion: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT DISTINCT mint FROM learning_shadow_episodes
      WHERE created_day = ?
        AND json_extract(payload_json, '$.policyVersion') = ?
    `).all(day, policyVersion) as Array<{ mint: string }>;
    return new Set(rows.map((row) => row.mint));
  }

  episodeCounts(policyVersion?: string): {
    pending: number;
    active: number;
    completed: number;
    rejected: number;
    unpriced: number;
    datasetEligible: number;
  } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM learning_shadow_episodes
      WHERE (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
      GROUP BY status
    `).all(policyVersion ?? null, policyVersion ?? null) as Array<{
      status: ShadowEpisode["status"];
      count: number;
    }>;
    const byStatus = new Map(rows.map((row) => [row.status, row.count]));
    const eligible = this.db.prepare(`
      SELECT COUNT(DISTINCT episode_id) AS count
      FROM learning_outcome_labels label
      JOIN learning_shadow_episodes episode ON episode.id = label.episode_id
      WHERE label.dataset_eligible = 1 AND label.horizon_minutes = 180
        AND (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
    `).get(policyVersion ?? null, policyVersion ?? null) as { count: number };
    return {
      pending: byStatus.get("PENDING_QUOTE") ?? 0,
      active: byStatus.get("ACTIVE") ?? 0,
      completed: byStatus.get("COMPLETED") ?? 0,
      rejected: byStatus.get("REJECTED") ?? 0,
      unpriced: byStatus.get("UNPRICED") ?? 0,
      datasetEligible: eligible.count
    };
  }

  episodeCountsForArm(
    strategyArm: AutonomousPaperStrategyArm,
    policyVersion?: string
  ): {
    pending: number;
    active: number;
    completed: number;
    rejected: number;
    unpriced: number;
    datasetEligible: number;
  } {
    const rows = this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM learning_shadow_episodes
      WHERE strategy_arm = ?
        AND (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
      GROUP BY status
    `).all(strategyArm, policyVersion ?? null, policyVersion ?? null) as Array<{
      status: ShadowEpisode["status"];
      count: number;
    }>;
    const byStatus = new Map(rows.map((row) => [row.status, row.count]));
    const eligible = this.db.prepare(`
      SELECT COUNT(DISTINCT episode_id) AS count
      FROM learning_outcome_labels label
      JOIN learning_shadow_episodes episode ON episode.id = label.episode_id
      WHERE episode.strategy_arm = ?
        AND label.dataset_eligible = 1
        AND label.horizon_minutes = 180
        AND (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
    `).get(strategyArm, policyVersion ?? null, policyVersion ?? null) as { count: number };
    return {
      pending: byStatus.get("PENDING_QUOTE") ?? 0,
      active: byStatus.get("ACTIVE") ?? 0,
      completed: byStatus.get("COMPLETED") ?? 0,
      rejected: byStatus.get("REJECTED") ?? 0,
      unpriced: byStatus.get("UNPRICED") ?? 0,
      datasetEligible: eligible.count
    };
  }

  saveOutcome(label: OutcomeLabel): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO learning_outcome_labels(
        id, episode_id, horizon_minutes, dataset_eligible, observed_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      label.id,
      label.episodeId,
      label.horizonMinutes,
      label.datasetEligible ? 1 : 0,
      label.observedAt,
      encode(label)
    );
    return result.changes === 1;
  }

  savePathObservation(observation: LearningPathObservation): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO learning_path_observations(
        id, episode_id, phase, observed_at, elapsed_minutes, dataset_eligible, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.id,
      observation.episodeId,
      observation.phase,
      observation.observedAt,
      observation.elapsedMinutes,
      observation.datasetEligible ? 1 : 0,
      encode(observation)
    );
    return result.changes === 1;
  }

  pathObservations(episodeId: string): LearningPathObservation[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_path_observations
      WHERE episode_id = ? ORDER BY elapsed_minutes, observed_at, id
    `).all(episodeId) as JsonRow[]).map((row) => decode<LearningPathObservation>(row)!);
  }

  pathObservationCount(policyVersion?: string): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM learning_path_observations observation
      JOIN learning_shadow_episodes episode ON episode.id = observation.episode_id
      WHERE (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
    `).get(policyVersion ?? null, policyVersion ?? null) as { count: number };
    return row.count;
  }

  outcomeFor(episodeId: string, horizonMinutes: OutcomeLabel["horizonMinutes"]): OutcomeLabel | undefined {
    return decode<OutcomeLabel>(this.db.prepare(`
      SELECT payload_json FROM learning_outcome_labels
      WHERE episode_id = ? AND horizon_minutes = ?
    `).get(episodeId, horizonMinutes) as JsonRow | undefined);
  }

  listTrainingRows(
    horizonMinutes: OutcomeLabel["horizonMinutes"] = 180,
    policyVersion?: string
  ): Array<{
    episode: ShadowEpisode;
    label: OutcomeLabel;
  }> {
    const rows = this.db.prepare(`
      SELECT episode.payload_json AS episode_json, label.payload_json AS label_json
      FROM learning_outcome_labels label
      JOIN learning_shadow_episodes episode ON episode.id = label.episode_id
      WHERE label.dataset_eligible = 1 AND label.horizon_minutes = ?
        AND (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
      ORDER BY label.observed_at, label.episode_id
    `).all(horizonMinutes, policyVersion ?? null, policyVersion ?? null) as Array<{
      episode_json: string;
      label_json: string;
    }>;
    return rows.map((row) => ({
      episode: JSON.parse(row.episode_json) as ShadowEpisode,
      label: JSON.parse(row.label_json) as OutcomeLabel
    }));
  }

  replaceActiveModels(artifacts: readonly ModelArtifact[]): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE learning_model_artifacts SET active = 0 WHERE active = 1").run();
      const insert = this.db.prepare(`
        INSERT OR REPLACE INTO learning_model_artifacts(
          id, model_kind, training_cutoff_at, dataset_digest, active, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of artifacts) {
        insert.run(
          artifact.id,
          artifact.modelKind,
          artifact.trainingCutoffAt,
          artifact.datasetDigest,
          artifact.active ? 1 : 0,
          encode(artifact),
          artifact.createdAt
        );
      }
    })();
  }

  activeModels(): ModelArtifact[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_model_artifacts WHERE active = 1 ORDER BY model_kind
    `).all() as JsonRow[]).map((row) => decode<ModelArtifact>(row)!);
  }

  latestModelFamily(horizonMinutes: 45 | 180, policyVersion?: string): ModelArtifact[] {
    const cutoff = this.db.prepare(`
      SELECT MAX(training_cutoff_at) AS cutoff
      FROM learning_model_artifacts
      WHERE json_extract(payload_json, '$.horizonMinutes') = ?
        AND (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
    `).get(horizonMinutes, policyVersion ?? null, policyVersion ?? null) as { cutoff: string | null };
    if (!cutoff.cutoff) return [];
    return (this.db.prepare(`
      SELECT payload_json FROM learning_model_artifacts
      WHERE training_cutoff_at = ? AND json_extract(payload_json, '$.horizonMinutes') = ?
        AND (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
      ORDER BY model_kind
    `).all(cutoff.cutoff, horizonMinutes, policyVersion ?? null, policyVersion ?? null) as JsonRow[])
      .map((row) => decode<ModelArtifact>(row)!);
  }

  replaceArmScores(scores: readonly StrategyArmScore[], at: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM learning_arm_scores").run();
      const insert = this.db.prepare(`
        INSERT INTO learning_arm_scores(strategy_arm, regime, payload_json, updated_at)
        VALUES (?, ?, ?, ?)
      `);
      for (const score of scores) insert.run(score.strategyArm, score.regime, encode(score), at);
    })();
  }

  listArmScores(): StrategyArmScore[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_arm_scores ORDER BY strategy_arm, regime
    `).all() as JsonRow[]).map((row) => decode<StrategyArmScore>(row)!);
  }

  saveAttribution(attribution: TradeAttribution): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO learning_trade_attributions(
        id, episode_id, trade_id, primary_cause, payload_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      attribution.id,
      attribution.episodeId,
      attribution.tradeId ?? null,
      attribution.primaryCause,
      encode(attribution),
      attribution.createdAt
    );
  }

  recentAttributions(limit = 20, policyVersion?: string): TradeAttribution[] {
    return (this.db.prepare(`
      SELECT attribution.payload_json
      FROM learning_trade_attributions attribution
      JOIN learning_shadow_episodes episode ON episode.id = attribution.episode_id
      WHERE (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
      ORDER BY attribution.created_at DESC, attribution.id LIMIT ?
    `).all(
      policyVersion ?? null,
      policyVersion ?? null,
      Math.max(1, Math.min(200, limit))
    ) as JsonRow[])
      .map((row) => decode<TradeAttribution>(row)!);
  }

  replaceChallengers(challengers: readonly PolicyChallenger[], folds: readonly WalkForwardResult[]): void {
    this.db.transaction(() => {
      this.db.prepare("UPDATE learning_policy_challengers SET status = 'ARCHIVED' WHERE status <> 'ARCHIVED'").run();
      const insert = this.db.prepare(`
        INSERT INTO learning_policy_challengers(
          id, rank, status, dataset_digest, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          rank = excluded.rank,
          status = excluded.status,
          dataset_digest = excluded.dataset_digest,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at
      `);
      for (const challenger of challengers) {
        insert.run(
          challenger.id,
          challenger.rank,
          challenger.status,
          challenger.datasetDigest,
          encode(challenger),
          challenger.createdAt
        );
      }
      const insertFold = this.db.prepare(`
        INSERT OR REPLACE INTO learning_walk_forward_results(
          id, challenger_id, fold, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?)
      `);
      for (const fold of folds) insertFold.run(fold.id, fold.challengerId, fold.fold, encode(fold), fold.createdAt);
    })();
  }

  activeChallengers(): PolicyChallenger[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_policy_challengers
      WHERE status <> 'ARCHIVED' ORDER BY rank, id LIMIT 5
    `).all() as JsonRow[]).map((row) => decode<PolicyChallenger>(row)!);
  }

  walkForwardFor(challengerId: string): WalkForwardResult[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_walk_forward_results
      WHERE challenger_id = ? ORDER BY fold
    `).all(challengerId) as JsonRow[]).map((row) => decode<WalkForwardResult>(row)!);
  }

  savePromotion(decision: ChampionPromotionDecision): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO learning_promotion_decisions(
        id, challenger_id, allowed, payload_json, decided_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.challengerId ?? null,
      decision.allowed ? 1 : 0,
      encode(decision),
      decision.decidedAt
    );
  }

  latestPromotion(): ChampionPromotionDecision | undefined {
    return decode<ChampionPromotionDecision>(this.db.prepare(`
      SELECT payload_json FROM learning_promotion_decisions ORDER BY decided_at DESC, id LIMIT 1
    `).get() as JsonRow | undefined);
  }

  saveAdmission(decision: LearningAdmissionDecision): void {
    const previous = this.db.prepare(`
      SELECT payload_json FROM learning_admission_decisions
      WHERE strategy_arm = ? AND regime = ?
      ORDER BY decided_at DESC, id DESC LIMIT 1
    `).get(decision.strategyArm, decision.regime) as JsonRow | undefined;
    if (previous) {
      const prior = JSON.parse(previous.payload_json) as LearningAdmissionDecision;
      const { decidedAt: _priorAt, ...priorComparable } = prior;
      const { decidedAt: _nextAt, ...nextComparable } = decision;
      if (encode(priorComparable) === encode(nextComparable)) return;
    }
    this.db.prepare(`
      INSERT INTO learning_admission_decisions(
        strategy_arm, regime, allowed, decided_at, payload_json
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      decision.strategyArm,
      decision.regime,
      decision.allowed ? 1 : 0,
      decision.decidedAt,
      encode(decision)
    );
  }

  recentAdmissions(limit = 20, policyVersion?: string): LearningAdmissionDecision[] {
    return (this.db.prepare(`
      SELECT payload_json FROM learning_admission_decisions
      WHERE (? IS NULL OR json_extract(payload_json, '$.policyVersion') = ?)
      ORDER BY decided_at DESC, id DESC LIMIT ?
    `).all(
      policyVersion ?? null,
      policyVersion ?? null,
      Math.max(1, Math.min(200, limit))
    ) as JsonRow[])
      .map((row) => decode<LearningAdmissionDecision>(row)!);
  }

  eligibleLabelCountsSince(
    at?: string,
    policyVersion?: string
  ): { horizon45: number; horizon180: number } {
    const since = at ?? "0000-01-01T00:00:00.000Z";
    const rows = this.db.prepare(`
      SELECT horizon_minutes AS horizon, COUNT(*) AS count
      FROM learning_outcome_labels label
      JOIN learning_shadow_episodes episode ON episode.id = label.episode_id
      WHERE label.dataset_eligible = 1 AND label.observed_at > ?
        AND label.horizon_minutes IN (45, 180)
        AND (? IS NULL OR json_extract(episode.payload_json, '$.policyVersion') = ?)
      GROUP BY label.horizon_minutes
    `).all(since, policyVersion ?? null, policyVersion ?? null) as Array<{
      horizon: number;
      count: number;
    }>;
    return {
      horizon45: rows.find((row) => row.horizon === 45)?.count ?? 0,
      horizon180: rows.find((row) => row.horizon === 180)?.count ?? 0
    };
  }

  markOutboxProcessed(outboxId: number, eventKey: string, at: string): boolean {
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO learning_processed_outbox(outbox_id, event_key, processed_at)
      VALUES (?, ?, ?)
    `).run(outboxId, eventKey, at);
    return result.changes === 1;
  }

  hasProcessedOutbox(outboxId: number): boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM learning_processed_outbox WHERE outbox_id = ?
    `).get(outboxId));
  }

  integrityCheck(): string {
    return String(this.db.pragma("integrity_check", { simple: true }));
  }
}
