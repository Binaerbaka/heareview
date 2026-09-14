"""
HearReview v0.3.1 - Sentence-based live captions

运行逻辑：
1. 持续监听麦克风并保存完整 WAV。
2. WebRTC VAD 判断老师是否正在讲话。
3. 检测到约0.7秒停顿后，认为当前语句结束。
4. 将完整语句交给 Whisper。
5. 识别完成后固定输出并向下追加。
6. 录音和识别使用不同线程，避免识别期间丢失声音。

目标：
老师讲完一句话后约3秒内输出稳定字幕。

当前默认：
Desktop 运行、CPU 推理、base.en 模型。
CUDA环境完成后，可以再切换到GPU。
"""

from __future__ import annotations

import queue
import tempfile
import threading
import time
import wave
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd
import webrtcvad
from faster_whisper import WhisperModel


# -------------------- 音频配置 --------------------

SAMPLE_RATE = 16_000

# WebRTC VAD 只接受10、20或30毫秒的音频帧。
FRAME_DURATION_MS = 30
FRAME_SAMPLES = int(
    SAMPLE_RATE * FRAME_DURATION_MS / 1000
)

# 检测到0.7秒静音后，认为老师讲完一句话。
SILENCE_TO_FINISH_SECONDS = 0.7
SILENCE_FRAMES_TO_FINISH = int(
    SILENCE_TO_FINISH_SECONDS * 1000 /
    FRAME_DURATION_MS
)

# 保存语音开始前0.3秒，避免切掉句首。
PRE_ROLL_SECONDS = 0.3
PRE_ROLL_FRAMES = int(
    PRE_ROLL_SECONDS * 1000 /
    FRAME_DURATION_MS
)

# 小于0.3秒的语音通常是咳嗽、碰撞声或误检测。
MIN_SPEECH_SECONDS = 0.3
MIN_SPEECH_FRAMES = int(
    MIN_SPEECH_SECONDS * 1000 /
    FRAME_DURATION_MS
)

# 老师如果连续讲话完全不停顿，20秒后强制切段。
MAX_UTTERANCE_SECONDS = 20
MAX_UTTERANCE_FRAMES = int(
    MAX_UTTERANCE_SECONDS * 1000 /
    FRAME_DURATION_MS
)


# -------------------- Whisper配置 --------------------

MODEL_NAME = "base.en"
INFERENCE_DEVICE = "cpu"
COMPUTE_TYPE = "int8"


# 麦克风回调和主线程之间的音频队列。
audio_queue: queue.Queue[bytes] = queue.Queue()

# 完整语句等待 Whisper 识别的队列。
transcription_queue: queue.Queue[
    "TranscriptionTask | None"
] = queue.Queue()


@dataclass
class TranscriptionTask:
    """
    一条等待识别的完整语音。

    audio_bytes:
        16 kHz、单声道、16位 PCM 数据。

    start_time/end_time:
        语句在整堂录音中的时间位置。
    """

    audio_bytes: bytes
    start_time: float
    end_time: float


def format_time(seconds: float) -> str:
    """将秒数转换为 00:00:00 格式。"""
    seconds = max(0, int(seconds))

    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    remaining = seconds % 60

    return (
        f"{hours:02d}:"
        f"{minutes:02d}:"
        f"{remaining:02d}"
    )


def audio_callback(indata, frames, time_info, status):
    """
    sounddevice 麦克风回调。

    回调中不能执行 Whisper 推理，否则会阻塞录音。
    这里只把一帧 PCM 音频放进队列。
    """
    if status:
        print(f"\n录音警告：{status}")

    # InputStream 使用int16，因此可以直接转换为PCM字节。
    frame_bytes = indata[:, 0].tobytes()
    audio_queue.put(frame_bytes)


