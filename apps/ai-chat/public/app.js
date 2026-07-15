const STORAGE_KEY = "cz-ai-chat-conversations";
const SETTINGS_KEY = "cz-ai-chat-settings";
const TOKEN_KEY = "cz-ai-chat-access-token";
const MEDIA_HISTORY_KEY = "cz-ai-chat-media-history";

const defaultSettings = {
  thinking: true,
  stream: true,
  autoCompress: true,
  webSearch: false,
  temperature: 0.7,
  maxTokens: 2048,
  contextLimit: 120000,
};

let config = {
  model: "qwen3.6-35b-a3b",
  contextLimit: 120000,
  apiKey: "server-side",
  webTokenRequired: false,
  features: {
    webSearch: false,
    imageGeneration: false,
    videoGeneration: false,
  },
  media: {
    imagePath: "/api/media/image",
    videoPath: "/api/media/video",
  },
};
let settings = loadJson(SETTINGS_KEY, defaultSettings);
let conversations = loadJson(STORAGE_KEY, []);
let mediaHistory = loadJson(MEDIA_HISTORY_KEY, []);
let activeId = conversations[0]?.id || "";
const activeRequests = new Map();
const mediaState = {
  studioMode: "chat",
  tab: "image",
  lastImage: "",
};
let messageRenderScheduled = false;

const els = {
  appShell: document.querySelector(".app-shell"),
  studioModeButtons: [...document.querySelectorAll("[data-studio-mode]")],
  list: document.querySelector("#conversation-list"),
  search: document.querySelector("#conversation-search"),
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  prompt: document.querySelector("#prompt"),
  title: document.querySelector("#active-title"),
  meta: document.querySelector("#chat-meta"),
  modelLabel: document.querySelector("#model-label"),
  modelStatus: document.querySelector("#model-status"),
  keyStatus: document.querySelector("#key-status"),
  streamState: document.querySelector("#stream-state"),
  contextBar: document.querySelector("#context-bar"),
  contextLabel: document.querySelector("#context-label"),
  contextLimit: document.querySelector("#context-limit"),
  summaryBox: document.querySelector("#summary-box"),
  tokenPanel: document.querySelector("#token-panel"),
  accessToken: document.querySelector("#access-token"),
  thinkingToggle: document.querySelector("#toggle-thinking"),
  streamToggle: document.querySelector("#toggle-stream"),
  compressToggle: document.querySelector("#toggle-compress"),
  webSearchToggle: document.querySelector("#toggle-web-search"),
  webSearchStatus: document.querySelector("#web-search-status"),
  mediaPanel: document.querySelector("#media-panel"),
  mediaEyebrow: document.querySelector("#media-eyebrow"),
  mediaTitle: document.querySelector("#media-title"),
  mediaStatus: document.querySelector("#media-status"),
  mediaResults: document.querySelector("#media-results"),
  imageRouteBar: document.querySelector("#image-route-bar"),
  imageReferenceRow: document.querySelector("#image-reference-row"),
  imageForm: document.querySelector("#image-form"),
  imageMode: document.querySelector("#image-mode"),
  imagePrompt: document.querySelector("#image-prompt"),
  imageNegativePrompt: document.querySelector("#image-negative-prompt"),
  imageInput: document.querySelector("#image-input"),
  imageUseLast: document.querySelector("#image-use-last"),
  imageWidth: document.querySelector("#image-width"),
  imageHeight: document.querySelector("#image-height"),
  imageSteps: document.querySelector("#image-steps"),
  imageCfg: document.querySelector("#image-cfg"),
  imageSeed: document.querySelector("#image-seed"),
  imageSampler: document.querySelector("#image-sampler"),
  imageScheduler: document.querySelector("#image-scheduler"),
  imageSubmit: document.querySelector("#image-submit"),
  videoForm: document.querySelector("#video-form"),
  videoRouteBar: document.querySelector("#video-route-bar"),
  videoReferenceRow: document.querySelector("#video-reference-row"),
  videoMode: document.querySelector("#video-mode"),
  videoPrompt: document.querySelector("#video-prompt"),
  videoNegativePrompt: document.querySelector("#video-negative-prompt"),
  videoImageInput: document.querySelector("#video-image-input"),
  videoKeyframes: document.querySelector("#video-keyframes"),
  videoWidth: document.querySelector("#video-width"),
  videoHeight: document.querySelector("#video-height"),
  videoLength: document.querySelector("#video-length"),
  videoSteps: document.querySelector("#video-steps"),
  videoCfg: document.querySelector("#video-cfg"),
  videoFps: document.querySelector("#video-fps"),
  videoSeed: document.querySelector("#video-seed"),
  videoQualityProfile: document.querySelector("#video-quality-profile"),
  videoSubmit: document.querySelector("#video-submit"),
  temperature: document.querySelector("#temperature"),
  maxTokens: document.querySelector("#max-tokens"),
  stop: document.querySelector("#stop-stream"),
  send: document.querySelector("#send-button"),
};

