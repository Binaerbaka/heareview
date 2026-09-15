"use strict";

/*
 * HearReview v0.7.0
 *
 * 设计目标：
 * 1. 长时间课堂中不保存音频，控制内存和磁盘占用。
 * 2. 只保存服务器返回的最新确认字幕。
 * 3. 使用增量 DOM 更新，避免反复重建整页字幕。
 * 4. 停止时等待服务器刷新最后一段字幕。
 * 5. 支持 Markdown 和紧凑 JSON 导出。
 * 6. 基于已确认字幕实时生成课堂要点（v0.6）。
 */

const APP_VERSION = "HearReview v0.7.0";
const TARGET_SAMPLE_RATE = 16000;
const DEBUG_EVENT_LIMIT = 100;
const STOP_TIMEOUT_MS = 15000;
const STOP_QUIET_PERIOD_MS = 800;

/*
 * v0.6 实时课堂要点参数。
 *
 * SUMMARY_MIN_NEW_CHARACTERS:
 *   新增多少已确认字符后允许自动生成。
 *
 * SUMMARY_MIN_INTERVAL_MS:
 *   两次自动生成之间的最小间隔。
 *
 * SUMMARY_MAX_CONTEXT_CHARACTERS:
 *   每次最多发送给 LLM 的字幕字符数（只取末尾）。
 */
const SUMMARY_SETTINGS_KEY = "heareview.summary.settings.v1";
const SUMMARY_MIN_NEW_CHARACTERS = 420;
const SUMMARY_MIN_INTERVAL_MS = 45000;
const SUMMARY_MAX_CONTEXT_CHARACTERS = 8000;
const SUMMARY_MAX_LIST_ITEMS = 5;
const TRANSLATION_SETTINGS_KEY = "heareview.translation.settings.v1";
const TRANSLATION_BATCH_SIZE = 3;
const TRANSLATION_DEBOUNCE_MS = 1200;
const PARTIAL_TRANSLATION_DEBOUNCE_MS = 1000;
const PARTIAL_TRANSLATION_MAX_WAIT_MS = 3000;
const PARTIAL_TRANSLATION_MIN_INTERVAL_MS = 1000;
const PARTIAL_TRANSLATION_SOURCE_LIMIT = 800;

/*
 * 最终 Review 的分段阈值。
 *
 * 字幕较短时一次请求完整生成；
 * 超过 SINGLE_LIMIT 时按时间顺序切成 CHUNK_SIZE 的多个分块，
 * 先逐块生成阶段分析，再做一次合并，避免长课堂丢失前半段。
 */
const FINAL_REVIEW_SINGLE_LIMIT = 24000;
const FINAL_REVIEW_CHUNK_SIZE = 12000;

/*
 * 两次翻译请求之间的最小间隔。
 *
 * 未配置 LLM 或服务断开时，失败重试也会受此冷却限制，
 * 避免每来一条字幕就失败一次。
 */
const TRANSLATION_MIN_INTERVAL_MS = 4000;

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
const partialTranslationCaption = requireElement("partial-translation-caption");

const transcriptionLag = requireElement("transcription-lag");
const policyLag = requireElement("policy-lag");
const processingLag = requireElement("processing-lag");
const sessionTime = requireElement("session-time");

const courseNameInput = requireElement("course-name");
const microphoneSelect = requireElement("microphone-select");
const refreshDevicesButton = requireElement("refresh-devices-button");
const volumeLevel = requireElement("volume-level");
const volumeStatus = requireElement("volume-status");

/* v0.6 实时课堂要点面板。 */
const summaryState = requireElement("summary-state");
const summaryContent = requireElement("summary-content");
const summarySettingsForm = requireElement("summary-settings");
const summaryProviderInput = requireElement("summary-provider");
const summaryModelInput = requireElement("summary-model");
const summaryEndpointInput = requireElement("summary-endpoint");
const summaryApiKeyInput = requireElement("summary-api-key");
const summaryEndpointRow = requireElement("summary-endpoint-row");
const summaryKeyRow = requireElement("summary-key-row");
const summaryProviderNote = requireElement("summary-provider-note");
const summaryNowButton = requireElement("summary-now-button");
const summarySettingsButton = requireElement("summary-settings-button");
const summaryCloseSettingsButton = requireElement("summary-close-settings");
const finalReviewButton = requireElement("final-review-button");
const finalReviewState = requireElement("final-review-state");
const finalReviewContent = requireElement("final-review-content");
const appLayout = requireElement("app-layout");
const sidebarResizer = requireElement("sidebar-resizer");
const summaryResizer = requireElement("summary-resizer");
const translationToggle = requireElement("translation-toggle");
const translationDirection = requireElement("translation-direction");
const translationState = requireElement("translation-state");

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
 * v0.6 实时课堂要点状态。
 *
 * summaryIsGenerating:
 *   是否正在请求 LLM，避免并发重复请求。
 *
 * summaryLastRequestedAt:
 *   最近一次发起请求的时间，用于限制自动生成频率。
 *
 * summarySummarizedCharacters:
 *   上次成功总结时已确认字幕的总字符数，用于判断新增量。
 *
 * summaryCurrentReview:
 *   最近一次生成的总结对象。
 */
let summaryIsGenerating = false;
let summaryLastRequestedAt = 0;
let summarySummarizedCharacters = 0;
let summaryCurrentReview = null;
let finalReviewIsGenerating = false;

/*
 * 所有 LLM 请求（课堂要点 / 字幕翻译 / 最终 Review）共享一个串行队列，
 * 保证同一时刻只有一个请求在飞，排队而不是丢弃。
 */
const llmRequestQueue = [];
let llmRequestRunning = false;

