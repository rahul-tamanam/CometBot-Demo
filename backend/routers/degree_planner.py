import json
import os
import re
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from neo4j.exceptions import ServiceUnavailable, AuthError
from backend.services.llm_client import safe_chat
from backend.services.pinecone_client import query_courses
from backend.services.neo4j_client import (
    get_valid_next_courses,
    get_degree_progress,
    check_prerequisites_met
)
from backend.services.validator import (
    validate_course_list,
    extract_course_ids,
    resolve_course_input,
)
from backend.services.program_rules import (
    get_credit_requirements,
    get_only_one_of_these_groups,
    get_program_name,
    get_core_elective_rules,
)
from backend.services.course_loader import load_courses_for_program, load_all_courses


# ── Structured response schema ────────────────────────────────────────────────
# The /chat endpoint returns this Pydantic model so the frontend can render
# rich UI components (progress bar, course cards, semester timeline) without
# re-parsing the narrative text. All existing RAG / Neo4j / Pinecone logic is
# preserved — only the return shape is formalized.

class CourseCard(BaseModel):
    course_id: str
    title: str
    course_type: str          # "Core" or "Elective"
    credits: int              # always 3 for MSBA catalog
    is_completed: bool
    prerequisites_met: bool


class SemesterBlock(BaseModel):
    label: str                # e.g. "Fall 2025" or "Semester 1"
    courses: list[CourseCard]


class ProgressData(BaseModel):
    core_completed_credits: int
    core_remaining_credits: int
    core_completed_count: int
    core_remaining_count: int
    elective_completed_credits: int
    elective_remaining_credits: int
    elective_completed_count: int
    elective_remaining_count: int
    total_completed_credits: int
    total_remaining_credits: int
    total_completed_count: int
    total_remaining_count: int
    percent_complete: float


class DegreePlannerResponse(BaseModel):
    narrative: str                          # LLM generated conversational response
    progress: ProgressData                  # pre-computed progress data
    recommended_courses: list[CourseCard]   # courses LLM picked from remaining lists
    semester_plan: list[SemesterBlock]      # populated only for plan requests
    remaining_core: list[CourseCard]        # full remaining core list
    remaining_elective: list[CourseCard]    # full remaining elective list
    choice_group_notes: list[str]           # plain language only-one-of notes
    invalid_courses: list[str]              # course IDs that failed validation
    corrections: list[dict]                 # course ID corrections made


def _course_ids_from_assistant_messages(conversation_history: list[dict]) -> list[str]:
    """
    Course IDs that already appeared in prior assistant replies (e.g. semester plans).
    Treat these as part of the student's plan so Neo4j eligibility/progress matches the chat.
    """
    collected: list[str] = []
    seen: set[str] = set()
    for m in conversation_history or []:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        content = m.get("content")
        if not isinstance(content, str) or not content.strip():
            continue
        for raw_id in extract_course_ids(content):
            cid = raw_id.strip().upper().replace("  ", " ")
            if cid not in seen:
                seen.add(cid)
                collected.append(raw_id.strip())
    return collected

router = APIRouter()

# Global maps built from ALL courses — used by validator helpers.
# Per-request maps are built inside each handler from program-scoped courses.
_ALL_COURSES_GLOBAL = load_all_courses()
COURSE_MAP = {c["course_id"].strip().upper(): c for c in _ALL_COURSES_GLOBAL}
COURSE_TYPE_BY_ID = {
    cid: (c.get("course_type") or "").strip()
    for cid, c in COURSE_MAP.items()
}
COURSE_CREDITS_BY_ID = {
    cid: float(c.get("credits") if c.get("credits") is not None else 3)
    for cid, c in COURSE_MAP.items()
}


def _cap_percent_complete(pct: float) -> float:
    """Cap displayed completion at 100% when students have extra credits beyond requirements."""
    try:
        x = float(pct)
    except (TypeError, ValueError):
        return 0.0
    return min(100.0, max(0.0, x))


def _degree_progress_overshoot_lines(program_id: str, progress: dict) -> tuple[str, str]:
    """
    When completed credits exceed the degree minimum, avoid '39 / 36' style lines — models
    divide and invent percentages like 108%. Return (warning_block, total_credits_line).
    """
    rules = get_credit_requirements(program_id)
    total_req = float(rules.get("total_credits") or 36)
    tc = float(progress.get("total_completed") or 0)
    pct = float(progress.get("percent_complete") or 0)
    tr = int(total_req)
    if tc <= total_req:
        return "", f"- Total credits completed: {progress['total_completed']} / {tr}"
    warning = (
        f"CRITICAL (read before replying): This student has MORE than {tr} degree credits applied. "
        f"You MUST NOT compute or say completion as (credits ÷ {tr})×100 — never mention figures like 108% or 108.3%. "
        f"The ONLY completion percentage you may quote is {pct}% (never above 100%). "
        f"You may say they completed more than the minimum credit requirement; do not invent a higher percent.\n"
    )
    line = (
        f"- Total credits toward the degree: {progress['total_completed']} credits "
        f"(minimum required for graduation: {tr} credits — requirement satisfied)"
    )
    return warning, line


def _overall_total_line(progress: dict, program_id: str) -> str:
    """Single line for OVERALL total credits — avoids '39 of 36' when overshooting."""
    rules = get_credit_requirements(program_id)
    total_req = float(rules.get("total_credits") or 36)
    tc = float(progress.get("total_completed") or 0)
    tr = int(total_req)
    if tc > total_req:
        return (
            f"  Total completed : {progress['total_completed']} credits "
            f"(minimum degree requirement {tr} credits satisfied — official percent is capped at "
            f"{progress['percent_complete']}%)"
        )
    return f"  Total completed : {progress['total_completed']} credits of {tr}"


def _sanitize_impossible_completion_percentages(text: str) -> str:
    """
    Models sometimes divide earned credits by minimum degree credits and emit values like 108.3%.
    Replace any percentage strictly above 100 in advisor prose with 100%.
    """

    def repl(match: re.Match) -> str:
        try:
            v = float(match.group(1))
        except ValueError:
            return match.group(0)
        if v > 100.0:
            return "100%"
        return match.group(0)

    return re.sub(r"\b(\d+(?:\.\d+)?)%", repl, text)


SYSTEM_PROMPT_TEMPLATE = """
You are CometBot, an academic advisor for the MSBA (Master of Science 
in Business Analytics and Artificial Intelligence) program at UTD.

{DEGREE_RULES}

YOUR ROLE:
You receive pre-computed degree progress and pre-computed course lists.
Your job is to explain these facts conversationally and make 
recommendations from the provided lists only.

RULES — follow every rule on every response without exception:
1. NEVER calculate, derive, or estimate any number. Every number is 
   already computed in the DEGREE PROGRESS section. Copy them exactly.
2. NEVER recommend a Core course to fill an Elective requirement.
3. NEVER recommend an Elective course to fill a Core requirement.
4. NEVER recommend a course not in the provided REMAINING lists.
5. NEVER recommend a course the student has already completed.
6. NEVER invent, guess, or paraphrase a course ID or course title.
   Use the exact course ID and exact title from the lists provided.
7. When a student asks how many courses or credits remain, read the 
   answer directly from DEGREE PROGRESS. Do not compute it yourself.
8. Only answer questions about course selection, degree progress, 
   prerequisites, and graduation planning.
   For career advice say: "Please use the Career Mentor for that."
   For skills questions say: "Please use the Skills Gap Analyzer for that."
9. NEVER compute degree completion as (credits completed ÷ minimum degree credits) × 100.
   Students may have extra credits beyond the minimum; the ONLY percentage you may ever state
   is the "Percent complete" value from the progress data (never above 100%). Never say "108%"
   or any figure over 100%, even if credits completed divided by 36 would suggest it.
""".strip()


def build_course_lists(
    valid_completed_ids: list[str],
    all_courses: list[dict],
    program_id: str = "msba",
) -> tuple[list[dict], list[dict], list[dict], dict, list[str]]:
    """
    Returns (remaining_core, remaining_core_elective, remaining_elective, progress, notes)
    """
    rules = get_credit_requirements(program_id)
    total_req = float(rules["total_credits"])
    core_req = float(rules["core_credits"])
    elec_req = float(rules["elective_credits"])

    completed_set = {(_normalize_id(x)) for x in (valid_completed_ids or [])}
    completed_ce_tracks: set[str] = set()
    for cid in completed_set:
        course = COURSE_MAP.get(cid)
        if course and (course.get("course_type") or "").lower() == "coreelective":
            track = course.get("course_track")
            if track:
                completed_ce_tracks.add(track)

    # Core remaining: all core catalog courses not completed.
    remaining_core = []
    for c in all_courses:
        cid = _normalize_id(c.get("course_id", ""))
        if not cid or cid in completed_set:
            continue
        if str(c.get("course_type", "")).lower() == "core":
            remaining_core.append(c)

    remaining_core_elective = []
    # Elective remaining: electives whose prereqs are met (Neo4j eligibility)
    eligible = get_valid_next_courses(list(completed_set), program_id=program_id)
    eligible_ids = {_normalize_id(c.get("course_id", "")) for c in eligible if c.get("course_id")}
    remaining_elective = []
    for c in all_courses:
        cid = _normalize_id(c.get("course_id", ""))
        if not cid or cid in completed_set:
            continue
        ctype = str(c.get("course_type", "")).lower()
        if ctype == "coreelective":
            track = c.get("course_track")
            if not track or track not in completed_ce_tracks:
                remaining_core_elective.append(c)
            continue
        if ctype != "elective":
            continue
        if cid in eligible_ids:
            remaining_elective.append(c)

    # Progress: compute from catalog types
    core_done = 0.0
    elec_done = 0.0
    for cid in completed_set:
        credits = float(COURSE_CREDITS_BY_ID.get(cid, rules["credits_per_course"]) or rules["credits_per_course"])
        if _course_is_core(cid):
            core_done += credits
        elif _course_is_elective(cid):
            elec_done += credits

    total_done = core_done + elec_done
    core_rem = max(0.0, core_req - core_done)
    elec_rem = max(0.0, elec_req - elec_done)
    total_rem = max(0.0, total_req - total_done)
    pct_raw = 0.0 if total_req <= 0 else round((total_done / total_req) * 100, 1)

    progress = {
        "total_completed": round(total_done, 1),
        "core_completed": round(core_done, 1),
        "elective_completed": round(elec_done, 1),
        "total_remaining": round(total_rem, 1),
        "core_remaining": round(core_rem, 1),
        "elective_remaining": round(elec_rem, 1),
        "percent_complete": _cap_percent_complete(pct_raw),
    }

    return remaining_core, remaining_core_elective, remaining_elective, progress, []


