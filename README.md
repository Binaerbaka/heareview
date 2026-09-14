# HearReview

上课时实时把老师讲课的语音转成字幕，并保存完整课堂录音，方便课后复习与总结。

## 功能

- 实时采集麦克风音频
- 流式识别（LocalAgreement-2）：每约 0.8 秒重新识别未确认音频
- 连续两轮识别相同的前缀单词立即确认为字幕
- 不依赖停顿分句，连续讲话时也能持续输出
- 识别结果带时间戳向下追加（Markdown）
- 同时保存完整课堂录音（WAV）
- 录音与识别分线程运行，识别期间不丢失声音

## 环境要求

- Python 3.13
- 依赖：
  - `numpy`
  - `sounddevice`
  - `faster-whisper`

安装依赖：

```bash
pip install numpy sounddevice faster-whisper
```

## 使用方法

```bash
python main.py
```

- 启动后自动加载 Whisper 模型（`base.en`，CPU int8）
- 按 `Ctrl+C` 停止，会先处理完剩余字幕再退出
- 字幕输出到 `transcripts/lecture-<时间>.md`
- 录音保存到 `recordings/lecture-<时间>.wav`

## 项目结构

```
heareview/
├── main.py            # 主程序
├── transcripts/       # 字幕输出（不上传）
├── recordings/        # 录音输出（不上传）
└── .venv313/          # 虚拟环境（不上传）
```

## 开发分工

- 代码升级：ChatGPT
- 进度文档 / 更新日志 / GitHub 维护：opencode

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 开发进度

见 [PROGRESS.md](PROGRESS.md)。
