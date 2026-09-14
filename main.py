"""
HearReview v0.4 - LocalAgreement streaming captions

核心逻辑：
1. 麦克风持续采集音频，同时保存完整 WAV。
2. 每当积累约0.8秒新音频，重新识别尚未确认的音频缓冲区。
3. 比较本轮和上一轮识别结果。
4. 连续两轮都相同的前缀单词被视为“已确认”。
5. 已确认文字立即向下输出并写入 Markdown。
6. 尚未确认的末尾文字留到下一轮继续判断。
7. 不依赖老师停顿，因此连续讲话时仍能不断输出。

当前默认：
- 运行设备：Desktop
- 模型：base.en
- 推理：CPU int8

如果之后完成 CUDA 配置，只需修改模型配置，不必重写流式算法。
"""

from __future__ import annotations

import queue
import re
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel


# -------------------- 基础配置 --------------------

SAMPLE_RATE = 16_000
CHANNELS = 1

# 麦克风每次回调提供100毫秒音频。
CALLBACK_BLOCK_SECONDS = 0.1
CALLBACK_BLOCK_SAMPLES = int(
    SAMPLE_RATE * CALLBACK_BLOCK_SECONDS
)

# 每增加约0.8秒音频，执行一次流式识别。
UPDATE_INTERVAL_SECONDS = 0.8

# 音频不足1秒时不开始识别。
MINIMUM_BUFFER_SECONDS = 1.0

# 如果长期无法确认任何文字，缓冲超过25秒时启用保护性提交，
# 防止一堂长课中内存不断增加。
MAXIMUM_BUFFER_SECONDS = 25.0

# 保护性提交时保留末尾3秒，不强制确认。
FORCED_KEEP_SECONDS = 3.0


# -------------------- 模型配置 --------------------

MODEL_NAME = "base.en"
INFERENCE_DEVICE = "cpu"
COMPUTE_TYPE = "int8"

COURSE_PROMPT = (
    "This is an English university lecture. "
    "Possible topics include electronic engineering, mathematics, "
    "physics, programming, circuits, signals, systems, robotics, "
    "algorithms and artificial intelligence."
)


# 麦克风回调只负责把音频放进队列。
audio_queue: queue.Queue[np.ndarray] = queue.Queue()

# 通知识别线程结束。
stop_event = threading.Event()


@dataclass
class WordToken:
    """
    Whisper返回的一个单词。

    start和end是相对于当前未确认音频缓冲区的时间。
    """

    text: str
    start: float
    end: float


class StreamingAudioBuffer:
    """
    保存尚未确认的音频。

    主线程不断追加麦克风音频；
    识别线程确认文字后，从缓冲区前端删除对应音频。
    """

    def __init__(self):
        self._audio = np.empty(
            0,
            dtype=np.float32
        )

        # 当前缓冲区开头在整堂课中的绝对时间。
        self._start_time = 0.0

        self._lock = threading.Lock()

    def append(self, audio: np.ndarray):
        """加入新录制的音频。"""
        with self._lock:
            self._audio = np.concatenate([
                self._audio,
                audio
            ])

    def snapshot(
        self
    ) -> tuple[np.ndarray, float]:
        """
        返回当前音频副本和绝对开始时间。

        Whisper推理使用副本，避免推理期间阻塞录音。
        """
        with self._lock:
            return (
                self._audio.copy(),
                self._start_time
            )

    def trim(self, seconds: float):
        """
        删除已经确认的前端音频。

        seconds是相对于当前缓冲区开头的时间。
        """
        samples = int(seconds * SAMPLE_RATE)

        if samples <= 0:
            return

        with self._lock:
            samples = min(
                samples,
                len(self._audio)
            )

            self._audio = self._audio[
                samples:
            ].copy()

            self._start_time += (
                samples / SAMPLE_RATE
            )


def audio_callback(
    indata,
    frames,
    time_info,
    status
):
    """
    麦克风回调函数。

    回调中不运行Whisper，避免推理导致麦克风丢帧。
    """
    if status:
        print(
            f"\n录音警告：{status}",
            flush=True
        )

    audio_queue.put(
        indata[:, 0].copy()
    )


