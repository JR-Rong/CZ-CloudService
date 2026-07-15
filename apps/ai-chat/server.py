#!/usr/bin/env python3
import argparse
import base64
import html
import json
import os
import pathlib
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import xml.etree.ElementTree as ElementTree
from dataclasses import dataclass
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from http import cookies


APP_DIR = pathlib.Path(__file__).resolve().parent
PUBLIC_DIR = APP_DIR / "public"
DEFAULT_WEB_SEARCH_URL = "https://cn.bing.com/search?q={query}"
DEFAULT_WEB_SEARCH_FALLBACK_URLS = (
    "https://www.marketwatch.com/rss/topstories,"
    "https://feeds.a.dj.com/rss/RSSMarketsMain.xml"
)
WEB_SEARCH_PLANNER_PROMPT = (
    "你是联网搜索规划器。你的唯一任务是快速判断本轮用户请求是否需要联网搜索，并给出要搜索的关键词。"
    "只输出一个 JSON 对象，不要输出 Markdown、解释或正式回答。"
    'JSON 格式必须是：{"should_search":true|false,"query":"...","reason":"..."}。'
    "reason 必须少于 20 个汉字或 12 个英文单词。"
    "规则："
    "1. 用户询问实时新闻、最新信息、网页内容、价格、天气、政策、版本、赛程或需要外部事实核验的信息时，should_search=true。"
    "2. 普通聊天、翻译、写作、计算、代码解释、常识问题或能直接用已有上下文回答的问题，should_search=false。"
    "3. 用户询问今天、现在、当前日期、星期几、周几、几号或当前时间时，应使用服务端时间，不要搜索，should_search=false。"
    "4. query 必须表达用户真实信息需求，去掉“帮我搜索”“请联网”等指令词。"
    "5. 对“今天有什么新闻”这类宽泛新闻请求，query 应使用新闻源导向词，例如“今日要闻 央视新闻 新华社 人民网”。"
    "不要搜索日历、农历或老黄历；除非用户明确要求某一天的历史新闻，否则不要把完整日期放在查询词最前面。"
    "6. 对“财经新闻/热门财经/热门财经新闻/国际财经新闻/全球市场/财经热点”请求，query 必须包含具体财经新闻源和市场词，"
    "例如“CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg”，不要只用 international、global、finance 这类泛词。"
    "7. 对热门开源项目、框架、库或多 Agent 编排请求，query 必须包含具体项目名和 GitHub/docs 发现词，"
    "例如“LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration”，不要以 multi、热门、项目 这类泛词开头。"
)
WEB_SEARCH_RELEVANCE_PROMPT = (
    "你是联网搜索结果相关性检查器。你的唯一任务是快速判断搜索结果是否足以回答用户问题。"
    "只输出一个 JSON 对象，不要输出 Markdown、解释或正式回答。"
    'JSON 格式必须是：{"relevant":true|false,"query":"...","reason":"..."}。'
    "如果结果不贴题，relevant=false，并在 query 中给出更准确的二次搜索词。"
    "reason 必须少于 20 个汉字或 12 个英文单词。"
    "针对财经新闻、热门财经新闻或国际财经新闻，优先建议“CNBC markets latest financial news stocks oil dollar today Reuters Bloomberg”，"
    "不要只用 international、global、finance 这类泛词。"
    "如果结果主要是知乎、论坛、下载、游戏、日历或老黄历等无关内容，relevant=false。"
    "针对热门开源项目、框架、库或技术趋势，优先建议“LangGraph AutoGen CrewAI OpenAI Swarm GitHub latest orchestration”，"
    "不要以 multi、热门、项目 这类泛词开头。"
)


MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


@dataclass
class Config:
    host: str
    port: int
    llm_base_url: str
    model: str
    api_key: str
    web_token: str
    context_limit: int
    public_dir: pathlib.Path
    web_search_enabled: bool
    web_search_url: str
    web_search_fallback_urls: list
    web_search_max_results: int
    web_search_timeout_seconds: float
    image_generation_url: str
    image_generation_backend: str
    image_checkpoint: str
    image_sampler: str
    image_scheduler: str
    video_generation_url: str
    video_generation_backend: str
    video_model_profile: str
    media_api_key: str
    media_timeout_seconds: float
    media_body_limit: int
    now_iso: str


def truthy(value):
    return str(value or "").strip().lower() in {"1", "true", "yes", "on"}


def parse_url_list(value):
    return [item.strip() for item in re.split(r"[\n,]+", str(value or "")) if item.strip()]


def extract_api_key(run_llm_path):
    path = pathlib.Path(run_llm_path)
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="ignore")
    match = re.search(r"--api-key\s+([^\\\s]+)", text)
    return match.group(1) if match else ""


def build_config(env=None):
    source = env if env is not None else os.environ
    run_llm = source.get("AI_CHAT_RUN_LLM", "/home/ubuntu/ai-stack/bin/run-llm.sh")
    api_key = source.get("AI_CHAT_API_KEY") or source.get("AI_API_KEY") or extract_api_key(run_llm)
    base_url = source.get("AI_CHAT_LLM_BASE_URL", "http://192.168.100.12:8000").rstrip("/")
    if base_url.endswith("/v1"):
        base_url = base_url[:-3]
    return Config(
        host=source.get("AI_CHAT_HOST", "0.0.0.0"),
        port=int(source.get("AI_CHAT_PORT", "9999")),
        llm_base_url=base_url,
        model=source.get("AI_CHAT_MODEL", "qwen3.6-35b-a3b"),
        api_key=api_key,
        web_token=source.get("AI_CHAT_WEB_TOKEN", ""),
        context_limit=int(source.get("AI_CHAT_CONTEXT_LIMIT", "120000")),
        public_dir=pathlib.Path(source.get("AI_CHAT_PUBLIC_DIR", str(PUBLIC_DIR))).resolve(),
        web_search_enabled=truthy(source.get("AI_CHAT_WEB_SEARCH_ENABLED", "1")),
        web_search_url=source.get("AI_CHAT_WEB_SEARCH_URL", DEFAULT_WEB_SEARCH_URL).strip(),
        web_search_fallback_urls=parse_url_list(
            source.get("AI_CHAT_WEB_SEARCH_FALLBACK_URLS", DEFAULT_WEB_SEARCH_FALLBACK_URLS)
        ),
        web_search_max_results=int(source.get("AI_CHAT_WEB_SEARCH_MAX_RESULTS", "5")),
        web_search_timeout_seconds=float(source.get("AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS", "8")),
        image_generation_url=source.get("AI_CHAT_IMAGE_GENERATION_URL", "").strip(),
        image_generation_backend=source.get("AI_CHAT_IMAGE_GENERATION_BACKEND", "").strip().lower(),
        image_checkpoint=source.get("AI_CHAT_IMAGE_CHECKPOINT", "Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors").strip(),
        image_sampler=source.get("AI_CHAT_IMAGE_SAMPLER", "dpmpp_2m_sde").strip(),
        image_scheduler=source.get("AI_CHAT_IMAGE_SCHEDULER", "karras").strip(),
        video_generation_url=source.get("AI_CHAT_VIDEO_GENERATION_URL", "").strip(),
        video_generation_backend=source.get("AI_CHAT_VIDEO_GENERATION_BACKEND", "").strip().lower(),
        video_model_profile=source.get("AI_CHAT_VIDEO_MODEL_PROFILE", "wan22-14b-lightx2v").strip().lower(),
        media_api_key=source.get("AI_CHAT_MEDIA_API_KEY", "").strip(),
        media_timeout_seconds=float(source.get("AI_CHAT_MEDIA_TIMEOUT_SECONDS", "600")),
        media_body_limit=int(source.get("AI_CHAT_MEDIA_BODY_LIMIT", "30000000")),
        now_iso=source.get("AI_CHAT_NOW_ISO", ""),
    )


