"use strict";

/*
 * HearReview v0.5.3
 *
 * 设计目标：
 * 1. 长时间课堂中不保存音频，控制内存和磁盘占用。
 * 2. 只保存服务器返回的最新确认字幕。
 * 3. 使用增量 DOM 更新，避免反复重建整页字幕。
 * 4. 停止时等待服务器刷新最后一段字幕。
 * 5. 支持 Markdown 和紧凑 JSON 导出。
 */

const APP_VERSION = "HearReview v0.5.3";
const TARGET_SAMPLE_RATE = 16000;
const DEBUG_EVENT_LIMIT = 100;
const STOP_TIMEOUT_MS = 15000;
const STOP_QUIET_PERIOD_MS = 800;

/* -------------------------------------------------------------------------- */
/* DOM 元素检查                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 获取必须存在的 HTML 元素。
 * 如果 HTML 与 JavaScript 版本不匹配，会立即给出明确错误。
 */
function requireElement(id) {
    const element = document.getElementById(id);

    if (!element) {
        throw new Error(`缺少必要的 HTML 元素：#${id}`);
    }

    return element;
}

const startButton = requireElement("start-button");
const stopButton = requireElement("stop-button");
const downloadMarkdownButton = requireElement("download-markdown-button");
const downloadJsonButton = requireElement("download-json-button");

const serverStatus = requireElement("server-status");
const confirmedCaptions = requireElement("confirmed-captions");
const partialCaption = requireElement("partial-caption");

const transcriptionLag = requireElement("transcription-lag");
const policyLag = requireElement("policy-lag");
const processingLag = requireElement("processing-lag");
const sessionTime = requireElement("session-time");

const courseNameInput = requireElement("course-name");
const microphoneSelect = requireElement("microphone-select");
const refreshDevicesButton = requireElement("refresh-devices-button");
const volumeLevel = requireElement("volume-level");
const volumeStatus = requireElement("volume-status");

/* -------------------------------------------------------------------------- */
/* 运行状态                                                                    */
/* -------------------------------------------------------------------------- */

let websocket = null;

let audioContext = null;
let microphoneStream = null;
let microphoneSource = null;
let audioProcessor = null;

let sessionTimer = null;
let sessionStartedAtMs = null;

let sessionRunning = false;
let sessionStopping = false;

/*
 * 停止阶段使用的服务器状态。
 *
 * stopSignalReceived:
 *   是否收到服务器的 ready_to_stop / completed 等完成信号。
 *
 * stopRequestedAt:
 *   用户点击停止的时间。
 *
 * lastServerMessageAt:
 *   最近一次服务器消息到达的时间。
 *
 * latestTotalLag:
 *   最近一次服务器报告的总积压。
 */
let stopSignalReceived = false;
let stopRequestedAt = 0;
let lastServerMessageAt = 0;
let latestTotalLag = 0;
let latestPartialText = "";

/*
 * 已创建的字幕 DOM。
 *
 * key -> {
 *     element,
 *     timeElement,
 *     speakerElement,
 *     textElement
 * }
 */
const renderedCaptionNodes = new Map();

/*
 * 只保留最近 100 条精简调试指标。
 * 不保存原始 WebSocket 数据，避免长时间课堂持续占用内存。
 */
const debugEvents = [];

/* -------------------------------------------------------------------------- */
/* 当前课堂数据                                                                */
/* -------------------------------------------------------------------------- */

let sessionData = createEmptySession();

/**
 * 创建一份新的课堂数据。
 */
function createEmptySession() {
    return {
        format_version: 1,
        application: APP_VERSION,
        course_name: "",
        started_at: null,
        ended_at: null,
        duration_seconds: 0,
        confirmed_lines: [],
        summary: null,
        statistics: {
            max_transcription_lag: 0,
            max_policy_lag: 0,
            max_processing_lag: 0,
            max_total_lag: 0
        }
    };
}

/* -------------------------------------------------------------------------- */
/* 通用工具                                                                    */
/* -------------------------------------------------------------------------- */

function delay(milliseconds) {
    return new Promise((resolve) => {
        window.setTimeout(resolve, milliseconds);
    });
}

/**
 * 将任意值转换为安全的非负数字。
 */
function toNonNegativeNumber(value) {
    const number = Number(value);

    if (!Number.isFinite(number) || number < 0) {
        return 0;
    }

    return number;
}

/**
 * 将秒数显示为 HH:MM:SS。
 */
function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const remainingSeconds = seconds % 60;

    return [
        String(hours).padStart(2, "0"),
        String(minutes).padStart(2, "0"),
        String(remainingSeconds).padStart(2, "0")
    ].join(":");
}

/**
 * 将课程名称转换成可用于 Windows 文件名的字符串。
 */
function sanitizeFilename(filename) {
    const sanitized = String(filename)
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
        .replace(/\s+/g, " ")
        .trim();

    return sanitized || "lecture";
}

