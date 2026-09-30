'use strict';

// 并行草案重放 / 冲突检测 / 原子发布
//
// 规则：
//  - 草案基于 base 版本创建；发布时若已有更新版本 latest，则把草案改动
//    重放到 latest 之上。
//  - 双方改动的条款集合不相交时允许重放；同一条款被双方改动 => 拒绝。
//  - 重放后出现悬空引用 => 拒绝。
//  - 发布在单事务中原子生成不可变新版本，成功后删除草案。

function nowIso() {
  return new Date().toISOString();
}

function cidGen() {
  return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function refsOf(clause) {
  return clause.refs || [];
}

// 计算草案相对基线的改动标签：added / deleted / edited / moved
function draftChangeTags(base, snap) {
  const tags = new Map(); // cid -> Set
  const baseCids = new Set(base.clauses.map((c) => c.cid));
  const flag = (cid, tag) => {
    if (!tags.has(cid)) tags.set(cid, new Set());
    tags.get(cid).add(tag);
  };
  for (const c of snap.clauses) {
    if (!baseCids.has(c.cid)) {
      flag(c.cid, 'added');
      continue;
    }
    if (c.status === 'edited') flag(c.cid, 'edited');
    if (c.moved) flag(c.cid, 'moved');
  }
  for (const c of snap.deleted) flag(c.cid, 'deleted');
  return tags;
}

// 计算 latest 相对 base 的改动标签（即并行期间“另一方”已发布的改动）
function historyChangeTags(base, latest) {
  const tags = new Map();
  const flag = (cid, tag) => {
    if (!tags.has(cid)) tags.set(cid, new Set());
    tags.get(cid).add(tag);
  };
  const baseMap = new Map(base.clauses.map((c) => [c.cid, c]));
  const latestMap = new Map(latest.clauses.map((c) => [c.cid, c]));
  for (const c of latest.clauses) {
    const old = baseMap.get(c.cid);
    if (!old) {
      flag(c.cid, 'added');
      continue;
    }
    if (old.title !== c.title || old.body !== c.body || JSON.stringify(old.refs) !== JSON.stringify(c.refs)) {
      flag(c.cid, 'edited');
    }
    if (c.moved) flag(c.cid, 'moved');
  }
  for (const cid of baseMap.keys()) {
    if (!latestMap.has(cid)) flag(cid, 'deleted');
  }
  return tags;
}

const TAG_LABEL = {
  added: '新增',
  deleted: '删除',
  edited: '编辑正文/引用',
  moved: '移动位置',
};

function tagLabels(tags) {
  return [...tags].map((t) => TAG_LABEL[t]).join('、');
}

// 按草案的锚点意图，把“移动/新增”的条款重放进 latest 的顺序
function replayOrder(latestCids, deletedDraft, snap) {
  const movers = new Set();
  for (const c of snap.clauses) {
    if (c.status === 'added' || c.moved) movers.add(c.cid);
  }
  const deleted = new Set(deletedDraft);

  // 先取 latest 顺序，去掉本草案删除的，再抽出待重定位的 mover
  let base = latestCids.filter((cid) => !deleted.has(cid) && !movers.has(cid));
  const aliveDraft = new Set(snap.clauses.map((c) => c.cid));

  // 按草案顺序找出每个连续 mover 段及其前后锚点
  const order = snap.clauses.map((c) => c.cid);
  const runs = [];
  let i = 0;
  while (i < order.length) {
    if (!movers.has(order[i])) {
      i += 1;
      continue;
    }
    const run = [];
    while (i < order.length && movers.has(order[i])) {
      run.push(order[i]);
      i += 1;
    }
    let before = null;
    for (let j = i - run.length - 1; j >= 0; j--) {
      if (!movers.has(order[j]) && aliveDraft.has(order[j]) && !deleted.has(order[j]) && base.includes(order[j])) {
        before = order[j];
        break;
      }
    }
    let after = null;
    for (let j = i; j < order.length; j++) {
      if (!movers.has(order[j]) && aliveDraft.has(order[j]) && !deleted.has(order[j]) && base.includes(order[j])) {
        after = order[j];
        break;
      }
    }
    runs.push({ run, before, after });
  }

  const merged = [...base];
  for (const { run, before, after } of runs) {
    let idx;
    if (before) {
      idx = merged.indexOf(before);
      merged.splice(idx + 1, 0, ...run);
    } else if (after) {
      idx = merged.indexOf(after);
      merged.splice(idx, 0, ...run);
    } else {
      merged.push(...run);
    }
  }
  return merged;
}

/**
 * 试算发布：返回 { ok, conflicts, version? }
 * 不写库。
 */
function planPublish(db, state, draftId) {
  const snap = state.draftSnapshot(db, draftId);
  if (!snap) return { ok: false, conflicts: [{ kind: 'missing', message: '草案不存在' }] };
  const base = state.loadVersion(db, snap.base_version_id);
  const latest = state.latestVersion(db);

  const mine = draftChangeTags(base, snap);
  const conflicts = [];

  // 1) 草案自身残留的悬空引用（暂存允许，发布禁止）
  for (const c of snap.clauses) {
    for (const t of c.danglingRefs) {
      conflicts.push({
        kind: 'dangling-ref',
        sourceCid: c.cid,
        sourceTitle: c.title,
        targetCid: t,
        message: `条款「${c.title}」引用的 ${t} 在草案中不存在（可能已被删除），请修复引用后再发布`,
      });
    }
  }

  let mergedCids;
  let mergedContent;
  let mergedRefs;

  if (latest.id === base.id) {
    // 没有并行版本，草案即新版本内容
    mergedCids = snap.clauses.map((c) => c.cid);
    mergedContent = new Map(snap.clauses.map((c) => [c.cid, { title: c.title, body: c.body }]));
    mergedRefs = new Map(snap.clauses.map((c) => [c.cid, [...c.refs]]));
  } else {
    const theirs = historyChangeTags(base, latest);

    // 2) 同一条款被双方改动
    for (const [cid, myTags] of mine) {
      const theirTags = theirs.get(cid);
      if (theirTags) {
        conflicts.push({
          kind: 'same-clause',
          cid,
          draftTags: [...myTags],
          otherTags: [...theirTags],
          otherVersion: latest.number,
          message:
            `条款 ${cid} 在本草案中被${tagLabels(myTags)}，但在基线之后发布的 v${latest.number} ` +
            `中已被${tagLabels(theirTags)}，双方改动重叠，需人工合并`,
        });
      }
    }

    // 3) 重放内容
    mergedContent = new Map(latest.clauses.map((c) => [c.cid, { title: c.title, body: c.body }]));
    mergedRefs = new Map(latest.clauses.map((c) => [c.cid, [...c.refs]]));
    const deletedDraft = [];
    for (const c of snap.clauses) {
      if (mine.has(c.cid)) {
        mergedContent.set(c.cid, { title: c.title, body: c.body });
        mergedRefs.set(c.cid, [...c.refs]);
      }
    }
    for (const d of snap.deleted) {
      deletedDraft.push(d.cid);
      mergedContent.delete(d.cid);
      mergedRefs.delete(d.cid);
    }

    // 4) 重放顺序
    mergedCids = replayOrder(
      latest.clauses.map((c) => c.cid),
      deletedDraft,
      snap
    );

    // 健全性检查
    const alive = new Set(mergedCids);
    for (const c of snap.clauses) {
      if (c.status === 'added' && !alive.has(c.cid)) {
        conflicts.push({ kind: 'replay', cid: c.cid, message: `新增条款 ${c.cid} 重放后丢失` });
      }
    }

    // 5) 重放后悬空引用
    for (const cid of mergedCids) {
      for (const t of mergedRefs.get(cid) || []) {
        if (!alive.has(t)) {
          const src = mergedContent.get(cid);
          conflicts.push({
            kind: 'dangling-ref-after-replay',
            sourceCid: cid,
            sourceTitle: src ? src.title : cid,
            targetCid: t,
            message:
              `重放到 v${latest.number} 后，条款「${src ? src.title : cid}」引用的 ${t} ` +
              `在最新版本中不存在（可能已被并行版本删除），无法发布`,
          });
        }
      }
    }
  }

  if (conflicts.length > 0) {
    return { ok: false, conflicts, latestNumber: latest.number, baseNumber: base.number };
  }

  const movedSet = new Set(snap.clauses.filter((c) => c.moved).map((c) => c.cid));
  const version = {
    baseNumber: base.number,
    latestNumber: latest.number,
    clauses: mergedCids.map((cid) => ({
      cid,
      title: mergedContent.get(cid).title,
      body: mergedContent.get(cid).body,
      refs: mergedRefs.get(cid) || [],
      moved: movedSet.has(cid),
    })),
  };
  return { ok: true, version, baseNumber: base.number, latestNumber: latest.number };
}

function publishDraft(db, state, draftId, note) {
  const plan = planPublish(db, state, draftId);
  if (!plan.ok) return plan;

  const snap = state.draftSnapshot(db, draftId);
  const tx = db.transaction(() => {
    const maxRow = db.prepare('SELECT MAX(number) AS n FROM version').get();
    const number = (maxRow.n || 0) + 1;
    const createdAt = nowIso();
    const info = db
      .prepare('INSERT INTO version (number, title, note, created_at) VALUES (?, ?, ?, ?)')
      .run(number, `章程 v${number}`, note || '', createdAt);
    const vid = info.lastInsertRowid;

    const insC = db.prepare(
      'INSERT INTO version_clause (version_id, cid, title, body, position) VALUES (?, ?, ?, ?, ?)'
    );
    const insR = db.prepare(
      'INSERT INTO version_ref (version_id, source_cid, target_cid, position) VALUES (?, ?, ?, ?)'
    );
    const insM = db.prepare('INSERT INTO version_move (version_id, cid) VALUES (?, ?)');

    plan.version.clauses.forEach((c, i) => {
      insC.run(vid, c.cid, c.title, c.body, i);
      c.refs.forEach((t, j) => insR.run(vid, c.cid, t, j));
      if (c.moved) insM.run(vid, c.cid);
    });

    db.prepare('DELETE FROM draft WHERE id = ?').run(draftId);
    return { id: vid, number, createdAt };
  });

  const created = tx();
  return { ok: true, version: { ...created, ...plan.version }, plan, baseNumber: plan.baseNumber, latestNumber: plan.latestNumber };
}

module.exports = { planPublish, publishDraft, cidGen, nowIso };
