# 更新日志

本项目所有重要改动都会记录在此文件。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号参考 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中
- 课堂内容随时总结功能
- GPU（CUDA）加速支持
- 实时字幕界面（GUI）

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
