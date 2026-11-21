import { state } from '../store.js';
import { renderDesigner } from './approval-flows.js';

// 独立页面：审批流程设计。系统设置只保留阈值/公司抬头/限额/授权。
export async function render(el, route, ctx) {
  await renderDesigner(el, ctx, state.user.role === 'admin');
}
