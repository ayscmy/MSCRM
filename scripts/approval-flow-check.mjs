#!/usr/bin/env node
// 可视化审批流程隔离验收：只用临时 SQLite，不连生产库、不读项目 .env 的生产连接。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'mserm-flow-'));
const dbFile = join(dir, 'crm.db');
process.env.DB_TYPE = 'sqlite';
process.env.CRM_DB = dbFile;

const { migrate, one, all, run, idOf } = await import('../src/db.js');
const { createWorkspace } = await import('../src/setup.js');
const { getSetting } = await import('../src/settings.js');
const { chainForDiscount, chainForContract, createApproval, decide } = await import('../src/approval.js');
const flow = await import('../src/approval-flow.js');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
    console.log('  ✓', name);
  } catch (e) {
    results.push(['FAIL', name, e.message]);
    console.error('  ✗', name, e.message);
    process.exitCode = 1;
  }
}
const rolesOf = chain => chain.map(c => c.role);

await migrate();
const workspace = await createWorkspace({ company: '验收科技', name: '超级管理员', username: 'admin01', password: 'Test12345' });
const admin = { id: workspace.userId, name: '超级管理员', role: 'admin' };

await check('新安装：官方预设 10 条规则全部启用，开关打开', async () => {
  assert.equal(await getSetting('approval.custom.enabled'), '1');
  const s = await flow.designerState();
  assert.equal(s.flows.length, 10);
  assert.ok(s.flows.every(f => f.source === 'official' && f.state === 'active' && f.version === 1));
  assert.ok((await one('select count(*) c from approval_flow_steps')).c >= 20);
});

await check('老实例升级：只跑 DDL 时无规则、开关仍关', async () => {
  const upgradeDb = join(dir, 'upgrade.db');
  const code = `
    process.env.DB_TYPE='sqlite'; process.env.CRM_DB=${JSON.stringify(upgradeDb)};
    const { migrate } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    const { getSetting } = await import(${JSON.stringify(new URL('../src/settings.js', import.meta.url).href)});
    const { one } = await import(${JSON.stringify(new URL('../src/db.js', import.meta.url).href)});
    await migrate();
    console.log(JSON.stringify({ enabled: await getSetting('approval.custom.enabled'), flows: (await one('select count(*) c from approval_flows')).c }));
  `;
  const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { encoding: 'utf8' });
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.enabled, '0');
  assert.equal(r.flows, 0);
});

await check('官方预设与旧链逐节点等价（报价 0/4/6/12%）', async () => {
  for (const rate of [0, 0.04, 0.06, 0.12]) {
    const ctx = await flow.buildApprovalContext('quote_discount', { record: { discount_rate: rate, amount: 500000 }, orgId: null, userId: 1 });
    const custom = await flow.resolveApprovalChain('quote_discount', ctx);
    const actual = custom.meta.autoApprove ? [] : rolesOf(custom.chain);
    const expected = rate === 0 ? [] : rolesOf(await chainForDiscount(rate, null));
    assert.deepEqual(actual, expected, `折扣 ${rate * 100}% 链不一致`);
  }
});

await check('官方预设与旧链逐节点等价（合同金额/账期/非标）', async () => {
  const cases = [
    { amount: 100000, payment_terms: 15, non_standard: 0 },
    { amount: 600000, payment_terms: 15, non_standard: 0 },
    { amount: 1200000, payment_terms: 15, non_standard: 0 },
    { amount: 100000, payment_terms: 15, non_standard: 1 }
  ];
  for (const record of cases) {
    const ctx = await flow.buildApprovalContext('contract', { record, orgId: null, userId: 1 });
    const custom = await flow.resolveApprovalChain('contract', ctx);
    const expected = rolesOf(await chainForContract({ amount: record.amount, paymentTerms: record.payment_terms, nonStandard: !!record.non_standard }));
    assert.deepEqual(rolesOf(custom.chain), expected, JSON.stringify(record));
  }
});

await check('规则首次命中与兜底', async () => {
  const mid = await flow.previewFlow('contract', { amount: 600000, payment_terms: 15 });
  assert.equal(mid.meta.ruleName, '总监审批');
  const high = await flow.previewFlow('contract', { amount: 1200000, payment_terms: 15 });
  assert.equal(high.meta.ruleName, '法务 + 总监');
  assert.equal(high.steps.length, 4);
});

await check('免审批规则：0% 折扣直接通过', async () => {
  const p = await flow.previewFlow('quote_discount', { discount_rate: 0, amount: 1000 });
  assert.equal(p.engine, 'custom');
  assert.equal(p.meta.autoApprove, true);
  assert.equal(p.steps.length, 0);
});

