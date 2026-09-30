'use strict';

const app = document.getElementById('app');

// ---------- 工具 ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.error || `请求失败 (${res.status})`);
    e.data = data;
    throw e;
  }
  return data;
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

function go(hash) { location.hash = hash; }

function refChips(refs, aliveSet, cidTitle) {
  if (!refs || !refs.length) return '<span class="muted small">无引用</span>';
  return refs.map((t) => {
    if (aliveSet && !aliveSet.has(t)) {
      return `<span class="ref-chip dangling" title="悬空引用：目标条款不存在">⚠ ${esc(t)}</span>`;
    }
    const label = cidTitle ? cidTitle.get(t) : t;
    return `<span class="ref-chip" data-jump="${esc(t)}" title="跳转到 ${esc(t)}">→ ${esc(label || t)}</span>`;
  }).join('');
}

function statusBadge(status, moved) {
  const map = {
    added: ['added', '新增'],
    deleted: ['deleted', '已删除'],
    edited: ['edited', '已编辑'],
    unchanged: '',
  };
  let out = '';
  if (map[status]) {
    const [cls, text] = map[status];
    if (cls) out += `<span class="badge ${cls}">${text}</span>`;
  }
  if (moved) out += `<span class="badge moved">移动</span>`;
  return out;
}

// ---------- 路由 ----------
async function route() {
  document.querySelectorAll('.navbtn').forEach((b) => {
    b.classList.toggle('active', location.hash.startsWith('#/' + b.dataset.view) ||
      (!location.hash && b.dataset.view === 'latest'));
  });
  const h = location.hash || '#/latest';
  try {
    if (h === '#/latest' || h === '#/') await viewLatest();
    else if (h === '#/drafts') await viewDrafts();
    else if (h.startsWith('#/drafts/')) await viewDraft(Number(h.split('/')[2]));
    else if (h === '#/history') await viewHistory();
    else if (h.startsWith('#/versions/')) await viewVersion(Number(h.split('/')[2]));
    else await viewLatest();
  } catch (e) {
    app.innerHTML = `<div class="card"><div class="banner err">${esc(e.message)}</div>
      <button class="btn ghost" onclick="history.back()">返回</button></div>`;
  }
}
window.addEventListener('hashchange', route);

// ---------- 首版初始化 ----------
async function viewLatest() {
  const ov = await api('GET', '/api/overview');
  if (!ov.initialized) return viewInit();
  const v = await api('GET', `/api/versions/${ov.latest.id}`);
  const alive = new Set(v.clauses.map((c) => c.cid));
  const titles = new Map(v.clauses.map((c) => [c.cid, c.title]));
  app.innerHTML = `
    <div class="card">
      <div class="inline" style="justify-content:space-between">
        <div>
          <h1>${esc(v.title)}</h1>
          <div class="sub">版本号 v${v.number} · 发布于 ${new Date(v.created_at).toLocaleString('zh-CN')}
            ${v.note ? '· ' + esc(v.note) : ''}</div>
        </div>
        <div class="btnrow">
          <button class="btn secondary" id="newDraft">从当前版本创建草案</button>
        </div>
      </div>
    </div>
    ${renderClauses(v.clauses, alive, titles, false)}`;
  document.getElementById('newDraft').onclick = async () => {
    const name = prompt('草案名称（可留空）', '');
    if (name === null) return;
    const r = await api('POST', '/api/drafts', { name }).catch((e) => toast(e.message, true));
    if (r) { toast('草案已创建'); go(`#/drafts/${r.draftId}`); }
  };
  bindJumps(alive);
}

