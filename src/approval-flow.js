import { all, one, run, tx, idOf, nowIso } from './db.js';
import { getSetting, getSettingNum } from './settings.js';
import { chainForDiscount, chainForContract, approverCandidates, resolveChain } from './approval.js';

/* =========================================================
   可视化审批流程
   - 新安装由 setup 写入官方预设（source=official，只读）
   - 超级管理员克隆为草稿，发布后才影响新单据
   - 进行中的审批在 approval_steps 里已有快照，不受配置改动影响
   ========================================================= */

export const BIZ_TYPES = ['quote_discount', 'contract'];
export const BIZ_LABELS = {
  quote_discount: '报价折扣',
  contract: '合同审批'
};
export const ALLOWED_ROLES = ['admin', 'owner', 'gm', 'director', 'manager', 'ae', 'sdr', 'finance', 'legal'];
const STAGES = ['sales', 'finance', 'legal'];
const OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne', 'in'];

export const CONDITION_FIELDS = {
  quote_discount: [
    { key: 'discount_rate', label: '折扣率（%）', type: 'number' },
    { key: 'amount', label: '报价金额（元）', type: 'number' },
    { key: 'has_custom', label: '含例外项', type: 'bool' },
    { key: 'manager_limit', label: '经理可批折扣（%）', type: 'number' },
    { key: 'director_limit', label: '总监可批折扣（%）', type: 'number' },
    { key: 'org_id', label: '组织编号', type: 'number' },
    { key: 'applicant_role', label: '申请人角色', type: 'text' }
  ],
  contract: [
    { key: 'amount', label: '合同金额（元）', type: 'number' },
    { key: 'payment_terms', label: '账期（天）', type: 'number' },
    { key: 'non_standard', label: '非标准条款', type: 'bool' },
    { key: 'has_quotation', label: '关联报价', type: 'bool' },
    { key: 'trigger_director', label: '需总监介入', type: 'bool' },
    { key: 'trigger_legal', label: '需法务介入', type: 'bool' },
    { key: 'org_id', label: '组织编号', type: 'number' },
    { key: 'applicant_role', label: '申请人角色', type: 'text' }
  ]
};

const parseJson = (text, fallback) => {
  try {
    return JSON.parse(text || '') ?? fallback;
  } catch {
    return fallback;
  }
};
const num = v => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function compare(actual, op, expected) {
  if (op === 'in') return Array.isArray(expected) && expected.map(String).includes(String(actual));
  if (op === 'eq') return String(actual) === String(expected);
  if (op === 'ne') return String(actual) !== String(expected);
  const a = num(actual);
  const b = num(expected);
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  if (op === 'lte') return a <= b;
  return false;
}

function matchConditions(conditions, ctx) {
  return conditions.every(c => {
    const field = CONDITION_FIELDS[ctx.bizType]?.find(f => f.key === c.field);
    if (!field) return false;
    return compare(ctx[c.field], c.op, c.value);
  });
}

function validateConditions(bizType, conditions) {
  if (!Array.isArray(conditions)) throw new Error('条件必须是数组');
  const allowed = CONDITION_FIELDS[bizType] || [];
  for (const c of conditions) {
    if (!c || !allowed.some(f => f.key === c.field)) throw new Error(`条件字段不合法：${c?.field || '空'}`);
    if (!OPS.includes(c.op)) throw new Error(`条件运算符不合法：${c.op}`);
    if (c.op === 'in' && !Array.isArray(c.value)) throw new Error('in 条件的值必须是数组');
  }
  return conditions;
}

