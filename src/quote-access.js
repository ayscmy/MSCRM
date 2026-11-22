/**
 * 报价单客户查看的短信验证（1对1）：
 * - 报价发送时把绑定的手机号/邮箱写到 quotations.view_phone / view_email；
 * - 客户打开 /q/<token> 时若未验证，需输入该手机号并获取短信验证码；
 * - 验证码校验通过后签发一个短期 HMAC cookie，仅对该 token 有效，随后才显示原件。
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { one, run } from './db.js';
import { sendSms } from './sms.js';
import { getSetting } from './settings.js';

const SECRET = String(process.env.CRM_SECRET || 'mserm-quote-access-secret');
const COOKIE_PREFIX = 'qv_';
const TTL_MS = 30 * 60 * 1000; // 验证通过后 30 分钟内可查看
const CODE_TTL_MS = 5 * 60 * 1000; // 验证码 5 分钟有效

const nowIso = () => new Date().toISOString();
const key = () => createHmac('sha256', SECRET);

function sign(token, phone, exp) {
  return key().update(`${token}|${phone}|${exp}`).digest('hex');
}

/** 校验通过后签发 cookie 值：base64(token|phone|exp|sig) */
export function grantValue(token, phone) {
  const exp = Date.now() + TTL_MS;
  const sig = sign(token, phone, exp);
  return Buffer.from(`${token}|${phone}|${exp}|${sig}`, 'utf8').toString('base64url');
}

/** 校验 cookie 是否对该 token 有效（手机号需与报价绑定一致） */
export async function verifyGrant(raw, token) {
  if (!raw) return false;
  let parts;
  try {
    parts = Buffer.from(String(raw), 'base64url').toString('utf8').split('|');
  } catch {
    return false;
  }
  if (parts.length !== 4) return false;
  const [t, phone, expStr, sig] = parts;
  if (t !== token) return false;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expect = sign(t, phone, exp);
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  // 手机号必须与报价当前绑定一致（销售改了绑定号码后立即失效）
  const q = await one('select view_phone from quotations where public_token = ?', token);
  if (!q || String(q.view_phone || '') !== phone) return false;
  return true;
}

export function cookieName(token) {
  return `${COOKIE_PREFIX}${token.slice(0, 16)}`;
}

/** 读取报价绑定的手机号（发送时写入；老数据回退到客户主联系人） */
export async function boundPhone(token) {
  const q = await one(`select q.view_phone, q.account_id from quotations q where q.public_token = ?`, token);
  if (!q) return { phone: '', email: '' };
  let phone = String(q.view_phone || '').trim();
  if (!phone) {
    const c = await one('select phone, email from contacts where account_id = ? and is_primary = 1 order by id limit 1', q.account_id);
    phone = String(c?.phone || '').trim();
  }
  const email = String(q.view_email || '').trim();
  return { phone, email };
}

/** 发送验证码；未配置短信网关时为模拟模式，返回验证码供演示/本地查看 */
export async function sendCode(token, phoneInput) {
  const bound = await boundPhone(token);
  if (!bound.phone) throw new Error('该报价未绑定客户手机号，请联系销售顾问');
  const phone = String(phoneInput || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('请输入正确的手机号');
  if (phone !== bound.phone) throw new Error('手机号与该报价绑定的客户手机号不一致');

  // 限流：同一手机号 60 秒内只能发一次
  const last = await one('select created_at from quote_view_codes where token = ? and phone = ? order by id desc limit 1', token, phone);
  if (last && Date.now() - new Date(last.created_at).getTime() < 60 * 1000) {
    throw new Error('验证码发送过于频繁，请稍后再试');
  }

  const code = String(randomInt(0, 1000000)).padStart(6, '0');
  const r = await sendSms({
    phone,
    content: `【报价验证】您的报价查看验证码为 ${code}，5 分钟内有效，请勿告知他人。`
  });
  await run(`insert into quote_view_codes(token,phone,code,expires_at,used,attempts,created_at)
     values(?,?,?,?,0,0,?)`, token, phone, code, new Date(Date.now() + CODE_TTL_MS).toISOString(), nowIso());
  // 模拟模式（未配置网关）把验证码回显，便于本地/演示；真实网关下不回显
  const simulated = r.simulated || !r.ok;
  return { ok: true, simulated, devCode: simulated ? code : undefined, provider: r.provider || '' };
}

/** 校验验证码；成功后调用方签发 cookie */
export async function checkCode(token, phoneInput, codeInput) {
  const bound = await boundPhone(token);
  const phone = String(phoneInput || '').trim();
  const code = String(codeInput || '').trim();
  if (phone !== bound.phone) throw new Error('手机号与该报价绑定的客户手机号不一致');
  const rec = await one(`select * from quote_view_codes where token = ? and phone = ? and used = 0 order by id desc limit 1`, token, phone);
  if (!rec) throw new Error('请先获取验证码');
  if (new Date(rec.expires_at).getTime() < Date.now()) throw new Error('验证码已过期，请重新获取');
  if (Number(rec.attempts) >= 5) throw new Error('尝试次数过多，请重新获取验证码');
  await run('update quote_view_codes set attempts = attempts + 1 where id = ?', rec.id);
  if (String(rec.code) !== code) throw new Error('验证码不正确');
  await run('update quote_view_codes set used = 1 where id = ?', rec.id);
  return { ok: true };
}
