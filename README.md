# DoWork

DoWork 是一个 Electron 桌面文件 agent。它使用 pi agent runtime 驱动 DeepSeek，在用户选择的本地工作区中读取和修改文件。

## 第一版能力

- 左侧历史会话与本地持久化
- DeepSeek V4 Flash / V4 Pro 流式对话
- 基于 `@earendil-works/pi-agent-core` 的多轮工具循环
- 列目录、读文件、写文件、精确编辑和删除文件
- 写入、编辑、删除前逐次确认
- 工作区路径隔离，并阻止 `../` 与符号链接逃逸
- API Key 通过 Electron `safeStorage` 加密后保存；渲染进程拿不到明文
- `contextIsolation`、sandboxed preload 与 Content Security Policy

## 本地启动

要求 Node.js 22.19 或更新版本。

```bash
npm install
npm run dev
```

首次启动后，在全屏设置中心中：

1. 填写 DeepSeek API Key。
2. 选择允许 DoWork 操作的工作区文件夹。
3. 选择 DeepSeek V4 Flash（默认）或 V4 Pro。
4. 保存设置并新建任务。

也可以在启动前设置 `DEEPSEEK_API_KEY` 环境变量。不要把真实密钥写入源码、`.env` 或文档。

## 检查

```bash
npm run typecheck
npm test
npm run build
```

## 当前边界

第一版只操作 UTF-8 文本文件，不提供 shell、Git、图片编辑、插件或全盘访问。单次读取上限为 256 KB，写入或编辑后的文件上限为 1 MB，目录列表最多返回 200 项。

DeepSeek 使用 OpenAI-compatible endpoint `https://api.deepseek.com`。模型配置基于当前的 V4 Flash / V4 Pro API，而不是已经下线的 `deepseek-chat`。

## AI 能力与外部服务配置

DoWork 默认使用无需额外密钥的 Google News RSS、Hacker News API 和 Bing RSS。以下可选能力仅从环境变量读取凭据，真实密钥不要写入源码、`.env`、对话附件或文档：

```bash
# 可选：增加 NewsAPI 新闻源及本地日调用上限
export NEWSAPI_API_KEY="your-key"
export NEWSAPI_DAILY_LIMIT="50"

# 可选：图片、OCR 与 PDF 理解
export GEMINI_API_KEY="your-key"
export GEMINI_VISION_MODEL="gemini-3.7-flash"
export GEMINI_DAILY_LIMIT="50"

# 可选：网页正文抽取回退服务
export JINA_API_KEY="your-key"
export JINA_DAILY_LIMIT="100"
```

工作区长期记忆、定时任务、资讯报告和调度日志位于 `.dowork/`。敏感文件（例如 `.env`、`.ssh/`、私钥和凭据文件）默认不能作为附件发送；通过 `read_file` 读取时会单独提示，并明确说明内容将发送给 DeepSeek。运行错误、工具摘要和调度日志会对常见 API Key、Bearer Token 和私钥内容脱敏。