def float_to_pcm16(
    audio: np.ndarray
) -> np.ndarray:
    """将float32音频转换成16位PCM，用于保存WAV。"""
    audio = np.clip(
        audio,
        -1.0,
        1.0
    )

    return (
        audio * 32767
    ).astype(np.int16)


def create_temporary_wav(
    audio: np.ndarray
) -> Path:
    """创建供faster-whisper读取的临时WAV文件。"""
    temporary_file = tempfile.NamedTemporaryFile(
        suffix=".wav",
        delete=False
    )
    temporary_file.close()

    wav_path = Path(
        temporary_file.name
    )

    with wave.open(
        str(wav_path),
        "wb"
    ) as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(
            SAMPLE_RATE
        )

        wav_file.writeframes(
            float_to_pcm16(
                audio
            ).tobytes()
        )

    return wav_path


def normalize_word(word: str) -> str:
    """
    标准化单词，用于比较连续两轮识别结果。

    忽略大小写和标点，但不会修改最终显示的原始文字。
    """
    normalized = re.sub(
        r"[^a-z0-9']",
        "",
        word.lower()
    )

    # 如果token本身只有标点，保留原始内容用于比较。
    return normalized or word.strip()


def find_common_prefix_length(
    previous_words: list[WordToken],
    current_words: list[WordToken]
) -> int:
    """
    寻找连续两轮识别结果共同的最长前缀。

    只有两轮都一致的单词才会被确认。
    这就是LocalAgreement-2的核心。
    """
    maximum_length = min(
        len(previous_words),
        len(current_words)
    )

    common_length = 0

    for index in range(maximum_length):
        previous = normalize_word(
            previous_words[index].text
        )

        current = normalize_word(
            current_words[index].text
        )

        if previous != current:
            break

        common_length += 1

    return common_length


def join_words(
    words: list[WordToken]
) -> str:
    """
    将Whisper词级token重新组合成可读文本。

    删除句号、逗号等标点前不必要的空格。
    """
    text = " ".join(
        word.text.strip()
        for word in words
        if word.text.strip()
    )

    text = re.sub(
        r"\s+([,.!?;:%])",
        r"\1",
        text
    )

    text = re.sub(
        r"([\(\[\{])\s+",
        r"\1",
        text
    )

    return " ".join(
        text.split()
    )


def format_time(seconds: float) -> str:
    """把秒数转换成00:00:00格式。"""
    seconds = max(
        0,
        int(seconds)
    )

    hours = seconds // 3600
    minutes = (
        seconds % 3600
    ) // 60
    remaining = seconds % 60

    return (
        f"{hours:02d}:"
        f"{minutes:02d}:"
        f"{remaining:02d}"
    )


def transcribe_buffer(
    model: WhisperModel,
    audio: np.ndarray
) -> list[WordToken]:
    """
    识别当前尚未确认的音频缓冲区。

    必须开启word_timestamps，因为确认文字后需要知道
    应该从音频缓冲区删除到哪个位置。
    """
    wav_path = create_temporary_wav(
        audio
    )

    try:
        segments, _ = model.transcribe(
            str(wav_path),
            language="en",

            # 实时识别优先低延迟。
            beam_size=1,
            best_of=1,

            word_timestamps=True,

            # 连续讲话时不能等待VAD分句。
            vad_filter=False,

            condition_on_previous_text=False,
            temperature=0,

            initial_prompt=COURSE_PROMPT
        )

        words: list[WordToken] = []

        # faster-whisper的segments是生成器，
        # 真正推理会在这里迭代时发生。
        for segment in segments:
            if segment.words is None:
                continue

            for word in segment.words:
                text = word.word.strip()

                if not text:
                    continue

                words.append(
                    WordToken(
                        text=text,
                        start=float(word.start),
                        end=float(word.end)
                    )
                )

        return words

    finally:
        wav_path.unlink(
            missing_ok=True
        )


