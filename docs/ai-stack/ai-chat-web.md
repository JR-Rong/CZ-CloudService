# AI Chat Web Gateway

The AI Chat Web gateway provides the browser UI on public port `9999`.
It does not replace the public LLM API on port `9000`.

## Public Endpoints

| URL | Purpose |
| --- | --- |
| `http://60.205.213.254:9000/v1` | OpenAI-compatible Qwen3.6 API |
| `http://60.205.213.254:9999/` | Browser chat UI |

## Runtime Topology

```text
browser -> ECS:9999 -> frps -> Windows frpc -> 192.168.100.12:9999 ai-chat-web
ai-chat-web -> 192.168.100.12:8000/v1/chat/completions
```

The web gateway reads the real LLM API key server-side. The browser sends chat
messages to `/api/chat`; it does not receive the LLM API key.

## Browser Features

- Streaming output is proxied line-by-line by the gateway and rendered in the
  browser on animation frames, so token bursts do not rebuild the whole message
  list for every SSE line.
- Assistant Markdown is rendered as formatted HTML for headings, lists, links,
  inline code, and fenced code blocks.
- Thinking output is shown in a collapsible `Thinking` section. It opens while
  a response is generating and can be folded by the user.
- Each assistant response stores and displays total generation time after the
  request finishes.
- Multiple conversations can have requests in flight at the same time. The stop
  button and send-disabled state are scoped to the currently selected
  conversation, not to the whole browser app.
- Web search is controlled per request from the browser toggle. The toggle is
  off by default; when enabled, the gateway first asks the LLM to decide
  whether search is needed and what query to use. Only then does it search
  server-side and prepend a bounded search summary to the model request.
- Search planning and search-result relevance checking are always non-streaming
  and non-thinking. The final answer call still respects the browser Thinking
  toggle, except for current date/time questions that intentionally force
  thinking off.

## Media Generation Defaults

The browser gateway defaults to higher-quality ComfyUI workflows:

| Media | Default profile | Primary model files |
| --- | --- | --- |
| Image | SDXL checkpoint workflow | `checkpoints/Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors` |
| Video | Wan2.2 14B Lightx2v | `diffusion_models/wan2.2_t2v_*_14B_fp8_scaled.safetensors`, `diffusion_models/wan2.2_i2v_*_14B_fp8_scaled.safetensors`, `loras/wan2.2_*lightx2v*.safetensors`, `vae/wan_2.1_vae.safetensors` |

The old lightweight defaults remain supported as explicit overrides:

```bash
AI_CHAT_IMAGE_CHECKPOINT=sd_xl_base_1.0.safetensors \
AI_CHAT_VIDEO_MODEL_PROFILE=wan22-5b-ti2v \
  sudo -E bash scripts/ai-stack/setup-ai-chat-web.sh --apply
```

The 14B video workflow is slower and uses more VRAM than the 5B TI2V workflow.
Keep default video dimensions modest for smoke tests, then raise width, height,
length, and steps for final renders. The install script defaults media requests
to an `AI_CHAT_MEDIA_TIMEOUT_SECONDS` value of `1800` for the 14B workflow.

## Install on the AI Host

Run from a checkout that contains `apps/ai-chat`:

```bash
sudo bash scripts/ai-stack/setup-ai-chat-web.sh --apply
```

Optional UI access token:

```bash
AI_CHAT_WEB_TOKEN="<runtime-ui-token>" \
  sudo -E bash scripts/ai-stack/setup-ai-chat-web.sh --apply
```

Optional web search overrides:

```bash
AI_CHAT_WEB_SEARCH_ENABLED=1 \
AI_CHAT_WEB_SEARCH_URL='https://cn.bing.com/search?q={query}' \
AI_CHAT_WEB_SEARCH_FALLBACK_URLS='https://www.marketwatch.com/rss/topstories,https://feeds.a.dj.com/rss/RSSMarketsMain.xml' \
AI_CHAT_WEB_SEARCH_MAX_RESULTS=5 \
  sudo -E bash scripts/ai-stack/setup-ai-chat-web.sh --apply
```

Set `AI_CHAT_WEB_SEARCH_ENABLED=0` to hide/disable the browser search toggle.
`AI_CHAT_WEB_SEARCH_URL` must include `{query}` when using a template URL. The
default provider is Bing China HTML search because it is reachable from the AI
host. The gateway can parse common JSON search APIs and Bing-style HTML result
pages, plus RSS/Atom XML feeds, but it is not a replacement for a paid full
web-search API.