function renderClauses(clauses, alive, titles, showMovedBadge) {
  if (!clauses.length) return '<div class="card empty">（暂无条款）</div>';
  return '<div class="card">' + clauses.map((c, i) => `
    <div class="clause" id="clause-${esc(c.cid)}">
      <div class="clause-head">
        <span class="muted small">第 ${i + 1} 条</span>
        <span class="cid">${esc(c.cid)}</span>
        <span class="clause-title">${esc(c.title)}</span>
        ${statusBadge(c.status || '', showMovedBadge && c.moved)}
        ${c.danglingRefs && c.danglingRefs.length ? '<span class="badge warn">⚠ 悬空引用</span>' : ''}
      </div>
      <div class="clause-body ${c.status === 'deleted' ? 'deleted-text' : ''}">${esc(c.body)}</div>
      <div class="refs">引用：${refChips(c.refs, alive, titles)}</div>
    </div>`).join('') + '</div>';
}

function bindJumps() {
  app.querySelectorAll('[data-jump]').forEach((el) => {
    el.onclick = () => {
      const target = document.getElementById('clause-' + el.dataset.jump);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      else toast('目标条款不在当前视图中');
    };
  });
}

async function viewInit() {
  app.innerHTML = `
    <div class="card">
      <h1>录入首版章程</h1>
      <div class="sub">首版是所有后续修订与差异对比的不可变基线。稳定标识（CID）一经生成即跨版本保持不变。</div>
      <div class="field">
        <label>发布说明（可选）</label>
        <input type="text" id="initNote" placeholder="例如：2026 年会员大会表决通过" />
      </div>
      <div id="initRows"></div>
      <div class="btnrow">
        <button class="btn ghost" id="addRow">＋ 添加条款</button>
        <button class="btn" id="seedDemo" style="margin-left:auto">填充示例</button>
        <button class="btn" id="submitInit">发布首版</button>
      </div>
      <div class="sub" style="margin-top:14px">
        引用在保存后统一维护；首版不允许悬空引用。创建草案后可以暂存指向不存在条款的悬空引用（会被标红），但不能发布。
      </div>
    </div>`;
  const rows = document.getElementById('initRows');
  function addRow(c = {}) {
    const div = document.createElement('div');
    div.className = 'clause';
    div.innerHTML = `
      <div class="field"><label>稳定标识 CID（留空自动生成）</label>
        <input type="text" class="f-cid" value="${esc(c.cid || '')}" placeholder="例如 purpose / membership" /></div>
      <div class="field"><label>标题</label><input type="text" class="f-title" value="${esc(c.title || '')}" /></div>
      <div class="field"><label>正文</label><textarea class="f-body">${esc(c.body || '')}</textarea></div>
      <div class="field"><label>引用（引用其他条款的 CID，英文逗号分隔）</label>
        <input type="text" class="f-refs" value="${esc((c.refs || []).join(', '))}" /></div>
      <button class="btn danger actn remove">移除该条</button>`;
    div.querySelector('.remove').onclick = () => div.remove();
    rows.appendChild(div);
  }
  document.getElementById('addRow').onclick = () => addRow();
  document.getElementById('seedDemo').onclick = () => {
    rows.innerHTML = '';
    [
      { cid: 'purpose', title: '第一条 宗旨', body: '本社团以促进成员交流与技术成长为宗旨。', refs: ['scope'] },
      { cid: 'membership', title: '第二条 成员', body: '凡承认本章程者均可申请加入，经审批后成为成员。', refs: ['purpose', 'duties'] },
      { cid: 'duties', title: '第三条 成员义务', body: '成员应遵守章程，维护社团声誉，积极参加活动。', refs: ['membership'] },
      { cid: 'scope', title: '第四条 活动范围', body: '社团组织技术分享、项目协作与社区服务等活动。', refs: [] },
    ].forEach(addRow);
  };
  document.getElementById('submitInit').onclick = async () => {
    const clauses = [...rows.querySelectorAll('.clause')].map((d) => ({
      cid: d.querySelector('.f-cid').value.trim(),
      title: d.querySelector('.f-title').value,
      body: d.querySelector('.f-body').value,
      refs: d.querySelector('.f-refs').value.split(',').map((s) => s.trim()).filter(Boolean),
    }));
    try {
      await api('POST', '/api/initialize', { note: document.getElementById('initNote').value, clauses });
      toast('首版已发布');
      go('#/latest');
    } catch (e) { toast(e.message, true); }
  };
  addRow();
}

