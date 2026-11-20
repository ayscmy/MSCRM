import { GET, POST } from '../http.js';
import { installInfo, createWorkspace } from '../setup.js';

/** 安装状态：登录页与安装向导都靠它决定跳哪里 */
GET('/api/setup/status', async () => {
  const info = await installInfo();
  return {
    ...info,
    // 本实例地址：报价单分享链接、邮件里的链接用它
    siteUrl: process.env.SITE_URL || 'http://localhost:8099',
    // 官网地址：注册会员、购买、升级都跳这里，**不受 SITE_URL 影响**
    officialUrl: (process.env.OFFICIAL_URL || 'https://aioffice.aiemy.com').replace(/\/+$/, ''),
    edition: process.env.CRM_EDITION || 'community'
  };
}, {
  auth: false
});

/** 创建第一个集团与管理员；只在空库时可用 */
POST('/api/setup', async ctx => {
  const r = await createWorkspace(ctx.body || {});
  return {
    ok: true,
    ...r
  };
}, {
  auth: false
});