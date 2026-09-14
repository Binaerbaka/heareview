# HearReview

上课时实时把老师讲课的语音转成字幕，并保存完整课堂录音，方便课后复习与总结。

## 功能

- 实时采集麦克风音频
- 流式识别（WhisperLiveKit + SimulStreaming）
- 已确认字幕（`lines`）固定向下显示，临时字幕（`buffer_transcription`）在底部实时变化
- 显示转录 / 确认策略 / 模型处理积压时间
- 保存并下载全部原始 JSON
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

> 若浏览器因安全策略拒绝麦克风，请改用本地静态服务器打开前端。

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
├── frontend/             # v0.5 Web 界面
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