def public_config(config):
    return {
        "port": config.port,
        "model": config.model,
        "contextLimit": config.context_limit,
        "llmBasePath": "/api/chat",
        "apiKey": "server-side" if config.api_key else "missing",
        "webTokenRequired": bool(config.web_token),
        "features": {
            "streaming": True,
            "thinking": True,
            "localHistory": True,
            "autoCompress": True,
            "webSearch": bool(config.web_search_enabled and config.web_search_url),
            "imageGeneration": bool(config.image_generation_url),
            "videoGeneration": bool(config.video_generation_url),
        },
        "media": {
            "imagePath": "/api/media/image",
            "videoPath": "/api/media/video",
        },
    }


def read_json_body(handler, limit=2_000_000):
    length = int(handler.headers.get("content-length", "0") or "0")
    if length > limit:
        raise ValueError("Request body is too large.")
    if length == 0:
        return {}
    body = handler.rfile.read(length)
    return json.loads(body.decode("utf-8"))


def json_bytes(payload):
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def prepare_upstream_payload(config, payload, stream):
    upstream_payload = dict(payload)
    upstream_payload["model"] = upstream_payload.get("model") or config.model
    upstream_payload["messages"] = upstream_payload.get("messages") or []
    upstream_payload["stream"] = stream
    datetime_question = is_current_datetime_question(upstream_payload["messages"])
    requested_thinking = upstream_payload.pop("thinking", None)

    system_contexts = [current_datetime_context(config)]
    search_context = ""
    if upstream_payload.pop("web_search", False) and not datetime_question:
        search_context = build_web_search_context(config, upstream_payload["messages"])
        if search_context:
            system_contexts.append(search_context)

    if requested_thinking is not None or datetime_question or search_context:
        thinking = bool(requested_thinking) if requested_thinking is not None else True
        thinking = thinking and not datetime_question
        template_kwargs = dict(upstream_payload.get("chat_template_kwargs") or {})
        template_kwargs["enable_thinking"] = thinking
        upstream_payload["chat_template_kwargs"] = template_kwargs

    upstream_payload["messages"] = [
        {"role": "system", "content": "\n\n".join(system_contexts)}
    ] + list(upstream_payload["messages"])

    return upstream_payload


def last_user_query(messages):
    for message in reversed(messages or []):
        if message.get("role") == "user" and message.get("content"):
            return str(message["content"]).strip()
    return ""


def current_datetime(config):
    if config.now_iso:
        raw = config.now_iso.strip()
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(raw)
            return parsed.astimezone() if parsed.tzinfo else parsed.astimezone()
        except ValueError:
            pass
    return datetime.now().astimezone()


def current_datetime_context(config):
    now = current_datetime(config)
    weekday = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"][now.weekday()]
    tz_name = now.tzname() or now.strftime("%z")
    timestamp = now.strftime("%Y年%m月%d日 %H:%M:%S")
    return (
        f"当前服务端时间：{timestamp}（{weekday}，时区 {tz_name}）。"
        "当用户询问今天、当前日期、星期几、周几、几号或当前时间时，"
        "优先使用这个服务端时间直接回答，不要从网页搜索结果推断。"
        "正式回答要简洁，不要输出内部推理过程。"
    )


def is_current_datetime_question(messages):
    query = last_user_query(messages)
    compact = re.sub(r"\s+", "", query)
    has_current_marker = any(marker in compact for marker in ["今天", "现在", "当前", "此刻"])
    has_date_marker = any(marker in compact for marker in ["周几", "星期几", "礼拜几", "几号", "日期", "时间"])
    return bool(has_current_marker and has_date_marker)


def web_search_query_from_messages(messages):
    original = last_user_query(messages)
    query = re.sub(r"[\s，,。.!！?？:：；;]+", " ", original).strip()
    noise_phrases = [
        "帮我搜索一下",
        "帮我搜一下",
        "帮我查一下",
        "帮我搜索",
        "帮我搜",
        "帮我查",
        "请结合联网搜索",
        "结合联网搜索",
        "请使用联网搜索",
        "使用联网搜索",
        "联网搜索",
        "搜索一下",
        "搜一下",
        "查一下",
        "用一句中文说明",
        "用一句话说明",
        "用一句中文回答",
        "用一句话回答",
        "请回答",
        "请说明",
        "请查询",
        "请搜索",
        "请",
    ]
    for phrase in noise_phrases:
        query = query.replace(phrase, " ")
    query = re.sub(r"\s+", " ", query).strip(" -_")
    return query[:160] or original[:160]


def recent_dialogue_for_search_planner(messages, limit=6):
    dialogue = []
    for message in list(messages or [])[-limit:]:
        role = message.get("role")
        if role not in {"user", "assistant"}:
            continue
        content = str(message.get("content") or "").strip()
        if not content:
            continue
        if len(content) > 2000:
            content = content[-2000:]
        dialogue.append({"role": role, "content": content})
    return dialogue


def extract_json_object(text):
    raw = str(text or "").strip()
    if not raw:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        pass
    fenced = re.search(r"(?is)```(?:json)?\s*(\{.*?\})\s*```", raw)
    if fenced:
        try:
            return json.loads(fenced.group(1))
        except json.JSONDecodeError:
            pass
    start = raw.find("{")
    end = raw.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass
    return None


def bool_from_planner(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value or "").strip().lower() in {"1", "true", "yes", "on", "需要", "搜索"}


def normalize_web_search_plan(data):
    if not isinstance(data, dict):
        return {"should_search": False, "query": "", "reason": "invalid_planner_response"}
    query = re.sub(r"\s+", " ", str(data.get("query") or "")).strip()[:160]
    should_search = bool_from_planner(data.get("should_search")) and bool(query)
    reason = re.sub(r"\s+", " ", str(data.get("reason") or "")).strip()[:240]
    return {"should_search": should_search, "query": query if should_search else "", "reason": reason}


def normalize_web_search_relevance(data):
    if not isinstance(data, dict):
        return {"relevant": True, "query": "", "reason": "invalid_relevance_response"}
    query = re.sub(r"\s+", " ", str(data.get("query") or "")).strip()[:160]
    relevant = bool_from_planner(data.get("relevant"))
    reason = re.sub(r"\s+", " ", str(data.get("reason") or "")).strip()[:240]
    return {"relevant": relevant, "query": query if not relevant else "", "reason": reason}


