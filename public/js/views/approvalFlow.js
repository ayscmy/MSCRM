import { renderDesigner } from './approval-flows.js';

// 独立页面：审批流程展示。官方预设由后端内置提供、只读；系统设置只保留阈值/公司抬头/限额/授权。
export async function render(el, route, ctx) {
  await renderDesigner(el, ctx, false);
}