def write_confirmed_text(
    transcript_path: Path,
    words: list[WordToken],
    buffer_start_time: float
):
    """
    将新确认的文字向下输出，并写入字幕文件。

    每次只输出这次新确认的部分，不重复输出历史文字。
    """
    if not words:
        return

    text = join_words(words)

    if not text:
        return

    absolute_start = (
        buffer_start_time +
        words[0].start
    )

    absolute_end = (
        buffer_start_time +
        words[-1].end
    )

    timestamp = (
        f"[{format_time(absolute_start)}"
        f"–{format_time(absolute_end)}]"
    )

    line = f"{timestamp} {text}"

    print(
        line,
        flush=True
    )

    with transcript_path.open(
        "a",
        encoding="utf-8"
    ) as transcript_file:
        transcript_file.write(
            line + "\n\n"
        )


def shift_word_timestamps(
    words: list[WordToken],
    removed_seconds: float
) -> list[WordToken]:
    """
    音频缓冲区前端被删除后，相应调整未确认单词时间戳。

    这些时间戳主要用于维持流式状态；
    下一轮Whisper仍会从新缓冲区重新识别。
    """
    shifted = []

    for word in words:
        shifted.append(
            WordToken(
                text=word.text,
                start=max(
                    0.0,
                    word.start -
                    removed_seconds
                ),
                end=max(
                    0.0,
                    word.end -
                    removed_seconds
                )
            )
        )

    return shifted


def recognition_worker(
    model: WhisperModel,
    streaming_buffer: StreamingAudioBuffer,
    transcript_path: Path
):
    """
    后台流式识别线程。

    连续两轮识别相同的前缀会立即确认。
    麦克风录音由主线程负责，因此推理不会中断录音。
    """
    previous_words: list[
        WordToken
    ] = []

    # 记录上一次处理到的绝对音频末尾，
    # 避免没有新声音时重复识别相同缓冲区。
    last_processed_audio_end = 0.0

    while not stop_event.is_set():
        audio, buffer_start_time = (
            streaming_buffer.snapshot()
        )

        buffer_duration = (
            len(audio) /
            SAMPLE_RATE
        )

        absolute_audio_end = (
            buffer_start_time +
            buffer_duration
        )

        new_audio_duration = (
            absolute_audio_end -
            last_processed_audio_end
        )

        if (
            buffer_duration <
            MINIMUM_BUFFER_SECONDS
            or new_audio_duration <
            UPDATE_INTERVAL_SECONDS
        ):
            stop_event.wait(0.05)
            continue

        inference_started = (
            time.monotonic()
        )

        try:
            current_words = (
                transcribe_buffer(
                    model,
                    audio
                )
            )

        except Exception as error:
            print(
                f"\n识别错误：{error}",
                flush=True
            )

            stop_event.wait(0.5)
            continue

        inference_time = (
            time.monotonic() -
            inference_started
        )

        last_processed_audio_end = (
            absolute_audio_end
        )

        common_length = (
            find_common_prefix_length(
                previous_words,
                current_words
            )
        )

        if common_length > 0:
            confirmed_words = (
                current_words[
                    :common_length
                ]
            )

            write_confirmed_text(
                transcript_path,
                confirmed_words,
                buffer_start_time
            )

            trim_end = (
                confirmed_words[-1].end
            )

            streaming_buffer.trim(
                trim_end
            )

            # 保留本轮尚未确认的后缀，
            # 下一轮将与新的识别结果继续比较。
            previous_words = (
                shift_word_timestamps(
                    current_words[
                        common_length:
                    ],
                    trim_end
                )
            )

        else:
            previous_words = (
                current_words
            )

        # 如果模型速度跟不上，输出提示方便后续调参。
        if (
            inference_time >
            UPDATE_INTERVAL_SECONDS * 2
        ):
            print(
                f"[性能提示] 单次识别耗时 "
                f"{inference_time:.2f}s",
                flush=True
            )

        # 长时间无法形成共同前缀时启用保护机制。
        audio, buffer_start_time = (
            streaming_buffer.snapshot()
        )

        buffer_duration = (
            len(audio) /
            SAMPLE_RATE
        )

        if (
            buffer_duration >
            MAXIMUM_BUFFER_SECONDS
            and previous_words
        ):
            safe_cutoff = (
                buffer_duration -
                FORCED_KEEP_SECONDS
            )

            forced_words = [
                word
                for word in previous_words
                if word.end <= safe_cutoff
            ]

            if forced_words:
                write_confirmed_text(
                    transcript_path,
                    forced_words,
                    buffer_start_time
                )

                trim_end = (
                    forced_words[-1].end
                )

                streaming_buffer.trim(
                    trim_end
                )

                previous_words = [
                    WordToken(
                        text=word.text,
                        start=max(
                            0,
                            word.start -
                            trim_end
                        ),
                        end=max(
                            0,
                            word.end -
                            trim_end
                        )
                    )
                    for word in previous_words
                    if word.end > trim_end
                ]

    # 停止录音后，对剩余音频做最后一次识别。
    audio, buffer_start_time = (
        streaming_buffer.snapshot()
    )

    if (
        len(audio) / SAMPLE_RATE >= 0.3
    ):
        try:
            final_words = transcribe_buffer(
                model,
                audio
            )

            write_confirmed_text(
                transcript_path,
                final_words,
                buffer_start_time
            )

        except Exception as error:
            print(
                f"\n最后一段识别失败：{error}",
                flush=True
            )


