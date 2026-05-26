import base64
import io
import re

import pdfplumber
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


class TranscriptRequest(BaseModel):
    id: str
    pdf_content: str  # base64 encoded PDF
    token: str | None = None


PROGRAM_TYPE_RE = re.compile(r"^Program:\s+(.+)$", re.IGNORECASE)
COURSE_CODE_RE = re.compile(r"^([A-Z]{2,4})\s+(\d[A-Z0-9]{3})\b")
GPA_RE = re.compile(r"^Cum GPA\s+([\d.]+)", re.IGNORECASE)
CUM_TOTALS_RE = re.compile(r"^Cum Totals\s+([\d.]+)", re.IGNORECASE)
CIP_RE = re.compile(r"CIP:\s*[\d.]+", re.IGNORECASE)
DATE_PREFIX_RE = re.compile(r"^\d{4}-\d{2}-\d{2}:\s*")
EXTERNAL_DEGREES_RE = re.compile(r"External Degree(s)?", re.IGNORECASE)
SKIP_RE = re.compile(
    r"^(Instructor:|Term GPA|Transfer Term|Combined GPA|"
    r"Transfer Cum|Combined Cum|Academic Standing|Beginning of|"
    r"End of|Print Date|Student ID:|Name:|Attempted|Earned\s+GPA|"
    r"Unofficial Transcript|External Degrees|Academic Program History|"
    r"Graduate Career Totals|\d+\s+\d+$|Course\s+Description)",
    re.IGNORECASE,
)


def extract_lines(pdf_bytes: bytes) -> list[str]:
    lines: list[str] = []
    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
        for page in pdf.pages:
            text = page.extract_text(x_tolerance=2, y_tolerance=2)
            if not text:
                continue
            for line in text.split("\n"):
                line = line.strip()
                if line:
                    lines.append(line)
    return lines


def parse_programs(lines: list[str]) -> tuple[list, list, list]:
    majors: list = []
    minors: list = []
    certifications: list = []

    # Pre-process: pdfplumber often splits "CIP: 30.7102" across two lines
    joined_lines: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if re.search(r"CIP:\s*$", line) and i + 1 < len(lines):
            next_line = lines[i + 1].strip()
            if re.match(r"^[\d.]+$", next_line):
                line = line.rstrip() + " " + next_line
                i += 2
                joined_lines.append(line)
                continue
        joined_lines.append(line)
        i += 1

    in_program_history = False
    in_external_degrees = False
    current_type: str | None = None
    current_start_date: str | None = None

    for line in joined_lines:
        if "Academic Program History" in line:
            in_program_history = True
            in_external_degrees = False
            continue

        if EXTERNAL_DEGREES_RE.search(line):
            in_external_degrees = True
            in_program_history = False
            continue

        if re.search(r"Beginning of (Graduate|Undergraduate) Record", line):
            in_program_history = False
            in_external_degrees = False
            continue

        if in_external_degrees:
            continue

        if not in_program_history:
            continue

        prog_match = PROGRAM_TYPE_RE.match(line)
        if prog_match:
            current_type = prog_match.group(1).strip()
            continue

        date_match = re.match(
            r"^(\d{4}-\d{2}-\d{2}):\s*Active in Program",
            line,
        )
        if date_match:
            raw_date = date_match.group(1)
            year = int(raw_date[:4])
            month = int(raw_date[5:7])
            if month >= 8:
                season = "Fall"
            elif month >= 5:
                season = "Summer"
            else:
                season = "Spring"
            current_start_date = f"{year} {season}"
            continue

        if CIP_RE.search(line) and current_type:
            name_raw = DATE_PREFIX_RE.sub("", line)
            name_raw = CIP_RE.sub("", name_raw)
            # Some transcript exports repeat "Program: X" on the same line as CIP.
            name_raw = re.sub(r"^\s*Program:\s*", "", name_raw, flags=re.IGNORECASE).strip()
            name_raw = re.sub(
                r"\s+Major\s*$",
                "",
                name_raw,
                flags=re.IGNORECASE,
            ).strip()
            # Avoid misclassifying external-degree/equivalency rows as active programs.
            lowered = name_raw.lower()
            if any(tok in lowered for tok in ("equiv", "equival", "us bach", "bachelor", "associate", "high school")):
                current_type = None
                current_start_date = None
                continue
            # Drop overly-generic entries that provide no useful program name.
            if lowered in ("master", "masters", "graduate", "undergraduate"):
                current_type = None
                current_start_date = None
                continue

            if not name_raw:
                current_type = None
                current_start_date = None
                continue

            is_cert = "certificate" in current_type.lower()
            is_master = "master" in current_type.lower()

            program_entry = {
                "name": name_raw,
                "program_level": "Graduate",
                "status": "Active",
                "school": "Naveen Jindal School of Management",
                "start_date": current_start_date or "",
                "concentration": None,
            }

            if is_cert:
                certifications.append(program_entry)
            elif is_master:
                majors.append(program_entry)
            else:
                minors.append(program_entry)

            current_type = None
            current_start_date = None

    return majors, minors, certifications


