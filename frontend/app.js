/*
HearReview v0.5 frontend

职责：
1. 连接 WhisperLiveKit WebSocket。
2. 通过浏览器获取麦克风。
3. 将音频重采样为16 kHz、单声道、PCM16。
4. 把音频持续发送给 WhisperLiveKit。
5. 显示 confirmed lines 和 buffer_transcription。
6. 保存服务器返回的原始 JSON。
*/

const WEBSOCKET_URL = "ws://127.0.0.1:8000/asr";
const TARGET_SAMPLE_RATE = 16000;

const startButton = document.querySelector("#start-button");
const stopButton = document.querySelector("#stop-button");
const downloadMarkdownButton = document.querySelector(
    "#download-markdown-button"
);

const downloadJsonButton = document.querySelector(
    "#download-json-button"
);

const courseNameInput = document.querySelector(
    "#course-name"
);

/*
保存服务器最近一次返回的确认字幕。
导出Markdown时只使用确认字幕，不使用临时字幕。
*/
let latestConfirmedLines = [];

const serverStatus = document.querySelector("#server-status");
const confirmedContainer = document.querySelector("#confirmed-captions");
const partialCaption = document.querySelector("#partial-caption");

const transcriptionLag = document.querySelector("#transcription-lag");
const policyLag = document.querySelector("#policy-lag");
const processingLag = document.querySelector("#processing-lag");
const sessionTime = document.querySelector("#session-time");

let websocket = null;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let processorNode = null;
let silentGainNode = null;

let recording = false;
let rawEvents = [];
let sessionStartedAt = null;
let timerId = null;

const microphoneSelect = document.querySelector(
    "#microphone-select"
);

const refreshDevicesButton = document.querySelector(
    "#refresh-devices-button"
);

const volumeLevel = document.querySelector(
    "#volume-level"
);

const volumeStatus = document.querySelector(
    "#volume-status"
);

let silenceStartedAt = null;


/*
更新顶部服务器状态。
*/
function setServerStatus(state, text) {
    serverStatus.className = `status ${state}`;
    serverStatus.textContent = text;
}


/*
将秒数格式化为00:00:00。
*/
function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds));
    const hours = String(Math.floor(seconds / 3600)).padStart(2, "0");
    const minutes = String(
        Math.floor((seconds % 3600) / 60)
    ).padStart(2, "0");
    const remaining = String(seconds % 60).padStart(2, "0");

    return `${hours}:${minutes}:${remaining}`;
}


/*
启动课堂计时器。
*/
function startTimer() {
    sessionStartedAt = Date.now();

    timerId = window.setInterval(() => {
        const elapsed = (Date.now() - sessionStartedAt) / 1000;
        sessionTime.textContent = formatDuration(elapsed);
    }, 250);
}


/*
停止课堂计时器。
*/
function stopTimer() {
    if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
    }
}


/*
将服务器的延迟字段安全转换成数字。
*/
function formatLag(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return "0.0s";
    }

    return `${number.toFixed(1)}s`;
}


/*
重新渲染服务器返回的完整确认字幕列表。

WhisperLiveKit可能在每条消息中重复发送全部历史lines，
所以这里重新渲染服务器的权威列表，而不是盲目append。
*/
function renderConfirmedLines(lines) {
    const validLines = (lines ?? []).filter((line) => {
        return typeof line.text === "string" && line.text.trim() !== "";
    });

    /*
    复制一份确认字幕，避免后续服务器消息修改原对象。
    */
    latestConfirmedLines = validLines.map((line) => ({
        speaker: line.speaker,
        start: line.start,
        end: line.end,
        text: line.text.trim(),
        detected_language: line.detected_language ?? null
    }));

    confirmedContainer.replaceChildren();

    if (validLines.length === 0) {
        const emptyMessage = document.createElement("div");
        emptyMessage.className = "empty-message";
        emptyMessage.textContent = "正在等待确认字幕……";
        confirmedContainer.appendChild(emptyMessage);
        return;
    }

    for (const line of validLines) {
        const lineElement = document.createElement("article");
        lineElement.className = "caption-line";

        const metadata = document.createElement("div");
        metadata.className = "caption-meta";

        const speaker =
            Number(line.speaker) > 0
                ? `Speaker ${line.speaker}`
                : "Speaker";

        metadata.textContent =
            `${line.start ?? "--:--"} → ${line.end ?? "--:--"} · ${speaker}`;

        const text = document.createElement("p");
        text.className = "caption-text";
        text.textContent = line.text.trim();

        lineElement.append(metadata, text);
        confirmedContainer.appendChild(lineElement);
    }

    // 新字幕出现后自动滚动到底部。
    confirmedContainer.scrollTop = confirmedContainer.scrollHeight;
}