let translationEnabled = false;
let translationTimer = null;
let translationRequestInFlight = false;
let translationEpoch = 0;
let translationLastRequestedAt = 0;
const translationCache = new Map();
let partialTranslationTimer = null;
let partialTranslationInFlight = false;
let partialTranslationRevision = 0;
let partialTranslationEpoch = 0;
let partialTranslationRequestId = 0;
let partialTranslationLastRenderedRequestId = 0;
let partialTranslationCycleStartedAt = 0;
let partialTranslationSourceText = "";
let partialTranslationLastRequestedAt = 0;
let latestPartialTranscription = "";

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
        final_review: null,
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
    /*
     * sessionData 中的字幕会被再次 normalizeLines()，
     * 例如翻译结果回写后重新渲染。
     *
     * 此时服务器原始 id 字段未必还在，但 Symbol 形式的内部稳定 ID
     * 仍存在，必须优先保留，否则翻译缓存 key 会从 source-id 变成
     * speaker-start，造成“翻译成功却不显示”。
     */
    const existingInternalId = line[LINE_SOURCE_ID];

    if (typeof existingInternalId === "string" && existingInternalId) {
        return existingInternalId;
    }

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

            /*
             * speaker 为 null / undefined / 空字符串时保持 null。
             *
             * 注意：Number(null) === 0。如果不先排除 null，
             * 对已经规范化的字幕再次调用 normalizeLines 时，
             * speaker 会从 null 变成 0，导致 DOM key 变化、
             * 译文缓存失配（v0.6.1 会重渲染已规范化的字幕）。
             */
            const rawSpeaker = line.speaker;

            const normalizedSpeaker =
                rawSpeaker === null ||
                rawSpeaker === undefined ||
                rawSpeaker === ""
                    ? null
                    : (
                        Number.isFinite(Number(rawSpeaker))
                            ? Number(rawSpeaker)
                            : null
                    );

            const normalizedLine = {
                speaker: normalizedSpeaker,

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

    const translationElement = document.createElement("div");
    translationElement.className = "caption-translation";
    translationElement.hidden = true;

    metadataElement.append(timeElement, speakerElement);
    lineElement.append(metadataElement, textElement, translationElement);

    return {
        element: lineElement,
        timeElement,
        speakerElement,
        textElement,
        translationElement
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

        const translation = getCachedTranslation(line, key);
        line.translation = translation || null;
        node.textElement.textContent = line.text;
        node.translationElement.textContent = translation;
        node.translationElement.hidden = !translationEnabled || !translation;

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
    scheduleTranslations(normalizedLines);

    /*
     * 字幕更新后按阈值判断是否自动生成课堂要点。
     * 这里是普通函数调用，不再使用 MutationObserver，
     * 避免额外的 DOM 观察开销。
     */
    maybeAutoGenerateSummary();
}

/**
 * 清空页面字幕。
 * 只在开始一场全新课堂时调用。
 */
function clearTranscriptDisplay() {
    renderedCaptionNodes.clear();
    confirmedCaptions.replaceChildren();

    partialCaption.textContent = "";
    clearPartialTranslation();
    latestPartialText = "";

    sessionData.confirmed_lines = [];
    updateDownloadButtons();
}

/* -------------------------------------------------------------------------- */
/* 实时课堂要点（v0.6）                                                        */
/* -------------------------------------------------------------------------- */

/*
 * 右侧“实时课堂要点”面板基于已确认字幕调用外部 LLM。
 *
 * 设计原则：
 * 1. 只读取已确认字幕，不改变原有转录流程；
 * 2. API Key 只保留在当前页面，不写入 localStorage、导出或字幕文件；
 * 3. 新增约 SUMMARY_MIN_NEW_CHARACTERS 个字符且距上次请求至少
 *    SUMMARY_MIN_INTERVAL_MS，才自动生成；
 * 4. 自动生成失败时保持安静，不打断课堂。
 */

/**
 * 创建一个简单的 DOM 节点。
 */
function createSummaryElement(tagName, className, text) {
    const node = document.createElement(tagName);

    if (className) {
        node.className = className;
    }

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

function readSummarySettings() {
    const defaults = {
        provider: "ollama",
        model: "qwen2.5:7b",
        endpoint: ""
    };

    try {
        return {
            ...defaults,
            ...JSON.parse(
                localStorage.getItem(SUMMARY_SETTINGS_KEY) || "{}"
            )
        };
    } catch (error) {
        console.warn("读取总结设置失败：", error);
        return defaults;
    }
}

function saveSummarySettings() {
    /*
     * API Key 有意不保存。
     * 刷新页面后需要重新填写，避免密钥写入本机存储。
     */
    localStorage.setItem(
        SUMMARY_SETTINGS_KEY,
        JSON.stringify({
            provider: summaryProviderInput.value,
            model: summaryModelInput.value.trim(),
            endpoint: summaryEndpointInput.value.trim()
        })
    );
}

function setSummaryState(text, tone = "idle") {
    summaryState.textContent = text;
    summaryState.className = `summary-state is-${tone}`;
}

function updateSummaryProviderFields() {
    const provider = summaryProviderInput.value;
    const isOllama = provider === "ollama";

    summaryEndpointRow.hidden = isOllama;
    summaryKeyRow.hidden = isOllama;

    if (provider === "ollama") {
        summaryProviderNote.textContent =
            "需在本机运行 Ollama；默认地址为 http://127.0.0.1:11434。";

        if (
            !summaryModelInput.value ||
            summaryModelInput.value === "deepseek-chat"
        ) {
            summaryModelInput.value = "qwen2.5:7b";
        }
    } else if (provider === "deepseek") {
        summaryProviderNote.textContent =
            "Key 只保留在当前页面。若浏览器拦截跨域请求，需在后续版本启用本地中转服务。";

        if (
            !summaryModelInput.value ||
            summaryModelInput.value === "qwen2.5:7b"
        ) {
            summaryModelInput.value = "deepseek-chat";
        }
    } else {
        summaryProviderNote.textContent =
            "填写兼容 Chat Completions 的服务地址与 Key。";
    }
}

/**
 * 用本机保存的设置初始化面板（不含 API Key）。
 */
function initializeSummaryPanel() {
    const settings = readSummarySettings();

    summaryProviderInput.value = settings.provider;
    summaryModelInput.value = settings.model;
    summaryEndpointInput.value = settings.endpoint;

    updateSummaryProviderFields();
}

/**
 * 已确认字幕的总字符数。
 *
 * 使用 sessionData 而不是 DOM，也不做 8000 字符截断，
 * 保证长时间课堂仍能正确判断新增量。
 */
function getConfirmedCharacterCount() {
    let totalCharacters = 0;

    for (const line of sessionData.confirmed_lines) {
        totalCharacters += line.text.length;
    }

    return totalCharacters;
}

/**
 * 取最近一段已确认字幕作为 LLM 上下文。
 *
 * 只保留末尾 SUMMARY_MAX_CONTEXT_CHARACTERS 个字符，
 * 避免把整场课堂都发给模型。
 */
function getConfirmedTranscriptText() {
    return sessionData.confirmed_lines
        .map((line) => line.text)
        .filter(Boolean)
        .join("\n")
        .slice(-SUMMARY_MAX_CONTEXT_CHARACTERS);
}

/**
 * 从模型输出中提取 JSON。
 *
 * 兼容 ```json 代码块和前后附带说明文字的情况。
 */
function extractSummaryJson(text) {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = (fenced ? fenced[1] : text).trim();

    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");

    if (start < 0 || end <= start) {
        throw new Error("模型没有返回 JSON 总结。");
    }

    return JSON.parse(candidate.slice(start, end + 1));
}

/**
 * 把总结对象整理成可导出的文本。
 */
function formatSummaryForExport(review) {
    const parts = [
        String(review.stage_summary || "").trim()
    ];

    const groups = [
        ["关键要点", review.key_points],
        ["术语 / 公式", review.terms],
        ["待复习", review.review_questions]
    ];

    for (const [title, values] of groups) {
        if (!Array.isArray(values) || values.length === 0) {
            continue;
        }

        parts.push("");
        parts.push(`${title}:`);

        values
            .slice(0, SUMMARY_MAX_LIST_ITEMS)
            .forEach((value) => {
                parts.push(`- ${String(value)}`);
            });
    }

    return parts.join("\n").trim();
}

function renderSummaryReview(review) {
    summaryCurrentReview = review;
    sessionData.summary = formatSummaryForExport(review);

    summaryContent.replaceChildren();

    summaryContent.append(
        createSummaryElement(
            "p",
            "stage-summary",
            String(
                review.stage_summary ||
                "本阶段暂无可提炼的连续主题。"
            )
        )
    );

    const groups = [
        ["关键要点", review.key_points],
        ["术语 / 公式", review.terms],
        ["待复习", review.review_questions]
    ];

    for (const [title, values] of groups) {
        if (!Array.isArray(values) || values.length === 0) {
            continue;
        }

        const block = createSummaryElement("div", "summary-group");
        block.append(createSummaryElement("h4", null, title));

        const list = createSummaryElement("ul");

        values
            .slice(0, SUMMARY_MAX_LIST_ITEMS)
            .forEach((value) => {
                list.append(
                    createSummaryElement("li", null, String(value))
                );
            });

        block.append(list);
        summaryContent.append(block);
    }
}

function buildSummarySystemPrompt() {
    return (
        "You are HearReview, a precise lecture study assistant. " +
        "Summarize only what appears in the confirmed lecture " +
        "transcript. The transcript may be English; answer in concise " +
        "Chinese, retaining important English technical terms. Do not " +
        "invent facts. Return strict JSON only with this schema: " +
        '{"stage_summary":"1-2 sentences","key_points":["..."],' +
        '"terms":["..."],"review_questions":["..."]}. ' +
        `Use at most ${SUMMARY_MAX_LIST_ITEMS} entries per array.`
    );
}

/**
 * 把任务排入共享 LLM 队列。
 *
 * 队列串行执行，同一时刻只有一个请求在飞；
 * 请求会被排队而不是丢弃。
 */
function enqueueLlmRequest(task) {
    return new Promise((resolve, reject) => {
        llmRequestQueue.push({ task, resolve, reject });
        void processLlmRequestQueue();
    });
}

async function processLlmRequestQueue() {
    if (llmRequestRunning) {
        return;
    }

    llmRequestRunning = true;

    try {
        while (llmRequestQueue.length > 0) {
            const entry = llmRequestQueue.shift();

            try {
                entry.resolve(await entry.task());
            } catch (error) {
                entry.reject(error);
            }
        }
    } finally {
        llmRequestRunning = false;
    }
}

/**
 * 通用 LLM JSON 请求。
 *
 * 读取当前 LLM 设置，按提供商发起请求并解析 JSON 对象。
 * 课堂要点、字幕翻译、最终 Review 都通过它，统一排队。
 */
async function requestLlmJson(messages, temperature = 0.2) {
    const provider = summaryProviderInput.value;
    const model = summaryModelInput.value.trim();
    const apiKey = summaryApiKeyInput.value.trim();

    if (!model) {
        throw new Error("请填写模型名称。");
    }

    if (provider !== "ollama" && !apiKey) {
        throw new Error("请填写 API Key。");
    }

    const endpoint = summaryEndpointInput.value.trim();

    return enqueueLlmRequest(() =>
        performLlmJsonRequest({
            provider,
            model,
            apiKey,
            endpoint,
            messages,
            temperature
        })
    );
}

async function performLlmJsonRequest({
    provider,
    model,
    apiKey,
    endpoint,
    messages,
    temperature
}) {
    if (provider === "ollama") {
        const response = await fetch(
            "http://127.0.0.1:11434/api/chat",
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    model,
                    messages,
                    stream: false,
                    format: "json",
                    options: { temperature }
                })
            }
        );

        if (!response.ok) {
            throw new Error(
                "无法连接 Ollama；请确认已启动且已下载模型。\n" +
                await response.text()
            );
        }

        const data = await response.json();

        return extractSummaryJson(
            data.message?.content || ""
        );
    }

    const resolvedEndpoint =
        endpoint ||
        (
            provider === "deepseek"
                ? "https://api.deepseek.com/chat/completions"
                : ""
        );

    if (!resolvedEndpoint) {
        throw new Error("请填写接口地址。");
    }

    const response = await fetch(resolvedEndpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify({
            model,
            messages,
            temperature,
            response_format: { type: "json_object" }
        })
    });

    if (!response.ok) {
        throw new Error(
            `LLM 请求失败 (${response.status})：` +
            await response.text()
        );
    }

    const data = await response.json();

    return extractSummaryJson(
        data.choices?.[0]?.message?.content || ""
    );
}