// ---------- 草案列表 ----------
async function viewDrafts() {
  const ov = await api('GET', '/api/overview');
  if (!ov.initialized) return viewInit();
  app.innerHTML = `
    <div class="card">
      <div class="inline" style="justify-content:space-between">
        <h1 style="margin:0">修订草案</h1>
        <div class="btnrow">
          <select id="baseSelect" style="width:auto">
            ${ov.versions.map((v) => `<option value="${v.id}" ${v.id === ov.latest.id ? 'selected' : ''}>基于 v${v.number}</option>`).join('')}
          </select>
          <input type="text" id="draftName" placeholder="草案名称（可选）" style="width:220px" />
          <button class="btn" id="createDraft">创建草案</button>
        </div>
      </div>
    </div>
    <div class="card">
      ${ov.drafts.length === 0 ? '<div class="empty">还没有草案，创建一个开始修订吧。</div>' : `
      <table class="grid">
        <thead><tr><th>#</th><th>名称</th><th>基线</th><th>改动数</th><th>悬空引用</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
          ${ov.drafts.map((d) => `<tr>
            <td>${d.id}</td>
            <td class="rowlink" data-go="${d.id}">${esc(d.name)}</td>
            <td>v${d.base_number}${d.base_number < ov.latest.number ? '<span class="badge warn" style="margin-left:6px">基线落后</span>' : ''}</td>
            <td>${d.changes}</td>
            <td>${d.danglingRefs ? `<span class="badge warn">${d.danglingRefs} 处</span>` : '—'}</td>
            <td class="small muted">${new Date(d.created_at).toLocaleString('zh-CN')}</td>
            <td><button class="btn secondary actn" data-open="${d.id}">打开</button></td>
          </tr>`).join('')}
        </tbody>
      </table>`}
    </div>`;
  document.getElementById('createDraft').onclick = async () => {
    const r = await api('POST', '/api/drafts', {
      name: document.getElementById('draftName').value,
      baseVersionId: Number(document.getElementById('baseSelect').value),
    }).catch((e) => toast(e.message, true));
    if (r) { toast('草案已创建'); go(`#/drafts/${r.draftId}`); }
  };
  app.querySelectorAll('[data-open],[data-go]').forEach((el) => {
    el.onclick = () => go(`#/drafts/${el.dataset.open || el.dataset.go}`);
  });
}

