'use strict';

const express = require('express');
const drafts = require('./drafts');
const state = require('./state');
const { diffDraft } = require('./diff');
const { planPublish, publishDraft } = require('./merge');

function createApi(db) {
  const router = express.Router();

  // ---- 概览 ----
  router.get('/overview', (req, res) => {
    const versions = state.listVersions(db);
    const latest = versions.length ? state.latestVersion(db) : null;
    res.json({
      initialized: versions.length > 0,
      latest: latest
        ? {
            id: latest.id,
            number: latest.number,
            title: latest.title,
            note: latest.note,
            createdAt: latest.created_at,
            clauseCount: latest.clauses.length,
          }
        : null,
      versions,
      drafts: state.listDrafts(db),
    });
  });

  // ---- 首版录入 ----
  router.post('/initialize', (req, res) => {
    const vid = drafts.initializeFirstVersion(db, req.body || {});
    res.status(201).json({ ok: true, versionId: vid, number: 1 });
  });

  // ---- 版本 ----
  router.get('/versions/:id', (req, res) => {
    const v = state.loadVersion(db, Number(req.params.id));
    if (!v) return res.status(404).json({ error: '版本不存在' });
    res.json(v);
  });

  // 两版对比：GET /versions/:newerId/compare/:olderId 返回 older -> newer 的变化
  router.get('/versions/:id/compare/:otherId', (req, res) => {
    const newer = state.loadVersion(db, Number(req.params.id));
    const older = state.loadVersion(db, Number(req.params.otherId));
    if (!newer || !older) return res.status(404).json({ error: '版本不存在' });
    res.json(compareVersions(older, newer));
  });

  // ---- 草案 ----
  router.post('/drafts', (req, res) => {
    const id = drafts.createDraft(db, req.body || {});
    res.status(201).json({ ok: true, draftId: id });
  });

  router.delete('/drafts/:id', (req, res) => {
    const row = db.prepare('SELECT id FROM draft WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: '草案不存在' });
    db.prepare('DELETE FROM draft WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });

  router.get('/drafts/:id', (req, res) => {
    const snap = state.draftSnapshot(db, Number(req.params.id));
    if (!snap) return res.status(404).json({ error: '草案不存在' });
    const base = state.loadVersion(db, snap.base_version_id);
    const latest = state.latestVersion(db);
    const plan = planPublish(db, state, snap.id);
    res.json({
      draft: snap,
      base,
      latestNumber: latest.number,
      stale: latest.id !== base.id,
      diff: diffDraft(base, snap),
      publishCheck: { ok: plan.ok, conflicts: plan.conflicts || [], baseNumber: base.number, latestNumber: latest.number },
    });
  });

  router.post('/drafts/:id/clauses', (req, res) => {
    const cid = drafts.addClause(db, Number(req.params.id), req.body || {});
    res.status(201).json({ ok: true, cid });
  });

  router.put('/drafts/:id/clauses/:cid', (req, res) => {
    drafts.editClause(db, Number(req.params.id), req.params.cid, req.body || {});
    res.json({ ok: true });
  });

  router.delete('/drafts/:id/clauses/:cid', (req, res) => {
    drafts.deleteClause(db, Number(req.params.id), req.params.cid);
    res.json({ ok: true });
  });

  router.put('/drafts/:id/clauses/:cid/move', (req, res) => {
    drafts.moveClause(db, Number(req.params.id), req.params.cid, req.body || {});
    res.json({ ok: true });
  });

  router.put('/drafts/:id/clauses/:cid/refs', (req, res) => {
    drafts.setRefs(db, Number(req.params.id), req.params.cid, (req.body || {}).refs);
    res.json({ ok: true });
  });

  // 发布前冲突预检（不修改任何内容；冲突时草案保留）
  router.get('/drafts/:id/publish-check', (req, res) => {
    const snap = state.draftSnapshot(db, Number(req.params.id));
    if (!snap) return res.status(404).json({ error: '草案不存在' });
    const plan = planPublish(db, state, snap.id);
    res.json({ ok: plan.ok, conflicts: plan.conflicts || [], baseNumber: plan.baseNumber, latestNumber: plan.latestNumber });
  });

  // 发布：原子生成不可变版本；冲突则 409 且草案原样保留
  router.post('/drafts/:id/publish', (req, res) => {
    const id = Number(req.params.id);
    const snap = state.draftSnapshot(db, id);
    if (!snap) return res.status(404).json({ error: '草案不存在' });
    const result = publishDraft(db, state, id, (req.body || {}).note);
    if (!result.ok) {
      return res.status(409).json({
        ok: false,
        conflicts: result.conflicts,
        baseNumber: result.baseNumber,
        latestNumber: result.latestNumber,
        message: '发布被拒绝：存在合并冲突，草案已保留',
      });
    }
    res.status(201).json({
      ok: true,
      versionId: result.version.id,
      number: result.version.number,
      baseNumber: result.baseNumber,
      replayed: result.latestNumber > result.baseNumber,
    });
  });

  return router;
}

// 两个已发布版本的对比
function compareVersions(a, b) {
  const aMap = new Map(a.clauses.map((c) => [c.cid, c]));
  const bMap = new Map(b.clauses.map((c) => [c.cid, c]));
  const changes = [];
  for (const c of b.clauses) {
    const old = aMap.get(c.cid);
    if (!old) {
      changes.push({ cid: c.cid, type: 'added', title: c.title });
      continue;
    }
    const bodyChanged = old.title !== c.title || old.body !== c.body;
    const refsChanged = JSON.stringify(old.refs) !== JSON.stringify(c.refs);
    const moved = c.moved;
    if (bodyChanged || refsChanged || moved) {
      changes.push({
        cid: c.cid,
        type: bodyChanged ? 'edited' : refsChanged ? 'refs-changed' : 'moved',
        title: c.title,
        bodyChanged,
        refsChanged,
        moved,
        oldBody: old.body,
        newBody: c.body,
        oldRefs: old.refs,
        newRefs: c.refs,
      });
    }
  }
  for (const c of a.clauses) {
    if (!bMap.has(c.cid)) changes.push({ cid: c.cid, type: 'deleted', title: c.title });
  }
  return { from: { id: a.id, number: a.number }, to: { id: b.id, number: b.number }, changes };
}

module.exports = { createApi };