async function requestSummaryFromLlm(transcript) {
    return requestLlmJson([
        { role: "system", content: buildSummarySystemPrompt() },
        {
            role: "user",
            content: `Confirmed transcript:\n${transcript}`
        }
    ]);
}

/**
 * 生成一次课堂要点。
 *
 * automatic 为 true 时表示由字幕更新触发，
 * 此时失败只更新状态，不覆盖面板内容。
 */
async function generateSummary(automatic = false) {
    const transcript = getConfirmedTranscriptText();

    if (summaryIsGenerating || !transcript) {
        if (!transcript && !automatic) {
            setSummaryState("等待确认字幕", "idle");
        }

        return;
    }

    /*
     * 记录本次请求对应的字符数。
     * 请求期间新到的字幕会在下一次触发时计算。
     */
    const characterCount = getConfirmedCharacterCount();

    summaryIsGenerating = true;

    /*
     * 无论成功或失败都记录请求时间，
     * 避免 LLM 不可用时被高频重试。
     */
    summaryLastRequestedAt = Date.now();
    setSummaryState("正在生成…", "working");

    try {
        renderSummaryReview(
            await requestSummaryFromLlm(transcript)
        );

        summarySummarizedCharacters = characterCount;
        setSummaryState("已更新", "ready");
    } catch (error) {
        console.warn("课堂总结失败：", error);
        setSummaryState("服务未连接", "error");

        if (!automatic) {
            summaryContent.replaceChildren(
                createSummaryElement(
                    "p",
                    "summary-placeholder",
                    error.message
                )
            );
        }
    } finally {
        summaryIsGenerating = false;
    }
}

