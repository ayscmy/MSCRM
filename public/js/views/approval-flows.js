import { api } from '../api.js';
import { esc, toast } from '../ui.js';
import { bindDrag, clearDropHighlight } from '../drag.js';

const OPS = [
  ['gt', '大于 >'], ['gte', '大于等于 ≥'], ['lt', '小于 <'], ['lte', '小于等于 ≤'],
  ['eq', '等于 ='], ['ne', '不等于 ≠'], ['in', '属于列表']
];
const STAGES = [
  ['', '按角色推导'], ['sales', '销售审核'], ['finance', '财务审核'], ['legal', '法务审核']
];
const S = {
  el: null,
  ctx: null,
  canEdit: false,
  data: null,
  biz: 'quote_discount',
  editing: false,
  working: [],
  preview: null,
  sample: { quote_discount: { discount_rate: 12, amount: 500000 }, contract: { amount: 600000, payment_terms: 30 } }
};

const clone = v => JSON.parse(JSON.stringify(v));
const fieldLabel = (biz, key) => {
  const f = (S.data?.conditionFields?.[biz] || []).find(x => x.key === key);
  return f ? f.label : key;
};
const opLabel = op => (OPS.find(x => x[0] === op) || [op, op])[1];
const valueLabel = (c, biz) => {
  const v = c.value;
  if (typeof v === 'string' && v.startsWith('@')) return v === '@manager_limit' ? '经理限额（随设置变化）' : '总监限额（随设置变化）';
  if ((S.data?.conditionFields?.[biz] || []).find(f => f.key === c.field)?.type === 'bool') return Number(v) ? '是' : '否';
  return String(v);
};

function currentFlows() {
  if (S.editing) return S.working;
  const version = S.data?.activeVersions?.[S.biz];
  return (S.data?.flows || []).filter(f => f.biz_type === S.biz && f.state === 'active' && (!version || f.version === version));
}

async function load() {
  S.data = await api.get('/api/settings/approval-flows');
  S.editing = false;
  S.working = [];
  S.preview = null;
}

function ruleCard(f, i, editable) {
  const conds = (f.conditions || []).map(c => `<span class="flow-chip">${esc(fieldLabel(f.biz_type, c.field))} ${esc(opLabel(c.op))} ${esc(valueLabel(c, f.biz_type))}</span>`).join(' ') || '<span class="flow-chip">无条件（兜底）</span>';
  const nodes = (f.steps || []).map((s, j) => `<span class="flow-node" title="${esc(s.name)}">
      <b>${j + 1}</b> ${esc(s.name)}
      <small>${s.approver_mode === 'user' ? esc(userName(s.user_id)) : esc(s.role)}</small>
    </span>`).join('<span class="flow-conn">→</span>');
  const tail = f.auto_approve ? '<span class="flow-node flow-end">免审批</span>' : `<span class="flow-conn">→</span><span class="flow-chip">结束</span>`;
  const badge = f.state === 'active'
    ? `<span class="flow-badge flow-badge-ok">${f.source === 'official' ? '官方预设' : `自定义 v${f.version}`} · 已启用</span>`
    : `<span class="flow-badge">草稿 v${f.version}</span>`;
  return `<div class="flow-lane ${editable ? 'is-editing' : ''}" data-flow-index="${i}">
    <div class="flow-lane-head">
      <span class="flow-grip ${editable && !f.fallback ? 'drag-handle' : ''}" title="${editable && !f.fallback ? '按住拖拽调整优先级' : '优先级'}">⋮⋮</span>
      <input class="flow-priority" type="number" min="1" value="${esc(f.priority)}" data-cprop="priority" data-ci="${i}" ${editable ? '' : 'disabled'} />
      <b class="flow-name">${esc(f.name)}</b>
      ${badge}
      ${editable ? `<button class="btn btn-sm" data-act="del-rule" data-i="${i}">删除</button>` : ''}
    </div>
    <div class="flow-line"><span class="flow-line-label">条件</span>${conds}</div>
    <div class="flow-line"><span class="flow-line-label">节点</span>${nodes || '<span class="muted">—</span>'}${tail}</div>
  </div>`;
}

function userName(id) {
  const u = (S.data?.users || []).find(x => Number(x.id) === Number(id));
  return u ? `${u.name}（${u.org_name}）` : '指定人已失效';
}