function validateSteps(bizType, steps, autoApprove) {
  if (!Array.isArray(steps)) throw new Error('节点必须是数组');
  if (autoApprove && steps.length) throw new Error('免审批规则不能带审批节点');
  if (!autoApprove && !steps.length) throw new Error('至少需要一个审批节点');
  for (const [i, s] of steps.entries()) {
    if (!s || !String(s.name || '').trim()) throw new Error(`节点 ${i + 1} 缺少名称`);
    if (s.approver_mode === 'user') {
      if (!s.user_id) throw new Error(`节点 ${i + 1} 未指定审批人`);
    } else if (!ALLOWED_ROLES.includes(s.role)) {
      throw new Error(`节点 ${i + 1} 的角色不合法`);
    }
    if (s.on_missing && !['block', 'admin'].includes(s.on_missing)) throw new Error(`节点 ${i + 1} 的缺人策略不合法`);
    if (s.stage && !STAGES.includes(s.stage)) throw new Error(`节点 ${i + 1} 的阶段不合法`);
  }
  return steps.map((s, i) => ({
    seq: i + 1,
    name: String(s.name).trim(),
    approver_mode: s.approver_mode === 'user' ? 'user' : 'role',
    role: s.approver_mode === 'user' ? null : s.role,
    user_id: s.approver_mode === 'user' ? Number(s.user_id) : null,
    allow_change: s.allow_change ? 1 : 0,
    on_missing: s.on_missing || 'block',
    skip_duplicate: s.skip_duplicate ? 1 : 0,
    allow_self: s.allow_self ? 1 : 0,
    require_comment: s.require_comment ? 1 : 0,
    stage: s.stage || null
  }));
}

/** 默认官方预设：与新装前的内置链完全等价，阈值通过上下文计算字段引用 */
export function officialPreset() {
  const step = (name, role, stage, extra = {}) => ({
    name,
    role,
    stage,
    approver_mode: 'role',
    user_id: null,
    allow_change: 1,
    on_missing: 'block',
    skip_duplicate: 0,
    allow_self: 0,
    require_comment: 0,
    ...extra
  });
  return [
    {
      bizType: 'quote_discount',
      rules: [
        { name: '零折扣免审', priority: 10, conditions: [{ field: 'discount_rate', op: 'eq', value: 0 }], autoApprove: true, fallback: 0, steps: [] },
        { name: '经理审批', priority: 20, conditions: [{ field: 'discount_rate', op: 'gt', value: 0 }, { field: 'discount_rate', op: 'lte', value: '@manager_limit' }], steps: [step('部门经理', 'manager', null)] },
        { name: '经理 + 总监', priority: 30, conditions: [{ field: 'discount_rate', op: 'gt', value: '@manager_limit' }, { field: 'discount_rate', op: 'lte', value: '@director_limit' }], steps: [step('部门经理', 'manager', null), step('销售总监', 'director', null)] },
        { name: '大额让价', priority: 40, conditions: [{ field: 'discount_rate', op: 'gt', value: '@director_limit' }], steps: [step('部门经理', 'manager', null), step('销售总监', 'director', null), step('总经理', 'gm', null)] },
        { name: '兜底规则', priority: 9999, conditions: [], fallback: 1, steps: [step('部门经理', 'manager', null)] }
      ]
    },
    {
      bizType: 'contract',
      rules: [
        { name: '法务 + 总监', priority: 10, conditions: [{ field: 'trigger_legal', op: 'eq', value: 1 }, { field: 'trigger_director', op: 'eq', value: 1 }], steps: [step('部门经理', 'manager', 'sales'), step('销售总监', 'director', 'sales'), step('财务审核', 'finance', 'finance'), step('法务审核', 'legal', 'legal')] },
        { name: '法务介入', priority: 11, conditions: [{ field: 'trigger_legal', op: 'eq', value: 1 }, { field: 'trigger_director', op: 'eq', value: 0 }], steps: [step('部门经理', 'manager', 'sales'), step('财务审核', 'finance', 'finance'), step('法务审核', 'legal', 'legal')] },
        { name: '总监审批', priority: 20, conditions: [{ field: 'trigger_director', op: 'eq', value: 1 }, { field: 'trigger_legal', op: 'eq', value: 0 }], steps: [step('部门经理', 'manager', 'sales'), step('销售总监', 'director', 'sales'), step('财务审核', 'finance', 'finance')] },
        { name: '标准合同', priority: 30, conditions: [{ field: 'trigger_director', op: 'eq', value: 0 }, { field: 'trigger_legal', op: 'eq', value: 0 }], steps: [step('部门经理', 'manager', 'sales'), step('财务审核', 'finance', 'finance')] },
        { name: '兜底规则', priority: 9999, conditions: [], fallback: 1, steps: [step('部门经理', 'manager', 'sales'), step('财务审核', 'finance', 'finance')] }
      ]
    }
  ];
}

