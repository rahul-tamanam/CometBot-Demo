import json
import os
import sys

sys.path.append(os.path.dirname(__file__))

from services.pinecone_client import upsert_courses, upsert_skills, upsert_certificates
from services.course_loader import load_all_courses

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")

def main():
    print("Loading all courses (deduplicated across programs)...\n")
    all_courses = load_all_courses()
    indexable_courses = [
        c for c in all_courses
        if (c.get("course_type") or "").strip().lower() not in ("noncredit", "external")
    ]
    print(f"Found {len(all_courses)} total courses, indexing {len(indexable_courses)} (excluding non-credit)...\n")
    print("Uploading courses to Pinecone...\n")
    upsert_courses(indexable_courses)

    for name in ["skills_clean.json", "skills.json"]:
        path = os.path.join(DATA_DIR, name)
        if os.path.exists(path):
            with open(path) as f:
                skills = json.load(f)
            break

    print(f"\nFound {len(skills)} job roles\n")
    upsert_skills(skills)

    certs_dir = os.path.join(DATA_DIR, "certificates")
    all_certs: list[dict] = []
    if os.path.isdir(certs_dir):
        for fname in sorted(os.listdir(certs_dir)):
            if not fname.endswith("_certs.json"):
                continue
            with open(os.path.join(certs_dir, fname), encoding="utf-8") as f:
                all_certs.extend(json.load(f))
    if all_certs:
        print(f"\nUploading {len(all_certs)} certificates to Pinecone...\n")
        upsert_certificates(all_certs)
    else:
        print("\n[warn] No certificate JSON files found under data/certificates/")

    print("\n[done] Pinecone index ready (courses, skills, certificates)")

if __name__ == "__main__":
    main()