// ---------- 草案详情 / 编辑 / 差异 / 发布 ----------
async function viewDraft(id) {
  const data = await api('GET', `/api/drafts/${id}`);
  const { draft, base, latestNumber, stale, diff, publishCheck } = data;
  const aliveSet = new Set(draft.clauses.map((c) => c.cid));
  const titles = new Map(draft.clauses.map((c) => [c.cid, c.title]));

  app.innerHTML = `
    <div class="card">
      <div class="inline" style="justify-content:space-between">
        <div>
          <h1>${esc(draft.name)}</h1>
          <div class="sub">草案 #${draft.id} · 基线 v${base.number} ·
            当前最新版本 <b>v${latestNumber}</b>${stale ? '（基线落后，发布时将自动重放不相交改动）' : ''}</div>
        </div>
        <div class="btnrow">
          <button class="btn ghost" id="backList">返回列表</button>
          <button class="btn danger" id="discard">废弃草案</button>
        </div>
      </div>
      ${publishCheck.ok
        ? `<div class="banner ok">✅ 发布预检通过${stale ? '，改动可干净重放到 v' + latestNumber : ''}。</div>`
        : `<div class="banner err">🚫 当前无法发布：${publishCheck.conflicts.length} 项问题。草案可以继续暂存编辑，但问题解决前不能发布。</div>`}
      <div class="btnrow">
        <button class="btn ghost" id="showDiff">查看差异</button>
        <button class="btn ghost" id="showEdit">编辑条款</button>
        <input type="text" id="pubNote" placeholder="发布说明（可选）" style="flex:1;min-width:200px" />
        <button class="btn" id="publish" ${publishCheck.ok ? '' : 'disabled'}>原子发布为 v${latestNumber + 1}</button>
      </div>
      <div id="conflicts" style="margin-top:12px">${renderConflicts(publishCheck)}</div>
    </div>

    <div class="card" id="diffPanel">${renderDiff(diff, stale, latestNumber)}</div>
    <div class="card hidden" id="editPanel">${renderEditor(draft, aliveSet)}</div>

    ${draft.deleted.length ? `
    <div class="card del-section">
      <h2>已删除条款（发布后将从新版本移除）</h2>
      ${draft.deleted.map((d) => `
        <div class="clause status-deleted">
          <div class="clause-head"><span class="cid">${esc(d.cid)}</span><span class="clause-title">${esc(d.title)}</span><span class="badge deleted">已删除</span></div>
          <div class="clause-body deleted-text">${esc(d.body)}</div>
        </div>`).join('')}
    </div>` : ''}`;

  document.getElementById('backList').onclick = () => go('#/drafts');
  document.getElementById('discard').onclick = async () => {
    if (!confirm('确认废弃该草案？此操作不可撤销。')) return;
    await api('DELETE', `/api/drafts/${id}`);
    toast('草案已废弃');
    go('#/drafts');
  };
  document.getElementById('showDiff').onclick = () => switchPanels('diff');
  document.getElementById('showEdit').onclick = () => switchPanels('edit');
  document.getElementById('publish').onclick = () => doPublish(id);

  bindEditor(id, draft, data);
  bindJumps();
}

function switchPanels(which) {
  document.getElementById('diffPanel').classList.toggle('hidden', which !== 'diff');
  document.getElementById('editPanel').classList.toggle('hidden', which !== 'edit');
}

function renderConflicts(check) {
  if (check.ok) {
    return `<div class="sub" style="margin:0">差异条款集合与已并行发布的版本不相交，且无悬空引用。</div>`;
  }
  return check.conflicts.map((c) => `
    <div class="conflict">
      <div class="kind">${conflictKindLabel(c.kind)}</div>
      <div>${esc(c.message)}</div>
      ${c.kind === 'same-clause' ? `<div class="sub" style="margin:4px 0 0">
        本草案：${c.draftTags.map(esc).join('、')} ｜ v${c.otherVersion}：${c.otherTags.map(esc).join('、')}</div>` : ''}
    </div>`).join('');
}

function conflictKindLabel(k) {
  return {
    'same-clause': '⛔ 同一条款被双方改动',
    'dangling-ref': '⚠ 草案内悬空引用',
    'dangling-ref-after-replay': '⚠ 重放后引用悬空',
    'replay': '⛔ 重放异常',
    'missing': '错误',
  }[k] || k;
}

