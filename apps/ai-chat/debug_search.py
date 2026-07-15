#!/usr/bin/env python3
import argparse
import json
import sys

import server


def result_rows(results):
    rows = []
    for index, result in enumerate(results or [], 1):
        rows.append(
            {
                "index": index,
                "title": str(result.get("title") or ""),
                "url": str(result.get("url") or ""),
                "snippet": str(result.get("snippet") or ""),
            }
        )
    return rows


def build_diagnostic(config, question):
    messages = [{"role": "user", "content": question}]
    diagnostic = {
        "question": question,
        "model": config.model,
        "web_search_enabled": bool(config.web_search_enabled and config.web_search_url),
        "plan": server.plan_web_search(config, messages),
        "initial_query": "",
        "initial_results": [],
        "relevance": {},
        "retry_query": "",
        "retry_results": [],
        "retry_relevance": {},
        "fallback_url": "",
        "fallback_query": "",
        "fallback_results": [],
        "fallback_relevance": {},
        "failure": "",
        "final_query": "",
        "final_results": [],
    }

    plan = diagnostic["plan"]
    if not plan.get("should_search"):
        return diagnostic

    initial_query = plan.get("query") or ""
    initial_results = server.fetch_web_search_results(config, initial_query)
    if not initial_results:
        diagnostic["initial_query"] = initial_query
        diagnostic["failure"] = "initial_no_results"
        return diagnostic

    relevance = server.judge_web_search_relevance(config, messages, initial_query, initial_results)
    final_query = initial_query
    final_results = initial_results

    diagnostic["initial_query"] = initial_query
    diagnostic["initial_results"] = result_rows(initial_results)
    diagnostic["relevance"] = relevance

    retry_query = relevance.get("query") if not relevance.get("relevant") else ""
    if retry_query and retry_query != initial_query:
        retry_results = server.fetch_web_search_results(config, retry_query)
        diagnostic["retry_query"] = retry_query
        diagnostic["retry_results"] = result_rows(retry_results)
        if not retry_results:
            fallback = server.fetch_relevant_fallback_search_results(config, messages, retry_query)
            diagnostic["fallback_url"] = fallback["url"]
            diagnostic["fallback_query"] = fallback["query"]
            diagnostic["fallback_results"] = result_rows(fallback["results"])
            diagnostic["fallback_relevance"] = fallback["relevance"]
            if fallback["results"]:
                final_query = fallback["query"]
                final_results = fallback["results"]
            else:
                diagnostic["failure"] = "retry_no_results"
                final_query = ""
                final_results = []
        else:
            retry_relevance = server.judge_web_search_relevance(config, messages, retry_query, retry_results)
            diagnostic["retry_relevance"] = retry_relevance
            if retry_relevance.get("relevant"):
                final_query = retry_query
                final_results = retry_results
            else:
                fallback = server.fetch_relevant_fallback_search_results(config, messages, retry_query)
                diagnostic["fallback_url"] = fallback["url"]
                diagnostic["fallback_query"] = fallback["query"]
                diagnostic["fallback_results"] = result_rows(fallback["results"])
                diagnostic["fallback_relevance"] = fallback["relevance"]
                if fallback["results"]:
                    final_query = fallback["query"]
                    final_results = fallback["results"]
                else:
                    diagnostic["failure"] = retry_relevance.get("reason") or "retry_irrelevant_results"
                    final_query = ""
                    final_results = []
    elif not relevance.get("relevant"):
        fallback = server.fetch_relevant_fallback_search_results(config, messages, initial_query)
        diagnostic["fallback_url"] = fallback["url"]
        diagnostic["fallback_query"] = fallback["query"]
        diagnostic["fallback_results"] = result_rows(fallback["results"])
        diagnostic["fallback_relevance"] = fallback["relevance"]
        if fallback["results"]:
            final_query = fallback["query"]
            final_results = fallback["results"]
        else:
            diagnostic["failure"] = relevance.get("reason") or "irrelevant_results"
            final_query = ""
            final_results = []

    diagnostic["final_query"] = final_query
    diagnostic["final_results"] = result_rows(final_results)
    return diagnostic


def print_kv(label, value):
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    print(f"{label}={value}")


def print_results(label, results):
    print_kv(f"{label}_COUNT", len(results or []))
    for row in results or []:
        print(f"[{row['index']}] {row['title']}")
        if row["url"]:
            print(f"    URL: {row['url']}")
        if row["snippet"]:
            print(f"    SNIPPET: {row['snippet']}")


def print_human(diagnostic):
    print_kv("QUESTION", diagnostic["question"])
    print_kv("MODEL", diagnostic["model"])
    print_kv("WEB_SEARCH_ENABLED", diagnostic["web_search_enabled"])
    print_kv("PLAN", diagnostic["plan"])
    print_kv("INITIAL_QUERY", diagnostic["initial_query"])
    print_results("INITIAL_RESULTS", diagnostic["initial_results"])
    print_kv("RELEVANCE", diagnostic["relevance"])
    print_kv("RETRY_QUERY", diagnostic["retry_query"])
    print_results("RETRY_RESULTS", diagnostic["retry_results"])
    print_kv("RETRY_RELEVANCE", diagnostic["retry_relevance"])
    print_kv("FALLBACK_URL", diagnostic["fallback_url"])
    print_kv("FALLBACK_QUERY", diagnostic["fallback_query"])
    print_results("FALLBACK_RESULTS", diagnostic["fallback_results"])
    print_kv("FALLBACK_RELEVANCE", diagnostic["fallback_relevance"])
    print_kv("FAILURE", diagnostic["failure"])
    print_kv("FINAL_QUERY", diagnostic["final_query"])
    print_results("FINAL_RESULTS", diagnostic["final_results"])


def main(argv=None):
    parser = argparse.ArgumentParser(description="Debug the AI chat web-search planner and result relevance checks.")
    parser.add_argument("question", help="User question to diagnose.")
    parser.add_argument("--json", action="store_true", help="Print the full diagnostic payload as JSON.")
    parser.add_argument("--max-results", type=int, default=None, help="Override AI_CHAT_WEB_SEARCH_MAX_RESULTS.")
    parser.add_argument("--timeout", type=float, default=None, help="Override AI_CHAT_WEB_SEARCH_TIMEOUT_SECONDS.")
    args = parser.parse_args(argv)

    config = server.build_config()
    if args.max_results is not None:
        config.web_search_max_results = args.max_results
    if args.timeout is not None:
        config.web_search_timeout_seconds = args.timeout

    if not config.api_key:
        print("ERROR=AI_CHAT_API_KEY is not configured and could not be read from AI_CHAT_RUN_LLM.", file=sys.stderr)
        return 2

    diagnostic = build_diagnostic(config, args.question)
    if args.json:
        print(json.dumps(diagnostic, ensure_ascii=False, indent=2))
    else:
        print_human(diagnostic)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