/**
 * 读取最新课程名称。
 *
 * 课程开始后仍允许修改输入框，因此导出前必须重新读取，
 * 不能一直使用开始课堂时保存的旧值。
 */
function getCurrentCourseName() {
    const courseName = courseNameInput.value.trim() || "Untitled Lecture";
    sessionData.course_name = courseName;
    return courseName;
}

/**
 * 将 ISO 时间转换为适合文件名的时间。
 */
function createExportTimestamp() {
    return new Date()
        .toISOString()
        .replace(/[:.]/g, "-");
}

/**
 * 触发浏览器下载文本文件。
 */
function downloadTextFile(filename, content, mimeType) {
    const blob = new Blob([content], {
        type: `${mimeType};charset=utf-8`
    });

    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = objectUrl;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 1000);
}

/**
 * 精简保存调试指标。
 *
 * 使用环形缓冲思想，只保留最近 DEBUG_EVENT_LIMIT 条记录。
 */
function addDebugEvent(data) {
    const event = {
        time: new Date().toISOString(),
        status: typeof data.status === "string" ? data.status : null,
        line_count: Array.isArray(data.lines) ? data.lines.length : null,
        transcription_lag: toNonNegativeNumber(
            data.remaining_time_transcription
        ),
        policy_lag: toNonNegativeNumber(
            data.remaining_time_transcription_policy
        ),
        processing_lag: toNonNegativeNumber(
            data.remaining_time_transcription_processing
        )
    };

    debugEvents.push(event);

    if (debugEvents.length > DEBUG_EVENT_LIMIT) {
        debugEvents.shift();
    }
}

/* -------------------------------------------------------------------------- */
/* 页面状态                                                                    */
/* -------------------------------------------------------------------------- */

/*
 * JS 使用业务状态，CSS 使用 offline / online / connecting 三种视觉状态。
 * 在这里统一映射，避免 data-state 与 CSS class 不一致。
 */
const SERVER_STATE_CLASS_MAP = Object.freeze({
    idle: "offline",
    offline: "offline",
    error: "offline",

    connecting: "connecting",
    stopping: "connecting",
    warning: "connecting",

    connected: "online",
    active: "online",
    completed: "online",
    online: "online"
});

function setServerStatus(text, state = "idle") {
    const visualState =
        SERVER_STATE_CLASS_MAP[state] || "offline";

    serverStatus.textContent = text;
    serverStatus.dataset.state = state;

    serverStatus.classList.remove(
        "offline",
        "online",
        "connecting"
    );

    serverStatus.classList.add(visualState);
}

function updateDownloadButtons() {
    const hasTranscript = sessionData.confirmed_lines.length > 0;

    downloadMarkdownButton.disabled = !hasTranscript;
    downloadJsonButton.disabled = !hasTranscript;
}

/**
 * 同时更新音量文字的业务状态和 CSS class。
 */
function setVolumeStatus(text, state) {
    volumeStatus.textContent = text;
    volumeStatus.dataset.state = state;

    volumeStatus.classList.remove(
        "silent",
        "low",
        "active",
        "error"
    );

    volumeStatus.classList.add(state);
}

/**
 * 同时兼容 div 形式和 progress 形式的音量条。
 */
function updateVolumeDisplay(rms) {
    const normalizedRms = Math.min(1, Math.max(0, rms));
    const percentage = Math.min(100, normalizedRms * 500);

    if ("value" in volumeLevel) {
        volumeLevel.value = percentage;
    }

    volumeLevel.style.width = `${percentage}%`;
    volumeLevel.setAttribute(
        "aria-valuenow",
        percentage.toFixed(0)
    );

    const volumeIsLow =
        normalizedRms >= 0.001 &&
        normalizedRms < 0.01;

    volumeLevel.classList.toggle(
        "warning",
        volumeIsLow
    );

    if (normalizedRms < 0.001) {
        setVolumeStatus(
            "未检测到声音",
            "silent"
        );
    } else if (volumeIsLow) {
        setVolumeStatus(
            "声音较小",
            "low"
        );
    } else {
        setVolumeStatus(
            "麦克风正常",
            "active"
        );
    }
}

function resetLagDisplay() {
    transcriptionLag.textContent = "0.0s";
    policyLag.textContent = "0.0s";
    processingLag.textContent = "0.0s";

    latestTotalLag = 0;
}

/* -------------------------------------------------------------------------- */
/* 字幕数据处理                                                                */
/* -------------------------------------------------------------------------- */

/*
 * 内部保存服务器提供的稳定字幕 ID。
 * Symbol 属性不会出现在 JSON 或 Markdown 导出中。
 */
const LINE_SOURCE_ID = Symbol("lineSourceId");

/**
 * start/end 同时支持字符串和数字。
 *
 * 数字 0 是合法时间戳，不能因为布尔值为 false 而丢失。
 */