/** 预设里的 @阈值 占位符在读取时替换成当前设置值 */
const THRESHOLD_SETTINGS = {
  '@manager_limit': 'approve.discount.manager',
  '@director_limit': 'approve.discount.director'
};
async function resolveConditionValues(conditions) {
  const out = [];
  for (const c of conditions) {
    let value = c.value;
    if (typeof value === 'string' && THRESHOLD_SETTINGS[value]) value = await getSettingNum(THRESHOLD_SETTINGS[value]);
    out.push({ ...c, value });
  }
  return out;
}

export async function buildApprovalContext(bizType, payload = {}) {
  const record = payload.record || payload || {};
  const orgId = payload.orgId ?? record.org_id ?? null;
  const applicantId = payload.userId ?? payload.applicantId ?? record.owner_id ?? null;
  const ctx = {
    bizType,
    orgId,
    applicantId,
    applicant_role: payload.applicantRole || null,
    org_id: orgId,
    amount: num(record.amount),
    has_custom: record.has_custom ? 1 : 0,
    non_standard: payload.nonStandard ? 1 : (record.non_standard ? 1 : 0),
    has_quotation: record.has_quotation ? 1 : (record.quotation_id ? 1 : 0)
  };
  if (bizType === 'quote_discount') {
    ctx.discount_rate = num(record.discount_rate) * 100;
    const mgr = orgId ? (await approverCandidates(orgId, 'manager'))[0] : null;
    const dir = orgId ? (await approverCandidates(orgId, 'director'))[0] : null;
    ctx.manager_limit = mgr && mgr.discount_limit !== null && mgr.discount_limit !== undefined ? num(mgr.discount_limit) : await getSettingNum('approve.discount.manager');
    ctx.director_limit = dir && dir.discount_limit !== null && dir.discount_limit !== undefined ? num(dir.discount_limit) : await getSettingNum('approve.discount.director');
  }
  if (bizType === 'contract') {
    ctx.payment_terms = num(record.payment_terms);
    ctx.trigger_director = ctx.amount > (await getSettingNum('approve.contract.amount_director')) || ctx.payment_terms > (await getSettingNum('approve.contract.terms_director')) ? 1 : 0;
    ctx.trigger_legal = ctx.amount > (await getSettingNum('approve.contract.amount_legal')) || ctx.payment_terms > (await getSettingNum('approve.contract.terms_legal')) || ctx.non_standard ? 1 : 0;
  }
  return ctx;
}