/* -------------------------------------------------------------------------- */
/* 最终 Review（v0.7.0）                                                       */
/* -------------------------------------------------------------------------- */

function setFinalReviewState(text, tone = "idle") {
    finalReviewState.textContent = text;
    finalReviewState.className = `summary-state is-${tone}`;
}

/**
 * 把最终 Review 整理成可导出的 Markdown 文本。
 */
function formatFinalReviewForExport(review) {
    const parts = [String(review.overview || "").trim()];

    const groups = [
        ["核心概念", review.core_concepts],
        ["反复强调的重点", review.repeated_emphases],
        ["专业术语", review.terminology],
        ["易混淆点", review.confusion_points]
    ];

    for (const [title, values] of groups) {
        if (!Array.isArray(values) || values.length === 0) {
            continue;
        }

        parts.push("");
        parts.push(`### ${title}`);

        values.forEach((item) => {
            parts.push(
                `- ${typeof item === "string"
                    ? item
                    : JSON.stringify(item)}`
            );
        });
    }

    return parts.join("\n").trim();
}

function renderFinalReview(review) {
    sessionData.final_review = review;
    finalReviewContent.replaceChildren();

    const overview = String(review.overview || "").trim();

    if (overview) {
        finalReviewContent.append(
            createSummaryElement(
                "p",
                "final-review-overview",
                overview
            )
        );
    }

    const groups = [
        ["核心概念", review.core_concepts],
        ["老师反复强调的重点", review.repeated_emphases],
        ["专业术语", review.terminology],
        ["易混淆点", review.confusion_points]
    ];

    for (const [title, values] of groups) {
        if (!Array.isArray(values)) {
            continue;
        }

        const items = values.filter(Boolean);

        if (items.length === 0) {
            continue;
        }

        const block = createSummaryElement(
            "section",
            "final-review-group"
        );

        block.append(createSummaryElement("h4", null, title));

        const list = createSummaryElement("ul");

        items.forEach((value) => {
            list.append(
                createSummaryElement(
                    "li",
                    null,
                    typeof value === "string"
                        ? value
                        : JSON.stringify(value)
                )
            );
        });

        block.append(list);
        finalReviewContent.append(block);
    }

    finalReviewContent.hidden = false;
}

function buildFinalReviewPrompt() {
    return (
        "You are HearReview. Analyze the full confirmed lecture " +
        "transcript in concise Chinese. Return strict JSON only: " +
        '{"overview":"...","core_concepts":["concept | Level 1-5 | ' +
        'explanation"],"repeated_emphases":["concept | count | ' +
        'timestamps if visible | why important"],"terminology":' +
        '["English term | Chinese | definition | Level 1-5"],' +
        '"confusion_points":["..."]}. Count repeated concepts ' +
        "semantically, not only exact wording. Do not invent facts " +
        "or generate exercises/questions."
    );
}

function buildStageAnalysisPrompt(partNumber, partCount) {
    return (
        `You are HearReview. This is part ${partNumber} of ` +
        `${partCount} of a confirmed lecture transcript. Analyze ` +
        "only this part in concise Chinese. Return strict JSON only: " +
        '{"segment_summary":"1-2 sentences","core_concepts":' +
        '["concept | Level 1-5 | explanation"],"repeated_emphases":' +
        '["concept | count in this part | timestamps if visible | ' +
        'why important"],"terminology":["English term | Chinese | ' +
        'definition | Level 1-5"],"confusion_points":["..."]}. ' +
        "Count repeated concepts semantically, not only exact " +
        "wording. Do not invent facts."
    );
}