function normalizeTimestamp(value) {
    if (typeof value === "number") {
        return Number.isFinite(value) && value >= 0
            ? value
            : "";
    }

    if (typeof value === "string") {
        return value.trim();
    }

    return "";
}

function hasTimestamp(value) {
    return (
        (
            typeof value === "number" &&
            Number.isFinite(value)
        ) ||
        (
            typeof value === "string" &&
            value.length > 0
        )
    );
}

function formatCaptionTimestamp(value) {
    return hasTimestamp(value)
        ? String(value)
        : "";
}

/**
 * 尝试读取服务器提供的稳定字幕行 ID。
 */
function getSourceLineId(line) {
    const candidates = [
        line.id,
        line.line_id,
        line.segment_id,
        line.uid
    ];

    for (const candidate of candidates) {
        if (
            typeof candidate === "number" &&
            Number.isFinite(candidate)
        ) {
            return String(candidate);
        }

        if (typeof candidate === "string") {
            const normalizedCandidate =
                candidate.trim();

            if (normalizedCandidate) {
                return normalizedCandidate;
            }
        }
    }

    return null;
}

/**
 * 清理服务器返回的字幕。
 *
 * 空字幕行不会显示，例如 WhisperLiveKit 中 speaker = -2 的静音行。
 */
function normalizeLines(lines) {
    if (!Array.isArray(lines)) {
        return [];
    }

    return lines
        .map((line) => {
            if (!line || typeof line !== "object") {
                return null;
            }

            const text =
                typeof line.text === "string"
                    ? line.text.trim()
                    : "";

            if (!text) {
                return null;
            }

            const normalizedLine = {
                speaker:
                    Number.isFinite(Number(line.speaker))
                        ? Number(line.speaker)
                        : null,

                start: normalizeTimestamp(line.start),
                end: normalizeTimestamp(line.end),

                text,

                detected_language:
                    typeof line.detected_language === "string"
                        ? line.detected_language
                        : null
            };

            /*
             * 内部 ID 不参与导出，但可用于稳定复用字幕 DOM。
             */
            Object.defineProperty(
                normalizedLine,
                LINE_SOURCE_ID,
                {
                    value: getSourceLineId(line),
                    enumerable: false
                }
            );

            return normalizedLine;
        })
        .filter(Boolean);
}

/**
 * 生成稳定的字幕 DOM key。
 *
 * 优先使用服务器提供的行 ID。
 * 没有行 ID 时使用 speaker + start。
 *
 * 不使用 end，因为 end 会随识别推进而变化。
 * 不使用数组 index，因为前面的字幕增删会导致整体位移。
 *
 * duplicateNumber 只区分具有完全相同身份的极少数重复行，
 * 不受其他字幕插入或删除影响。
 */
function createLineKey(line, duplicateNumber = 0) {
    const sourceId = line[LINE_SOURCE_ID];

    const identity = sourceId !== null
        ? [
            "source-id",
            sourceId
        ]
        : [
            "speaker-start",
            line.speaker ?? "unknown",
            hasTimestamp(line.start)
                ? line.start
                : "no-start"
        ];

    return JSON.stringify([
        ...identity,
        duplicateNumber
    ]);
}

/**
 * 创建一行字幕 DOM。
 *
 * 同时保留多个常见 class 名，避免影响现有页面样式。
 */
function createCaptionNode() {
    const lineElement = document.createElement("div");
    lineElement.className = "caption-line transcript-line";

    const metadataElement = document.createElement("div");
    metadataElement.className = "caption-meta";

    const timeElement = document.createElement("span");
    timeElement.className = "caption-time caption-timestamp timestamp";

    const speakerElement = document.createElement("span");
    speakerElement.className = "caption-speaker speaker";

    const textElement = document.createElement("div");
    textElement.className = "caption-text transcript-text";

    metadataElement.append(timeElement, speakerElement);
    lineElement.append(metadataElement, textElement);

    return {
        element: lineElement,
        timeElement,
        speakerElement,
        textElement
    };
}

/**
 * 更新字幕内容。
 *
 * 这里接收的是服务器的完整 lines 快照，因此：
 * 1. 更新存在的行；
 * 2. 创建新增行；
 * 3. 删除服务器快照中已经不存在的行；
 * 4. 保持服务器给出的字幕顺序。
 */