def _resolve_core_requirements(
    valid_completed_ids: list[str],
    all_courses: list[dict],
    program_id: str,
) -> dict:
    """
    Deterministically resolves the student's exact core requirement status.
    For MSITM: 3 Part A (fixed core) + 3 Part B (one per track) = 6 total mandatory core slots.
    For MSBA: all core courses are mandatory.
    Never delegates slot counting to the LLM.
    """
    from backend.services.program_rules import get_only_one_of_these_groups, get_core_elective_rules

    completed = {_normalize_id(x) for x in valid_completed_ids}
    only_one_groups = get_only_one_of_these_groups(program_id)
    only_one_sets = [frozenset(_normalize_id(x) for x in g) for g in only_one_groups]

    # Part A: Fixed Core courses
    # Each course is either a standalone required course or part of an only_one_of group.
    # One only_one_of group = one slot (student picks one from the group).
    core_courses = [
        c for c in all_courses
        if str(c.get("course_type", "")).lower() == "core"
    ]

    processed_groups: set[frozenset] = set()
    part_a_remaining: list[dict] = []
    part_a_completed: list[dict] = []
    part_a_total_slots = 0

    for c in core_courses:
        cid = _normalize_id(c.get("course_id", ""))
        if not cid:
            continue
        matching_group = next((g for g in only_one_sets if cid in g), None)

        if matching_group:
            if matching_group in processed_groups:
                continue
            processed_groups.add(matching_group)
            part_a_total_slots += 1

            group_done = matching_group & completed
            if group_done:
                done_cid = next(iter(group_done))
                done_course = next(
                    (x for x in all_courses if _normalize_id(x.get("course_id", "")) == done_cid),
                    {"course_id": done_cid, "title": done_cid, "credits": 3}
                )
                part_a_completed.append(done_course)
            else:
                options = [
                    x for x in all_courses
                    if _normalize_id(x.get("course_id", "")) in matching_group
                ]
                part_a_remaining.append({
                    "is_choice_group": True,
                    "options": options,
                    "credits": 3,
                })
        else:
            part_a_total_slots += 1
            if cid in completed:
                part_a_completed.append(c)
            else:
                part_a_remaining.append({
                    "is_choice_group": False,
                    "course_id": c["course_id"],
                    "title": c["title"],
                    "credits": c.get("credits", 3),
                })

    # Part B: CoreElective courses (MSITM track diversity)
    ce_rules = get_core_elective_rules(program_id)
    tracks_required = ce_rules.get("tracks_required", 0)

    ce_courses = [
        c for c in all_courses
        if str(c.get("course_type", "")).lower() == "coreelective"
    ]

    # Find which tracks the student has already satisfied
    completed_ce_by_track: dict[str, dict] = {}
    for c in ce_courses:
        cid = _normalize_id(c.get("course_id", ""))
        track = (c.get("course_track") or "").strip()
        if cid in completed and track and track not in completed_ce_by_track:
            completed_ce_by_track[track] = c

    tracks_done = set(completed_ce_by_track.keys())
    tracks_remaining_count = max(0, tracks_required - len(tracks_done))

    # Group remaining CE courses by track, excluding satisfied tracks
    part_b_remaining_by_track: dict[str, list[dict]] = {}
    for c in ce_courses:
        cid = _normalize_id(c.get("course_id", ""))
        track = (c.get("course_track") or "Unknown").strip()
        if track in tracks_done:
            continue
        if cid in completed:
            continue
        part_b_remaining_by_track.setdefault(track, []).append(c)

    # Totals
    total_core_slots = part_a_total_slots + tracks_required
    total_completed_slots = len(part_a_completed) + len(tracks_done)
    total_remaining_slots = total_core_slots - total_completed_slots

    return {
        # Part A
        "part_a_total_slots": part_a_total_slots,
        "part_a_remaining": part_a_remaining,
        "part_a_completed": part_a_completed,
        "part_a_slots_done": len(part_a_completed),
        "part_a_slots_remaining": len(part_a_remaining),
        # Part B
        "part_b_tracks_required": tracks_required,
        "part_b_tracks_done": len(tracks_done),
        "part_b_tracks_remaining": tracks_remaining_count,
        "part_b_completed_by_track": completed_ce_by_track,
        "part_b_remaining_by_track": part_b_remaining_by_track,
        # Totals
        "total_core_slots": total_core_slots,
        "total_completed_slots": total_completed_slots,
        "total_remaining_slots": total_remaining_slots,
    }


def _format_core_requirement_context(resolved: dict, program_id: str) -> str:
    """
    Converts pre-solved core requirement into an unambiguous LLM instruction block.
    The LLM reads this and narrates it — it does zero math.
    """
    is_itm = program_id.strip().lower() == "msitm"

    if not is_itm:
        return "CORE REQUIREMENT: Complete all remaining courses listed in REMAINING CORE COURSES below."

    lines: list[str] = []
    total = resolved["total_core_slots"]
    done = resolved["total_completed_slots"]
    remaining = resolved["total_remaining_slots"]

    lines.append("=" * 60)
    lines.append("CORE REQUIREMENT — PRE-COMPUTED. DO NOT RECALCULATE.")
    lines.append(
        f"The student has {total} mandatory core slots total: "
        f"{resolved['part_a_total_slots']} required courses (Part A) + "
        f"{resolved['part_b_tracks_required']} track courses (Part B)."
    )
    lines.append(
        f"Status: {done} of {total} core slots completed. "
        f"{remaining} core slots still required."
    )
    lines.append(f"ALL {total} slots are MANDATORY for graduation. Part B is not optional.")
    lines.append("=" * 60)
    lines.append("")

    lines.append(
        f"PART A — Required core courses "
        f"({resolved['part_a_slots_done']} of {resolved['part_a_total_slots']} completed):"
    )
    if resolved["part_a_completed"]:
        for c in resolved["part_a_completed"]:
            lines.append(f"  ✓ DONE: {c.get('course_id','')} — {c.get('title','')}")

    if resolved["part_a_remaining"]:
        for item in resolved["part_a_remaining"]:
            if item.get("is_choice_group"):
                opts = item["options"]
                opt_str = " OR ".join(f"{o['course_id']} — {o['title']}" for o in opts)
                lines.append(f"  ✗ NEEDED (pick ONE): {opt_str}")
            else:
                lines.append(
                    f"  ✗ NEEDED: {item['course_id']} | {item['title']} | {item['credits']} credits"
                )
    else:
        lines.append("  ✓ All Part A slots completed.")

    lines.append("")
    lines.append(
        f"PART B — Core track courses: pick exactly {resolved['part_b_tracks_required']} courses, "
        f"one from each of {resolved['part_b_tracks_required']} DIFFERENT tracks "
        f"({resolved['part_b_tracks_done']} of {resolved['part_b_tracks_required']} tracks completed):"
    )

    if resolved["part_b_completed_by_track"]:
        for track, c in resolved["part_b_completed_by_track"].items():
            lines.append(
                f"  ✓ DONE ({track}): {c.get('course_id','')} — {c.get('title','')}"
            )

    if resolved["part_b_remaining_by_track"]:
        lines.append(f"  Tracks still needed ({resolved['part_b_tracks_remaining']} remaining):")
        for track, courses in resolved["part_b_remaining_by_track"].items():
            opts = courses[:4]
            opt_str = " | ".join(f"{c['course_id']} — {c['title']}" for c in opts)
            lines.append(f"  ✗ NEEDED — pick one from '{track}' track: {opt_str}")
    else:
        lines.append("  ✓ All Part B track slots completed.")

    lines.append("")
    lines.append("-" * 60)
    lines.append("INSTRUCTIONS TO LLM — FOLLOW EXACTLY:")
    lines.append(f"1. The student needs {remaining} more core courses total before electives.")
    lines.append(
        f"2. When recommending next semester, fill Part A NEEDED slots first, "
        f"then fill Part B NEEDED slots (one per track) until all {total} core slots are complete."
    )
    lines.append(
        "3. If the student asks 'what should I take next semester' and all core slots "
        "are not done, always recommend enough courses to make progress on BOTH Part A and Part B."
    )
    lines.append(
        "4. NEVER describe Part B as optional, as 'additional', or as something to do 'later'. "
        "It is mandatory. The student cannot graduate without completing all Part B tracks."
    )
    lines.append(
        "5. NEVER use the word 'CoreElective'. Say 'core track course' or 'core requirement' instead."
    )
    lines.append(
        "6. For choice groups in Part A (pick ONE of X options), tell the student clearly "
        "they pick one — do not list both as required."
    )
    lines.append(
        "7. When listing a next-semester plan, present ALL recommended core courses "
        "(Part A + Part B picks) as one unified 'Core courses for next semester' list."
    )
    lines.append("-" * 60)
    return "\n".join(lines)


def _display_course_type(course_type: str, course_track: str = "") -> str:
    t = (course_type or "").strip().lower()
    if t == "coreelective":
        return f"Core — {course_track}" if course_track else "Core (track)"
    if t == "core":
        return "Core (required)"
    return (course_type or "").capitalize()


def _apply_only_one_of_constraints(
    completed_ids: list[str],
    remaining_core: list[dict],
    remaining_elective: list[dict],
) -> tuple[list[dict], list[dict], list[str]]:
    groups = get_only_one_of_these_groups("msba")
    completed = {_normalize_id(x) for x in completed_ids or []}
    notes: list[str] = []

    core_by_id = {_normalize_id(c.get("course_id", "")): c for c in remaining_core if c.get("course_id")}
    elec_by_id = {_normalize_id(c.get("course_id", "")): c for c in remaining_elective if c.get("course_id")}

    for g in groups:
        g_ids = [_normalize_id(x) for x in g]
        done = [x for x in g_ids if x in completed]
        if done:
            keep = done[0]
            for cid in g_ids:
                if cid != keep:
                    core_by_id.pop(cid, None)
                    elec_by_id.pop(cid, None)
            continue

        # none completed -> keep only first representative among remaining lists (if present)
        present = [cid for cid in g_ids if cid in core_by_id or cid in elec_by_id]
        if present:
            keep = present[0]
            for cid in present[1:]:
                core_by_id.pop(cid, None)
                elec_by_id.pop(cid, None)
            course_options: list[str] = []
            for cid in g_ids:
                course_obj = COURSE_MAP.get(cid)
                title = course_obj.get("title", cid) if course_obj else cid
                course_options.append(f"{cid} {title}")
            notes.append(
                "For this core requirement, you only need to complete ONE of the following courses — "
                "pick whichever best fits your background and goals:\n"
                + "\n".join(f"  • {opt}" for opt in course_options)
            )

    return list(core_by_id.values()), list(elec_by_id.values()), notes

