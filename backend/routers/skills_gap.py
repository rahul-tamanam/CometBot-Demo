"""
Skills Gap Analyzer router.

Pipeline:
  1. Parse resume -> raw text (resume_parser)
  2. Load required skills (skills.json exact match OR jd_parser)
  3. Groq rates each required skill against the resume text (extract_and_rate_skills)
  4. Evidence quotes are validated against resume text
  5. gap_engine computes weighted score
  6. Pinecone maps missing/partial skills to catalog courses (unchanged)
  7. Completed courses filtered out (unchanged)
  8. Groq narrates pre-computed result (never picks courses)
"""

import json as _json
import os
import re
from collections import Counter
from typing import Optional

from fastapi import APIRouter, File, Form, UploadFile
from pydantic import BaseModel

from backend.services.course_loader import load_courses_for_program
from backend.services.gap_engine import compute_gap
from backend.services.jd_parser import extract_skills_from_jd
from backend.services.llm_client import chat, safe_chat
from backend.services.pinecone_client import query_courses_for_skills
from backend.services.resume_parser import parse_resume
from backend.services.skill_normalizer import normalize_skill_list
from backend.services.validator import validate_course_list

router = APIRouter()

_SKILL_JUDGE_SYSTEM = """
You are a strict resume skill evaluator. You will be given:
1. A resume (raw text)
2. A list of required skills for a target role

Your job is to evaluate whether each required skill is demonstrated in the resume.

RATING RULES:
- "matched"  - Clear, direct evidence in the resume.
- "partial"  - Indirect or weak evidence.
- "missing"  - No evidence at all.

EVIDENCE RULES:
- For matched and partial: copy a SHORT exact phrase (under 15 words) from the resume.
- For missing: set evidence to empty string "".
- Do NOT paraphrase. Do NOT invent text.

TECHNICAL VS SOFT GUARDRAILS:
- The required skills list may contain both technical and soft skills.
- Technical tools, libraries, frameworks, algorithms, and platforms MUST always be evaluated as technical evidence only.
- Never use technical evidence (e.g., XGBoost, Kafka, Spark, Snowflake, AWS) to justify a soft-skill rating.
- If a skill is a soft skill, evidence must directly reflect that soft skill (e.g., communication, collaboration, leadership).
- If a skill is a technical skill and you only see adjacent/indirect technical evidence, rate it as "partial" (not as evidence for any soft skill).

Return ONE JSON array only. No markdown.
Each element:
{"skill":"<exact input skill>","rating":"matched|partial|missing","evidence":"<quote or empty>"}
""".strip()


def _load_role_from_skills_json(role_name: str) -> dict | None:
    skills_path = os.path.join(os.path.dirname(__file__), "..", "data", "skills.json")
    try:
        with open(skills_path, encoding="utf-8") as f:
            roles = _json.load(f)
    except Exception:
        return None

    role_lower = role_name.strip().lower()
    for role in roles:
        if (role.get("job_title") or "").strip().lower() == role_lower:
            return {
                "job_title": role.get("job_title", role_name.strip()),
                "technical_skills": role.get("technical_skills", []) or [],
                "soft_skills": role.get("soft_skills", []) or [],
            }
    return None