function renderConfirmedLines(lines) {
    const normalizedLines = normalizeLines(lines);
    const activeKeys = new Set();

    /*
     * 只统计具有相同稳定身份的行。
     * 这不是服务器完整数组的 index，因此前方字幕发生变化时，
     * 后续字幕的 key 不会整体位移。
     */
    const duplicateCounts = new Map();

    normalizedLines.forEach((line) => {
        const baseKey = createLineKey(line);

        const duplicateNumber =
            duplicateCounts.get(baseKey) || 0;

        duplicateCounts.set(
            baseKey,
            duplicateNumber + 1
        );

        const key = createLineKey(
            line,
            duplicateNumber
        );

        activeKeys.add(key);

        let node = renderedCaptionNodes.get(key);

        if (!node) {
            node = createCaptionNode();
            renderedCaptionNodes.set(key, node);
        }

        const startText =
            formatCaptionTimestamp(line.start);

        const endText =
            formatCaptionTimestamp(line.end);

        if (startText && endText) {
            node.timeElement.textContent =
                `${startText}–${endText}`;
        } else {
            node.timeElement.textContent =
                startText || endText;
        }

        if (
            line.speaker !== null &&
            line.speaker >= 0
        ) {
            node.speakerElement.textContent =
                `Speaker ${line.speaker}`;

            node.speakerElement.hidden = false;
        } else {
            node.speakerElement.textContent = "";
            node.speakerElement.hidden = true;
        }

        node.textElement.textContent = line.text;

        /*
         * appendChild 对已有节点只执行移动，不会复制节点。
         */
        confirmedCaptions.appendChild(node.element);
    });

    for (
        const [key, node]
        of renderedCaptionNodes.entries()
    ) {
        if (!activeKeys.has(key)) {
            node.element.remove();
            renderedCaptionNodes.delete(key);
        }
    }

    sessionData.confirmed_lines = normalizedLines;
    updateDownloadButtons();
}

/**
 * 清空页面字幕。
 * 只在开始一场全新课堂时调用。
 */
function clearTranscriptDisplay() {
    renderedCaptionNodes.clear();
    confirmedCaptions.replaceChildren();

    partialCaption.textContent = "";
    latestPartialText = "";

    sessionData.confirmed_lines = [];
    updateDownloadButtons();
}

/* -------------------------------------------------------------------------- */
/* WhisperLiveKit 消息处理                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 判断消息是否代表服务器已完成最后一次字幕刷新。
 */
function isStopCompletionMessage(data) {
    if (!data || typeof data !== "object") {
        return false;
    }

    const status = String(data.status || "").toLowerCase();
    const type = String(data.type || "").toLowerCase();

    const completionValues = new Set([
        "ready_to_stop",
        "completed",
        "complete",
        "finished",
        "stopped"
    ]);

    return completionValues.has(status) || completionValues.has(type);
}

/**
 * 更新服务器积压指标。
 */
function updateLagMetrics(data) {
    const transcription = toNonNegativeNumber(
        data.remaining_time_transcription
    );

    const policy = toNonNegativeNumber(
        data.remaining_time_transcription_policy
    );

    const processing = toNonNegativeNumber(
        data.remaining_time_transcription_processing
    );

    const total = transcription + policy + processing;

    transcriptionLag.textContent = `${transcription.toFixed(1)}s`;
    policyLag.textContent = `${policy.toFixed(1)}s`;
    processingLag.textContent = `${processing.toFixed(1)}s`;

    latestTotalLag = total;

    sessionData.statistics.max_transcription_lag = Math.max(
        sessionData.statistics.max_transcription_lag,
        transcription
    );

    sessionData.statistics.max_policy_lag = Math.max(
        sessionData.statistics.max_policy_lag,
        policy
    );

    sessionData.statistics.max_processing_lag = Math.max(
        sessionData.statistics.max_processing_lag,
        processing
    );

    sessionData.statistics.max_total_lag = Math.max(
        sessionData.statistics.max_total_lag,
        total
    );
}

/**
 * 处理服务器 JSON。
 *
 * 重要：
 * 某些 WhisperLiveKit 消息只有状态或积压信息，没有 lines。
 * 缺少 lines 不代表字幕为空，因此绝不能清空已有字幕。
 */
function handleServerData(data) {
    if (!data || typeof data !== "object") {
        return;
    }

    lastServerMessageAt = performance.now();
    addDebugEvent(data);
    updateLagMetrics(data);

    /*
     * Debug 修复 1：
     * 只有服务器明确返回 lines 数组时，才更新确认字幕。
     */
    if (Array.isArray(data.lines)) {
        renderConfirmedLines(data.lines);
    }

    const bufferTranscription =
        typeof data.buffer_transcription === "string"
            ? data.buffer_transcription.trim()
            : "";

    const bufferTranslation =
        typeof data.buffer_translation === "string"
            ? data.buffer_translation.trim()
            : "";

    latestPartialText = bufferTranscription || bufferTranslation;
    partialCaption.textContent = latestPartialText;

    /*
     * data.status 是服务器协议状态，只用于程序逻辑判断。
     * 不直接显示它，否则 active、processing 等原始值会覆盖
     * “正在生成实时字幕”等中文友好状态。
     */

    if (isStopCompletionMessage(data)) {
        stopSignalReceived = true;
    }
}

