'use strict';

// 草案的创建与条款编辑操作

const { cidGen, nowIso } = require('./merge');

const CID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  e.extra = extra;
  return e;
}

function getDraftRow(db, draftId) {
  const row = db.prepare('SELECT * FROM draft WHERE id = ?').get(draftId);
  if (!row) throw httpError(404, '草案不存在');
  return row;
}

function aliveCids(db, draftId) {
  return db
    .prepare('SELECT cid FROM draft_order WHERE draft_id = ? ORDER BY position')
    .all(draftId)
    .map((r) => r.cid);
}

function baseClause(db, baseVersionId, cid) {
  return db
    .prepare('SELECT cid, title, body FROM version_clause WHERE version_id = ? AND cid = ?')
    .get(baseVersionId, cid);
}

function baseRefs(db, baseVersionId, cid) {
  return db
    .prepare('SELECT target_cid FROM version_ref WHERE version_id = ? AND source_cid = ? ORDER BY position')
    .all(baseVersionId, cid)
    .map((r) => r.target_cid);
}

// 依据与基线的差异重算既有条款状态（added/deleted 保持不变）
function recomputeStatus(db, draftId, baseVersionId, cid) {
  const row = db.prepare('SELECT status FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  if (!row || row.status === 'added' || row.status === 'deleted') return;
  const base = baseClause(db, baseVersionId, cid);
  const cur = db.prepare('SELECT title, body FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  const refsChanged = JSON.stringify(baseRefs(db, baseVersionId, cid)) !==
    JSON.stringify(
      db
        .prepare('SELECT target_cid FROM draft_ref WHERE draft_id = ? AND source_cid = ? ORDER BY position')
        .all(draftId, cid)
        .map((r) => r.target_cid)
    );
  const changed = !base || base.title !== cur.title || base.body !== cur.body || refsChanged;
  db.prepare('UPDATE draft_clause SET status = ? WHERE draft_id = ? AND cid = ?').run(
    changed ? 'edited' : 'unchanged',
    draftId,
    cid
  );
}

// 把 draft_order 压缩为连续位置
function compactOrder(db, draftId) {
  const cids = aliveCids(db, draftId);
  db.prepare('DELETE FROM draft_order WHERE draft_id = ?').run(draftId);
  const ins = db.prepare('INSERT INTO draft_order (draft_id, position, cid) VALUES (?, ?, ?)');
  cids.forEach((cid, i) => ins.run(draftId, i, cid));
}

// 显式移动后重算“移位”标记：与基线存活条款的自然顺序一致则视为已还原
function recomputeMoveFlag(db, draftId, baseVersionId, cid) {
  const row = db.prepare('SELECT status FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  if (!row || row.status === 'added' || row.status === 'deleted') {
    db.prepare('DELETE FROM draft_move WHERE draft_id = ? AND cid = ?').run(draftId, cid);
    return;
  }
  const current = aliveCids(db, draftId);
  const natural = db
    .prepare(
      `SELECT cid FROM version_clause WHERE version_id = ? AND cid IN
         (SELECT cid FROM draft_order WHERE draft_id = ?) ORDER BY position`
    )
    .all(baseVersionId, draftId)
    .map((r) => r.cid);
  const moved = current.indexOf(cid) !== natural.indexOf(cid);
  if (moved) {
    db.prepare('INSERT OR IGNORE INTO draft_move (draft_id, cid) VALUES (?, ?)').run(draftId, cid);
  } else {
    db.prepare('DELETE FROM draft_move WHERE draft_id = ? AND cid = ?').run(draftId, cid);
  }
}

function createDraft(db, { name, baseVersionId } = {}) {
  const latest = db.prepare('SELECT id FROM version ORDER BY number DESC LIMIT 1').get();
  if (!latest) throw httpError(409, '尚未发布任何版本，请先录入首版章程');
  const baseId = baseVersionId ? Number(baseVersionId) : latest.id;
  const base = db.prepare('SELECT id, number FROM version WHERE id = ?').get(baseId);
  if (!base) throw httpError(404, '基线版本不存在');
  const draftName = (name || '').trim() || `基于 v${base.number} 的草案`;

  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO draft (name, base_version_id, created_at) VALUES (?, ?, ?)')
      .run(draftName, baseId, nowIso());
    const draftId = info.lastInsertRowid;
    const clauses = db
      .prepare('SELECT cid, title, body FROM version_clause WHERE version_id = ? ORDER BY position')
      .all(baseId);
    const insC = db.prepare(
      "INSERT INTO draft_clause (draft_id, cid, title, body, status) VALUES (?, ?, ?, ?, 'unchanged')"
    );
    const insO = db.prepare('INSERT INTO draft_order (draft_id, position, cid) VALUES (?, ?, ?)');
    const insR = db.prepare(
      'INSERT INTO draft_ref (draft_id, source_cid, target_cid, position) VALUES (?, ?, ?, ?)'
    );
    clauses.forEach((c, i) => {
      insC.run(draftId, c.cid, c.title, c.body);
      insO.run(draftId, i, c.cid);
      db.prepare(
        'SELECT target_cid FROM version_ref WHERE version_id = ? AND source_cid = ? ORDER BY position'
      )
        .all(baseId, c.cid)
        .forEach((r, j) => insR.run(draftId, c.cid, r.target_cid, j));
    });
    return draftId;
  });
  return tx();
}

