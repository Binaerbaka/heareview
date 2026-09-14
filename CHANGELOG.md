# 更新日志

本项目所有重要改动都会记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号参考 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 从完整 WAV 生成最终准确转录
- 课堂内容随时总结功能
- GPU（CUDA）加速支持
- 实时字幕界面（GUI）

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