/**
 * 处理 WebSocket 消息。
 *
 * WhisperLiveKit 通常发送 JSON 字符串；
 * 停止阶段也可能直接发送 ready_to_stop。
 */
async function handleServerMessage(event) {
    let rawMessage = event.data;

    if (rawMessage instanceof Blob) {
        rawMessage = await rawMessage.text();
    }

    if (rawMessage instanceof ArrayBuffer) {
        rawMessage = new TextDecoder().decode(rawMessage);
    }

    if (typeof rawMessage !== "string") {
        return;
    }

    const trimmedMessage = rawMessage.trim();

    if (!trimmedMessage) {
        return;
    }

    if (trimmedMessage.toLowerCase() === "ready_to_stop") {
        lastServerMessageAt = performance.now();
        stopSignalReceived = true;
        return;
    }

    try {
        const data = JSON.parse(trimmedMessage);
        handleServerData(data);
    } catch (error) {
        /*
         * 非 JSON 消息不会终止课堂。
         * 保留警告，方便以后适配服务器的新消息格式。
         */
        console.warn("无法解析服务器消息：", trimmedMessage, error);
    }
}

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                   */
/* -------------------------------------------------------------------------- */

function connectWebSocket() {
    return new Promise((resolve, reject) => {
        let connectionSettled = false;

        const protocol = window.location.protocol === "https:"
            ? "wss"
            : "ws";

        const socketUrl = `${protocol}://127.0.0.1:8000/asr`;

        setServerStatus("正在连接服务器……", "connecting");

        websocket = new WebSocket(socketUrl);
        websocket.binaryType = "arraybuffer";

        websocket.addEventListener("open", () => {
            connectionSettled = true;
            setServerStatus("服务器已连接", "connected");
            resolve();
        });

        websocket.addEventListener("message", (event) => {
            void handleServerMessage(event);
        });

        websocket.addEventListener("error", () => {
            setServerStatus("服务器连接失败", "error");

            if (!connectionSettled) {
                connectionSettled = true;
                reject(
                    new Error(
                        "无法连接 WhisperLiveKit，请确认服务器正在运行。"
                    )
                );
            }
        });

        websocket.addEventListener("close", () => {
            if (!sessionStopping && sessionRunning) {
                setServerStatus("服务器连接已断开", "error");
            } else if (!sessionRunning) {
                setServerStatus("未连接", "idle");
            }
        });
    });
}

/* -------------------------------------------------------------------------- */
/* 麦克风设备                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 刷新麦克风列表。
 *
 * 浏览器首次授权前可能无法显示真实设备名称，
 * 但仍然可以显示“麦克风 1、麦克风 2”等占位名称。
 */
async function refreshMicrophoneDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) {
        throw new Error("当前浏览器不支持读取麦克风设备。");
    }

    const previousDeviceId = microphoneSelect.value;
    const devices = await navigator.mediaDevices.enumerateDevices();

    const microphones = devices.filter(
        (device) => device.kind === "audioinput"
    );

    microphoneSelect.replaceChildren();

    if (microphones.length === 0) {
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "没有检测到麦克风";
        microphoneSelect.appendChild(option);
        microphoneSelect.disabled = true;
        return;
    }

    microphones.forEach((microphone, index) => {
        const option = document.createElement("option");

        option.value = microphone.deviceId;
        option.textContent =
            microphone.label || `麦克风 ${index + 1}`;

        microphoneSelect.appendChild(option);
    });

    microphoneSelect.disabled = false;

    const previousOptionExists = microphones.some(
        (device) => device.deviceId === previousDeviceId
    );

    if (previousOptionExists) {
        microphoneSelect.value = previousDeviceId;
    }
}

/**
 * 将任意采样率的单声道音频转换成 16 kHz。
 *
 * 使用线性插值，适合实时语音输入。
 */
function resampleAudio(inputSamples, inputSampleRate) {
    if (inputSampleRate === TARGET_SAMPLE_RATE) {
        return new Float32Array(inputSamples);
    }

    const outputLength = Math.max(
        1,
        Math.round(
            inputSamples.length *
            TARGET_SAMPLE_RATE /
            inputSampleRate
        )
    );

    const outputSamples = new Float32Array(outputLength);
    const sampleRateRatio = inputSampleRate / TARGET_SAMPLE_RATE;

    for (let outputIndex = 0; outputIndex < outputLength; outputIndex += 1) {
        const sourcePosition = outputIndex * sampleRateRatio;
        const leftIndex = Math.floor(sourcePosition);
        const rightIndex = Math.min(
            leftIndex + 1,
            inputSamples.length - 1
        );

        const interpolation = sourcePosition - leftIndex;

        outputSamples[outputIndex] =
            inputSamples[leftIndex] * (1 - interpolation) +
            inputSamples[rightIndex] * interpolation;
    }

    return outputSamples;
}