function loadJson(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key) || "") || structuredClone(fallback);
  } catch {
    return structuredClone(fallback);
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function saveMediaHistory() {
  localStorage.setItem(MEDIA_HISTORY_KEY, JSON.stringify(mediaHistory.slice(0, 60)));
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function activeConversation() {
  if (!activeId || !conversations.find((item) => item.id === activeId)) {
    createConversation();
  }
  return conversations.find((item) => item.id === activeId);
}

function createConversation(seed = {}) {
  const now = new Date().toISOString();
  const conversation = {
    id: uid("chat"),
    title: seed.title || "新聊天",
    pinned: false,
    createdAt: now,
    updatedAt: now,
    summary: "",
    messages: seed.messages || [],
  };
  conversations.unshift(conversation);
  activeId = conversation.id;
  saveState();
  render();
  return conversation;
}

function deleteConversation(id = activeId) {
  if (!id) return;
  if (!confirm("删除这条聊天记录？")) return;
  conversations = conversations.filter((item) => item.id !== id);
  activeId = conversations[0]?.id || "";
  if (!activeId) createConversation();
  saveState();
  render();
}

function exportConversation(id = activeId) {
  const conversation = conversations.find((item) => item.id === id);
  if (!conversation) return;
  downloadJson(`${conversation.title || "chat"}.json`, conversation);
}

function setMessageFeedback(messageId, value) {
  const conversation = activeConversation();
  const message = conversation.messages.find((item) => item.id === messageId);
  if (!message || message.role !== "assistant") return;
  message.feedback = message.feedback === value ? "" : value;
  message.feedbackUpdatedAt = message.feedback ? new Date().toISOString() : "";
  conversation.updatedAt = new Date().toISOString();
  saveState();
  renderMessages();
}

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.replace(/[\\/:*?"<>|]+/g, "-");
  anchor.click();
  URL.revokeObjectURL(url);
}

function roughTokens(messages) {
  const text = messages.map((message) => `${message.role}:${message.content || ""}${message.reasoning || ""}`).join("\n");
  return Math.ceil(text.length / 3.2);
}

function conversationPayload(conversation) {
  const base = [];
  if (conversation.summary) {
    base.push({
      role: "system",
      content: `以下是较早聊天历史的压缩摘要，请在继续对话时保持一致：\n${conversation.summary}`,
    });
  }
  for (const message of conversation.messages) {
    if (message.role === "system") continue;
    base.push({ role: message.role, content: message.content || "" });
  }
  return base;
}

async function compressConversation(manual = false) {
  const conversation = activeConversation();
  if (conversation.messages.length < 8 && !manual) return false;

  const budget = Number(settings.contextLimit || config.contextLimit);
  if (!manual && roughTokens(conversationPayload(conversation)) < budget * 0.82) return false;

  const oldMessages = conversation.messages.slice(0, -4);
  if (!oldMessages.length) return false;
  setSummaryStatus("正在压缩上下文...");

  const response = await fetch("/api/compress", {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({ messages: oldMessages }),
  });
  if (!response.ok) {
    const error = await response.text();
    setSummaryStatus(`压缩失败：${error.slice(0, 160)}`);
    return false;
  }
  const data = await response.json();
  conversation.summary = data.summary || conversation.summary;
  conversation.messages = conversation.messages.slice(-4);
  conversation.updatedAt = new Date().toISOString();
  saveState();
  render();
  return true;
}

function authHeaders(extra = {}) {
  const token = localStorage.getItem(TOKEN_KEY) || "";
  return {
    "content-type": "application/json",
    ...(token ? { "x-ai-chat-token": token } : {}),
    ...extra,
  };
}

function setMediaStatus(text) {
  els.mediaStatus.textContent = text;
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve("");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("file read failed"));
    reader.readAsDataURL(file);
  });
}

function latestGeneratedImage() {
  if (mediaState.lastImage) return mediaState.lastImage;
  for (const record of mediaHistory) {
    for (const output of record.outputs || []) {
      if (output.type === "image" && (output.url || output.dataUrl)) {
        return output.url || output.dataUrl;
      }
    }
  }
  return "";
}

function normalizeMediaOutputs(data, defaultType) {
  const outputs = [];
  const sources = [];
  if (Array.isArray(data?.outputs)) sources.push(...data.outputs);
  if (Array.isArray(data?.images)) sources.push(...data.images.map((item) => ({ ...asMediaObject(item), type: "image" })));
  if (Array.isArray(data?.videos)) sources.push(...data.videos.map((item) => ({ ...asMediaObject(item), type: "video" })));
  if (data?.url) sources.push({ type: defaultType, url: data.url });
  if (data?.dataUrl) sources.push({ type: defaultType, dataUrl: data.dataUrl });
  if (data?.b64_json) sources.push({ type: defaultType, dataUrl: `data:${defaultType === "video" ? "video/mp4" : "image/png"};base64,${data.b64_json}` });

  for (const item of sources) {
    const output = asMediaObject(item);
    output.type = output.type || defaultType;
    if (output.b64_json && !output.dataUrl) {
      output.dataUrl = `data:${output.type === "video" ? "video/mp4" : "image/png"};base64,${output.b64_json}`;
    }
    if (output.url || output.dataUrl) outputs.push(output);
  }
  return outputs;
}

function asMediaObject(item) {
  if (typeof item === "string") return { url: item };
  return item && typeof item === "object" ? { ...item } : {};
}

function optionalNumber(input, parser = Number) {
  const raw = String(input?.value || "").trim();
  if (!raw) return undefined;
  const value = parser(raw);
  return Number.isFinite(value) ? value : undefined;
}