function buildFinalReviewMergePrompt() {
    return (
        "You are HearReview. You are given ordered stage analyses " +
        "of one full lecture. Merge them into a single final review " +
        "in concise Chinese. Return strict JSON only: " +
        '{"overview":"...","core_concepts":["concept | Level 1-5 | ' +
        'explanation"],"repeated_emphases":["concept | total count | ' +
        'timestamps if visible | why important"],"terminology":' +
        '["English term | Chinese | definition | Level 1-5"],' +
        '"confusion_points":["..."]}. Merge duplicates and sum ' +
        "counts across stages. Preserve important content from every " +
        "stage; do not drop the beginning. Do not invent facts or " +
        "generate exercises/questions."
    );
}

function buildFinalReviewTranscript() {
    return sessionData.confirmed_lines
        .map((line) => `[${line.start || ""}] ${line.text}`)
        .join("\n");
}

/**
 * 按时间顺序把字幕切成多个分块。
 *
 * 逐行累加，尽量保持原有顺序，不在句子中间随意切断。
 */
function splitTranscriptForReview(transcript, chunkSize) {
    const lines = transcript.split("\n");
    const chunks = [];
    let current = "";

    for (const line of lines) {
        if (current && current.length + line.length + 1 > chunkSize) {
            chunks.push(current);
            current = "";
        }

        current = current ? `${current}\n${line}` : line;
    }

    if (current) {
        chunks.push(current);
    }

    return chunks;
}

function buildFinalReviewMessages(transcript) {
    return [
        { role: "system", content: buildFinalReviewPrompt() },
        {
            role: "user",
            content: `Confirmed transcript:\n${transcript}`
        }
    ];
}

function buildStageAnalysisMessages(chunk, partNumber, partCount) {
    return [
        {
            role: "system",
            content: buildStageAnalysisPrompt(partNumber, partCount)
        },
        {
            role: "user",
            content:
                `Confirmed transcript (part ${partNumber}/` +
                `${partCount}):\n${chunk}`
        }
    ];
}

function buildFinalReviewMergeMessages(stageAnalyses) {
    return [
        { role: "system", content: buildFinalReviewMergePrompt() },
        { role: "user", content: JSON.stringify(stageAnalyses) }
    ];
}

/**
 * 长课堂：逐块生成阶段分析，再合并为最终 Review。
 */
async function generateChunkedFinalReview(transcript) {
    const chunks = splitTranscriptForReview(
        transcript,
        FINAL_REVIEW_CHUNK_SIZE
    );

    const stageAnalyses = [];

    for (let index = 0; index < chunks.length; index += 1) {
        setFinalReviewState(
            `正在分析第 ${index + 1}/${chunks.length} 段…`,
            "working"
        );

        stageAnalyses.push(
            await requestLlmJson(
                buildStageAnalysisMessages(
                    chunks[index],
                    index + 1,
                    chunks.length
                )
            )
        );
    }

    setFinalReviewState("正在合并各段分析…", "working");

    return requestLlmJson(
        buildFinalReviewMergeMessages(stageAnalyses)
    );
}

async function generateFinalReview() {
    if (
        finalReviewIsGenerating ||
        sessionData.confirmed_lines.length === 0
    ) {
        return;
    }

    const transcript = buildFinalReviewTranscript();

    finalReviewIsGenerating = true;
    finalReviewButton.disabled = true;
    setFinalReviewState("正在生成…", "working");

    try {
        const review =
            transcript.length <= FINAL_REVIEW_SINGLE_LIMIT
                ? await requestLlmJson(
                    buildFinalReviewMessages(transcript)
                )
                : await generateChunkedFinalReview(transcript);

        renderFinalReview(review);
        setFinalReviewState("已生成", "ready");
        finalReviewButton.textContent = "重新生成最终 Review";
    } catch (error) {
        console.warn("最终 Review 生成失败：", error);
        setFinalReviewState("生成失败", "error");
    } finally {
        finalReviewIsGenerating = false;
        finalReviewButton.disabled =
            sessionData.confirmed_lines.length === 0;
    }
}

/**
 * 字幕更新后判断是否达到自动生成条件。
 */
function maybeAutoGenerateSummary() {
    const totalCharacters = getConfirmedCharacterCount();

    const newCharacters =
        totalCharacters - summarySummarizedCharacters;

    if (newCharacters < SUMMARY_MIN_NEW_CHARACTERS) {
        return;
    }

    if (
        Date.now() - summaryLastRequestedAt <
        SUMMARY_MIN_INTERVAL_MS
    ) {
        return;
    }

    void generateSummary(true);
}

/**
 * 开始新课堂时重置要点面板。
 */
function resetSummaryPanel() {
    summaryCurrentReview = null;
    summarySummarizedCharacters = 0;
    summaryLastRequestedAt = 0;
    summaryIsGenerating = false;

    sessionData.summary = null;

    summaryContent.replaceChildren(
        createSummaryElement(
            "p",
            "summary-placeholder",
            "连接 LLM 后，这里会持续显示本阶段重点。"
        )
    );

    setSummaryState("等待确认字幕", "idle");
}

/* -------------------------------------------------------------------------- */
/* 确认字幕翻译（v0.6.1）                                                     */
/* -------------------------------------------------------------------------- */

function setTranslationState(text) {
    translationState.textContent = text;
}

function renderTranslationVisibility() {
    for (const node of renderedCaptionNodes.values()) {
        node.translationElement.hidden =
            !translationEnabled || !node.translationElement.textContent;
    }
}

function saveTranslationSettings() {
    localStorage.setItem(TRANSLATION_SETTINGS_KEY, JSON.stringify({
        enabled: translationEnabled,
        direction: translationDirection.value
    }));
}

function initializeTranslationSettings() {
    try {
        const settings = JSON.parse(
            localStorage.getItem(TRANSLATION_SETTINGS_KEY) || "{}"
        );
        translationEnabled = settings.enabled === true;
        translationDirection.value = settings.direction || "en-zh";
    } catch (error) {
        console.warn("读取翻译设置失败：", error);
    }
    translationToggle.classList.toggle("is-on", translationEnabled);
    translationToggle.setAttribute("aria-pressed", String(translationEnabled));
    translationToggle.title = translationEnabled ? "翻译已开启" : "翻译已关闭";
    setTranslationState(translationEnabled ? "等待字幕" : "翻译关闭");
}