/*
处理WhisperLiveKit返回的一条JSON消息。
*/
function handleServerMessage(data) {
    rawEvents.push({
        received_at: new Date().toISOString(),
        payload: data
    });

    renderConfirmedLines(data.lines);

    const partialText =
        typeof data.buffer_transcription === "string"
            ? data.buffer_transcription.trim()
            : "";

    partialCaption.textContent =
        partialText || "等待新的语音……";

    transcriptionLag.textContent = formatLag(
        data.remaining_time_transcription
    );

    policyLag.textContent = formatLag(
        data.remaining_time_transcription_policy
    );

    processingLag.textContent = formatLag(
        data.remaining_time_transcription_processing
    );

    downloadJsonButton.disabled =
        rawEvents.length === 0;

    downloadMarkdownButton.disabled =
        latestConfirmedLines.length === 0;
}


/*
把浏览器采集到的音频降采样至16 kHz。

简单平均法足够用于当前语音识别原型。
后期可以换成质量更高的音频重采样器。
*/
function downsampleAudio(input, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) {
        return new Float32Array(input);
    }

    if (inputSampleRate < outputSampleRate) {
        throw new Error(
            `输入采样率${inputSampleRate}低于目标采样率${outputSampleRate}`
        );
    }

    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.round(input.length / ratio);
    const output = new Float32Array(outputLength);

    let outputIndex = 0;
    let inputIndex = 0;

    while (outputIndex < output.length) {
        const nextInputIndex = Math.round(
            (outputIndex + 1) * ratio
        );

        let sum = 0;
        let count = 0;

        for (
            let index = inputIndex;
            index < nextInputIndex && index < input.length;
            index += 1
        ) {
            sum += input[index];
            count += 1;
        }

        output[outputIndex] = count > 0 ? sum / count : 0;

        outputIndex += 1;
        inputIndex = nextInputIndex;
    }

    return output;
}


/*
将Float32音频转换成小端PCM16。

WhisperLiveKit使用--pcm-input启动时，
WebSocket需要接收这种原始音频格式。
*/
function float32ToPCM16(input) {
    const output = new Int16Array(input.length);

    for (let index = 0; index < input.length; index += 1) {
        const sample = Math.max(-1, Math.min(1, input[index]));

        output[index] =
            sample < 0
                ? sample * 0x8000
                : sample * 0x7fff;
    }

    return output;
}


/*
创建WebSocket并等待连接完成。
*/
function connectWebSocket() {
    return new Promise((resolve, reject) => {
        setServerStatus("connecting", "正在连接服务器");

        websocket = new WebSocket(WEBSOCKET_URL);
        websocket.binaryType = "arraybuffer";

        websocket.addEventListener("open", () => {
            setServerStatus("online", "服务器已连接");
            resolve();
        });

        websocket.addEventListener("message", async (event) => {
            try {
                let messageText;

                if (typeof event.data === "string") {
                    messageText = event.data;
                } else if (event.data instanceof Blob) {
                    messageText = await event.data.text();
                } else {
                    return;
                }

                const data = JSON.parse(messageText);
                handleServerMessage(data);
            } catch (error) {
                console.error("无法处理服务器消息：", error, event.data);
            }
        });

        websocket.addEventListener("error", () => {
            reject(
                new Error(
                    "无法连接WhisperLiveKit，请确认8000端口服务器正在运行"
                )
            );
        });

        websocket.addEventListener("close", () => {
            setServerStatus("offline", "服务器连接已关闭");
            websocket = null;
        });
    });
}


