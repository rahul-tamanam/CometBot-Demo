import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv()

app = FastAPI(
    title="MSBA Smart Advisor API",
    description="AI-powered academic and career advisor for MSBA students",
    version="1.0.0"
)

# Browsers treat localhost vs 127.0.0.1 as different origins; preflight fails with 400 if missing.
_default_cors = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
)
_cors_env = os.getenv("CORS_ALLOW_ORIGINS", "").strip()
_cors_origins = (
    [o.strip() for o in _cors_env.split(",") if o.strip()] if _cors_env else list(_default_cors)
)

import inspect

_cors_kwargs = {
    "allow_origins": _cors_origins,
    "allow_methods": ["*"],
    "allow_headers": ["*"],
}

# Chrome “Private Network Access” (Access-Control-Request-Private-Network) support.
# Starlette may not support this kwarg in older versions; avoid passing it unless supported.
try:
    sig = inspect.signature(CORSMiddleware.__init__)
    if "allow_private_network" in sig.parameters:
        _cors_kwargs["allow_private_network"] = True
except Exception:
    # If signature introspection fails for any reason, omit the kwarg.
    pass

app.add_middleware(CORSMiddleware, **_cors_kwargs)

@app.get("/api/health")
def health_check():
    groq_configured = bool(os.getenv("GROQ_API_KEY", "").strip())
    return {
        "status": "ok",
        "message": "CometBot API is running (portfolio demo)",
        "demo_mode": True,
        "llm_configured": groq_configured,
    }


@app.get("/api/courses")
def get_all_courses(program_id: str = "msba"):
    from backend.services.course_loader import load_courses_for_program
    courses = load_courses_for_program(program_id)
    return [
        {
            "course_id":    c["course_id"],
            "title":        c["title"],
            "course_type":  c["course_type"],
            "credits":      c.get("credits", 3),
            "course_track": c.get("course_track"),
        }
        for c in courses
        # Include NonCredit (e.g. MAS 6102 PD) so course history can record them; degree math ignores them in planners.
        if (c.get("course_type") or "").strip().lower() != "external"
    ]


@app.get("/api/programs")
def get_programs():
    import json
    programs_dir = os.path.join(os.path.dirname(__file__), "data", "programs")
    result = []
    for pid in os.listdir(programs_dir):
        rules_path = os.path.join(programs_dir, pid, "rules.json")
        if os.path.exists(rules_path):
            with open(rules_path, encoding="utf-8") as f:
                rules = json.load(f)
            result.append({
                "program_id":   rules.get("program_id", pid),
                "program_name": rules.get("program_name", pid.upper())
            })
    return result


@app.get("/api/certificates")
def get_certificates(program_id: str = "msba"):
    import json
    certs_path = os.path.join(
        os.path.dirname(__file__), "data", "certificates",
        f"{program_id}_certs.json"
    )
    if not os.path.exists(certs_path):
        return []
    with open(certs_path, encoding="utf-8") as f:
        return json.load(f)

from backend.routers import degree_planner, career_mentor, skills_gap, transcript_parser

app.include_router(
    degree_planner.router,
    prefix="/api/degree-planner",
    tags=["Degree Planner"]
)
app.include_router(
    career_mentor.router,
    prefix="/api/career-mentor",
    tags=["Career Mentor"]
)
app.include_router(
    skills_gap.router,
    prefix="/api/skills-gap",
    tags=["Skills Gap"]
)
app.include_router(
    transcript_parser.router,
    prefix="/api",
    tags=["Transcript Parser"],
)