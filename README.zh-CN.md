# WaveInflu Skills

[English](README.md) · 简体中文

无需运行 MCP Server，也无需安装 WaveInflu CLI，即可让 Agent 获得两项专注能力：发现相似达人、查询公开联系方式。

| Skill | 能力 | 额度账户 |
|---|---|---|
| `waveinflu-discover-creators` | 发现相似的 YouTube、TikTok 和 Instagram 达人 | 主额度 |
| `waveinflu-lookup-creator-email` | 查询单个达人的公开联系邮箱和链接 | 邮箱额度 |

需要 Node.js 22 或更高版本。

## 快速开始

### 1. 签发 API Key

1. [从 Chrome 应用商店安装 WaveInflu](https://chromewebstore.google.com/detail/waveinflu/memenfegdnhmjipjnfndoncinlcpfenf)，然后登录。
2. 在扩展右侧边栏打开 **API**。
3. 输入名称并签发 Key。
4. 立即复制——完整 Key 只显示一次。

### 2. 安装两个 Skill

```bash
npx skills add WaveInflu/skills --global
```

如果 Agent 已经运行，请在安装后重启。

### 3. 安全传入 Key

在即将启动 Agent 的同一个终端中设置 Key：

```bash
printf 'WaveInflu API Key: '
IFS= read -rs WAVEINFLU_API_KEY
printf '\n'
export WAVEINFLU_API_KEY
```

PowerShell 7：

```powershell
$env:WAVEINFLU_API_KEY = Read-Host "WaveInflu API Key" -MaskInput
```

不要把 Key 粘贴到对话中、提交到 Git，或暴露在客户端代码里。设置完成后，从这个终端启动 Agent。

### 4. 直接描述需求

```text
$waveinflu-discover-creators
为面向美国市场的护肤活动，查找 20 个与 https://www.tiktok.com/@example 相似的 TikTok 达人。
```

```text
$waveinflu-lookup-creator-email
查找 https://www.youtube.com/@example 的公开联系邮箱。
```

如果 Agent 能匹配已安装的 Skill，也可以省略 `$skill-name`，直接用自然语言提问。YouTube 和 TikTok 发现支持达人主页、活动描述或两者组合；Instagram 发现使用活动描述。邮箱查询每次接收一个受支持的达人 URL。

## 额度规则

主额度和邮箱额度是两个独立账户。

| 操作 | 额度规则 |
|---|---|
| YouTube 发现 | 每 3 个有效结果消耗 1 主额度 |
| TikTok 发现 | 每 5 个有效结果消耗 1 主额度 |
| Instagram 发现 | 每 2 个有效结果消耗 1 主额度 |
| TikTok 邮箱查询 | 消耗 1 邮箱额度 |
| Instagram 或 YouTube 邮箱查询 | 消耗 2 邮箱额度 |

发现达人会先按 `ceil(请求数量 ÷ 平台比例)` 预扣，再按 `ceil(有效结果数 ÷ 平台比例)` 实扣，并退回未使用的预扣额度；没有有效结果时主额度消耗为 0。邮箱查询即使没有找到公开邮箱，也会消耗对应平台额度。

调用前，Agent 会概括请求范围和预计预扣额度或查询成本；调用成功后，会报告服务端返回的剩余额度。

两个 Skill 每次只发送一个会消耗额度的 POST 请求，绝不自动重试、翻页、放宽筛选条件或切换平台。超时或响应异常后，额度状态未知；只有在你决定再次尝试后，才应发起一个新请求。

## 官方文档

- [API 总览](https://wavely.cc/docs/api)
- [邮箱查询 API](https://wavely.cc/docs/api/email-lookup)
- 相似达人 API：[YouTube](https://wavely.cc/docs/api/similar/youtube) · [TikTok](https://wavely.cc/docs/api/similar/tiktok) · [Instagram](https://wavely.cc/docs/api/similar/instagram)
- [MIT License](LICENSE)

<details>
<summary>开发与验证</summary>

需要 Node.js 22 或更高版本；内置脚本只使用 Node.js 原生 API。

```bash
npx skills add . --list
npm run check
```

测试使用本地 Mock Server，不会调用 WaveInflu 生产 API。

</details>