def extract_and_rate_skills(resume_text: str, required_skills: list[str]) -> list[dict]:
    if not required_skills:
        return []

    resume_truncated = resume_text[:6000]
    skill_list_text = "\n".join(f"- {s}" for s in required_skills)
    user_message = (
        f"RESUME:\n{resume_truncated}\n\n"
        f"REQUIRED SKILLS TO EVALUATE:\n{skill_list_text}\n\n"
        "Rate each skill based on the resume above. Return JSON array only."
    )

    try:
        result = chat(
            system_prompt=_SKILL_JUDGE_SYSTEM,
            messages=[{"role": "user", "content": user_message}],
            temperature=0.1,
            validate=False,
        )
        raw = (result.get("text") or "").strip()
        raw = re.sub(r"```json\s*|```", "", raw).strip()
        match = re.search(r"\[[\s\S]+\]", raw)
        if not match:
            raise ValueError("No JSON array found in response")

        parsed = _json.loads(match.group(0))
        if not isinstance(parsed, list):
            raise ValueError("Response is not a JSON array")

        valid_ratings = {"matched", "partial", "missing"}
        resume_lower = resume_truncated.lower()
        rated: list[dict] = []
        seen_names: set[str] = set()

        for item in parsed:
            if not isinstance(item, dict):
                continue
            skill = str(item.get("skill") or "").strip()
            rating = str(item.get("rating") or "missing").lower().strip()
            evidence = str(item.get("evidence") or "").strip()
            if not skill:
                continue
            if rating not in valid_ratings:
                rating = "missing"

            if rating in ("matched", "partial") and evidence:
                evidence_key = evidence.lower().strip()[:60]
                evidence_words = [w for w in evidence_key.split() if len(w) > 3]
                words_found = sum(1 for w in evidence_words if w in resume_lower)
                if evidence_words and words_found < len(evidence_words) * 0.5:
                    rating = "partial" if rating == "matched" else "missing"
                    evidence = ""

            rated.append({"skill": skill, "rating": rating, "evidence": evidence})
            seen_names.add(skill.lower().strip())

        for req in required_skills:
            if req.lower().strip() not in seen_names:
                rated.append({"skill": req, "rating": "missing", "evidence": ""})
        return rated

    except Exception as exc:
        print(f"[skills_gap] Groq skill rating failed: {exc}. Falling back to all-missing.")
        return [{"skill": s, "rating": "missing", "evidence": ""} for s in required_skills]


def _ratings_to_resume_skills(ratings: list[dict]) -> list[str]:
    # Keep score conservative: only clear "matched" counts as present.
    seen: set[str] = set()
    out: list[str] = []
    for rating in ratings:
        if rating.get("rating") != "matched":
            continue
        skill = str(rating.get("skill") or "").strip()
        if skill and skill.lower() not in seen:
            seen.add(skill.lower())
            out.append(skill)
    return out


def _get_course_recommendations(
    missing_technical: list[str],
    partial_technical: list[str],
    completed_ids: set[str],
    program_id: str,
) -> tuple[dict, list[dict]]:
    all_course_map = {
        c["course_id"]: c
        for c in load_courses_for_program(program_id)
        if c.get("course_id")
    }

    recommendations_raw = query_courses_for_skills(
        missing_technical + partial_technical,
        n_per_skill=2,
        program_id=program_id,
    )

    by_skill: dict[str, list[dict]] = {}
    seen_course_ids: set[str] = set(completed_ids)
    flat_list: list[dict] = []
    missing_skill_set = {s for s in missing_technical}
    coverage_counter: Counter[str] = Counter()

    for skill, courses in recommendations_raw.items():
        if skill not in missing_skill_set:
            continue
        unique_for_skill = {
            (course.get("course_id") or "").upper()
            for course in courses
            if course.get("course_id")
        }
        for cid in unique_for_skill:
            coverage_counter[cid] += 1

    for skill, courses in recommendations_raw.items():
        filtered: list[dict] = []
        for course in courses:
            cid = course["course_id"].upper()
            if cid in seen_course_ids:
                continue
            seen_course_ids.add(cid)

            catalog_entry = all_course_map.get(cid, {})
            coverage_count = coverage_counter.get(cid, 0)
            priority = "high" if coverage_count >= 2 else "medium"
            enriched = {
                "course_id": course["course_id"],
                "title": course.get("title", ""),
                "course_type": catalog_entry.get("course_type", "Elective"),
                "skill_addressed": skill,
                "priority": priority,
                "coverage_count": coverage_count,
            }
            filtered.append(enriched)
            flat_list.append(enriched)

        if filtered:
            by_skill[skill] = filtered

    flat_list.sort(
        key=lambda c: (
            -int(c.get("coverage_count", 0)),
            str(c.get("course_id", "")),
        )
    )

    for course in flat_list:
        course.pop("coverage_count", None)
    for skill_courses in by_skill.values():
        for course in skill_courses:
            course.pop("coverage_count", None)

    return by_skill, flat_list


