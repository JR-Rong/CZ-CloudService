const modeCopy = {
  chat: {
    eyebrow: "聊天",
    title: "和模型一起完成任务",
    context: "当前上下文：普通聊天",
  },
  image: {
    eyebrow: "生图",
    title: "按对话持续生成和修改图片",
    context: "当前上下文：图片 V2 · 沿用上一张结果继续修改",
  },
  video: {
    eyebrow: "生视频",
    title: "按对话持续生成和修改视频",
    context: "当前上下文：视频 V1 · 可追加首帧、参考图或关键帧",
  },
};

const modelInfo = {
  chat: [
    ["LLM", "qwen3.6", "用于需求判断、提示词整理和生成解释"],
    ["Search", "可开关", "需要联网时先由模型判断是否调用"],
  ],
  image: [
    ["Checkpoint", "sd_xl_base_1.0.safetensors", "当前 ComfyUI 图片端可见模型"],
    ["Sampler", "dpmpp_2m_sde / karras", "服务端默认采样设置"],
  ],
  video: [
    ["UNet", "wan2.2_ti2v_5B_fp16.safetensors", "当前 ComfyUI 视频端可见模型"],
    ["VAE", "wan2.2_vae.safetensors", "当前视频工作流 VAE"],
  ],
};

const settings = {
  chat: [
    ["模式", "流式聊天"],
    ["输出", "Markdown 渲染"],
    ["反馈", "赞 / 踩"],
    ["上下文", "自动压缩"],
  ],
  image: [
    ["类型", "持续改图"],
    ["尺寸", "832 x 1216"],
    ["构图", "head-to-toe"],
    ["Seed", "固定重试"],
  ],
  video: [
    ["类型", "图生视频"],
    ["帧数", "49"],
    ["FPS", "16"],
    ["关键帧", "首帧 + 尾帧"],
  ],
};

const advancedOptions = {
  chat: [
    ["联网搜索", "由模型判断"],
    ["思考内容", "折叠显示"],
    ["最大输出", "2048 tokens"],
    ["流式输出", "开启"],
  ],
  image: [
    ["模型", "自动选择可用 checkpoint"],
    ["尺寸", "832 x 1216"],
    ["Steps", "32"],
    ["CFG", "7.0"],
    ["Sampler", "DPM++ 2M SDE"],
    ["Scheduler", "Karras"],
    ["Seed", "固定或随机"],
    ["负向", "cropped, close-up, half body"],
    ["构图保护", "head-to-toe, feet visible"],
    ["参考强度", "0.55"],
  ],
  video: [
    ["模型", "自动选择 Wan2.2 工作流"],
    ["尺寸", "832 x 480"],
    ["帧数", "49"],
    ["FPS", "16"],
    ["Steps", "8"],
    ["CFG", "1.2"],
    ["Seed", "固定或随机"],
    ["运动强度", "中"],
    ["关键帧权重", "0.70"],
    ["稳定性", "减少闪烁/变形"],
  ],
};

const versions = {
  chat: [
    ["当前", "多 Agent 框架对比", "7 条消息"],
    ["昨天", "联网搜索判断策略", "12 条消息"],
  ],
  image: [
    ["V2", "拉远镜头，完整脚部入镜", "832 x 1216"],
    ["V1", "半身偏近，构图不满足", "1024 x 1024"],
  ],
  video: [
    ["V1", "8 秒产品短片，轻微运镜", "49 帧"],
    ["草稿", "只保留首帧和镜头方向", "未生成"],
  ],
};

