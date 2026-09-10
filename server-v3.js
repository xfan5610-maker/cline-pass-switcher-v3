// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { name, key, enabled } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询
  activeAccount: 0,        // single 模式下使用的账号下标
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstreams: string[]（有序优先列表，空=自动）, exclude: string[]（排除列表，优先级高于勾选）,
  //              pinMode: 'strict'|'preferred', sort: 'cost'|'ttft'|'tps'|null }
  // 请求按 upstreams 顺序逐个钉住尝试：第一个异常（非 200 / 网络失败 / 超时）自动顺切下一个，
  // 全部失败才把最后一个错误透传给客户端；exclude 中的上游永不被使用（自动模式下注入排除偏好）。
  // upstream 为旧版单上游兼容镜像（取列表第一个），maxRetries 已退役（旧值仅作回滚兼容保留在文件里）。
  perModel: {},
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
// DeepSeek V4 Flash 的补充上游。
const DEEPSEEK_FLASH_UPSTREAMS = [
  'open-inference', 'deepinfra', 'relace', 'sail-research', 'digitalocean',
  'makora', 'wafer', 'reka', 'morph', 'baseten', 'inceptron', 'coreweave',
  'streamlake', 'together', 'baidu', 'parasail', 'mancer', 'venice',
  'fireworks', 'siliconflow', 'gmicloud', 'nextbit', 'alibaba', 'novita',
  'phala', 'atlas-cloud', 'cloudflare', 'deepseek', 'azure',
];
const DEEPSEEK_PASS_UPSTREAMS = [
  'deepinfra', 'digitalocean', 'streamlake', 'baidu', 'parasail', 'mancer',
  'venice', 'siliconflow', 'gmicloud', 'nextbit', 'alibaba', 'novita',
  'phala', 'atlas-cloud', 'deepseek', 'azure',
];
function isDeepseekFlash(modelId) {
  return modelId === 'deepseek/deepseek-v4-flash' || modelId === 'cline-pass/deepseek-v4-flash';
}
function extendDeepseekFlashUpstreams(modelId) {
  if (!isDeepseekFlash(modelId)) return;
  const meta = (META.models[modelId] ||= {});
  const defaults = modelId === 'cline-pass/deepseek-v4-flash' ? DEEPSEEK_PASS_UPSTREAMS : DEEPSEEK_FLASH_UPSTREAMS;
  meta.upstreams = [...new Set([...defaults, ...(meta.upstreams || [])])].filter((u) => !(meta.deletedUpstreams || []).includes(u));
}

function pruneDeletedUpstreams(modelId) {
  const meta = META.models[modelId];
  if (!meta?.deletedUpstreams?.length) return;
  const deleted = new Set(meta.deletedUpstreams);
  for (const field of ['upstreams', 'watchedUpstreams', 'availableProviders', 'tier0']) {
    if (Array.isArray(meta[field])) meta[field] = meta[field].filter((u) => !deleted.has(u));
  }
  for (const field of ['upstreamDetail', 'upstreamStatus']) {
    if (meta[field]) for (const u of deleted) delete meta[field][u];
  }
  for (const field of ['lastProvider', 'provider']) {
    if (deleted.has(meta[field])) delete meta[field];
  }
  const cfg = config.perModel[modelId];
  if (cfg) {
    cfg.upstreams = (cfg.upstreams || []).filter((u) => !deleted.has(u));
    cfg.exclude = (cfg.exclude || []).filter((u) => !deleted.has(u));
    cfg.upstream = cfg.upstreams[0] || null;
  }
}
for (const modelId of ['deepseek/deepseek-v4-flash', 'cline-pass/deepseek-v4-flash']) {
  extendDeepseekFlashUpstreams(modelId);
}

const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const saveMeta = () => fs.writeFileSync(META_PATH, JSON.stringify(META, null, 2));
// 旧版单 apiKey 迁移为账号池
if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
  config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
  config.accountMode = 'single';
  config.activeAccount = 0;
  saveConfig();
}
config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single';

// perModel 配置升级：旧版单 upstream 迁移为有序多上游列表（upstream 保留为回滚兼容镜像）
(function migratePerModel() {
  let dirty = false;
  for (const c of Object.values(config.perModel || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.upstreams === undefined) { c.upstreams = c.upstream ? [c.upstream] : []; dirty = true; }
    if (c.exclude === undefined) { c.exclude = []; dirty = true; }
    if (!Array.isArray(c.upstreams)) { c.upstreams = []; dirty = true; }
    if (!Array.isArray(c.exclude)) { c.exclude = []; dirty = true; }
  }
  if (dirty) saveConfig();
})();

