# 2026-06-25 AI Chat Public Gateway Session

## Scope

This session started as a request to expose AI host services through the public
cloud server and ended with a deployed browser AI chat UI on public port `9999`,
while preserving the OpenAI-compatible LLM API on public port `9000`.

Sensitive values used during the session are intentionally omitted. Passwords,
API keys, and FRP tokens are recorded only as `<redacted>`.

## Topology Confirmed

- Public ECS IP: `60.205.213.254`.
- ECS runs `frps`.
- Windows runs `frpc` and registers public proxy ports with ECS `frps`.
- AI host is reachable behind the Windows/FRP path at `192.168.100.12`.
- The public SSH path is:
  - external client -> `60.205.213.254:2222`
  - ECS `frps`
  - Windows `frpc`
  - Windows OpenSSH on `127.0.0.1:22222`
- `2222` is not a fixed ECS sshd port. It appears only when Windows `frpc`
  registers the proxy.

## Port Decisions

| Port | Role | Result |
| --- | --- | --- |
| `7000` | FRP control port on ECS | Kept as existing `frps` control port |
| `2222` | Public SSH proxy through FRP | Used for remote access |
| `2444` | Hermes Agent Platform web proxy | Preserved from existing work |
| `9000` | Public OpenAI-compatible LLM API | Preserved as API, not used as web UI |
| `9999` | Public AI Chat Web UI | Added and deployed |

The user changed the UI requirement from `9000` to `9999`, so the final design
keeps:

- `http://60.205.213.254:9000/v1` as API.
- `http://60.205.213.254:9999/` as browser AI Chat Web.

## Repository Work Added

### AI Chat Web Gateway

Created `apps/ai-chat/`:

- `apps/ai-chat/server.py`
  - Python stdlib web gateway.
  - Serves static UI on `9999`.
  - Proxies `/api/chat` to the internal Qwen service at
    `192.168.100.12:8000/v1/chat/completions`.
  - Keeps the real LLM API key server-side.
  - Supports streaming, context compression, optional UI access token, web
    search, current datetime context, and date/time question handling.
- `apps/ai-chat/public/index.html`
- `apps/ai-chat/public/styles.css`
- `apps/ai-chat/public/app.js`
  - Browser UI similar to ChatGPT/DeepSeek.
  - Local browser conversation history.
  - Conversation create/delete/rename/pin/export/clear.
  - Streaming output.
  - Thinking mode display.
  - Collapsible Thinking section.
  - Response duration display.
  - Markdown rendering for assistant output.
  - Context meter and manual/automatic compression.
  - Web search toggle.
- `apps/ai-chat/test/test_gateway.py`
  - Gateway and static UI contract tests.

### Deployment Scripts

Created or updated:

- `scripts/ai-stack/setup-ai-chat-web.sh`
  - Installs the web gateway to `/home/ubuntu/ai-stack/ai-chat-web`.
  - Writes `/etc/default/ai-chat-web`.
  - Writes `/etc/systemd/system/ai-chat-web.service`.
  - Enables and restarts `ai-chat-web.service`.
- `scripts/ai-stack/collect-ai-stack-status.sh`
  - Includes `ai-chat-web` and `192.168.100.12:9999/health`.
- `scripts/cloud/setup-frps.sh`
  - Allows `9999` in addition to existing ports.
- `scripts/cloud/check-frps-agent-platform.sh`
  - Checks `9999` listener/proxy evidence.
- `scripts/windows/setup-frpc.ps1`
  - Adds `ai-chat-web-9999` proxy:
    `60.205.213.254:9999 -> 192.168.100.12:9999`.

### Documentation Updated

Created or updated:

- `docs/ai-stack/ai-chat-web.md`
- `docs/ai-stack/current-deployment.md`
- `docs/ai-stack/runbook.md`
- `docs/operations/ports-and-autostart.md`
- `docs/frp/server-deployment-guide.md`
- `docs/frp/windows-client-deployment-guide.md`
- `README.md`
- `examples/frp/frps.example.toml`
- `examples/frp/frpc.example.toml`