function optionalText(input) {
  const value = String(input?.value || "").trim();
  return value || undefined;
}

function collectImageOptions() {
  const options = {
    negative: optionalText(els.imageNegativePrompt),
    width: optionalNumber(els.imageWidth, Number.parseInt),
    height: optionalNumber(els.imageHeight, Number.parseInt),
    steps: optionalNumber(els.imageSteps, Number.parseInt),
    cfg: optionalNumber(els.imageCfg, Number.parseFloat),
    seed: optionalNumber(els.imageSeed, Number.parseInt),
    sampler: optionalText(els.imageSampler),
    scheduler: optionalText(els.imageScheduler),
  };
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function collectVideoOptions() {
  const options = {
    profile: optionalText(els.videoQualityProfile),
    negative: optionalText(els.videoNegativePrompt),
    width: optionalNumber(els.videoWidth, Number.parseInt),
    height: optionalNumber(els.videoHeight, Number.parseInt),
    length: optionalNumber(els.videoLength, Number.parseInt),
    steps: optionalNumber(els.videoSteps, Number.parseInt),
    cfg: optionalNumber(els.videoCfg, Number.parseFloat),
    fps: optionalNumber(els.videoFps, Number.parseInt),
    seed: optionalNumber(els.videoSeed, Number.parseInt),
  };
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined));
}

function looksLikeEditRequest(prompt) {
  return /继续|修改|改|调整|修|上一张|这张|保持|不要|加|换|去掉|删除|拉远|拉近|背景|细节|重画|优化/.test(prompt || "");
}

function routeLabel(mode) {
  return mediaModeLabel(mode);
}

function inferImageRoute(prompt = "", uploadedImage = "") {
  const currentImage = latestGeneratedImage();
  if (uploadedImage) {
    return {
      mode: "image-to-image",
      image: uploadedImage,
      label: "图生图",
      reason: "检测到参考图，会以参考图作为视觉约束生成新图。",
    };
  }
  if ((els.imageUseLast.checked || (currentImage && looksLikeEditRequest(prompt))) && currentImage) {
    return {
      mode: "edit-image",
      image: currentImage,
      label: "持续改图",
      reason: "检测到当前图片和修改意图，会沿用上一张结果继续修改。",
    };
  }
  return {
    mode: "text-to-image",
    image: "",
    label: "文生图",
    reason: "没有参考图或当前结果，会从文字直接生成图片。",
  };
}

function inferVideoRoute(prompt = "", image = "", keyframes = []) {
  if (keyframes.length) {
    return {
      mode: "keyframes-to-video",
      image,
      keyframes,
      label: "关键帧生视频",
      reason: "检测到关键帧，会优先走关键帧视频工作流。",
    };
  }
  if (image) {
    return {
      mode: "image-to-video",
      image,
      keyframes,
      label: "图生视频",
      reason: "检测到首帧图，会把图片作为视频起点。",
    };
  }
  return {
    mode: "text-to-video",
    image: "",
    keyframes,
    label: "文生视频",
    reason: "没有图片输入，会从文字直接生成视频。",
  };
}

function renderRouteBar(container, route) {
  if (!container) return;
  container.innerHTML = `
    <div>
      <span class="route-label">自动选择</span>
      <strong>${escapeHtml(route.label)}</strong>
    </div>
    <span>${escapeHtml(route.reason)}</span>
  `;
}

function renderReferenceRow(container, items) {
  if (!container) return;
  container.innerHTML = items.length
    ? items.map((item) => `<span class="reference-chip">${escapeHtml(item)}</span>`).join("")
    : '<span class="reference-empty">未添加媒体输入，将从文字开始生成</span>';
}

function updateMediaRoutePreview() {
  const imageHasUpload = Boolean(els.imageInput.files?.[0]);
  const imageRoute = inferImageRoute(els.imagePrompt.value, imageHasUpload ? "__uploaded__" : "");
  els.imageMode.value = imageRoute.mode;
  renderRouteBar(els.imageRouteBar, imageRoute);
  renderReferenceRow(
    els.imageReferenceRow,
    [
      imageHasUpload ? "参考图" : "",
      imageRoute.mode === "edit-image" ? "当前图片" : "",
    ].filter(Boolean),
  );

  const videoHasImage = Boolean(els.videoImageInput.files?.[0]);
  const videoKeyframeCount = els.videoKeyframes.files?.length || 0;
  const videoRoute = inferVideoRoute(els.videoPrompt.value, videoHasImage ? "__uploaded__" : "", new Array(videoKeyframeCount).fill({}));
  els.videoMode.value = videoRoute.mode;
  renderRouteBar(els.videoRouteBar, videoRoute);
  renderReferenceRow(
    els.videoReferenceRow,
    [
      videoHasImage ? "首帧图" : "",
      videoKeyframeCount ? `${videoKeyframeCount} 个关键帧` : "",
    ].filter(Boolean),
  );
}

async function postMedia(path, payload) {
  const response = await fetch(path, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw new Error(data.error || text || `HTTP ${response.status}`);
  }
  return data;
}