function renderDiff(diff, stale, latestNumber) {
  const c = diff.counts;
  return `
    <h2>相对基线 v${diff.baseNumber} 的差异${stale ? `（重放目标 v${latestNumber}）` : ''}</h2>
    <div class="badges" style="margin-bottom:12px">
      <span class="badge added">新增 ${c.added}</span>
      <span class="badge edited">正文/引用改动 ${c.edited}</span>
      <span class="badge moved">显式移动 ${c.moved}</span>
      <span class="badge deleted">删除 ${c.deleted}</span>
      ${diff.danglingRefs.length ? `<span class="badge warn">悬空引用 ${diff.danglingRefs.length}</span>` : ''}
    </div>
    ${diff.items.filter((i) => i.type !== 'unchanged').map((i) => {
      if (i.type === 'added') return `<div class="clause status-added"><b>＋ 新增</b> <span class="cid">${esc(i.cid)}</span> ${esc(i.title)}</div>`;
      if (i.type === 'deleted') return `<div class="clause status-deleted"><b>－ 删除</b> <span class="cid">${esc(i.cid)}</span> ${esc(i.title)}</div>`;
      let body = '';
      if (i.bodyChanged) {
        body = `<div class="diff-old">${esc(i.oldTitle)}：${esc(i.oldBody)}</div>
                <div class="diff-new">${esc(i.newTitle)}：${esc(i.newBody)}</div>`;
      }
      if (i.refsChanged) {
        body += `<div class="small muted">引用：[${i.oldRefs.map(esc).join(', ') || '无'}] → [${i.newRefs.map(esc).join(', ') || '无'}]</div>`;
      }
      if (i.moved && !i.bodyChanged && !i.refsChanged) {
        body += `<div class="small muted">位置：第 ${i.from} 条 → 第 ${i.to} 条</div>`;
      }
      const cls = i.type === 'moved' ? 'status-moved' : 'status-edited';
      return `<div class="clause ${cls}">
        <b>✎ ${i.type === 'moved' ? '移动' : '修改'}</b> <span class="cid">${esc(i.cid)}</span> ${esc(i.title)}
        ${i.moved && (i.bodyChanged || i.refsChanged) ? '<span class="badge moved">同时移动</span>' : ''}
        ${body}</div>`;
    }).join('') || '<div class="empty">与基线完全一致，没有差异。</div>'}`;
}

function renderEditor(draft, aliveSet) {
  const cidOptions = draft.clauses.map((c) => `<option value="${esc(c.cid)}">${esc(c.cid)} — ${esc(c.title)}</option>`).join('');
  return `
    <h2>编辑条款</h2>
    <div class="sub">条款以稳定标识 CID 跟踪；移动仅改变顺序，删除既有条款会在发布时移除（其引用需同步修正）。</div>
    <div id="clauseList">
      ${draft.clauses.map((c, i) => `
        <div class="clause status-${c.status}" data-cid="${esc(c.cid)}">
          <div class="clause-head">
            <span class="muted small">序 ${i + 1}</span>
            <span class="cid">${esc(c.cid)}</span>
            ${c.status === 'added' ? '<span class="badge added">新增</span>' : ''}
            ${c.status === 'edited' ? '<span class="badge edited">已编辑</span>' : ''}
            ${c.moved ? '<span class="badge moved">已移动</span>' : ''}
            <div class="move-controls" style="margin-left:auto">
              <button class="btn ghost actn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
              <button class="btn ghost actn" data-act="down" ${i === draft.clauses.length - 1 ? 'disabled' : ''}>↓</button>
            </div>
          </div>
          <div class="field"><label>标题</label><input class="e-title" type="text" value="${esc(c.title)}" /></div>
          <div class="field"><label>正文</label><textarea class="e-body">${esc(c.body)}</textarea></div>
          <div class="field ref-editor">
            <label>引用（可多选；指向已删除/不存在条款的引用在下方手动录入以暂存）</label>
            <select class="e-refs" multiple>
              ${draft.clauses.filter((x) => x.cid !== c.cid).map((x) =>
                `<option value="${esc(x.cid)}" ${c.refs.includes(x.cid) && aliveSet.has(x.cid) ? 'selected' : ''}>${esc(x.cid)} — ${esc(x.title)}</option>`).join('')}
            </select>
            <div class="small muted">按住 Ctrl/Cmd 多选</div>
            <label style="margin-top:6px">悬空引用 CID（逗号分隔，将被标红且禁止发布）</label>
            <input type="text" class="e-dangling" value="${esc(c.danglingRefs.join(', '))}" />
          </div>
          <div class="refs">当前引用：${refChips(c.refs, aliveSet, new Map(draft.clauses.map((x) => [x.cid, x.title])))}</div>
          <div class="btnrow" style="margin-top:8px">
            <button class="btn secondary actn" data-act="save">保存修改</button>
            <button class="btn danger actn" data-act="delete">删除条款</button>
          </div>
        </div>`).join('')}
    </div>

    <div class="card" style="background:#fafbfd">
      <h3>＋ 添加新条款</h3>
      <div class="field"><label>CID（留空自动生成）</label><input id="n-cid" type="text" placeholder="例如 elections" /></div>
      <div class="field"><label>标题</label><input id="n-title" type="text" /></div>
      <div class="field"><label>正文</label><textarea id="n-body"></textarea></div>
      <div class="field"><label>插入到哪个条款之后（留空放末尾）</label>
        <select id="n-after"><option value="">— 末尾 —</option>${cidOptions}</select></div>
      <button class="btn" id="n-add">添加条款</button>
    </div>`;
}

