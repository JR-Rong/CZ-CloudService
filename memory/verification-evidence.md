# Verification Evidence

This file records representative evidence from the 2026-06-25 session. It is a
memory artifact, not a live health check.

## Public Endpoint Checks

Observed final results:

```text
9999_HEALTH=200
9000_HEALTH=200
9000_MODELS_NOAUTH=401
9999_HEALTH_BODY={"status":"ok","model":"qwen3.6-35b-a3b","apiKey":true}
9000_MODELS_BODY={"error":"Unauthorized"}
```

Interpretation:

- `9999` web gateway is reachable and has server-side API key access.
- `9000` LLM API health remains reachable.
- `9000/v1/models` still rejects unauthenticated requests.

After deploying the search planner change, the final public checks again showed:

```text
PUBLIC_9999=200
PUBLIC_9000=200
PUBLIC_9000_MODELS_NOAUTH=401
```

## AI Host Service Checks

Observed on the AI host:

```text
active
enabled
AI_HOST_9999=200
```

Observed listener:

```text
LISTEN 192.168.100.12:9999 users:(("python3",...))
```

## Public Chat Checks

Non-streaming `9999/api/chat` worked through the public endpoint.

Streaming `9999/api/chat` worked and produced final SSE marker:

```text
STREAM_DONE=yes
STREAM_CONTENT="content":"" "content":"流" "content":"式" "content":"正常" "content":""
```

## Web Search Checks

AI host reachability tests showed:

```text
https://cn.bing.com/search?q=qwen code=200
https://www.baidu.com/s?wd=qwen code=200
https://www.so.com/s?q=qwen code=200
https://www.sogou.com/web?query=qwen code=200
```

DuckDuckGo Instant Answer timed out from the AI host, so the default provider
was changed to Bing China HTML search.

Gateway parsing check on AI host:

```text
SEARCH_RESULTS= 5
qianwen.com https://www.qianwen.com
https://www.qianwen.com/
```

Query cleaning and context check:

```text
CLEAN_QUERY=Qwen 是什么
CTX_HAS_QWEN=true
```

Later search planner verification:

```text
PLAN={"should_search": true, "query": "今日要闻 央视新闻 新华社 人民网", "reason": "用户询问“今天有什么新闻”，属于实时新闻查询，需要联网获取最新信息。"}
RESULTS=5
TITLE=toutiao.com https://www.toutiao.com
TITLE=tophub.today https://tophub.today
TITLE=cctv.com https://news.cctv.com › china
```

Public non-streaming chat check for:

```text
今天有什么新闻
```

Observed:

```text
STATUS=200
ELAPSED=22.90s
REASONING_LEN=0
```

The answer summarized current hot topics from the search results and no longer
used calendar, lunar-calendar, or almanac results as the primary context.

Earlier quick planner and no-thinking mitigation check for:

```text
给我讲讲近期ai harness engineering
```

Observed planner-only check on the AI host:

```text
PLAN_ELAPSED=3.16s
PLAN={"should_search": true, "query": "AI harness engineering recent developments", "reason": "用户询问近期AI工程领域的具体概念，需联网获取最新信息。"}
```

Observed public chat check from that earlier mitigation with `thinking=true` and
`web_search=true`:

```text
STATUS=200
ELAPSED=28.97s
REASONING_LEN=0
```

Historical interpretation, later superseded:

- The search/no-search decision is made by a non-thinking planner first.
- That intermediate build forced final-answer `enable_thinking=false` for
  search-backed turns. This was later changed so final answers respect the
  browser Thinking toggle while planner and relevance checks remain
  non-thinking.

Later relevance, Thinking-toggle, and multi-chat verification:

Final upstream payload checks with `thinking=true` and `web_search=true`:

```text
QUESTION=给我讲讲今天热门国际财经新闻
THINKING={'enable_thinking': True}
搜索问题：CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg
HAS_SEARCH=True

QUESTION=给我讲讲当前比较热门的多 agent 编排项目
THINKING={'enable_thinking': True}
搜索问题：LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration
HAS_SEARCH=True
```

Public concurrent short-chat check:

```text
{"prompt": "用五个字回答：天空什么颜色", "status": 200, "elapsed": 0.39, "content": "通常是蓝色"}
{"prompt": "用五个字回答：一加一等于几", "status": 200, "elapsed": 1.16, "content": "等于二"}
TOTAL=1.17s
```

Public search-backed short-answer checks with `thinking=false`:

