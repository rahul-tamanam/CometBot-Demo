from fastapi import APIRouter
from pydantic import BaseModel
import json
import os
from backend.services.llm_client import safe_chat
from backend.services.pinecone_client import (
    get_embedding,
    sanitize,
    query_courses_by_embedding,
    query_job_role_by_embedding,
    query_certificates_by_embedding,
)
from backend.services.validator import validate_course_list
from backend.services.program_rules import get_program_name
from backend.services.course_loader import load_courses_for_program

def _load_certs_for_program(program_id: str) -> list[dict]:
    """Load certificates for the given program. Returns empty list if file not found."""
    pid = (program_id or "msba").strip().lower()
    certs_path = os.path.join(
        os.path.dirname(__file__), "..", "data", "certificates",
        f"{pid}_certs.json"
    )
    if not os.path.exists(certs_path):
        return []
    with open(certs_path, encoding="utf-8") as f:
        return json.load(f)

router = APIRouter()

def _match_certificates(job_role: dict, program_certs: list[dict], top_k: int = 6) -> list:
    if not job_role:
        return []
    all_job_skills = [s.lower() for s in
                      job_role.get("technical_skills", []) +
                      job_role.get("soft_skills", [])]
    scored = []
    for cert in program_certs:
        score = 0
        for cert_skill in cert.get("skills_taught", []):
            cs = cert_skill.lower()
            if any(cs in js or js in cs for js in all_job_skills):
                score += 1
        if score > 0:
            scored.append((score, cert))
    scored.sort(key=lambda x: x[0], reverse=True)
    fallback = [c for _, c in scored[:top_k]]
    for cert in fallback:
        cert.setdefault("fit_label", "Relevant fit")
        cert.setdefault(
            "fit_reason",
            "This certificate aligns with several skills expected for this target role.",
        )
    return fallback

def _normalize_course_id(course_id: str) -> str:
    return (course_id or "").strip().upper()


def _extract_history_courses(course_history: list[dict]) -> list[str]:
    out: list[str] = []
    if not isinstance(course_history, list):
        return out
    for item in course_history:
        if isinstance(item, dict) and isinstance(item.get("course"), str):
            out.append(item["course"])
    return out


def _build_certificate_recommendations(certs: list, completed_ids: list[str]) -> list[dict]:
    completed_set = {_normalize_course_id(c) for c in completed_ids if _normalize_course_id(c)}
    recommendations: list[dict] = []

    for cert in certs:
        completed_for_cert: list[str] = []
        remaining_groups: list[list[str]] = []

        for group in cert.get("course_id", []):
            normalized_group = [_normalize_course_id(cid) for cid in group if _normalize_course_id(cid)]
            if not normalized_group:
                continue
            done_in_group = [cid for cid in normalized_group if cid in completed_set]
            if done_in_group:
                completed_for_cert.append(done_in_group[0])
            else:
                remaining_groups.append(normalized_group)

        recommendations.append({
            **cert,
            "completed_courses_for_certificate": completed_for_cert,
            "remaining_course_groups": remaining_groups,
            "remaining_course_count": len(remaining_groups),
            "is_eligible_now": len(remaining_groups) == 0,
            "readiness_note": (
                "You are already eligible for this certificate based on completed courses."
                if len(remaining_groups) == 0
                else (
                    f"You are close. Complete {len(remaining_groups)} more requirement group(s) to become eligible."
                    if len(remaining_groups) <= 2
                    else f"You have {len(remaining_groups)} requirement group(s) remaining to become eligible."
                )
            ),
        })

    return recommendations


