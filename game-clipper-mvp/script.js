const fileInput = document.getElementById("videoFile");
const video = document.getElementById("video");
const analyzeBtn = document.getElementById("analyzeBtn");
const statusEl = document.getElementById("status");
const clipsEl = document.getElementById("clips");
const template = document.getElementById("clipTemplate");

let currentFile = null;
let objectUrl = null;
let ffmpegInstance = null;

fileInput.addEventListener("change", () => {
  currentFile = fileInput.files?.[0] || null;
  clipsEl.innerHTML = "";

  if (!currentFile) {
    statusEl.textContent = "動画を選択してください。";
    return;
  }

  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(currentFile);
  video.src = objectUrl;
  statusEl.textContent = `読み込み完了：${currentFile.name}`;
});

analyzeBtn.addEventListener("click", async () => {
  if (!currentFile) {
    alert("先に動画を選択してください。");
    return;
  }

  analyzeBtn.disabled = true;
  statusEl.textContent = "音声を解析中です。動画が長い場合は少し時間がかかります。";

  try {
    const clipLength = Number(document.getElementById("clipLength").value);
    const sensitivity = Number(document.getElementById("sensitivity").value);
    const maxClips = Number(document.getElementById("maxClips").value);

    const peaks = await detectAudioPeaks(currentFile, {
      clipLength,
      sensitivity,
      maxClips
    });

    renderClips(peaks, clipLength);

    statusEl.textContent = peaks.length
      ? `${peaks.length}件の切り抜き候補を検出しました。`
      : "候補が見つかりませんでした。感度を高くして再解析してください。";
  } catch (error) {
    console.error(error);
    statusEl.textContent = "解析に失敗しました。別の動画で試してください。";
  } finally {
    analyzeBtn.disabled = false;
  }
});

async function detectAudioPeaks(file, options) {
  const arrayBuffer = await file.arrayBuffer();
  const audioContext = new AudioContext();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));

  const channelData = audioBuffer.getChannelData(0);
  const sampleRate = audioBuffer.sampleRate;
  const duration = audioBuffer.duration;

  // 0.5秒単位でRMS音量を計算
  const windowSec = 0.5;
  const windowSize = Math.floor(sampleRate * windowSec);
  const volumes = [];

  for (let i = 0; i < channelData.length; i += windowSize) {
    let sum = 0;
    const end = Math.min(i + windowSize, channelData.length);

    for (let j = i; j < end; j++) {
      sum += channelData[j] * channelData[j];
    }

    const rms = Math.sqrt(sum / (end - i));
    volumes.push({
      time: i / sampleRate,
      volume: rms
    });
  }

  const avg = volumes.reduce((a, b) => a + b.volume, 0) / volumes.length;
  const threshold = avg * options.sensitivity;

  const candidates = volumes
    .filter(v => v.volume > threshold)
    .sort((a, b) => b.volume - a.volume);

  // 近すぎる候補を除外
  const selected = [];
  for (const item of candidates) {
    const tooClose = selected.some(s => Math.abs(s.time - item.time) < options.clipLength);
    if (!tooClose) selected.push(item);
    if (selected.length >= options.maxClips) break;
  }

  await audioContext.close();

  return selected
    .sort((a, b) => a.time - b.time)
    .map((item, index) => {
      const start = Math.max(0, item.time - options.clipLength * 0.35);
      const end = Math.min(duration, start + options.clipLength);

      return {
        id: index + 1,
        start,
        end,
        score: Math.min(100, Math.round((item.volume / threshold) * 70)),
        reason: "音量ピーク"
      };
    });
}

function renderClips(clips) {
  clipsEl.innerHTML = "";

  if (!clips.length) return;

  for (const clip of clips) {
    const node = template.content.cloneNode(true);
    node.querySelector(".clipTitle").textContent = `候補 ${clip.id}：${makeTitle(clip)}`;
    node.querySelector(".clipMeta").textContent =
      `${formatTime(clip.start)}〜${formatTime(clip.end)} / スコア ${clip.score} / 理由：${clip.reason}`;

    node.querySelector(".previewBtn").addEventListener("click", () => {
      video.currentTime = clip.start;
      video.play();

      const stopTimer = setInterval(() => {
        if (video.currentTime >= clip.end) {
          video.pause();
          clearInterval(stopTimer);
        }
      }, 200);
    });

    node.querySelector(".exportBtn").addEventListener("click", async () => {
      await exportClip(clip);
    });

    clipsEl.appendChild(node);
  }
}

function makeTitle(clip) {
  const titles = [
    "ここが一番盛り上がった瞬間",
    "神プレイ候補",
    "視聴者が反応しそうな場面",
    "ショート向け切り抜き候補",
    "ハイライト候補"
  ];

  return titles[(clip.id - 1) % titles.length];
}

function formatTime(sec) {
  const m = Math.floor(sec / 60).toString().padStart(2, "0");
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

async function getFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  const { FFmpeg } = FFmpegWASM;
  const ffmpeg = new FFmpeg();

  ffmpeg.on("log", ({ message }) => {
    console.log(message);
  });

  statusEl.textContent = "初回のみFFmpegを読み込み中です。";
  await ffmpeg.load({
    coreURL: "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd/ffmpeg-core.js"
  });

  ffmpegInstance = ffmpeg;
  return ffmpeg;
}

async function exportClip(clip) {
  if (!currentFile) return;

  const ffmpeg = await getFFmpeg();

  const inputName = "input.mp4";
  const outputName = `clip-${clip.id}.mp4`;

  statusEl.textContent = `候補${clip.id}を書き出し中です。`;

  const data = new Uint8Array(await currentFile.arrayBuffer());
  await ffmpeg.writeFile(inputName, data);

  await ffmpeg.exec([
    "-ss", String(clip.start),
    "-to", String(clip.end),
    "-i", inputName,
    "-c", "copy",
    outputName
  ]);

  const outputData = await ffmpeg.readFile(outputName);
  const blob = new Blob([outputData.buffer], { type: "video/mp4" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = outputName;
  a.click();

  URL.revokeObjectURL(url);
  statusEl.textContent = `候補${clip.id}を書き出しました。`;
}