/**
 * 将 Float32 PCM 转换成 16-bit PCM。
 */
function float32ToInt16(inputSamples) {
    const outputSamples = new Int16Array(inputSamples.length);

    for (let index = 0; index < inputSamples.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, inputSamples[index]));

        outputSamples[index] = sample < 0
            ? sample * 0x8000
            : sample * 0x7fff;
    }

    return outputSamples;
}

/**
 * 计算当前音频块的 RMS，用于音量显示和麦克风排错。
 */
function calculateRms(samples) {
    if (samples.length === 0) {
        return 0;
    }

    let squareSum = 0;

    for (let index = 0; index < samples.length; index += 1) {
        squareSum += samples[index] * samples[index];
    }

    return Math.sqrt(squareSum / samples.length);
}

/**
 * 启动用户选择的麦克风。
 *
 * 当前版本继续使用 ScriptProcessorNode，以维持 v0.5.3 的兼容性。
 * 浏览器的 deprecated 提示不是运行错误，后续版本再迁移 AudioWorklet。
 */
async function startMicrophone() {
    if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("当前浏览器不支持麦克风录音。");
    }

    const selectedDeviceId = microphoneSelect.value;

    const audioConstraints = {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
    };

    if (selectedDeviceId) {
        audioConstraints.deviceId = {
            exact: selectedDeviceId
        };
    }

    microphoneStream = await navigator.mediaDevices.getUserMedia({
        audio: audioConstraints,
        video: false
    });

    /*
     * 获得授权后刷新一次设备列表，
     * 此时浏览器通常能够显示真实设备名称。
     */
    await refreshMicrophoneDevices();

    if (selectedDeviceId) {
        microphoneSelect.value = selectedDeviceId;
    }

    audioContext = new AudioContext();

    if (audioContext.state === "suspended") {
        await audioContext.resume();
    }

    microphoneSource = audioContext.createMediaStreamSource(
        microphoneStream
    );

    audioProcessor = audioContext.createScriptProcessor(
        4096,
        1,
        1
    );

    audioProcessor.addEventListener("audioprocess", (event) => {
        const inputSamples = event.inputBuffer.getChannelData(0);
        const rms = calculateRms(inputSamples);

        updateVolumeDisplay(rms);

        /*
         * 输出静音，避免麦克风声音从扬声器播放造成回音。
         * ScriptProcessorNode 必须连接 destination 才能持续触发。
         */
        const outputSamples = event.outputBuffer.getChannelData(0);
        outputSamples.fill(0);

        if (
            !sessionRunning ||
            sessionStopping ||
            !websocket ||
            websocket.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        const resampled = resampleAudio(
            inputSamples,
            audioContext.sampleRate
        );

        const pcm16 = float32ToInt16(resampled);

        websocket.send(pcm16.buffer);
    });

    microphoneSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    console.info({
        inputSampleRate: audioContext.sampleRate,
        selectedMicrophone: microphoneSelect.selectedOptions[0]?.textContent
    });
}

/**
 * 停止麦克风并释放浏览器音频资源。
 */
async function stopMicrophone() {
    if (audioProcessor) {
        audioProcessor.disconnect();
        audioProcessor = null;
    }

    if (microphoneSource) {
        microphoneSource.disconnect();
        microphoneSource = null;
    }

    if (microphoneStream) {
        microphoneStream.getTracks().forEach((track) => {
            track.stop();
        });

        microphoneStream = null;
    }

    if (audioContext) {
        try {
            await audioContext.close();
        } catch (error) {
            console.warn("关闭 AudioContext 时出现警告：", error);
        }

        audioContext = null;
    }

    updateVolumeDisplay(0);
}

/* -------------------------------------------------------------------------- */
/* 课堂计时                                                                    */
/* -------------------------------------------------------------------------- */

function startSessionTimer() {
    stopSessionTimer();

    sessionStartedAtMs = Date.now();
    sessionTime.textContent = "00:00:00";

    sessionTimer = window.setInterval(() => {
        const elapsedSeconds =
            (Date.now() - sessionStartedAtMs) / 1000;

        sessionTime.textContent = formatDuration(elapsedSeconds);
    }, 1000);
}

function stopSessionTimer() {
    if (sessionTimer !== null) {
        window.clearInterval(sessionTimer);
        sessionTimer = null;
    }

    if (sessionStartedAtMs !== null) {
        sessionData.duration_seconds = Math.round(
            (Date.now() - sessionStartedAtMs) / 1000
        );
    }
}

/* -------------------------------------------------------------------------- */
/* 停止阶段                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 等待 WhisperLiveKit 完成最后一段字幕。
 *
 * 完成条件：
 * 1. 收到 ready_to_stop / completed 等明确完成信号；或
 * 2. 停止后收到服务器消息，积压归零、临时字幕为空，
 *    并且服务器已经安静一段时间；或
 * 3. WebSocket 已关闭；或
 * 4. 达到 15 秒安全超时。
 *
 * 这样不会固定等待 5 秒，也不会无限等待。
 */