async function submitImageGeneration(event) {
  event.preventDefault();
  if (!config.features?.imageGeneration) {
    setMediaStatus("生图接口未配置");
    return;
  }
  const prompt = els.imagePrompt.value.trim();
  const uploadedImage = await fileToDataUrl(els.imageInput.files?.[0]);
  const route = inferImageRoute(prompt, uploadedImage);
  const mode = route.mode;
  const image = route.image;
  els.imageMode.value = mode;
  if (!prompt && !image) {
    setMediaStatus("请输入描述或选择参考图");
    return;
  }
  els.imageSubmit.disabled = true;
  setMediaStatus("图片任务提交中...");
  try {
    const payload = { mode, prompt, image, ...collectImageOptions(), source: "cz-ai-chat-web" };
    const data = await postMedia(config.media?.imagePath || "/api/media/image", payload);
    const record = {
      id: uid("media"),
      type: "image",
      mode,
      routeReason: route.reason,
      prompt,
      createdAt: new Date().toISOString(),
      outputs: normalizeMediaOutputs(data, "image"),
      response: data,
    };
    mediaHistory.unshift(record);
    const firstImage = record.outputs.find((output) => output.type === "image" && (output.url || output.dataUrl));
    if (firstImage) mediaState.lastImage = firstImage.url || firstImage.dataUrl;
    saveMediaHistory();
    renderMediaResults();
    setMediaStatus(record.outputs.length ? `${route.label}完成` : `${route.label}任务已提交`);
  } catch (error) {
    setMediaStatus(`生图失败：${error.message.slice(0, 120)}`);
  } finally {
    els.imageSubmit.disabled = false;
    updateMediaRoutePreview();
  }
}

async function submitVideoGeneration(event) {
  event.preventDefault();
  if (!config.features?.videoGeneration) {
    setMediaStatus("生视频接口未配置");
    return;
  }
  const prompt = els.videoPrompt.value.trim();
  const image = await fileToDataUrl(els.videoImageInput.files?.[0]);
  const keyframes = [];
  for (const file of Array.from(els.videoKeyframes.files || [])) {
    keyframes.push({ name: file.name, dataUrl: await fileToDataUrl(file) });
  }
  const route = inferVideoRoute(prompt, image, keyframes);
  const mode = route.mode;
  els.videoMode.value = mode;
  if (!prompt && !image && !keyframes.length) {
    setMediaStatus("请输入描述或选择图片/关键帧");
    return;
  }
  els.videoSubmit.disabled = true;
  setMediaStatus("视频任务提交中...");
  try {
    const payload = { mode, prompt, image, keyframes, ...collectVideoOptions(), source: "cz-ai-chat-web" };
    const data = await postMedia(config.media?.videoPath || "/api/media/video", payload);
    const record = {
      id: uid("media"),
      type: "video",
      mode,
      routeReason: route.reason,
      prompt,
      createdAt: new Date().toISOString(),
      outputs: normalizeMediaOutputs(data, "video"),
      response: data,
    };
    mediaHistory.unshift(record);
    saveMediaHistory();
    renderMediaResults();
    setMediaStatus(record.outputs.length ? `${route.label}完成` : `${route.label}任务已提交`);
  } catch (error) {
    setMediaStatus(`生视频失败：${error.message.slice(0, 120)}`);
  } finally {
    els.videoSubmit.disabled = false;
    updateMediaRoutePreview();
  }
}

async function sendMessage(content) {
  const conversation = activeConversation();
  const prompt = String(content || "").trim();
  if (!prompt || activeRequests.has(conversation.id)) return;

  conversation.messages.push({ id: uid("msg"), role: "user", content: prompt, createdAt: new Date().toISOString() });
  if (conversation.title === "新聊天") {
    conversation.title = prompt.slice(0, 28);
  }
  conversation.updatedAt = new Date().toISOString();
  saveState();
  render();

  if (settings.autoCompress) {
    await compressConversation(false);
  }

  const assistant = {
    id: uid("msg"),
    role: "assistant",
    content: "",
    reasoning: "",
    streaming: true,
    elapsedMs: 0,
    createdAt: new Date().toISOString(),
  };
  conversation.messages.push(assistant);
  saveState();
  render();

  const requestController = new AbortController();
  activeRequests.set(conversation.id, requestController);
  updateStreamingState();

  const body = {
    messages: conversationPayload(conversation).filter((message) => message.role !== "assistant" || message.content),
    thinking: settings.thinking,
    stream: settings.stream,
    web_search: Boolean(settings.webSearch && config.features?.webSearch),
    temperature: Number(settings.temperature),
    max_tokens: Number(settings.maxTokens),
  };
  const startedAt = performance.now();

  try {
    const response = await fetch("/api/chat", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: requestController.signal,
    });
    if (!response.ok) {
      assistant.content = `请求失败：${await response.text()}`;
      return;
    }
    if (settings.stream && response.body?.getReader) {
      await readStreamingResponse(response, assistant, startedAt);
    } else {
      const data = await response.json();
      const message = data.choices?.[0]?.message || {};
      assistant.reasoning = message.reasoning_content || message.reasoning || "";
      assistant.content = message.content || "";
      assistant.elapsedMs = performance.now() - startedAt;
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      assistant.content = `请求中断：${error.message}`;
    }
  } finally {
    assistant.streaming = false;
    assistant.elapsedMs = assistant.elapsedMs || performance.now() - startedAt;
    conversation.updatedAt = new Date().toISOString();
    activeRequests.delete(conversation.id);
    updateStreamingState();
    saveState();
    flushMessageRender();
    render();
  }
}

