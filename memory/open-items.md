# Open Items

## Security

- Configure `AI_CHAT_WEB_TOKEN` for the public `9999` UI, or restrict cloud
  security group/source IP access.
- Keep `9000/v1` bearer auth behavior intact. A no-token `401` is expected.
- Do not store live passwords, API keys, or FRP tokens in repository files.

## Product

- Integrate image generation and video generation services into `9999` only if
  those service endpoints and auth boundaries are confirmed.
- Consider showing a small time-source note in the UI, for example:
  `Based on AI host time: CST`.
- Consider passing browser timezone to the gateway if user-local time answers
  are needed.

## Search Reliability

- Search execution uses `https://cn.bing.com/search?q={query}` and HTML parsing
  after the LLM search planner decides that search is needed.
- The LLM planner chooses the search query. Do not reintroduce backend automatic
  query selection for normal chat turns unless the user explicitly asks for a
  deterministic fallback.
- For higher reliability, replace it with a paid JSON search API and set
  `AI_CHAT_WEB_SEARCH_URL` accordingly.
- Keep search result summaries bounded to avoid bloating the LLM prompt.

## Operations

- After changing `apps/ai-chat`, redeploy with
  `scripts/ai-stack/setup-ai-chat-web.sh --apply` on the AI host.
- The setup script intentionally restarts `ai-chat-web.service` after copying
  files so updated frontend assets are loaded.
- If public `9999` disappears, check in this order:
  - AI host `ai-chat-web.service`.
  - AI host listener `192.168.100.12:9999`.
  - Windows `frpc` log for `ai-chat-web-9999`.
  - ECS `frps` listener `*:9999`.
  - ECS security group/firewall.