```text
QUESTION=给我讲讲今天热门国际财经新闻
STATUS=200
ELAPSED=32.24s
REASONING_LEN=0

QUESTION=给我讲讲当前比较热门的多 agent 编排项目
STATUS=200
ELAPSED=37.64s
REASONING_LEN=0
```

Public frontend script check showed per-conversation request tracking:

```text
const activeRequests = new Map();
if (!prompt || activeRequests.has(conversation.id)) return;
activeRequests.set(conversation.id, requestController);
activeRequests.delete(conversation.id);
```

## Search Debug Script and Finance Fallback

Later issue reported by user:

```text
User: 给我一点今天的热门财经新闻
AI: primary search results were irrelevant, such as Zhihu, QQ, or Baidu pages.
```

Local verification after adding `debug_search.py`, relevance failure handling,
RSS/Atom parsing, and fallback providers:

```text
python3 -m unittest apps/ai-chat/test/test_gateway.py
Ran 18 tests ... OK
python3 -m py_compile apps/ai-chat/server.py apps/ai-chat/debug_search.py
node --check apps/ai-chat/public/app.js
```

Deployed AI host checks:

```text
active
enabled
AI_HOST_9999=200
PUBLIC_9999=200
PUBLIC_9000=200
```

AI host debug script check:

```text
QUESTION=给我一点今天的热门财经新闻
INITIAL_RESULTS_COUNT=3
RELEVANCE={"relevant":false,... "reason":"结果全是QQ邮箱，与财经新闻无关。"}
FALLBACK_URL=https://www.marketwatch.com/rss/topstories
FALLBACK_RESULTS_COUNT=3
FALLBACK_RELEVANCE={"relevant":true,...}
FINAL_RESULTS_COUNT=3
```

Public chat check with `web_search=true`, `thinking=false`, `stream=false`:

```text
STATUS=200
REASONING_LEN=0
HAS_ZHIHU=False
HAS_QQ=False
HAS_MARKETWATCH_TOPIC=True
```

The returned answer summarized finance-market topics from fallback RSS results,
including SpaceX-related stocks, OPEC/oil, and S&P 500 support levels.

## Current Date / Weekday Fix

For:

```text
帮我搜索一下今天是周几
```

Observed final public result:

```text
今天是星期四。
```

With `thinking=true` and `web_search=true`, observed:

```text
CONTENT=今天是星期四。
REASONING_LEN=0
FINISH=stop
```

AI host gateway context showed:

```text
CLEAN_QUERY=今天是周几
IS_DATETIME=true
当前服务端时间：2026年06月25日 ...（星期四，时区 CST）。
```

## Browser UI QA

Local browser validation used bundled Playwright with system Chrome because the
in-app Browser timed out when opening local `127.0.0.1:19999`.

Validated UI behavior:

- Page title: `CZ AI Chat`
- Web search toggle can be enabled.
- Markdown heading rendered as an HTML heading.
- Markdown list rendered as list items.
- Inline code rendered as code.
- Fenced code block rendered as a code block.
- Raw triple backticks were not visible.
- Thinking section rendered as collapsible `details`.
- Completion status displayed a duration such as `完成 · 0.4s`.
- Console errors after favicon fix: none.

Screenshots were saved outside the repo during QA:

- `/tmp/cz-ai-chat-9999-optimized-desktop.png`
- `/tmp/cz-ai-chat-9999-optimized-mobile.png`

## Local Test Commands

Final local verification included:

```bash
python3 -m py_compile apps/ai-chat/server.py
python3 -m unittest apps/ai-chat/test/test_gateway.py
node --check apps/ai-chat/public/app.js
bash -n scripts/ai-stack/setup-ai-chat-web.sh scripts/ai-stack/collect-ai-stack-status.sh scripts/cloud/setup-frps.sh scripts/cloud/check-frps-agent-platform.sh
git diff --check
node --test apps/ui/test/script.test.js
npm test --prefix apps/ui
```

Observed test totals before the search planner change:

- `apps/ai-chat/test/test_gateway.py`: 10 tests passed.
- `apps/ui/test/script.test.js`: 17 tests passed.
- `npm test --prefix apps/ui`: 88 tests passed.

Observed test totals after the search planner/relevance/concurrency changes:

- `apps/ai-chat/test/test_gateway.py`: 14 tests passed after the
  relevance-retry, Thinking-toggle, and per-conversation request fixes.