class ChatRequest(BaseModel):
    message: str
    completed_courses: list[str] = []
    conversation_history: list[dict] = []
    student_type: str | None = None  # "new" | "current"
    interests: list[str] = []
    course_history: list[dict] = []  # [{course: str, semester: str}]
    program_id: str = "msba"

class PlanRequest(BaseModel):
    completed_courses: list[str] = []
    courses_per_semester: int = 3
    max_semesters: int = 8
    core_per_semester: int | None = None
    elective_per_semester: int | None = None
    interests: list[str] = []
    course_history: list[dict] = []  # [{course: str, semester: str}] for current students
    program_id: str = "msba"


# ── Semester labels (course_history → next term) ─────────────────────────────

_TERM_ORDER = {"spring": 0, "summer": 1, "fall": 2, "winter": 3}
_TERM_NAME = {0: "Spring", 1: "Summer", 2: "Fall", 3: "Winter"}


def _parse_semester_token(s: str):
    raw = (s or "").strip().lower()
    if not raw:
        return None
    m = re.search(r"\bsemester\s*(\d+)\b", raw) or re.search(r"\bsem\.?\s*(\d+)\b", raw)
    if m:
        return ("idx", int(m.group(1)))
    if re.fullmatch(r"\d+", raw):
        return ("idx", int(raw))
    m = re.search(r"\b(\d+)(?:st|nd|rd|th)\s+semester\b", raw)
    if m:
        return ("idx", int(m.group(1)))
    m = re.search(r"\b(fall|spring|summer|winter)\s+(\d{4})\b", raw)
    if m:
        season, year = m.group(1), int(m.group(2))
        if season in _TERM_ORDER:
            return ("cal", year, _TERM_ORDER[season])
    m = re.search(r"\b(\d{4})\s*(fall|spring|summer|winter)\b", raw)
    if m:
        year, season = int(m.group(1)), m.group(2)
        if season in _TERM_ORDER:
            return ("cal", year, _TERM_ORDER[season])
    return None


def _advance_cal_year_term(year: int, term_idx: int) -> tuple[int, int]:
    name = _TERM_NAME.get(term_idx, "Spring").lower()
    if name == "fall":
        return year + 1, 0
    if name == "spring":
        return year, 1
    if name == "summer":
        return year, 2
    if name == "winter":
        return year, 1
    return year + 1, 0


def _cal_label(y: int, tidx: int) -> str:
    return f"{_TERM_NAME.get(tidx, 'Spring')} {y}"


def _generate_forward_cal_labels(year: int, term_idx: int, n: int) -> list[str]:
    labels: list[str] = []
    y, t = year, term_idx
    for _ in range(max(1, n)):
        y, t = _advance_cal_year_term(y, t)
        labels.append(_cal_label(y, t))
    return labels


def _analyze_course_history(ch: list[dict]) -> dict:
    """
    From [{course, semester}, ...] build display lines and the next planning term.
    """
    rows_out: list[str] = []
    idx_vals: list[int] = []
    cal_vals: list[tuple[int, int]] = []

    if not isinstance(ch, list):
        ch = []

    for item in ch:
        if not isinstance(item, dict):
            continue
        c_raw = item.get("course")
        sem_raw = item.get("semester")
        if not isinstance(c_raw, str) or not isinstance(sem_raw, str):
            continue
        c_raw, sem_raw = c_raw.strip(), sem_raw.strip()
        if not c_raw or not sem_raw:
            continue
        resolved = resolve_course_input(c_raw)
        if resolved.get("corrected") and resolved.get("title"):
            cite = f"{resolved['corrected']} — {resolved['title']}"
        else:
            cite = c_raw

        tok = _parse_semester_token(sem_raw)
        if tok and tok[0] == "idx":
            idx_vals.append(tok[1])
            rows_out.append(f"- {cite} (took in Semester {tok[1]} — {sem_raw})")
        elif tok and tok[0] == "cal":
            y, ti = tok[1], tok[2]
            cal_vals.append((y, ti))
            rows_out.append(f"- {cite} (took in {_cal_label(y, ti)} — {sem_raw})")
        else:
            rows_out.append(f"- {cite} (took in {sem_raw})")

    result: dict = {
        "lines":            rows_out,
        "mode":             "none",
        "next_index":       None,
        "next_label":       None,
        "forward_labels":   [],
    }

    if idx_vals:
        mx = max(idx_vals)
        result["mode"] = "index"
        result["next_index"] = mx + 1
        result["next_label"] = f"Semester {mx + 1}"
        result["forward_labels"] = [f"Semester {mx + 1 + i}" for i in range(8)]
    elif cal_vals:
        latest = max(cal_vals, key=lambda t: (t[0], t[1]))
        y, tidx = latest
        result["mode"] = "calendar"
        result["forward_labels"] = _generate_forward_cal_labels(y, tidx, 8)
        result["next_label"] = result["forward_labels"][0] if result["forward_labels"] else None

    return result


def _headings_for_plan_rows(hist_info: dict, n_rows: int) -> list[str]:
    n = max(0, n_rows)
    if hist_info.get("forward_labels"):
        return hist_info["forward_labels"][:n]
    return [f"Semester {i}" for i in range(1, n + 1)]


def _format_prereqs(prereqs: list) -> str:
    if not prereqs:
        return "None"
    lines = []
    for i, group in enumerate(prereqs, start=1):
        if isinstance(group, list):
            lines.append(f"- Group {i} (take ONE): " + ", ".join(group))
        else:
            lines.append(f"- {group}")
    return "\n".join(lines)


def _format_prereqs_natural(prereqs: list, course_title: str) -> str:
    """
    Render prerequisites in a single conversational sentence for students
    who only asked "what are the prereqs for X?". Pairs each catalog ID
    with its title when known; falls back to just the ID otherwise.
    """
    if not prereqs:
        return (
            f"There are no specific prerequisite requirements "
            f"for {course_title}. You can enroll in this course "
            f"at any point in your program."
        )

    groups: list[str] = []
    for group in prereqs:
        if isinstance(group, list):
            readable: list[str] = []
            for cid in group:
                norm = str(cid).strip().upper()
                course_obj = COURSE_MAP.get(norm)
                if course_obj:
                    readable.append(f"{norm} {course_obj['title']}")
                else:
                    readable.append(norm)
            if len(readable) == 1:
                groups.append(readable[0])
            else:
                groups.append("one of: " + " or ".join(readable))
        else:
            norm = str(group).strip().upper()
            course_obj = COURSE_MAP.get(norm)
            if course_obj:
                groups.append(f"{norm} {course_obj['title']}")
            else:
                groups.append(norm)

    if len(groups) == 1:
        return (
            f"To enroll in {course_title}, you need to have "
            f"completed {groups[0]}."
        )
    joined = ", and ".join(groups)
    return (
        f"To enroll in {course_title}, you need to have "
        f"completed {joined}."
    )


def _parse_course_mix(message: str) -> dict | None:
    """
    Parse requests like:
      - "3 courses. 2 core and 1 elective"
      - "take 2 core + 1 elective"
      - "need 4 electives"
    Returns dict {total:int|None, core:int|None, elective:int|None} or None.
    """
    msg = (message or "").lower()
    total = None
    m_total = re.search(r"\b(\d+)\s*(?:courses|classes)\b", msg)
    if m_total:
        total = int(m_total.group(1))

    core = None
    elective = None
    m_core = (
        re.search(r"\b(\d+)\s+more\s+core(?:\s+courses?|\s+classes?)?\b", msg)
        or re.search(r"\banother\s+(\d+)\s+core(?:\s+courses?)?\b", msg)
        or re.search(r"\b(\d+)\s*core\b", msg)
    )
    m_elec = re.search(r"\b(\d+)\s+more\s+electives?\b", msg) or re.search(
        r"\b(\d+)\s*elective\b", msg
    )
    if m_core:
        core = int(m_core.group(1))
    if m_elec:
        elective = int(m_elec.group(1))

    if total is None and core is None and elective is None:
        return None
    return {"total": total, "core": core, "elective": elective}


def _extract_preferences_from_convo(conversation_history: list[dict], user_message: str) -> dict:
    """
    Extract planner preferences from the entire conversation so the final "plan my degree"
    request uses accumulated context.
    """
    texts: list[str] = []
    for m in conversation_history or []:
        if isinstance(m, dict) and isinstance(m.get("content"), str):
            texts.append(m["content"])
    texts.append(user_message or "")
    blob = "\n".join(texts)

    mix = _parse_course_mix(blob) or {}

    # Heuristic: if user mentions "per semester" but not explicit number, keep default 3.
    cps = mix.get("total") or 3

    # Try to capture any declared completed courses in text: course IDs, or titles (one per line / comma separated).
    completed_ids: set[str] = set()
    for cid in extract_course_ids(blob):
        completed_ids.add(cid.strip().upper())

    # Title-ish mentions: look for "completed/took/taken/finished" sentences and resolve parts.
    completed_markers = ("completed", "took", "taken", "finished", "already took", "already taken")
    for chunk in re.split(r"[\n;]+", blob):
        chunk = chunk.strip()
        if len(chunk) < 6:
            continue
        lower = chunk.lower()
        if not any(m in lower for m in completed_markers):
            continue

        # Split lists on commas and "and"
        for part in re.split(r",|\band\b|&", chunk, flags=re.IGNORECASE):
            part = part.strip()
            if len(part) < 6:
                continue
            r = resolve_course_input(part)
            if r.get("corrected"):
                completed_ids.add(str(r["corrected"]).strip().upper())

    # Focus query: last few user turns (used to rank electives by relevance, optional)
    user_turns = []
    for m in (conversation_history or [])[-6:]:
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str):
            user_turns.append(m["content"])
    focus_query = " ".join(user_turns + [user_message]).strip()

    return {
        "courses_per_semester": int(cps),
        "core_per_semester": mix.get("core"),
        "elective_per_semester": mix.get("elective"),
        "completed_from_convo": sorted(completed_ids),
        "focus_query": focus_query,
    }


def _only_one_group(course_id: str) -> tuple[str, ...] | None:
    course = COURSE_MAP.get(course_id.strip().upper())
    if not course:
        return None
    group = course.get("only_one_of_these") or []
    group = [g.strip().upper() for g in group if isinstance(g, str)]
    if len(group) <= 1:
        return None
    return tuple(sorted(group))