function buildTranslationPrompt(items) {
    const toChinese = translationDirection.value === "en-zh";
    const target = toChinese ? "Simplified Chinese" : "English";
    return [
        {
            role: "system",
            content: "Translate only the supplied confirmed lecture captions into " +
                target + ". Preserve formulas, symbols, names and technical terms. " +
                "Return strict JSON only: {\"translations\":[{\"index\":0,\"text\":\"...\"}]}"
        },
        {
            role: "user",
            content: JSON.stringify(items.map((item, index) => ({
                index,
                text: item.line.text
            })))
        }
    ];
}

async function requestTranslationFromLlm(items) {
    const data = await requestLlmJson(
        buildTranslationPrompt(items),
        0.1
    );

    return data.translations;
}

/**
 * 距离下次允许发起翻译请求的剩余冷却时间。
 */
function getTranslationCooldownRemaining() {
    return Math.max(
        0,
        TRANSLATION_MIN_INTERVAL_MS -
        (Date.now() - translationLastRequestedAt)
    );
}

/**
 * 安排一次翻译请求。
 *
 * 等待时间为 max(防抖, 剩余冷却)：
 * 1. 连续字幕更新只触发一次请求；
 * 2. 失败重试也受冷却限制，不会过于频繁。
 *
 * 回调里读取 sessionData.confirmed_lines，
 * 保证用的是最新的字幕快照。
 */
function scheduleTranslations(lines) {
    if (!translationEnabled || translationRequestInFlight) return;

    const pending = getTranslationEntries(lines)
        .filter((item) => !getCachedTranslation(item.line, item.key));

    if (pending.length === 0) return;

    const wait = Math.max(
        TRANSLATION_DEBOUNCE_MS,
        getTranslationCooldownRemaining()
    );

    window.clearTimeout(translationTimer);
    translationTimer = window.setTimeout(() => {
        void flushTranslations(sessionData.confirmed_lines);
    }, wait);
}

async function flushTranslations(lines) {
    if (!translationEnabled || translationRequestInFlight) return;

    const items = getTranslationEntries(lines)
        .filter((item) => !getCachedTranslation(item.line, item.key))
        .slice(0, TRANSLATION_BATCH_SIZE);

    if (items.length === 0) return;

    /*
     * 并发由共享 LLM 队列统一串行化，
     * 这里不再需要针对另一类翻译做重试。
     */
    const epoch = translationEpoch;

    translationRequestInFlight = true;
    translationLastRequestedAt = Date.now();
    setTranslationState("翻译中…");

    try {
        const results = await requestTranslationFromLlm(items);

        /*
         * 方向切换或新课堂会递增 epoch。
         * 旧请求的结果必须丢弃，不能写回当前会话。
         */
        if (epoch !== translationEpoch) {
            return;
        }

        for (const result of Array.isArray(results) ? results : []) {
            const item = items[Number(result.index)];

            /*
             * 有些模型返回 translation 而不是 text，
             * 两种字段都接受。
             */
            const translatedText = result.text || result.translation;

            if (
                item &&
                typeof translatedText === "string" &&
                translatedText.trim()
            ) {
                translationCache.set(item.key, {
                    sourceText: item.line.text,
                    translation: translatedText.trim()
                });
            }
        }

        renderConfirmedLines(sessionData.confirmed_lines);
        setTranslationState("已更新");
    } catch (error) {
        console.warn("字幕翻译失败：", error);
        setTranslationState("服务未连接");
    } finally {
        translationRequestInFlight = false;

        /*
         * 无论成功或失败，只要翻译仍然开启，
         * 就按冷却时间安排下一次续传，
         * 不再依赖下一条服务器消息。
         */
        if (translationEnabled) {
            scheduleTranslations(sessionData.confirmed_lines);
        }
    }
}

function getTranslationEntries(lines) {
    const duplicateCounts = new Map();
    return lines.map((line) => {
        const baseKey = createLineKey(line);
        const duplicateNumber = duplicateCounts.get(baseKey) || 0;
        duplicateCounts.set(baseKey, duplicateNumber + 1);
        return { line, key: createLineKey(line, duplicateNumber) };
    });
}

/**
 * 读取已确认字幕的译文缓存。
 *
 * 缓存必须与原文关联：同一个 line key 的 text 若仍在增长，
 * 旧译文不能永久阻止该行后续翻译。
 * 只有原文完全一致时才视为有效缓存。
 */
function getCachedTranslation(line, key) {
    const cached = translationCache.get(key);

    if (cached && cached.sourceText === line.text) {
        return cached.translation;
    }

    return "";
}

function resetTranslations() {
    /*
     * 递增 epoch，让仍在进行的旧请求结果被丢弃。
     *
     * 这里不强制 translationRequestInFlight = false，
     * 由旧请求的 finally 自行收尾，避免新旧请求并发。
     */
    translationEpoch += 1;
    translationCache.clear();
    window.clearTimeout(translationTimer);
    translationLastRequestedAt = 0;
    setTranslationState(translationEnabled ? "等待字幕" : "翻译关闭");
}

/* 临时字幕翻译：只供课堂中参考，不参与导出。 */
function clearPartialTranslation() {
    window.clearTimeout(partialTranslationTimer);

    /*
     * 递增独立 epoch：
     * 方向切换、关闭翻译、新课堂、结束课堂时，
     * 仍在飞的旧请求结果必须丢弃。
     */
    partialTranslationEpoch += 1;
    partialTranslationRevision += 1;
    partialTranslationCycleStartedAt = 0;
    partialTranslationSourceText = "";
    partialTranslationLastRequestedAt = 0;
    partialTranslationCaption.textContent = "";
    partialTranslationCaption.hidden = true;
}