def plan_web_search(config, messages):
    if not config.web_search_enabled or not config.web_search_url:
        return {"should_search": False, "query": "", "reason": "web_search_disabled"}
    if is_current_datetime_question(messages):
        return {"should_search": False, "query": "", "reason": "current_datetime_answerable_locally"}

    planner_messages = [
        {"role": "system", "content": f"{WEB_SEARCH_PLANNER_PROMPT}\n\n{current_datetime_context(config)}"},
    ] + recent_dialogue_for_search_planner(messages)
    planner_payload = {
        "model": config.model,
        "messages": planner_messages,
        "stream": False,
        "temperature": 0,
        "max_tokens": 96,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        f"{config.llm_base_url}/v1/chat/completions",
        data=json_bytes(planner_payload),
        headers={
            "authorization": f"Bearer {config.api_key}",
            "content-type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
        data = json.loads(body.decode("utf-8"))
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, UnicodeDecodeError, IndexError, AttributeError):
        return {"should_search": False, "query": "", "reason": "planner_failed"}
    return normalize_web_search_plan(extract_json_object(content))


def search_results_for_prompt(results):
    compact = []
    for index, result in enumerate(results[: config_safe_max_results(results)], 1):
        compact.append(
            {
                "index": index,
                "title": result.get("title", ""),
                "url": result.get("url", ""),
                "snippet": result.get("snippet", ""),
            }
        )
    return compact


def config_safe_max_results(results):
    return min(5, len(results or []))


def judge_web_search_relevance(config, messages, query, results):
    if not results:
        return {"relevant": False, "query": web_search_query_from_messages(messages), "reason": "no_results"}
    relevance_messages = [
        {"role": "system", "content": f"{WEB_SEARCH_RELEVANCE_PROMPT}\n\n{current_datetime_context(config)}"},
        {
            "role": "user",
            "content": json.dumps(
                {
                    "user_request": last_user_query(messages),
                    "search_query": query,
                    "search_results": search_results_for_prompt(results),
                },
                ensure_ascii=False,
            ),
        },
    ]
    relevance_payload = {
        "model": config.model,
        "messages": relevance_messages,
        "stream": False,
        "temperature": 0,
        "max_tokens": 96,
        "chat_template_kwargs": {"enable_thinking": False},
    }
    request = urllib.request.Request(
        f"{config.llm_base_url}/v1/chat/completions",
        data=json_bytes(relevance_payload),
        headers={
            "authorization": f"Bearer {config.api_key}",
            "content-type": "application/json",
            "accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            body = response.read()
        data = json.loads(body.decode("utf-8"))
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError, UnicodeDecodeError, IndexError, AttributeError):
        return {"relevant": True, "query": "", "reason": "relevance_check_failed"}
    return normalize_web_search_relevance(extract_json_object(content))


def build_search_url(template, query):
    encoded = urllib.parse.quote_plus(query)
    if "{query}" in template:
        return template.replace("{query}", encoded)
    separator = "&" if "?" in template else "?"
    return f"{template}{separator}q={encoded}"


def normalize_search_results(data, max_results):
    results = []

    def add(title="", url="", snippet=""):
        title = str(title or "").strip()
        url = str(url or "").strip()
        snippet = str(snippet or "").strip()
        if not title and not snippet:
            return
        results.append({"title": title or url or "Untitled", "url": url, "snippet": snippet})

    def add_duck_topics(topics):
        for item in topics or []:
            if len(results) >= max_results:
                return
            if "Topics" in item:
                add_duck_topics(item.get("Topics"))
                continue
            add(item.get("Text"), item.get("FirstURL"), item.get("Text"))

    if isinstance(data, dict):
        if data.get("AbstractText"):
            add(data.get("Heading") or "DuckDuckGo", data.get("AbstractURL"), data.get("AbstractText"))
        add_duck_topics(data.get("RelatedTopics"))

        containers = [
            data.get("results"),
            data.get("items"),
            data.get("organic"),
            data.get("data"),
            (data.get("webPages") or {}).get("value") if isinstance(data.get("webPages"), dict) else None,
        ]
    elif isinstance(data, list):
        containers = [data]
    else:
        containers = []

    for container in containers:
        if not isinstance(container, list):
            continue
        for item in container:
            if len(results) >= max_results:
                return results[:max_results]
            if not isinstance(item, dict):
                continue
            add(
                item.get("title") or item.get("name"),
                item.get("url") or item.get("link"),
                item.get("snippet") or item.get("description") or item.get("body"),
            )

    return results[:max_results]


def clean_html_text(value):
    text = re.sub(r"(?is)<(script|style).*?</\1>", " ", str(value or ""))
    text = re.sub(r"(?s)<[^>]+>", " ", text)
    text = html.unescape(text)
    return re.sub(r"\s+", " ", text).strip()


def normalize_html_search_results(text, max_results):
    results = []

    def add(title="", url="", snippet=""):
        title = clean_html_text(title)
        url = html.unescape(str(url or "")).strip()
        snippet = clean_html_text(snippet)
        if not title or not url.startswith(("http://", "https://")):
            return
        if any(existing["url"] == url for existing in results):
            return
        results.append({"title": title, "url": url, "snippet": snippet})

    for item in re.findall(r'(?is)<li[^>]+class=["\'][^"\']*\bb_algo\b[^"\']*["\'][^>]*>(.*?)</li>', text):
        if len(results) >= max_results:
            break
        link = re.search(r'(?is)<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)</a>', item)
        if not link:
            continue
        snippet = re.search(r"(?is)<p[^>]*>(.*?)</p>", item)
        add(link.group(2), link.group(1), snippet.group(1) if snippet else "")

    if results:
        return results[:max_results]

    for link in re.findall(r'(?is)<a[^>]+href=["\'](https?://[^"\']+)["\'][^>]*>(.*?)</a>', text):
        if len(results) >= max_results:
            break
        add(link[1], link[0], "")
    return results[:max_results]


def xml_child_text(element, names):
    for name in names:
        child = element.find(name)
        if child is not None and child.text:
            return clean_html_text(child.text)
    for child in list(element):
        local_name = child.tag.rsplit("}", 1)[-1].lower()
        if local_name in names and child.text:
            return clean_html_text(child.text)
    return ""


def normalize_xml_search_results(text, max_results):
    results = []
    try:
        root = ElementTree.fromstring(str(text or "").strip())
    except ElementTree.ParseError:
        return []

    entries = list(root.findall(".//item")) + list(root.findall(".//{http://www.w3.org/2005/Atom}entry"))
    for entry in entries:
        if len(results) >= max_results:
            break
        title = xml_child_text(entry, {"title"})
        url = xml_child_text(entry, {"link"})
        if not url:
            for child in list(entry):
                local_name = child.tag.rsplit("}", 1)[-1].lower()
                href = child.attrib.get("href", "")
                if local_name == "link" and href:
                    url = href.strip()
                    break
        snippet = xml_child_text(entry, {"description", "summary", "content"})
        if not title and not snippet:
            continue
        results.append({"title": title or url or "Untitled", "url": url, "snippet": snippet})
    return results[:max_results]


def fetch_web_search_results(config, query, web_search_url=None):
    search_url = (web_search_url or config.web_search_url or "").strip()
    if not config.web_search_enabled or not search_url or not query:
        return []

    url = build_search_url(search_url, query)
    request = urllib.request.Request(
        url,
        headers={
            "accept": "application/json,text/html;q=0.9,*/*;q=0.8",
            "user-agent": "CZAIChat/0.1 (+https://60.205.213.254:9999/)",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(request, timeout=config.web_search_timeout_seconds) as response:
            content_type = response.headers.get("content-type", "")
            body = response.read(1_000_000)
    except (urllib.error.URLError, TimeoutError, ValueError):
        return []

    text = body.decode("utf-8", errors="ignore")
    try:
        if "json" in content_type.lower() or text.lstrip().startswith(("{", "[")):
            return normalize_search_results(json.loads(text), config.web_search_max_results)
    except json.JSONDecodeError:
        pass
    stripped = text.lstrip()
    if "xml" in content_type.lower() or "rss" in content_type.lower() or stripped.startswith(("<?xml", "<rss", "<feed")):
        xml_results = normalize_xml_search_results(text, config.web_search_max_results)
        if xml_results:
            return xml_results
    return normalize_html_search_results(text, config.web_search_max_results)


def web_search_unavailable_context(query, reason):
    lines = [
        "联网搜索已尝试，但搜索结果与用户问题不相关或没有可用结果。",
        "回答时必须说明无法从搜索结果确认实时内容，不要引用未确认网页结果。",
    ]
    if query:
        lines.append(f"搜索问题：{query}")
    if reason:
        lines.append(f"原因：{reason}")
    return "\n".join(lines)


def fetch_relevant_fallback_search_results(config, messages, query):
    for fallback_url in config.web_search_fallback_urls:
        results = fetch_web_search_results(config, query, fallback_url)
        if not results:
            continue
        relevance = judge_web_search_relevance(config, messages, query, results)
        if relevance["relevant"]:
            return {
                "url": fallback_url,
                "query": query,
                "results": results,
                "relevance": relevance,
            }
    return {"url": "", "query": "", "results": [], "relevance": {}}


def build_web_search_context(config, messages):
    plan = plan_web_search(config, messages)
    query = plan["query"] if plan["should_search"] else ""
    results = fetch_web_search_results(config, query)
    if not results:
        return web_search_unavailable_context(query, plan.get("reason") or "no_results") if query else ""

    relevance = judge_web_search_relevance(config, messages, query, results)
    if not relevance["relevant"]:
        retry_query = relevance["query"]
        if retry_query and retry_query != query:
            retry_results = fetch_web_search_results(config, retry_query)
            if retry_results:
                retry_relevance = judge_web_search_relevance(config, messages, retry_query, retry_results)
                if retry_relevance["relevant"]:
                    query = retry_query
                    results = retry_results
                else:
                    fallback = fetch_relevant_fallback_search_results(config, messages, retry_query)
                    if fallback["results"]:
                        query = fallback["query"]
                        results = fallback["results"]
                    else:
                        reason = retry_relevance.get("reason") or relevance.get("reason") or "irrelevant_results"
                        return web_search_unavailable_context(retry_query, reason)
            else:
                fallback = fetch_relevant_fallback_search_results(config, messages, retry_query)
                if fallback["results"]:
                    query = fallback["query"]
                    results = fallback["results"]
                else:
                    return web_search_unavailable_context(retry_query, "retry_no_results")
        else:
            fallback = fetch_relevant_fallback_search_results(config, messages, query)
            if fallback["results"]:
                query = fallback["query"]
                results = fallback["results"]
            else:
                return web_search_unavailable_context(query, relevance.get("reason") or "irrelevant_results")

    lines = [
        "联网搜索结果如下。回答时只把这些结果作为参考，无法从结果确认的内容要说明不确定。",
        f"搜索问题：{query}",
    ]
    for index, result in enumerate(results, 1):
        lines.append(f"{index}. {result['title']}")
        if result.get("url"):
            lines.append(f"   URL: {result['url']}")
        if result.get("snippet"):
            lines.append(f"   摘要: {result['snippet']}")
    return "\n".join(lines)


def call_chat_completion(config, payload):
    if not config.api_key:
        return 500, {"content-type": "application/json"}, json_bytes({"error": "AI_CHAT_API_KEY is not configured."})

    upstream_payload = prepare_upstream_payload(config, payload, bool(payload.get("stream", True)))
    body = json_bytes(upstream_payload)
    request = urllib.request.Request(
        f"{config.llm_base_url}/v1/chat/completions",
        data=body,
        headers={
            "authorization": f"Bearer {config.api_key}",
            "content-type": "application/json",
            "accept": "text/event-stream" if upstream_payload["stream"] else "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            content_type = response.headers.get("content-type", "application/json")
            return response.status, {"content-type": content_type}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {"content-type": error.headers.get("content-type", "application/json")}, error.read()
    except urllib.error.URLError as error:
        return 502, {"content-type": "application/json"}, json_bytes({"error": f"Upstream LLM is unreachable: {error.reason}"})


def media_backend(config, media_type, upstream_url):
    if media_type == "image" and config.image_generation_backend:
        return config.image_generation_backend
    if media_type == "video" and config.video_generation_backend:
        return config.video_generation_backend
    if media_type in {"image", "video"}:
        parsed = urllib.parse.urlparse(upstream_url)
        path = parsed.path.rstrip("/")
        if path in ("", "/prompt"):
            return "comfyui"
    return "generic"


def comfyui_base_url(upstream_url):
    parsed = urllib.parse.urlparse(upstream_url)
    path = parsed.path.rstrip("/")
    if path.endswith("/prompt"):
        path = path[: -len("/prompt")].rstrip("/")
    return urllib.parse.urlunparse((parsed.scheme, parsed.netloc, path, "", "", "")).rstrip("/")


def clamp_int(value, default, minimum, maximum):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def clamp_float(value, default, minimum, maximum):
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = default
    return max(minimum, min(maximum, parsed))


def comfyui_dimension(value, default):
    dimension = clamp_int(value, default, 256, 1536)
    return max(256, int(round(dimension / 8)) * 8)


def comfyui_video_dimension(value, default):
    dimension = clamp_int(value, default, 128, 1024)
    return max(128, int(round(dimension / 32)) * 32)


def comfyui_video_length(value, default):
    length = clamp_int(value, default, 1, 129)
    if length <= 1:
        return 1
    return max(5, int(round((length - 1) / 4)) * 4 + 1)


def decode_data_url(data_url):
    match = re.match(r"^data:([^;,]+)?(;base64)?,(.*)$", str(data_url or ""), re.S)
    if not match:
        raise ValueError("A source image data URL is required for this image mode.")
    mime_type = match.group(1) or "application/octet-stream"
    payload = match.group(3)
    if match.group(2):
        return mime_type, base64.b64decode(payload, validate=True)
    return mime_type, urllib.parse.unquote_to_bytes(payload)


def image_extension_from_mime(mime_type):
    return {
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
    }.get(mime_type.lower(), ".png")


def urlopen_json(request, timeout):
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def comfyui_request_headers(config, content_type="application/json"):
    headers = {"accept": "application/json"}
    if content_type:
        headers["content-type"] = content_type
    if config.media_api_key:
        headers["authorization"] = f"Bearer {config.media_api_key}"
    return headers


def upload_comfyui_image(config, base_url, data_url):
    mime_type, image_bytes = decode_data_url(data_url)
    if not image_bytes:
        raise ValueError("The source image is empty.")
    if len(image_bytes) > config.media_body_limit:
        raise ValueError("The source image is too large.")

    filename = f"cz_ai_chat_{uuid.uuid4().hex}{image_extension_from_mime(mime_type)}"
    boundary = f"----CZAIChat{uuid.uuid4().hex}"
    fields = [
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="type"\r\n\r\n'
            "input\r\n"
        ).encode("utf-8"),
        (
            f"--{boundary}\r\n"
            'Content-Disposition: form-data; name="overwrite"\r\n\r\n'
            "true\r\n"
        ).encode("utf-8"),
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'
            f"Content-Type: {mime_type}\r\n\r\n"
        ).encode("utf-8"),
        image_bytes,
        b"\r\n",
        f"--{boundary}--\r\n".encode("utf-8"),
    ]
    request = urllib.request.Request(
        f"{base_url}/upload/image",
        data=b"".join(fields),
        headers=comfyui_request_headers(config, f"multipart/form-data; boundary={boundary}"),
        method="POST",
    )
    response = urlopen_json(request, min(config.media_timeout_seconds, 60))
    return response.get("name") or filename


def build_comfyui_image_workflow(
    payload,
    uploaded_image_name="",
    checkpoint="Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors",
    sampler="dpmpp_2m_sde",
    scheduler="karras",
):
    mode = str(payload.get("mode") or "text-to-image").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("Prompt is required.")

    negative_prompt = str(
        payload.get("negativePrompt")
        or payload.get("negative_prompt")
        or payload.get("negative")
        or "low quality, blurry, distorted, watermark, text"
    ).strip()
    seed = payload.get("seed")
    seed = clamp_int(seed, uuid.uuid4().int % (2**63 - 1), 0, 2**63 - 1)
    steps = clamp_int(payload.get("steps"), 25, 1, 80)
    cfg = clamp_float(payload.get("cfg") or payload.get("guidance"), 7.0, 1.0, 20.0)
    denoise = 1.0
    if mode in {"image-to-image", "edit-image"}:
        denoise = clamp_float(payload.get("denoise") or payload.get("strength"), 0.65, 0.05, 1.0)

    workflow = {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": str(payload.get("sampler") or sampler),
                "scheduler": str(payload.get("scheduler") or scheduler),
                "denoise": denoise,
                "model": ["4", 0],
                "positive": ["6", 0],
                "negative": ["7", 0],
                "latent_image": ["5", 0],
            },
        },
        "4": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": str(payload.get("checkpoint") or checkpoint)},
        },
        "5": {
            "class_type": "EmptyLatentImage",
            "inputs": {
                "width": comfyui_dimension(payload.get("width"), 1024),
                "height": comfyui_dimension(payload.get("height"), 1024),
                "batch_size": 1,
            },
        },
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {
            "class_type": "SaveImage",
            "inputs": {"filename_prefix": "cz_ai_chat", "images": ["8", 0]},
        },
    }

    if mode in {"image-to-image", "edit-image"}:
        if not uploaded_image_name:
            raise ValueError("A source image is required for this image mode.")
        workflow.pop("5")
        workflow["10"] = {"class_type": "LoadImage", "inputs": {"image": uploaded_image_name}}
        workflow["11"] = {
            "class_type": "VAEEncode",
            "inputs": {"pixels": ["10", 0], "vae": ["4", 2]},
        }
        workflow["3"]["inputs"]["latent_image"] = ["11", 0]
    elif mode != "text-to-image":
        raise ValueError(f"Unsupported ComfyUI image mode: {mode}.")

    return workflow


def wan22_video_model_names(profile, mode):
    use_i2v = mode in {"image-to-video", "keyframes-to-video"}
    if profile == "wan22-14b-lightx2v":
        prefix = "i2v" if use_i2v else "t2v"
        if use_i2v:
            return {
                "type": "14b",
                "high_unet": "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors",
                "low_unet": "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors",
                "high_lora": "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors",
                "low_lora": "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors",
                "vae": "wan_2.1_vae.safetensors",
            }
        return {
            "type": "14b",
            "high_unet": f"wan2.2_{prefix}_high_noise_14B_fp8_scaled.safetensors",
            "low_unet": f"wan2.2_{prefix}_low_noise_14B_fp8_scaled.safetensors",
            "high_lora": "wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors",
            "low_lora": "wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors",
            "vae": "wan_2.1_vae.safetensors",
        }
    return {
        "type": "5b",
        "unet": "wan2.2_ti2v_5B_fp16.safetensors",
        "vae": "wan2.2_vae.safetensors",
    }


def build_comfyui_video_workflow(payload, video_model_profile="wan22-14b-lightx2v", uploaded_images=None):
    uploaded_images = uploaded_images or {}
    mode = str(payload.get("mode") or "text-to-video").strip()
    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        raise ValueError("Prompt is required.")

    negative_prompt = str(
        payload.get("negativePrompt")
        or payload.get("negative_prompt")
        or payload.get("negative")
        or "low quality, blurry, static, watermark, text, distorted"
    ).strip()
    width = comfyui_video_dimension(payload.get("width"), 512)
    height = comfyui_video_dimension(payload.get("height"), 512)
    length = comfyui_video_length(payload.get("length") or payload.get("frames"), 17)
    fps = clamp_float(payload.get("fps"), 8.0, 1.0, 30.0)
    seed = clamp_int(payload.get("seed"), uuid.uuid4().int % (2**63 - 1), 0, 2**63 - 1)
    steps = clamp_int(payload.get("steps"), 4, 1, 40)
    cfg = clamp_float(payload.get("cfg") or payload.get("guidance"), 1.0, 0.1, 20.0)

    if mode not in {"text-to-video", "image-to-video", "keyframes-to-video"}:
        raise ValueError(f"Unsupported ComfyUI video mode: {mode}.")

    profile = str(payload.get("profile") or payload.get("videoProfile") or video_model_profile or "wan22-14b-lightx2v").strip().lower()
    models = wan22_video_model_names(profile, mode)
    if models["type"] == "14b":
        return build_comfyui_wan22_14b_video_workflow(
            payload,
            mode,
            models,
            uploaded_images,
            prompt,
            negative_prompt,
            width,
            height,
            length,
            fps,
            seed,
            steps,
            cfg,
        )

    workflow = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {
                "unet_name": str(payload.get("unet") or "wan2.2_ti2v_5B_fp16.safetensors"),
                "weight_dtype": str(payload.get("weight_dtype") or "default"),
            },
        },
        "2": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": str(payload.get("clip") or "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
                "type": "wan",
                "device": "default",
            },
        },
        "3": {
            "class_type": "VAELoader",
            "inputs": {"vae_name": str(payload.get("vae") or "wan2.2_vae.safetensors")},
        },
        "4": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["2", 0]}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["2", 0]}},
        "6": {
            "class_type": "Wan22ImageToVideoLatent",
            "inputs": {
                "vae": ["3", 0],
                "width": width,
                "height": height,
                "length": length,
                "batch_size": 1,
            },
        },
        "7": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["1", 0], "shift": 5.0}},
        "8": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["7", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": str(payload.get("sampler") or "euler"),
                "scheduler": str(payload.get("scheduler") or "simple"),
                "positive": ["4", 0],
                "negative": ["5", 0],
                "latent_image": ["6", 0],
                "denoise": 1.0,
            },
        },
        "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
        "10": {"class_type": "CreateVideo", "inputs": {"images": ["9", 0], "fps": fps}},
        "11": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["10", 0],
                "filename_prefix": "cz_ai_chat_video",
                "format": str(payload.get("format") or "mp4"),
                "codec": str(payload.get("codec") or "auto"),
            },
        },
    }

    if mode == "image-to-video":
        start_image = uploaded_images.get("start")
        if not start_image:
            raise ValueError("A source image is required for image-to-video.")
        workflow["12"] = {"class_type": "LoadImage", "inputs": {"image": start_image}}
        workflow["6"]["inputs"]["start_image"] = ["12", 0]

    if mode == "keyframes-to-video":
        start_image = uploaded_images.get("start")
        end_image = uploaded_images.get("end")
        if not start_image or not end_image:
            raise ValueError("At least two keyframes are required for keyframes-to-video.")
        workflow["12"] = {"class_type": "LoadImage", "inputs": {"image": start_image}}
        workflow["13"] = {"class_type": "LoadImage", "inputs": {"image": end_image}}
        workflow["6"] = {
            "class_type": "WanFirstLastFrameToVideo",
            "inputs": {
                "positive": ["4", 0],
                "negative": ["5", 0],
                "vae": ["3", 0],
                "width": width,
                "height": height,
                "length": length,
                "batch_size": 1,
                "start_image": ["12", 0],
                "end_image": ["13", 0],
            },
        }
        workflow["8"]["inputs"]["positive"] = ["6", 0]
        workflow["8"]["inputs"]["negative"] = ["6", 1]
        workflow["8"]["inputs"]["latent_image"] = ["6", 2]

    return workflow