/*
读取浏览器可用的麦克风列表。

浏览器通常只有在用户授予麦克风权限后，
才会公开真实的设备名称。
*/
async function loadMicrophoneDevices(requestPermission = false) {
    let temporaryStream = null;

    try {
        if (requestPermission) {
            temporaryStream =
                await navigator.mediaDevices.getUserMedia({
                    audio: true
                });
        }

        const devices =
            await navigator.mediaDevices.enumerateDevices();

        const microphones = devices.filter(
            (device) => device.kind === "audioinput"
        );

        const previousSelection =
            microphoneSelect.value;

        microphoneSelect.replaceChildren();

        const defaultOption =
            document.createElement("option");

        defaultOption.value = "";
        defaultOption.textContent =
            "系统默认麦克风";

        microphoneSelect.appendChild(
            defaultOption
        );

        microphones.forEach((microphone, index) => {
            const option =
                document.createElement("option");

            option.value = microphone.deviceId;

            option.textContent =
                microphone.label ||
                `麦克风 ${index + 1}`;

            microphoneSelect.appendChild(
                option
            );
        });

        const previousStillExists =
            microphones.some(
                (microphone) =>
                    microphone.deviceId ===
                    previousSelection
            );

        if (previousStillExists) {
            microphoneSelect.value =
                previousSelection;
        }

    } catch (error) {
        console.error(
            "无法读取麦克风列表：",
            error
        );

        alert(
            "无法读取麦克风，请检查浏览器权限。"
        );

    } finally {
        if (temporaryStream) {
            temporaryStream
                .getTracks()
                .forEach((track) => track.stop());
        }
    }
}


/*
根据RMS音量更新界面。

这里使用对数刻度，因为人声振幅通常较小，
直接使用线性百分比会让音量条几乎不动。
*/
function updateVolumeMeter(rms) {
    const decibels =
        20 * Math.log10(
            Math.max(rms, 0.000001)
        );

    const percentage = Math.max(
        0,
        Math.min(
            100,
            ((decibels + 60) / 50) * 100
        )
    );

    volumeLevel.style.width =
        `${percentage}%`;

    if (rms >= 0.002) {
        silenceStartedAt = null;

        volumeStatus.textContent =
            "有声音";

        volumeStatus.className =
            "active";

        volumeLevel.classList.remove(
            "warning"
        );

        return;
    }

    if (silenceStartedAt === null) {
        silenceStartedAt = Date.now();
    }

    const silentDuration =
        Date.now() - silenceStartedAt;

    if (silentDuration >= 3000) {
        volumeStatus.textContent =
            "没有声音";

        volumeStatus.className =
            "silent";

        volumeLevel.classList.add(
            "warning"
        );
    } else {
        volumeStatus.textContent =
            "音量较低";

        volumeStatus.className = "";
    }
}


/*
开启浏览器麦克风，并将PCM音频持续发给服务器。
*/
async function startMicrophone() {
    const selectedDeviceId =
        microphoneSelect.value;

    const audioConstraints =
        selectedDeviceId
            ? {
                deviceId: {
                    exact: selectedDeviceId
                }
            }
            : true;

    mediaStream =
        await navigator.mediaDevices.getUserMedia({
            audio: audioConstraints
        });

    const microphoneTrack =
        mediaStream.getAudioTracks()[0];

    console.log("当前麦克风：", {
        label: microphoneTrack.label,
        settings: microphoneTrack.getSettings()
    });

    audioContext = new AudioContext();

    sourceNode = audioContext.createMediaStreamSource(mediaStream);

    /*
    ScriptProcessorNode虽然已经被Web Audio标准标记为旧API，
    但当前原型中兼容性较好。

    正式版会改成AudioWorklet。
    */
    processorNode = audioContext.createScriptProcessor(
        4096,
        1,
        1
    );

    /*
    ScriptProcessor必须连接到音频输出图才能持续触发，
    因此通过音量为0的GainNode连接，防止麦克风声音回放。
    */
    silentGainNode = audioContext.createGain();
    silentGainNode.gain.value = 0;

    processorNode.addEventListener("audioprocess", (event) => {
        if (
            !recording ||
            websocket?.readyState !== WebSocket.OPEN
        ) {
            return;
        }

        const input = event.inputBuffer.getChannelData(0);
        const rms = Math.sqrt(
            input.reduce(
                (sum, sample) => sum + sample * sample,
                0
            ) / input.length
        );

        updateVolumeMeter(rms);

        const downsampled = downsampleAudio(
            input,
            audioContext.sampleRate,
            TARGET_SAMPLE_RATE
        );

        const pcm16 = float32ToPCM16(downsampled);

        websocket.send(pcm16.buffer);
    });

    sourceNode.connect(processorNode);
    processorNode.connect(silentGainNode);
    silentGainNode.connect(audioContext.destination);
}


