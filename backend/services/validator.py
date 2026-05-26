import re
import json
import os
from difflib import get_close_matches, SequenceMatcher

DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "data")

# Load valid course IDs once at startup
def _load_valid_courses() -> dict[str, str]:
    """
    Returns a dict of course_id -> title for all valid courses.
    """
    from backend.services.course_loader import load_all_courses
    return {
        c["course_id"].strip().upper(): c["title"]
        for c in load_all_courses()
        if c.get("course_id") and c.get("title")
    }

VALID_COURSES = _load_valid_courses()
VALID_IDS     = list(VALID_COURSES.keys())
VALID_TITLES  = list(VALID_COURSES.values())


def _norm_title(s: str) -> str:
    s = (s or "").strip().lower()
    # keep alphanumerics/spaces only
    s = re.sub(r"[^a-z0-9\s]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


TITLE_TO_ID: dict[str, str] = {
    _norm_title(title): course_id
    for course_id, title in VALID_COURSES.items()
    if title
}
NORM_TITLES: list[str] = list(TITLE_TO_ID.keys())

# Regex: standard numeric sections (BUAN 6341) and variable-credit style (BUAN 6V98, IMS 6V92).
COURSE_ID_PATTERN = re.compile(
    r"\b([A-Z]{2,5})\s?(\d{4,5}|\d[V]\d{2})\b",
    re.IGNORECASE,
)


def extract_course_ids(text: str) -> list[str]:
    """
    Extracts all course ID mentions from a text string.
    Normalizes spacing e.g. BUAN6341 -> BUAN 6341
    """
    matches = COURSE_ID_PATTERN.findall(text or "")
    out: list[str] = []
    for prefix, number in matches:
        out.append(f"{prefix.upper()} {number.upper()}")
    return out


def validate_course_id(course_id: str) -> dict:
    """
    Checks if a course ID is valid.
    If not, finds the closest valid match.
    Returns:
      - valid: bool
      - original: str
      - corrected: str | None
      - title: str | None
    """
    normalized = course_id.strip().upper()

    if normalized in VALID_COURSES:
        return {
            "valid":     True,
            "original":  course_id,
            "corrected": normalized,
            "title":     VALID_COURSES[normalized]
        }

    # Find closest match
    close = get_close_matches(normalized, VALID_IDS, n=1, cutoff=0.7)

    if close:
        return {
            "valid":     False,
            "original":  course_id,
            "corrected": close[0],
            "title":     VALID_COURSES[close[0]]
        }

    return {
        "valid":     False,
        "original":  course_id,
        "corrected": None,
        "title":     None
    }


def resolve_course_input(course_input: str) -> dict:
    """
    Resolves student input that may be a course ID ("BUAN 6312") OR a course title
    ("Applied Econometrics and Time Series Analysis") into a canonical course ID.

    Returns the same shape as validate_course_id(), plus:
      - matched_by: "id" | "title" | None
      - score: float | None  (title match similarity 0..1)
    """
    raw = (course_input or "").strip()
    if not raw:
        return {
            "valid": False,
            "original": course_input,
            "corrected": None,
            "title": None,
            "matched_by": None,
            "score": None,
        }

    # 1) If it looks like an ID, use ID validation/correction first.
    if COURSE_ID_PATTERN.search(raw.upper()):
        r = validate_course_id(raw)
        r["matched_by"] = "id"
        r["score"] = 1.0 if r["valid"] else None
        return r

    # 2) Try exact normalized title lookup.
    norm = _norm_title(raw)
    if norm in TITLE_TO_ID:
        cid = TITLE_TO_ID[norm]
        return {
            "valid": False,
            "original": course_input,
            "corrected": cid,
            "title": VALID_COURSES[cid],
            "matched_by": "title",
            "score": 1.0,
        }

    # 3) Try substring candidates, then best similarity.
    candidates = [t for t in NORM_TITLES if norm and norm in t]
    if not candidates:
        candidates = get_close_matches(norm, NORM_TITLES, n=5, cutoff=0.55)

    best_title = None
    best_score = 0.0
    for t in candidates[:25]:
        score = SequenceMatcher(a=norm, b=t).ratio()
        if score > best_score:
            best_score = score
            best_title = t

    if best_title and best_score >= 0.62:
        cid = TITLE_TO_ID[best_title]
        return {
            "valid": False,
            "original": course_input,
            "corrected": cid,
            "title": VALID_COURSES[cid],
            "matched_by": "title",
            "score": round(best_score, 3),
        }

    return {
        "valid": False,
        "original": course_input,
        "corrected": None,
        "title": None,
        "matched_by": None,
        "score": None,
    }


def soften_length_truncation(text: str) -> str:
    """
    If generation stopped at the token limit, trim to the last complete sentence
    in the latter part of the reply so it does not end mid-clause.
    """
    t = (text or "").rstrip()
    if len(t) < 80:
        return t
    zone_start = max(0, int(len(t) * 0.35))
    best = -1
    for m in re.finditer(r"[.!?](?:\s+|$)", t):
        if m.end() >= zone_start:
            best = m.end()
    if best > zone_start:
        return t[:best].rstrip()
    br = t.rfind("\n\n")
    if br >= zone_start:
        return t[:br].rstrip()
    return t.rstrip() + "…"


def strip_markdown_to_plain(text: str) -> str:
    """
    Remove common Markdown artifacts so chat UIs show clean plain text
    (models often emit #, **, --- despite instructions).
    """
    s = (text or "").strip()
    if not s:
        return s

    def _fence_body(m):
        inner = (m.group(1) or "").strip()
        return inner if inner else ""

    s = re.sub(r"```(?:\w+)?\s*([\s\S]*?)```", _fence_body, s)
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"(?m)^#{1,6}\s*", "", s)
    s = re.sub(r"(?m)^\s*>\s?", "", s)
    s = re.sub(r"(?m)^\s*(?:---|\*\*\*|___)\s*$", "", s)

    for _ in range(5):
        prev = s
        s = re.sub(r"\*\*([^*]+)\*\*", r"\1", s)
        s = re.sub(r"__([^_]+)__", r"\1", s)
        if s == prev:
            break

    s = re.sub(r"(?m)^\s*[\*\+-]\s+", "- ", s)
    s = re.sub(r"(?<!\*)\*([^*\n]+)\*(?!\*)", r"\1", s)
    s = re.sub(r"(?<!_)_([^_\n]+)_(?!_)", r"\1", s)
    s = re.sub(r"~~([^~]+)~~", r"\1", s)
    s = re.sub(r"\n{3,}", "\n\n", s)
    return s.strip()