function bindEditor(id, draft, data) {
  const panel = document.getElementById('editPanel');
  if (!panel) return;

  async function refresh() { await viewDraft(id); switchPanels('edit'); }

  panel.querySelectorAll('.clause[data-cid]').forEach((box) => {
    const cid = box.dataset.cid;
    box.querySelector('[data-act=up]').onclick = async () => {
      const cur = draft.clauses.findIndex((c) => c.cid === cid);
      if (cur > 0) {
        const after = cur - 2 >= 0 ? draft.clauses[cur - 2].cid : null;
        await api('PUT', `/api/drafts/${id}/clauses/${encodeURIComponent(cid)}/move`, { afterCid: after })
          .catch((e) => toast(e.message, true));
        await refresh();
      }
    };
    box.querySelector('[data-act=down]').onclick = async () => {
      const cur = draft.clauses.findIndex((c) => c.cid === cid);
      if (cur < draft.clauses.length - 1) {
        await api('PUT', `/api/drafts/${id}/clauses/${encodeURIComponent(cid)}/move`, { afterCid: draft.clauses[cur + 1].cid })
          .catch((e) => toast(e.message, true));
        await refresh();
      }
    };
    box.querySelector('[data-act=save]').onclick = async () => {
      try {
        await api('PUT', `/api/drafts/${id}/clauses/${encodeURIComponent(cid)}`, {
          title: box.querySelector('.e-title').value,
          body: box.querySelector('.e-body').value,
        });
        const refs = [...box.querySelector('.e-refs').selectedOptions].map((o) => o.value);
        box.querySelector('.e-dangling').value.split(',').map((s) => s.trim()).filter(Boolean).forEach((d) => refs.push(d));
        await api('PUT', `/api/drafts/${id}/clauses/${encodeURIComponent(cid)}/refs`, refs);
        toast('已保存');
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
    box.querySelector('[data-act=delete]').onclick = async () => {
      if (!confirm('确认删除该条款？引用它的条款将出现悬空引用，需修复后才能发布。')) return;
      await api('DELETE', `/api/drafts/${id}/clauses/${encodeURIComponent(cid)}`).catch((e) => toast(e.message, true));
      await refresh();
    };
  });

  const addBtn = panel.querySelector('#n-add');
  if (addBtn) {
    addBtn.onclick = async () => {
      const body = {
        cid: panel.querySelector('#n-cid').value.trim(),
        title: panel.querySelector('#n-title').value,
        body: panel.querySelector('#n-body').value,
        afterCid: panel.querySelector('#n-after').value,
      };
      try {
        await api('POST', `/api/drafts/${id}/clauses`, body);
        toast('条款已添加');
        await refresh();
      } catch (e) { toast(e.message, true); }
    };
  }
}

async function doPublish(id) {
  const note = document.getElementById('pubNote').value;
  try {
    const r = await api('POST', `/api/drafts/${id}/publish`, { note });
    toast(`已原子发布为 v${r.number}${r.replayed ? '（并行改动已自动重放）' : ''}`);
    go('#/latest');
  } catch (e) {
    if (e.data && e.data.conflicts) {
      toast('发布被拒绝：存在冲突，草案已保留', true);
      await viewDraft(id);
    } else {
      toast(e.message, true);
    }
  }
}

// ---------- 历史版本 ----------
async function viewHistory() {
  const ov = await api('GET', '/api/overview');
  if (!ov.initialized) return viewInit();
  app.innerHTML = `
    <div class="card">
      <h1>历史版本</h1>
      <div class="sub">已发布版本不可变；点开任一版本可完整还原其条款顺序、正文与引用。</div>
      <table class="grid">
        <thead><tr><th>版本</th><th>说明</th><th>发布时间</th><th>操作</th></tr></thead>
        <tbody>
          ${ov.versions.map((v, i) => `<tr>
            <td class="rowlink" data-v="${v.id}"><b>v${v.number}</b></td>
            <td>${esc(v.note)}</td>
            <td class="small muted">${new Date(v.created_at).toLocaleString('zh-CN')}</td>
            <td class="btnrow">
              <button class="btn secondary actn" data-v="${v.id}">查看</button>
              ${i < ov.versions.length - 1 ? `<button class="btn ghost actn" data-cmp="${v.id}" data-prev="${ov.versions[i + 1].id}">与上一版对比</button>` : ''}
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <div class="card hidden" id="cmpPanel"></div>`;
  app.querySelectorAll('[data-v]').forEach((el) => {
    el.onclick = () => go(`#/versions/${el.dataset.v}`);
  });
  app.querySelectorAll('[data-cmp]').forEach((el) => {
    el.onclick = async () => {
      const newer = await api('GET', `/api/versions/${el.dataset.cmp}/compare/${el.dataset.prev}`);
      const panel = document.getElementById('cmpPanel');
      panel.classList.remove('hidden');
      panel.innerHTML = `<h2>v${newer.to.number} 相对 v${newer.from.number} 的变化</h2>` +
        (newer.changes.length === 0 ? '<div class="empty">两版完全相同。</div>' :
          newer.changes.map((c) => {
            if (c.type === 'added') return `<div class="clause status-added"><b>＋ 新增</b> <span class="cid">${esc(c.cid)}</span> ${esc(c.title)}</div>`;
            if (c.type === 'deleted') return `<div class="clause status-deleted"><b>－ 删除</b> <span class="cid">${esc(c.cid)}</span> ${esc(c.title)}</div>`;
            return `<div class="clause status-edited"><b>✎ 修改</b> <span class="cid">${esc(c.cid)}</span> ${esc(c.title)}
              ${c.bodyChanged ? `<div class="diff-old">${esc(c.oldBody)}</div><div class="diff-new">${esc(c.newBody)}</div>` : ''}
              ${c.refsChanged ? `<div class="small muted">引用：[${c.oldRefs.map(esc).join(', ') || '无'}] → [${c.newRefs.map(esc).join(', ') || '无'}]</div>` : ''}
            </div>`;
          }).join(''));
      panel.scrollIntoView({ behavior: 'smooth' });
    };
  });
}

async function viewVersion(id) {
  const v = await api('GET', `/api/versions/${id}`);
  const alive = new Set(v.clauses.map((c) => c.cid));
  const titles = new Map(v.clauses.map((c) => [c.cid, c.title]));
  app.innerHTML = `
    <div class="card">
      <div class="inline" style="justify-content:space-between">
        <div>
          <h1>${esc(v.title)} <span class="badge info">不可变快照</span></h1>
          <div class="sub">发布于 ${new Date(v.created_at).toLocaleString('zh-CN')}${v.note ? ' · ' + esc(v.note) : ''}</div>
        </div>
        <div class="btnrow">
          <button class="btn ghost" onclick="go('#/history')">返回历史</button>
          <button class="btn secondary" id="forkDraft">从此版本创建草案</button>
        </div>
      </div>
    </div>
    ${renderClauses(v.clauses, alive, titles, true)}`;
  document.getElementById('forkDraft').onclick = async () => {
    const r = await api('POST', '/api/drafts', { baseVersionId: id }).catch((e) => toast(e.message, true));
    if (r) { toast('草案已创建'); go(`#/drafts/${r.draftId}`); }
  };
  bindJumps();
}

route();