def _normalize_id(course_id: str) -> str:
    return (course_id or "").strip().upper()


def _course_is_core_elective(course_id: str) -> bool:
    return COURSE_TYPE_BY_ID.get(_normalize_id(course_id), "").lower() == "coreelective"


def _get_course_tracks(course_id: str, course_map: dict) -> list[str]:
    course = course_map.get(_normalize_id(course_id))
    if not course:
        return []
    return course.get("course_tracks") or ([course["course_track"]] if course.get("course_track") else [])


def _build_system_prompt(program_id: str) -> str:
    program_name = get_program_name(program_id)
    rules = get_credit_requirements(program_id)
    language_rules = """
RESPONSE LANGUAGE RULES — ENFORCE IN EVERY MESSAGE:
1. NEVER reference internal list names. Never say:
   - "REMAINING CORE COURSES list"
   - "REMAINING ELECTIVE COURSES list"
   - "STUDENT DEGREE PROGRESS section"
   - "the provided data"
   - "based on the context"
   - "according to the information given"
   - "from the list above/below"
   These are internal backend labels the student has never seen and should never hear.

2. When recommending core courses, simply say what the student should take next.
   Do not explain where you got the list from.

3. When transitioning to electives, do NOT say "choose from the remaining electives list".
   Instead, end with a natural invitation such as:
   - "For electives, what areas interest you most? For example, are you drawn more towards data engineering, marketing analytics, cybersecurity, or something else? Let me know and I can suggest courses that align with your goals."
   - "Once you have your core courses sorted, tell me what career path or skills you want to build and I'll suggest electives that fit."
   - "What industries or roles are you targeting? That will help me point you to the most relevant elective options."
   Pick whichever fits the conversation naturally. Never use all three.

4. Always speak directly to the student as a helpful advisor would in person.
   Warm, direct, and conversational. Never robotic or list-heavy unless the student asks for a full plan.

5. MAS 6102 — Professional Development: If SPECIAL PROGRAM REQUIREMENTS shows it as NOT completed,
   you may mention enrolling when discussing first-semester planning. If it shows COMPLETED on their profile,
   do not remind them every message or nag about enrollment — only discuss if they ask.

COMPLETION & PERCENT RULES:
6. Never tell the student a degree completion percentage above 100%. The data you receive is already capped at 100% when they have met or exceeded credit requirements.
7. When total credits remaining are 0 (degree credit requirements satisfied), open with a short, warm congratulations. You may write "Congratulations 🎓" once — placing the graduation cap emoji immediately after "Congratulations". Avoid leading with a percentage in that situation; focus on the milestone instead.
"""

    if program_id.strip().lower() == "msitm":
        degree_rules = f"""DEGREE RULES for {program_name}:
- 36 total credit hours to graduate
- 18 credit hours of CORE requirement = exactly 6 mandatory courses:
    3 courses from the required core list (Part A — no substitution except where noted)
    3 courses from the track list (Part B — one course per track, 3 different tracks required)
    BOTH Part A and Part B are mandatory. The student cannot graduate without all 6.
- 18 credit hours of ELECTIVE courses — free choice from any elective track
- Each course is 3 credit hours
"""
    else:
        degree_rules = f"""DEGREE RULES:
- {int(rules['total_credits'])} total credit hours required to graduate
- {int(rules['core_credits'])} credit hours must come from CORE courses
- {int(rules['elective_credits'])} credit hours must come from ELECTIVE courses
- Each course is 3 credit hours
- Only ONE course from an 'Only One Of These' group counts toward credit"""

    return (
        SYSTEM_PROMPT_TEMPLATE
        .replace("{PROGRAM_NAME}", program_name)
        .replace(
            "MSBA (Master of Science \nin Business Analytics and Artificial Intelligence)",
            f"{program_name}",
        )
        .replace("{DEGREE_RULES}", degree_rules)
        + "\n\n"
        + language_rules
    )


def _enrich_course_record(c: dict) -> dict:
    """
    Use MSBA catalog as source of truth for Type/title (Neo4j/Pinecone can drift or be incomplete).
    """
    cid = _normalize_id(str(c.get("course_id", "")))
    if not cid or cid not in COURSE_MAP:
        return c
    canon = COURSE_MAP[cid]
    out = dict(c)
    out["course_id"] = canon.get("course_id", cid)
    out["course_type"] = canon.get("course_type", out.get("course_type"))
    out["title"] = canon.get("title", out.get("title"))
    out["credits"] = canon.get("credits", out.get("credits", 3))
    out["description"] = canon.get("description", out.get("description", ""))
    out["skills_taught"] = canon.get("skills_taught", out.get("skills_taught") or [])
    out["only_one_of_these"] = canon.get("only_one_of_these", out.get("only_one_of_these") or [])
    return out


def _detect_requested_course_type(message: str) -> str | None:
    """
    Detect core-only vs elective-only recommendation requests without brittle substring rules.

    Old logic required 'core' in the message AND 'elective' absent — that failed for phrases like
    'core courses, no electives', which then sent a mixed course list to the model.
    """
    m = (message or "").lower()
    if not m.strip():
        return None

    only_core = bool(
        re.search(r"\b(only|just)\s+cores?\b", m)
        or re.search(r"\bcores?\s+only\b", m)
    )
    only_elective = bool(
        re.search(r"\b(only|just)\s+electives?\b", m)
        or re.search(r"\belectives?\s+only\b", m)
    )
    exclude_elective = bool(
        re.search(r"\b(without|avoid|skip)\s+electives?\b", m)
        or re.search(r"\b(don't|do not|dont)\s+want\s+electives?\b", m)
    )
    exclude_core = bool(
        re.search(r"\b(without|avoid|skip)\s+cores?\b", m)
        or re.search(r"\b(don't|do not|dont)\s+want\s+cores?\b", m)
    )

    has_core_word = bool(re.search(r"\bcores?\b", m))
    has_elective_word = bool(re.search(r"\belectives?\b", m))

    core_phrase = bool(
        re.search(r"\bcores?\s+(courses?|classes?|options?|pick|recommendations?)\b", m)
        or re.search(r"\b(core|required)\s+(courses?|classes?|requirements?)\b", m)
        or re.search(r"\brequired\s+cores?\b", m)
    )
    elective_phrase = bool(
        re.search(r"\belectives?\s+(courses?|classes?|options?|pick|recommendations?)\b", m)
        or re.search(r"\boptional\s+electives?\b", m)
    )

    comparing = bool(re.search(r"\b(vs\.?|versus|difference|differences|compare)\b", m))

    if only_elective or exclude_core:
        if only_core or exclude_elective:
            return None
        return "Elective"
    if only_core or exclude_elective:
        return "Core"

    if has_core_word and has_elective_word:
        if comparing:
            return None
        if core_phrase and not elective_phrase:
            return "Core"
        if elective_phrase and not core_phrase:
            return "Elective"
        return None

    if core_phrase or (has_core_word and not has_elective_word):
        return "Core"
    if elective_phrase or (has_elective_word and not has_core_word):
        return "Elective"
    return None


def _course_is_core(course_id: str) -> bool:
    return COURSE_TYPE_BY_ID.get(_normalize_id(course_id), "").lower() == "core"

def _course_is_elective(course_id: str) -> bool:
    return COURSE_TYPE_BY_ID.get(_normalize_id(course_id), "").lower() == "elective"


def _profile_course_audit_for_prompt(valid_completed: list[str], validation: dict) -> str:
    """
    Explain how profile/history inputs map to degree progress so the model does not equate
    "N courses in Course History" with "N × 3 core credits".
    """
    invalid = validation.get("invalid") or []
    if not valid_completed and not invalid:
        return ""

    lines: list[str] = []

    if valid_completed:
        lines.append(
            "PROFILE COURSE AUDIT — recognized completed courses (these feed STUDENT DEGREE PROGRESS totals):"
        )
        for cid in valid_completed:
            cid_n = _normalize_id(cid)
            c = COURSE_MAP.get(cid_n) or {}
            title = (c.get("title") or "").strip()
            typ = (c.get("course_type") or "unknown").strip()
            cr = float(COURSE_CREDITS_BY_ID.get(cid_n, 3.0))
            if _course_is_core(cid_n):
                bucket = "core"
            elif _course_is_elective(cid_n):
                bucket = "elective"
            else:
                bucket = "neither (unexpected)"
            title_bit = f" — {title}" if title else ""
            lines.append(f"  • {cid_n}{title_bit} | catalog: {typ} | {cr:g} cr counts toward {bucket}")

    unfound = [inv for inv in invalid if not inv.get("corrected")]
    if unfound:
        lines.append(
            "PROFILE COURSE AUDIT — not in planner catalog (excluded from degree progress; 0 cr until ID is fixed or catalog is updated):"
        )
        for inv in unfound:
            lines.append(f'  • "{inv.get("original", "")}"')

    fuzzy = [inv for inv in invalid if inv.get("corrected") and not inv.get("valid")]
    if fuzzy:
        lines.append("PROFILE COURSE AUDIT — input was normalized to a catalog ID for degree math:")
        for inv in fuzzy:
            lines.append(f'  • "{inv.get("original", "")}" → {inv.get("corrected")}')

    lines.append(
        "Each recognized course contributes its catalog credit hours to core OR elective based on catalog type — not based on the student's label or the number of Course History rows alone."
    )
    return "\n".join(lines)


def _prereqs_met(course_id: str, completed: set[str]) -> bool:
    course = COURSE_MAP.get(_normalize_id(course_id))
    if not course:
        return False
    prereqs = course.get("prerequisites") or []
    if not prereqs:
        return True
    for group in prereqs:
        if isinstance(group, list):
            group_ids = {_normalize_id(x) for x in group}
            if not (group_ids & completed):
                return False
        else:
            if _normalize_id(group) not in completed:
                return False
    return True