function schedulePartialTranslation(text, force = false) {
    const normalizedText = String(text || "").trim();

    if (!translationEnabled || !normalizedText) {
        clearPartialTranslation();
        return;
    }

    if (!force && normalizedText === partialTranslationSourceText) {
        return;
    }

    const now = Date.now();

    partialTranslationSourceText = normalizedText;
    partialTranslationRevision += 1;

    if (!partialTranslationCycleStartedAt) {
        partialTranslationCycleStartedAt = now;
    }

    /*
     * 防抖：静止约 1 秒后翻译；
     * 同时用 MAX_WAIT 限制持续变化时的等待，约每 3 秒至少请求一次。
     */
    const elapsed = now - partialTranslationCycleStartedAt;
    const cycleWait = Math.max(0, Math.min(
        PARTIAL_TRANSLATION_DEBOUNCE_MS,
        PARTIAL_TRANSLATION_MAX_WAIT_MS - elapsed
    ));

    /*
     * 临时翻译使用独立的冷却时间，
     * 不复用确认字幕的 translationLastRequestedAt。
     */
    const cooldownWait = Math.max(
        0,
        PARTIAL_TRANSLATION_MIN_INTERVAL_MS -
        (now - partialTranslationLastRequestedAt)
    );

    const wait = Math.max(cycleWait, cooldownWait);
    const revision = partialTranslationRevision;

    window.clearTimeout(partialTranslationTimer);
    partialTranslationTimer = window.setTimeout(() => {
        void flushPartialTranslation(revision, normalizedText);
    }, wait);
}

async function flushPartialTranslation(revision, text) {
    if (!translationEnabled || revision !== partialTranslationRevision) {
        return;
    }

    if (partialTranslationInFlight) {
        return;
    }

    /*
     * 并发由共享 LLM 队列统一串行化。
     */

    /*
     * 每次实际请求分配递增 requestId，
     * 用于保证较新的结果不会被较旧的结果覆盖。
     */
    partialTranslationRequestId += 1;

    const requestId = partialTranslationRequestId;
    const epoch = partialTranslationEpoch;

    partialTranslationInFlight = true;
    partialTranslationLastRequestedAt = Date.now();

    try {
        const results = await requestTranslationFromLlm([{ line: { text } }]);

        /*
         * 方向切换 / 关闭翻译 / 新课堂会递增 epoch，
         * 旧 epoch 的结果必须丢弃，避免中英方向串味。
         */
        if (epoch !== partialTranslationEpoch || !translationEnabled) {
            return;
        }

        /*
         * 临时译文是“延迟参考”，允许比当前英文稍旧。
         *
         * 因此这里不再因为英文后续更新（revision 变化）而丢弃结果；
         * 只要求 requestId 比已显示的更新，避免旧结果覆盖新结果。
         */
        if (requestId <= partialTranslationLastRenderedRequestId) {
            return;
        }

        const result = Array.isArray(results) ? results[0] : null;
        const translated = result && (result.text || result.translation);

        if (typeof translated === "string" && translated.trim()) {
            partialTranslationCaption.textContent = translated.trim();
            partialTranslationCaption.hidden = false;
            partialTranslationLastRenderedRequestId = requestId;
        }
    } catch (error) {
        console.warn("临时字幕翻译失败：", error);
    } finally {
        partialTranslationInFlight = false;

        /*
         * 结束当前 cycle：无论成功、失败还是被丢弃，
         * 下一次临时字幕变化都会开启新的 3 秒 cycle。
         */
        partialTranslationCycleStartedAt = 0;

        if (translationEnabled) {
            /*
             * 等待期间临时文本又变化了，按防抖重新调度。
             */
            if (revision !== partialTranslationRevision) {
                schedulePartialTranslation(
                    partialTranslationSourceText,
                    true
                );
            }

            /*
             * 确认字幕若有积压，在串行约束解除后重新调度。
             */
            scheduleTranslations(sessionData.confirmed_lines);
        }
    }
}

/**
 * 选择临时翻译的原文。
 *
 * 1. 优先使用非空的 buffer_transcription；
 * 2. 课堂中 buffer_transcription 常为空、而 lines 持续增长时，
 *    在 active_transcription 状态下回退到最后一条非空 line.text，
 *    并且只保留末尾 PARTIAL_TRANSLATION_SOURCE_LIMIT 个字符，
 *    避免不断增长的实时字幕让 API 输入与费用无限增大；
 * 3. 其他情况返回空字符串。
 */
