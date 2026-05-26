"""
User-facing copy when Groq (or other LLM) is unavailable in demo deployments.
Never expose API keys, rate limits, or raw backend errors to the client.
"""

from __future__ import annotations

FALLBACKS: dict[str, str] = {
    "degree_planner": (
        "This is a portfolio demo. Personalized coaching text is temporarily "
        "unavailable, but your degree progress and remaining courses below are "
        "still calculated from the program catalog. Try another question in a "
        "moment, or use the course cards and timeline."
    ),
    "career_mentor": (
        "This is a portfolio demo. Career narrative text is temporarily "
        "unavailable. Certificate and course matches may still appear when "
        "retrieval succeeds. Try again shortly or explore the suggested prompts."
    ),
    "skills_gap": (
        "This is a portfolio demo. The full AI narrative is temporarily "
        "unavailable. Gap scores and course suggestions below still use catalog "
        "and rules-based matching where possible."
    ),
    "skills_gap_followup": (
        "This is a portfolio demo. I cannot answer follow-up questions with AI "
        "right now. Your prior gap analysis on screen is still valid—review the "
        "matched and missing skills, then try again later."
    ),
    "skills_gap_judge": (
        "Demo mode: skill ratings defaulted to catalog rules. Upload or paste "
        "your materials again when AI is available for finer detail."
    ),
}


def get_fallback(key: str) -> str:
    return FALLBACKS.get(key, FALLBACKS["degree_planner"])