async function waitForServerFlush() {
    const waitStartedAt = performance.now();

    while (performance.now() - waitStartedAt < STOP_TIMEOUT_MS) {
        if (stopSignalReceived) {
            return "server-signal";
        }

        if (
            !websocket ||
            websocket.readyState === WebSocket.CLOSED
        ) {
            return "socket-closed";
        }

        const now = performance.now();
        const receivedMessageAfterStop =
            lastServerMessageAt >= stopRequestedAt;

        const serverHasBeenQuiet =
            now - lastServerMessageAt >= STOP_QUIET_PERIOD_MS;

        const backlogIsClear = latestTotalLag <= 0.05;
        const partialIsClear = latestPartialText.trim() === "";

        /*
         * 至少等待一秒，避免在服务器刚收到结束包时过早判断完成。
         */
        const minimumGracePeriodPassed =
            now - stopRequestedAt >= 1000;

        if (
            receivedMessageAfterStop &&
            serverHasBeenQuiet &&
            backlogIsClear &&
            partialIsClear &&
            minimumGracePeriodPassed
        ) {
            return "backlog-clear";
        }

        await delay(100);
    }

    return "timeout";
}

/* -------------------------------------------------------------------------- */
/* 开始和停止课堂                                                              */
/* -------------------------------------------------------------------------- */

async function startSession() {
    if (sessionRunning || sessionStopping) {
        return;
    }

    startButton.disabled = true;
    stopButton.disabled = true;
    refreshDevicesButton.disabled = true;

    sessionData = createEmptySession();
    sessionData.course_name =
        courseNameInput.value.trim() || "Untitled Lecture";
    sessionData.started_at = new Date().toISOString();

    debugEvents.length = 0;

    stopSignalReceived = false;
    stopRequestedAt = 0;
    lastServerMessageAt = 0;
    latestPartialText = "";

    clearTranscriptDisplay();
    resetLagDisplay();

    try {
        await connectWebSocket();
        await startMicrophone();

        sessionRunning = true;
        sessionStopping = false;

        startSessionTimer();

        setServerStatus("正在生成实时字幕", "active");

        stopButton.disabled = false;
        microphoneSelect.disabled = true;
    } catch (error) {
        console.error(error);

        await stopMicrophone();

        if (
            websocket &&
            websocket.readyState !== WebSocket.CLOSED
        ) {
            websocket.close();
        }

        websocket = null;

        sessionRunning = false;
        sessionStopping = false;

        setServerStatus(error.message || "启动失败", "error");

        startButton.disabled = false;
        stopButton.disabled = true;
        refreshDevicesButton.disabled = false;
        microphoneSelect.disabled = false;
    }
}

async function stopSession() {
    if (!sessionRunning || sessionStopping) {
        return;
    }

    sessionStopping = true;
    stopRequestedAt = performance.now();
    stopSignalReceived = false;

    stopButton.disabled = true;
    setServerStatus("正在处理最后一段字幕……", "stopping");

    /*
     * 先停止麦克风，保证结束包之后不会继续发送音频。
     */
    await stopMicrophone();

    /*
     * WhisperLiveKit 使用空 ArrayBuffer 表示音频输入结束。
     */
    if (
        websocket &&
        websocket.readyState === WebSocket.OPEN
    ) {
        websocket.send(new ArrayBuffer(0));
    }

    const flushResult = await waitForServerFlush();

    console.info("服务器刷新结果：", flushResult);

    if (
        websocket &&
        websocket.readyState !== WebSocket.CLOSED
    ) {
        websocket.close(1000, "Session finished");
    }

    websocket = null;

    stopSessionTimer();

    sessionData.ended_at = new Date().toISOString();
    getCurrentCourseName();

    sessionRunning = false;
    sessionStopping = false;

    latestPartialText = "";
    partialCaption.textContent = "";

    setServerStatus(
        flushResult === "timeout"
            ? "课堂已停止（服务器刷新超时）"
            : "课堂已完成",
        flushResult === "timeout" ? "warning" : "completed"
    );

    startButton.disabled = false;
    stopButton.disabled = true;
    refreshDevicesButton.disabled = false;
    microphoneSelect.disabled = false;

    updateDownloadButtons();
}

/* -------------------------------------------------------------------------- */
/* 导出                                                                        */
/* -------------------------------------------------------------------------- */