function addClause(db, draftId, { cid, title, body, refs = [], afterCid } = {}) {
  const draft = getDraftRow(db, draftId);
  const finalCid = (cid || cidGen()).trim();
  if (!CID_RE.test(finalCid)) throw httpError(400, '条款标识只能包含字母、数字、下划线或连字符（1-64 位）');
  if (db.prepare('SELECT 1 FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, finalCid)) {
    throw httpError(409, `条款标识 ${finalCid} 已存在`);
  }
  const t = (title || '').trim();
  const b = (body || '').trim();
  if (!t) throw httpError(400, '条款标题不能为空');
  if (!b) throw httpError(400, '条款正文不能为空');
  const targetRefs = normalizeRefs(finalCid, refs);

  const tx = db.transaction(() => {
    db.prepare(
      "INSERT INTO draft_clause (draft_id, cid, title, body, status) VALUES (?, ?, ?, ?, 'added')"
    ).run(draftId, finalCid, t, b);
    const order = aliveCids(db, draftId);
    let idx = order.length;
    if (afterCid !== undefined && afterCid !== null && afterCid !== '') {
      idx = order.indexOf(afterCid);
      if (idx < 0) throw httpError(400, '锚点条款不存在');
      idx += 1;
    }
    order.splice(idx, 0, finalCid);
    // 整体重排（先删后插，避免与 (draft_id, position) 唯一约束冲突）
    db.prepare('DELETE FROM draft_order WHERE draft_id = ?').run(draftId);
    const insO = db.prepare('INSERT INTO draft_order (draft_id, position, cid) VALUES (?, ?, ?)');
    order.forEach((c, i) => insO.run(draftId, i, c));
    const insR = db.prepare(
      'INSERT INTO draft_ref (draft_id, source_cid, target_cid, position) VALUES (?, ?, ?, ?)'
    );
    targetRefs.forEach((r, j) => insR.run(draftId, finalCid, r, j));
  });
  tx();
  return finalCid;
}

function editClause(db, draftId, cid, { title, body } = {}) {
  const draft = getDraftRow(db, draftId);
  const row = db.prepare('SELECT status FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  if (!row) throw httpError(404, '条款不存在');
  if (row.status === 'deleted') throw httpError(409, '该条款已被删除，无法编辑');
  const t = title === undefined ? undefined : String(title).trim();
  const b = body === undefined ? undefined : String(body).trim();
  if (t === '') throw httpError(400, '条款标题不能为空');
  if (b === '') throw httpError(400, '条款正文不能为空');
  db.prepare(
    'UPDATE draft_clause SET title = COALESCE(?, title), body = COALESCE(?, body) WHERE draft_id = ? AND cid = ?'
  ).run(t === undefined ? null : t, b === undefined ? null : b, draftId, cid);
  recomputeStatus(db, draftId, draft.base_version_id, cid);
}

function setRefs(db, draftId, cid, refs) {
  const draft = getDraftRow(db, draftId);
  const row = db.prepare('SELECT status FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  if (!row) throw httpError(404, '条款不存在');
  if (row.status === 'deleted') throw httpError(409, '该条款已被删除，无法编辑引用');
  const targetRefs = normalizeRefs(cid, refs);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM draft_ref WHERE draft_id = ? AND source_cid = ?').run(draftId, cid);
    const ins = db.prepare(
      'INSERT INTO draft_ref (draft_id, source_cid, target_cid, position) VALUES (?, ?, ?, ?)'
    );
    targetRefs.forEach((t, i) => ins.run(draftId, cid, t, i));
    recomputeStatus(db, draftId, draft.base_version_id, cid);
  });
  tx();
}

function normalizeRefs(sourceCid, refs) {
  if (!Array.isArray(refs)) throw httpError(400, 'refs 必须是条款标识数组');
  const out = [];
  const seen = new Set();
  for (const raw of refs) {
    const t = String(raw).trim();
    if (!t) continue;
    if (!CID_RE.test(t)) throw httpError(400, `非法的引用目标标识：${t}`);
    if (t === sourceCid) continue; // 自引用无意义，静默忽略
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function deleteClause(db, draftId, cid) {
  const draft = getDraftRow(db, draftId);
  const row = db.prepare('SELECT status FROM draft_clause WHERE draft_id = ? AND cid = ?').get(draftId, cid);
  if (!row) throw httpError(404, '条款不存在');
  if (row.status === 'deleted') throw httpError(409, '条款已处于删除状态');

  const tx = db.transaction(() => {
    if (row.status === 'added') {
      // 草案内新增、尚未发布：彻底移除
      db.prepare('DELETE FROM draft_clause WHERE draft_id = ? AND cid = ?').run(draftId, cid);
      db.prepare('DELETE FROM draft_move WHERE draft_id = ? AND cid = ?').run(draftId, cid);
    } else {
      db.prepare("UPDATE draft_clause SET status = 'deleted' WHERE draft_id = ? AND cid = ?").run(draftId, cid);
      db.prepare('DELETE FROM draft_move WHERE draft_id = ? AND cid = ?').run(draftId, cid);
    }
    db.prepare('DELETE FROM draft_order WHERE draft_id = ? AND cid = ?').run(draftId, cid);
    db.prepare('DELETE FROM draft_ref WHERE draft_id = ? AND source_cid = ?').run(draftId, cid);
    compactOrder(db, draftId);
    // 其他条款的位置参照可能变化，刷新各自的移位标记
    for (const c of aliveCids(db, draftId)) {
      recomputeMoveFlag(db, draftId, draft.base_version_id, c);
    }
  });
  tx();
}

// 移动到 0 基绝对位置；也支持 afterCid（null/'' 表示移到最前）
function moveClause(db, draftId, cid, { position, afterCid } = {}) {
  const draft = getDraftRow(db, draftId);
  if (!db.prepare('SELECT 1 FROM draft_order WHERE draft_id = ? AND cid = ?').get(draftId, cid)) {
    throw httpError(404, '条款不存在或已删除');
  }
  const tx = db.transaction(() => {
    const order = aliveCids(db, draftId);
    const from = order.indexOf(cid);
    order.splice(from, 1);
    let to;
    if (afterCid !== undefined) {
      if (afterCid === null || afterCid === '') {
        to = 0;
      } else {
        const anchor = order.indexOf(afterCid);
        if (anchor < 0) throw httpError(400, '锚点条款不存在或已删除');
        to = anchor + 1;
      }
    } else {
      to = Number(position);
      if (!Number.isInteger(to) || to < 0 || to > order.length) {
        throw httpError(400, '目标位置超出范围');
      }
    }
    order.splice(to, 0, cid);
    db.prepare('DELETE FROM draft_order WHERE draft_id = ?').run(draftId);
    const insO = db.prepare('INSERT INTO draft_order (draft_id, position, cid) VALUES (?, ?, ?)');
    order.forEach((c, i) => insO.run(draftId, i, c));
    recomputeMoveFlag(db, draftId, draft.base_version_id, cid);
  });
  tx();
}

// 首版章程发布（仅允许在尚无任何版本时调用）
function initializeFirstVersion(db, { note, clauses } = {}) {
  const exists = db.prepare('SELECT 1 FROM version LIMIT 1').get();
  if (exists) throw httpError(409, '首版已存在，请通过草案进行后续修订');
  if (!Array.isArray(clauses) || clauses.length === 0) {
    throw httpError(400, '请至少录入一个条款');
  }
  const seen = new Set();
  const prepared = [];
  clauses.forEach((c, i) => {
    const cid = (c.cid || cidGen()).trim();
    if (!CID_RE.test(cid)) throw httpError(400, `第 ${i + 1} 条标识非法：${cid}`);
    if (seen.has(cid)) throw httpError(400, `条款标识重复：${cid}`);
    seen.add(cid);
    const title = String(c.title || '').trim();
    const body = String(c.body || '').trim();
    if (!title) throw httpError(400, `第 ${i + 1} 条标题不能为空`);
    if (!body) throw httpError(400, `第 ${i + 1} 条正文不能为空`);
    prepared.push({ cid, title, body, refs: normalizeRefs(cid, c.refs || []) });
  });
  for (const c of prepared) {
    for (const t of c.refs) {
      if (!seen.has(t)) throw httpError(400, `条款 ${c.cid} 引用了不存在的条款 ${t}，首版不允许悬空引用`);
    }
  }

  const tx = db.transaction(() => {
    const createdAt = nowIso();
    const info = db
      .prepare('INSERT INTO version (number, title, note, created_at) VALUES (1, ?, ?, ?)')
      .run('章程 v1', (note || '').trim() || '首版发布', createdAt);
    const vid = info.lastInsertRowid;
    const insC = db.prepare(
      'INSERT INTO version_clause (version_id, cid, title, body, position) VALUES (?, ?, ?, ?, ?)'
    );
    const insR = db.prepare(
      'INSERT INTO version_ref (version_id, source_cid, target_cid, position) VALUES (?, ?, ?, ?)'
    );
    prepared.forEach((c, i) => {
      insC.run(vid, c.cid, c.title, c.body, i);
      c.refs.forEach((t, j) => insR.run(vid, c.cid, t, j));
    });
    return vid;
  });
  return tx();
}

module.exports = {
  createDraft,
  addClause,
  editClause,
  setRefs,
  deleteClause,
  moveClause,
  initializeFirstVersion,
  httpError,
};