function getLiveTranslationSource(data) {
    const bufferTranscription =
        typeof data.buffer_transcription === "string"
            ? data.buffer_transcription.trim()
            : "";

    if (bufferTranscription) {
        return bufferTranscription;
    }

    if (
        data.status === "active_transcription" &&
        Array.isArray(data.lines)
    ) {
        for (
            let index = data.lines.length - 1;
            index >= 0;
            index -= 1
        ) {
            const line = data.lines[index];

            const text =
                line && typeof line.text === "string"
                    ? line.text.trim()
                    : "";

            if (text) {
                return text.slice(-PARTIAL_TRANSLATION_SOURCE_LIMIT);
            }
        }
    }

    return "";
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

    const hasPartialBuffer =
        typeof data.buffer_transcription === "string" ||
        typeof data.buffer_translation === "string";

    if (hasPartialBuffer) {
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
    }

    /*
     * 临时翻译源：优先 buffer_transcription；
     * 课堂中它常为空而 lines 持续增长时，回退到实时 lines 末尾文本。
     */
    const liveTranslationSource = getLiveTranslationSource(data);

    if (liveTranslationSource) {
        latestPartialTranscription = liveTranslationSource;
        schedulePartialTranslation(liveTranslationSource);
    } else if (
        typeof data.buffer_transcription === "string" &&
        data.buffer_transcription.trim() === ""
    ) {
        /*
         * 只有服务器明确发送了空的 buffer_transcription 才清空，
         * 单纯的状态消息不会清掉已有临时参考译文。
         */
        latestPartialTranscription = "";
        schedulePartialTranslation("");
    }

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

    /*
     * 新课堂重置最终 Review。
     */
    finalReviewContent.replaceChildren();
    finalReviewContent.hidden = true;
    finalReviewButton.disabled = true;
    finalReviewButton.textContent = "生成最终 Review";
    finalReviewIsGenerating = false;
    setFinalReviewState("等待课堂结束", "idle");

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
    resetSummaryPanel();
    resetTranslations();

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
    clearPartialTranslation();

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

    finalReviewButton.disabled =
        sessionData.confirmed_lines.length === 0;
    setFinalReviewState("可按需生成", "idle");
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
        if (line.translation) {
            lines.push(`> ${line.translation}`);
        }
        lines.push("");
    });

    if (sessionData.summary) {
        lines.push("## Summary");
        lines.push("");
        lines.push(String(sessionData.summary));
        lines.push("");
    }

    if (sessionData.final_review) {
        lines.push("## Final Review");
        lines.push("");
        lines.push(
            formatFinalReviewForExport(sessionData.final_review)
        );
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

summaryNowButton.addEventListener("click", () => {
    void generateSummary();
});

finalReviewButton.addEventListener("click", () => {
    void generateFinalReview();
});

summarySettingsButton.addEventListener("click", () => {
    const willOpen = summarySettingsForm.hidden;

    summarySettingsForm.hidden = !willOpen;
    summarySettingsButton.textContent = willOpen ? "收起" : "展开";
});

summaryCloseSettingsButton.addEventListener("click", () => {
    summarySettingsForm.hidden = true;
    summarySettingsButton.textContent = "展开";
});

summaryProviderInput.addEventListener(
    "change",
    updateSummaryProviderFields
);

summarySettingsForm.addEventListener(
    "submit",
    async (event) => {
        event.preventDefault();

        saveSummarySettings();

        await generateSummary();
    }
);

translationToggle.addEventListener("click", () => {
    translationEnabled = !translationEnabled;
    translationToggle.classList.toggle("is-on", translationEnabled);
    translationToggle.setAttribute("aria-pressed", String(translationEnabled));
    translationToggle.title = translationEnabled ? "翻译已开启" : "翻译已关闭";
    saveTranslationSettings();
    renderTranslationVisibility();
    setTranslationState(translationEnabled ? "等待字幕" : "翻译关闭");
    if (translationEnabled) {
        scheduleTranslations(sessionData.confirmed_lines);
        schedulePartialTranslation(latestPartialTranscription, true);
    } else {
        clearPartialTranslation();
    }
});

translationDirection.addEventListener("change", () => {
    /*
     * 递增 epoch 并清空缓存：
     * 正在进行的旧方向请求返回后会被丢弃，
     * 避免把旧方向译文写回当前方向。
     */
    translationEpoch += 1;
    translationCache.clear();

    /*
     * 使正在飞的临时翻译结果失效（递增 revision 并清空显示），
     * 旧方向请求返回后绝不能写入 partial-translation-caption。
     */
    clearPartialTranslation();

    saveTranslationSettings();
    renderTranslationVisibility();

    if (translationEnabled) {
        scheduleTranslations(sessionData.confirmed_lines);
        schedulePartialTranslation(latestPartialTranscription, true);
    }
});

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

/**
 * 初始化可调整布局（v0.6.2）。
 *
 * 设置栏宽度与总结面板高度会保存到 localStorage，
 * 刷新页面后保持；窄屏下布局改为单列，不启用拖动。
 */
function initializeResizableLayout() {
    const storageKey = "heareview.layout.v0.6.2";

    try {
        const saved = JSON.parse(
            localStorage.getItem(storageKey) || "{}"
        );

        if (Number.isFinite(saved.sidebarWidth)) {
            appLayout.style.setProperty(
                "--sidebar-width",
                `${saved.sidebarWidth}px`
            );
        }

        if (Number.isFinite(saved.summaryHeight)) {
            appLayout.style.setProperty(
                "--summary-height",
                `${saved.summaryHeight}px`
            );
        }
    } catch (error) {
        console.warn("读取布局设置失败：", error);
    }

    function persist() {
        const styles = window.getComputedStyle(appLayout);

        localStorage.setItem(storageKey, JSON.stringify({
            sidebarWidth: parseFloat(
                styles.getPropertyValue("--sidebar-width")
            ),
            summaryHeight: parseFloat(
                styles.getPropertyValue("--summary-height")
            )
        }));
    }

    function makeResizable(handle, axis) {
        handle.addEventListener("pointerdown", (event) => {
            /*
             * 窄屏下布局改为单列，拖动把手隐藏，
             * 这里不再响应拖动。
             */
            if (window.matchMedia("(max-width: 850px)").matches) {
                return;
            }

            event.preventDefault();
            handle.setPointerCapture(event.pointerId);

            document.body.classList.add("is-resizing");

            const bounds = appLayout.getBoundingClientRect();

            const onMove = (moveEvent) => {
                if (axis === "x") {
                    const width = Math.min(
                        520,
                        Math.max(240, bounds.right - moveEvent.clientX)
                    );

                    appLayout.style.setProperty(
                        "--sidebar-width",
                        `${width}px`
                    );

                    return;
                }

                const panel = document
                    .querySelector(".caption-panel")
                    .getBoundingClientRect();

                const height = Math.min(
                    panel.height * 0.6,
                    Math.max(150, panel.bottom - moveEvent.clientY)
                );

                appLayout.style.setProperty(
                    "--summary-height",
                    `${height}px`
                );
            };

            const onUp = () => {
                document.body.classList.remove("is-resizing");
                persist();

                window.removeEventListener("pointermove", onMove);
                window.removeEventListener("pointerup", onUp);
            };

            window.addEventListener("pointermove", onMove);
            window.addEventListener("pointerup", onUp);
        });
    }

    makeResizable(sidebarResizer, "x");
    makeResizable(summaryResizer, "y");
}

async function initializeApplication() {
    startButton.disabled = false;
    stopButton.disabled = true;
    downloadMarkdownButton.disabled = true;
    downloadJsonButton.disabled = true;

    resetLagDisplay();
    updateVolumeDisplay(0);
    initializeSummaryPanel();
    initializeResizableLayout();
    initializeTranslationSettings();

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
