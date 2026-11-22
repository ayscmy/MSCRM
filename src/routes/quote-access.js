import { GET, POST, bad } from '../http.js';
import { boundPhone, sendCode, checkCode, grantValue, cookieName } from '../quote-access.js';

const validToken = t => /^[a-f0-9]{16,64}$/.test(String(t || ''));
const maskPhone = p => {
  const s = String(p || '');
  return s.length === 11 ? `${s.slice(0, 3)}****${s.slice(7)}` : (s ? '已绑定' : '');
};

/** 客户查看报价前：拿到需要验证的手机号（脱敏），用于提示 */
GET('/api/quote-access/hint', async ctx => {
  const token = String(ctx.query.token || '');
  if (!validToken(token)) throw bad('链接无效');
  const { phone, email } = await boundPhone(token);
  if (!phone) throw bad('该报价未绑定客户手机号，请联系销售顾问');
  return { ok: true, phoneMasked: maskPhone(phone), emailBound: !!email };
}, { auth: false });

/** 发送短信验证码 */
POST('/api/quote-access/send-code', async ctx => {
  const token = String(ctx.body?.token || '');
  const phone = String(ctx.body?.phone || '');
  if (!validToken(token)) throw bad('链接无效');
  try {
    return await sendCode(token, phone);
  } catch (e) {
    throw bad(e.message);
  }
}, { auth: false });

/** 校验验证码，通过则种短期 cookie（仅对该 token 有效） */
POST('/api/quote-access/verify', async ctx => {
  const token = String(ctx.body?.token || '');
  const phone = String(ctx.body?.phone || '');
  const code = String(ctx.body?.code || '');
  if (!validToken(token)) throw bad('链接无效');
  try {
    await checkCode(token, phone, code);
  } catch (e) {
    throw bad(e.message);
  }
  ctx.res.setHeader('Set-Cookie', `${cookieName(token)}=${grantValue(token, String(phone).trim())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 60}`);
  return { ok: true };
}, { auth: false });