async function readStreamingResponse(response, assistant, startedAt) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta || {};
        const message = parsed.choices?.[0]?.message || {};
        assistant.reasoning += delta.reasoning_content || delta.reasoning || message.reasoning_content || "";
        assistant.content += delta.content || message.content || "";
        assistant.elapsedMs = performance.now() - startedAt;
        scheduleMessageRender();
      } catch {
        assistant.content += data;
        assistant.elapsedMs = performance.now() - startedAt;
        scheduleMessageRender();
      }
    }
  }
}

function scheduleMessageRender() {
  if (messageRenderScheduled) return;
  messageRenderScheduled = true;
  requestAnimationFrame(() => {
    messageRenderScheduled = false;
    renderMessages();
  });
}

function flushMessageRender() {
  if (!messageRenderScheduled) return;
  messageRenderScheduled = false;
  renderMessages();
}

function render() {
  renderConversationList();
  renderMessages();
  renderMediaResults();
  renderInspector();
  renderStudioMode();
}

function renderConversationList() {
  const query = els.search.value.trim().toLowerCase();
  const sorted = [...conversations].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  els.list.innerHTML = "";
  for (const conversation of sorted) {
    const preview = conversation.messages.at(-1)?.content || conversation.summary || "暂无消息";
    if (query && !`${conversation.title} ${preview}`.toLowerCase().includes(query)) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = `conversation-row${conversation.id === activeId ? " active" : ""}`;
    button.innerHTML = `
      <div class="conversation-title-line">
        <span>${conversation.pinned ? "★" : "□"}</span>
        <span>${escapeHtml(conversation.title || "未命名聊天")}</span>
      </div>
      <div class="conversation-preview">${escapeHtml(preview)}</div>
    `;
    button.addEventListener("click", () => {
      activeId = conversation.id;
      render();
    });
    els.list.appendChild(button);
  }
}

function renderMessages() {
  const conversation = activeConversation();
  els.title.textContent = conversation.title || "新聊天";
  const tokenCount = roughTokens(conversationPayload(conversation));
  els.meta.textContent = `上下文 ${tokenCount} tokens · ${conversation.summary ? "已压缩" : "未压缩"}`;
  els.messages.innerHTML = "";

  if (!conversation.messages.length) {
    els.messages.innerHTML = `
      <div class="empty-state">
        <h2>开始一次私有 AI 对话</h2>
        <p>聊天记录保存在浏览器本地，发送请求由 9999 服务端代理到内网 Qwen3.6。</p>
        <div class="quick-prompts">
          <button type="button">帮我写一个 Python 调用示例</button>
          <button type="button">总结今天的部署状态</button>
          <button type="button">分析一段错误日志</button>
          <button type="button">把这段需求拆成任务清单</button>
        </div>
      </div>
    `;
    els.messages.querySelectorAll(".quick-prompts button").forEach((button) => {
      button.addEventListener("click", () => {
        els.prompt.value = button.textContent;
        els.prompt.focus();
      });
    });
    renderInspector();
    return;
  }

  for (const message of conversation.messages) {
    const article = document.createElement("article");
    article.className = `message ${message.role}`;
    const label = message.role === "user" ? "你" : "AI";
    const thinkingText = message.streaming && settings.thinking && !message.reasoning ? "思考中..." : message.reasoning;
    const elapsedText = message.elapsedMs ? formatDuration(message.elapsedMs) : "";
    const assistantStatus =
      message.role === "assistant" && (message.streaming || elapsedText)
        ? `<div class="message-status">${message.streaming ? "生成中" : "完成"}${elapsedText ? ` · ${elapsedText}` : ""}</div>`
        : "";
    const feedbackControls =
      message.role === "assistant" && !message.streaming
        ? `<div class="message-feedback" aria-label="回答反馈">
            <button class="feedback-button${message.feedback === "up" ? " active" : ""}" type="button" data-message-id="${escapeHtml(message.id)}" data-feedback="up" aria-pressed="${message.feedback === "up"}" title="符合心意">赞</button>
            <button class="feedback-button${message.feedback === "down" ? " active" : ""}" type="button" data-message-id="${escapeHtml(message.id)}" data-feedback="down" aria-pressed="${message.feedback === "down"}" title="不符合心意">踩</button>
            ${message.feedback ? `<span>已记录 · ${message.feedback === "up" ? "满意" : "不满意"}</span>` : ""}
          </div>`
        : "";
    const contentHtml =
      message.role === "assistant"
        ? renderMarkdown(message.content || (message.streaming ? "正在生成..." : ""))
        : escapeHtml(message.content || "");
    const thinkingOpen = message.streaming && !message.thinkingCollapsed ? " open" : "";
    article.innerHTML = `
      <div class="avatar">${label}</div>
      <div class="message-body">
        <div class="message-role">${message.role === "user" ? "User" : "Assistant"}</div>
        ${
          message.role === "assistant" && settings.thinking && (thinkingText || message.streaming)
            ? `<details class="thinking-block"${thinkingOpen} data-message-id="${message.id}">
                <summary class="thinking-title">Thinking</summary>
                <div class="thinking-content">${escapeHtml(thinkingText || "思考中...")}</div>
              </details>`
            : ""
        }
        <div class="message-content markdown-body">${contentHtml}</div>
        ${assistantStatus}
        ${feedbackControls}
      </div>
    `;
    els.messages.appendChild(article);
    const thinkingDetails = article.querySelector(".thinking-block");
    if (thinkingDetails) {
      thinkingDetails.addEventListener("toggle", () => {
        message.thinkingCollapsed = !thinkingDetails.open;
        saveState();
      });
    }
  }
  els.messages.scrollTop = els.messages.scrollHeight;
  renderInspector();
}

