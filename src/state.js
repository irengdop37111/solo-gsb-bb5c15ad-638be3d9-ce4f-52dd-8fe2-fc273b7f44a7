'use strict';

// 版本 / 草案状态加载与快照构造

function loadVersion(db, id) {
  const meta = db.prepare('SELECT id, number, title, note, created_at FROM version WHERE id = ?').get(id);
  if (!meta) return null;
  const rows = db.prepare(
    'SELECT cid, title, body, position FROM version_clause WHERE version_id = ?'
  ).all(id);
  rows.sort((a, b) => a.position - b.position);
  const refRows = db.prepare(
    'SELECT source_cid, target_cid, position FROM version_ref WHERE version_id = ?'
  ).all(id);
  const moves = new Set(
    db.prepare('SELECT cid FROM version_move WHERE version_id = ?').all(id).map((r) => r.cid)
  );
  const refsBySource = new Map();
  for (const r of refRows) {
    if (!refsBySource.has(r.source_cid)) refsBySource.set(r.source_cid, []);
    refsBySource.get(r.source_cid).push(r);
  }
  const clauses = rows.map((r) => {
    const list = (refsBySource.get(r.cid) || []).sort((a, b) => a.position - b.position);
    return {
      cid: r.cid,
      title: r.title,
      body: r.body,
      moved: moves.has(r.cid),
      refs: list.map((x) => x.target_cid),
    };
  });
  const cids = new Set(clauses.map((c) => c.cid));
  for (const c of clauses) {
    c.danglingRefs = c.refs.filter((t) => !cids.has(t));
  }
  return { ...meta, clauses };
}

function latestVersion(db) {
  const row = db.prepare('SELECT id FROM version ORDER BY number DESC LIMIT 1').get();
  return row ? loadVersion(db, row.id) : null;
}

function listVersions(db) {
  return db
    .prepare('SELECT id, number, title, note, created_at FROM version ORDER BY number DESC')
    .all();
}

// 把草案物化成一份有序的条款视图
function draftSnapshot(db, draftId) {
  const meta = db
    .prepare(
      `SELECT d.id, d.name, d.base_version_id, d.created_at, v.number AS base_number
       FROM draft d JOIN version v ON v.id = d.base_version_id
       WHERE d.id = ?`
    )
    .get(draftId);
  if (!meta) return null;

  const cRows = db.prepare('SELECT cid, title, body, status FROM draft_clause WHERE draft_id = ?').all(draftId);
  const oRows = db.prepare('SELECT cid, position FROM draft_order WHERE draft_id = ?').all(draftId);
  const posByCid = new Map(oRows.map((r) => [r.cid, r.position]));
  const moves = new Set(
    db.prepare('SELECT cid FROM draft_move WHERE draft_id = ?').all(draftId).map((r) => r.cid)
  );
  const rRows = db.prepare(
    'SELECT source_cid, target_cid, position FROM draft_ref WHERE draft_id = ?'
  ).all(draftId);
  const refsBySource = new Map();
  for (const r of rRows) {
    if (!refsBySource.has(r.source_cid)) refsBySource.set(r.source_cid, []);
    refsBySource.get(r.source_cid).push(r);
  }

  const byCid = new Map(cRows.map((r) => [r.cid, r]));
  const clauses = oRows
    .sort((a, b) => a.position - b.position)
    .map((o) => {
      const row = byCid.get(o.cid);
      const list = (refsBySource.get(o.cid) || []).sort((a, b) => a.position - b.position);
      return {
        cid: row.cid,
        title: row.title,
        body: row.body,
        status: row.status,
        moved: moves.has(row.cid),
        refs: list.map((x) => x.target_cid),
      };
    });

  // 防御性：若有标记删除但仍残留在顺序表（正常不会发生），不纳入活条款
  const alive = new Set(clauses.map((c) => c.cid));
  const danglingByCid = new Map();
  for (const c of clauses) {
    const dangling = c.refs.filter((t) => !alive.has(t));
    danglingByCid.set(c.cid, dangling);
  }
  for (const c of clauses) c.danglingRefs = danglingByCid.get(c.cid);

  const deleted = cRows.filter((r) => r.status === 'deleted').map((r) => ({ cid: r.cid, title: r.title, body: r.body }));
  const hasDanglingRef = clauses.some((c) => c.danglingRefs.length > 0);

  return { ...meta, clauses, deleted, hasDanglingRef };
}

function listDrafts(db) {
  const rows = db
    .prepare(
      `SELECT d.id, d.name, d.base_version_id, v.number AS base_number, d.created_at,
              (SELECT COUNT(*) FROM draft_clause dc WHERE dc.draft_id = d.id AND dc.status != 'unchanged') AS changes
       FROM draft d JOIN version v ON v.id = d.base_version_id
       ORDER BY d.id`
    )
    .all();
  for (const r of rows) {
    const drefs = db
      .prepare(
        `SELECT COUNT(*) AS n FROM draft_ref dr
         WHERE dr.draft_id = ?
           AND dr.target_cid NOT IN (SELECT cid FROM draft_order WHERE draft_id = ?)`
      )
      .get(r.id, r.id);
    r.danglingRefs = drefs.n;
  }
  return rows;
}

module.exports = { loadVersion, latestVersion, listVersions, draftSnapshot, listDrafts };