def skills_from_completed_courses(completed_course_ids: list[str], course_catalog: list[dict]) -> list[str]:
    skills: list[str] = []
    catalog_by_id = {
        str(c.get("course_id", "")).strip().upper(): c
        for c in course_catalog
        if c.get("course_id")
    }
    for cid in completed_course_ids:
        key = str(cid or "").strip().upper()
        if not key:
            continue
        course = catalog_by_id.get(key)
        if not course:
            continue
        course_skills = course.get("skills_taught") or []
        if isinstance(course_skills, list):
            skills.extend(str(skill).strip() for skill in course_skills if str(skill).strip())
    return normalize_skill_list(list(dict.fromkeys(skills)))


_NARRATIVE_SYSTEM = """
You are a skills gap advisor for graduate students at UT Dallas.
You will be given a fully pre-computed gap analysis. Narrate it clearly.
Plain text only, no markdown.
Do not invent course IDs. Use only listed course IDs.
Never recommend completed courses.
Do not include numeric counts for matched, partial, or missing skills.
When discussing missing soft skills, phrase it like:
"Don't forget to improve on soft skills required for this job: ..."
Keep total response under 550 words.
""".strip()


def _build_narrative_context(
    job_title: str,
    ratings: list[dict],
    gap,
    completed_ids: set[str],
    flat_courses: list[dict],
) -> str:
    matched = [r for r in ratings if r["rating"] == "matched"]
    partial = [r for r in ratings if r["rating"] == "partial"]
    missing = [r for r in ratings if r["rating"] == "missing"]

    tech_set = {s.lower().strip() for s in gap.required_technical}
    matched_tech = [r["skill"] for r in matched if r["skill"].lower().strip() in tech_set]
    matched_soft = [r["skill"] for r in matched if r["skill"].lower().strip() not in tech_set]
    partial_tech = []
    for rating in partial:
        skill = rating["skill"]
        if skill.lower().strip() not in tech_set:
            continue
        evidence = str(rating.get("evidence") or "").replace("\n", " ").strip()
        if evidence:
            partial_tech.append(f"{skill} (adjacent experience: {evidence[:80]})")
        else:
            partial_tech.append(f"{skill} (adjacent experience: n/a)")
    missing_tech = [r["skill"] for r in missing if r["skill"].lower().strip() in tech_set]
    missing_soft = [r["skill"] for r in missing if r["skill"].lower().strip() not in tech_set]

    courses_text = "\n".join(
        f"  {c['course_id']} — {c['title']} (builds: {c['skill_addressed']}, priority: {c['priority']})"
        for c in flat_courses
    ) or "  None available."

    completed_text = (
        "\n".join(f"  - {cid}" for cid in sorted(completed_ids))
        if completed_ids else "  None"
    )

    evidence_lines = []
    for rating in matched[:5]:
        if rating.get("evidence"):
            evidence_lines.append(f'  {rating["skill"]}: "{rating["evidence"]}"')
    evidence_block = "\n".join(evidence_lines) or "  (no quotes available)"

    return f"""
GAP ANALYSIS — PRE-COMPUTED. NARRATE ONLY.
Target Role: {job_title}
Match Score: {gap.match_percent}%

MATCHED TECHNICAL SKILLS: {', '.join(matched_tech) or 'None'}
MATCHED SOFT SKILLS: {', '.join(matched_soft) or 'None'}

EVIDENCE FROM RESUME (top matched skills):
{evidence_block}

PARTIAL SKILLS — on resume but need more depth:
{', '.join(partial_tech) or 'None'}

MISSING TECHNICAL SKILLS — high priority first:
{chr(10).join(f'  - {s}' for s in missing_tech) or '  None'}

MISSING SOFT SKILLS:
{', '.join(missing_soft) or 'None'}

COMPLETED COURSES (NEVER RECOMMEND THESE):
{completed_text}

COURSE RECOMMENDATIONS (USE ONLY THESE EXACT IDs, NO OTHERS):
{courses_text}
""".strip()