def build_comfyui_wan22_14b_video_workflow(
    payload,
    mode,
    models,
    uploaded_images,
    prompt,
    negative_prompt,
    width,
    height,
    length,
    fps,
    seed,
    steps,
    cfg,
):
    high_end_step = max(1, steps // 2)
    workflow = {
        "1": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models["high_unet"], "weight_dtype": str(payload.get("weight_dtype") or "default")},
        },
        "2": {
            "class_type": "UNETLoader",
            "inputs": {"unet_name": models["low_unet"], "weight_dtype": str(payload.get("weight_dtype") or "default")},
        },
        "3": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["1", 0], "lora_name": models["high_lora"], "strength_model": 1.0},
        },
        "4": {
            "class_type": "LoraLoaderModelOnly",
            "inputs": {"model": ["2", 0], "lora_name": models["low_lora"], "strength_model": 1.0},
        },
        "5": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["3", 0], "shift": 5.0}},
        "6": {"class_type": "ModelSamplingSD3", "inputs": {"model": ["4", 0], "shift": 5.0}},
        "7": {
            "class_type": "CLIPLoader",
            "inputs": {
                "clip_name": str(payload.get("clip") or "umt5_xxl_fp8_e4m3fn_scaled.safetensors"),
                "type": "wan",
                "device": "default",
            },
        },
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": str(payload.get("vae") or models["vae"])}},
        "9": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["7", 0]}},
        "10": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["7", 0]}},
        "11": {
            "class_type": "EmptyHunyuanLatentVideo",
            "inputs": {"width": width, "height": height, "length": length, "batch_size": 1},
        },
        "12": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "model": ["5", 0],
                "add_noise": "enable",
                "noise_seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": str(payload.get("sampler") or "euler"),
                "scheduler": str(payload.get("scheduler") or "simple"),
                "positive": ["9", 0],
                "negative": ["10", 0],
                "latent_image": ["11", 0],
                "start_at_step": 0,
                "end_at_step": high_end_step,
                "return_with_leftover_noise": "enable",
            },
        },
        "13": {
            "class_type": "KSamplerAdvanced",
            "inputs": {
                "model": ["6", 0],
                "add_noise": "disable",
                "noise_seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": str(payload.get("sampler") or "euler"),
                "scheduler": str(payload.get("scheduler") or "simple"),
                "positive": ["9", 0],
                "negative": ["10", 0],
                "latent_image": ["12", 0],
                "start_at_step": high_end_step,
                "end_at_step": steps,
                "return_with_leftover_noise": "disable",
            },
        },
        "14": {"class_type": "VAEDecode", "inputs": {"samples": ["13", 0], "vae": ["8", 0]}},
        "15": {"class_type": "CreateVideo", "inputs": {"images": ["14", 0], "fps": fps}},
        "16": {
            "class_type": "SaveVideo",
            "inputs": {
                "video": ["15", 0],
                "filename_prefix": "cz_ai_chat_video",
                "format": str(payload.get("format") or "mp4"),
                "codec": str(payload.get("codec") or "auto"),
            },
        },
    }

    if mode == "image-to-video":
        start_image = uploaded_images.get("start")
        if not start_image:
            raise ValueError("A source image is required for image-to-video.")
        workflow["17"] = {"class_type": "LoadImage", "inputs": {"image": start_image}}
        workflow["11"] = {
            "class_type": "WanImageToVideo",
            "inputs": {
                "positive": ["9", 0],
                "negative": ["10", 0],
                "vae": ["8", 0],
                "width": width,
                "height": height,
                "length": length,
                "batch_size": 1,
                "start_image": ["17", 0],
            },
        }
        workflow["12"]["inputs"]["positive"] = ["11", 0]
        workflow["12"]["inputs"]["negative"] = ["11", 1]
        workflow["12"]["inputs"]["latent_image"] = ["11", 2]
        workflow["13"]["inputs"]["positive"] = ["11", 0]
        workflow["13"]["inputs"]["negative"] = ["11", 1]

    if mode == "keyframes-to-video":
        start_image = uploaded_images.get("start")
        end_image = uploaded_images.get("end")
        if not start_image or not end_image:
            raise ValueError("At least two keyframes are required for keyframes-to-video.")
        workflow["17"] = {"class_type": "LoadImage", "inputs": {"image": start_image}}
        workflow["18"] = {"class_type": "LoadImage", "inputs": {"image": end_image}}
        workflow["11"] = {
            "class_type": "WanFirstLastFrameToVideo",
            "inputs": {
                "positive": ["9", 0],
                "negative": ["10", 0],
                "vae": ["8", 0],
                "width": width,
                "height": height,
                "length": length,
                "batch_size": 1,
                "start_image": ["17", 0],
                "end_image": ["18", 0],
            },
        }
        workflow["12"]["inputs"]["positive"] = ["11", 0]
        workflow["12"]["inputs"]["negative"] = ["11", 1]
        workflow["12"]["inputs"]["latent_image"] = ["11", 2]
        workflow["13"]["inputs"]["positive"] = ["11", 0]
        workflow["13"]["inputs"]["negative"] = ["11", 1]

    return workflow