function renderMediaResults() {
  if (!els.mediaResults) return;
  const records = mediaHistory.slice(0, 8);
  if (!records.length) {
    els.mediaResults.innerHTML = `
      <div class="empty-state media-empty-state">
        <h2>${mediaState.tab === "image" ? "开始一次图片生成" : "开始一次视频生成"}</h2>
        <p>${mediaState.tab === "image" ? "直接输入描述即可文生图；添加参考图或沿用当前结果后会自动切换图生图或持续改图。" : "直接输入描述即可文生视频；添加首帧或关键帧后会自动切换图生视频或关键帧生视频。"}</p>
      </div>
    `;
    return;
  }
  els.mediaResults.innerHTML = records
    .filter((record) => record.type === mediaState.tab)
    .map((record) => {
      const outputs = (record.outputs || []).map((output) => renderMediaOutput(output)).join("");
      const fallback = outputs || `<pre>${escapeHtml(JSON.stringify(record.response || {}, null, 2))}</pre>`;
      return `
        <div class="media-thread-pair" data-media-id="${escapeHtml(record.id)}">
          <article class="message user media-message">
            <div class="avatar">你</div>
            <div class="message-body">
              <div class="message-role">User</div>
              <div class="message-content">${escapeHtml(record.prompt || "使用媒体输入继续生成")}</div>
            </div>
          </article>
          <article class="message assistant media-message">
            <div class="avatar">AI</div>
            <div class="message-body">
              <div class="message-role">Assistant</div>
              <div class="media-result-head">
                <strong>${record.type === "image" ? "生图" : "生视频"} · ${mediaModeLabel(record.mode)}</strong>
                <span>${new Date(record.createdAt).toLocaleString()}</span>
              </div>
              ${record.routeReason ? `<p class="media-route-reason">${escapeHtml(record.routeReason)}</p>` : ""}
              <div class="media-output-grid">${fallback}</div>
            </div>
          </article>
        </div>
      `;
    })
    .join("") || `
      <div class="empty-state media-empty-state">
        <h2>${mediaState.tab === "image" ? "开始一次图片生成" : "开始一次视频生成"}</h2>
        <p>${mediaState.tab === "image" ? "当前还没有图片结果。" : "当前还没有视频结果。"}</p>
      </div>
    `;
}

function mediaRecordSummary(record) {
  return `${record.type === "image" ? "生图" : "生视频"} · ${mediaModeLabel(record.mode)}`;
}

function renderMediaOutput(output) {
  const src = output.dataUrl || output.url || "";
  if (!src) return "";
  if (output.type === "video" || /\.(mp4|webm|mov)(\?|$)/i.test(src)) {
    return `
      <figure>
        <video class="media-output" src="${escapeHtml(src)}" controls></video>
      </figure>
    `;
  }
  return `
    <figure>
      <img class="media-output" src="${escapeHtml(src)}" alt="生成图片" />
      <button class="ghost-button use-image-as-source" type="button" data-image-src="${escapeHtml(src)}">继续改这张</button>
    </figure>
  `;
}

function mediaModeLabel(mode) {
  return (
    {
      "text-to-image": "文生图",
      "image-to-image": "图生图",
      "edit-image": "持续改图",
      "text-to-video": "文生视频",
      "image-to-video": "图生视频",
      "keyframes-to-video": "关键帧生视频",
    }[mode] || mode || "任务"
  );
}

function renderInspector() {
  const conversation = activeConversation();
  const tokenCount = roughTokens(conversationPayload(conversation));
  const limit = Number(settings.contextLimit || config.contextLimit);
  const ratio = Math.min(100, Math.round((tokenCount / Math.max(1, limit)) * 100));
  els.contextBar.style.width = `${ratio}%`;
  els.contextLabel.textContent = `${tokenCount} / ${limit}`;
  els.summaryBox.textContent = conversation.summary || "暂无压缩摘要";
  els.modelLabel.textContent = config.model;
  els.modelStatus.textContent = config.model;
  els.keyStatus.textContent = config.apiKey;
  els.streamState.textContent = settings.stream ? "流式输出已开启" : "非流式输出";
  els.thinkingToggle.checked = settings.thinking;
  els.streamToggle.checked = settings.stream;
  els.compressToggle.checked = settings.autoCompress;
  els.webSearchToggle.checked = Boolean(settings.webSearch && config.features?.webSearch);
  els.webSearchToggle.disabled = !config.features?.webSearch;
  els.webSearchStatus.textContent = config.features?.webSearch
    ? settings.webSearch
      ? "联网搜索会注入本轮提问"
      : "默认不联网"
    : "服务端未启用搜索";
  els.temperature.value = settings.temperature;
  els.maxTokens.value = settings.maxTokens;
  els.contextLimit.value = limit;
  els.tokenPanel.classList.toggle("hidden", !config.webTokenRequired);
  els.accessToken.value = localStorage.getItem(TOKEN_KEY) || "";
  els.imageSubmit.disabled = !config.features?.imageGeneration;
  els.videoSubmit.disabled = !config.features?.videoGeneration;
  if (!config.features?.imageGeneration && !config.features?.videoGeneration) {
    setMediaStatus("媒体接口未配置");
  }
  updateMediaRoutePreview();
  updateStreamingState();
}