def _resolve_special_requirements(
    valid_completed_ids: list[str],
    program_id: str,
) -> dict:
    """
    Deterministically resolves all special program requirements:
    - Non-credit prerequisites (MAS 6102, OPRE 6303)
    - Internship requirement — tracks eligibility, completion, and credit impact
    Returns resolved facts the LLM narrates verbatim. No logic delegated to LLM.
    """
    from backend.services.program_rules import (
        get_required_non_credit,
        get_conditional_prerequisites,
        get_internship_rules,
    )

    completed = {_normalize_id(x) for x in valid_completed_ids}

    required_non_credit = get_required_non_credit(program_id)
    non_credit_status: list[dict] = []
    for cid in required_non_credit:
        nid = _normalize_id(cid)
        non_credit_status.append({
            "course_id": cid,
            "completed": nid in completed,
        })

    conditional_prereqs = get_conditional_prerequisites(program_id)
    conditional_status: list[dict] = []
    for prereq in conditional_prereqs:
        cid = _normalize_id(prereq.get("course_id", ""))
        conditional_status.append({
            **prereq,
            "completed": cid in completed,
        })

    internship_rules = get_internship_rules(program_id)
    internship_status: dict = {}

    if internship_rules:
        first_course = _normalize_id(internship_rules.get("first_internship_course", ""))
        fulfillment_courses = [
            _normalize_id(x) for x in internship_rules.get("fulfillment_courses", [])
        ]
        ineligibility_triggers = [
            _normalize_id(x) for x in internship_rules.get("ineligibility_trigger", [])
        ]

        first_course_done = first_course in completed if first_course else False
        fulfillment_done = [cid for cid in fulfillment_courses if cid in completed]
        ineligibility_triggered = any(cid in completed for cid in ineligibility_triggers)
        internship_fulfilled = first_course_done or bool(fulfillment_done)

        internship_status = {
            "required": True,
            "fulfilled": internship_fulfilled,
            "first_internship_course": internship_rules.get("first_internship_course", ""),
            "first_internship_note": internship_rules.get("first_internship_note", ""),
            "first_course_done": first_course_done,
            "fulfillment_courses": internship_rules.get("fulfillment_courses", []),
            "fulfillment_note": internship_rules.get("fulfillment_note", ""),
            "fulfillment_done": [
                internship_rules.get("fulfillment_courses", [])[fulfillment_courses.index(cid)]
                for cid in fulfillment_done
            ],
            "ineligible_for_first_course": ineligibility_triggered,
            "ineligibility_note": internship_rules.get("ineligibility_note", ""),
            "additional_course": internship_rules.get("additional_internship_course", ""),
            "additional_note": internship_rules.get("additional_internship_note", ""),
            "description": internship_rules.get("description", ""),
        }

    return {
        "non_credit_status": non_credit_status,
        "conditional_status": conditional_status,
        "internship_status": internship_status,
    }


def _format_special_requirements_context(resolved: dict, program_id: str) -> str:
    """
    Converts resolved special requirements into an unambiguous LLM instruction block.
    LLM reads and narrates — does zero logic itself.
    """
    lines = []
    lines.append("=" * 60)
    lines.append("SPECIAL PROGRAM REQUIREMENTS — PRE-COMPUTED. DO NOT RECALCULATE.")
    lines.append("=" * 60)
    lines.append("")

    non_credit = resolved.get("non_credit_status", [])
    if non_credit:
        lines.append("NON-CREDIT PREREQUISITES (mandatory, do not count toward 36 credits):")
        for item in non_credit:
            nid = _normalize_id(item["course_id"])
            pd_title = (COURSE_MAP.get(nid) or {}).get("title") or "Professional Development"
            status = "COMPLETED" if item["completed"] else "NOT YET COMPLETED"
            lines.append(
                f"  Course ID: {item['course_id']} | "
                f"Title: {pd_title} | "
                f"Status: {status}"
            )
            if not item["completed"]:
                lines.append(
                    f"  -> The exact course ID is {item['course_id']}. "
                    "Never substitute this with any other course ID. "
                    "Must be taken in the student's FIRST semester alongside regular courses. "
                    "Grade counts toward GPA but does not count toward the 36-credit degree total."
                )
            else:
                lines.append(
                    "  -> Student profile lists this course as completed. "
                    "Do NOT repeatedly remind them to enroll or stress first-semester timing in every reply."
                )
        lines.append("")

    conditional = resolved.get("conditional_status", [])
    if conditional:
        lines.append("CONDITIONAL PREREQUISITES:")
        for item in conditional:
            status = "COMPLETED" if item["completed"] else "MAY BE REQUIRED (see condition)"
            lines.append(f"  {item['course_id']}: {status}")
            lines.append(f"  Condition: {item.get('condition', '')}")
            lines.append(f"  Timing: {item.get('when_to_take', '')}")
            lines.append(f"  Note: {item.get('note', '')}")
        lines.append("")

    internship = resolved.get("internship_status", {})
    if internship.get("required"):
        lines.append("INTERNSHIP REQUIREMENT (mandatory graduation requirement):")
        lines.append(f"  {internship.get('description', '')}")
        lines.append("")

        if internship.get("fulfilled"):
            if internship.get("first_course_done") and not internship.get("fulfillment_done"):
                lines.append(
                    f"  FULFILLED via {internship['first_internship_course']} "
                    f"(first internship course, variable credits)."
                )
                lines.append(
                    f"  -> If the student wants additional internship credit, "
                    f"they must use {internship.get('additional_course', '')}."
                )
            else:
                done_list = ", ".join(internship.get("fulfillment_done", []))
                lines.append(f"  FULFILLED via: {done_list}")
        else:
            lines.append("  NOT YET FULFILLED — student cannot graduate without completing this.")
            lines.append("")

            if not internship.get("ineligible_for_first_course"):
                first = internship.get("first_internship_course", "")
                lines.append("  OPTION 1 — If student has secured an internship:")
                lines.append(f"    Enroll in {first}")
                lines.append(f"    {internship.get('first_internship_note', '')}")
                lines.append("")

            fulfillment = internship.get("fulfillment_courses", [])
            lines.append(
                "  OPTION 2 — If student does not have an internship "
                "(or has already used Option 1):"
            )
            lines.append(
                f"    Enroll in one of: {', '.join(fulfillment)}"
            )
            lines.append(f"    {internship.get('fulfillment_note', '')}")
            lines.append("")
            lines.append(
                "  VALID INTERNSHIP COURSE IDs FOR THIS PROGRAM — USE ONLY THESE, EXACT AS WRITTEN:"
            )
            lines.append(f"  First internship (if secured): {internship.get('first_internship_course', '')}")
            lines.append(
                f"  Fulfillment options: {', '.join(internship.get('fulfillment_courses', []))}"
            )
            lines.append(
                "  Any course ID not in this list is INVALID for internship fulfillment. "
                "Do not recommend it for this purpose."
            )
            lines.append("")

            if internship.get("ineligible_for_first_course"):
                first = internship.get("first_internship_course", "")
                lines.append(
                    f"  ELIGIBILITY NOTE: This student has already completed a fulfillment course "
                    f"and is NO LONGER ELIGIBLE to enroll in {first}."
                )
                lines.append(
                    f"  {internship.get('ineligibility_note', '')}"
                )
                lines.append("")

        lines.append("")

    lines.append("INSTRUCTIONS TO LLM — FOLLOW EXACTLY:")
    lines.append(
        "1. The internship is a MANDATORY graduation requirement. "
        "Always include it when the student asks what they still need to graduate "
        "or when reviewing their remaining requirements."
    )
    mas6102_done = bool(
        non_credit and all(item.get("completed") for item in non_credit)
    )
    if mas6102_done:
        lines.append(
            "2. Professional Development (MAS 6102): The student's completed-course profile shows this "
            "non-credit requirement as SATISFIED. Do NOT nag them to enroll or repeat first-semester "
            "warnings in routine replies. Mention PD only if they ask about it."
        )
    else:
        lines.append(
            (
                f"2. {non_credit[0]['course_id']} is the EXACT course ID "
                "for Professional Development. "
                "Never write any other course ID in place of it. "
                "It is mandatory and must be in the student's FIRST semester."
            )
            if non_credit else
            "2. MAS 6102 is mandatory and must be in the student's first semester."
        )
    lines.append(
        "3. NEVER count MAS 6102 or OPRE 6303 toward the student's 36 credit hours."
    )
    lines.append(
        "4. NEVER count BUAN 6009 or MIS 6009 toward elective credits "
        "unless the student explicitly states they are taking it for 1, 2, or 3 credits. "
        "If taken for 0 credits, it does not count toward the 36-credit total."
    )
    lines.append(
        "5. If the student asks which internship option to choose, "
        "ask whether they have secured an actual internship before recommending. "
        "Do not assume."
    )
    lines.append(
        "6. INTERNSHIP COURSE IDs ARE EXACT — NEVER SUBSTITUTE THEM. "
        "The only valid internship course IDs for this program are listed above in the "
        "INTERNSHIP REQUIREMENT section. Copy them character for character. "
        "BUAN 6398 is NOT an internship course — it is Prescriptive Analytics. "
        "BUAN 6390 and BUAN 6V98 are the ONLY fulfillment options for MSBA. "
        "MIS 6V98, MIS 6349, and MIS 6354 are the ONLY fulfillment options for MSITM. "
        "Never recommend any other course for internship fulfillment."
    )
    lines.append(
        "7. When mentioning internship courses to the student, always write the full course ID "
        "exactly as it appears: BUAN 6390, BUAN 6V98, BUAN 6009, MIS 6009, MIS 6V98. "
        "Never shorten, paraphrase, or substitute these IDs."
    )
    lines.append("=" * 60)

    return "\n".join(lines)