const conversations = {
  chat: [
    {
      role: "user",
      text: "帮我判断当前多 Agent 编排项目怎么选。",
    },
    {
      role: "assistant",
      text: "可以先按控制粒度分：LangGraph 适合复杂状态机，AutoGen 适合多角色对话协作，CrewAI 适合声明式业务流程。需要实时信息时，我会先判断是否值得联网，再执行搜索。",
    },
  ],
  image: [
    {
      role: "user",
      text: "生成一张全身人物写真，站在干净的工作室里，现代科技感。",
    },
    {
      role: "assistant",
      text: "已生成第一版。当前模型更容易把人物裁成半身，我把下一版设置为竖构图并强化 head-to-toe。",
      asset: {
        kind: "image",
        title: "V1 · 人物写真草稿",
        detail: "人物细节可用，但镜头过近，脚部没有完整入镜。",
        tags: ["sd_xl_base_1.0", "1024 x 1024", "需要修图"],
      },
    },
    {
      role: "user",
      text: "镜头拉远，必须完整看到头到脚，脚不要被裁掉，背景保持简洁。",
    },
    {
      role: "assistant",
      text: "已沿用上一张继续修改。下一步如果要稳定全身照，建议接 OpenPose/Depth 或换更适合真人写真的 checkpoint。",
      asset: {
        kind: "image",
        title: "V2 · 全身构图版本",
        detail: "竖构图、远景、完整身体轮廓，作为后续继续修改的当前图。",
        tags: ["head-to-toe", "832 x 1216", "版本链"],
      },
    },
  ],
  video: [
    {
      role: "user",
      text: "用这张产品图生成一个 8 秒短视频，镜头从左向右慢慢推进。",
    },
    {
      role: "assistant",
      text: "已生成视频草稿。当前 5B 模型速度快，但细节稳定性有限，适合先看构图和运动方向。",
      asset: {
        kind: "video",
        title: "V1 · 产品短片草稿",
        detail: "轻微推进镜头，保留首帧产品轮廓；可继续指定关键帧修正运动。",
        tags: ["wan2.2 5B", "49 frames", "16 fps"],
      },
    },
    {
      role: "user",
      text: "保持产品不变形，尾帧更靠近一点，背景不要闪烁。",
    },
  ],
};

let activeMode = "image";
const modeState = {
  chat: {
    reference: false,
    current: false,
    keyframes: false,
  },
  image: {
    reference: false,
    current: true,
    keyframes: false,
  },
  video: {
    reference: true,
    current: false,
    keyframes: false,
  },
};

