"""
Catalog integrity checks for degree planner / profile validation.

Run from repo root:
  python tests/catalog_integrity_test.py

Or:
  python -m unittest tests.catalog_integrity_test -v
(requires PYTHONPATH including repo root, or run from repo root with python -m unittest)
"""

from __future__ import annotations

import json
import os
import re
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services.course_loader import load_all_courses, load_courses_for_program
from backend.services.validator import VALID_COURSES, validate_course_list, extract_course_ids

CERT_DIR = ROOT / "backend" / "data" / "certificates"

# Certificate JSON may reference courses not yet modeled under backend/data/courses/.
# Keep this set empty by adding catalog rows; any NEW gap outside this list fails CI.
KNOWN_CERT_IDS_MISSING_FROM_CATALOG: frozenset[str] = frozenset({"ACCT 6383", "PPPE 6315"})


def _looks_like_course_id_token(ref: str) -> bool:
    """UT Dallas-style IDs only (skips free-text placeholders like 'MBA MAJOR')."""
    n = _normalize_id(ref)
    return bool(re.match(r"^[A-Z]{2,5}\s+(\d{4,5}|\dV\d{2})$", n))


def _normalize_id(cid: str) -> str:
    return (cid or "").strip().upper().replace("  ", " ").strip()


def _iter_prerequisite_ids(prerequisites) -> list[str]:
    """Flatten prerequisite structure into normalized course IDs."""
    out: list[str] = []
    if not prerequisites:
        return out
    for group in prerequisites:
        if isinstance(group, list):
            for x in group:
                if isinstance(x, str) and x.strip():
                    out.append(_normalize_id(x))
        elif isinstance(group, str) and group.strip():
            out.append(_normalize_id(group))
    return out


def _cert_course_ids_from_file(path: Path) -> list[str]:
    ids: list[str] = []
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    for cert in data:
        blocks = cert.get("course_id") or []
        if not isinstance(blocks, list):
            continue
        for cell in blocks:
            if isinstance(cell, list):
                for raw in cell:
                    if isinstance(raw, str) and raw.strip():
                        ids.append(_normalize_id(raw))
            elif isinstance(cell, str) and cell.strip():
                ids.append(_normalize_id(cell))
    return ids


class TestCatalogIntegrity(unittest.TestCase):
    def test_every_catalog_row_has_id_and_title(self) -> None:
        """Validator only accepts IDs present in VALID_COURSES (requires title)."""
        bad: list[str] = []
        for c in load_all_courses():
            cid = (c.get("course_id") or "").strip()
            title = (c.get("title") or "").strip()
            if not cid:
                bad.append("row missing course_id")
            elif not title:
                bad.append(f"{cid}: missing or empty title (excluded from VALID_COURSES)")
        self.assertEqual(
            bad,
            [],
            "Catalog rows must have course_id and title:\n" + "\n".join(bad[:50])
            + (f"\n... and {len(bad) - 50} more" if len(bad) > 50 else ""),
        )

    def test_validate_course_list_accepts_every_catalog_id(self) -> None:
        failures: list[str] = []
        for c in load_all_courses():
            cid = _normalize_id(c["course_id"])
            title = (c.get("title") or "").strip()
            if not cid or not title:
                continue
            result = validate_course_list([cid])
            val = result.get("valid") or []
            inv = result.get("invalid") or []
            if len(val) != 1 or inv:
                failures.append(f"{cid}: valid={val!r} invalid={inv!r}")
            elif val[0].get("course_id") != cid:
                failures.append(f"{cid}: got normalized id {val[0].get('course_id')!r}")
        self.assertEqual(failures, [], "\n".join(failures[:40]))

    def test_msba_msitm_program_courses_validate(self) -> None:
        failures: list[str] = []
        for pid in ("msba", "msitm"):
            for c in load_courses_for_program(pid):
                cid = _normalize_id(c.get("course_id", ""))
                if not cid:
                    failures.append(f"{pid}: empty course_id in record")
                    continue
                result = validate_course_list([cid])
                if not result.get("valid"):
                    failures.append(f"{pid}: {cid} failed validation {result!r}")
        self.assertEqual(failures, [], "\n".join(failures))

    def test_prerequisite_and_only_one_references_exist(self) -> None:
        if os.environ.get("JSOM_ADVISOR_STRICT_PREREQS") != "1":
            self.skipTest(
                "Prerequisite graph closure is optional; set JSOM_ADVISOR_STRICT_PREREQS=1 to enforce "
                "(many catalogs reference courses not yet imported as rows)."
            )
        all_ids = {_normalize_id(c["course_id"]) for c in load_all_courses() if c.get("course_id")}
        failures: list[str] = []
        for c in load_all_courses():
            cid = _normalize_id(c.get("course_id", ""))
            for pid in _iter_prerequisite_ids(c.get("prerequisites")):
                if not _looks_like_course_id_token(pid):
                    continue
                if pid not in all_ids:
                    failures.append(f"{cid}: prerequisite references unknown course {pid}")
            for x in c.get("only_one_of_these") or []:
                if isinstance(x, str):
                    u = _normalize_id(x)
                    if not _looks_like_course_id_token(u):
                        continue
                    if u not in all_ids:
                        failures.append(f"{cid}: only_one_of_these references unknown {u}")
        self.assertEqual(failures, [], "\n".join(failures[:80]))

    def test_certificate_json_course_ids_validate(self) -> None:
        unknown: list[str] = []
        validation_failures: list[str] = []
        for path in sorted(CERT_DIR.glob("*_certs.json")):
            for cid in _cert_course_ids_from_file(path):
                if cid not in VALID_COURSES:
                    if cid not in KNOWN_CERT_IDS_MISSING_FROM_CATALOG:
                        unknown.append(f"{path.name}: {cid} not in catalog (add course JSON or allowlist intentionally)")
                    continue
                r = validate_course_list([cid])
                if not r.get("valid"):
                    validation_failures.append(f"{path.name}: {cid} validate_course_list failed {r!r}")
        self.assertEqual(
            unknown,
            [],
            "Certificate references must resolve via validator:\n" + "\n".join(unknown),
        )
        self.assertEqual(validation_failures, [], "\n".join(validation_failures))

    def test_extract_course_ids_roundtrip_on_sample_strings(self) -> None:
        """Sanity check regex used in chat matches typical IDs."""
        samples = [
            ("Completed BUAN 6341 last fall.", ["BUAN 6341"]),
            ("OPRE6305 and MIS 6380", ["OPRE 6305", "MIS 6380"]),
            ("internship BUAN6V98 option", ["BUAN 6V98"]),
        ]
        for text, expected in samples:
            got = extract_course_ids(text)
            self.assertEqual(got, expected, f"extract_course_ids({text!r})")


if __name__ == "__main__":
    unittest.main(verbosity=2)
