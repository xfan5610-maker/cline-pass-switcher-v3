# Cline Pass 上游控制台（cline-pass-switcher）

本仓库是基于 [liqiming-whu/cline-pass-switcher](https://github.com/liqiming-whu/cline-pass-switcher) 的移动端适配修改版；原项目源自 [munmunjaklin458-afk/cline-pass-switcher](https://github.com/munmunjaklin458-afk/cline-pass-switcher)。重点优化手机端管理面板、上游管理与操作体验。

## 功能概览

- **自定义上游**：测试台可填写上游 slug，严格指定该渠道发送测试；错误中的上游名称高亮，点击即可加入对应模型的监查列表。
- **持久管理**：支持逐项删除上游，同步清理优先、排除及指标缓存；重启和再次探测不会自动加回，手动收录可恢复。
- **指标与排名**：探测后按实际管道分别读取 Vercel 或 OpenRouter 的价格、首字延迟和吞吐数据。列表支持最低成本、最快首字、最高吞吐排序，标注数值、单位、来源和采集时间。
- **简洁显示**：缺失数据静默隐藏，列表排名编号保留；无指标时按发现顺序排列。展示排名与手动请求优先级分别显示。
- **折叠摘要**：跟随当前排序策略，展示最近探测命中的上游，同时保留手动优先与排除信息。
- **批量上游测速**：选择订阅模型后默认全选其全部上游，可手动多选；逐个测速并实时填表，显示生成速度、体感均速、首包延迟、输入/输出/缓存读报价，以及 OpenRouter 的 5m/1d 或 Vercel 的 15m/1d 可用性。
- **测速表格**：完成后默认按生成速度降序；点击表头可按速度、价格、可用性降序或首包延迟升序排列，缺失值置后。表格采用紧凑布局，窄屏可横向滚动，来源与正文集中折叠展示；失败项仅显示“失败”，并继续测试后续上游。
- **DeepSeek Flash**：订阅入口预置 16 个上游，目录模型入口预置 29 个；具体渠道是否可用以实际探测和测试为准。

批量测速每个上游最多生成 1024 token，单项超时 120 秒，会消耗订阅额度。价格单位为美元/百万 token，可用性取对应网关公开接口；缺失数据静默隐藏。

![批量上游测速结果](docs/image.png)

图中排名靠前的端点均带有 `fp8` / `fp4` 标注，我认为它们对应量化版本。不过，这些端点标签读取自 OpenRouter 提供的数据，不一定准确；端点名称没有 `fp8` / `fp4` 标注，也不意味着没有量化。

根据本次截图中的测速结果，排除明确标注 `fp8` / `fp4` 的端点后，`deepseek` 上游 API 的首包延迟最低、生成速度第二、体感均速第一，符合预期。这是本次测速的观察结果。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A5%2018-green)
![Docker](https://img.shields.io/badge/docker-ready-2496ED)

**零依赖**的 Node.js 本地/服务器代理 + 网页控制台，用于 [Cline Pass](https://cline.bot/cline-pass) 订阅：

- 🔍 **上游枚举与校验** —— 列出订阅模型背后每一条上游渠道，并一键实测哪些「✔可用 / ⏳限流 / ✘不可钉」
- 🎯 **精确钉住上游** —— 严格钉住 / 优先+回退两种模式，支持按最低成本、最快首字、最高吞吐排序
- 🧬 **多上游优先级故障转移（2026-09-06 新增）** —— 勾选多个上游即按勾选顺序逐个尝试：第一个异常（报错 / 网络失败 / 超时）自动顺切下一个，全部失败才透传错误；每次尝试有独立 120s 超时与逐次尝试明细（请求头 X-Cline-Target-Upstream: a>b 与 X-Cline-Attempts，历史与测试台展示逐次尝试路径 upstream(502) 到 upstream(200)）
- 🚫 **上游排除** —— 勾「排除」的渠道永不被使用：勾选模式下从候选中剔除；自动模式与优先+回退模式下把排除换算成 only 白名单（已知上游 - 排除项）注入，两类管道均实测生效；网关侧渠道清单更新导致白名单过期时，报错中附带的最新渠道清单会被自动学习合并
- 👥 **账号池** —— 多账号管理、手动切换、轮询均衡、逐账号连通性测试与用量统计
- 📊 **观测** —— 每条请求自动记录实际命中的渠道、背后模型、耗时（含流式）
- 🔑 **代理密钥** —— 给下游客户端发一把独立密钥，可随时在页面轮换
- 🌐 **OpenAI 兼容** —— 任何 OpenAI 客户端 / Cline 扩展把 Base URL 指向代理即可，无侵入

![控制台截图](docs/screenshot-top.png)

---

## Termux 一键部署（推荐）

Android / Termux 用户推荐直接使用一键部署脚本。

在 Termux 中复制并执行下面这一条命令：

```bash
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/xfan5610-maker/cline-pass-switcher-v3/main/install-termux.sh | bash
```

脚本会自动完成：

- 检查 Git，没有则自动安装；
- 检查 Node.js，已有 Node.js ≥ 18 时不会修改现有版本；
- 检查 PM2，没有则自动安装；
- 下载项目到 `~/cline-pass-switcher-v3`；
- 检查 `server-v3.js` 语法；
- 启动 `cline-pass-v3` 后台服务；
- 保存 PM2 进程列表，方便后续恢复运行。

部署完成后打开：

```text
http://127.0.0.1:3123/
```

然后在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。

没有 key 也可以先启动，进入管理面板后再配置。

### 更新 / 重新部署

以后需要更新项目时，可以直接再次执行同一条命令：

```bash
pkg install -y curl && curl -fsSL https://raw.githubusercontent.com/xfan5610-maker/cline-pass-switcher-v3/main/install-termux.sh | bash
```

如果项目已经存在，脚本会拉取最新代码并重新启动 PM2 服务，不需要重新手动部署。

### 常用 Termux 管理命令

查看运行状态：

```bash
pm2 ls
```

重启服务：

```bash
pm2 restart cline-pass-v3
```

查看日志：

```bash
pm2 logs cline-pass-v3
```

停止服务：

```bash
pm2 stop cline-pass-v3
```

如果 Termux 被 Android 系统关闭，重新打开 Termux 后可尝试恢复已保存的服务：

```bash
pm2 resurrect
```

---
![上游管理：路由模式、优先上游与排除上游](docs/termux-06.jpg)

![模型管理：模型探测、测试、校验与路由入口](docs/termux-05.jpg)

![上游测速结果：生成速度、首包延迟与价格排名](docs/termux-02.jpg)

![上游测速结果：速度、延迟与价格排名](docs/termux-03.jpg)
## 30 秒上手（本地）

如果不使用一键部署，也可以手动运行：

```bash
git clone https://github.com/xfan5610-maker/cline-pass-switcher-v3.git
cd cline-pass-switcher-v3
node server-v3.js     # 仅需 Node ≥ 18，无需 npm install
```

打开 <http://127.0.0.1:3123/>，在「账号管理」里添加你的 Cline Pass 账号（`sk_` 开头的 key）并保存即可。

没有 key 也能启动：页面会提示配置入口。

本地语法检查：

```bash
node --check server-v3.js
```

> Cline Pass key 从哪里来？购买 Cline Pass 订阅后，在 Cline 的账户设置里创建 API Key。
>
> 订阅模型 ID 均为 `cline-pass/*` 前缀（如 `cline-pass/glm-5.2`）。

客户端接入（任何 OpenAI 兼容工具）：

```text
Base URL: http://127.0.0.1:3123/v1
API Key:  （在控制台「访问与安全」里设置代理密钥；本地留空 = 不鉴权）
Model:    cline-pass/glm-5.2 等
```

---

## Docker 部署

以下 Docker 配置已统一使用 `server-v3.js` 启动，与本地运行使用相同的配置文件格式。

### 方式 A：All-in-one（自带 Caddy 自动 HTTPS，推荐新手）

```bash
mkdir -p data && cp config.example.json data/config.json
# 编辑 data/config.json，或在启动时用环境变量注入 key

# 有域名（A 记录指向服务器，自动签发 Let's Encrypt 受信证书）：
CPASS_DOMAIN=pass.example.com docker compose -f deploy/docker-compose.all-in-one.yml up -d --build

# 只有 IP（自签证书，浏览器需手动信任一次）：
docker compose -f deploy/docker-compose.all-in-one.yml up -d --build
```

访问 `https://你的域名/`（或 `https://服务器IP/`），控制台里设置代理密钥即可对外提供服务。

### 方式 B：已有反向代理（nginx / Caddy 等）

根目录的 `docker-compose.yml` 只启动应用并绑定 `127.0.0.1:3123`，由你现有的 nginx/Caddy 做 TLS：

```nginx
location / {
    proxy_pass http://127.0.0.1:3123;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_buffering off;            # 流式响应必须
    proxy_read_timeout 600s;
}
```

### 环境变量

| 变量 | 说明 |
|---|---|
| `CLINE_PASS_KEY` | 上游 Cline Pass API Key（无 config 时自动创建账号） |
| `PROXY_KEY` | 下游代理密钥（客户端访问代理的凭据） |
| `PUBLIC_BASE_URL` | 门户展示的公网代理地址，如 `https://pass.example.com` |
| `PORT` / `BIND_HOST` / `DATA_DIR` | 端口 / 绑定地址（容器内为 0.0.0.0）/ 配置目录 |

环境变量在启动时覆盖 `config.json`；此后通过控制台保存设置，会以当前生效值写回文件。

---

## 配置参考（config.json）

| 字段 | 说明 |
|---|---|
| `accounts` | 账号池：`[{ name, key, enabled }]` |
| `accountMode` | `single` 手动指定 / `roundrobin` 轮询 |
| `activeAccount` | 单账号模式下使用的下标 |
| `proxyKey` | 下游代理密钥；空 = 不鉴权 |
| `publicBaseUrl` | 公网代理地址（控制台展示用） |
| `exposeCatalog` | `true` 时代理的 `/v1/models` 会合并 Cline 公开目录模型；默认 `false` 只返回订阅模型（避免客户端模型列表被淹没） |
| `knownModels` | 订阅模型清单（控制台主表） |
| `perModel` | 每模型的钉住配置：`{ upstreams: [], exclude: [], pinMode: strict|preferred, sort: cost|ttft|tps }`；`upstream` 为首个优先上游的兼容镜像 |
| `apiKey` | 旧版单 key 字段，启动时自动迁移进 `accounts` |

---

## 核心机制：Cline Pass 的两条路由管道（实测发现）

Cline Pass 订阅模型在 Cline 网关之后分成两条管道，钉住上游的写法**完全不同**：

| 管道 | 实际后端 | 识别特征 | 钉住方式 |
|---|---|---|---|
| **直连**（direct） | OpenRouter | 响应顶层带 `provider` 与真实 `model` 字段 | 顶层 `provider.only / order` |
| **规划器**（planner） | **Vercel AI Gateway** | 响应带 `provider_metadata.gateway.routing` | **`providerOptions.gateway.only / order / sort`** |

**关键发现**：规划器管道的请求由 Vercel AI Gateway 执行，请求体里的顶层 `provider.only/order` 会被 Cline 丢弃
（这也是官方 API 上"换上游不生效"的原因），但 `providerOptions.gateway` 嵌套形式会**原样透传**：

```json
{
  "model": "cline-pass/glm-5.2",
  "messages": [],
  "providerOptions": { "gateway": { "only": ["alibaba"] } }
}
```

实测响应：`finalProvider: "alibaba"`，规划器理由变为 `Provider set restricted to: alibaba`。

参考：[Vercel AI Gateway — Provider Filtering, Ordering & Sorting](https://vercel.com/docs/ai-gateway/models-and-providers/provider-filtering-and-ordering)

### 上游枚举的三种手段

1. **响应元数据回读**：规划器管道带 `canonicalSlug` / `fallbacksAvailable` / `finalProvider`；直连管道顶层 `provider` 即实际上游；
2. **假上游探测**（零 token）：带不存在的 `only:["__probe__"]` 让网关在路由层报错并列出精确的可用渠道清单（两条管道的清单**不一致**，要分别取）；
3. **OpenRouter 公开接口** `GET /api/v1/models/{slug}/endpoints`：补充上下文长度/在线率（对直连管道有直接参考意义）。

### 实测记录（2026-09）

| 实验 | 结果 |
|---|---|
| glm-5.2 + 顶层 `provider.only/ignore/order` | 全部被网关丢弃，恒选同一渠道 |
| glm-5.2 + `providerOptions.gateway.only:["alibaba"]` | ✔ `finalProvider: alibaba` |
| glm-5.2 流式 + `only:["baseten"]` | ✔ 流式同样生效 |
| glm-5.2 + `providerOptions.gateway.sort:"cost"` | ✔ 按成本重排执行顺序 |
| glm-5.3-flash（直连）+ 顶层 `provider.only:["gmicloud"]` | ✔ `provider: "GMICloud"` |
| glm-5.3-flash + `providerOptions.gateway` | ✘ 无效（直连管道只认顶层 provider 形式） |

> 管道归属由 Cline 侧决定、可能随时间变化，控制台的「探测」会刷新每个模型的管道类型与渠道清单。

---

## 控制台功能一览

| 卡片 | 功能 |
|---|---|
| 账号管理 | 账号池增删改、显隐密钥、逐账号连通性测试、单账号/轮询模式、用量统计 |
| 访问与安全 | 修改下游代理密钥（即时生效）、公网代理地址、鉴权开关 |
| 订阅模型 | 背后模型 / 渠道数 / 最近实际渠道；渠道下拉（带可用性标注）；严格钉住 / 优先+回退；排序 |
| 操作按钮 | 探测（刷新渠道清单）、测试（单次钉住验证）、校验（全渠道实测地图） |
| 测试台 | 任选模型+渠道发一条小请求，直接看网关是否采纳 |
| 请求历史 | 自动记录每条请求的账号、实际渠道、耗时、尝试序列（最近 100 条，含流式） |
| 完整目录 | Cline 公开目录模型，`:free` 变体可精确钉住 |

代理同时做了兼容性标准化：解包 Cline 的 `{"data":...}` 包装为标准 OpenAI 格式、错误统一为
`{"error":{"message":...}}`、附加 `X-Cline-Target-Upstream / X-Cline-Actual-Upstream / X-Cline-Account` 等响应头。

---

## 常见问题

**Q：为什么选了某个渠道会报 `invalid_request_error`？**

部分渠道被单独钉住时会因模型 ID 映射失败，还有渠道处于共享池限流（429）状态。点该模型行的「校验」，
把所有渠道实测一遍，下拉框会标注 ✔可用 / ⏳限流 / ✘不可钉。钉住失败的渠道会被自动学习标记。

**Q：限流的渠道还能用吗？**

能。限流是共享池的临时状态，过段时间重新「校验」即可；或改用「优先+回退」模式，限流时自动跳到其他渠道。

**Q：直接用官方 API 写 `provider.only` 为什么不生效？**

对规划器管道（走 Vercel AI Gateway 的模型）会被 Cline 网关丢弃，请改用 `providerOptions.gateway`，见上文。

**Q：两条管道的渠道清单为什么不一样？**

钉住发生在不同后端（OpenRouter vs Vercel AI Gateway），各自支持的渠道池不同，要以对应清单为准。

**Q：订阅额度怎么计？**

经代理的请求与直连官方 API 计费一致；「探测/测试/校验」会产生极小额的真实请求（每次约 0.0002 美元级）。

---

## 安全提醒

- `config.json` / `data/` 含明文密钥，已在 `.gitignore` 排除，**不要提交或分享**；
- 对外部署务必设置 `proxyKey`（控制台可随时轮换）；
- 多上游故障转移会逐个尝试已选择的渠道，注意请求量和额度消耗。

## License

[MIT](LICENSE)
