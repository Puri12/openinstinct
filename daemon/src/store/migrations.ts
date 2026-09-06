export interface Migration {
  readonly version: number;
  readonly sql: string;
  /** Table rebuilds require foreign-key enforcement to be paused before BEGIN. */
  readonly requiresForeignKeysDisabled?: boolean;
}

export const LATEST_SCHEMA_VERSION = 8;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested', 'admitted', 'running', 'completed', 'failed', 'timed_out', 'canceled')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool', 'daemon')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0)
      );

      CREATE TABLE deliveries (
        id TEXT PRIMARY KEY,
        child_id TEXT REFERENCES children(id),
        state TEXT NOT NULL CHECK (state IN ('pending', 'inflight', 'confirmed', 'failed_ambiguous', 'expired')),
        idempotency_key TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitors (
        id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
        spec_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE monitor_events (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitors(id),
        stage TEXT NOT NULL CHECK (stage IN ('admitted', 'batched', 'session_selected', 'authored', 'memory_queued', 'delivered', 'reconciled', 'failed', 'failed_no_retry')),
        lease_owner TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        state TEXT NOT NULL CHECK (state IN ('persisted', 'delivered')),
        idempotency_key TEXT NOT NULL UNIQUE,
        projection TEXT NOT NULL,
        artifact_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    sql: `
      ALTER TABLE deliveries ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'text'
        CHECK (delivery_kind IN ('text', 'file'));
      ALTER TABLE deliveries ADD COLUMN handle TEXT NOT NULL DEFAULT '';
      ALTER TABLE deliveries ADD COLUMN body TEXT;
      ALTER TABLE deliveries ADD COLUMN file_path TEXT;
      ALTER TABLE deliveries ADD COLUMN reply_to_guid TEXT;
      ALTER TABLE deliveries ADD COLUMN quoted_text TEXT;
      ALTER TABLE deliveries ADD COLUMN degraded INTEGER NOT NULL DEFAULT 0 CHECK (degraded IN (0, 1));
      ALTER TABLE deliveries ADD COLUMN redelivered INTEGER NOT NULL DEFAULT 0 CHECK (redelivered IN (0, 1));
      ALTER TABLE deliveries ADD COLUMN inflight_at TEXT;
      ALTER TABLE deliveries ADD COLUMN confirmed_at TEXT;
      ALTER TABLE deliveries ADD COLUMN external_message_id TEXT;
      ALTER TABLE deliveries ADD COLUMN thread_id TEXT;
      ALTER TABLE deliveries ADD COLUMN last_error_code TEXT;
      ALTER TABLE deliveries ADD COLUMN last_error_message TEXT;
      CREATE INDEX deliveries_due_idx ON deliveries (state, next_attempt_at, created_at);
    `,
  },
  {
    version: 3,
    sql: `
      ALTER TABLE children ADD COLUMN title TEXT NOT NULL DEFAULT '';
      ALTER TABLE children ADD COLUMN prompt TEXT NOT NULL DEFAULT '';
      ALTER TABLE children ADD COLUMN journal_path TEXT;
      ALTER TABLE children ADD COLUMN terminal_checksum TEXT;
      ALTER TABLE children ADD COLUMN terminal_summary TEXT;
      ALTER TABLE children ADD COLUMN error_code TEXT;
      ALTER TABLE children ADD COLUMN session_file TEXT;
      CREATE INDEX children_state_idx ON children (state, created_at);
      CREATE INDEX receipts_state_idx ON receipts (state, created_at);
    `,
  },
  {
    version: 4,
    requiresForeignKeysDisabled: true,
    sql: `
      CREATE TABLE children_v4 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested', 'admitted', 'running', 'completed', 'failed', 'timeout', 'cancelled', 'orphaned')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool', 'daemon')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
        title TEXT NOT NULL DEFAULT '',
        prompt TEXT NOT NULL DEFAULT '',
        journal_path TEXT,
        terminal_checksum TEXT,
        terminal_summary TEXT,
        error_code TEXT,
        session_file TEXT,
        priority TEXT NOT NULL DEFAULT 'conversational' CHECK (priority IN ('conversational', 'monitor'))
      );
      INSERT INTO children_v4 (
        id, state, kind, created_at, updated_at, terminal_at, timeout_ms,
        title, prompt, journal_path, terminal_checksum, terminal_summary, error_code, session_file, priority
      ) SELECT
        id,
        CASE state
          WHEN 'timed_out' THEN 'timeout'
          WHEN 'canceled' THEN 'cancelled'
          ELSE state
        END,
        kind, created_at, updated_at, terminal_at, timeout_ms,
        title, prompt, journal_path, terminal_checksum, terminal_summary, error_code, session_file, 'conversational'
      FROM children;
      DROP TABLE children;
      ALTER TABLE children_v4 RENAME TO children;
      ALTER TABLE receipts ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
      CREATE INDEX children_state_idx ON children (state, priority, created_at);
      CREATE UNIQUE INDEX receipts_child_content_hash_idx
        ON receipts (child_id, content_hash) WHERE content_hash <> '';
    `,
  },
  {
    version: 5,
    requiresForeignKeysDisabled: true,
    sql: `
      ALTER TABLE monitors ADD COLUMN last_fired_at TEXT;
      CREATE TABLE monitor_events_v5 (
        id TEXT PRIMARY KEY,
        monitor_id TEXT NOT NULL REFERENCES monitors(id),
        stage TEXT NOT NULL CHECK (stage IN ('admitted', 'batched', 'dispatched', 'authored', 'delivered', 'failed')),
        idempotency_key TEXT NOT NULL UNIQUE,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        burst_key TEXT NOT NULL,
        catch_up INTEGER NOT NULL DEFAULT 0 CHECK (catch_up IN (0, 1)),
        child_id TEXT REFERENCES children(id),
        delivery_id TEXT REFERENCES deliveries(id),
        delivery_intent_key TEXT,
        lease_owner TEXT,
        lease_id TEXT,
        lease_expires_at TEXT,
        epoch INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
        last_error_code TEXT,
        last_error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO monitor_events_v5 (
        id, monitor_id, stage, idempotency_key, event_type, payload_json, burst_key, catch_up,
        lease_owner, lease_id, lease_expires_at, epoch, attempts, created_at, updated_at
      ) SELECT
        id,
        monitor_id,
        CASE stage
          WHEN 'delivered' THEN 'delivered'
          WHEN 'reconciled' THEN 'delivered'
          WHEN 'failed' THEN 'failed'
          WHEN 'failed_no_retry' THEN 'failed'
          WHEN 'authored' THEN 'authored'
          WHEN 'memory_queued' THEN 'authored'
          WHEN 'session_selected' THEN 'batched'
          WHEN 'batched' THEN 'batched'
          ELSE 'admitted'
        END,
        'legacy:' || id,
        'legacy',
        '{}',
        id,
        0,
        lease_owner,
        lease_id,
        lease_expires_at,
        epoch,
        CASE WHEN attempts > 3 THEN 3 ELSE attempts END,
        created_at,
        updated_at
      FROM monitor_events;
      DROP TABLE monitor_events;
      ALTER TABLE monitor_events_v5 RENAME TO monitor_events;
      CREATE INDEX monitor_events_claimable_idx
        ON monitor_events (stage, lease_expires_at, attempts, created_at);
      CREATE INDEX monitor_events_child_idx ON monitor_events (child_id);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE memory_intents (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('capture', 'maintenance')),
        payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'written', 'committed', 'receipted', 'quarantined')),
        commit_hash TEXT,
        quarantine_reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX memory_intents_state_idx ON memory_intents (state, created_at);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE children ADD COLUMN started_at TEXT;
      ALTER TABLE children ADD COLUMN tokens INTEGER;
      ALTER TABLE children ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 8,
    requiresForeignKeysDisabled: true,
    sql: `
      CREATE TABLE children_v8 (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('requested','admitted','running','idle','cold','completed','failed','timeout','cancelled','orphaned','terminated')),
        kind TEXT NOT NULL CHECK (kind IN ('task_tool','daemon')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, terminal_at TEXT,
        timeout_ms INTEGER NOT NULL CHECK (timeout_ms > 0),
        title TEXT NOT NULL DEFAULT '', prompt TEXT NOT NULL DEFAULT '',
        journal_path TEXT, terminal_checksum TEXT, terminal_summary TEXT, error_code TEXT, session_file TEXT,
        priority TEXT NOT NULL DEFAULT 'conversational' CHECK (priority IN ('conversational','monitor')),
        started_at TEXT, tokens INTEGER, tool_calls INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL DEFAULT 'owner' CHECK (origin IN ('owner','monitor','memory')),
        last_activity_at TEXT, last_assistant_text TEXT,
        turn_seq INTEGER NOT NULL DEFAULT 0,
        interim_omitted INTEGER NOT NULL DEFAULT 0 CHECK (interim_omitted >= 0)
      );
      INSERT INTO children_v8 (id, state, kind, created_at, updated_at, terminal_at, timeout_ms, title, prompt, journal_path,
        terminal_checksum, terminal_summary, error_code, session_file, priority, started_at, tokens, tool_calls, origin)
      SELECT id, state, kind, created_at, updated_at, terminal_at, timeout_ms, title, prompt, journal_path,
        terminal_checksum, terminal_summary, error_code, session_file, priority, started_at, tokens, tool_calls,
        CASE WHEN kind = 'daemon' AND title = 'Memory canonicalization' THEN 'memory'
             WHEN kind = 'daemon' THEN 'monitor' ELSE 'owner' END
      FROM children;
      DROP TABLE children;
      ALTER TABLE children_v8 RENAME TO children;
      CREATE INDEX children_state_idx ON children (state, priority, created_at);
      CREATE INDEX children_live_idx ON children (state, last_activity_at);
      CREATE TABLE child_interim_batches (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('assigned','injected','delivered')),
        mode TEXT CHECK (mode IN ('steer','turn')),
        attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
        prompt TEXT NOT NULL,
        omitted_json TEXT NOT NULL DEFAULT '{}',
        owner_turn_id TEXT,
        delivery_id TEXT REFERENCES deliveries(id),
        outcome TEXT CHECK (outcome IN ('owner_text','silent','reply_lost')),
        created_at TEXT NOT NULL, injected_at TEXT, delivered_at TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE child_interim_messages (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL REFERENCES children(id),
        idempotency_key TEXT NOT NULL UNIQUE,
        body TEXT NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0 CHECK (truncated IN (0, 1)),
        batch_id TEXT REFERENCES child_interim_batches(id),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX child_interim_unbatched_idx ON child_interim_messages (batch_id, created_at);
      CREATE INDEX child_interim_batches_state_idx ON child_interim_batches (state, created_at);
    `,
  },
];
