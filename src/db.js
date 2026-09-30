'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const SCHEMA = `
PRAGMA foreign_keys = ON;

-- 已发布版本（不可变）
CREATE TABLE IF NOT EXISTS version (
  id         INTEGER PRIMARY KEY,
  number     INTEGER NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

-- 某版本下的条款快照，cid 为跨版本稳定标识
CREATE TABLE IF NOT EXISTS version_clause (
  version_id INTEGER NOT NULL REFERENCES version(id),
  cid        TEXT NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (version_id, cid)
);

-- 某版本下的引用快照（source -> target）
CREATE TABLE IF NOT EXISTS version_ref (
  version_id INTEGER NOT NULL REFERENCES version(id),
  source_cid TEXT NOT NULL,
  target_cid TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (version_id, source_cid, target_cid)
);

-- 相对上一版本发生显式移位的既有条款（用于并行变更检测）
CREATE TABLE IF NOT EXISTS version_move (
  version_id INTEGER NOT NULL REFERENCES version(id),
  cid        TEXT NOT NULL,
  anchor_cid TEXT,
  PRIMARY KEY (version_id, cid)
);

-- 草案：基于某个已发布版本创建
CREATE TABLE IF NOT EXISTS draft (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  base_version_id INTEGER NOT NULL REFERENCES version(id),
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS draft_clause (
  draft_id INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  cid      TEXT NOT NULL,
  title    TEXT NOT NULL,
  body     TEXT NOT NULL,
  status   TEXT NOT NULL CHECK (status IN ('unchanged','edited','added','deleted')),
  PRIMARY KEY (draft_id, cid)
);

-- 草案中存活条款的顺序（被删除条款不在此表中）
CREATE TABLE IF NOT EXISTS draft_order (
  draft_id INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  cid      TEXT NOT NULL,
  PRIMARY KEY (draft_id, position)
);

-- 显式移位标记：仅记录“既有条款被有意移动/还原”，
-- 不因其他条款的增删而误判为移位。anchor 以发布时的 draft_order 为准。
CREATE TABLE IF NOT EXISTS draft_move (
  draft_id INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  cid      TEXT NOT NULL,
  PRIMARY KEY (draft_id, cid)
);

CREATE TABLE IF NOT EXISTS draft_ref (
  draft_id   INTEGER NOT NULL REFERENCES draft(id) ON DELETE CASCADE,
  source_cid TEXT NOT NULL,
  target_cid TEXT NOT NULL,
  position   INTEGER NOT NULL,
  PRIMARY KEY (draft_id, source_cid, target_cid)
);

-- 已发布版本一经生成即不可变
CREATE TRIGGER IF NOT EXISTS trg_version_no_update BEFORE UPDATE ON version BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_version_no_delete BEFORE DELETE ON version BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vclause_no_update BEFORE UPDATE ON version_clause BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vclause_no_delete BEFORE DELETE ON version_clause BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vref_no_update BEFORE UPDATE ON version_ref BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vref_no_delete BEFORE DELETE ON version_ref BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vmove_no_update BEFORE UPDATE ON version_move BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;
CREATE TRIGGER IF NOT EXISTS trg_vmove_no_delete BEFORE DELETE ON version_move BEGIN
  SELECT RAISE(ABORT, 'published versions are immutable');
END;

CREATE INDEX IF NOT EXISTS idx_draft_clause ON draft_clause(draft_id);
CREATE INDEX IF NOT EXISTS idx_draft_ref    ON draft_ref(draft_id);
CREATE INDEX IF NOT EXISTS idx_vclause_vid  ON version_clause(version_id);
CREATE INDEX IF NOT EXISTS idx_vref_vid     ON version_ref(version_id);
`;

function open(dbPath) {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

module.exports = { open };