def create_temporary_wav(
    audio_bytes: bytes
) -> Path:
    """将一条PCM语音暂存为Whisper可读取的WAV文件。"""
    temporary_file = tempfile.NamedTemporaryFile(
        suffix=".wav",
        delete=False
    )
    temporary_file.close()

    wav_path = Path(temporary_file.name)

    with wave.open(str(wav_path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(audio_bytes)

    return wav_path


def transcribe_utterance(
    model: WhisperModel,
    audio_bytes: bytes
) -> str:
    """
    识别一条已经结束的语句。

    使用 beam_size=1 降低延迟。
    由于 WebRTC VAD 已经完成语音切分，此处不再开启Whisper VAD。
    """
    wav_path = create_temporary_wav(
        audio_bytes
    )

    try:
        segments, _ = model.transcribe(
            str(wav_path),
            language="en",
            beam_size=1,
            best_of=1,
            vad_filter=False,
            condition_on_previous_text=False,
            temperature=0,
            without_timestamps=True,
            initial_prompt=(
                "This is an English university lecture about "
                "electronic engineering, mathematics, physics, "
                "programming, circuits, signals, systems, "
                "robotics and artificial intelligence."
            )
        )

        text = " ".join(
            segment.text.strip()
            for segment in segments
            if segment.text.strip()
        )

        # 合并多余空格，但不修改模型识别出的单词。
        return " ".join(text.split())

    finally:
        wav_path.unlink(missing_ok=True)


def transcription_worker(
    model: WhisperModel,
    transcript_path: Path
):
    """
    后台识别线程。

    主线程持续录音并检测停顿；这个线程逐条处理完整语句。
    因此Whisper推理不会阻止麦克风继续录音。
    """
    while True:
        task = transcription_queue.get()

        # None是结束信号：所有已提交语句处理完成后退出。
        if task is None:
            transcription_queue.task_done()
            break

        inference_started = time.monotonic()

        try:
            text = transcribe_utterance(
                model,
                task.audio_bytes
            )

            inference_time = (
                time.monotonic() -
                inference_started
            )

            if text:
                timestamp = (
                    f"[{format_time(task.start_time)}"
                    f"–{format_time(task.end_time)}]"
                )

                line = f"{timestamp} {text}"

                # 每条字幕固定向下输出，不再覆盖上一行。
                print(line, flush=True)

                with transcript_path.open(
                    "a",
                    encoding="utf-8"
                ) as transcript_file:
                    transcript_file.write(
                        line + "\n\n"
                    )

                # 显示推理耗时，方便判断能否达到3秒目标。
                print(
                    f"    识别耗时：{inference_time:.2f}s",
                    flush=True
                )

        except Exception as error:
            print(
                f"识别失败：{error}",
                flush=True
            )

        finally:
            transcription_queue.task_done()


def submit_utterance(
    utterance_frames: list[bytes],
    speech_frame_count: int,
    start_time: float,
    end_time: float
):
    """
    将已结束的语句提交给后台识别线程。

    太短的声音不会提交，避免键盘声、咳嗽或碰撞声触发字幕。
    """
    if speech_frame_count < MIN_SPEECH_FRAMES:
        return

    task = TranscriptionTask(
        audio_bytes=b"".join(
            utterance_frames
        ),
        start_time=start_time,
        end_time=end_time
    )

    transcription_queue.put(task)


def main():
    """启动一句一条的实时课堂字幕。"""
    print("HearReview v0.3.1")
    print(f"正在加载 {MODEL_NAME} 模型……")

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

    transcript_folder = Path("transcripts")
    recording_folder = Path("recordings")

    transcript_folder.mkdir(exist_ok=True)
    recording_folder.mkdir(exist_ok=True)

    session_name = datetime.now().strftime(
        "%Y%m%d-%H%M%S"
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
    recording_file.setnchannels(1)
    recording_file.setsampwidth(2)
    recording_file.setframerate(SAMPLE_RATE)

    # aggressiveness范围为0至3：
    # 0最宽松，3最严格。课堂环境先使用2。
    vad = webrtcvad.Vad(2)

    pre_roll: deque[bytes] = deque(
        maxlen=PRE_ROLL_FRAMES
    )

    utterance_frames: list[bytes] = []

    speech_active = False
    speech_frame_count = 0
    silence_frame_count = 0

    total_frames = 0
    utterance_start_time = 0.0

    worker = threading.Thread(
        target=transcription_worker,
        args=(model, transcript_path),
        daemon=False
    )
    worker.start()

    print("\n开始录音")
    print("检测到约0.7秒停顿后输出完整句子")
    print("按 Ctrl+C 停止\n")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",

            # 30毫秒一帧，满足WebRTC VAD要求。
            blocksize=FRAME_SAMPLES,

            callback=audio_callback
        ):
            while True:
                frame_bytes = audio_queue.get()

                recording_file.writeframes(
                    frame_bytes
                )

                total_frames += 1
                current_time = (
                    total_frames *
                    FRAME_DURATION_MS /
                    1000
                )

                try:
                    is_speech = vad.is_speech(
                        frame_bytes,
                        SAMPLE_RATE
                    )
                except Exception as error:
                    print(
                        f"\nVAD错误：{error}"
                    )
                    continue

                if not speech_active:
                    # 未讲话时持续保留最近0.3秒，避免丢失句首。
                    pre_roll.append(
                        frame_bytes
                    )

                    if is_speech:
                        speech_active = True

                        utterance_frames = list(
                            pre_roll
                        )

                        utterance_start_time = max(
                            0,
                            current_time -
                            len(utterance_frames) *
                            FRAME_DURATION_MS /
                            1000
                        )

                        speech_frame_count = 1
                        silence_frame_count = 0

                    continue

                # 已处于讲话状态，所有帧都加入当前语句。
                utterance_frames.append(
                    frame_bytes
                )

                if is_speech:
                    speech_frame_count += 1
                    silence_frame_count = 0
                else:
                    silence_frame_count += 1

                reached_silence = (
                    silence_frame_count >=
                    SILENCE_FRAMES_TO_FINISH
                )

                reached_maximum_length = (
                    len(utterance_frames) >=
                    MAX_UTTERANCE_FRAMES
                )

                if (
                    reached_silence or
                    reached_maximum_length
                ):
                    # end_time去除用于确认结束的尾部静音。
                    if reached_silence:
                        end_time = max(
                            utterance_start_time,
                            current_time -
                            SILENCE_TO_FINISH_SECONDS
                        )
                    else:
                        end_time = current_time

                    submit_utterance(
                        utterance_frames,
                        speech_frame_count,
                        utterance_start_time,
                        end_time
                    )

                    # 将最后几帧留作下一句话的句首预录音。
                    pre_roll.clear()

                    for frame in utterance_frames[
                        -PRE_ROLL_FRAMES:
                    ]:
                        pre_roll.append(frame)

                    utterance_frames = []
                    speech_active = False
                    speech_frame_count = 0
                    silence_frame_count = 0

    except KeyboardInterrupt:
        print("\n正在结束录音……")

        # 如果用户在老师讲话期间停止程序，
        # 仍然提交尚未处理的最后一句。
        if speech_active and utterance_frames:
            current_time = (
                total_frames *
                FRAME_DURATION_MS /
                1000
            )

            submit_utterance(
                utterance_frames,
                speech_frame_count,
                utterance_start_time,
                current_time
            )

    finally:
        recording_file.close()

        # None必须排在所有已提交语句之后。
        transcription_queue.put(None)

        print("等待剩余字幕处理完成……")
        worker.join()

        print("\nHearReview 已停止")
        print("字幕：", transcript_path.resolve())
        print("录音：", recording_path.resolve())


if __name__ == "__main__":
    main()