function createMarkdownTranscript() {
    const courseName = getCurrentCourseName();

    const lines = [
        `# ${courseName}`,
        "",
        `- Application: ${APP_VERSION}`,
        `- Started: ${sessionData.started_at || "Unknown"}`,
        `- Ended: ${sessionData.ended_at || "Not finished"}`,
        `- Duration: ${formatDuration(sessionData.duration_seconds)}`,
        "",
        "## Lecture Transcript",
        ""
    ];

    sessionData.confirmed_lines.forEach((line) => {
        const startText =
            formatCaptionTimestamp(line.start);

        const endText =
            formatCaptionTimestamp(line.end);

        const timeRange =
            startText && endText
                ? `${startText}–${endText}`
                : startText || endText;

        const speaker =
            line.speaker !== null && line.speaker >= 0
                ? ` Speaker ${line.speaker}:`
                : "";

        lines.push(`[${timeRange}]${speaker} ${line.text}`);
        lines.push("");
    });

    if (sessionData.summary) {
        lines.push("## Summary");
        lines.push("");
        lines.push(String(sessionData.summary));
        lines.push("");
    }

    return lines.join("\n");
}

function downloadMarkdownTranscript() {
    if (sessionData.confirmed_lines.length === 0) {
        return;
    }

    stopSessionTimer();

    const courseName = getCurrentCourseName();
    const filename = sanitizeFilename(
        `${courseName}-${createExportTimestamp()}.md`
    );

    downloadTextFile(
        filename,
        createMarkdownTranscript(),
        "text/markdown"
    );
}

function downloadJsonTranscript() {
    if (sessionData.confirmed_lines.length === 0) {
        return;
    }

    stopSessionTimer();

    const courseName = getCurrentCourseName();
    const filename = sanitizeFilename(
        `${courseName}-${createExportTimestamp()}.json`
    );

    /*
     * debug_events 最多只有 100 条，并且只保存精简指标。
     * 不导出音频和全部原始 WebSocket 消息。
     */
    const exportData = {
        ...sessionData,
        debug_events: [...debugEvents]
    };

    downloadTextFile(
        filename,
        JSON.stringify(exportData),
        "application/json"
    );
}

/* -------------------------------------------------------------------------- */
/* 页面事件                                                                    */
/* -------------------------------------------------------------------------- */

startButton.addEventListener("click", () => {
    void startSession();
});

stopButton.addEventListener("click", () => {
    void stopSession();
});

downloadMarkdownButton.addEventListener(
    "click",
    downloadMarkdownTranscript
);

downloadJsonButton.addEventListener(
    "click",
    downloadJsonTranscript
);

refreshDevicesButton.addEventListener(
    "click",
    async () => {
        /*
         * 课堂期间或正在等待最终字幕时，不能重新申请设备权限。
         * 重新枚举设备可能改变选择状态，也可能短暂占用麦克风，
         * 从而影响正在进行的录音和最终字幕刷新。
         *
         * 正常情况下按钮已经 disabled；这里再次判断，
         * 用于防止脚本触发 click 等绕过按钮状态的情况。
         */
        if (sessionRunning || sessionStopping) {
            return;
        }

        refreshDevicesButton.disabled = true;

        try {
            /*
             * 临时申请权限，让浏览器显示真实麦克风名称。
             */
            const permissionStream =
                await navigator.mediaDevices.getUserMedia({
                    audio: true,
                    video: false
                });

            permissionStream
                .getTracks()
                .forEach((track) => {
                    track.stop();
                });

            await refreshMicrophoneDevices();
        } catch (error) {
            console.error(error);

            setVolumeStatus(
                "无法读取麦克风",
                "error"
            );
        } finally {
            /*
             * 如果刷新过程中课堂状态发生变化，
             * 必须继续保持按钮禁用。
             */
            refreshDevicesButton.disabled =
                sessionRunning || sessionStopping;
        }
    }
);

if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener(
        "devicechange",
        async () => {
            if (!sessionRunning && !sessionStopping) {
                try {
                    await refreshMicrophoneDevices();
                } catch (error) {
                    console.warn("刷新麦克风列表失败：", error);
                }
            }
        }
    );
}

/**
 * 课堂正在进行或处理最后字幕时，提醒用户不要直接关闭页面。
 */
window.addEventListener("beforeunload", (event) => {
    if (!sessionRunning && !sessionStopping) {
        return;
    }

    event.preventDefault();
    event.returnValue = "";
});

/* -------------------------------------------------------------------------- */
/* 页面初始化                                                                  */
/* -------------------------------------------------------------------------- */

async function initializeApplication() {
    startButton.disabled = false;
    stopButton.disabled = true;
    downloadMarkdownButton.disabled = true;
    downloadJsonButton.disabled = true;

    resetLagDisplay();
    updateVolumeDisplay(0);

    sessionTime.textContent = "00:00:00";
    setServerStatus("未连接", "idle");

    try {
        await refreshMicrophoneDevices();
    } catch (error) {
        console.warn("初始化麦克风列表失败：", error);

        microphoneSelect.disabled = true;
        setVolumeStatus(
            "未检测到麦克风",
            "error"
        );
    }
}

void initializeApplication();