def fetch_comfyui_history(config, base_url, prompt_id):
    deadline = time.monotonic() + config.media_timeout_seconds
    history_url = f"{base_url}/history/{urllib.parse.quote(str(prompt_id), safe='')}"
    while time.monotonic() < deadline:
        remaining = max(1, min(10, deadline - time.monotonic()))
        request = urllib.request.Request(
            history_url,
            headers=comfyui_request_headers(config, ""),
            method="GET",
        )
        history = urlopen_json(request, remaining)
        record = history.get(prompt_id) or history.get(str(prompt_id)) or {}
        status = record.get("status") or {}
        status_str = str(status.get("status_str") or "").lower()
        if status_str in {"error", "failed"}:
            raise ValueError(f"ComfyUI prompt failed: {comfyui_status_message(status)}")
        if record.get("outputs"):
            return record
        if status.get("completed"):
            return record
        time.sleep(0.5)
    raise TimeoutError("Timed out waiting for ComfyUI image generation.")


def comfyui_status_message(status):
    for message in status.get("messages") or []:
        details = message[1] if isinstance(message, (list, tuple)) and len(message) > 1 else message
        if not isinstance(details, dict):
            continue
        for key in ("exception_message", "message", "node_type"):
            if details.get(key):
                return str(details[key])[:240]
    return str(status.get("status_str") or "unknown error")[:240]