def _format_cert_context(
    certs: list,
    has_profile_courses: bool,
    course_title_by_id: dict[str, str] | None = None,
) -> str:
    if not certs:
        return "No certificates closely matched this role."
    course_title_by_id = course_title_by_id or {}

    def fmt_course(cid: str) -> str:
        title = course_title_by_id.get(_normalize_course_id(cid), "").strip()
        return f"{cid} — {title}" if title else cid

    blocks = []
    for cert in certs:
        required_groups = []
        for group in cert["course_id"]:
            if len(group) == 1:
                required_groups.append(f"- Required: {fmt_course(group[0])}")
            else:
                options = " OR ".join(fmt_course(cid) for cid in group)
                required_groups.append(f"- Pick ONE: {options}")
        remaining_groups = cert.get("remaining_course_groups", [])
        remaining_groups_lines = []
        if remaining_groups:
            for g in remaining_groups:
                if len(g) == 1:
                    remaining_groups_lines.append(f"- Required: {fmt_course(g[0])}")
                else:
                    options = " OR ".join(fmt_course(cid) for cid in g)
                    remaining_groups_lines.append(f"- Pick ONE: {options}")
        else:
            remaining_groups_lines.append("None — all requirements already satisfied.")
        completed_text = ", ".join(cert.get("completed_courses_for_certificate", [])) or "None"
        blocks.append(
            f"Certificate: {cert['cert_title']}\n"
            f"Total Credits: {cert['total_credits']}\n"
            f"Required Course Groups:\n" + "\n".join(required_groups) + "\n"
            f"Skills Covered: {', '.join(cert['skills_taught'])}\n"
            f"Career Fit Level: {cert.get('fit_label', 'Relevant fit')}\n"
            f"Career Fit Rationale: {cert.get('fit_reason', 'This certificate supports role-readiness for the target job.')}\n"
            f"Completed Toward This Certificate: {completed_text}\n"
            f"Remaining Requirement Groups:\n" + "\n".join(remaining_groups_lines) + "\n"
            f"Eligible Now: {'Yes' if cert.get('is_eligible_now') else 'No'}\n"
            f"Eligibility Note: {cert.get('readiness_note', '')}"
        )
    profile_note = (
        "Student profile course history: none provided. Treat this as a new student with no completed courses."
        if not has_profile_courses
        else "Student profile course history was provided and already applied to certificate eligibility checks."
    )
    return f"{profile_note}\n\n" + "\n\n".join(blocks)

SYSTEM_PROMPT = """
You are a career mentor for MSBA students at UT Dallas.

Your ONLY purpose is to provide qualitative career guidance including:
- Explaining what specific job roles involve day to day
- Describing the technical skills required for a role and why they matter
- Describing the soft skills required for a role and why they matter
- Advising on career trajectories and how roles progress over time
- Comparing similar roles (e.g. Data Analyst vs Data Scientist)
- Explaining industry trends and what employers look for

You will be given the closest matching job role with its required skills
and relevant courses from the catalog.

When recommending courses always reference specific course IDs and titles
from the provided data only. Never invent course IDs.

STRICT BOUNDARIES — you do NOT:
- Help with degree planning or credit requirements
- Perform skills gap analysis
- Give specific GPA or admissions advice

If asked about these topics redirect the student:
"For degree planning please use the Degree Planner component.
For a detailed skills gap analysis please use the Skills Gap Analyzer."

Be encouraging, honest, and conversational.

Write plain text only: no Markdown (no # headings, **bold**, *italics*, --- rules, or code fences).
Use short lines and "- " bullets when listing items.

PROGRAM CERTIFICATES:
You will be given 1-2 certificates from the student's program that best match their target role.
- Only reference certificates that appear in the RELEVANT CERTIFICATES section below.
- Never invent certificate names or suggest certificates from a different program.
- Recommend the most relevant certificate(s) and explain which skills they build and why those skills matter for the role.
- For course groups shown as (COURSE A or COURSE B), tell the student they may take either one.
- Mention total credits so the student understands the commitment.
- If no certificate is a strong fit, say so honestly rather than forcing a recommendation.
"""

class ChatRequest(BaseModel):
    message: str
    conversation_history: list[dict] = []
    completed_courses: list[str] = []
    student_type: str | None = None
    course_history: list[dict] = []  # [{course: str, semester: str}]
    program_id: str = "msba"

