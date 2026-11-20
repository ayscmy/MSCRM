import { GET, POST, PATCH, DELETE, bad, denied } from '../http.js';
import {
  designerState,
  cloneActiveFlows,
  saveDraftFlow,
  publishDraftFlows,
  restoreOfficialFlows,
  deleteDraftFlow,
  previewFlow
} from '../approval-flow.js';

const requireAdmin = user => {
  if (!user || user.role !== 'admin') throw denied('只有系统管理员可以调整审批流程');
};
const act = async fn => {
  try {
    return await fn();
  } catch (e) {
    throw bad(e.message || '操作失败');
  }
};

GET('/api/settings/approval-flows', async ctx => designerState());

POST('/api/settings/approval-flows/clone-active', async ctx => {
  requireAdmin(ctx.user);
  return await act(() => cloneActiveFlows(ctx.body?.bizType, ctx.user));
});

PATCH('/api/settings/approval-flows/:id', async ctx => {
  requireAdmin(ctx.user);
  return await act(() => saveDraftFlow(Number(ctx.params.id), ctx.body || {}, ctx.user));
});

POST('/api/settings/approval-flows/publish', async ctx => {
  requireAdmin(ctx.user);
  return await act(() => publishDraftFlows(ctx.body?.bizType, ctx.user));
});

POST('/api/settings/approval-flows/restore-official', async ctx => {
  requireAdmin(ctx.user);
  return await act(() => restoreOfficialFlows(ctx.body?.bizType, ctx.user));
});

DELETE('/api/settings/approval-flows/:id', async ctx => {
  requireAdmin(ctx.user);
  return await act(() => deleteDraftFlow(Number(ctx.params.id), ctx.user));
});

POST('/api/settings/approval-flows/preview', async ctx => {
  const b = ctx.body || {};
  return await act(() => previewFlow(b.bizType, b.sample || {}, ctx.user));
});
