# Current State

Last updated from the 2026-06-25 operator session.

## Public Endpoints

| Public URL | Current purpose | Expected result |
| --- | --- | --- |
| `http://60.205.213.254:9000/health` | LLM API health | HTTP `200` |
| `http://60.205.213.254:9000/v1` | OpenAI-compatible Qwen API | Requires bearer token |
| `http://60.205.213.254:9000/v1/models` | API model listing | HTTP `401` without token |
| `http://60.205.213.254:9999/` | AI Chat Web UI | Browser app loads |
| `http://60.205.213.254:9999/health` | AI Chat Web health | HTTP `200` |

## Internal AI Host Services

| Internal address | Service | Notes |
| --- | --- | --- |
| `192.168.100.12:8000` | Qwen3.6 LLM service | Upstream for web gateway and public `9000` |
| `192.168.100.12:9999` | `ai-chat-web.service` | Browser UI and server-side gateway |

## Systemd Unit

`ai-chat-web.service`:

- Install dir: `/home/ubuntu/ai-stack/ai-chat-web`
- Env file: `/etc/default/ai-chat-web`
- Unit file: `/etc/systemd/system/ai-chat-web.service`
- User/group: `ubuntu:ubuntu`
- Default host: `192.168.100.12`
- Default port: `9999`
- Default upstream: `http://192.168.100.12:8000`
- Default model: `qwen3.6-35b-a3b`

## FRP Proxy Chain

```text
browser -> 60.205.213.254:9999
  -> ECS frps
  -> Windows frpc proxy ai-chat-web-9999
  -> 192.168.100.12:9999 ai-chat-web.service
  -> 192.168.100.12:8000/v1/chat/completions
```

Current managed public proxy ports:

- `2222`: SSH path through Windows.
- `2444`: Hermes Agent Platform web path.
- `9000`: public LLM API path.
- `9999`: public AI Chat Web path.

## Important Runtime Behavior

- `9000` remains the API surface and requires bearer auth.
- `9999` is a web gateway. It hides the LLM API key from the browser.
- `9999` can call the LLM with server-side auth.
- `9999` has optional UI token protection through `AI_CHAT_WEB_TOKEN`.
- Web search is controlled by a UI toggle and by server env:
  - `AI_CHAT_WEB_SEARCH_ENABLED`
  - `AI_CHAT_WEB_SEARCH_URL`
  - `AI_CHAT_WEB_SEARCH_FALLBACK_URLS`
  - `AI_CHAT_WEB_SEARCH_MAX_RESULTS`
  - `AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS`
- Default search URL is currently:
  - `https://cn.bing.com/search?q={query}`
- Default fallback search URLs are currently:
  - `https://www.marketwatch.com/rss/topstories`
  - `https://feeds.a.dj.com/rss/RSSMarketsMain.xml`
- When the UI toggle enables search, the gateway first asks the LLM to decide
  whether search is needed and what query to use. It expects planner JSON with
  `should_search`, `query`, and `reason`, then searches only if
  `should_search=true`.
- The planner call is non-streaming, forces `enable_thinking=false`, and uses a
  small `max_tokens=96` response budget for quick search/no-search judgment.
- After fetching results, the gateway runs a non-thinking relevance check. If
  the results do not match the user request, it retries search once with the
  checker-suggested query.
- If the primary search and retry results are still irrelevant, the gateway
  tries fallback RSS/Atom providers. If those also fail relevance, it injects a
  search-failure note instead of bad search results.
- Search debugging can be run from the AI host:
  - `cd /home/ubuntu/ai-stack/ai-chat-web`
  - `python3 debug_search.py "给我一点今天的热门财经新闻"`
- The final answer call respects the browser Thinking toggle after search. Only
  current date/time questions force final-answer thinking off.
- Browser requests are tracked per conversation, so one generating chat should
  not block sending a message from another chat.
- Current date/time questions still bypass web search and use the server-side
  clock context directly.

## Security Notes

- Do not commit live passwords, API keys, or FRP tokens.
- Public `9999` should ideally be protected by `AI_CHAT_WEB_TOKEN` or source IP
  allowlisting.
- `9000/v1` returning `401` without token is expected and should be preserved.