def _build_structured_analysis(job_title: str, ratings: list[dict], gap, flat_courses: list[dict]) -> dict:
    tech_set = {s.lower().strip() for s in gap.required_technical}
    matched_skills = []
    for rating in ratings:
        if rating["rating"] != "matched":
            continue
        skill = rating["skill"]
        matched_skills.append({
            "skill": skill,
            "type": "technical" if skill.lower().strip() in tech_set else "soft",
            "evidence": rating.get("evidence", ""),
        })

    partial_skills = []
    for rating in ratings:
        if rating["rating"] != "partial":
            continue
        skill = rating["skill"]
        partial_skills.append({
            "name": skill,
            "category": "technical" if skill.lower().strip() in tech_set else "soft",
            "evidence": rating.get("evidence", ""),
        })

    missing_soft = [
        rating["skill"]
        for rating in ratings
        if rating["rating"] == "missing" and rating["skill"].lower().strip() not in tech_set
    ]

    missing_skills = []
    for skill in gap.missing_technical:
        missing_skills.append({"name": skill, "category": "technical", "weight": 1.0})
    for skill in missing_soft:
        missing_skills.append({"name": skill, "category": "soft", "weight": 0.5})

    return {
        "job_title": job_title,
        "match_score": gap.match_score,
        "match_percent": gap.match_percent,
        "total_required": gap.total_required,
        "total_matched": gap.total_matched,
        "matched_skills": matched_skills,
        "missing_technical": gap.missing_technical,
        "missing_soft": missing_soft,
        "recommended_courses": flat_courses,
        "student_skills_count": len(gap.resume_skills),
        # extra fields for the new judge-based flow
        "total_partial": len(partial_skills),
        "total_missing": len(missing_skills),
        "partial_skills": partial_skills,
        "missing_skills": missing_skills,
        "soft_skills_scored": False,
    }


@router.post("/analyze-resume")
async def analyze_from_resume(
    file: Optional[UploadFile] = File(default=None),
    target_job: str = Form(default=""),
    job_description: str = Form(default=""),
    completed_courses: str = Form(default="[]"),
    program_id: str = Form(default="msba"),
):
    try:
        completed_list = _json.loads(completed_courses)
    except Exception:
        completed_list = []
    completed_ids = {c.strip().upper() for c in completed_list if isinstance(c, str) and c.strip()}

    resume_text = ""
    has_resume_file = file is not None
    if has_resume_file:
        file_bytes = await file.read()
        mime_type = file.content_type or "application/pdf"
        parse_result = parse_resume(file_bytes, mime_type)
        if parse_result.get("error") or not parse_result.get("raw_text", "").strip():
            error_msg = parse_result.get("error") or "Could not extract text from resume."
            return {"error": error_msg, "structured_analysis": None, "response": error_msg}
        resume_text = parse_result["raw_text"]
    elif not completed_ids:
        msg = "Please upload a resume or provide completed courses."
        return {"error": msg, "structured_analysis": None, "response": msg}

    if target_job.strip():
        role_data = _load_role_from_skills_json(target_job.strip())
        if not role_data:
            role_data = extract_skills_from_jd(target_job.strip())
            role_data["job_title"] = target_job.strip()
    elif job_description.strip():
        role_data = extract_skills_from_jd(job_description.strip())
    else:
        msg = "Please provide either a target job title or a job description."
        return {"error": msg, "structured_analysis": None, "response": msg}

    job_title = role_data.get("job_title", "Target Role")
    all_required_skills = (role_data.get("technical_skills") or []) + (role_data.get("soft_skills") or [])
    if not all_required_skills:
        msg = "Could not identify required skills for this role. Try pasting the full job description instead."
        return {"error": msg, "structured_analysis": None, "response": msg}

    if has_resume_file:
        ratings = extract_and_rate_skills(resume_text, all_required_skills)
        resume_skills_for_scoring = _ratings_to_resume_skills(ratings)
    else:
        course_catalog = load_courses_for_program(program_id or "msba")
        completed_course_skills = skills_from_completed_courses(sorted(completed_ids), course_catalog)
        completed_skill_set = {s.lower().strip() for s in completed_course_skills}
        ratings = []
        for req in all_required_skills:
            if req.lower().strip() in completed_skill_set:
                ratings.append({"skill": req, "rating": "matched", "evidence": "Completed coursework"})
            else:
                ratings.append({"skill": req, "rating": "missing", "evidence": ""})
        resume_skills_for_scoring = completed_course_skills

    partial_tech = [
        r["skill"] for r in ratings
        if r["rating"] == "partial" and r["skill"] in (role_data.get("technical_skills") or [])
    ]

    gap = compute_gap(
        resume_skills=resume_skills_for_scoring,
        required_technical=role_data.get("technical_skills") or [],
        # Score should reflect technical fit only; soft skills are shown as guidance.
        required_soft=[],
        partial_technical=partial_tech,
    )

    missing_tech = [r["skill"] for r in ratings if r["rating"] == "missing" and r["skill"] in (role_data.get("technical_skills") or [])]

    _, flat_courses = _get_course_recommendations(
        missing_technical=missing_tech,
        partial_technical=partial_tech,
        completed_ids=completed_ids,
        program_id=program_id or "msba",
    )

    narrative_context = _build_narrative_context(
        job_title=job_title,
        ratings=ratings,
        gap=gap,
        completed_ids=completed_ids,
        flat_courses=flat_courses,
    )

    llm_result = safe_chat(
        "skills_gap",
        system_prompt=_NARRATIVE_SYSTEM,
        messages=[{"role": "user", "content": narrative_context}],
    )

    structured = _build_structured_analysis(job_title, ratings, gap, flat_courses)
    return {
        "response": llm_result["text"],
        "corrections": llm_result.get("corrections", []),
        "removed": llm_result.get("removed", []),
        "structured_analysis": structured,
        "resume_text_length": len(resume_text),
        "confidence_warning": None,
    }