def parse_courses(lines: list[str]) -> tuple[dict, list, list, float, int]:
    utd_classes: dict[str, list] = {}
    transfer_credits: list = []
    test_credits: list = []
    cum_gpa = 0.0
    cum_hours = 0

    current_semester: str | None = None
    in_record = False
    seen_courses: dict[str, set[str]] = {}

    for line in lines:
        if re.search(r"Beginning of (Graduate|Undergraduate) Record", line):
            in_record = True
            continue

        if re.search(r"End of Unofficial Transcript", line):
            break

        if not in_record:
            continue

        if SKIP_RE.match(line):
            continue

        gpa_match = GPA_RE.match(line)
        if gpa_match:
            try:
                cum_gpa = float(gpa_match.group(1))
            except ValueError:
                pass
            continue

        totals_match = CUM_TOTALS_RE.match(line)
        if totals_match:
            try:
                cum_hours = int(float(totals_match.group(1)))
            except ValueError:
                pass
            continue

        sem_match = re.match(
            r"^(?:Term:\s*)?(\d{4})\s+(Fall|Spring|Summer|Winter)\s*:?\s*$|"
            r"^(?:Term:\s*)?(Fall|Spring|Summer|Winter)\s+(\d{4})\s*:?\s*$",
            line,
            re.IGNORECASE,
        )
        if sem_match:
            if sem_match.group(1):
                semester = f"{sem_match.group(1)} {sem_match.group(2).capitalize()}"
            else:
                semester = f"{sem_match.group(4)} {sem_match.group(3).capitalize()}"

            current_semester = semester
            if semester not in utd_classes:
                utd_classes[semester] = []
                seen_courses[semester] = set()
            continue

        course_match = COURSE_CODE_RE.match(line)
        if course_match and current_semester:
            dept = course_match.group(1).upper()
            num = course_match.group(2).upper()
            course_code = f"{dept} {num}"

            if course_code in seen_courses.get(current_semester, set()):
                continue

            after_code = line[course_match.end() :].strip()

            full_match = re.match(
                r"^(.+?)\s+(\d+\.\d{3})\s+(\d+\.\d{3})\s+(\S+)\s+([\d.]+)$",
                after_code,
            )
            if full_match:
                course_name = full_match.group(1).strip()
                credits_attempted = float(full_match.group(2))
                credits_earned = float(full_match.group(3))
                grade = full_match.group(4)
                points = float(full_match.group(5))
            else:
                course_name = re.sub(r"\s+\d+\.\d{3}.*$", "", after_code).strip()
                credits_attempted = 3.0
                credits_earned = 3.0
                grade = ""
                points = 0.0

            course_entry = {
                "course_code": course_code,
                "course_name": course_name,
                "credits_attempted": credits_attempted,
                "credits_earned": credits_earned,
                "grade": grade,
                "points": points,
            }

            utd_classes[current_semester].append(course_entry)
            seen_courses[current_semester].add(course_code)

    return utd_classes, transfer_credits, test_credits, cum_gpa, cum_hours


@router.post("/parse-transcript")
def parse_transcript(request: TranscriptRequest) -> dict:
    try:
        pdf_bytes = base64.b64decode(request.pdf_content)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 PDF content") from None

    try:
        lines = extract_lines(pdf_bytes)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Could not read PDF: {e!s}") from e

    try:
        majors, minors, certifications = parse_programs(lines)
        utd_classes, transfer_credits, test_credits, cum_gpa, cum_hours = parse_courses(lines)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Parse error: {e!s}") from e

    is_grad = any(
        p.get("program_level") == "Graduate"
        for p in majors + certifications
    )

    transcript_data = {
        "majors": majors,
        "minors": minors,
        "certifications": certifications,
        "courses": {
            "utd_classes": utd_classes,
            "transfer_credits": transfer_credits,
            "test_credits": test_credits,
        },
        "gpa": {
            "graduate": cum_gpa if is_grad else 0.0,
            "undergraduate": cum_gpa if not is_grad else 0.0,
        },
        "credit_hours": {
            "graduate": cum_hours if is_grad else 0,
            "undergraduate": cum_hours if not is_grad else 0,
        },
    }

    return {
        "message": "Transcript processed successfully",
        "transcript_data": transcript_data,
    }
