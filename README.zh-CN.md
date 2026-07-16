# WaveInflu Skills

[English](README.md) | 简体中文

WaveInflu 官方 Agent Skills，通过 WaveInflu API 查找相似达人和公开商务邮箱。

| Skill | 能力 | 额度 |
|---|---|---|
| `waveinflu-discover-creators` | 查找相似的 YouTube、TikTok 或 Instagram 达人 | 主额度 |
| `waveinflu-lookup-creator-email` | 查询单个达人的公开商务邮箱和联系方式 | 邮箱额度 |

两个 API 操作都是会扣减额度的 POST 请求。内置 Node.js 脚本每次只发送一个请求，绝不自动重试，并返回服务端报告的剩余额度。

## 环境要求

- Node.js 22 或更高版本。
- 在 WaveInflu 扩展中签发的 API Key。
- Codex、Claude Code、Cursor 或其他兼容 Agent Skills 的 Agent。

无需安装 WaveInflu CLI 或 MCP Server。

## 安装

为检测到的 Agent 全局安装两个 Skill：

```bash
npx skills add waveinflu/skills --global
```

为 Codex 无交互安装两个 Skill：

```bash
npx skills add waveinflu/skills \
  --global \
  --agent codex \
  --skill waveinflu-discover-creators waveinflu-lookup-creator-email \
  --yes
```

本地开发时，可以从本地仓库中列出 Skill，不执行安装：

```bash
npx skills add /absolute/path/to/waveinflu-skills --list
```

如果 Agent 没有识别新安装的 Skill，请重启 Agent。

## 配置 API Key

只在启动 Agent 的终端中设置 Key。不要将 Key 粘贴到 AI 对话、提交到 Git，或保存到项目的 `.env` 文件。

macOS 或 Linux（Bash/Zsh）：

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

从同一个终端启动 Agent，例如：

```bash
codex
```

## 使用

明确调用达人发现 Skill：

```text
$waveinflu-discover-creators
为面向美国市场的护肤活动，查找 20 个与 https://www.tiktok.com/@example 相似的 TikTok 达人。
```

明确调用邮箱查询 Skill：

```text
$waveinflu-lookup-creator-email
查找 https://www.youtube.com/@example 的公开商务邮箱。
```

自然语言请求也可以自动触发对应的 Skill。执行会扣减额度的调用前，Agent 会说明请求数量或该次查询将消耗的额度。超时或响应格式异常表示额度是否已扣减未知；除非用户发起新的请求，否则绝不重试。

## 安全与额度规则

- API Key 只从 `WAVEINFLU_API_KEY` 读取，绝不接受标准输入 JSON 中的 Key。
- 生产请求固定发送到 `https://api.wavely.cc`；脚本拒绝重定向，防止 Key 被转发到其他 Origin。
- `WAVEINFLU_API_BASE_URL` 只接受回环地址，仅用于本地测试。终端用户不应设置它。
- 脚本通过严格白名单重新构造输入后再提交，并在本地拒绝未知字段。
- 空结果、HTTP 错误、超时和响应错误都不会触发重试、翻页、放宽筛选条件或跨平台调用。
- 如果 Key 可能泄露，请在 WaveInflu 中撤销并重新签发。不要把 Key 发布到公开 Issue。

## 更新或卸载

```bash
npx skills update --global \
  waveinflu-discover-creators \
  waveinflu-lookup-creator-email
```

```bash
npx skills remove --global \
  waveinflu-discover-creators \
  waveinflu-lookup-creator-email
```

## 开发

脚本只使用 Node.js 内置 API。运行以下命令执行语法检查和本地 Mock Server 测试：

```bash
npm run check
```

测试套件不会调用 WaveInflu 生产 API，也不会消耗额度。

## 许可证

Skill 内容和内置客户端脚本采用 [MIT License](LICENSE)。该许可证不授予 API 访问权，也不改变 WaveInflu 的鉴权、额度、计费、数据使用或服务条款。
