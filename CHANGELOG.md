# 更新日志

本项目所有重要改动都会记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号参考 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 从完整 WAV 生成最终准确转录
- 课堂内容随时总结功能
- GPU（CUDA）加速支持
- 实时字幕界面（GUI）

## [0.5.3] - 2026-09-14

### 变更
- 前端重写为 `"use strict"` 版本，长时间课堂内存与导出体积受控
- 只保存服务器最新确认字幕，不再保存全部原始 WebSocket 消息
- 确认字幕改为**增量 DOM 更新**（稳定 key），不再整页重建
- 调试指标精简为最多 100 条（`DEBUG_EVENT_LIMIT`）
- 停止课堂改为**等待服务器刷新**（`ready_to_stop` / 积压归零 / 15 秒超时），不再固定等 5 秒
- 导出重新读取课程名；时间戳兼容字符串与数字

### 修复
- 服务器消息缺少 `lines` 时不再清空已有字幕
- 服务器状态与音量状态改为**同步设置 CSS class**（`SERVER_STATE_CLASS_MAP` / `setVolumeStatus`），修复颜色失效
- 不再用服务器原始 `status` 覆盖中文友好状态
- 字幕 DOM key 改用服务器行 ID 或 `speaker + start`，不再用数组 `index` / `end`，避免位移与重建
- 课堂进行中禁止刷新麦克风设备

### 样式
- 新增 `#volume-status.low`、`#volume-status.error`

## [0.5.2] - 2026-09-14

### 新增
- 课程名称输入框（默认 `Untitled Lecture`）
- 下载拆分为两个按钮：**下载字幕**（Markdown）与 **下载JSON**
- Markdown 导出：只包含已确认的 `lines`，含标题、创建时间、段落数、时间戳与 Speaker

### 变更
- 下载逻辑拆分为 `downloadMarkdownTranscript` 与 `downloadJsonSession`
- 新增 `latestConfirmedLines` 快照（复制服务器返回的确认字幕，避免被后续消息修改）
- 移除废弃的 `#download-button` 样式

## [0.5.1] - 2026-09-14

### 新增
- 输入设备选择：可枚举并选择麦克风，支持“刷新”与设备热插拔自动刷新
- 实时音量条（对数刻度）与静音状态提示（有声音 / 音量较低 / 没有声音）
- 启动麦克风时打印当前设备 label 与 settings

### 变更
- `startMicrophone` 按所选 `deviceId` 请求麦克风
- 移除每秒一次的 RMS 调试 `console.log`，改为驱动音量条

## [0.5.0] - 2026-09-14

### 新增
- **自定义 Web 界面**：`frontend/`（`index.html`、`style.css`、`app.js`）
- 浏览器麦克风采集，实时重采样为 16 kHz 单声道 PCM16
- 通过 WebSocket 连接 WhisperLiveKit（`ws://127.0.0.1:8000/asr`）
- `lines` 作为已确认字幕**全量重渲染**（不盲目追加）
- `buffer_transcription` 作为临时字幕，仅更新底部区域
- 自动滚动、课堂计时器、服务器连接状态
- 显示转录 / 确认策略 / 模型处理积压时间
- 保存全部原始 JSON，一键下载课堂记录
- 开始 / 停止课堂按钮
- `start_server.ps1`：一键启动 WhisperLiveKit 服务

### 说明
- 识别后端切换到 **WhisperLiveKit + SimulStreaming**（`base` 模型，faster-whisper）
- 前端原型使用 `ScriptProcessorNode`，后续可替换为 AudioWorklet
- 语音识别参数保持不变，本版仅新增界面

## [0.4.0] - 2026-09-14

### 新增
- **LocalAgreement-2 流式字幕**：每约 0.8 秒重新识别未确认音频缓冲区
- 连续两轮识别结果相同的前缀单词立即确认并向下输出
- 词级时间戳（`word_timestamps=True`），按确认位置裁剪音频缓冲区
- 保护性提交：缓冲超过 25 秒时强制确认前段，保留末尾 3 秒，防止内存增长
- 性能提示：单次识别超过 1.6 秒时打印耗时

### 变更
- **移除 WebRTC VAD 分句**，不再依赖停顿，连续讲话也能输出
- 新增 `StreamingAudioBuffer`（带锁），主线程追加、识别线程裁剪
- 新增 `WordToken`、`find_common_prefix_length`、`join_words`、`shift_word_timestamps`
- 麦克风回调改为 100 毫秒块、`dtype="float32"`
- 停止时对剩余音频做最后一次识别