## Remote Deployment Work

### AI Host

Deployed `ai-chat-web.service` on the AI host:

- Install directory: `/home/ubuntu/ai-stack/ai-chat-web`
- Environment file: `/etc/default/ai-chat-web`
- Systemd unit: `/etc/systemd/system/ai-chat-web.service`
- Listen address: `192.168.100.12:9999`
- Upstream LLM: `http://192.168.100.12:8000`
- Model: `qwen3.6-35b-a3b`

The gateway reads the LLM API key server-side from environment or the existing
LLM launcher. The browser does not receive the key.

### ECS `frps`

Updated `frps` allow ports to include `9999`.

Observed public listeners after `frpc` registration:

- `*:7000`
- `*:2222`
- `*:2444`
- `*:9000`
- `*:9999`

### Windows `frpc`

Updated Windows `frpc` config and restarted it so the public proxy
`ai-chat-web-9999` registers with ECS `frps`.

## API Key / Auth Notes

The public `9000` API remains OpenAI-compatible and requires bearer auth.

Observed behavior:

- `GET http://60.205.213.254:9000/health` returns `200`.
- `GET http://60.205.213.254:9000/v1/models` without auth returns `401`.

This is expected. Client calls to `9000/v1` need:

```text
Authorization: Bearer <redacted-api-key>
```

The `9999` web UI does not require the browser to know that LLM API key. The
server-side gateway injects it when calling the internal LLM service.

## UI / Gateway Improvements Completed

### Streaming Smoothness

Initial issue: streaming looked choppy because the browser rebuilt the full
message list on every SSE `data:` line.

Fix:

- Backend forwards SSE line-by-line and flushes each line.
- Frontend batches message rendering through `requestAnimationFrame`.

### Collapsible Thinking

Thinking output is rendered in a `details` block:

- Opens while streaming.
- Can be folded by the user.
- Stores folded state per message.

### Response Duration

Each assistant message records `elapsedMs` and displays completion time such as:

```text
完成 · 0.4s
```

### Markdown Rendering

Assistant output is rendered as formatted Markdown instead of raw source for:

- headings
- unordered and ordered lists
- inline code
- fenced code blocks
- links

The renderer escapes HTML before applying the supported Markdown transforms.

### Web Search

Added a per-request browser toggle:

- Default UI state: off.
- When enabled, the gateway first performs a small LLM planning call with
  thinking disabled. The planner decides whether search is needed and returns a
  JSON query plan. Only `should_search=true` plans cause the gateway to perform
  server-side web search and prepend a bounded search summary to the model
  request.
- The browser does not receive the configured search provider URL.

Provider behavior:

- Initial DuckDuckGo Instant Answer JSON timed out from the AI host.
- The default provider was changed to `https://cn.bing.com/search?q={query}`
  because the AI host could reach it.
- Gateway supports common JSON search APIs and Bing-style HTML result pages.
- Normal chat turns no longer rely on backend keyword cleanup to decide the
  search query. The model chooses the query through the planner. Backend query
  cleanup remains only as a utility/helper, not the primary search decision
  path.

Later issue reported by user:

```text
User: 今天有什么新闻
AI: searched calendar/lunar-calendar style results and reported no news.
```

Root cause:

- The gateway still decided the search query with backend heuristics.
- Current-date context and broad words such as `今天` could steer the provider
  toward date/calendar pages instead of news.

Fix:

- Added an LLM search planner before search execution.
- The planner is instructed to choose source-aware news queries for broad
  current news requests, for example `今日要闻 央视新闻 新华社 人民网`, because
  date-first queries on the current Bing HTML source tended to return calendar,
  year, and policy pages.
- If the planner says search is unnecessary, or if its JSON cannot be parsed,
  the gateway skips web search instead of guessing a backend query.

Later issue reported by user:

```text
User: 给我一点今天的热门财经新闻
AI: primary search results were irrelevant, such as Zhihu, QQ, or Baidu pages.
```