`AI_CHAT_WEB_SEARCH_FALLBACK_URLS` is a comma- or newline-separated list. The
default fallback list uses MarketWatch and WSJ Markets RSS feeds. They are only
tried after the primary search results fail the relevance check.

The gateway does not derive normal search queries from backend keyword rules.
It performs a small non-streaming LLM planning call with thinking disabled and
expects a short JSON response within a 96-token cap, such as:

```json
{"should_search":true,"query":"今日要闻 央视新闻 新华社 人民网","reason":"needs current news"}
```

If the planner says search is unnecessary, or if the planner response cannot be
parsed, the gateway skips web search for that turn.

After fetching results, the gateway runs a second small non-thinking relevance
check. If the results do not match the user request, the checker returns a
better query and the gateway retries search once before building the final
answer context.

If the relevance checker still says the results are unrelated, the gateway does
not prepend those bad results to the final model call. Instead, it prepends a
short failure note telling the model that search was attempted but could not
confirm the requested real-time content.

## Search Debug Script

Use the debug script when a search-backed answer looks wrong. It calls the same
planner, search fetcher, relevance checker, and one-retry path as the web
gateway, but prints the intermediate decisions instead of asking the model for
the final answer.

Local checkout:

```bash
python3 apps/ai-chat/debug_search.py "给我一点今天的热门财经新闻"
```

AI host after install:

```bash
cd /home/ubuntu/ai-stack/ai-chat-web
python3 debug_search.py "给我一点今天的热门财经新闻"
```

JSON output for scripts:

```bash
python3 debug_search.py --json "给我讲讲今天热门国际财经新闻"
```

The key fields are:

- `PLAN`: whether the LLM planner chose to search and which query it picked.
- `INITIAL_QUERY` / `INITIAL_RESULTS`: the first provider request and results.
- `RELEVANCE`: whether the first results are usable for the user question.
- `RETRY_QUERY` / `RETRY_RESULTS`: the one retry suggested by the relevance
  checker, if the first results drifted.
- `FALLBACK_URL` / `FALLBACK_RESULTS`: the fallback provider used after primary
  search and retry results fail relevance.
- `FAILURE`: why no search results will be injected, if relevance failed.
- `FINAL_QUERY` / `FINAL_RESULTS`: the results that would be prepended to the
  final model call.

Planner and relevance-checker prompts include domain-specific query guidance
for cases that were observed to drift on Bing HTML search:

- International finance: `CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg`
- Multi-agent projects: `LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration`

The script installs:

- `/home/ubuntu/ai-stack/ai-chat-web/server.py`
- `/home/ubuntu/ai-stack/ai-chat-web/debug_search.py`
- `/home/ubuntu/ai-stack/ai-chat-web/public/`
- `/etc/default/ai-chat-web`
- `/etc/systemd/system/ai-chat-web.service`

## FRP Exposure

Cloud `frps` must allow `9999/tcp`:

```bash
FRPS_AUTH_TOKEN="<runtime-token>" \
  bash scripts/cloud/setup-frps.sh --allow-ports 2222,2444,9000,9999 --apply
```

Windows `frpc.toml` must include:

```toml
[[proxies]]
name = "ai-chat-web-9999"
type = "tcp"
localIP = "192.168.100.12"
localPort = 9999
remotePort = 9999
```

## Verification

AI host:

```bash
systemctl is-active ai-chat-web.service
curl -i http://192.168.100.12:9999/health
```

ECS:

```bash
ss -tlnp | grep -E '(:7000|:2222|:9000|:9999)([[:space:]]|$)'
```

External:

```bash
curl -i http://60.205.213.254:9000/health
curl -i http://60.205.213.254:9999/health
```

`9000` should continue to return the LLM API health check. `9999` should return
the AI Chat Web health check and serve the chat UI at `/`.

Search smoke check from the AI host:

```bash
curl -sS 'https://cn.bing.com/search?q=qwen' | head -c 200
```

The normal browser check is to open `http://60.205.213.254:9999/`, enable
`联网搜索`, ask a current-events style question, and confirm the request still
streams and completes with a displayed duration.
