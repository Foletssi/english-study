/* Eastudy V3 — 第三方模型服务地址校验 (SSRF 闸门)。

   为什么这个文件必须存在: 控制端让运维自己填"API 地址", 而这个地址是**服务端
   去请求**的。只要不校验, 一个能登录后台的人就能让 Cloudflare 的出口去访问
   任何地址 —— 包括内网管理面板、云厂商的元数据端点(169.254.169.254)、以及
   Supabase 自己的 REST 端口。这不再是"配置写错了", 而是拿我们的服务当跳板。

   校验分两层, 两层都必须过:

   1. 语法层 —— 必须是 http/https 绝对地址, 不能带用户名密码, 不能带查询串和
      锚点。带 `@` 的地址(http://real@evil.com 或 http://evil.com@real)是经典
      绕过手法, 直接拒绝而不是尝试解析。

   2. 目标层 —— 解析出的主机名不能是回环、内网、链路本地或云元数据地址。
      这一层的问题是 DNS rebinding: 主机名在**校验时**解析到公网、在**请求时**
      解析到内网。边缘运行时没法把解析结果钉住再复用, 所以这里做不到完全免疫。
      实际挡住的是绝大多数情况(运维抄错地址、有人手工试探), 并且把它记进日志。
      真正的兜底是: 这个接口只有管理员能调, 且 key 不出服务端。

   为什么要单独一个文件: 这段逻辑要在两个地方用(通道检测、模型获取), 而它是
   那种"抄一份过去、过两个月两边不一样"的代码。校验规则只有一份, 才谈得上
   一致。 */

import { HttpError } from './env.js';

/* 云厂商的元数据端点。这几个地址在拿到实例凭据这件事上没有任何鉴权, 是 SSRF
   最常见的跳板, 所以即使它们同时也是"内网地址"、会被下面的私网判断拦掉,
   仍然单列出来 —— 单列是为了日志里能一眼看出这是攻击而不是手滑。 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',            // AWS / Azure / GCP / 阿里云 通用
  'metadata.google.internal',
  'metadata.goog',
  '100.100.100.200',            // 阿里云
]);

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * 校验并规范化一个第三方 API 基地址。
 *
 * @param {unknown} input 运维填进输入框的字符串
 * @param {{ allowPrivate?: boolean }} [options]
 *        allowPrivate 只给本地开发用(指向 127.0.0.1 上的 mock)。生产路径不要传。
 * @returns {string} 去掉尾部斜杠的规范地址
 * @throws {HttpError} 400, 且 message 直接可以显示给运维 —— 它会原样出现在
 *         表单的错误提示里, 所以必须说清哪里不对, 不能只写"非法地址"。
 */
export function assertUpstreamUrl(input, { allowPrivate = false } = {}) {
  const raw = String(input ?? '').trim();
  if (!raw) {
    throw new HttpError(400, 'AI_BASE_URL_REQUIRED', '请先填写 API 地址');
  }
  if (raw.length > 300) {
    throw new HttpError(400, 'AI_BASE_URL_TOO_LONG', 'API 地址过长(超过 300 字符)');
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    /* 相对地址在这一步就被拦下。它看着像"我们自己的 /v1", 但服务端 fetch
       相对路径会直接抛错, 与其让运维看到 TypeError, 不如在这里说清楚。 */
    throw new HttpError(400, 'AI_BASE_URL_INVALID', 'API 地址必须是完整地址(以 http:// 或 https:// 开头)');
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new HttpError(400, 'AI_BASE_URL_SCHEME', `API 地址只支持 http:// 或 https://,当前是 ${url.protocol}`);
  }
  /* 用户名密码内嵌在 URL 里会被 fetch 当成 Authorization 之外的凭据, 而且
     是钓鱼域名最爱的写法 (https://api.deepseek.com@evil.example)。一律拒绝。 */
  if (url.username || url.password) {
    throw new HttpError(400, 'AI_BASE_URL_CREDENTIALS', 'API 地址不能包含用户名或密码');
  }
  if (url.search || url.hash) {
    throw new HttpError(400, 'AI_BASE_URL_QUERY', 'API 地址不能带查询参数或 # 锚点');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (METADATA_HOSTS.has(host)) {
    throw new HttpError(400, 'AI_BASE_URL_BLOCKED', '该地址是云元数据端点,禁止访问');
  }

  if (!allowPrivate && isPrivateHost(host)) {
    throw new HttpError(400, 'AI_BASE_URL_PRIVATE',
      '不能指向内网或本机地址。第三方模型服务必须是公网可访问的地址。');
  }

  // 只留到路径, 去掉尾斜杠 —— 拼 /chat/completions 时多一条斜杠在部分网关上
  // 会 301 到 http, 而 301 之后 Authorization 头会被浏览器/fetch 丢掉。
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

/** 私网 / 回环 / 链路本地 / 保留段。IPv4 和 IPv6 都判。 */
function isPrivateHost(host) {
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.endsWith('.local') || host.endsWith('.internal')) return true;

  // IPv6: ::1 回环, fe80::/10 链路本地, fc00::/7 唯一本地地址
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (/^fe[89ab][0-9a-f]?:/i.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    // IPv4-mapped (::ffff:127.0.0.1) —— 拆出后四位再按 v4 判一次
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isPrivateHost(mapped[1]);
    return false;
  }

  const parts = host.split('.');
  if (parts.length !== 4) return false;          // 普通域名
  const octets = parts.map((part) => Number(part));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127) return true;   // 0.0.0.0/8, 10/8, 回环
  if (a === 169 && b === 254) return true;             // 链路本地 / 元数据
  if (a === 172 && b >= 16 && b <= 31) return true;    // 172.16/12
  if (a === 192 && b === 168) return true;             // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;   // 运营商级 NAT 100.64/10
  if (a >= 224) return true;                           // 组播与保留
  return false;
}

/** 拼一个上游路径, 保证中间只有一条斜杠。 */
export function joinUrl(base, path) {
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}