function editorPanel(f, i) {
  if (!f) return '<div class="muted">选择左侧规则进行编辑</div>';
  const fields = S.data.conditionFields[S.biz] || [];
  const roles = S.data.roles || [];
  const users = S.data.users || [];
  return `<div class="flow-prop-title">规则 ${i + 1}：${esc(f.name)}</div>
    <div class="field"><label>规则名称</label><input class="input" value="${esc(f.name)}" data-sprop="name" data-si="${i}" /></div>
    <div class="field"><label>免审批（命中后直接通过）</label>
      <label class="chk"><input type="checkbox" data-sprop="auto_approve" data-si="${i}" ${f.auto_approve ? 'checked' : ''} /> 本规则不设审批节点</label></div>
    <div class="flow-sub">条件（全部满足才命中）</div>
    ${(f.conditions || []).map((c, j) => `<div class="flow-cond-row">
      <select data-cprop="field" data-ci="${i}" data-cj="${j}">${fields.map(x => `<option value="${x.key}" ${c.field === x.key ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select>
      <select data-cprop="op" data-ci="${i}" data-cj="${j}">${OPS.map(x => `<option value="${x[0]}" ${c.op === x[0] ? 'selected' : ''}>${esc(x[1])}</option>`).join('')}</select>
      <input data-cprop="value" data-ci="${i}" data-cj="${j}" value="${esc(c.value)}" />
      <button class="btn btn-sm" data-act="del-cond" data-i="${i}" data-j="${j}">×</button>
    </div>`).join('')}
    <button class="btn btn-sm" data-act="add-cond" data-i="${i}">+ 条件</button>
    <div class="flow-sub">审批节点（按顺序执行）</div>
    ${(f.steps || []).map((s, j) => `<div class="flow-step-edit" data-step="${j}" data-step-drop="${j}">
      <div class="flow-step-head"><span class="flow-step-grip drag-handle" data-step-grip="${j}" title="按住拖拽调整节点顺序">⋮⋮</span><b>${j + 1}</b><input class="input" value="${esc(s.name)}" data-sprop="step_name" data-si="${i}" data-sj="${j}" />
        <button class="btn btn-sm" data-act="del-step" data-i="${i}" data-j="${j}">×</button></div>
      <div class="flow-grid2">
        <label>审批人来源<select data-sprop="approver_mode" data-si="${i}" data-sj="${j}">
          <option value="role" ${s.approver_mode !== 'user' ? 'selected' : ''}>按角色（组织树）</option>
          <option value="user" ${s.approver_mode === 'user' ? 'selected' : ''}>指定用户</option></select></label>
        ${s.approver_mode === 'user'
          ? `<label>指定人<select data-sprop="user_id" data-si="${i}" data-sj="${j}"><option value="">请选择</option>${users.map(u => `<option value="${u.id}" ${Number(s.user_id) === Number(u.id) ? 'selected' : ''}>${esc(u.name)} · ${esc(u.org_name)}</option>`).join('')}</select></label>`
          : `<label>角色<select data-sprop="role" data-si="${i}" data-sj="${j}">${roles.map(r => `<option value="${r}" ${s.role === r ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>`}
      </div>
      <div class="flow-grid2">
        <label>缺人时<select data-sprop="on_missing" data-si="${i}" data-sj="${j}">
          <option value="block" ${s.on_missing !== 'admin' ? 'selected' : ''}>阻止提交</option>
          <option value="admin" ${s.on_missing === 'admin' ? 'selected' : ''}>转系统管理员</option></select></label>
        <label>合同阶段<select data-sprop="stage" data-si="${i}" data-sj="${j}">${STAGES.map(x => `<option value="${x[0]}" ${(s.stage || '') === x[0] ? 'selected' : ''}>${esc(x[1])}</option>`).join('')}</select></label>
      </div>
      <div class="flow-toggles">
        ${[['allow_change', '允许改选'], ['skip_duplicate', '跳过重复'], ['allow_self', '允许自审'], ['require_comment', '意见必填']].map(([k, label]) =>
          `<label class="chk"><input type="checkbox" data-sprop="${k}" data-si="${i}" data-sj="${j}" ${Number(s[k]) ? 'checked' : ''} /> ${label}</label>`).join('')}
      </div>
    </div>`).join('')}
    ${f.auto_approve ? '' : '<button class="btn btn-sm" data-act="add-step" data-i="${i}">+ 审批节点</button>'}
    ${f.auto_approve ? '' : `<div class="flow-sub">拖拽下方角色或人员到节点上，即可指定审批人</div>
    <div class="flow-approver-pool">
      ${roles.map(r => `<span class="flow-approver-chip drag-handle" data-approver-mode="role" data-approver-id="${esc(r)}" title="拖到上方节点指定审批人">${esc(r)}</span>`).join('')}
      ${users.slice(0, 40).map(u => `<span class="flow-approver-chip drag-handle" data-approver-mode="user" data-approver-id="${u.id}" title="拖到上方节点指定审批人">${esc(u.name)}</span>`).join('')}
    </div>
    ${users.length > 40 ? `<div class="muted" style="font-size:10.5px;margin-top:4px">仅显示前 40 位人员，更多人员请用节点属性里的下拉框选择</div>` : ''}`}`;
}

function previewPanel() {
  const b = S.biz;
  const sample = S.sample[b] || {};
  const inputs = b === 'quote_discount'
    ? `<label>折扣率（%）<input class="input" type="number" step="0.5" data-sample="discount_rate" value="${esc(sample.discount_rate ?? 0)}" /></label>
       <label>报价金额（元）<input class="input" type="number" step="10000" data-sample="amount" value="${esc(sample.amount ?? 0)}" /></label>`
    : `<label>合同金额（元）<input class="input" type="number" step="10000" data-sample="amount" value="${esc(sample.amount ?? 0)}" /></label>
       <label>账期（天）<input class="input" type="number" data-sample="payment_terms" value="${esc(sample.payment_terms ?? 0)}" /></label>
       <label class="chk"><input type="checkbox" data-sample="non_standard" ${sample.non_standard ? 'checked' : ''} /> 非标准条款</label>`;
  const p = S.preview;
  const result = !p ? '<div class="muted">填入样例后点「试运行」，查看命中规则与实际审批人。</div>'
    : `<div class="flow-result-line">引擎：<b>${p.engine === 'custom' ? '可视化流程' : '旧阈值链'}</b>${p.rule ? ` · 命中：<b>${esc(p.rule)}</b>` : ''}</div>
       <div class="flow-result-line">${p.steps.length ? p.steps.map((s, i) => `${i + 1}. ${esc(s.label)}${s.approver_name ? ` → ${esc(s.approver_name)}` : ' → <span class="flow-warn">缺人</span>'}`).join('<br>') : '本规则免审批，直接通过'}</div>
       ${p.missing?.length ? `<div class="flow-warn">缺少审批人：${p.missing.map(m => esc(m.label)).join('、')}</div>` : ''}`;
  return `<div class="flow-preview">
    <div class="flow-sub">试运行（只读）</div>
    <div class="flow-grid2">${inputs}</div>
    <button class="btn btn-sm" data-act="preview">试运行</button>
    ${result}
  </div>`;
}

function render() {
  if (!S.el || !S.data) return;
  const flows = currentFlows();
  const active = S.data.activeVersions?.[S.biz];
  const draft = (S.data.flows || []).filter(f => f.biz_type === S.biz && f.state === 'draft');
  const draftVersion = draft.length ? draft[0].version : null;
  const status = S.editing ? `草稿 v${draftVersion}` : (active ? `官方/自定义 v${active} · 已启用` : '未启用（旧阈值链）');
  S.el.innerHTML = `<div class="flow-design">
    <div class="flow-head">
      <div><h3>审批流程设计器 <span class="flow-status">${esc(status)}</span></h3>
        <p class="muted">新安装默认使用官方预设；超级管理员可克隆为草稿后可视化调整，发布才影响新单据。</p></div>
      <div class="flow-actions">
        ${S.canEdit && !S.editing ? `<button class="btn btn-primary btn-sm" data-act="edit">可视化编辑</button>` : ''}
        ${S.canEdit && S.editing ? `<button class="btn btn-primary btn-sm" data-act="save">保存草稿</button><button class="btn btn-sm" data-act="publish">发布</button><button class="btn btn-sm" data-act="cancel">取消</button>` : ''}
        ${S.canEdit && !S.editing ? `<button class="btn btn-sm" data-act="restore">恢复官方预设</button>` : ''}
      </div>
    </div>
    <div class="flow-tabs">${(S.data.bizTypes || []).map(t => `<button class="btn btn-sm ${t.key === S.biz ? 'is-active' : ''}" data-act="tab" data-biz="${t.key}">${esc(t.label)}</button>`).join('')}</div>
    <div class="flow-body">
      <div class="flow-canvas">
        ${flows.map((f, i) => ruleCard(f, i, S.editing)).join('') || '<div class="muted">当前没有配置，走旧阈值链。</div>'}
        ${S.editing ? '<button class="btn btn-sm" data-act="add-rule">+ 新建规则</button>' : ''}
      </div>
      <div class="flow-side">
        ${S.editing ? editorPanel(S.working[S.selected], S.selected) : previewPanel()}
      </div>
    </div>
    ${S.editing ? previewPanel() : ''}
  </div>`;
  bind();
}

function bind() {
  S.el.querySelectorAll('[data-act]').forEach(btn => {
    btn.onclick = async () => {
      const act = btn.dataset.act;
      const i = Number(btn.dataset.i);
      const j = Number(btn.dataset.j);
      try {
        if (act === 'tab') {
          S.biz = btn.dataset.biz;
          S.preview = null;
          S.selected = 0;
          await load();
          return render();
        }
        if (act === 'edit') {
          await api.post('/api/settings/approval-flows/clone-active', { bizType: S.biz });
          await load();
          const draft = S.data.flows.filter(f => f.biz_type === S.biz && f.state === 'draft');
          S.working = clone(draft);
          S.selected = 0;
          S.editing = true;
          toast('已复制当前流程为草稿，修改后点发布生效', 'ok');
          return render();
        }
        if (act === 'save') {
          for (const f of S.working) {
            await api.patch(`/api/settings/approval-flows/${f.id}`, {
              name: f.name, priority: f.priority, conditions: f.conditions,
              autoApprove: !!f.auto_approve, steps: f.steps
            });
          }
          toast('草稿已保存', 'ok');
          await load();
          const draft = S.data.flows.filter(f => f.biz_type === S.biz && f.state === 'draft');
          S.working = clone(draft);
          S.editing = true;
          return render();
        }
        if (act === 'publish') {
          await api.post('/api/settings/approval-flows/publish', { bizType: S.biz });
          S.ctx?.refresh?.();
          await load();
          S.editing = false;
          toast('流程已发布，新单据按新流程执行', 'ok');
          return render();
        }
        if (act === 'restore') {
          if (!confirm('恢复官方预设？当前启用的自定义版本会停用，进行中的审批不受影响。')) return;
          await api.post('/api/settings/approval-flows/restore-official', { bizType: S.biz });
          S.ctx?.refresh?.();
          await load();
          toast('已恢复官方预设', 'ok');
          return render();
        }
        if (act === 'cancel') {
          S.editing = false;
          S.working = [];
          await load();
          return render();
        }
        if (act === 'del-rule') {
          S.working.splice(i, 1);
          S.selected = Math.max(0, Math.min(S.selected, S.working.length - 1));
          return render();
        }
        if (act === 'add-cond') {
          const fields = S.data.conditionFields[S.biz] || [];
          S.working[i].conditions.push({ field: fields[0]?.key || 'amount', op: 'gt', value: 0 });
          return render();
        }
        if (act === 'del-cond') {
          S.working[i].conditions.splice(j, 1);
          return render();
        }
        if (act === 'add-step') {
          S.working[i].steps.push({ name: '新节点', approver_mode: 'role', role: 'manager', user_id: null, allow_change: 1, on_missing: 'block', skip_duplicate: 0, allow_self: 0, require_comment: 0, stage: '' });
          return render();
        }
        if (act === 'del-step') {
          S.working[i].steps.splice(j, 1);
          return render();
        }
        if (act === 'preview') {
          const sample = {};
          S.el.querySelectorAll('[data-sample]').forEach(inp => {
            sample[inp.dataset.sample] = inp.type === 'checkbox' ? (inp.checked ? 1 : 0) : (inp.value === '' ? 0 : Number(inp.value));
          });
          S.sample[S.biz] = sample;
          S.preview = await api.post('/api/settings/approval-flows/preview', { bizType: S.biz, sample });
          return render();
        }
      } catch (e) {
        toast(e.message || '操作失败', 'err');
      }
    };
  });
  S.el.querySelectorAll('[data-flow-index]').forEach(lane => {
    lane.onclick = e => {
      if (e.target.closest('[data-act]') || e.target.closest('input') || e.target.closest('select') || e.target.closest('.flow-grip') || e.target.closest('.flow-step-grip')) return;
      if (!S.editing) return;
      S.selected = Number(lane.dataset.flowIndex);
      render();
    };
  });
  S.el.querySelectorAll('[data-cprop]').forEach(inp => {
    inp.onchange = () => {
      const i = Number(inp.dataset.ci);
      const j = inp.dataset.cj;
      const prop = inp.dataset.cprop;
      if (prop === 'priority') {
        S.working[i].priority = Number(inp.value) || 1;
        return render();
      }
      const c = S.working[i]?.conditions?.[j];
      if (!c) return;
      c[prop] = prop === 'value' && !Number.isNaN(Number(inp.value)) ? Number(inp.value) : inp.value;
      render();
    };
  });
  S.el.querySelectorAll('[data-sprop]').forEach(inp => {
    inp.onchange = () => {
      const i = Number(inp.dataset.si);
      const j = inp.dataset.sj;
      const prop = inp.dataset.sprop;
      const f = S.working[i];
      if (!f) return;
      if (prop === 'name') f.name = inp.value;
      else if (prop === 'auto_approve') f.auto_approve = inp.checked ? 1 : 0;
      else if (prop === 'step_name') f.steps[j].name = inp.value;
      else if (inp.type === 'checkbox') f.steps[j][prop] = inp.checked ? 1 : 0;
      else f.steps[j][prop] = prop === 'user_id' ? Number(inp.value) : inp.value;
      if (prop === 'approver_mode') {
        const s = f.steps[j];
        if (s.approver_mode === 'user') s.role = null;
        else s.user_id = null;
      }
      render();
    };
  });

  // —— 规则排序（鼠标拖拽，兼容内嵌 WebView）——
  if (S.editing) {
    bindDrag({
      container: S.el,
      handle: '.flow-grip.drag-handle',
      selector: '.flow-lane',
      payload: h => Number(h.closest('[data-flow-index]')?.dataset.flowIndex),
      onHover: t => { clearDropHighlight('ptr-over'); if (t) t.classList.add('ptr-over'); },
      onDrop: (from, target) => {
        if (Number.isNaN(from)) return;
        const to = Number(target.dataset.flowIndex);
        const tgt = S.working[to];
        const insertAt = tgt?.fallback ? S.working.findIndex(f => f.fallback) : to;
        if (from === insertAt || insertAt < 0) return;
        const [moved] = S.working.splice(from, 1);
        S.working.splice(insertAt, 0, moved);
        S.working.forEach((f, idx) => { f.priority = f.fallback ? 9999 : (idx + 1) * 10; });
        S.selected = insertAt;
        render();
      }
    });

    // —— 节点排序 ——
    bindDrag({
      container: S.el,
      handle: '.flow-step-grip.drag-handle',
      selector: '.flow-step-edit',
      payload: h => Number(h.dataset.stepGrip),
      onHover: t => { clearDropHighlight('ptr-over'); if (t) t.classList.add('ptr-over'); },
      onDrop: (from, target) => {
        const to = Number(target.dataset.stepDrop);
        const steps = S.working[S.selected]?.steps || [];
        if (Number.isNaN(from) || from === to || !steps[from]) return;
        const [moved] = steps.splice(from, 1);
        steps.splice(to, 0, moved);
        render();
      }
    });

    // —— 审批人池 → 节点（指定审批人）——
    bindDrag({
      container: S.el,
      handle: '.flow-approver-chip.drag-handle',
      selector: '.flow-step-edit',
      payload: h => ({ mode: h.dataset.approverMode, id: h.dataset.approverId }),
      onHover: t => { clearDropHighlight('ptr-over'); if (t) t.classList.add('ptr-over'); },
      onDrop: (who, target) => {
        const to = Number(target.dataset.stepDrop);
        const s = S.working[S.selected]?.steps?.[to];
        if (!who || !s) return;
        if (who.mode === 'role') {
          s.approver_mode = 'role'; s.role = who.id; s.user_id = null;
        } else {
          s.approver_mode = 'user'; s.user_id = Number(who.id); s.role = null;
        }
        render();
      }
    });
  }
}

export async function renderDesigner(el, ctx, canEdit) {
  S.el = el;
  S.ctx = ctx;
  S.canEdit = !!canEdit;
  if (!S.data) await load();
  render();
}
