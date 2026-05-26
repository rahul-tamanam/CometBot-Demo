import logging
import os
from typing import Any

from groq import Groq

from backend.services.demo_fallbacks import get_fallback
from backend.services.validator import (
    validate_and_fix_response,
    soften_length_truncation,
    validate_and_fix_titles,
)

GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
DEFAULT_MAX_TOKENS = int(os.getenv("LLM_MAX_TOKENS", "1024"))
INJECT_SYSTEM_INTO_USER = False
FORCE_SYSTEM_IN_USER = os.getenv("LLM_FORCE_SYSTEM_IN_USER", "0") == "1"

_groq_client: Groq | None = None
_log = logging.getLogger(__name__)


def _get_groq() -> Groq:
    global _groq_client
    if _groq_client is None:
        key = os.getenv("GROQ_API_KEY")
        if not key:
            raise RuntimeError(
                "GROQ_API_KEY is not set. Add it to your .env for Groq chat completions."
            )
        _groq_client = Groq(api_key=key)
    return _groq_client


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """
    Ensure messages are OpenAI-compatible and only include supported roles.
    Also enforces alternating user/assistant roles (LM Studio templates often require this).
    """
    cleaned: list[dict] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content")
        if role not in {"system", "user", "assistant"}:
            continue
        if not isinstance(content, str) or not content.strip():
            continue
        cleaned.append({"role": role, "content": content.strip()})

    # Merge consecutive same-role messages to guarantee alternation.
    merged: list[dict] = []
    for m in cleaned:
        if not merged:
            merged.append(m)
            continue
        if merged[-1]["role"] == m["role"]:
            merged[-1]["content"] = merged[-1]["content"].rstrip() + "\n\n" + m["content"].lstrip()
        else:
            merged.append(m)

    # If conversation starts with assistant, insert a user turn.
    if merged and merged[0]["role"] == "assistant":
        merged.insert(0, {"role": "user", "content": "Start."})

    return merged


def _build_formatted_messages(system_prompt: str, normalized: list[dict]) -> list[dict]:
    if INJECT_SYSTEM_INTO_USER or FORCE_SYSTEM_IN_USER:
        formatted: list[dict] = []
        system_injected = False
        for msg in normalized:
            if msg["role"] == "user" and not system_injected:
                formatted.append({
                    "role": "user",
                    "content": f"{system_prompt}\n\n{msg['content']}",
                })
                system_injected = True
            else:
                formatted.append(msg)
        if not system_injected:
            formatted.insert(0, {"role": "user", "content": system_prompt})
        return formatted
    return [{"role": "system", "content": system_prompt}] + normalized


def chat(
    system_prompt: str,
    messages: list[dict],
    temperature: float = 0.3,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    validate: bool = True,
) -> dict[str, Any]:
    """
    Groq chat completions (OpenAI-compatible).

    Env:
      - ``GROQ_API_KEY`` (required)
      - ``GROQ_MODEL`` (optional, default llama-3.3-70b-versatile)
      - ``LLM_MAX_TOKENS`` default for ``max_tokens`` when callers omit it

    If your stack does not support a separate ``system`` message, set ``LLM_FORCE_SYSTEM_IN_USER=1``.
    """

    normalized = _normalize_messages(messages)
    formatted = _build_formatted_messages(system_prompt, normalized)

    response = _get_groq().chat.completions.create(
        model=GROQ_MODEL,
        messages=formatted,
        temperature=temperature,
        max_tokens=max_tokens,
    )
    choice = response.choices[0]
    raw_text = choice.message.content or ""
    finish = getattr(choice, "finish_reason", None) or ""

    if finish in ("length", "max_tokens"):
        raw_text = soften_length_truncation(raw_text)

    if validate:
        result = validate_and_fix_response(raw_text)
        title_fix = validate_and_fix_titles(result["text"])
        result["text"] = title_fix["text"]
        result["title_corrections"] = title_fix.get("title_corrections", [])
        return result

    return {
        "text": raw_text,
        "corrections": [],
        "removed": [],
    }


def safe_chat(
    fallback_key: str,
    system_prompt: str,
    messages: list[dict],
    *,
    temperature: float = 0.3,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    validate: bool = True,
) -> dict[str, Any]:
    """
    Like ``chat``, but never raises. On missing key, rate limits, or network errors,
    returns demo-safe narrative text (no token/backend jargon).
    """
    try:
        out = chat(
            system_prompt=system_prompt,
            messages=messages,
            temperature=temperature,
            max_tokens=max_tokens,
            validate=validate,
        )
        out["llm_unavailable"] = False
        return out
    except Exception as exc:
        _log.warning("LLM unavailable (%s): %s", fallback_key, exc)
        return {
            "text": get_fallback(fallback_key),
            "corrections": [],
            "removed": [],
            "llm_unavailable": True,
        }