def fetch_comfyui_image_output(config, base_url, image_info):
    query = urllib.parse.urlencode(
        {
            "filename": image_info.get("filename", ""),
            "subfolder": image_info.get("subfolder", ""),
            "type": image_info.get("type", "output"),
        }
    )
    request = urllib.request.Request(
        f"{base_url}/view?{query}",
        headers=comfyui_request_headers(config, ""),
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=min(config.media_timeout_seconds, 60)) as response:
        content_type = response.headers.get("content-type", "image/png").split(";", 1)[0]
        image_bytes = response.read(config.media_body_limit + 1)
    if len(image_bytes) > config.media_body_limit:
        raise ValueError("The generated image is too large.")
    return {
        "type": "image",
        "filename": image_info.get("filename", ""),
        "dataUrl": f"data:{content_type};base64,{base64.b64encode(image_bytes).decode('ascii')}",
    }


def fetch_comfyui_video_output(config, base_url, video_info):
    query = urllib.parse.urlencode(
        {
            "filename": video_info.get("filename", ""),
            "subfolder": video_info.get("subfolder", ""),
            "type": video_info.get("type", "output"),
        }
    )
    request = urllib.request.Request(
        f"{base_url}/view?{query}",
        headers=comfyui_request_headers(config, ""),
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=min(config.media_timeout_seconds, 60)) as response:
        content_type = response.headers.get("content-type", "video/mp4").split(";", 1)[0]
        video_bytes = response.read(config.media_body_limit + 1)
    if len(video_bytes) > config.media_body_limit:
        raise ValueError("The generated video is too large.")
    filename = video_info.get("filename", "")
    return {
        "type": "video",
        "filename": filename,
        "dataUrl": f"data:{content_type};base64,{base64.b64encode(video_bytes).decode('ascii')}",
    }


