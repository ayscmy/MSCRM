import './src/env.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { createReadStream } from 'node:fs';
import { migrate, DB_LABEL, DB_ENGINE } from './src/db.js';
import { setupNeeded } from './src/setup.js';
import { dispatch, HttpError, parseCookies } from './src/http.js';
import { getSession, createSession, COOKIE } from './src/auth.js';
import { DEMO_MODE, demoAccount } from './src/demo.js';
import { findQuoteByToken, renderSheetHtml } from './src/doc/quote-sheet.js';
import { verifyGrant, cookieName, boundPhone } from './src/quote-access.js';
import { startTrialJanitor, TRIAL_DAYS, TRIAL_RETAIN_DAYS, TRIAL_URL } from './src/trial.js';
import { startPoolJanitor, poolBanner } from './src/pool.js';
import './src/routes/index.js';

const PORT = Number(process.env.PORT || 8081);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = join(process.cwd(), 'public');

await migrate();
// 启动横幅要打印当前生效的公海规则；migrate 之后 settings 表才一定存在
const POOL_BANNER = await poolBanner();
if (await setupNeeded()) {
  console.log('[init] 检测到空数据库，请打开安装向导完成初始化：/setup.html');
}

/** 报价单短信验证页：手机号 + 验证码，验证通过后回跳原链接 */
function quoteVerifyPage(token, phoneMasked, quoteNo) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>验证手机号 · 查看报价单</title>
<style>
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; padding:20px;
    background:#eef1f6; color:#1b1f27; font:14px/1.7 "Microsoft YaHei","PingFang SC",sans-serif; }
  .box { width:100%; max-width:420px; background:#fff; border-radius:14px; padding:30px 28px;
    box-shadow:0 10px 36px rgba(17,24,39,.11); }
  .logo { font-size:13px; color:#2b4a8b; font-weight:700; letter-spacing:.5px; margin-bottom:16px; }
  h1 { font-size:19px; margin:0 0 6px; }
  .sub { color:#6b7280; font-size:13px; margin:0 0 22px; }
  .no { background:#f4f6fa; border-radius:8px; padding:9px 12px; font-size:12.5px; color:#3c4353; margin-bottom:18px; }
  .no b { font-family:Consolas,monospace; color:#1b1f27; }
  label { display:block; font-size:12.5px; color:#3c4353; margin:14px 0 6px; }
  .row { display:flex; gap:8px; }
  input { flex:1; min-width:0; height:42px; padding:0 12px; border:1px solid #ccd4e0; border-radius:8px;
    font-size:14px; outline:none; }
  input:focus { border-color:#2b4a8b; box-shadow:0 0 0 3px rgba(43,74,139,.1); }
  button { height:42px; padding:0 16px; border:none; border-radius:8px; cursor:pointer; font-size:13.5px; white-space:nowrap; }
  .code { background:#eef2fa; color:#2b4a8b; border:1px solid #d7e0f2; }
  .code:disabled { opacity:.6; cursor:default; }
  .submit { width:100%; margin-top:22px; background:#2b4a8b; color:#fff; font-size:15px; font-weight:600; }
  .submit:disabled { opacity:.6; cursor:default; }
  .msg { margin-top:14px; font-size:12.5px; min-height:20px; color:#c0392b; }
  .msg.ok { color:#1e8e5a; }
  .tip { margin-top:18px; padding-top:14px; border-top:1px solid #eef1f6; font-size:12px; color:#9aa1ad; }
</style></head>
<body>
  <div class="box">
    <div class="logo">报价单安全查看</div>
    <h1>验证手机号</h1>
    <p class="sub">为保护商业信息，本报价需验证客户手机号后才能查看原件。</p>
    <div class="no">报价单号 <b>${escHtml(quoteNo)}</b> · 绑定手机 ${escHtml(phoneMasked)}</div>
    <label>客户手机号</label>
    <input id="phone" inputmode="numeric" maxlength="11" placeholder="请输入绑定手机号" />
    <label>短信验证码</label>
    <div class="row">
      <input id="code" inputmode="numeric" maxlength="6" placeholder="6 位验证码" />
      <button class="code" id="send">获取验证码</button>
    </div>
    <button class="submit" id="ok">验证并查看报价</button>
    <div class="msg" id="msg"></div>
    <div class="tip">验证码仅发送给该报价绑定的客户手机号，5 分钟内有效。如非本人，请联系销售顾问重新发送报价。</div>
  </div>
<script>
  const TOKEN = ${JSON.stringify(token)};
  const $ = id => document.getElementById(id);
  const msg = (t, ok) => { const e=$('msg'); e.textContent=t; e.className='msg'+(ok?' ok':''); };
  async function post(path, body) {
    const r = await fetch(path, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    let d = {}; try { d = await r.json(); } catch {}
    if (!r.ok) throw new Error(d.error || '请求失败');
    return d;
  }
  $('send').onclick = async () => {
    const phone = $('phone').value.trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) return msg('请输入正确的手机号');
    const btn = $('send'); btn.disabled = true; btn.textContent = '发送中…';
    try {
      const d = await post('/api/quote-access/send-code', { token: TOKEN, phone });
      msg(d.simulated ? '验证码已生成（演示模式）：' + d.devCode : '验证码已发送，请查收短信', true);
      let s = 60; const timer = setInterval(() => { btn.textContent = s + ' 秒后重发'; if (--s <= 0) { clearInterval(timer); btn.disabled = false; btn.textContent = '重新获取'; } }, 1000);
    } catch (e) { msg(e.message); btn.disabled = false; btn.textContent = '获取验证码'; }
  };
  $('ok').onclick = async () => {
    const phone = $('phone').value.trim(), code = $('code').value.trim();
    if (!/^1[3-9]\\d{9}$/.test(phone)) return msg('请输入正确的手机号');
    if (!/^\\d{6}$/.test(code)) return msg('请输入 6 位验证码');
    const btn = $('ok'); btn.disabled = true; btn.textContent = '验证中…';
    try {
      await post('/api/quote-access/verify', { token: TOKEN, phone, code });
      location.href = '/q/' + TOKEN;
    } catch (e) { msg(e.message); btn.disabled = false; btn.textContent = '验证并查看报价'; }
  };
</script>
</body></html>`;
}

const escHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(req, res, pathname) {
  if (pathname === '/') {
    // setupNeeded / getSession 都是异步的，漏 await 会拿到 Promise：
    // Promise 恒为真 → 所有请求都被重定向到安装向导
    if (await setupNeeded()) {
      res.writeHead(302, { Location: '/setup.html' });
      return res.end();
    }
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const session = await getSession(token);
    res.writeHead(302, { Location: session ? '/app.html' : '/login.html' });
    return res.end();
  }
  // 还没初始化时，登录页直接引导到安装向导
  if (pathname === '/login.html' && await setupNeeded()) {
    res.writeHead(302, { Location: '/setup.html' });
    return res.end();
  }
  // 已初始化后，安装向导不再可用
  if (pathname === '/setup.html' && !(await setupNeeded())) {
    res.writeHead(302, { Location: '/login.html' });
    return res.end();
  }
  if (pathname === '/favicon.ico') {
    res.writeHead(204).end();
    return;
  }
  const full = normalize(join(PUBLIC, decodeURIComponent(pathname)));
  if (!full.startsWith(PUBLIC)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const st = await stat(full);
    if (!st.isFile()) throw new Error('not a file');
    // 协商缓存：文件一变就失效，避免改动后浏览器仍跑旧脚本
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }).end();
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full)] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-cache',
      ETag: etag,
      'Last-Modified': st.mtime.toUTCString(),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'SAMEORIGIN',
    });
    createReadStream(full).pipe(res);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 页面不存在');
  }
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    '';
  const url = new URL(req.url, 'http://localhost');
  try {
    // 客户查看报价单：/q/<token> —— 绑定手机时须短信验证，1对1才可看原件
    if (url.pathname.startsWith('/q/')) {
      const token = url.pathname.slice(3).replace(/\/+$/, '');
      const data = /^[a-f0-9]{16,64}$/.test(token) ? await findQuoteByToken(token) : null;
      if (!data || !['approved', 'converted'].includes(data.q.status)) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(`<!doctype html><meta charset="utf-8"><title>报价单不存在</title>
          <div style="font:14px/1.8 'Microsoft YaHei',sans-serif;color:#444;text-align:center;margin-top:120px">
            <div style="font-size:18px;font-weight:600;margin-bottom:8px">报价单不存在或已失效</div>
            <div style="color:#888">链接可能已过期，请联系您的销售顾问重新获取。</div></div>`);
        return;
      }
      // 该报价是否强制短信验证：发送时绑定了手机号才开启（老报价无绑定则放行，保持兼容）
      const bound = await boundPhone(token);
      if (bound.phone) {
        const cookies = parseCookies(req.headers.cookie);
        const ok = await verifyGrant(cookies[cookieName(token)], token);
        if (!ok) {
          const q = data.q;
          const mask = bound.phone.length === 11 ? `${bound.phone.slice(0, 3)}****${bound.phone.slice(7)}` : '已绑定手机';
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(quoteVerifyPage(token, mask, String(q.no || '')));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(await renderSheetHtml(data, { autoPrint: url.searchParams.get('print') === '1' }));
      return;
    }

    // 官网「在线测试」：一次性签发演示账号会话，不用访客记密码
    if (url.pathname === '/demo') {
      const acct = (await setupNeeded()) ? null : await demoAccount();
      if (!acct) {
        res.writeHead(302, { Location: '/login.html?demo=off', 'Cache-Control': 'no-store' });
        return res.end();
      }
      const token = await createSession(acct, ip, req.headers['user-agent']);
      res.writeHead(302, {
        Location: '/app.html#/dashboard',
        'Cache-Control': 'no-store',
        'Set-Cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${4 * 3600}`,
      });
      return res.end();
    }

    // 健康检查：编排器 / Nginx / 监控用，不鉴权、不碰业务表
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        service: 'mserm-crm',
        db: DB_ENGINE,
        uptime: Math.round(process.uptime()),
        now: new Date().toISOString(),
      }));
      return;
    }

    if (req.url.startsWith('/api/')) {
      const out = await dispatch(req, res, { ip });
      if (!res.writableEnded && !res.headersSent) {
        // 路由里可以用 ctx.res.statusCode 指定 201 / 204 之类的状态码
        res.writeHead(res.statusCode || 200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(out ?? { ok: true }));
      }
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    if (err instanceof HttpError) {
      if (!res.writableEnded) {
        res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message, detail: err.detail }));
      }
    } else {
      console.error('[500]', req.method, req.url, err);
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '服务器内部错误' }));
      }
    }
  } finally {
    if (process.env.CRM_LOG !== '0' && req.url.startsWith('/api/')) {
      console.log(`${req.method} ${req.url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n[启动失败] 端口 ${PORT} 已被占用。`);
    console.error('请修改 .env 里的 PORT（例如 8082），或先停掉占用该端口的进程。\n');
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  MSERM CRM 网络版已启动');
  console.log(`  本机访问   http://localhost:${PORT}`);
  console.log(`  局域网访问 http://<本机IP>:${PORT}`);
  console.log(`  数据库     ${DB_LABEL}`);
  console.log(`  试用账号   ${process.env.TRIAL_API_KEY ? `已开启（${TRIAL_DAYS} 天试用 → 冻结保留 ${TRIAL_RETAIN_DAYS} 天 → 回收）` : '未配置 TRIAL_API_KEY，官网无法自助开通'}`);
  console.log(`  ${POOL_BANNER}`);
  console.log('');
});

// 过期试用账号兜底清理（官网每小时也会调一次内部接口，两边互为保险）
startTrialJanitor();
// 线索公海双时钟回收：每小时一次，与试用清理并列注册
startPoolJanitor();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭服务...');
    server.close(() => process.exit(0));
  });
}