def _compute_progress_from_catalog(completed_ids: list[str], program_id: str = "msba") -> dict:
    rules = get_credit_requirements(program_id)
    total_req = rules["total_credits"]
    core_req = rules["core_credits"]
    core_elective_req = rules.get("core_elective_credits", 0)
    elective_req = rules["elective_credits"]

    completed_set = {_normalize_id(x) for x in completed_ids if _normalize_id(x)}
    core_credits = 0.0
    core_elective_credits = 0.0
    elective_credits = 0.0
    core_courses_completed_list = sorted(
        cid for cid in completed_set if _course_is_core(cid)
    )
    core_elective_courses_completed_list = sorted(
        cid for cid in completed_set if _course_is_core_elective(cid)
    )
    elective_courses_completed_list = sorted(
        cid for cid in completed_set if _course_is_elective(cid)
    )
    for cid in completed_set:
        credits = COURSE_CREDITS_BY_ID.get(cid, 3.0)
        t = COURSE_TYPE_BY_ID.get(cid, "").lower()
        if t == "core":
            core_credits += credits
        elif t == "coreelective":
            core_elective_credits += credits
        elif t == "elective":
            elective_credits += credits
    total = core_credits + core_elective_credits + elective_credits
    core_courses_completed_count = len(core_courses_completed_list)
    core_elective_courses_completed_count = len(core_elective_courses_completed_list)
    elective_courses_completed_count = len(elective_courses_completed_list)
    core_courses_remaining_count = max(0, int((core_req - core_credits) // 3))
    core_elective_courses_remaining_count = max(0, int((core_elective_req - core_elective_credits) // 3))
    elective_courses_remaining_count = max(0, int((elective_req - elective_credits) // 3))
    total_courses_remaining = (
        core_courses_remaining_count + core_elective_courses_remaining_count + elective_courses_remaining_count
    )
    internship_courses = {
        "msba": ["BUAN 6009", "BUAN 6390", "BUAN 6V98"],
        "msitm": ["MIS 6009", "MIS 6V98", "MIS 6349", "MIS 6354"],
    }
    program_internship_courses = {
        _normalize_id(x) for x in internship_courses.get(program_id, [])
    }
    internship_done = bool(completed_set & program_internship_courses)
    return {
        "total_completed": round(total, 1),
        "core_completed": round(core_credits, 1),
        "core_elective_completed": round(core_elective_credits, 1),
        "elective_completed": round(elective_credits, 1),
        "total_remaining": max(0.0, total_req - total),
        "core_remaining": max(0.0, core_req - core_credits),
        "core_elective_remaining": max(0.0, core_elective_req - core_elective_credits),
        "elective_remaining": max(0.0, elective_req - elective_credits),
        "percent_complete": _cap_percent_complete(
            round((total / total_req) * 100, 1) if total and total_req else 0.0
        ),
        "core_courses_completed_list": core_courses_completed_list,
        "core_elective_courses_completed_list": core_elective_courses_completed_list,
        "elective_courses_completed_list": elective_courses_completed_list,
        "core_courses_completed_count": core_courses_completed_count,
        "core_elective_courses_completed_count": core_elective_courses_completed_count,
        "elective_courses_completed_count": elective_courses_completed_count,
        "core_courses_remaining_count": core_courses_remaining_count,
        "core_elective_courses_remaining_count": core_elective_courses_remaining_count,
        "elective_courses_remaining_count": elective_courses_remaining_count,
        "total_courses_remaining": total_courses_remaining,
        "internship_fulfilled": internship_done,
    }


def format_progress_block(progress: dict, program_id: str = "msba") -> str:
    """
    Formats degree progress as a fixed fact block.
    The LLM must copy these numbers exactly and never recalculate them.
    """
    core_done_list = progress.get("core_courses_completed_list") or []
    elec_done_list = progress.get("elective_courses_completed_list") or []

    core_done_str = ", ".join(core_done_list) if core_done_list else "None"
    elec_done_str = ", ".join(elec_done_list) if elec_done_list else "None"

    return f"""
DEGREE PROGRESS — COPY THESE NUMBERS EXACTLY, NEVER RECALCULATE:
═══════════════════════════════════════════════════════════════
CORE REQUIREMENT (18 credits required):
  Completed : {progress['core_courses_completed_count']} courses = {progress['core_completed']} credits
  Remaining : {progress['core_courses_remaining_count']} courses = {progress['core_remaining']} credits
  Completed courses: {core_done_str}

ELECTIVE REQUIREMENT (18 credits required):
  Completed : {progress['elective_courses_completed_count']} courses = {progress['elective_completed']} credits
  Remaining : {progress['elective_courses_remaining_count']} courses = {progress['elective_remaining']} credits
  Completed courses: {elec_done_str}

OVERALL:
{_overall_total_line(progress, program_id)}
  Total remaining : {progress['total_courses_remaining']} courses = {progress['total_remaining']} credits
  Progress        : {progress['percent_complete']}% complete (never exceed 100% when speaking to the student)
═══════════════════════════════════════════════════════════════
""".strip()


def format_course_lists(
    remaining_core: list[dict],
    remaining_elective: list[dict],
    constraint_notes: list[str],
) -> str:
    """
    Formats remaining core and elective courses as fixed labeled lists.
    The LLM must only recommend from these lists and never add others.
    """
    lines = []

    lines.append(
        "REMAINING CORE COURSES — recommend ONLY from this list for core requirements:"
    )
    if remaining_core:
        for c in remaining_core:
            cid   = c.get("course_id", "")
            title = c.get("title", "")
            lines.append(f"  {cid} | {title} | 3 credits | Core")
    else:
        lines.append("  None remaining — core requirement complete.")

    lines.append("")
    lines.append(
        "REMAINING ELECTIVE COURSES — recommend ONLY from this list for elective requirements:"
    )
    if remaining_elective:
        for c in remaining_elective:
            cid   = c.get("course_id", "")
            title = c.get("title", "")
            lines.append(f"  {cid} | {title} | 3 credits | Elective")
    else:
        lines.append("  None remaining — elective requirement complete.")

    if constraint_notes:
        lines.append("")
        lines.append("CHOICE GROUP NOTES:")
        for note in constraint_notes:
            lines.append(f"  {note}")

    lines.append("")
    lines.append(
        "HARD RULE: A course labeled Core above must NEVER be "
        "recommended as an elective. A course labeled Elective above "
        "must NEVER be recommended as a core course. The labels are "
        "final and come from the database."
    )

    return "\n".join(lines)


def _build_semester_plan(
    completed_ids: list[str],
    courses_per_semester: int,
    max_semesters: int,
    core_per_semester: int | None,
    elective_per_semester: int | None,
    relevance_query: str | None = None,
    program_id: str = "msba",
    all_courses: list[dict] | None = None,
) -> dict:
    if all_courses is None:
        all_courses = load_courses_for_program(program_id)
    local_course_map = {c["course_id"].strip().upper(): c for c in all_courses if c.get("course_id")}
    local_type_map = {cid: (c.get("course_type") or "").strip() for cid, c in local_course_map.items()}

    completed = {_normalize_id(x) for x in completed_ids if _normalize_id(x)}

    # Block other courses in only-one-of groups once one is completed/picked.
    blocked_ids: set[str] = set()
    seen_groups: set[tuple[str, ...]] = set()
    for cid in list(completed):
        grp = _only_one_group(cid)
        if grp:
            seen_groups.add(grp)
    for grp in seen_groups:
        for cid in grp:
            if cid not in completed:
                blocked_ids.add(cid)

    progress0 = _compute_progress_from_catalog(list(completed), program_id=program_id)
    core_remaining_courses = int(progress0["core_remaining"] // 3)
    elective_remaining_courses = int(progress0["elective_remaining"] // 3)

    all_core = [c for c in all_courses if (c.get("course_type") or "").lower() == "core"]
    all_elec = [c for c in all_courses if (c.get("course_type") or "").lower() == "elective"]

    def course_key(c: dict) -> str:
        return _normalize_id(c.get("course_id", ""))

    # Optional: use Pinecone relevance scores to rank picks toward the student's stated focus.
    score_by_id: dict[str, float] = {}
    if relevance_query:
        try:
            rel = query_courses(relevance_query, top_k=50, program_id=program_id)
            score_by_id = {str(c.get("course_id", "")).strip().upper(): float(c.get("score", 0) or 0) for c in rel}
        except Exception:
            score_by_id = {}

    def ranked_key(c: dict):
        cid = course_key(c)
        return (-float(score_by_id.get(cid, 0) or 0), cid)

    all_core.sort(key=ranked_key)
    all_elec.sort(key=ranked_key)

    semesters: list[dict] = []
    warnings: list[str] = []

    for sem in range(1, max_semesters + 1):
        if core_remaining_courses <= 0 and elective_remaining_courses <= 0:
            break

        if core_per_semester is None and elective_per_semester is None:
            total_remaining = core_remaining_courses + elective_remaining_courses
            if total_remaining == 0:
                break
            desired_core = round((core_remaining_courses / total_remaining) * courses_per_semester)
            desired_core = max(0, min(courses_per_semester, desired_core))
            desired_elec = courses_per_semester - desired_core
        else:
            desired_core = core_per_semester or 0
            desired_elec = elective_per_semester or 0
            if desired_core + desired_elec == 0:
                desired_core = courses_per_semester
                desired_elec = 0
            if desired_core + desired_elec != courses_per_semester:
                courses_per_semester = desired_core + desired_elec

        picked: list[dict] = []
        picked_ids: set[str] = set()

        def try_pick(pool: list[dict], n: int):
            for c in pool:
                if len([x for x in picked if (x.get("course_type") or "").lower() == (c.get("course_type") or "").lower()]) >= n:
                    return
                cid = _normalize_id(c.get("course_id"))
                if not cid or cid in completed or cid in blocked_ids or cid in picked_ids:
                    continue
                grp = _only_one_group(cid)
                if grp and grp in seen_groups:
                    continue
                if not _prereqs_met(cid, completed):
                    continue
                picked.append(c)
                picked_ids.add(cid)
                if grp:
                    seen_groups.add(grp)
                    for other in grp:
                        if other not in completed and other != cid:
                            blocked_ids.add(other)

        if desired_core > 0 and core_remaining_courses > 0:
            try_pick(all_core, min(desired_core, core_remaining_courses))
        if desired_elec > 0 and elective_remaining_courses > 0:
            try_pick(all_elec, min(desired_elec, elective_remaining_courses))

        if len(picked) < courses_per_semester:
            combined = all_core + all_elec
            for c in combined:
                if len(picked) >= courses_per_semester:
                    break
                cid = _normalize_id(c.get("course_id"))
                if not cid or cid in completed or cid in blocked_ids or cid in picked_ids:
                    continue
                if not _prereqs_met(cid, completed):
                    continue
                # Do not overfill beyond remaining degree requirements by type
                picked_core = len([x for x in picked if (x.get("course_type") or "").lower() == "core"])
                picked_elec = len([x for x in picked if (x.get("course_type") or "").lower() == "elective"])
                if (local_type_map.get(cid, "").lower() == "core"):
                    if core_remaining_courses <= 0:
                        continue
                    if picked_core >= core_remaining_courses:
                        continue
                if (local_type_map.get(cid, "").lower() == "elective"):
                    if elective_remaining_courses <= 0:
                        continue
                    if picked_elec >= elective_remaining_courses:
                        continue
                grp = _only_one_group(cid)
                if grp and grp in seen_groups:
                    continue
                picked.append(c)
                picked_ids.add(cid)
                if grp:
                    seen_groups.add(grp)
                    for other in grp:
                        if other not in completed and other != cid:
                            blocked_ids.add(other)

        if not picked:
            warnings.append(f"Semester {sem}: no additional eligible courses found with current prerequisites/constraints.")
            break

        for c in picked:
            cid = _normalize_id(c.get("course_id"))
            completed.add(cid)
            if (local_type_map.get(cid, "").lower() == "core") and core_remaining_courses > 0:
                core_remaining_courses -= 1
            elif (local_type_map.get(cid, "").lower() == "elective") and elective_remaining_courses > 0:
                elective_remaining_courses -= 1

        semesters.append({
            "semester": sem,
            "courses": [
                {
                    "course_id": c.get("course_id"),
                    "title": c.get("title"),
                    "course_type": _display_course_type(c.get("course_type", ""), c.get("course_track", "")),
                    "course_track": c.get("course_track", ""),
                    "credits": c.get("credits", 3),
                    "prerequisites": c.get("prerequisites") or [],
                    "only_one_of_these": c.get("only_one_of_these") or [],
                }
                for c in picked
            ],
        })

    final_progress = _compute_progress_from_catalog(list(completed), program_id=program_id)
    return {"plan": semesters, "warnings": warnings, "progress": final_progress}


@router.post("/plan")
def degree_planner_plan(request: PlanRequest):
    program_id = (request.program_id or "msba").strip().lower()
    program_courses = load_courses_for_program(program_id)
    from_hist: list[str] = []
    if isinstance(request.course_history, list):
        for item in request.course_history:
            if isinstance(item, dict) and isinstance(item.get("course"), str):
                from_hist.append(item["course"])
    validation = validate_course_list(list(request.completed_courses or []) + from_hist)
    completed_ids = list(dict.fromkeys(c["course_id"] for c in validation["valid"]))

    plan = _build_semester_plan(
        completed_ids=completed_ids,
        courses_per_semester=max(1, int(request.courses_per_semester)),
        max_semesters=max(1, int(request.max_semesters)),
        core_per_semester=request.core_per_semester,
        elective_per_semester=request.elective_per_semester,
        relevance_query=" ".join(request.interests) if request.interests else None,
        program_id=program_id,
        all_courses=program_courses,
    )
    resolved_special = _resolve_special_requirements(
        valid_completed_ids=completed_ids,
        program_id=program_id,
    )
    extra_notes: list[str] = []
    non_credit_pending = [
        item["course_id"] for item in resolved_special.get("non_credit_status", [])
        if not item["completed"]
    ]
    if non_credit_pending:
        extra_notes.append("Non-credit prerequisites still needed (take in first semester):")
        for cid in non_credit_pending:
            extra_notes.append(f"- {cid} (does not count toward 36 credits, grade counts toward GPA)")

    internship = resolved_special.get("internship_status", {})
    if internship.get("required") and not internship.get("fulfilled"):
        first = internship.get("first_internship_course", "")
        fulfillment = internship.get("fulfillment_courses", [])
        extra_notes.append("Internship requirement: NOT YET FULFILLED (required for graduation)")
        if not internship.get("ineligible_for_first_course"):
            extra_notes.append(f"- If you have an internship lined up: enroll in {first}")
        extra_notes.append(
            f"- If you do not have an internship: complete one of {', '.join(fulfillment)}"
        )

    hist_info = _analyze_course_history(
        list(request.course_history) if isinstance(request.course_history, list) else []
    )
    headings = _headings_for_plan_rows(hist_info, len(plan["plan"]))

    return {
        "plan": plan["plan"],
        "warnings": [*(plan.get("warnings") or []), *extra_notes],
        "progress": plan["progress"],
        "invalid_courses": validation["invalid"],
        "next_semester_label": hist_info.get("next_label"),
        "semester_headings": headings,
    }


def _select_courses(
    eligible: list[dict],
    relevant: list[dict],
    n_core: int | None,
    n_elective: int | None,
    max_total: int | None,
) -> tuple[list[dict], list[str]]:
    """
    Deterministically pick a semester plan from eligible courses.
    Uses Pinecone relevance scores when available, but never changes course_type.
    Enforces only-one-of groups (doesn't pick 2 from same group).
    Returns (selected_courses, warnings).
    """
    score_by_id = {c["course_id"].strip().upper(): c.get("score", 0) for c in relevant if c.get("course_id")}

    def rank_key(c: dict):
        cid = c["course_id"].strip().upper()
        return (-float(score_by_id.get(cid, 0) or 0), cid)

    eligible_core = [c for c in eligible if str(c.get("course_type", "")).lower() == "core"]
    eligible_elec = [c for c in eligible if str(c.get("course_type", "")).lower() == "elective"]
    eligible_core.sort(key=rank_key)
    eligible_elec.sort(key=rank_key)

    selected: list[dict] = []
    warnings: list[str] = []
    seen_groups: set[tuple[str, ...]] = set()
    seen_ids: set[str] = set()

    def take_from(pool: list[dict], n: int):
        nonlocal selected
        added = 0
        for c in pool:
            if added >= n:
                return
            if len(selected) >= (max_total or 10**9):
                return
            cid = c["course_id"].strip().upper()
            if cid in seen_ids:
                continue
            grp = _only_one_group(cid)
            if grp and grp in seen_groups:
                continue
            selected.append(c)
            seen_ids.add(cid)
            if grp:
                seen_groups.add(grp)
            added += 1

    # If user specified counts, honor them
    if n_core is not None:
        take_from(eligible_core, n_core)
        if len([c for c in selected if str(c.get("course_type", "")).lower() == "core"]) < n_core:
            warnings.append("Not enough eligible CORE courses to satisfy the requested count.")
    if n_elective is not None:
        take_from(eligible_elec, n_elective)
        if len([c for c in selected if str(c.get("course_type", "")).lower() == "elective"]) < n_elective:
            warnings.append("Not enough eligible ELECTIVE courses to satisfy the requested count.")

    # If total was specified, fill remaining from best-ranked eligible (any type)
    if max_total is not None and len(selected) < max_total:
        combined = sorted(eligible_core + eligible_elec, key=rank_key)
        for c in combined:
            if len(selected) >= max_total:
                break
            cid = c["course_id"].strip().upper()
            if cid in seen_ids:
                continue
            grp = _only_one_group(cid)
            if grp and grp in seen_groups:
                continue
            selected.append(c)
            seen_ids.add(cid)
            if grp:
                seen_groups.add(grp)

    if max_total is not None and len(selected) < max_total:
        warnings.append(
            f"Only {len(selected)} eligible course(s) could be selected out of the {max_total} requested "
            "due to prerequisites/constraints."
        )

    return selected, warnings


@router.post("/chat", response_model=DegreePlannerResponse)
def degree_planner_chat(request: ChatRequest) -> DegreePlannerResponse:
    program_id = (request.program_id or "msba").strip().lower()
    program_courses = load_courses_for_program(program_id)
    # Step 1 — validate student's completed courses (from payload + optional course_history)
    from_history: list[str] = []
    if isinstance(request.course_history, list):
        for item in request.course_history:
            if isinstance(item, dict) and isinstance(item.get("course"), str):
                from_history.append(item["course"])

    validation = validate_course_list(
        list(request.completed_courses or []) + from_history
    )
    valid_completed = list(dict.fromkeys(c["course_id"] for c in validation["valid"]))
    resolved_core = _resolve_core_requirements(
        valid_completed_ids=valid_completed,
        all_courses=program_courses,
        program_id=program_id,
    )
    core_requirement_context = _format_core_requirement_context(resolved_core, program_id)
    resolved_special = _resolve_special_requirements(
        valid_completed_ids=valid_completed,
        program_id=program_id,
    )
    special_requirement_context = _format_special_requirements_context(resolved_special, program_id)

    # Pre-compute remaining lists (strict Core vs Elective) — used by every response path
    # so the frontend always has progress + remaining-courses data to render.
    remaining_core, remaining_core_elective, remaining_elective, progress, list_notes = build_course_lists(
        valid_completed_ids=valid_completed,
        all_courses=program_courses,
        program_id=program_id,
    )
    remaining_core, remaining_elective, group_notes = _apply_only_one_of_constraints(
        completed_ids=valid_completed,
        remaining_core=remaining_core,
        remaining_elective=remaining_elective,
    )
    list_notes = (list_notes or []) + (group_notes or [])
    progress = {**progress, **_compute_progress_from_catalog(valid_completed, program_id=program_id)}

    progress_data = ProgressData(
        core_completed_credits=int(progress["core_completed"]),
        core_remaining_credits=int(progress["core_remaining"]),
        core_completed_count=progress.get("core_courses_completed_count", 0),
        core_remaining_count=progress.get("core_courses_remaining_count", 0),
        elective_completed_credits=int(progress["elective_completed"]),
        elective_remaining_credits=int(progress["elective_remaining"]),
        elective_completed_count=progress.get("elective_courses_completed_count", 0),
        elective_remaining_count=progress.get("elective_courses_remaining_count", 0),
        total_completed_credits=int(progress["total_completed"]),
        total_remaining_credits=int(progress["total_remaining"]),
        total_completed_count=progress.get("core_courses_completed_count", 0)
            + progress.get("elective_courses_completed_count", 0),
        total_remaining_count=progress.get("total_courses_remaining", 0),
        percent_complete=float(progress["percent_complete"]),
    )

    remaining_core_cards = [
        CourseCard(
            course_id=c["course_id"],
            title=c["title"],
            course_type="Core",
            credits=3,
            is_completed=False,
            prerequisites_met=True,
        )
        for c in remaining_core
    ]
    remaining_elective_cards = [
        CourseCard(
            course_id=c["course_id"],
            title=c["title"],
            course_type="Elective",
            credits=3,
            is_completed=False,
            prerequisites_met=True,
        )
        for c in remaining_elective
    ]
    invalid_course_ids = [c.get("original", "") for c in validation.get("invalid", [])]

    # ── Path A: course details / prereq lookup ───────────────────────────────
    # Two distinct intents share this block. A "prereq only" request returns
    # just a natural-language prerequisite sentence; a general "details"
    # request returns the existing full course info. If both signals appear,
    # the more specific prereq intent wins.
    mentioned_ids = [cid.strip().upper() for cid in extract_course_ids(request.message)]
    if mentioned_ids:
        msg_lower_details = request.message.lower()
        prereq_keywords = [
            "prereq",
            "prerequisite",
            "prerequisites",
            "what do i need to take",
            "what do i need before",
            "requirements for",
            "required for",
            "eligible for",
        ]
        details_keywords = [
            "tell me about",
            "what is",
            "describe",
            "what does",
            "info on",
            "information on",
        ]
        wants_prereq = any(k in msg_lower_details for k in prereq_keywords)
        wants_details = any(k in msg_lower_details for k in details_keywords)

        # Case A — prereq-specific query (takes priority over general details).
        if wants_prereq:
            cid = mentioned_ids[0]
            course = COURSE_MAP.get(cid)
            if course:
                prereqs = course.get("prerequisites") or []
                natural_response = _format_prereqs_natural(prereqs, course["title"])
                return DegreePlannerResponse(
                    narrative=natural_response,
                    progress=progress_data,
                    recommended_courses=[],
                    semester_plan=[],
                    remaining_core=[],
                    remaining_elective=[],
                    choice_group_notes=[],
                    invalid_courses=[],
                    corrections=[],
                )

        # Case B — general course details (unchanged full info payload).
        if wants_details:
            cid = mentioned_ids[0]
            course = COURSE_MAP.get(cid)
            if course:
                prereqs = course.get("prerequisites") or []
                only_one = course.get("only_one_of_these") or []
                skills = course.get("skills_taught") or []
                desc = (course.get("description") or "").strip() or "N/A"
                detail_text = (
                    f"{course['course_id']} — {course['title']}\n"
                    f"Type: {course.get('course_type', 'N/A')} | Credits: {course.get('credits', 3)}\n\n"
                    f"Description:\n{desc}\n\n"
                    f"Prerequisites:\n{_format_prereqs(prereqs)}\n\n"
                    f"Only One Of These group:\n{', '.join(only_one) if only_one else 'None'}\n\n"
                    f"Skills taught (high level):\n{', '.join(skills) if skills else 'N/A'}"
                )
                return DegreePlannerResponse(
                    narrative=detail_text,
                    progress=progress_data,
                    recommended_courses=[],
                    semester_plan=[],
                    remaining_core=remaining_core_cards,
                    remaining_elective=remaining_elective_cards,
                    choice_group_notes=list_notes or [],
                    invalid_courses=invalid_course_ids,
                    corrections=[],
                )

    # ── Path B: full degree plan / schedule request ──────────────────────────
    msg_lower = request.message.lower()
    wants_path = any(k in msg_lower for k in [
        "plan out my degree",
        "map my degree",
        "degree plan",
        "semester by semester",
        "path to graduation",
        "roadmap to graduation",
        "schedule my courses",
    ])
    if wants_path:
        hist_info = _analyze_course_history(
            list(request.course_history) if isinstance(request.course_history, list) else []
        )
        prefs = _extract_preferences_from_convo(request.conversation_history, request.message)
        merged_completed = sorted(set(valid_completed) | set(prefs["completed_from_convo"]))
        plan_out = _build_semester_plan(
            completed_ids=merged_completed,
            courses_per_semester=max(1, int(prefs["courses_per_semester"])),
            max_semesters=8,
            core_per_semester=prefs["core_per_semester"],
            elective_per_semester=prefs["elective_per_semester"],
            relevance_query=(" ".join(request.interests) if request.interests else prefs["focus_query"]),
            program_id=program_id,
            all_courses=program_courses,
        )

        # Deterministic narrative (no LLM call needed for plans).
        lines: list[str] = []
        lines.append(
            f"Got it — here's a semester-by-semester plan with "
            f"{prefs['courses_per_semester']} course(s) per semester, based on what you shared so far."
        )
        if hist_info.get("next_label"):
            lines.append(f"Next terms start at: {hist_info['next_label']} (from your reported course history).")
        lines.append("")
        plan_rows = plan_out["plan"][:8]
        headings = _headings_for_plan_rows(hist_info, len(plan_rows))
        for i, sem in enumerate(plan_rows):
            label = headings[i] if i < len(headings) else f"Semester {sem['semester']}"
            lines.append(f"{label}:")
            for c in sem["courses"]:
                lines.append(
                    f"- {c['course_id']} — {c['title']} "
                    f"({_display_course_type(c.get('course_type', ''), c.get('course_track', ''))})"
                )
            lines.append("")
        if plan_out["warnings"]:
            lines.append("Notes:")
            for w in plan_out["warnings"]:
                lines.append(f"- {w}")
            lines.append("")

        semester_plan_blocks: list[SemesterBlock] = []
        for i, sem in enumerate(plan_out["plan"]):
            label = headings[i] if i < len(headings) else f"Semester {sem['semester']}"
            cards = [
                CourseCard(
                    course_id=c["course_id"],
                    title=c["title"],
                    course_type=_display_course_type(c.get("course_type", "Elective"), c.get("course_track", "")),
                    credits=3,
                    is_completed=False,
                    prerequisites_met=True,
                )
                for c in sem["courses"]
            ]
            semester_plan_blocks.append(SemesterBlock(label=label, courses=cards))

        return DegreePlannerResponse(
            narrative="\n".join(lines).strip(),
            progress=progress_data,
            recommended_courses=[],
            semester_plan=semester_plan_blocks,
            remaining_core=remaining_core_cards,
            remaining_elective=remaining_elective_cards,
            choice_group_notes=list_notes or [],
            invalid_courses=invalid_course_ids,
            corrections=[],
        )

    # ── Path C: conversational advising via LLM ──────────────────────────────
    try:
        eligible_courses = get_valid_next_courses(valid_completed, program_id=program_id)
    except (ServiceUnavailable, AuthError):
        # Demo deploy: catalog progress still works without the graph.
        eligible_courses = []

    # Canonical types + eligible next steps from graph (kept for side-effect parity;
    # the LLM prompt uses remaining_* lists, not this eligibility list directly).
    eligible_courses = [_enrich_course_record(c) for c in eligible_courses]

    total_core_done = progress.get("core_completed", 0) + progress.get("core_elective_completed", 0)
    total_core_remaining = progress.get("core_remaining", 0) + progress.get("core_elective_remaining", 0)
    core_a_total = resolved_core.get("part_a_total_slots", 0) * 3
    core_b_total = resolved_core.get("part_b_tracks_required", 0) * 3
    internship_line = (
        "- Internship requirement: Fulfilled"
        if progress.get("internship_fulfilled")
        else "- Internship requirement: Not yet fulfilled (required for graduation)"
    )
    overshoot_warn, total_credits_line = _degree_progress_overshoot_lines(program_id, progress)
    pct_line = (
        f"- Percent complete (ONLY percentage you may mention; never above 100%): "
        f"{progress['percent_complete']}%"
    )
    progress_context = f"""
STUDENT DEGREE PROGRESS:
{overshoot_warn}{total_credits_line}
- Core credits completed: {total_core_done} / 18
  (Part A completed: {progress.get('core_completed', 0)} / {core_a_total})
  (Part B completed: {progress.get('core_elective_completed', 0)} / {core_b_total})
- Elective credits completed: {progress['elective_completed']} / 18
- Credits remaining: {progress['total_remaining']}
- Core remaining: {total_core_remaining}
- Elective remaining: {progress['elective_remaining']}
{internship_line}
{pct_line}
""".strip()
    # Per-ID completed lists (aggregates alone hide courses like BUAN 6341 from the model).
    progress_lists_context = format_progress_block(progress, program_id)
    profile_audit_context = ""
    if validation.get("invalid"):
        audit = _profile_course_audit_for_prompt(valid_completed, validation).strip()
        if audit:
            profile_audit_context = audit + "\n\n"
    courses_context = format_course_lists(remaining_core, remaining_elective, list_notes)
    remaining_elective_context = "\n".join(
        f"{c.get('course_id', '')} | {c.get('title', '')} | {c.get('credits', 3)}"
        for c in remaining_elective
    ) or "None"
    rules_notes_context = (
        "NOTE: The course lists above already reflect only-one-of-these constraints. "
        "Do not explain these constraints to the student unless directly asked. "
        "Simply recommend from the lists as given.\n\n"
        if list_notes else ""
    )
    warnings_context = ""
    plan_context = ""
    type_turn_rules = ""
    requested_type = None

    system_prompt_base = _build_system_prompt(program_id)
    system_prompt_with_context = (
        f"{system_prompt_base}\n\n"
        f"{progress_context}\n\n"
        f"{progress_lists_context}\n\n"
        f"{profile_audit_context}"
        f"{core_requirement_context}\n\n"
        f"{special_requirement_context}\n\n"
        f"REQUEST TYPE: {requested_type or 'Any'}\n"
        f"{type_turn_rules}"
        f"{rules_notes_context}"
        f"REMAINING ELECTIVE COURSES (prerequisites met) — student can freely choose from these.\n"
        f"Format: COURSE_ID | EXACT_TITLE | credits\n\n"
        f"{remaining_elective_context}\n\n"
        f"{warnings_context}"
        f"{plan_context}"
        f"{courses_context}\n\n"
        "The course type labels are FINAL and come from the database. "
        "Never reclassify a course. Never recommend a course the student has already completed."
    )

    messages = request.conversation_history + [
        {"role": "user", "content": request.message}
    ]

    result = safe_chat(
        "degree_planner",
        system_prompt=system_prompt_with_context,
        messages=messages,
    )

    # Extract course IDs the LLM mentioned and turn valid ones into recommendation
    # cards. Completed courses are never included — only IDs in the remaining lists.
    narrative_text = _sanitize_impossible_completion_percentages(result.get("text", ""))
    mentioned_in_narrative = extract_course_ids(narrative_text)
    remaining_ids = (
        {_normalize_id(c["course_id"]) for c in remaining_core}
        | {_normalize_id(c["course_id"]) for c in remaining_elective}
    )
    recommended_cards: list[CourseCard] = []
    seen_recommended: set[str] = set()
    for cid in mentioned_in_narrative:
        normalized = _normalize_id(cid)
        if normalized in seen_recommended:
            continue
        if normalized not in remaining_ids:
            continue
        course = COURSE_MAP.get(normalized)
        if not course:
            continue
        recommended_cards.append(CourseCard(
            course_id=course["course_id"],
            title=course["title"],
            course_type=course.get("course_type", "Elective"),
            credits=3,
            is_completed=False,
            prerequisites_met=True,
        ))
        seen_recommended.add(normalized)

    # Preserve eligible_courses calculation so it remains part of the hot path
    # (Neo4j call wasn't free — keeping it avoids silently changing observable
    # behavior like connection errors surfacing to the student).
    _ = len(eligible_courses)

    return DegreePlannerResponse(
        narrative=narrative_text,
        progress=progress_data,
        recommended_courses=recommended_cards,
        semester_plan=[],
        remaining_core=remaining_core_cards,
        remaining_elective=remaining_elective_cards,
        choice_group_notes=list_notes or [],
        invalid_courses=invalid_course_ids,
        corrections=result.get("corrections", []),
    )