### 移除
- 依赖 `webrtcvad` / `webrtcvad-wheels`

### 说明
- 目前仍仅支持英文、仅 CPU（int8）
- 尚未完成最终转录与总结功能

## [0.3.1] - 2026-09-14

### 新增
- 基于 **WebRTC VAD** 的语句切分：检测到约 0.7 秒停顿后判定一句结束
- 句首 0.3 秒预录音（pre-roll），避免切掉句首
- 按“一句一条”识别并**固定向下追加**字幕，不再覆盖或重复
- 语音段最长 20 秒强制切分（`MAX_UTTERANCE_SECONDS`）
- 过滤过短声音（< 0.3 秒），避免咳嗽/碰撞声触发字幕
- 每条字幕显示识别耗时，便于评估 3 秒延迟目标

### 变更
- 录音改为 `dtype="int16"`、30 毫秒定长帧，满足 WebRTC VAD 输入要求
- 恢复写 `transcripts/`：因为字幕是句子级稳定结果
- 后台识别线程 `daemon=False`，`Ctrl+C` 时先把剩余句子处理完再退出
- 识别参数：`beam_size=1`、`best_of=1`、`vad_filter=False`、`without_timestamps=True`

### 依赖
- 新增 `webrtcvad`（Python 3.13 使用预编译轮子 `webrtcvad-wheels`，避免 MSVC 编译）

### 说明
- 目标：老师讲完一句话后约 3 秒内输出稳定字幕
- 目前仍仅支持英文、仅 CPU（int8）

## [0.3.0] - 2026-09-14

### 新增
- 低延迟实时字幕：约每 1 秒重新识别最近 6 秒音频
- 临时字幕在终端同一行原地刷新（ANSI 清行），不再追加重复内容
- 后台字幕线程与录音线程分离，推理不阻塞录音
- 滚动音频缓冲区（`rolling_audio`）与线程锁保护

### 变更
- 模型由 `small.en` 换为更快的 `base.en`（CPU int8）
- 识别参数改为 `beam_size=1`、`best_of=1`、`vad_filter=False`、`without_timestamps=True`
- 本版本**不再写 `transcripts/` 最终稿**：临时字幕会不断被修正，不作为课堂记录
- `Ctrl+C` 后仅保存完整录音，并等待后台线程退出

### 说明
- 字幕为“临时预览”，下一次识别可能修改上一轮文字
- 最终准确转录将在后续版本中从完整 WAV 重新生成
- 目前仍仅支持英文、仅 CPU（int8）

## [0.2.1] - 2026-09-14

### 变更
- 去重方式从“文字完全相同”改为基于 **Whisper 时间戳的稳定区提交**，不再单纯依赖文本匹配
- 重叠窗口由 2 秒增加到 4 秒，减少跨窗口句子被截断
- 新增 `UNSTABLE_TAIL_SECONDS = 2`：窗口末尾 2 秒的字幕延迟到下一轮再提交
- 新增 `committed_until` 机制，按时间戳过滤已输出内容（含 0.15 秒容差）
- 字幕时间戳由单点改为 `[开始–结束]` 区间

### 重构
- `transcribe_window` 返回带时间戳的片段列表 `(start, end, text)`
- 新增 `process_window`、`write_subtitle`、`clean_text` 函数
- 移除旧的 `remove_repeated_sentences`、`remove_cross_chunk_overlap`、`save_temporary_wav`
- 补充完整中文注释与模块文档

### 说明
- 字幕为“稳定模式”，延迟约 8–12 秒
- 目前仍仅支持英文、仅 CPU（int8）

## [0.2.0] - 2026-09-13

### 新增
- 实时麦克风录音与转写
- 每 8 秒滚动转写（带 2 秒重叠，减少断句丢失）
- Whisper `small.en` 模型（CPU int8）
- 重复句子去重（`remove_repeated_sentences`）
- 跨段文字重叠去重（`remove_cross_chunk_overlap`）
- 带时间戳字幕输出到 `transcripts/`
- 完整课堂录音保存到 `recordings/`
- `Ctrl+C` 停止时处理最后一段录音

### 说明
- 目前仅支持英文（`language="en"`）
- 目前仅使用 CPU，避免 CUDA DLL 问题