class FollowUpRequest(BaseModel):
    message: str
    conversation_history: list[dict] = []
    structured_analysis: dict | None = None
    completed_courses: list[str] = []
    course_history: list[dict] = []
    program_id: str = "msba"


_FOLLOWUP_SYSTEM = """
You are a skills gap advisor for graduate students at UT Dallas.

You have already performed a gap analysis for this student. The prior results
are provided below. Answer their follow-up questions about:
- Which missing skills to prioritize and why
- How to build a specific skill efficiently
- Which recommended course to take first
- How this role compares to similar roles
- Next steps given their current skill level

If asked about degree planning (credits, scheduling, graduation requirements):
  Redirect: "For degree planning, please switch to the Degree Planner."

If asked about career paths unrelated to the gap analysis:
  Redirect: "For broader career guidance, the Career Mentor is better suited for that."
""".strip()


@router.post("/analyze")
def analyze_followup(request: FollowUpRequest):
    from_history: list[str] = []
    if isinstance(request.course_history, list):
        for item in request.course_history:
            if isinstance(item, dict) and isinstance(item.get("course"), str):
                from_history.append(item["course"])

    validation = validate_course_list(list(request.completed_courses or []) + from_history)
    _ = {c["course_id"].upper() for c in validation["valid"]}

    system = _FOLLOWUP_SYSTEM
    if request.structured_analysis:
        sa = request.structured_analysis
        matched_names = ", ".join(s.get("name", s.get("skill", "")) for s in sa.get("matched_skills", []))
        missing_names = ", ".join(s.get("name", "") for s in sa.get("missing_skills", []))
        partial_names = ", ".join(s.get("name", "") for s in sa.get("partial_skills", []))
        rec_names = ", ".join(
            f"{r.get('course_id')} ({r.get('skill_addressed')})"
            for r in sa.get("recommended_courses", [])
        )
        system += f"""

PRIOR ANALYSIS — reference this when answering:
Role: {sa.get('job_title', 'Unknown')}
Match: {sa.get('match_percent', 0)}%
Matched skills: {matched_names or 'None'}
Partial skills (on resume but need depth): {partial_names or 'None'}
Missing skills: {missing_names or 'None'}
Recommended courses: {rec_names or 'None'}
"""

    messages = list(request.conversation_history) + [{"role": "user", "content": request.message}]
    result = safe_chat("skills_gap_followup", system_prompt=system, messages=messages)
    return {
        "response": result["text"],
        "corrections": result.get("corrections", []),
        "removed": result.get("removed", []),
    }