await check('克隆 → 改节点 → 发布：新版本生效', async () => {
  const version = await flow.cloneActiveFlows('quote_discount', admin);
  assert.equal(version, 2);
  const s = await flow.designerState();
  const draft = s.flows.find(f => f.biz_type === 'quote_discount' && f.state === 'draft' && f.name === '大额让价');
  assert.ok(draft);
  const steps = draft.steps.map(x => ({ ...x }));
  steps.push({ ...steps[0], name: '财务复核', role: 'finance', stage: 'finance' });
  await flow.saveDraftFlow(draft.id, { name: '自定义大额', priority: draft.priority, conditions: draft.conditions, autoApprove: false, steps }, admin);
  await flow.publishDraftFlows('quote_discount', admin);
  const ctx = await flow.buildApprovalContext('quote_discount', { record: { discount_rate: 0.12, amount: 500000 }, orgId: null, userId: 1 });
  const r = await flow.resolveApprovalChain('quote_discount', ctx);
  assert.equal(r.meta.flowVersion, 2);
  assert.equal(r.meta.ruleName, '自定义大额');
  assert.equal(r.chain.at(-1).role, 'finance');
});

await check('恢复官方预设：回到 v1 且自定义草稿清除', async () => {
  await flow.restoreOfficialFlows('quote_discount', admin);
  const ctx = await flow.buildApprovalContext('quote_discount', { record: { discount_rate: 0.12, amount: 500000 }, orgId: null, userId: 1 });
  const r = await flow.resolveApprovalChain('quote_discount', ctx);
  assert.equal(r.meta.source, 'official');
  assert.equal(r.meta.flowVersion, 1);
  const s = await flow.designerState();
  assert.equal(s.flows.filter(f => f.biz_type === 'quote_discount' && f.state === 'draft').length, 0);
});

await check('缺人转管理员与相邻重复节点跳过', async () => {
  const r1 = await flow.resolveFlowSteps([{ role: 'legal', label: '法务审核', mode: 'role', on_missing: 'admin' }], null, 999);
  assert.equal(r1.steps[0].approver_id, admin.id);
  const r2 = await flow.resolveFlowSteps([
    { role: 'user', label: 'A', mode: 'user', user_id: admin.id, skip_duplicate: 1, allow_self: 1 },
    { role: 'user', label: 'B', mode: 'user', user_id: admin.id, skip_duplicate: 1, allow_self: 1 }
  ], null, 999);
  assert.equal(r2.steps.length, 1);
});

await check('业务联动与流程留痕：审批通过后报价转 approved', async () => {
  const now = new Date().toISOString();
  const acc = await run(`insert into accounts(name,org_id,created_at,updated_at) values(?,?,?,?)`, '验收客户', 1, now, now);
  const accId = idOf(acc);
  const op = await run(`insert into opportunities(name,account_id,org_id,created_at,updated_at) values(?,?,?,?,?)`, '验收商机', accId, 1, now, now);
  const opId = idOf(op);
  const q = await run(`insert into quotations(no,opportunity_id,account_id,amount,list_amount,discount_rate,cost,status,org_id,created_at,updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?)`, 'Q-FLOW-001', opId, accId, 100000, 100000, 0.1, 80000, 'pending', 1, now, now);
  const qId = idOf(q);
  const { approvalId } = await createApproval({
    type: 'quote_discount', targetType: 'quotation', targetId: qId,
    title: '流程验收', summary: '流程验收', amount: 100000,
    applicantId: admin.id, orgId: 1,
    steps: [{ seq: 1, role: 'admin', label: '系统管理员', approver_id: admin.id, decision: 'pending' }],
    flow: { flowId: 1, version: 1, ruleId: 1, source: 'official' }
  });
  const r = await decide(approvalId, admin, 'approved', '验收通过');
  assert.equal(r.status, 'approved');
  assert.equal((await one('select status from quotations where id=?', qId)).status, 'approved');
  const ap = await one('select flow_id, flow_version, flow_source from approvals where id=?', approvalId);
  assert.equal(ap.flow_source, 'official');
  assert.equal(ap.flow_version, 1);
});

await check('双引擎兼容：DDL 与新增模块无 SQLite 专有写法', async () => {
  const dbSrc = readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
  const flowSrc = readFileSync(new URL('../src/approval-flow.js', import.meta.url), 'utf8');
  for (const token of ['CREATE TABLE IF NOT EXISTS approval_flows', 'CREATE TABLE IF NOT EXISTS approval_flow_steps', "['approvals', 'flow_id'", "['approval_steps', 'approver_mode'"]) {
    assert.ok(dbSrc.includes(token), `db.js 缺少 ${token}`);
  }
  assert.ok(!/insert\s+or\s+replace/i.test(flowSrc));
  assert.ok(!/julianday/i.test(flowSrc));
});

try {
  rmSync(dir, { recursive: true, force: true });
} catch {
  // Windows 上临时库可能被驱动句柄占用，留待系统清理即可
}
const failed = results.filter(r => r[0] === 'FAIL');
console.log(`\n可视化审批流程验收：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