def comfyui_image_generation(config, upstream_url, payload):
    base_url = comfyui_base_url(upstream_url)
    mode = str((payload or {}).get("mode") or "text-to-image").strip()
    uploaded_image_name = ""
    if mode in {"image-to-image", "edit-image"}:
        uploaded_image_name = upload_comfyui_image(config, base_url, (payload or {}).get("image", ""))

    workflow = build_comfyui_image_workflow(
        payload or {},
        uploaded_image_name,
        config.image_checkpoint,
        config.image_sampler,
        config.image_scheduler,
    )
    client_id = f"cz-ai-chat-{uuid.uuid4().hex}"
    request = urllib.request.Request(
        f"{base_url}/prompt",
        data=json_bytes({"client_id": client_id, "prompt": workflow}),
        headers=comfyui_request_headers(config),
        method="POST",
    )
    response = urlopen_json(request, min(config.media_timeout_seconds, 60))
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise ValueError("ComfyUI did not return a prompt_id.")

    history = fetch_comfyui_history(config, base_url, str(prompt_id))
    outputs = []
    for node_output in (history.get("outputs") or {}).values():
        for image_info in node_output.get("images") or []:
            outputs.append(fetch_comfyui_image_output(config, base_url, image_info))
    if not outputs:
        raise ValueError("ComfyUI finished without image outputs.")

    return {
        "status": "completed",
        "backend": "comfyui",
        "mode": mode,
        "promptId": prompt_id,
        "outputs": outputs,
    }


def keyframe_data_urls(payload):
    keyframes = payload.get("keyframes") or []
    urls = []
    for item in keyframes:
        if isinstance(item, dict) and item.get("dataUrl"):
            urls.append(item["dataUrl"])
        elif isinstance(item, str):
            urls.append(item)
    return urls


def comfyui_video_generation(config, upstream_url, payload):
    payload = payload or {}
    base_url = comfyui_base_url(upstream_url)
    mode = str(payload.get("mode") or "text-to-video").strip()
    uploaded_images = {}
    if mode == "image-to-video":
        image = payload.get("image") or (keyframe_data_urls(payload)[0] if keyframe_data_urls(payload) else "")
        uploaded_images["start"] = upload_comfyui_image(config, base_url, image)
    elif mode == "keyframes-to-video":
        frames = keyframe_data_urls(payload)
        if len(frames) < 2:
            raise ValueError("At least two keyframes are required for keyframes-to-video.")
        uploaded_images["start"] = upload_comfyui_image(config, base_url, frames[0])
        uploaded_images["end"] = upload_comfyui_image(config, base_url, frames[-1])

    workflow = build_comfyui_video_workflow(payload, config.video_model_profile, uploaded_images)
    client_id = f"cz-ai-chat-{uuid.uuid4().hex}"
    request = urllib.request.Request(
        f"{base_url}/prompt",
        data=json_bytes({"client_id": client_id, "prompt": workflow}),
        headers=comfyui_request_headers(config),
        method="POST",
    )
    response = urlopen_json(request, min(config.media_timeout_seconds, 60))
    prompt_id = response.get("prompt_id")
    if not prompt_id:
        raise ValueError("ComfyUI did not return a prompt_id.")

    history = fetch_comfyui_history(config, base_url, str(prompt_id))
    outputs = []
    for node_output in (history.get("outputs") or {}).values():
        animated = bool(node_output.get("animated"))
        for video_info in node_output.get("videos") or []:
            outputs.append(fetch_comfyui_video_output(config, base_url, video_info))
        for output_info in node_output.get("images") or []:
            filename = str(output_info.get("filename") or "")
            if animated or filename.lower().endswith((".mp4", ".webm", ".mov", ".mkv")):
                outputs.append(fetch_comfyui_video_output(config, base_url, output_info))
    if not outputs:
        raise ValueError("ComfyUI finished without video outputs.")

    return {
        "status": "completed",
        "backend": "comfyui",
        "mode": mode,
        "promptId": prompt_id,
        "outputs": outputs,
    }


def call_media_generation(config, media_type, payload):
    urls = {
        "image": config.image_generation_url,
        "video": config.video_generation_url,
    }
    upstream_url = urls.get(media_type, "").strip()
    if not upstream_url:
        return 503, {"content-type": "application/json"}, json_bytes({"error": f"{media_type} generation endpoint is not configured."})

    if media_backend(config, media_type, upstream_url) == "comfyui":
        try:
            if media_type == "image":
                data = comfyui_image_generation(config, upstream_url, payload or {})
            else:
                data = comfyui_video_generation(config, upstream_url, payload or {})
            return 200, {"content-type": "application/json"}, json_bytes(data)
        except ValueError as error:
            return 400, {"content-type": "application/json"}, json_bytes({"error": str(error)})
        except TimeoutError as error:
            return 504, {"content-type": "application/json"}, json_bytes({"error": str(error)})
        except urllib.error.HTTPError as error:
            return error.code, {"content-type": error.headers.get("content-type", "application/json")}, error.read()
        except urllib.error.URLError as error:
            return 502, {"content-type": "application/json"}, json_bytes({"error": f"ComfyUI is unreachable: {error.reason}"})

    upstream_payload = dict(payload or {})
    upstream_payload["type"] = media_type
    headers = {
        "content-type": "application/json",
        "accept": "application/json",
    }
    if config.media_api_key:
        headers["authorization"] = f"Bearer {config.media_api_key}"
    request = urllib.request.Request(
        upstream_url,
        data=json_bytes(upstream_payload),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=config.media_timeout_seconds) as response:
            content_type = response.headers.get("content-type", "application/json")
            return response.status, {"content-type": content_type}, response.read()
    except urllib.error.HTTPError as error:
        return error.code, {"content-type": error.headers.get("content-type", "application/json")}, error.read()
    except urllib.error.URLError as error:
        return 502, {"content-type": "application/json"}, json_bytes({"error": f"Upstream media service is unreachable: {error.reason}"})