for (const modelId of Object.keys(META.models)) pruneDeletedUpstreams(modelId);

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [{ name: 'env-account', key: k, enabled: true }, ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

// 账号选择：roundrobin 在启用的账号间轮询；single 使用 activeAccount 指定的账号
let RR_COUNTER = 0;
function enabledAccounts() {
  return (config.accounts || []).filter((a) => a && a.key && a.enabled !== false);
}
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '' };
  if (config.accountMode === 'roundrobin' && list.length > 1) {
    const a = list[RR_COUNTER % list.length];
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
    return a;
  }
  const byIdx = config.accounts[config.activeAccount];
  if (byIdx && byIdx.key && byIdx.enabled !== false) return byIdx;
  return list[0];
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  return bearer === PROXY_KEY || admin === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
  }
  return ids;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  if (!Array.isArray(json?.data?.endpoints)) throw new Error('OpenRouter 指标不可用');
  return { slug: real, endpoints: endpointMetrics(json.data.endpoints, 'OpenRouter') };
}

function metricNumber(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 单位统一为美元/百万 token、毫秒、token/秒；缺失指标保持 null。
function endpointMetrics(endpoints, source) {
  const detail = new Map();
  for (const e of endpoints) {
    const slug = source === 'Vercel' ? slugify(e.provider_name || '')
      : String(e.tag || '').split('/')[0] || slugify(e.provider_name || '');
    if (!validUpstream(slug)) continue;
    const d = detail.get(slug) || { slug, name: e.provider_name || slug, endpoints: 0, context: 0,
      source, fetchedAt: Date.now(), window: source === 'Vercel' ? '1h' : '30m',
      input: null, output: null, cost: null, ttft: null, tps: null, offers: [] };
    d.endpoints++;
    d.context = Math.max(d.context, metricNumber(e.context_length) || 0);
    const input = metricNumber(e.pricing?.prompt);
    const output = metricNumber(e.pricing?.completion);
    const percentage = (value) => { const n = metricNumber(value); return n !== null && n <= 100 ? n : null; };
    const cacheRead = metricNumber(e.pricing?.input_cache_read);
    d.offers.push({
      endpoint: String(e.tag || e.name || slug),
      input: input === null ? null : input * 1e6,
      output: output === null ? null : output * 1e6,
      cacheRead: cacheRead === null ? null : cacheRead * 1e6,
      shortWindow: source === 'Vercel' ? '15m' : '5m',
      uptimeShort: percentage(source === 'Vercel' ? e.uptime_last_15m : e.uptime_last_5m),
      uptimeDay: percentage(e.uptime_last_1d),
    });
    // 成本按输入输出 1:1 的基础报价比较；两项必须来自同一个 endpoint。
    if (input !== null && output !== null && (d.cost === null || (input + output) * 1e6 < d.cost)) {
      d.input = input * 1e6;
      d.output = output * 1e6;
      d.cost = d.input + d.output;
    }
    const latency = source === 'Vercel' ? e.latency_last_1h : e.latency_last_30m;
    const throughput = source === 'Vercel' ? e.throughput_last_1h : e.throughput_last_30m;
    const ttft = metricNumber(typeof latency === 'object' ? latency?.p50 : latency);
    const tps = metricNumber(typeof throughput === 'object' ? throughput?.p50 : throughput);
    if (ttft !== null) d.ttft = Math.min(d.ttft ?? Infinity, ttft * (source === 'Vercel' ? 1 : 1000));
    if (tps !== null) d.tps = Math.max(d.tps ?? 0, tps);
    detail.set(slug, d);
  }
  return [...detail.values()];
}

async function vercelEndpoints(slug) {
  const modelPath = slug.split('/').map(encodeURIComponent).join('/');
  const { json } = await fetchJSON(`https://ai-gateway.vercel.sh/v1/models/${modelPath}/endpoints`, {}, 20000);
  if (!Array.isArray(json?.data?.endpoints)) throw new Error('Vercel 指标不可用');
  return { slug, endpoints: endpointMetrics(json.data.endpoints, 'Vercel') };
}

function validUpstream(value) {
  return typeof value === 'string' && value.length <= 128
    && /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/.test(value)
    && !['__proto__', 'constructor', 'prototype'].includes(value);
}

// 只从明确的渠道清单字段提取名称，不把错误里的普通词语当作上游。
function errorProviders(error) {
  const found = new Set();
  function visit(value, depth = 0) {
    if (depth > 5 || value == null) return;
    if (typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (['available_providers', 'availableProviders'].includes(key) && Array.isArray(child)) {
          child.filter(validUpstream).forEach((p) => found.add(p));
        } else if (['error', 'message', 'metadata', 'raw'].includes(key)) visit(child, depth + 1);
      }
    } else if (typeof value === 'string') {
      for (const match of value.matchAll(/Available providers are:\s*([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*)/gi)) {
        match[1].split(/\s*,\s*/).filter(validUpstream).forEach((p) => found.add(p));
      }
      const start = value.indexOf('{');
      if (start >= 0) { try { visit(JSON.parse(value.slice(start)), depth + 1); } catch {} }
    }
  }
  visit(error);
  return [...found];
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
  };
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
// - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的 "Available providers are: ..."
async function harvestAvailableProviders(modelId, pipeline) {
  const acc = pickAccount();
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000);
  const providers = errorProviders(json?.error);
  return providers.length ? providers : null;
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId) {
  const acc = pickAccount();
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(acc.key),
    body: JSON.stringify(body),
  }, 180000);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: typeof json.error === 'string' ? json.error : JSON.stringify(json.error) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline && r.canonicalSlug) {
    try {
      const res = await (r.pipeline === 'planner' ? vercelEndpoints(r.canonicalSlug) : orEndpoints(r.canonicalSlug));
      endpoints = res.endpoints;
      if (r.pipeline === 'direct') orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  const prev = META.models[modelId] || {};
  const detail = {};
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks, ...Object.keys(detail), ...(prev.watchedUpstreams || [])])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail), ...(prev.watchedUpstreams || [])])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    availableProviders: harvest || prev.availableProviders || [],
    canonicalSlug: r.canonicalSlug,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  extendDeepseekFlashUpstreams(modelId);
  pruneDeletedUpstreams(modelId);
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'ok';                     // 请求已到达模型（推理耗尽 max_tokens 导致内容为空）
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const m = /Available providers are:\s*([^.]+)/.exec(String(errMsg || ''));
  if (!m) return;
  const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  pruneDeletedUpstreams(modelId);
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount();
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = msg.slice(0, 160);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      results[slug] = { status, ms: Date.now() - t0, note };
    }));
  }
  META.models[modelId] = { ...meta, upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, validatedAt: Date.now() };
  saveMeta();
  return results;
}

