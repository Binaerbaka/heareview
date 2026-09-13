from __future__ import annotations

import queue
import re
import tempfile
import time
import wave
from datetime import datetime
from pathlib import Path

import numpy as np
import sounddevice as sd
from faster_whisper import WhisperModel


SAMPLE_RATE = 16000

# 每次收集8秒新声音，并带上上一段最后2秒
NEW_AUDIO_SECONDS = 8
OVERLAP_SECONDS = 2

audio_queue = queue.Queue()


def audio_callback(indata, frames, time_info, status):
    if status:
        print("录音警告：", status)

    audio_queue.put(indata[:, 0].copy())


def float_to_pcm16(audio):
    audio = np.clip(audio, -1.0, 1.0)
    return (audio * 32767).astype(np.int16)


def save_temporary_wav(audio):
    temporary_file = tempfile.NamedTemporaryFile(
        suffix=".wav",
        delete=False
    )
    temporary_file.close()

    wav_path = Path(temporary_file.name)
    pcm_audio = float_to_pcm16(audio)

    with wave.open(str(wav_path), "wb") as file:
        file.setnchannels(1)
        file.setsampwidth(2)
        file.setframerate(SAMPLE_RATE)
        file.writeframes(pcm_audio.tobytes())

    return wav_path


def format_time(seconds):
    seconds = max(0, int(seconds))

    hours = seconds // 3600
    minutes = (seconds % 3600) // 60
    remaining_seconds = seconds % 60

    return f"{hours:02d}:{minutes:02d}:{remaining_seconds:02d}"


def normalize_word(word):
    return re.sub(r"[^a-z0-9']", "", word.lower())


def remove_cross_chunk_overlap(previous_text, current_text):
    """
    如果上一段结尾与当前段开头相同，就删除当前段重复部分。
    """

    if not previous_text or not current_text:
        return current_text

    previous_words = previous_text.split()
    current_words = current_text.split()

    previous_normalized = [
        normalize_word(word) for word in previous_words
    ]
    current_normalized = [
        normalize_word(word) for word in current_words
    ]

    maximum_overlap = min(
        20,
        len(previous_normalized),
        len(current_normalized)
    )

    # 至少两个词相同才判断为重复，避免误删普通单词
    for overlap_size in range(maximum_overlap, 1, -1):
        previous_end = previous_normalized[-overlap_size:]
        current_start = current_normalized[:overlap_size]

        if previous_end == current_start:
            remaining_words = current_words[overlap_size:]
            return " ".join(remaining_words).strip()

    return current_text


def remove_repeated_sentences(text):
    """
    删除 Whisper 产生的连续重复句子，例如：
    Thank you. Thank you. Thank you.
    """

    sentences = re.split(r"(?<=[.!?])\s+", text.strip())

    cleaned_sentences = []
    previous_sentence = None

    for sentence in sentences:
        sentence = sentence.strip()

        if not sentence:
            continue

        normalized = re.sub(
            r"[^a-z0-9]",
            "",
            sentence.lower()
        )

        if normalized == previous_sentence:
            continue

        cleaned_sentences.append(sentence)
        previous_sentence = normalized

    return " ".join(cleaned_sentences)


def transcribe_audio(model, audio):
    wav_path = save_temporary_wav(audio)

    try:
        segments, information = model.transcribe(
            str(wav_path),
            language="en",
            beam_size=5,
            vad_filter=True,
            vad_parameters={
                "min_silence_duration_ms": 500
            },
            condition_on_previous_text=False,
            temperature=0,
            no_speech_threshold=0.6,
            initial_prompt=(
                "This is a university lecture. "
                "The speaker may discuss electronic engineering, "
                "mathematics, physics, programming, robotics, "
                "circuits, signals, systems, algorithms and AI."
            )
        )

        text = " ".join(
            segment.text.strip()
            for segment in segments
        ).strip()

        return text

    finally:
        wav_path.unlink(missing_ok=True)


def main():
    print("HearReview v0.2")
    print("正在加载 Whisper 模型……")

    # 当前先使用CPU，避免CUDA DLL问题
    model = WhisperModel(
        "small.en",
        device="cpu",
        compute_type="int8"
    )

    print("Whisper 已加载：CPU int8")

    transcript_folder = Path("transcripts")
    recording_folder = Path("recordings")

    transcript_folder.mkdir(exist_ok=True)
    recording_folder.mkdir(exist_ok=True)

    session_name = datetime.now().strftime("%Y%m%d-%H%M%S")

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

    recording_file = wave.open(str(recording_path), "wb")
    recording_file.setnchannels(1)
    recording_file.setsampwidth(2)
    recording_file.setframerate(SAMPLE_RATE)

    new_audio_required = int(
        SAMPLE_RATE * NEW_AUDIO_SECONDS
    )

    overlap_required = int(
        SAMPLE_RATE * OVERLAP_SECONDS
    )

    pending_audio = []
    pending_frames = 0

    overlap_audio = np.empty(
        0,
        dtype=np.float32
    )

    previous_text = ""
    started_at = time.monotonic()

    print("\n开始录音")
    print("每8秒更新一次字幕")
    print("按 Ctrl+C 停止\n")

    try:
        with sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            callback=audio_callback
        ):
            while True:
                block = audio_queue.get()

                # 保存完整课堂录音
                recording_file.writeframes(
                    float_to_pcm16(block).tobytes()
                )

                pending_audio.append(block)
                pending_frames += len(block)

                if pending_frames < new_audio_required:
                    continue

                new_audio = np.concatenate(pending_audio)

                pending_audio.clear()
                pending_frames = 0

                # 当前窗口 = 上一段最后2秒 + 新的8秒
                window_audio = np.concatenate([
                    overlap_audio,
                    new_audio
                ])

                text = transcribe_audio(
                    model,
                    window_audio
                )

                text = remove_repeated_sentences(text)
                text = remove_cross_chunk_overlap(
                    previous_text,
                    text
                )

                elapsed = time.monotonic() - started_at

                if text:
                    timestamp = format_time(elapsed)
                    line = f"[{timestamp}] {text}"

                    print(line, flush=True)

                    with transcript_path.open(
                        "a",
                        encoding="utf-8"
                    ) as transcript_file:
                        transcript_file.write(
                            line + "\n\n"
                        )

                    # 保留最近字幕，供下一段去重
                    previous_text = (
                        previous_text + " " + text
                    ).strip()

                    previous_text = " ".join(
                        previous_text.split()[-50:]
                    )

                # 保存当前音频最后2秒
                overlap_audio = window_audio[
                    -overlap_required:
                ].copy()

    except KeyboardInterrupt:
        print("\n正在处理最后一段录音……")

        if pending_audio:
            final_audio = np.concatenate(
                pending_audio
            )

            window_audio = np.concatenate([
                overlap_audio,
                final_audio
            ])

            text = transcribe_audio(
                model,
                window_audio
            )

            text = remove_repeated_sentences(text)
            text = remove_cross_chunk_overlap(
                previous_text,
                text
            )

            if text:
                elapsed = time.monotonic() - started_at
                line = (
                    f"[{format_time(elapsed)}] {text}"
                )

                print(line)

                with transcript_path.open(
                    "a",
                    encoding="utf-8"
                ) as transcript_file:
                    transcript_file.write(
                        line + "\n\n"
                    )

    finally:
        recording_file.close()

        print("\nHearReview 已停止")
        print("字幕文件：", transcript_path.resolve())
        print("录音文件：", recording_path.resolve())


if __name__ == "__main__":
    main()