def main():
    """启动HearReview流式字幕。"""
    print("HearReview v0.4")
    print(
        f"正在加载 {MODEL_NAME}……"
    )

    model = WhisperModel(
        MODEL_NAME,
        device=INFERENCE_DEVICE,
        compute_type=COMPUTE_TYPE
    )

    print(
        f"模型加载完成："
        f"{MODEL_NAME} / "
        f"{INFERENCE_DEVICE} / "
        f"{COMPUTE_TYPE}"
    )

    transcript_folder = Path(
        "transcripts"
    )
    recording_folder = Path(
        "recordings"
    )

    transcript_folder.mkdir(
        exist_ok=True
    )
    recording_folder.mkdir(
        exist_ok=True
    )

    session_name = (
        datetime.now().strftime(
            "%Y%m%d-%H%M%S"
        )
    )

    transcript_path = (
        transcript_folder /
        f"lecture-{session_name}.md"
    )

    recording_path = (
        recording_folder /
        f"lecture-{session_name}.wav"
    )

    transcript_path.write_text(
        "# Lecture Transcript\n\n",
        encoding="utf-8"
    )

    recording_file = wave.open(
        str(recording_path),
        "wb"
    )

    recording_file.setnchannels(
        CHANNELS
    )
    recording_file.setsampwidth(2)
    recording_file.setframerate(
        SAMPLE_RATE
    )

    streaming_buffer = (
        StreamingAudioBuffer()
    )

    worker = threading.Thread(
        target=recognition_worker,
        args=(
            model,
            streaming_buffer,
            transcript_path
        ),
        daemon=False
    )

    worker.start()

    print("\n开始流式字幕")
    print(
        "连续两轮确认的文字会向下输出"
    )
    print("按 Ctrl+C 停止\n")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=CHANNELS,
            dtype="float32",
            blocksize=(
                CALLBACK_BLOCK_SAMPLES
            ),
            callback=audio_callback
        ):
            while True:
                audio_block = (
                    audio_queue.get()
                )

                # 完整录音始终保存。
                recording_file.writeframes(
                    float_to_pcm16(
                        audio_block
                    ).tobytes()
                )

                # 将音频提供给流式识别器。
                streaming_buffer.append(
                    audio_block
                )

    except KeyboardInterrupt:
        print(
            "\n正在处理最后一段……"
        )

    finally:
        recording_file.close()
        stop_event.set()

        # 等待最后一段完成。
        worker.join()

        print("\nHearReview 已停止")
        print(
            "字幕：",
            transcript_path.resolve()
        )
        print(
            "录音：",
            recording_path.resolve()
        )


if __name__ == "__main__":
    main()
