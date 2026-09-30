'use strict';

// 草案相对其基线版本的差异
// 类型：added / deleted / edited / moved / unchanged（引用变化并入 edited / ref-only）

function diffDraft(base, snap) {
  const baseMap = new Map(base.clauses.map((c) => [c.cid, c]));
  const snapMap = new Map(snap.clauses.map((c) => [c.cid, c]));
  const baseOrder = base.clauses.map((c) => c.cid);
  const snapOrder = snap.clauses.map((c) => c.cid);
  const baseIndex = new Map(baseOrder.map((cid, i) => [cid, i]));

  const items = [];

  for (const cur of snap.clauses) {
    const old = baseMap.get(cur.cid);
    if (!old) {
      items.push({ cid: cur.cid, type: 'added', title: cur.title });
      continue;
    }
    const bodyChanged = old.title !== cur.title || old.body !== cur.body;
    const refsChanged = JSON.stringify(old.refs) !== JSON.stringify(cur.refs);
    const moved = cur.moved === true;
    if (bodyChanged || refsChanged || moved) {
      items.push({
        cid: cur.cid,
        type: bodyChanged ? 'edited' : refsChanged ? 'refs-changed' : 'moved',
        title: cur.title,
        bodyChanged,
        refsChanged,
        moved,
        oldTitle: old.title,
        newTitle: cur.title,
        oldBody: old.body,
        newBody: cur.body,
        oldRefs: old.refs,
        newRefs: cur.refs,
        from: baseIndex.get(cur.cid) + 1,
        to: snapOrder.indexOf(cur.cid) + 1,
      });
    } else {
      items.push({ cid: cur.cid, type: 'unchanged', title: cur.title });
    }
  }

  for (const old of base.clauses) {
    if (!snapMap.has(old.cid)) {
      items.push({ cid: old.cid, type: 'deleted', title: old.title });
    }
  }

  // 汇总相对基线顺序发生位移的条款（含增删引发的整体平移，仅用于展示）
  const movedAll = [];
  snap.clauses.forEach((cur, i) => {
    const bi = baseIndex.get(cur.cid);
    if (bi !== undefined && bi !== i && !cur.moved) {
      movedAll.push(cur.cid);
    }
  });

  const danglingRefs = [];
  for (const c of snap.clauses) {
    for (const t of c.danglingRefs) {
      danglingRefs.push({ sourceCid: c.cid, targetCid: t, deletedInDraft: !snapMap.has(t) || snap.clauses.every((x) => x.cid !== t) });
    }
  }

  return {
    baseNumber: base.number,
    items,
    order: snapOrder,
    movedAll,
    danglingRefs,
    counts: {
      added: items.filter((i) => i.type === 'added').length,
      deleted: items.filter((i) => i.type === 'deleted').length,
      edited: items.filter((i) => i.type === 'edited' || i.type === 'refs-changed').length,
      moved: items.filter((i) => i.moved).length,
    },
  };
}

module.exports = { diffDraft };
