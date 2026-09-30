'use strict';

// 端到端冒烟测试（不启动 HTTP，直接驱动核心模块）
// node test/smoke.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { open } = require('../src/db.js');
const state = require('../src/state.js');
const drafts = require('../src/drafts.js');
const { publishDraft, planPublish } = require('../src/merge.js');
const { diffDraft } = require('../src/diff.js');

let passed = 0;
function test(name, fn) {
  const dbPath = path.join(os.tmpdir(), `charter-smoke-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = open(dbPath);
  try {
    fn(db);
    passed += 1;
    console.log(`  ✓ ${name}`);
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(dbPath + '-wal', { force: true });
    fs.rmSync(dbPath + '-shm', { force: true });
  }
}

function seedV1(db) {
  drafts.initializeFirstVersion(db, {
    note: '首版',
    clauses: [
      { cid: 'a', title: '总则', body: '正文A', refs: ['b'] },
      { cid: 'b', title: '成员', body: '正文B', refs: [] },
      { cid: 'c', title: '义务', body: '正文C', refs: ['a', 'b'] },
      { cid: 'd', title: '附则', body: '正文D', refs: [] },
    ],
  });
}

function expectError(fn, status) {
  assert.throws(fn, (e) => (status ? e.status === status : e.status > 0));
}

console.log('1. 首版初始化与校验');
test('首版发布成功且顺序/引用正确', (db) => {
  seedV1(db);
  const v = state.latestVersion(db);
  assert.equal(v.number, 1);
  assert.deepEqual(v.clauses.map((c) => c.cid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(v.clauses[0].refs, ['b']);
  assert.deepEqual(v.clauses[2].refs, ['a', 'b']);
});

test('首版拒绝悬空引用', (db) => {
  expectError(() => drafts.initializeFirstVersion(db, {
    clauses: [{ cid: 'a', title: 't', body: 'x', refs: ['ghost'] }],
  }), 400);
});

test('首版只能初始化一次', (db) => {
  seedV1(db);
  expectError(() => seedV1(db), 409);
});

console.log('2. 草案编辑与差异');
test('编辑/新增/删除/移动/引用改动并正确生成差异', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, { name: 'D1' });
  drafts.editClause(db, id, 'a', { title: '总则', body: '正文A-改' });
  drafts.addClause(db, id, { cid: 'e', title: '选举', body: '正文E', afterCid: 'b' });
  drafts.deleteClause(db, id, 'd');
  drafts.setRefs(db, id, 'c', ['b']); // a,b -> b
  // 把 e 移到 a 之前
  drafts.moveClause(db, id, 'e', { afterCid: null });

  const snap = state.draftSnapshot(db, id);
  assert.deepEqual(snap.clauses.map((c) => c.cid), ['e', 'a', 'b', 'c']);
  const base = state.loadVersion(db, snap.base_version_id);
  const d = diffDraft(base, snap);
  const byCid = new Map(d.items.map((i) => [i.cid, i]));
  assert.equal(byCid.get('a').type, 'edited');
  assert.equal(byCid.get('e').type, 'added');
  assert.equal(byCid.get('d').type, 'deleted');
  assert.equal(byCid.get('c').type, 'refs-changed'); // 仅引用改动
  assert.equal(byCid.get('e').type, 'added');
  assert.equal(d.counts.added, 1);
  assert.equal(d.counts.deleted, 1);
});

test('删除被引用条款产生悬空引用：可暂存但禁止发布', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, { name: 'D' });
  drafts.deleteClause(db, id, 'b'); // a 引用 b
  const snap = state.draftSnapshot(db, id);
  const a = snap.clauses.find((c) => c.cid === 'a');
  assert.deepEqual(a.danglingRefs, ['b']);
  const plan = planPublish(db, state, id);
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.some((c) => c.kind === 'dangling-ref' && c.targetCid === 'b'));
  // 草案保留
  assert.ok(state.draftSnapshot(db, id));
});

test('显式暂存不存在的引用同样禁止发布', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, {});
  drafts.setRefs(db, id, 'a', ['b', 'ghost']);
  const plan = planPublish(db, state, id);
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.some((c) => c.kind === 'dangling-ref' && c.targetCid === 'ghost'));
});

console.log('3. 普通发布与不可变版本');
test('无冲突发布原子生成 v2 并删除草案，历史可完整还原', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, {});
  drafts.editClause(db, id, 'b', { body: '正文B-v2' });
  const r = publishDraft(db, state, id, '修订成员条款');
  assert.equal(r.ok, true);
  assert.equal(r.version.number, 2);
  assert.equal(state.draftSnapshot(db, id), null);

  const v1 = state.loadVersion(db, 1);
  const v2 = state.loadVersion(db, 2);
  assert.equal(v1.clauses[1].body, '正文B'); // 旧版不动
  assert.equal(v2.clauses[1].body, '正文B-v2');
  assert.deepEqual(v2.clauses.map((c) => c.cid), ['a', 'b', 'c', 'd']);
  assert.deepEqual(v1.clauses[2].refs, ['a', 'b']);
});

test('已发布版本不可变（触发器拒绝 UPDATE/DELETE）', (db) => {
  seedV1(db);
  assert.throws(() => db.prepare("UPDATE version_clause SET body='x' WHERE version_id=1").run());
  assert.throws(() => db.prepare('DELETE FROM version WHERE id=1').run());
  assert.throws(() => db.prepare('DELETE FROM version_ref WHERE version_id=1').run());
});

console.log('4. 并行草案：不相交改动重放');
test('双方改动不相交：自动重放到最新版成功', (db) => {
  seedV1(db);
  const d1 = drafts.createDraft(db, { name: '改a' });
  const d2 = drafts.createDraft(db, { name: '改c' });

  // d1 先发布：修改 a
  drafts.editClause(db, d1, 'a', { body: 'A-by-d1' });
  assert.equal(publishDraft(db, state, d1, '').ok, true); // v2

  // d2 基线仍是 v1，修改 c（与 a 不相交）
  drafts.editClause(db, d2, 'c', { body: 'C-by-d2' });
  const plan = planPublish(db, state, d2);
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, true);
  assert.equal(r.version.number, 3);

  const v3 = state.loadVersion(db, 3);
  const map = new Map(v3.clauses.map((c) => [c.cid, c]));
  assert.equal(map.get('a').body, 'A-by-d1'); // 另一方改动保留
  assert.equal(map.get('c').body, 'C-by-d2'); // 本方改动重放
});

test('不相交的新增+删除+移动可正确重放顺序', (db) => {
  seedV1(db); // a b c d
  const d1 = drafts.createDraft(db, {});
  const d2 = drafts.createDraft(db, {});

  // d1: 删除 d，新增 f 放末尾
  drafts.deleteClause(db, d1, 'd');
  drafts.addClause(db, d1, { cid: 'f', title: '财务', body: 'F' });
  assert.equal(publishDraft(db, state, d1, '').ok, true); // v2: a b c f

  // d2（基线 v1）: 新增 e 放到 b 之后，移动 a 到 c 之后
  drafts.addClause(db, d2, { cid: 'e', title: '选举', body: 'E', afterCid: 'b' });
  drafts.moveClause(db, d2, 'a', { afterCid: 'c' });
  const plan = planPublish(db, state, d2);
  assert.equal(plan.ok, true, JSON.stringify(plan.conflicts));
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, true);
  const v3 = state.loadVersion(db, r.version.id);
  // d2 视角: b e c a (d 被 d1 删除，不出现)，f 在末尾
  assert.deepEqual(v3.clauses.map((c) => c.cid), ['b', 'e', 'c', 'a', 'f']);
});

console.log('5. 并行草案：冲突拒绝且保留草案');
test('同一条款被双方编辑 => 拒绝发布、说明冲突、草案保留', (db) => {
  seedV1(db);
  const d1 = drafts.createDraft(db, {});
  const d2 = drafts.createDraft(db, {});
  drafts.editClause(db, d1, 'b', { body: 'B1' });
  publishDraft(db, state, d1, ''); // v2
  drafts.editClause(db, d2, 'b', { body: 'B2' });
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, false);
  const conflict = r.conflicts.find((c) => c.kind === 'same-clause' && c.cid === 'b');
  assert.ok(conflict);
  assert.ok(/双方改动重叠/.test(conflict.message));
  assert.equal(r.conflicts[0].otherVersion, 2);
  // 草案原样保留，修复后可发布
  assert.ok(state.draftSnapshot(db, d2));
});

test('一方编辑、另一方移动同一条款 => 同样视为冲突', (db) => {
  seedV1(db);
  const d1 = drafts.createDraft(db, {});
  const d2 = drafts.createDraft(db, {});
  drafts.editClause(db, d1, 'c', { body: 'C1' });
  publishDraft(db, state, d1, '');
  drafts.moveClause(db, d2, 'c', { afterCid: null });
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'same-clause' && c.cid === 'c'));
});

test('重放后引用悬空（并行版本删除了引用目标）=> 拒绝并保留草案', (db) => {
  seedV1(db); // a -> b, c -> a,b
  const d1 = drafts.createDraft(db, {});
  const d2 = drafts.createDraft(db, {});
  // d1 删除 b，并修复所有指向 b 的引用（a、c）
  drafts.setRefs(db, d1, 'a', []);
  drafts.setRefs(db, d1, 'c', ['a']);
  drafts.deleteClause(db, d1, 'b');
  publishDraft(db, state, d1, ''); // v2: a c d
  // d2（基线仍为 v1，b 还存在）：给未被 d1 触碰的 d 新增指向 b 的引用
  drafts.setRefs(db, d2, 'd', ['b']);
  const plan = planPublish(db, state, d2);
  // 草案自身不悬空（基线里 b 存在），但重放到 v2 后悬空
  assert.ok(state.draftSnapshot(db, d2).clauses.find((c) => c.cid === 'd').danglingRefs.length === 0);
  assert.equal(plan.ok, false);
  assert.ok(plan.conflicts.some((c) => c.kind === 'dangling-ref-after-replay' && c.targetCid === 'b'));
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.kind === 'dangling-ref-after-replay' && c.targetCid === 'b'));
  assert.ok(state.draftSnapshot(db, d2));
});

test('双方都新增相同 CID => 按同条款冲突处理', (db) => {
  seedV1(db);
  const d1 = drafts.createDraft(db, {});
  const d2 = drafts.createDraft(db, {});
  drafts.addClause(db, d1, { cid: 'x', title: 'X1', body: 'x1' });
  publishDraft(db, state, d1, '');
  drafts.addClause(db, d2, { cid: 'x', title: 'X2', body: 'x2' });
  const r = publishDraft(db, state, d2, '');
  assert.equal(r.ok, false);
  assert.ok(r.conflicts.some((c) => c.cid === 'x'));
});

console.log('6. 移动标记与还原');
test('移走再移回原位 => 不再计为移动变更', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, {});
  drafts.moveClause(db, id, 'a', { afterCid: 'd' });
  drafts.moveClause(db, id, 'a', { position: 0 });
  const snap = state.draftSnapshot(db, id);
  const base = state.loadVersion(db, snap.base_version_id);
  const d = diffDraft(base, snap);
  assert.equal(d.counts.moved, 0);
  assert.equal(publishDraft(db, state, id, '').ok, true);
  const v2 = state.loadVersion(db, 2);
  assert.deepEqual(v2.clauses.map((c) => c.cid), ['a', 'b', 'c', 'd']);
});

test('删除中间条款后其他条款的自然位移不算显式移动', (db) => {
  seedV1(db);
  const id = drafts.createDraft(db, {});
  drafts.deleteClause(db, id, 'b');
  const snap = state.draftSnapshot(db, id);
  assert.equal(snap.clauses.find((c) => c.cid === 'c').moved, false);
});

console.log(`\n全部 ${passed} 项测试通过 ✅`);