/*
开始新课堂。
*/
async function startSession() {
    try {
        startButton.disabled = true;

        rawEvents = [];
        latestConfirmedLines = [];

        confirmedContainer.replaceChildren();

        downloadMarkdownButton.disabled = true;
        downloadJsonButton.disabled = true;

        await connectWebSocket();
        await startMicrophone();

        recording = true;

        startTimer();

        stopButton.disabled = false;

        partialCaption.textContent = "正在监听课堂语音……";
    } catch (error) {
        console.error(error);
        alert(error.message);

        startButton.disabled = false;
        stopButton.disabled = true;

        await stopAudioResources();
    }
}


/*
释放浏览器音频资源。
*/
async function stopAudioResources() {
    recording = false;

    if (processorNode) {
        processorNode.disconnect();
        processorNode = null;
    }

    if (sourceNode) {
        sourceNode.disconnect();
        sourceNode = null;
    }

    if (silentGainNode) {
        silentGainNode.disconnect();
        silentGainNode = null;
    }

    if (mediaStream) {
        for (const track of mediaStream.getTracks()) {
            track.stop();
        }

        mediaStream = null;
    }

    if (audioContext) {
        await audioContext.close();
        audioContext = null;
    }
}


/*
结束课堂。

发送零长度二进制消息，通知WhisperLiveKit刷新剩余字幕。
*/
async function stopSession() {
    stopButton.disabled = true;

    await stopAudioResources();
    stopTimer();

    if (websocket?.readyState === WebSocket.OPEN) {
        websocket.send(new ArrayBuffer(0));
    }

    startButton.disabled = false;

    downloadJsonButton.disabled =
        rawEvents.length === 0;

    downloadMarkdownButton.disabled =
        latestConfirmedLines.length === 0;

    partialCaption.textContent = "课堂已经结束";
}


/*
把所有原始服务器消息下载成JSON。

后续可利用这些数据分析字幕稳定过程、置信度和纠错权重。
*/
function downloadJsonSession() {
    const session = {
        version: "HearReview v0.5.2",
        created_at: new Date().toISOString(),
        events: rawEvents
    };

    const blob = new Blob(
        [JSON.stringify(session, null, 2)],
        {
            type: "application/json"
        }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const timestamp = new Date()
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-");

    link.href = url;
    link.download = `heareview-${timestamp}.json`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
}


/*
将已确认字幕导出为可读Markdown。

Markdown只包含最终确认的lines，
不会包含尚未稳定的buffer_transcription。
*/
function downloadMarkdownTranscript() {
    if (latestConfirmedLines.length === 0) {
        alert("当前没有可以导出的确认字幕。");
        return;
    }

    const courseName =
        courseNameInput.value.trim() ||
        "Untitled Lecture";

    const createdAt =
        new Date().toLocaleString();

    const markdownLines = [
        `# ${courseName}`,
        "",
        `- Created: ${createdAt}`,
        `- Application: HearReview v0.5.2`,
        `- Confirmed segments: ${latestConfirmedLines.length}`,
        "",
        "## Lecture Transcript",
        ""
    ];

    for (const line of latestConfirmedLines) {
        const speaker =
            Number(line.speaker) > 0
                ? `Speaker ${line.speaker}`
                : "Speaker";

        markdownLines.push(
            `### ${line.start ?? "--:--"}–${line.end ?? "--:--"} · ${speaker}`
        );

        markdownLines.push("");
        markdownLines.push(line.text);
        markdownLines.push("");
    }

    const markdown = markdownLines.join("\n");

    const blob = new Blob(
        [markdown],
        {
            type: "text/markdown;charset=utf-8"
        }
    );

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const safeCourseName = courseName
        .replace(/[<>:"/\\|?*]+/g, "-")
        .replace(/\s+/g, "-");

    const date = new Date()
        .toISOString()
        .slice(0, 10);

    link.href = url;
    link.download =
        `${safeCourseName}-${date}.md`;

    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
}


startButton.addEventListener("click", startSession);
stopButton.addEventListener("click", stopSession);

downloadMarkdownButton.addEventListener(
    "click",
    downloadMarkdownTranscript
);

downloadJsonButton.addEventListener(
    "click",
    downloadJsonSession
);

refreshDevicesButton.addEventListener(
    "click",
    () => loadMicrophoneDevices(true)
);

/*
麦克风插入或拔出时自动刷新设备列表。
*/
navigator.mediaDevices.addEventListener(
    "devicechange",
    () => loadMicrophoneDevices(false)
);

/*
页面加载后先读取一次设备。
如果名称为空，用户点击“刷新”并授权后就会显示。
*/
loadMicrophoneDevices(false);