const nodes = {
  modeButtons: [...document.querySelectorAll("[data-mode]")],
  conversation: document.querySelector("#conversation"),
  title: document.querySelector("#thread-title"),
  eyebrow: document.querySelector("#mode-eyebrow"),
  context: document.querySelector("#composer-context"),
  routeBar: document.querySelector("#auto-route-bar"),
  referenceRow: document.querySelector("#reference-row"),
  composerAdvanced: document.querySelector("#composer-advanced"),
  prompt: document.querySelector("#prompt"),
  composer: document.querySelector("#composer"),
  attach: document.querySelector("#attach-reference"),
  reuse: document.querySelector("#reuse-current"),
  keyframes: document.querySelector("#add-keyframes"),
  assetPreview: document.querySelector("#asset-preview"),
  modelStack: document.querySelector("#model-stack"),
  settingGrid: document.querySelector("#setting-grid"),
  advancedGrid: document.querySelector("#advanced-grid"),
  versionList: document.querySelector("#version-list"),
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function render() {
  const copy = modeCopy[activeMode];
  const route = getRouteInfo();
  nodes.title.textContent = copy.title;
  nodes.eyebrow.textContent = copy.eyebrow;
  nodes.context.textContent = copy.context;
  nodes.prompt.placeholder = activeMode === "chat" ? "输入消息" : "输入生成需求或继续修改意见";
  nodes.keyframes.hidden = activeMode !== "video";
  nodes.attach.hidden = activeMode === "chat";
  nodes.reuse.hidden = activeMode === "chat";
  nodes.composer.dataset.mode = activeMode;
  nodes.composer.dataset.route = route.key;

  for (const button of nodes.modeButtons) {
    button.classList.toggle("active", button.dataset.mode === activeMode);
  }

  renderAutoRoute(route);
  renderReferenceRow();
  renderComposerAdvanced();
  renderConversation();
  renderInspector();
}

function getRouteInfo() {
  const state = modeState[activeMode];
  if (activeMode === "chat") {
    return {
      key: "chat",
      label: "普通聊天",
      reason: "不需要媒体输入，直接进入 LLM 对话。",
    };
  }
  if (activeMode === "image") {
    if (state.current) {
      return {
        key: "edit-image",
        label: "持续改图",
        reason: "检测到当前图片，会把上一张结果作为输入继续修改。",
      };
    }
    if (state.reference) {
      return {
        key: "image-to-image",
        label: "图生图",
        reason: "检测到参考图，会以参考图作为视觉约束生成新图。",
      };
    }
    return {
      key: "text-to-image",
      label: "文生图",
      reason: "没有参考图或当前结果，会从文字直接生成图片。",
    };
  }
  if (state.keyframes) {
    return {
      key: "keyframes-to-video",
      label: "关键帧生视频",
      reason: "检测到关键帧，会优先走关键帧视频工作流。",
    };
  }
  if (state.current || state.reference) {
    return {
      key: "image-to-video",
      label: "图生视频",
      reason: "检测到首帧或参考图，会把图片作为视频起点。",
    };
  }
  return {
    key: "text-to-video",
    label: "文生视频",
    reason: "没有图片输入，会从文字直接生成视频。",
  };
}

function renderAutoRoute(route) {
  nodes.routeBar.innerHTML = `
    <div>
      <span class="route-label">自动选择</span>
      <strong>${escapeHtml(route.label)}</strong>
    </div>
    <span>${escapeHtml(route.reason)}</span>
  `;
}

function renderReferenceRow() {
  const state = modeState[activeMode];
  if (activeMode === "chat") {
    nodes.referenceRow.innerHTML = "";
    return;
  }
  const chips = [];
  if (state.current) chips.push(["current", activeMode === "video" ? "当前视频" : "当前图片"]);
  if (state.reference) chips.push(["reference", activeMode === "video" ? "首帧/参考图" : "参考图"]);
  if (state.keyframes) chips.push(["keyframes", "关键帧"]);
  nodes.referenceRow.innerHTML = chips.length
    ? chips.map(([key, label]) => `<button class="reference-chip" type="button" data-clear="${key}">${escapeHtml(label)} <span>×</span></button>`).join("")
    : '<span class="reference-empty">未添加媒体输入，将从文字开始生成</span>';
}

function renderComposerAdvanced() {
  nodes.composerAdvanced.innerHTML = `
    <div class="composer-advanced-title">高级选项</div>
    <div class="composer-advanced-grid">
      ${advancedOptions[activeMode]
        .map(([label, value]) => `
          <label class="advanced-item compact">
            <span>${escapeHtml(label)}</span>
            <input value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" />
          </label>
        `)
        .join("")}
    </div>
  `;
}

function renderConversation() {
  nodes.conversation.innerHTML = conversations[activeMode]
    .map((item) => {
      const avatar = `<div class="avatar">${item.role === "user" ? "你" : "AI"}</div>`;
      const asset = item.asset ? renderAsset(item.asset) : "";
      const body = `
        <article class="message">
          <div class="message-text">${escapeHtml(item.text)}</div>
          ${asset}
          ${item.role === "assistant" ? renderToolbar(item.asset?.kind || activeMode) : ""}
        </article>
      `;
      return item.role === "user"
        ? `<div class="message-row user">${body}${avatar}</div>`
        : `<div class="message-row">${avatar}${body}</div>`;
    })
    .join("");
}

function renderAsset(asset) {
  const tags = asset.tags
    .map((tag, index) => `<span class="tag ${index === 0 ? "blue" : index === 2 ? "amber" : ""}">${escapeHtml(tag)}</span>`)
    .join("");
  return `
    <div class="asset-card">
      ${renderFrame(asset.kind)}
      <div class="asset-copy">
        <h2 class="asset-title">${escapeHtml(asset.title)}</h2>
        <p>${escapeHtml(asset.detail)}</p>
        <div class="tag-row">${tags}</div>
      </div>
    </div>
  `;
}

function renderFrame(kind) {
  const play = kind === "video" ? '<span class="play-mark" aria-hidden="true"></span>' : "";
  return `<div class="media-frame ${kind}" aria-label="${kind === "video" ? "视频预览" : "图片预览"}">${play}</div>`;
}

function renderToolbar(kind) {
  const primaryLabel = kind === "video" ? "继续修视频" : kind === "image" ? "继续修图" : "继续追问";
  return `
    <div class="message-toolbar">
      <button class="asset-action active" type="button" data-action="reuse">${primaryLabel}</button>
      <button class="asset-action" type="button" data-action="reference">作为参考</button>
      <button class="asset-action" type="button" data-action="download">下载</button>
    </div>
  `;
}

function renderInspector() {
  const previewKind = activeMode === "video" ? "video" : "image";
  const route = getRouteInfo();
  nodes.assetPreview.innerHTML = activeMode === "chat"
    ? `<div class="media-frame image" aria-label="聊天上下文预览"></div>`
    : renderFrame(previewKind);

  nodes.modelStack.innerHTML = modelInfo[activeMode]
    .map(([label, value, note]) => `
      <div class="model-chip">
        <strong>${escapeHtml(label)} · ${escapeHtml(value)}</strong>
        <span>${escapeHtml(note)}</span>
      </div>
    `)
    .join("");

  nodes.settingGrid.innerHTML = [["自动类型", route.label], ...settings[activeMode]]
    .map(([label, value]) => `
      <div class="setting-item">
        <div class="setting-label">${escapeHtml(label)}</div>
        <div class="setting-value">${escapeHtml(value)}</div>
      </div>
    `)
    .join("");

  nodes.advancedGrid.innerHTML = advancedOptions[activeMode]
    .map(([label, value]) => `
      <label class="advanced-item">
        <span>${escapeHtml(label)}</span>
        <input value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}" />
      </label>
    `)
    .join("");

  nodes.versionList.innerHTML = versions[activeMode]
    .map(([label, title, meta], index) => `
      <button class="version-item ${index === 0 ? "active" : ""}" type="button">
        <strong>${escapeHtml(label)} · ${escapeHtml(title)}</strong>
        <span class="version-meta">${escapeHtml(meta)}</span>
      </button>
    `)
    .join("");
}

function setMode(mode) {
  activeMode = mode;
  render();
}

function appendMockReply(text) {
  const route = getRouteInfo();
  conversations[activeMode].push({ role: "user", text });
  if (activeMode === "image") {
    conversations.image.push({
      role: "assistant",
      text: `已自动选择「${route.label}」，并生成一个新版本，版本链会保留上一张结果。`,
      asset: {
        kind: "image",
        title: `V3 · ${route.label}更新`,
        detail: "沿用人物身份、姿态和背景，只调整本轮描述的局部要求。",
        tags: [route.label, "高级参数已应用", "可回退"],
      },
    });
  } else if (activeMode === "video") {
    conversations.video.push({
      role: "assistant",
      text: `已自动选择「${route.label}」，并基于当前上下文生成下一版。`,
      asset: {
        kind: "video",
        title: `V2 · ${route.label}修正版`,
        detail: "保留首帧构图，收束镜头运动，减少背景闪烁。",
        tags: [route.label, "高级参数已应用", "版本链"],
      },
    });
  } else {
    conversations.chat.push({
      role: "assistant",
      text: "收到。我会先判断是否需要调用工具，再把结论直接放到回答里。",
    });
  }
  nodes.prompt.value = "";
  render();
  nodes.conversation.scrollTop = nodes.conversation.scrollHeight;
}

nodes.modeButtons.forEach((button) => {
  button.addEventListener("click", () => setMode(button.dataset.mode));
});

nodes.conversation.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]");
  if (!action) return;
  if (action.dataset.action === "reuse") {
    modeState[activeMode].current = true;
    nodes.prompt.value = activeMode === "video"
      ? "基于当前视频继续修改："
      : activeMode === "image"
        ? "基于当前图片继续修改："
        : "继续：";
    render();
    nodes.prompt.focus();
  }
});

nodes.attach.addEventListener("click", () => {
  modeState[activeMode].reference = true;
  nodes.prompt.value = `${nodes.prompt.value} 添加一张参考图，保持主体一致。`.trim();
  render();
  nodes.prompt.focus();
});

nodes.reuse.addEventListener("click", () => {
  modeState[activeMode].current = true;
  nodes.prompt.value = `${nodes.prompt.value} 沿用当前结果继续修改。`.trim();
  render();
  nodes.prompt.focus();
});

nodes.keyframes.addEventListener("click", () => {
  modeState.video.keyframes = true;
  modeState.video.reference = true;
  nodes.prompt.value = `${nodes.prompt.value} 添加首帧和尾帧，按关键帧控制运动。`.trim();
  render();
  nodes.prompt.focus();
});

nodes.referenceRow.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-clear]");
  if (!chip) return;
  modeState[activeMode][chip.dataset.clear] = false;
  render();
});

nodes.composer.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = nodes.prompt.value.trim();
  if (!text) return;
  appendMockReply(text);
});

render();