// 从官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => found.add(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  try {
    const res = await fetch('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

function record(modelId, info) {
  META.models[modelId] = { ...(META.models[modelId] || {}), ...info };
  META.history.unshift({ ts: Date.now(), model: modelId, ...info });
  if (META.history.length > 100) META.history.length = 100;
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}


// ---------- V3 稳定性层：运行态观测 + SSE 空闲看门狗 ----------
const V3_STARTED_AT = Date.now();
const V3_STREAM_IDLE_MS = Math.max(15000, Number(process.env.STREAM_IDLE_TIMEOUT_MS) || 90000);
const V3_STREAM_TAIL_BYTES = Math.max(32768, Number(process.env.STREAM_TAIL_BYTES) || 131072);
const V3_ACTIVE_STREAMS = new Map();
let V3_STREAM_SEQ = 0;
let V3_STALLED_TOTAL = 0;

function v3RuntimeSnapshot() {
  const now = Date.now();
  return {
    version: 'v3-mobile-1.4.0',
    startedAt: V3_STARTED_AT,
    uptimeMs: now - V3_STARTED_AT,
    streamIdleTimeoutMs: V3_STREAM_IDLE_MS,
    activeStreams: [...V3_ACTIVE_STREAMS.values()].map((s) => ({
      id: s.id, model: s.model, account: s.account, startedAt: s.startedAt,
      lastChunkAt: s.lastChunkAt, idleMs: now - s.lastChunkAt,
      bytes: s.bytes, target: s.target, state: s.state,
    })),
    stalledTotal: V3_STALLED_TOTAL,
  };
}

function v3TailAppend(prev, chunk) {
  const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (b.length >= V3_STREAM_TAIL_BYTES) return b.subarray(b.length - V3_STREAM_TAIL_BYTES);
  const merged = Buffer.concat([prev, b]);
  return merged.length > V3_STREAM_TAIL_BYTES
    ? merged.subarray(merged.length - V3_STREAM_TAIL_BYTES) : merged;
}

function v3ParseTailRouting(tail) {
  const text = tail.toString('utf8');
  let provider = null, canonical = null;
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 20 && !provider; i--) {
    const l = lines[i];
    if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
    try {
      const c = JSON.parse(l.slice(6));
      if (typeof c.provider === 'string') {
        provider = slugify(c.provider);
        canonical = c.model || null;
      }
    } catch {}
  }
  if (!provider) {
    const fp = /"finalProvider":"([^"]+)"/.exec(text);
    const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
    provider = fp ? fp[1] : null;
    canonical = cs ? cs[1] : null;
  }
  return { provider, canonical };
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return { status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  const r = parseRouting(d);
  return { status: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，排除的永不在候选中
// - 未勾选：单候选自动模式，排除换算成 only 白名单注入（见 injectPrefs）
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const base = { strict, sort, excludeList: exclude };
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.map((u, i) => ({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return [{ ...base, upstream: null, orderRest: [], excludeList: exclude }];
}

// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

// 单次向上游网关发起非流式请求；返回 { status, out, routing, netError, acc }
// 异常（网络错误/非 JSON/非 200）不抛出，由调用方决定切换
async function attemptOnce(modelId, body, attempt, signal) {
  const send = injectPrefs(body, modelId, attempt);
  const acc = pickAccount();
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) return { status: 502, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc };
    const { status, body: out, routing } = unwrap(json);
    return { status, out, routing, netError: null, acc };
  } catch (e) {
    return { status: 502, out: { error: { message: `upstream fetch failed: ${e.message}`, type: 'upstream_error' } }, routing: {}, netError: e.message, acc };
  }
}

// 顺序故障转移：依次执行候选，非 200 / 网络失败 / 超时即切换下一个；全部失败返回最后一次结果。
// 流式：首包前（网关以 JSON 而非 SSE 应答错误）仍可切换；SSE 一旦开始即透传，无法重试。
// 每次尝试有独立的超时中止（attemptTimeoutMs）；客户端断开会中止当前尝试。
// 返回 { status, out, routing, acc, trace, streamUp? } —— trace 为逐次尝试 [{ upstream, status, ms, note }]
async function runChatChain(req, body, modelId, cfg, { stream = false, attemptTimeoutMs = 120000 } = {}) {
  const attempts = buildAttempts(modelId, cfg);
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeCtrl = null;            // 当前尝试的 AbortController；流式成功后保持指向该次 fetch，用于断连时中止上游 body
  let keepCloseHook = false;        // 流式 SSE 建立后，close 钩子要保留到流结束
  const onClientClose = () => { if (activeCtrl) activeCtrl.abort(); };
  req.on('close', onClientClose);
  try {
    for (const attempt of attempts) {
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          const acc = pickAccount();
          let up = null;
          let netError = null;
          try {
            up = await fetch(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal: ctrl.signal });
          } catch (e) { netError = e.message; }
          const ctype = up?.headers?.get('content-type') || '';
          let isSSE = !!up && up.status === 200 && ctype.includes('event-stream');
          // 网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}：
          // 读首个数据块探测，真正的 SSE 第一行是 "data: {...}" 且非纯错误对象
          let firstChunk = null;
          if (isSSE) {
            let reader = null;
            try {
              reader = up.body.getReader();
              const { value, done } = await reader.read();
              if (done) {
                isSSE = false;
                netError = 'empty stream';
              } else {
                firstChunk = Buffer.from(value);
                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);
                if (head.startsWith('data:')) {
                  const payload = head.replace(/^data:\s*/, '').slice(0, 160);
                  if (payload.startsWith('{"error"')) { isSSE = false; netError = `stream error: ${payload.slice(0, 120)}`; }
                } else {
                  isSSE = false;
                  netError = `unexpected stream head: ${head.slice(0, 60)}`;
                }
              }
            } catch (e) {
              isSSE = false;
              netError = e.message;
            } finally {
              try { reader?.releaseLock(); } catch {}
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let text = '';
            let json = null;
            if (firstChunk) {
              // 已消费的块 + 剩余 body 拼回完整错误文本
              const rest = await up.text().catch(() => '');
              text = firstChunk.toString('utf8') + rest;
            } else {
              text = await up.text();
            }
            try { json = JSON.parse(text); } catch {}
            const msg = errText(json?.error) || text.slice(0, 160) || netError;
            trace.push({ upstream: attempt.upstream, status: up.status, ms, note: msg.slice(0, 160) });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            last = { status: json?.error ? 502 : up.status, out: json || { error: { message: text.slice(0, 400) || netError, type: 'upstream_error' } }, routing: parseRouting(json || {}), acc, netError: null };
            continue; // 错误：还未向客户端写任何字节，可切换下一候选
          }
          if (!up) {
            trace.push({ upstream: attempt.upstream, status: 502, ms, note: netError || 'no response' });
            last = { status: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc, netError: netError || 'no response' };
            continue;
          }
          // 真 SSE：firstChunk 与剩余 body 串联透传（SSE 开始后无法重试）；close 钩子保留用于客户端断开时中止上游
          keepCloseHook = true;
          trace.push({ upstream: attempt.upstream, status: 200, ms, note: 'stream' });
          return {
            status: 200,
            streamUp: up,
            streamHead: firstChunk,
            acc,
            trace,
            t0,
            streamAbort: () => ctrl.abort(),
            streamCleanup: () => req.off('close', onClientClose),
          };
        }
        // 非流式
        const r = await attemptOnce(modelId, body, attempt, ctrl.signal);
        const ms = Date.now() - t1;
        const note = r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok');
        trace.push({ upstream: attempt.upstream, status: r.status, ms, note });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        last = r;
        if (r.status === 200) break;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!keepCloseHook) req.off('close', onClientClose);
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  const modelId = body.model;
  if (!modelId) return sendJSON(res, 400, { error: { message: 'model is required' } });

  const cfg = config.perModel[modelId] || {};
  const targets = buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean);
  const isStream = !!body.stream;

  const chain = await runChatChain(req, body, modelId, cfg, { stream: isStream });

  if (isStream && chain.streamUp) {
    // V3：显式泵送 WebStream，增加空闲超时、背压、有限尾部缓存与完整清理。
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    const ctype = up.headers.get('content-type') || 'text/event-stream';
    const streamId = ++V3_STREAM_SEQ;
    const state = {
      id: streamId, model: modelId, account: acc?.name || null,
      target: targets.length ? targets.join('>') : 'auto',
      startedAt: Date.now(), lastChunkAt: Date.now(), bytes: 0, state: 'STREAMING',
    };
    V3_ACTIVE_STREAMS.set(streamId, state);

    res.writeHead(up.status, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
      'X-Cline-Stream-Id': String(streamId),
    });

    let reader = null;
    let idleTimer = null;
    let tail = Buffer.alloc(0);
    let finished = false;
    let recorded = false;

    state.abort = () => {
      if (finished) return false;
      state.state = 'ABORTING';
      try { chain.streamAbort?.(); } catch {}
      try { reader?.cancel('aborted by admin')?.catch?.(() => {}); } catch {}
      return true;
    };

    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (finished) return;
        state.state = 'STALLED';
        V3_STALLED_TOTAL++;
        try { chain.streamAbort?.(); } catch {}
        try { reader?.cancel('stream idle timeout'); } catch {}
      }, V3_STREAM_IDLE_MS);
    };

    const pushChunk = async (chunk) => {
      if (!chunk || !chunk.length) return;
      state.lastChunkAt = Date.now();
      state.bytes += chunk.length;
      state.state = 'STREAMING';
      tail = v3TailAppend(tail, chunk);
      armIdle();
      if (!res.write(chunk)) {
        await new Promise((resolve) => res.once('drain', resolve));
      }
    };

    try {
      armIdle();
      if (chain.streamHead) await pushChunk(chain.streamHead);
      reader = up.body.getReader();

      while (true) {
        const part = await reader.read();
        if (part.done) break;
        await pushChunk(Buffer.from(part.value));
      }

      if (state.state === 'STALLED') throw new Error('stream idle timeout');
      if (state.state === 'ABORTING') throw new Error('aborted by admin');
      finished = true;
      state.state = 'DONE';
      const { provider, canonical } = v3ParseTailRouting(tail);
      record(modelId, {
        provider, canonical, ms: Date.now() - t0, stream: true, error: null,
        account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto'),
      });
      recorded = true;
      if (!res.writableEnded) res.end();
    } catch (err) {
      finished = true;
      const idleFor = Date.now() - state.lastChunkAt;
      const stalled = state.state === 'STALLED' || idleFor >= V3_STREAM_IDLE_MS;
      state.state = stalled ? 'STALLED' : 'ERROR';
      const message = stalled
        ? `上游流连续 ${Math.round(idleFor / 1000)} 秒无数据，已自动中止`
        : `上游流异常：${err?.message || String(err)}`;

      if (!recorded) {
        record(modelId, {
          provider: null, canonical: null, ms: Date.now() - t0, stream: true, error: message,
          account: acc?.name || null, attempts: chain.trace.map((t) => t.upstream || 'auto'),
        });
        recorded = true;
      }

      if (!res.writableEnded && !res.destroyed) {
        try {
          res.write(`data: ${JSON.stringify({ error: { message, type: stalled ? 'stream_idle_timeout' : 'stream_error' } })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
        } catch {
          try { res.destroy(); } catch {}
        }
      }
    } finally {
      clearTimeout(idleTimer);
      try { await reader?.cancel(); } catch {}
      try { reader?.releaseLock(); } catch {}
      try { chain.streamCleanup?.(); } catch {}
      V3_ACTIVE_STREAMS.delete(streamId);
    }
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  // 客户端实际使用成功的新订阅模型自动收录进列表
  if (status === 200 && /^cline-pass\//.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
  });
  res.end(JSON.stringify(out));
}

// ---------- HTTP 服务 ----------
// 测速单独读取流，不走故障转移，避免把多家供应商的时间混算。
async function measureStream(response, startedAt) {
  if (!response.body || !/text\/event-stream/i.test(response.headers.get('content-type') || '')) {
    const error = await response.text();
    throw new Error(`上游未返回事件流：${error.slice(0, 500)}`);
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', dataLines = [], firstPacket = null, firstGenerated = null, lastGenerated = null;
  let completedAt = null, done = false, usage = null, preview = '', size = 0;
  let routing = {};
  function event() {
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    dataLines = [];
    if (data.trim() === '[DONE]') { done = true; completedAt = performance.now(); return; }
    let chunk;
    try { chunk = JSON.parse(data); } catch { throw new Error('上游事件流包含无效 JSON'); }
    const d = chunk?.data && typeof chunk.data === 'object' ? chunk.data : chunk;
    if (d?.error) throw new Error(errText(d.error?.message || d.error).slice(0, 1000));
    if (d?.usage) usage = d.usage;
    const delta = d?.choices?.[0]?.delta || {};
    const r = parseRouting(d || {});
    const deltaRouting = parseRouting({ choices: [{ message: delta }] });
    for (const info of [r, deltaRouting]) {
      for (const key of ['pipeline', 'canonicalSlug', 'finalProvider']) if (info[key]) routing[key] = info[key];
    }
    const text = typeof delta.content === 'string' ? delta.content : '';
    const reasoning = [delta.reasoning, delta.reasoning_content, ...(Array.isArray(delta.reasoning_details) ? delta.reasoning_details : []).map((item) => item?.text)]
      .some((value) => typeof value === 'string' && value.length > 0);
    if (text || reasoning) {
      const now = performance.now();
      firstGenerated ??= now;
      lastGenerated = now;
      preview = (preview + text).slice(0, 1200);
    }
    if (d?.choices?.some((choice) => choice.finish_reason === 'error')) throw new Error('上游生成失败');
  }
  function lines(flush = false) {
    let end;
    while (!done && (end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).replace(/\r$/, '');
      buffer = buffer.slice(end + 1);
      if (!line) event();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (flush && !done) {
      if (buffer.startsWith('data:')) dataLines.push(buffer.slice(5).replace(/^ /, '').replace(/\r$/, ''));
      buffer = '';
      event();
    }
  }
  try {
    while (!done) {
      const part = await reader.read();
      if (part.done) { buffer += decoder.decode(); lines(true); break; }
      if (!part.value.length) continue;
      firstPacket ??= performance.now();
      size += part.value.length;
      if (size > 2 * 1024 * 1024) throw new Error('测速响应超出大小限制');
      buffer += decoder.decode(part.value, { stream: true });
      lines();
    }
    completedAt ??= performance.now();
    if (!done) throw new Error('上游流提前断开，测速未完成');
    if (firstGenerated === null) throw new Error('上游未返回生成内容');
    const reportedTokens = metricNumber(usage?.completion_tokens);
    const tokens = Number.isInteger(reportedTokens) && reportedTokens > 0 ? reportedTokens : null;
    const generatedMs = lastGenerated - firstGenerated;
    const totalMs = completedAt - startedAt;
    return {
      firstPacketMs: firstPacket === null ? null : firstPacket - startedAt,
      generationSpeed: tokens !== null && generatedMs > 0 ? tokens * 1000 / generatedMs : null,
      perceivedSpeed: tokens !== null && totalMs > 0 ? tokens * 1000 / totalMs : null,
      completionTokens: tokens, totalMs, preview, ...routing,
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function speedTest(model, upstream, signal) {
  const acc = pickAccount();
  if (!acc.key) throw new Error('请先配置上游账号');
  const body = injectPrefs({ model, stream: true, stream_options: { include_usage: true }, max_tokens: 1024,
    messages: [{ role: 'user', content: '直接用中文写一篇约600字的科普短文，介绍雨滴的形成过程，不要列提纲。' }],
  }, model, { upstream, strict: true });
  const startedAt = performance.now();
  const response = await fetch(`${config.upstreamBase}/chat/completions`, {
    method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`上游 HTTP ${response.status}：${(await response.text()).slice(0, 500)}`);
  const measured = await measureStream(response, startedAt);
  const actual = measured.finalProvider || null;
  let detail = null;
  // 只展示本次响应确认的网关和供应商数据；查询时间不计入测速。
  if (actual && measured.pipeline && measured.canonicalSlug) {
    try {
      const source = measured.pipeline === 'planner' ? 'Vercel' : 'OpenRouter';
      const base = source === 'Vercel' ? 'https://ai-gateway.vercel.sh/v1' : OR_API;
      const modelPath = measured.canonicalSlug.split('/').map(encodeURIComponent).join('/');
      const res = await fetch(`${base}/models/${modelPath}/endpoints`, { signal });
      if (res.ok) {
        const json = await res.json();
        const endpoints = Array.isArray(json?.data?.endpoints) ? endpointMetrics(json.data.endpoints, source) : [];
        detail = endpoints.find((d) => norm(d.slug) === norm(actual) || norm(d.name) === norm(actual)) || null;
      }
    } catch (e) { if (signal?.aborted) throw e; /* 公共指标不可用时只展示本次实测 */ }
  }
  const matched = actual ? norm(actual) === norm(upstream) || (detail && norm(detail.slug) === norm(upstream)) : null;
  if (!matched) return { ok: false, error: actual ? `网关实际使用 ${actual}，与指定供应商 ${upstream} 不符，本次测速无效` : '响应未确认实际供应商，本次测速无效' };
  return { ok: true, model, upstream, actual, matched: matched === null ? null : !!matched,
    ...measured, detail, testedAt: Date.now() };
}

function rememberSpeedTest(model, upstream, result) {
  const meta = (META.models[model] ||= {});
  const tests = (meta.speedTests ||= {});
  tests[upstream] = {
    ok: !!result.ok, model, upstream, actual: result.actual || null,
    matched: result.matched ?? null, generationSpeed: result.generationSpeed ?? null,
    perceivedSpeed: result.perceivedSpeed ?? null, firstPacketMs: result.firstPacketMs ?? null,
    completionTokens: result.completionTokens ?? null, totalMs: result.totalMs ?? null,
    detail: result.detail || null, error: result.error || null, testedAt: result.testedAt || Date.now(),
  };
  saveMeta();
}

function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/') || CHAT_PATHS.has(p)) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index-v3.html')));
    }
    if (req.method === 'GET' && p === '/api/runtime') {
      return sendJSON(res, 200, v3RuntimeSnapshot());
    }
    if (req.method === 'POST' && p === '/api/runtime/abort') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const id = Number(body.id);
      const stream = V3_ACTIVE_STREAMS.get(id);
      if (!Number.isInteger(id) || !stream) return sendJSON(res, 404, { ok: false, error: '活动请求不存在或已经结束' });
      if (typeof stream.abort !== 'function') return sendJSON(res, 409, { ok: false, error: '当前请求不支持单独终止' });
      stream.abort();
      return sendJSON(res, 200, { ok: true, id });
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const sub = config.knownModels.map((id) => ({ id, config: config.perModel[id] || {}, meta: META.models[id] || null }));
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/speed-test') {
      const { model, upstream } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (typeof model !== 'string' || !Object.hasOwn(META.models, model) || !validUpstream(upstream)
        || !META.models[model]?.upstreams?.includes(upstream)) {
        return sendJSON(res, 400, { ok: false, error: '请选择模型及其列表中的供应商；没有供应商时先探测或手动收录' });
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 120000);
      const onClose = () => { if (!res.writableEnded) ctrl.abort(); };
      res.on?.('close', onClose);
      try {
        const result = await speedTest(model, upstream, ctrl.signal);
        rememberSpeedTest(model, upstream, result);
        return sendJSON(res, 200, result);
      } catch (e) {
        return sendJSON(res, 502, { ok: false, error: ctrl.signal.aborted ? '测速超时或连接已断开' : e.message });
      } finally {
        clearTimeout(timer);
        res.off?.('close', onClose);
      }
    }
    if (req.method === 'POST' && p === '/api/test') {
      // 临时配置可带 upstreams/exclude（数组）或旧版 upstream（单值），完整走故障转移链路
      const { model, upstream, upstreams, exclude, pinMode } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const t0 = Date.now();
      const cfg = { ...(config.perModel[model] || {}) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      if (pinMode === 'strict' || pinMode === 'preferred') cfg.pinMode = pinMode;
      if (!Array.isArray(cfg.upstreams || []) || !(cfg.upstreams || []).every(validUpstream)) {
        return sendJSON(res, 400, { ok: false, error: '上游名称格式无效' });
      }
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      const chain = await runChatChain(req, body, model, cfg, { stream: false, attemptTimeoutMs: 180000 });
      const trace = chain.trace || [];
      if (chain.status !== 200) {
        const providers = errorProviders(chain.out?.error);
        for (const t of trace) providers.push(...errorProviders(t.note));
        return sendJSON(res, 200, {
          ok: false, error: errText(chain.out?.error?.message || chain.out?.error || 'upstream error').slice(0, 12000),
          errorProviders: [...new Set(providers)],
          targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace,
        });
      }
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, {
        ok: true, ms: Date.now() - t0,
        targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [],
        actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null,
        canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120),
        account: chain.acc?.name || null, trace,
      });
    }
    if (req.method === 'POST' && (p === '/api/watch-upstream' || p === '/api/delete-upstream')) {
      const { model, upstream } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (typeof model !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model)
        || !validUpstream(upstream)) return sendJSON(res, 400, { ok: false, error: '模型或上游名称格式无效' });
      if (!config.knownModels.includes(model) && !Object.hasOwn(META.models, model)) {
        return sendJSON(res, 400, { ok: false, error: '请先选择或探测对应模型' });
      }
      const meta = (META.models[model] ||= {});
      if (p === '/api/delete-upstream') {
        meta.deletedUpstreams = [...new Set([...(meta.deletedUpstreams || []), upstream])];
        pruneDeletedUpstreams(model);
        saveConfig();
      } else {
        meta.deletedUpstreams = (meta.deletedUpstreams || []).filter((u) => u !== upstream);
        meta.watchedUpstreams = [...new Set([...(meta.watchedUpstreams || []), upstream])];
        meta.upstreams = [...new Set([...(meta.upstreams || []), upstream])];
      }
      saveMeta();
      return sendJSON(res, 200, { ok: true, meta, config: config.perModel[model] || {} });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJSON(res, 200, {
        accounts: config.accounts,
        mode: config.accountMode,
        active: config.activeAccount,
        stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const accs = (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a, i) => ({
          name: String(a.name || `账号${i + 1}`).slice(0, 50),
          key: String(a.key || '').trim(),
          enabled: a.enabled !== false,
        }))
        .filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      config.accounts = accs;
      config.accountMode = body.mode === 'roundrobin' ? 'roundrobin' : 'single';
      config.activeAccount = Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      saveConfig();
      RR_COUNTER = 0;
      return sendJSON(res, 200, { ok: true, accounts: config.accounts.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = JSON.parse(await readBody(req).then((b) => b.toString()));
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'GET' && p === '/api/security') {
      return sendJSON(res, 200, { proxyKey: config.proxyKey || '', publicBaseUrl: config.publicBaseUrl || '', authRequired: !!PROXY_KEY, exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.proxyKey !== undefined) config.proxyKey = String(body.proxyKey).trim();
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, { ok: true, proxyKey: config.proxyKey, publicBaseUrl: config.publicBaseUrl, authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const results = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels });
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.perModel) {
        for (const [m, c] of Object.entries(body.perModel)) {
          const limit = Math.max(10, META.models[m]?.upstreams?.length || 0);
          const normalize = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, limit);
          let upstreams = normalize(c.upstreams);
          const exclude = normalize(c.exclude);
          const excl = new Set(exclude);
          const deleted = new Set(META.models[m]?.deletedUpstreams || []);
          upstreams = upstreams.filter((u) => !excl.has(u) && !deleted.has(u)); // 同时出现以 exclude 为准
          const upstream = upstreams[0] || null; // 旧字段兼容镜像
          config.perModel[m] = {
            upstream,
            upstreams,
            exclude: exclude.filter((u) => !deleted.has(u)),
            pinMode: c.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: ['cost', 'ttft', 'tps'].includes(c.sort) ? c.sort : null,
          };
        }
        saveConfig();
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog())])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, 500, { error: { message: e.message } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

server.on('error', (e) => {
  console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
  process.exit(1);
});

const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
server.listen(config.port, BIND_HOST, () => {
  console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${config.port}/`);
  console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${config.port}/v1`);
});