def stream_chat_completion(config, payload, output):
    if not config.api_key:
        output.write_head(500, {"content-type": "application/json"})
        output.wfile.write(json_bytes({"error": "AI_CHAT_API_KEY is not configured."}))
        return

    upstream_payload = prepare_upstream_payload(config, payload, True)
    request = urllib.request.Request(
        f"{config.llm_base_url}/v1/chat/completions",
        data=json_bytes(upstream_payload),
        headers={
            "authorization": f"Bearer {config.api_key}",
            "content-type": "application/json",
            "accept": "text/event-stream",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as response:
            output.write_head(
                response.status,
                {
                    "content-type": response.headers.get("content-type", "text/event-stream; charset=utf-8"),
                    "cache-control": "no-cache",
                    "x-accel-buffering": "no",
                },
            )
            for line in response:
                output.wfile.write(line)
                output.wfile.flush()
    except urllib.error.HTTPError as error:
        output.write_head(error.code, {"content-type": error.headers.get("content-type", "application/json")})
        output.wfile.write(error.read())
    except urllib.error.URLError as error:
        output.write_head(502, {"content-type": "application/json"})
        output.wfile.write(json_bytes({"error": f"Upstream LLM is unreachable: {error.reason}"}))


def compress_messages(config, messages):
    prompt = (
        "请把下面的历史对话压缩成一段可继续对话的中文上下文摘要。"
        "保留用户目标、关键约束、已经确认的事实、待办事项和重要代码/命令。"
        "不要添加新事实，不要输出标题，只输出摘要。"
    )
    compact_messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": json.dumps(messages, ensure_ascii=False)},
    ]
    status, headers, body = call_chat_completion(
        config,
        {
            "messages": compact_messages,
            "stream": False,
            "thinking": False,
            "temperature": 0.1,
            "max_tokens": 900,
        },
    )
    if status != 200:
        return status, headers, body
    try:
        data = json.loads(body.decode("utf-8"))
        content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    except (json.JSONDecodeError, UnicodeDecodeError, IndexError, AttributeError):
        content = ""
    return 200, {"content-type": "application/json"}, json_bytes({"summary": content})


class AiChatHandler(BaseHTTPRequestHandler):
    server_version = "CZAIChat/0.1"

    @property
    def config(self):
        return self.server.config

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - - [%s] %s\n" % (self.client_address[0], self.log_date_time_string(), fmt % args))

    def write_head(self, status, headers=None):
        self.send_response(status)
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def send_json(self, status, payload):
        body = json_bytes(payload)
        self.write_head(
            status,
            {
                "content-type": "application/json; charset=utf-8",
                "content-length": str(len(body)),
            },
        )
        self.wfile.write(body)

    def token_from_request(self):
        header = self.headers.get("x-ai-chat-token", "")
        if header:
            return header
        auth = self.headers.get("authorization", "")
        if auth.lower().startswith("bearer "):
            return auth[7:]
        cookie_header = self.headers.get("cookie", "")
        if cookie_header:
            parsed = cookies.SimpleCookie(cookie_header)
            if "ai_chat_token" in parsed:
                return parsed["ai_chat_token"].value
        return ""

    def require_access(self):
        if not self.config.web_token:
            return True
        return self.token_from_request() == self.config.web_token

    def do_GET(self):
        if self.path == "/health":
            self.send_json(200, {"status": "ok", "model": self.config.model, "apiKey": bool(self.config.api_key)})
            return
        if self.path == "/api/config":
            self.send_json(200, public_config(self.config))
            return
        self.serve_static()

    def do_POST(self):
        if self.path == "/api/token":
            try:
                payload = read_json_body(self)
            except (ValueError, json.JSONDecodeError) as error:
                self.send_json(400, {"error": str(error)})
                return
            if not self.config.web_token or payload.get("token") == self.config.web_token:
                self.send_json(200, {"ok": True})
            else:
                self.send_json(401, {"error": "Invalid access token."})
            return

        if self.path in ("/api/chat", "/api/compress", "/api/media/image", "/api/media/video") and not self.require_access():
            self.send_json(401, {"error": "Access token required."})
            return

        try:
            limit = self.config.media_body_limit if self.path.startswith("/api/media/") else 2_000_000
            payload = read_json_body(self, limit=limit)
        except (ValueError, json.JSONDecodeError) as error:
            self.send_json(400, {"error": str(error)})
            return

        if self.path == "/api/chat":
            if payload.get("stream", True):
                stream_chat_completion(self.config, payload, self)
            else:
                status, headers, body = call_chat_completion(self.config, payload)
                self.write_head(status, headers)
                self.wfile.write(body)
            return

        if self.path == "/api/compress":
            status, headers, body = compress_messages(self.config, payload.get("messages") or [])
            self.write_head(status, headers)
            self.wfile.write(body)
            return

        if self.path == "/api/media/image":
            status, headers, body = call_media_generation(self.config, "image", payload)
            self.write_head(status, headers)
            self.wfile.write(body)
            return

        if self.path == "/api/media/video":
            status, headers, body = call_media_generation(self.config, "video", payload)
            self.write_head(status, headers)
            self.wfile.write(body)
            return

        self.send_json(404, {"error": "Not found."})

    def serve_static(self):
        requested = self.path.split("?", 1)[0]
        if requested == "/":
            requested = "/index.html"
        public_root = self.config.public_dir.resolve()
        candidate = (public_root / requested.lstrip("/")).resolve()
        try:
            candidate.relative_to(public_root)
        except ValueError:
            self.send_json(404, {"error": "Not found."})
            return
        if not candidate.exists() or candidate.is_dir():
            self.send_json(404, {"error": "Not found."})
            return
        body = candidate.read_bytes()
        self.write_head(
            200,
            {
                "content-type": MIME_TYPES.get(candidate.suffix, "application/octet-stream"),
                "content-length": str(len(body)),
            },
        )
        self.wfile.write(body)


class AiChatServer(ThreadingHTTPServer):
    def __init__(self, address, handler, config):
        super().__init__(address, handler)
        self.config = config


def main(argv=None):
    parser = argparse.ArgumentParser(description="CZ CloudService AI chat web gateway")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    args = parser.parse_args(argv)

    config = build_config()
    if args.host:
        config.host = args.host
    if args.port:
        config.port = args.port

    server = AiChatServer((config.host, config.port), AiChatHandler, config)
    print(f"AI chat gateway listening on http://{config.host}:{config.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