function setSummaryStatus(text) {
  els.summaryBox.textContent = text;
}

function updateStreamingState() {
  const conversation = activeConversation();
  const streaming = activeRequests.has(conversation.id);
  els.stop.disabled = !streaming;
  els.send.disabled = streaming;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderMarkdown(value) {
  const lines = String(value || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let listItems = [];
  let listType = "";
  let codeLines = [];
  let codeLang = "";

  function flushParagraph() {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;
    const tag = listType === "ol" ? "ol" : "ul";
    blocks.push(`<${tag}>${listItems.map((item) => `<li>${renderInlineMarkdown(item)}</li>`).join("")}</${tag}>`);
    listItems = [];
    listType = "";
  }

  function flushCode() {
    const languageClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : "";
    const codeText = codeLines.join("\n");
    const encodedCode = encodeURIComponent(codeText);
    blocks.push(
      `<div class="code-block">
        <button type="button" class="copy-code-button" data-code="${encodedCode}" title="复制代码" aria-label="复制代码">复制</button>
        <pre><code${languageClass}>${escapeHtml(codeText)}</code></pre>
      </div>`
    );
    codeLines = [];
    codeLang = "";
  }

  let inCode = false;
  for (const rawLine of lines) {
    const codeFence = rawLine.match(/^```([\w-]*)\s*$/);
    if (codeFence) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        inCode = true;
        codeLang = codeFence[1] || "";
      }
      continue;
    }

    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }

    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const level = heading[1].length + 2;
      blocks.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      if (listType && listType !== "ul") flushList();
      listType = "ul";
      listItems.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      if (listType && listType !== "ol") flushList();
      listType = "ol";
      listItems.push(ordered[1]);
      continue;
    }

    paragraph.push(line);
  }

  if (inCode) flushCode();
  flushParagraph();
  flushList();
  return blocks.join("") || escapeHtml(value);
}

function renderInlineMarkdown(value) {
  let html = escapeHtml(value);
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label, url) => {
    const href = url.replace(/&amp;/g, "&").trim();
    if (!/^(https?:|mailto:)/i.test(href)) return label;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  return html;
}

async function copyCodeBlock(button) {
  const code = decodeURIComponent(button.dataset.code || "");
  if (!code) return;
  const original = button.textContent;
  try {
    await writeClipboardText(code);
    button.textContent = "已复制";
    button.classList.add("copied");
  } catch {
    button.textContent = "复制失败";
  } finally {
    button.disabled = true;
    window.setTimeout(() => {
      button.textContent = original || "复制";
      button.classList.remove("copied");
      button.disabled = false;
    }, 1200);
  }
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy")) {
      throw new Error("copy command failed");
    }
  } finally {
    textarea.remove();
  }
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, milliseconds / 1000);
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

async function loadConfig() {
  const response = await fetch("/api/config");
  config = { ...config, ...(await response.json()) };
  settings.contextLimit = settings.contextLimit || config.contextLimit;
  saveState();
}

function bindEvents() {
  document.querySelector("#new-chat").addEventListener("click", () => createConversation());
  document.querySelector("#delete-chat").addEventListener("click", () => deleteConversation());
  document.querySelector("#export-chat").addEventListener("click", () => exportConversation());
  document.querySelector("#clear-chat").addEventListener("click", () => {
    const conversation = activeConversation();
    if (!confirm("清空当前聊天消息？")) return;
    conversation.messages = [];
    conversation.summary = "";
    saveState();
    render();
  });
  document.querySelector("#rename-chat").addEventListener("click", () => {
    const conversation = activeConversation();
    const next = prompt("聊天名称", conversation.title);
    if (!next) return;
    conversation.title = next.trim().slice(0, 80) || conversation.title;
    saveState();
    render();
  });
  document.querySelector("#pin-chat").addEventListener("click", () => {
    const conversation = activeConversation();
    conversation.pinned = !conversation.pinned;
    saveState();
    render();
  });
  document.querySelector("#export-all").addEventListener("click", () => downloadJson("cz-ai-chat-history.json", conversations));
  document.querySelector("#clear-unpinned").addEventListener("click", () => {
    if (!confirm("清理所有未收藏聊天？")) return;
    conversations = conversations.filter((item) => item.pinned);
    activeId = conversations[0]?.id || "";
    if (!activeId) createConversation();
    saveState();
    render();
  });
  els.search.addEventListener("input", renderConversationList);
  els.composer.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = els.prompt.value;
    els.prompt.value = "";
    sendMessage(value);
  });
  els.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.composer.requestSubmit();
    }
  });
  els.messages.addEventListener("click", (event) => {
    const feedback = event.target.closest(".feedback-button");
    if (feedback) {
      setMessageFeedback(feedback.dataset.messageId, feedback.dataset.feedback);
      return;
    }
    const button = event.target.closest(".copy-code-button");
    if (button) copyCodeBlock(button);
  });
  els.studioModeButtons.forEach((button) => {
    button.addEventListener("click", () => setStudioMode(button.dataset.studioMode));
  });
  document.querySelectorAll(".media-tab").forEach((button) => {
    button.addEventListener("click", () => setMediaTab(button.dataset.mediaTab));
  });
  [els.imagePrompt, els.imageInput, els.imageUseLast, els.videoPrompt, els.videoImageInput, els.videoKeyframes].forEach((input) => {
    input.addEventListener("input", updateMediaRoutePreview);
    input.addEventListener("change", updateMediaRoutePreview);
  });
  els.imageForm.addEventListener("submit", submitImageGeneration);
  els.videoForm.addEventListener("submit", submitVideoGeneration);
  document.querySelector("#clear-media-results").addEventListener("click", () => {
    mediaHistory = [];
    mediaState.lastImage = "";
    saveMediaHistory();
    renderMediaResults();
    setMediaStatus("结果已清空");
  });
  els.mediaResults.addEventListener("click", (event) => {
    const button = event.target.closest(".use-image-as-source");
    if (!button) return;
    mediaState.lastImage = button.dataset.imageSrc || "";
    mediaState.tab = "image";
    setStudioMode("image");
    els.imageUseLast.checked = true;
    updateMediaRoutePreview();
    els.imagePrompt.focus();
    setMediaStatus("已选中上一张图");
  });
  els.stop.addEventListener("click", () => activeRequests.get(activeConversation().id)?.abort());
  document.querySelector("#manual-compress").addEventListener("click", () => compressConversation(true));
  els.thinkingToggle.addEventListener("change", () => updateSetting("thinking", els.thinkingToggle.checked));
  els.streamToggle.addEventListener("change", () => updateSetting("stream", els.streamToggle.checked));
  els.compressToggle.addEventListener("change", () => updateSetting("autoCompress", els.compressToggle.checked));
  els.webSearchToggle.addEventListener("change", () => updateSetting("webSearch", els.webSearchToggle.checked));
  els.temperature.addEventListener("change", () => updateSetting("temperature", Number(els.temperature.value)));
  els.maxTokens.addEventListener("change", () => updateSetting("maxTokens", Number(els.maxTokens.value)));
  els.contextLimit.addEventListener("change", () => updateSetting("contextLimit", Number(els.contextLimit.value)));
  document.querySelector("#save-token").addEventListener("click", async () => {
    const token = els.accessToken.value.trim();
    const response = await fetch("/api/token", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) {
      alert("令牌校验失败");
      return;
    }
    localStorage.setItem(TOKEN_KEY, token);
    alert("令牌已保存");
  });
}

function setStudioMode(mode) {
  mediaState.studioMode = ["chat", "image", "video"].includes(mode) ? mode : "chat";
  if (mediaState.studioMode === "image" || mediaState.studioMode === "video") {
    setMediaTab(mediaState.studioMode, { syncStudioMode: false });
  } else {
    renderMessages();
    renderInspector();
  }
  renderStudioMode();
}

function renderStudioMode() {
  const mode = mediaState.studioMode || "chat";
  els.appShell.dataset.studioMode = mode;
  els.studioModeButtons.forEach((button) => {
    button.classList.toggle("active", button.dataset.studioMode === mode);
  });

  if (mode === "image") {
    els.title.textContent = "按对话持续生成和修改图片";
    els.meta.textContent = "自动选择：文生图 / 图生图 / 持续改图";
    els.mediaEyebrow.textContent = "生图";
    els.mediaTitle.textContent = "按对话持续生成和修改图片";
  } else if (mode === "video") {
    els.title.textContent = "按对话持续生成和修改视频";
    els.meta.textContent = "自动选择：文生视频 / 图生视频 / 关键帧生视频";
    els.mediaEyebrow.textContent = "生视频";
    els.mediaTitle.textContent = "按对话持续生成和修改视频";
  }
}

function setMediaTab(tab, options = {}) {
  mediaState.tab = tab === "video" ? "video" : "image";
  if (options.syncStudioMode !== false) {
    mediaState.studioMode = mediaState.tab;
  }
  document.querySelectorAll(".media-tab").forEach((button) => {
    button.classList.toggle("active", button.dataset.mediaTab === mediaState.tab);
  });
  els.imageForm.classList.toggle("hidden", mediaState.tab !== "image");
  els.videoForm.classList.toggle("hidden", mediaState.tab !== "video");
  renderMediaResults();
  updateMediaRoutePreview();
  renderStudioMode();
}

function updateSetting(key, value) {
  settings[key] = value;
  saveState();
  renderInspector();
}

async function init() {
  if (!conversations.length) createConversation({ title: "新聊天" });
  bindEvents();
  await loadConfig();
  setMediaTab(mediaState.tab, { syncStudioMode: false });
  mediaState.studioMode = "chat";
  renderMediaResults();
  render();
}

init().catch((error) => {
  els.messages.innerHTML = `<div class="empty-state"><h2>启动失败</h2><p>${escapeHtml(error.message)}</p></div>`;
});
