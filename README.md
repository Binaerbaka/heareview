# HearReview

上课时实时把老师讲课的语音转成字幕，并保存完整课堂录音，方便课后复习与总结。

## 功能

- 实时采集麦克风音频
- 流式识别（WhisperLiveKit + SimulStreaming）
- 已确认字幕（`lines`）固定向下显示，临时字幕（`buffer_transcription`）在底部实时变化
- 显示转录 / 确认策略 / 模型处理积压时间
- 实时课堂要点：基于已确认字幕调用 LLM 生成阶段总结（Ollama / DeepSeek / OpenAI-compatible）
- 确认字幕翻译（EN → 中 / 中 → EN），与课堂要点共用 LLM 配置
- 临时参考译文：约 1–3 秒延迟，随实时英文持续刷新，仅供课堂参考
- 最终 Review：课堂结束后从完整确认字幕生成结构化复习资料（长课堂自动分段分析再合并）
- 可调整布局：拖动分隔线调整设置栏宽度与总结面板高度
- 下载字幕（Markdown）与原始 JSON，导出包含课堂总结与已确认译文
- 同时保存完整课堂录音（WAV）

## 环境要求

- Python 3.13
- 流式服务：WhisperLiveKit（位于 `.venv-stream/`）
- 前端：现代浏览器（Chrome / Edge）

## 使用方法

### 1. 启动识别服务

```powershell
powershell -ExecutionPolicy Bypass -File .\start_server.ps1
```

服务监听 `127.0.0.1:8000`，WebSocket 地址为 `ws://127.0.0.1:8000/asr`。

### 2. 打开界面

在浏览器中打开 `frontend/index.html`，点击“开始课堂”授权麦克风即可。
界面中的分隔线可拖动，用于调整设置栏宽度与总结面板高度（尺寸保存在本机）。

> 若浏览器因安全策略拒绝麦克风，请改用本地静态服务器打开前端。

### 3. 配置 LLM（可选）

在右侧“LLM 设置”点击“展开”，选择服务、模型与 Key 后“保存并测试”。
该配置同时用于“实时课堂要点”、字幕翻译和最终 Review。

| 提供商 | 填写内容 | 默认模型 |
| --- | --- | --- |
| Ollama | 不填 Key 和地址 | `qwen2.5:7b` |
| DeepSeek | Key；地址可留空 | `deepseek-chat` |
| OpenAI-compatible | Key、完整 Chat Completions 地址 | 按服务填写 |

- 课堂要点：新增约 420 个已确认字符且距上次总结至少 45 秒时自动更新，也可手动“生成当前总结”。
- 字幕翻译：在右侧“翻译”卡片开关并选择 EN → 中 / 中 → EN；临时译文约 1–3 秒延迟，仅供课堂参考、不导出。
- 最终 Review：课堂结束后在总结面板下方点击“生成最终 Review”；长课堂会自动分段分析再合并，完整覆盖整堂课。
- API Key 只保留在当前页面，不会写入本机存储、导出文件或字幕；未配置时原有字幕功能不受影响。

### 命令行版本（v0.4，旧）

```bash
python main.py
```

- 字幕输出到 `transcripts/lecture-<时间>.md`
- 录音保存到 `recordings/lecture-<时间>.wav`

## 项目结构

```
heareview/
├── main.py               # 命令行版主程序（v0.4）
├── frontend/             # v0.7 Web 界面
│   ├── index.html
│   ├── style.css
│   └── app.js
├── start_server.ps1      # 启动 WhisperLiveKit 服务
├── data/                 # 数据目录
├── transcripts/          # 字幕输出（不上传）
├── recordings/           # 录音输出（不上传）
├── .venv313/             # 命令行版虚拟环境（不上传）
└── .venv-stream/         # WhisperLiveKit 虚拟环境（不上传）
```

## 开发分工

- 代码升级：ChatGPT
- 进度文档 / 更新日志 / GitHub 维护：opencode

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 开发进度

见 [PROGRESS.md](PROGRESS.md)。