Root cause:

- The planner selected a finance-oriented query, but the default Bing China
  HTML search source sometimes returned unrelated portal, mail, Q&A, or app
  pages for English finance query terms.
- The relevance checker correctly marked those results irrelevant, but when it
  returned the same query, the gateway previously had no alternate provider and
  could either inject bad results or fail to provide usable current finance
  context.

Fix:

- Added `apps/ai-chat/debug_search.py`, installed on the AI host as
  `/home/ubuntu/ai-stack/ai-chat-web/debug_search.py`.
- The script prints planner output, primary results, relevance decision, retry
  query, fallback provider results, final query, and final results.
- Added RSS/Atom XML parsing for feed-style search providers.
- Added `AI_CHAT_WEB_SEARCH_FALLBACK_URLS`, defaulting to MarketWatch and WSJ
  Markets RSS feeds.
- If primary search and retry results are irrelevant, the gateway tries fallback
  providers and only injects results that pass relevance.
- If no provider yields relevant results, the gateway injects a short
  search-failure note instead of unrelated search results.

Later issue reported by user:

```text
User: 给我讲讲近期ai harness engineering
AI: showed a long Thinking block and explained that the search results were
generic AI tool/navigation pages, not directly about AI harness engineering.
```

Root cause:

- Search planning used non-thinking mode, but there was no search-result
  relevance gate, so generic or off-topic results could still be injected.
- A later mitigation forced final-answer thinking off for search-backed turns,
  which made the user lose Thinking mode whenever search was used.
- The browser also used one global request controller, so one generating chat
  blocked sending from another chat.

Fix:

- `prepare_upstream_payload` now delays thinking-mode calculation until after
  web-search planning and search-result injection.
- The search planner prompt now explicitly asks for quick judgment and caps the
  planner response at `max_tokens=96`.
- Added a non-thinking search-result relevance checker. If initial search
  results do not match the user request, the checker returns a better query and
  the gateway retries search once.
- Added specific query guidance for observed weak spots on Bing HTML search:
  international finance should include CNBC/Reuters/Bloomberg and market terms;
  multi-Agent project discovery should include concrete project names such as
  LangGraph, AutoGen, CrewAI, OpenAI Swarm, and GitHub.
- Final answer calls now respect the browser Thinking toggle after search. Only
  current date/time questions force final-answer thinking off.
- The frontend now tracks in-flight requests with an `activeRequests` map keyed
  by conversation id, so different conversations can generate at the same time.

### Current Date / Time Fix

Problem reported by user:

```text
User: 帮我搜索一下今天是周几
AI: produced a long Thinking section, searched the word "帮", and said it could
not know the current time.
```

Root causes:

- The gateway did not inject current server time.
- The search query cleaner did not strip `帮我搜索一下`.
- Date/time questions still ran web search when the toggle was on.
- `thinking=true` could cause Qwen to spend output on reasoning and return
  `content: null`.

Fix:

- Gateway now injects current server time as system context for all chat calls.
- Date/time questions are detected by markers such as `今天`, `现在`, `当前`,
  `周几`, `星期几`, `几号`, `日期`, and `时间`.
- Date/time questions skip web search even when the search toggle is enabled.
- Date/time questions force `chat_template_kwargs.enable_thinking = false`.

Verified public result:

```text
User: 帮我搜索一下今天是周几
AI: 今天是星期四。
```

With `thinking=true` and `web_search=true`, the result was still:

```text
CONTENT=今天是星期四。
REASONING_LEN=0
FINISH=stop
```

## Known Non-Goals / Not Yet Done

- Image generation and video generation services are not yet integrated into
  the `9999` UI.
- The `9999` UI is currently public unless `AI_CHAT_WEB_TOKEN` or cloud source
  IP restrictions are configured.
- Web search uses a lightweight HTML/JSON parser and should be replaced with a
  paid search API if high reliability is required.
- Date/time answers currently use the AI host service timezone, not browser
  local timezone.