export async function seedOfficialFlows(userId = null) {
  const now = nowIso();
  let created = 0;
  for (const preset of officialPreset()) {
    const exists = await one('select id from approval_flows where biz_type = ? and source = ? limit 1', preset.bizType, 'official');
    if (exists) continue;
    for (const r of preset.rules) {
      const ins = await run(`insert into approval_flows(biz_type,name,version,state,source,priority,conditions_json,auto_approve,fallback,created_by,updated_by,created_at,updated_at,published_at)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, preset.bizType, r.name, 1, 'active', 'official', r.priority, JSON.stringify(r.conditions), r.autoApprove ? 1 : 0, r.fallback ? 1 : 0, userId, userId, now, now, now);
      const flowId = idOf(ins);
      for (const [i, s] of r.steps.entries()) {
        await run(`insert into approval_flow_steps(flow_id,seq,name,approver_mode,role,user_id,allow_change,on_missing,skip_duplicate,allow_self,require_comment,stage)
           values(?,?,?,?,?,?,?,?,?,?,?,?)`, flowId, i + 1, s.name, s.approver_mode, s.role || null, s.user_id || null, s.allow_change ? 1 : 0, s.on_missing || 'block', s.skip_duplicate ? 1 : 0, s.allow_self ? 1 : 0, s.require_comment ? 1 : 0, s.stage || null);
      }
      created++;
    }
  }
  return created;
}

async function loadFlows(where = '', params = []) {
  const rows = await all(`select * from approval_flows ${where} order by biz_type, case when state='active' then 0 else 1 end, priority, id`, ...params);
  const ids = rows.map(r => r.id);
  const steps = ids.length ? await all(`select * from approval_flow_steps where flow_id in (${ids.map(() => '?').join(',')}) order by flow_id, seq`, ...ids) : [];
  const byFlow = {};
  for (const s of steps) (byFlow[s.flow_id] ||= []).push(s);
  return rows.map(r => ({
    ...r,
    conditions: parseJson(r.conditions_json, []),
    steps: byFlow[r.id] || []
  }));
}

export async function activeFlows(bizType) {
  return (await loadFlows("where biz_type = ? and state = 'active'", [bizType]));
}

async function adminUser() {
  return await one(`select u.id, u.name, u.title, o.name as org_name from users u
     join user_roles r on r.user_id = u.id and r.role = 'admin'
     join org_units o on o.id = u.org_id where u.status = 'active' order by u.id limit 1`);
}

/** 把配置节点解析成具体人，并应用跳过重复 / 禁止自审 / 缺人转管理员 */
export async function resolveFlowSteps(chain, orgId, applicantId) {
  const resolved = await resolveChain(chain, orgId);
  const used = [];
  const out = [];
  for (const original of resolved.steps) {
    const s = { ...original };
    if (!s.approver_id && s.on_missing === 'admin') {
      const admin = await adminUser();
      if (admin) {
        s.approver_id = admin.id;
        s.approver_name = admin.name;
        s.approver_title = admin.title;
        s.approver_org = admin.org_name;
        s.candidates = [admin];
        s.comment = '无在职审批人，转系统管理员';
      }
    }
    if (s.approver_id && s.skip_duplicate && used.includes(Number(s.approver_id))) continue;
    if (s.approver_id && !s.allow_self && Number(s.approver_id) === Number(applicantId)) {
      const next = (s.candidates || []).find(c => Number(c.id) !== Number(applicantId) && !used.includes(Number(c.id)));
      if (next) {
        s.approver_id = next.id;
        s.approver_name = next.name;
        s.approver_title = next.title;
        s.approver_org = next.org_name;
      } else {
        s.approver_id = null;
        s.approver_name = null;
      }
    }
    if (s.approver_id) used.push(Number(s.approver_id));
    out.push(s);
  }
  out.forEach((s, i) => {
    s.seq = i + 1;
  });
  return {
    steps: out,
    missing: out.filter(s => !s.approver_id).map(s => ({ role: s.role, label: s.label }))
  };
}

/** 链生成主入口：预览与提交共用，保证「看到的就是实际走的」 */
export async function resolveApprovalChain(bizType, context) {
  const enabled = String(await getSetting('approval.custom.enabled')) === '1';
  if (!enabled) {
    const chain = bizType === 'quote_discount'
      ? await chainForDiscount(num(context.discount_rate) / 100, context.orgId)
      : await chainForContract({ amount: context.amount, paymentTerms: context.payment_terms, nonStandard: context.non_standard });
    return { engine: 'legacy', chain, meta: {} };
  }
  const flows = await activeFlows(bizType);
  if (!flows.length) {
    const chain = bizType === 'quote_discount'
      ? await chainForDiscount(num(context.discount_rate) / 100, context.orgId)
      : await chainForContract({ amount: context.amount, paymentTerms: context.payment_terms, nonStandard: context.non_standard });
    return { engine: 'legacy', chain, meta: { fallback: 'no-active-flow' } };
  }
  for (const f of flows) {
    const conditions = await resolveConditionValues(f.conditions || []);
    if (!matchConditions(conditions, context)) continue;
    const chain = (f.steps || []).map(s => ({
      role: s.role,
      label: s.name,
      mode: s.approver_mode,
      user_id: s.user_id,
      flow_step_id: s.id,
      allow_change: s.allow_change !== 0,
      on_missing: s.on_missing || 'block',
      skip_duplicate: s.skip_duplicate === 1,
      allow_self: s.allow_self === 1,
      stage: s.stage || null
    }));
    return {
      engine: 'custom',
      chain,
      meta: {
        flowId: f.id,
        flowVersion: f.version,
        ruleId: f.id,
        ruleName: f.name,
        source: f.source,
        autoApprove: f.auto_approve === 1
      }
    };
  }
  const chain = bizType === 'quote_discount'
    ? await chainForDiscount(num(context.discount_rate) / 100, context.orgId)
    : await chainForContract({ amount: context.amount, paymentTerms: context.payment_terms, nonStandard: context.non_standard });
  return { engine: 'legacy', chain, meta: { fallback: 'no-match' } };
}

async function logChange(user, action, flowId, detail) {
  await run(`insert into audit_logs(user_id,user_name,action,target_type,target_id,detail,ip,created_at)
     values(?,?,?,?,?,?,?,?)`, user?.id || null, user?.name || '', action, 'approval_flow', flowId || null, detail || '', '', nowIso());
}

/** 配置管理接口用的读取入口 */
export async function designerState() {
  const enabled = String(await getSetting('approval.custom.enabled')) === '1';
  const flows = await loadFlows();
  const activeByBiz = {};
  for (const f of flows) if (f.state === 'active') activeByBiz[f.biz_type] = f.version;
  const users = await all(`select u.id, u.name, o.name as org_name,
      (select group_concat(role) from user_roles r where r.user_id = u.id) as roles
     from users u join org_units o on o.id = u.org_id where u.status = 'active' order by o.path, u.id`);
  return {
    enabled,
    flows,
    activeVersions: activeByBiz,
    bizTypes: BIZ_TYPES.map(k => ({ key: k, label: BIZ_LABELS[k] })),
    conditionFields: CONDITION_FIELDS,
    roles: ALLOWED_ROLES,
    users: users.map(u => ({ ...u, roles: String(u.roles || '').split(',').filter(Boolean) }))
  };
}

/** 把当前启用版本整体克隆为可编辑草稿 */
export async function cloneActiveFlows(bizType, user) {
  if (!BIZ_TYPES.includes(bizType)) throw new Error('单据类型不合法');
  const active = await activeFlows(bizType);
  if (!active.length) throw new Error('当前没有启用中的流程可编辑');
  const max = await one('select max(version) v from approval_flows where biz_type = ?', bizType);
  const version = num(max?.v) + 1;
  const now = nowIso();
  await tx(async () => {
    for (const f of active) {
      const ins = await run(`insert into approval_flows(biz_type,name,version,state,source,priority,conditions_json,auto_approve,fallback,created_by,updated_by,created_at,updated_at)
         values(?,?,?,?,?,?,?,?,?,?,?,?,?)`, f.biz_type, f.name, version, 'draft', 'custom', f.priority, f.conditions_json, f.auto_approve, f.fallback, user?.id || null, user?.id || null, now, now);
      const newId = idOf(ins);
      for (const s of f.steps) {
        await run(`insert into approval_flow_steps(flow_id,seq,name,approver_mode,role,user_id,allow_change,on_missing,skip_duplicate,allow_self,require_comment,stage)
           values(?,?,?,?,?,?,?,?,?,?,?,?)`, newId, s.seq, s.name, s.approver_mode, s.role, s.user_id, s.allow_change, s.on_missing, s.skip_duplicate, s.allow_self, s.require_comment, s.stage);
      }
    }
  });
  await logChange(user, 'clone', null, `${BIZ_LABELS[bizType]} 克隆为草稿 v${version}`);
  return version;
}

export async function saveDraftFlow(id, body, user) {
  const f = await one('select * from approval_flows where id=?', id);
  if (!f) throw new Error('流程规则不存在');
  if (f.source !== 'custom' || f.state !== 'draft') throw new Error('只有自定义草稿可以编辑');
  const conditions = validateConditions(f.biz_type, body.conditions ?? parseJson(f.conditions_json, []));
  const autoApprove = body.autoApprove ? 1 : 0;
  const steps = validateSteps(f.biz_type, body.steps || [], autoApprove);
  const name = String(body.name || f.name).trim();
  if (!name) throw new Error('规则名称不能为空');
  await tx(async () => {
    await run('update approval_flows set name=?, priority=?, conditions_json=?, auto_approve=?, updated_by=?, updated_at=? where id=?', name, num(body.priority ?? f.priority), JSON.stringify(conditions), autoApprove, user?.id || null, nowIso(), id);
    await run('delete from approval_flow_steps where flow_id=?', id);
    for (const s of steps) {
      await run(`insert into approval_flow_steps(flow_id,seq,name,approver_mode,role,user_id,allow_change,on_missing,skip_duplicate,allow_self,require_comment,stage)
         values(?,?,?,?,?,?,?,?,?,?,?,?)`, id, s.seq, s.name, s.approver_mode, s.role, s.user_id, s.allow_change, s.on_missing, s.skip_duplicate, s.allow_self, s.require_comment, s.stage);
    }
  });
  await logChange(user, 'update', id, `修改草稿：${name}`);
  return {
    ok: true
  };
}

export async function publishDraftFlows(bizType, user) {
  if (!BIZ_TYPES.includes(bizType)) throw new Error('单据类型不合法');
  const drafts = await loadFlows('where biz_type = ? and state = ?', [bizType, 'draft']);
  if (!drafts.length) throw new Error('没有待发布的草稿');
  if (!drafts.some(f => f.fallback)) throw new Error('缺少兜底规则，不能发布');
  const version = drafts[0].version;
  await tx(async () => {
    await run("update approval_flows set state='disabled' where biz_type=? and state='active'", bizType);
    for (const f of drafts) {
      const conditions = validateConditions(bizType, f.conditions);
      validateSteps(bizType, f.steps, f.auto_approve === 1);
      await run("update approval_flows set state='active', published_at=?, updated_by=?, updated_at=? where id=?", nowIso(), user?.id || null, nowIso(), f.id);
    }
  });
  await logChange(user, 'publish', drafts[0].id, `${BIZ_LABELS[bizType]} 发布 v${version}`);
  return {
    ok: true,
    version
  };
}

export async function restoreOfficialFlows(bizType, user) {
  if (!BIZ_TYPES.includes(bizType)) throw new Error('单据类型不合法');
  const official = await loadFlows('where biz_type = ? and source = ?', [bizType, 'official']);
  if (!official.length) throw new Error('官方预设不存在');
  await tx(async () => {
    await run("update approval_flows set state='disabled' where biz_type=? and state='active'", bizType);
    for (const f of official) await run("update approval_flows set state='active' where id=?", f.id);
    await run("delete from approval_flows where biz_type=? and source='custom' and state='draft'", bizType);
  });
  await logChange(user, 'restore', official[0].id, `${BIZ_LABELS[bizType]} 恢复官方预设`);
  return {
    ok: true
  };
}

export async function deleteDraftFlow(id, user) {
  const f = await one('select * from approval_flows where id=?', id);
  if (!f) throw new Error('流程规则不存在');
  if (f.source !== 'custom' || f.state !== 'draft') throw new Error('只能删除自定义草稿');
  await run('delete from approval_flows where id=?', id);
  await logChange(user, 'delete', id, `删除草稿：${f.name}`);
  return {
    ok: true
  };
}

/** 试运行：只读取配置，不改任何数据 */
export async function previewFlow(bizType, sample, user) {
  if (!BIZ_TYPES.includes(bizType)) throw new Error('单据类型不合法');
  const input = { ...sample, bizType };
  // 试运行表单里填的是百分数（12 表示 12%），库里存的是比率（0.12）
  if (input.discount_rate !== undefined) input.discount_rate = num(input.discount_rate) / 100;
  const ctx = await buildApprovalContext(bizType, input);
  const r = await resolveApprovalChain(bizType, ctx);
  const resolved = await resolveFlowSteps(r.chain, ctx.orgId, ctx.applicantId);
  return {
    bizType,
    engine: r.engine,
    meta: r.meta,
    context: ctx,
    steps: resolved.steps.map(s => ({
      seq: s.seq,
      label: s.label,
      role: s.role,
      mode: s.approver_mode,
      approver_id: s.approver_id,
      approver_name: s.approver_name
    })),
    missing: resolved.missing,
    canEdit: user?.role === 'admin'
  };
}