@router.post("/chat")
def career_mentor_chat(request: ChatRequest):
    from_history = _extract_history_courses(request.course_history)
    validation = validate_course_list(list(request.completed_courses or []) + from_history)
    valid_completed = list(dict.fromkeys(c["course_id"] for c in validation["valid"]))

    # Step 1 — embed query once (avoid duplicate embedding work)
    program_id = (request.program_id or "msba").strip().lower()
    program_certs = _load_certs_for_program(program_id)
    allowed_cert_titles = {
        (c.get("cert_title") or "").strip().lower()
        for c in program_certs
        if (c.get("cert_title") or "").strip()
    }
    program_courses = load_courses_for_program(program_id)
    course_title_by_id = {
        _normalize_course_id(c.get("course_id", "")): (c.get("title", "") or "").strip()
        for c in program_courses
        if c.get("course_id")
    }
    embedding = get_embedding(sanitize(request.message))

    # Step 2 — retrieve closest job role + relevant courses
    job_role = query_job_role_by_embedding(embedding)
    relevant_courses = query_courses_by_embedding(
        embedding,
        top_k=8,
        program_id=program_id,
    )
    cert_query_parts = [request.message]
    if job_role:
        cert_query_parts.extend([job_role.get("job_title", "")] + job_role.get("technical_skills", []))
    cert_query_text = " ".join([p for p in cert_query_parts if p]).strip()

    matched_certs = []
    if cert_query_text:
        try:
            cert_embedding = get_embedding(sanitize(cert_query_text))
            matched_certs = query_certificates_by_embedding(cert_embedding, top_k=6)
            # Keep certificate retrieval logic unchanged, but enforce current program scope.
            if allowed_cert_titles:
                matched_certs = [
                    cert for cert in matched_certs
                    if (cert.get("cert_title") or "").strip().lower() in allowed_cert_titles
                ]
        except Exception:
            matched_certs = []
    if not matched_certs:
        matched_certs = _match_certificates(job_role, program_certs)

    certificate_recommendations = _build_certificate_recommendations(matched_certs, valid_completed)
    certs_context = _format_cert_context(
        certificate_recommendations,
        has_profile_courses=bool(valid_completed),
        course_title_by_id=course_title_by_id,
    )

    # Step 3 — build context
    job_context = ""
    if job_role:
        job_context = f"""
CLOSEST MATCHING JOB ROLE:
Title: {job_role['job_title']}
Match confidence: {job_role['score']}
Technical Skills Required: {', '.join(job_role['technical_skills'])}
Soft Skills Required: {', '.join(job_role['soft_skills'])}
        """.strip()

    courses_context = "\n\n".join([
        f"Course ID: {c['course_id']}\n"
        f"Title: {c['title']}\n"
        f"Type: {c['course_type']} | Credits: {c.get('credits', 3)}\n"
        f"Skills Taught: {', '.join(c.get('skills_taught') or []) or 'N/A'}"
        for c in relevant_courses
    ])

    program_name = get_program_name(program_id)
    system_prompt_with_context = (
        SYSTEM_PROMPT
        .replace("MSBA students at UT Dallas", f"{program_name} students at UT Dallas")
        .replace("MSBA CERTIFICATES", f"{program_name} CERTIFICATES")
        + "\n\n"
        f"{job_context}\n\n"
        f"RELEVANT COURSES FROM {program_name.upper()} CATALOG ONLY:\n\n{courses_context}\n\n"
        f"RELEVANT {program_name.upper()} CERTIFICATES:\n\n{certs_context}"
    )

    # Step 4 — conversation
    messages = request.conversation_history + [
        {"role": "user", "content": request.message}
    ]

    result = safe_chat(
        "career_mentor",
        system_prompt=system_prompt_with_context,
        messages=messages,
    )

    return {
        "response":             result["text"],
        "corrections":          result["corrections"],
        "removed":              result["removed"],
        "job_role":             job_role,
        "matched_certificates": certificate_recommendations,
        "valid_completed_courses": valid_completed,
        "invalid_profile_courses": validation.get("invalid", []),
    }