def _load_course_title_map() -> dict[str, str]:
    """
    course_id -> exact title (from all loaded program course catalogs)
    """
    from backend.services.course_loader import load_all_courses
    courses = load_all_courses()
    return {str(c["course_id"]).strip().upper(): str(c["title"]).strip() for c in courses if c.get("course_id") and c.get("title")}


def validate_and_fix_titles(text: str) -> dict:
    """
    Replace incorrect/paraphrased course titles near course IDs with the exact catalog title.

    Strategy:
    - Find course IDs in text (same regex)
    - For each ID, look at up to ~10 words after the ID
    - If there's a "ID — Title" or "ID - Title" pattern and Title differs, replace with exact title
    """
    fixed = text or ""
    title_map = _load_course_title_map()
    corrections: list[dict] = []

    # Work on a snapshot of matches so replacements don't affect iteration offsets.
    matches = list(COURSE_ID_PATTERN.finditer(fixed))
    for m in reversed(matches):
        cid = f"{m.group(1).upper()} {m.group(2)}"
        exact = title_map.get(cid)
        if not exact:
            continue

        after = fixed[m.end():]
        # Look ahead window: first 10 "word" tokens
        words = re.findall(r"\S+", after)
        window = " ".join(words[:10])

        # If exact title already present in near window, do nothing.
        if exact.lower() in window.lower():
            continue

        # Try to detect "ID — something" right after the ID in the original string
        # Capture until newline or "(" to avoid swallowing metadata like (Core)
        pattern = re.compile(
            re.escape(cid) + r"\s*(?:—|-|:)\s*([^\n(]{3,120})",
            flags=re.IGNORECASE,
        )
        seg = fixed[max(0, m.start() - 8) : min(len(fixed), m.end() + 220)]
        pm = pattern.search(seg)
        if not pm:
            continue

        found_title = pm.group(1).strip()
        if not found_title or found_title.lower() == exact.lower():
            continue

        # Replace only this occurrence inside the segment, then splice back.
        before = fixed[: max(0, m.start() - 8)]
        after_full = fixed[min(len(fixed), m.end() + 220) :]
        seg_fixed = seg[: pm.start(1)] + exact + seg[pm.end(1) :]
        fixed = before + seg_fixed + after_full
        corrections.append({"course_id": cid, "from": found_title, "to": exact})

    return {"text": fixed, "title_corrections": corrections}


def validate_and_fix_response(text: str) -> dict:
    """
    Main validation function.
    Scans LLM response for course ID mentions,
    validates each one, and replaces invalid IDs
    with corrected versions in the response text.

    Returns:
      - text: corrected response text
      - corrections: list of corrections made
      - removed: list of IDs that had no valid match
    """
    found_ids   = extract_course_ids(text)
    corrections = []
    removed     = []
    fixed_text  = text

    for course_id in set(found_ids):
        result = validate_course_id(course_id)

        if result["valid"]:
            # Already correct — normalize spacing just in case
            normalized = result["corrected"]
            if course_id != normalized:
                fixed_text = fixed_text.replace(course_id, normalized)
            continue

        if result["corrected"]:
            # Replace with corrected ID and title
            corrected = result["corrected"]
            title     = result["title"]
            fixed_text = fixed_text.replace(
                course_id,
                f"{corrected} ({title})"
            )
            corrections.append({
                "original":  course_id,
                "corrected": corrected,
                "title":     title
            })
        else:
            # No valid match found — flag it
            fixed_text = fixed_text.replace(
                course_id,
                f"[INVALID COURSE ID: {course_id}]"
            )
            removed.append(course_id)

    fixed_text = strip_markdown_to_plain(fixed_text)

    return {
        "text":        fixed_text,
        "corrections": corrections,
        "removed":     removed
    }


def validate_course_list(course_ids: list[str]) -> dict:
    """
    Validates a list of course IDs (e.g. from student input).
    Returns valid courses and flags invalid ones.
    """
    valid   = []
    invalid = []

    for course_input in course_ids:
        resolved = resolve_course_input(course_input)

        # If it was an exact ID match, it's already valid.
        if resolved.get("matched_by") == "id" and resolved.get("valid"):
            valid.append({
                "course_id": resolved["corrected"],
                "title": resolved["title"],
            })
            continue

        # If we can correct it to a valid ID (title match OR close ID match), accept it.
        if resolved.get("corrected") and resolved["corrected"] in VALID_COURSES:
            valid.append({
                "course_id": resolved["corrected"],
                "title": VALID_COURSES[resolved["corrected"]],
            })
            # record as invalid correction (so UI can show what was normalized)
            invalid.append(resolved)
            continue

        invalid.append(resolved)

    return {"valid": valid, "invalid": invalid}