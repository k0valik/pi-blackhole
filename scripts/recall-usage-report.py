#!/usr/bin/env python3
"""Recall usage report for pi session files.

Read-only analysis of how the `recall` tool is actually used across session
JSONL files. Intended for design work on the recall surface, not production.

What it measures
----------------
- how often `recall` / legacy `vcc_recall` is called, and by query shape
  (free text, `#N`, `#N:path`/`#N:text`, 12-hex memory ids, expand-only,
  touched-file view);
- whether calls happen before/after an observational-memory compaction;
- if a memory-id call resolved, whether the id was visible in a prior
  compaction summary, and whether it points at an observation or reflection;
- per-session call counts and "tangents" (calls clustered within N assistant
  messages of a previous call);
- how models mix `#N` with free text in one query string (the tool currently
  treats the whole string as a text search);
- source spans of observations/reflections, expressed in the transcript's
  `#N` message-index space, to judge whether range references are useful.

`#N` is the session-global index of `type:"message"` entries only (tool results
included, custom entries excluded). It is not the same namespace as the
12-hex content-hash ids used by observational memory.

Usage
-----
    python3 scripts/recall-usage-report.py
    python3 scripts/recall-usage-report.py --sessions-root ~/.pi/agent/sessions
    python3 scripts/recall-usage-report.py --exclude my-repo --out-dir /tmp/report
    python3 scripts/recall-usage-report.py --dump-calls --examples 5

By default sessions under a path/cwd containing "pi-blackhole-dev" are
excluded: recall is part of that repo's code and its test sessions are not
representative. Use --no-default-exclude to include them, or add more
--exclude substrings.

Outputs (default: tmp/recall-usage/)
------------------------------------
- report.txt     human-readable summary
- summary.json   machine-readable aggregates
- calls.jsonl    optional, only with --dump-calls (contains session content)

This script only reads session files. It never modifies them. Output files may
contain excerpts of session text; treat them as private.
"""

from __future__ import annotations

import argparse
import collections
import glob
import json
import os
import re
import statistics
import sys
import time

HEX12_RE = re.compile(r"^[a-f0-9]{12}$", re.I)
HEX16_RE = re.compile(r"^[a-f0-9]{16}$", re.I)
HEX_ANY_RE = re.compile(r"^[a-f0-9]{8,64}$", re.I)
ENTRY_RE = re.compile(r"^#(\d+)(?::(.*))?$", re.S)
MIXED_ENTRY_RE = re.compile(r"^#(\d+)\s+\S", re.S)
ID_IN_TEXT_RE = re.compile(r"\[([a-f0-9]{12})\]", re.I)
HEX_IN_TEXT_RE = re.compile(r"\b[a-f0-9]{12}\b", re.I)

DEFAULT_EXCLUDE = ["pi-blackhole-dev"]
DEFAULT_AGENT_DIR = os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.pi/agent")
DEFAULT_SESSIONS_ROOT = os.path.join(DEFAULT_AGENT_DIR, "sessions")
DEFAULT_OUT_DIR = os.path.join(os.getcwd(), "tmp", "recall-usage")

TOOL_NAMES = ("recall", "vcc_recall")
ALLOWED_MODES = {"hybrid", "file", "touched"}
ALLOWED_SCOPES = {"lineage", "all"}
OM_OBS_TYPES = ("om.observations.recorded", "om.observation")
OM_REF_TYPES = ("om.reflections.recorded",)


def iter_session_files(root: str) -> list[str]:
    files = glob.glob(os.path.join(root, "**", "*.jsonl"), recursive=True)
    return sorted(p for p in files if "/.trash/" not in p and not p.endswith(".exit"))


def load_entries(path: str) -> list[dict]:
    entries: list[dict] = []
    with open(path, "r", errors="ignore") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return entries


def header_cwd(entries: list[dict]) -> str | None:
    for entry in entries:
        if entry.get("type") == "session":
            cwd = entry.get("cwd")
            return cwd if isinstance(cwd, str) else None
    return None


def tool_result_text(msg: dict) -> str:
    content = msg.get("content")
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return ""


def parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            value = json.loads(raw)
            return value if isinstance(value, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def summary_sections(summary: str) -> tuple[set[str], set[str], bool]:
    """Return (observation ids, reflection ids, has an OM section)."""
    obs: set[str] = set()
    ref: set[str] = set()
    current: str | None = None
    has_section = False
    for line in summary.splitlines():
        stripped = line.strip()
        if stripped.startswith("## Reflections"):
            current = "ref"
            has_section = True
        elif stripped.startswith("## Observations"):
            current = "obs"
            has_section = True
        elif stripped.startswith("## ") or stripped.startswith("----"):
            current = None
        elif current:
            for match in ID_IN_TEXT_RE.finditer(line):
                (ref if current == "ref" else obs).add(match.group(1).lower())
    return obs, ref, has_section


def classify_query(args: dict) -> str:
    mode = args.get("mode")
    query = args.get("query")
    q = query.strip() if isinstance(query, str) else ""
    if mode == "touched":
        return "touched"
    if HEX12_RE.match(q):
        return "hex12"
    if HEX16_RE.match(q):
        return "hex16"
    if HEX_ANY_RE.match(q):
        return "hex-other"
    match = ENTRY_RE.match(q) if q else None
    if match:
        return "drill" if match.group(2) else "entry"
    if q:
        return "text"
    if args.get("expand"):
        return "expand-only"
    if mode:
        return "mode-only"
    return "none"


def classify_hex_result(text: str, hex_id: str) -> str:
    low = text.lower()
    if "no observation or reflection with id" in low:
        return "not_found"
    if "memory id must be" in low or "must be 12 lowercase hex" in low:
        return "bad_id"
    if "no matches" in low or "no results" in low or "no entries" in low:
        return "empty"
    if hex_id.lower() in low or "sources:" in low or "related observations:" in low:
        return "found"
    return "other"


def classify_generic_result(text: str) -> str:
    low = text.lower()
    if "session file available" in low:
        return "no_session_file"
    if "no matches" in low or "no results" in low or "no entries" in low:
        return "empty"
    if "error" in low and "error)" not in low:
        return "error-ish"
    if text.strip():
        return "nonempty"
    return "empty"


def pct(n: int, d: int) -> str:
    return f"{100.0 * n / d:.1f}%" if d else "n/a"


def span_bucket(span: int) -> str:
    if span <= 0:
        return "1"
    if span == 1:
        return "2"
    if span <= 5:
        return "3-5"
    if span <= 20:
        return "6-20"
    if span <= 100:
        return "21-100"
    return ">100"


def summarize_spans(spans: list[int]) -> dict:
    if not spans:
        return {"n": 0}
    ordered = sorted(spans)
    n = len(ordered)
    return {
        "n": n,
        "median": statistics.median(ordered),
        "p75": ordered[int(n * 0.75)],
        "p90": ordered[int(n * 0.90)],
        "p99": ordered[int(n * 0.99)],
        "max": ordered[-1],
    }


def build_index_maps(entries: list[dict]) -> tuple[dict[str, int], dict[str, dict], dict[str, dict]]:
    """Return (#N index by entry id, observation by id, reflection by id)."""
    index_by_id: dict[str, int] = {}
    ambiguous_ids: set[str] = set()
    observations: dict[str, dict] = {}
    reflections: dict[str, dict] = {}
    message_index = 0
    for entry in entries:
        if entry.get("type") == "message":
            entry_id = entry.get("id")
            if isinstance(entry_id, str):
                # Mirror buildGlobalIndexById: duplicate ids are ambiguous and
                # must not silently resolve to one of the two positions.
                if entry_id in index_by_id or entry_id in ambiguous_ids:
                    index_by_id.pop(entry_id, None)
                    ambiguous_ids.add(entry_id)
                else:
                    index_by_id[entry_id] = message_index
            message_index += 1
            continue
        if entry.get("type") != "custom":
            continue
        custom_type = entry.get("customType")
        data = entry.get("data")
        if not isinstance(data, dict):
            continue
        if custom_type in OM_OBS_TYPES:
            records = data.get("observations", data.get("records", [])) or []
            for record in records:
                if isinstance(record, dict) and isinstance(record.get("id"), str):
                    observations.setdefault(record["id"].lower(), record)
        elif custom_type in OM_REF_TYPES:
            for record in data.get("reflections", []) or []:
                if isinstance(record, dict) and isinstance(record.get("id"), str):
                    reflections.setdefault(record["id"].lower(), record)
    return index_by_id, observations, reflections


def source_spans(
    observations: dict[str, dict],
    reflections: dict[str, dict],
    index_by_id: dict[str, int],
) -> tuple[dict, list[int], list[int]]:
    """Compute observation/reflection source spans in #N space.

    Returns the bucket summary plus the raw multi-entry spans, so callers can
    aggregate exact percentiles without rebuilding the observation maps.
    """
    obs_total = 0
    obs_no_mapped = 0
    obs_single = 0
    obs_multi_spans: list[int] = []
    obs_buckets = collections.Counter()
    ref_total = 0
    ref_no_mapped = 0
    ref_single = 0
    ref_multi_spans: list[int] = []
    ref_buckets = collections.Counter()

    obs_indices: dict[str, set[int]] = {}
    for obs_id, observation in observations.items():
        indices = {
            index_by_id[source_id]
            for source_id in observation.get("sourceEntryIds") or []
            if source_id in index_by_id
        }
        obs_indices[obs_id] = indices
        obs_total += 1
        if not indices:
            obs_no_mapped += 1
            obs_buckets["no_mapped"] += 1
        elif len(indices) == 1:
            obs_single += 1
            obs_buckets["1"] += 1
        else:
            span = max(indices) - min(indices)
            obs_multi_spans.append(span)
            obs_buckets[span_bucket(span)] += 1

    for reflection in reflections.values():
        indices: set[int] = set()
        for observation_id in reflection.get("supportingObservationIds") or []:
            observation = observations.get(str(observation_id).lower())
            if observation:
                indices |= obs_indices.get(str(observation_id).lower(), set())
        ref_total += 1
        if not indices:
            ref_no_mapped += 1
            ref_buckets["no_mapped"] += 1
        elif len(indices) == 1:
            ref_single += 1
            ref_buckets["1"] += 1
        else:
            span = max(indices) - min(indices)
            ref_multi_spans.append(span)
            ref_buckets[span_bucket(span)] += 1

    return (
        {
            "observations": {
                "total": obs_total,
                "no_mapped": obs_no_mapped,
                "single_entry": obs_single,
                "multi_entry": len(obs_multi_spans),
                "buckets": dict(obs_buckets),
            },
            "reflections": {
                "total": ref_total,
                "no_mapped": ref_no_mapped,
                "single_entry": ref_single,
                "multi_entry": len(ref_multi_spans),
                "buckets": dict(ref_buckets),
            },
        },
        obs_multi_spans,
        ref_multi_spans,
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Measure recall-tool usage across pi session files (read-only)."
    )
    parser.add_argument("--sessions-root", default=DEFAULT_SESSIONS_ROOT)
    parser.add_argument(
        "--exclude",
        action="append",
        default=None,
        help="Substring matched against session path and cwd; repeatable.",
    )
    parser.add_argument(
        "--no-default-exclude",
        action="store_true",
        help="Do not exclude paths containing 'pi-blackhole-dev'.",
    )
    parser.add_argument("--out-dir", default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--dump-calls",
        action="store_true",
        help="Write calls.jsonl (contains session excerpts; private).",
    )
    parser.add_argument(
        "--examples",
        type=int,
        default=0,
        help="Include N truncated query examples in report.txt/summary.json.",
    )
    parser.add_argument("--limit", type=int, default=0, help="Only scan the first N files (debug).")
    parser.add_argument("--quiet", action="store_true", help="Suppress progress on stderr.")
    args = parser.parse_args()

    excludes = list(args.exclude or [])
    if not args.no_default_exclude:
        excludes = DEFAULT_EXCLUDE + excludes
    excludes = [value for value in excludes if value]

    def is_excluded(path: str, cwd: str | None) -> bool:
        for value in excludes:
            if value in path or (cwd and value in cwd):
                return True
        return False

    if not os.path.isdir(args.sessions_root):
        print(f"sessions root not found: {args.sessions_root}", file=sys.stderr)
        return 2

    files = iter_session_files(args.sessions_root)
    if args.limit:
        files = files[: args.limit]
    os.makedirs(args.out_dir, exist_ok=True)

    totals = collections.Counter()
    by_kind = collections.Counter()
    by_tool = collections.Counter()
    nonhex_result = collections.Counter()
    hex_result = collections.Counter()
    hex_kind = collections.Counter()
    hex_visible = collections.Counter()
    after_om = collections.Counter()
    after_om_kind = collections.Counter()
    first_call_kind = collections.Counter()
    kind_sessions = collections.Counter()
    ref_shapes = collections.Counter()
    expand_lengths = collections.Counter()
    mode_values = collections.Counter()
    scope_values = collections.Counter()
    invalid_mode = collections.Counter()
    invalid_scope = collections.Counter()
    source_span_totals = collections.Counter()
    source_span_buckets = collections.Counter()
    source_span_multi: dict[str, list[int]] = {"observations": [], "reflections": []}
    project_stats = collections.defaultdict(collections.Counter)
    calls_per_session: list[int] = []
    sessions_with_compaction = 0
    sessions_with_recall = 0
    sessions_with_hex = 0
    sessions_with_entry = 0
    sessions_with_drill = 0
    sessions_with_text = 0
    sessions_with_expand_only = 0
    sessions_with_touched = 0
    sessions_with_rendered = 0
    sessions_using_rendered = 0
    sessions_with_om = 0
    sessions_with_om_and_hex = 0
    sessions_with_om_and_any_recall_after = 0
    sessions_with_om_and_no_recall_after = 0
    tangent_sessions = 0
    tangent_followups = 0
    calls_rows: list[dict] = []
    examples_mixed: list[dict] = []
    examples_hex_not_found: list[dict] = []

    totals["files_discovered"] = len(files)

    for file_index, path in enumerate(files, 1):
        entries = load_entries(path)
        if not entries:
            totals["files_empty"] += 1
            continue
        cwd = header_cwd(entries)
        if is_excluded(path, cwd):
            totals["files_excluded"] += 1
            continue
        totals["files_included"] += 1

        project = cwd or os.path.dirname(path).replace(args.sessions_root.rstrip("/") + "/", "")
        ps = project_stats[project]

        results: dict[str, dict] = {}
        visible_obs: set[str] = set()
        visible_ref: set[str] = set()
        rendered_obs: set[str] = set()
        rendered_ref: set[str] = set()
        queried_hex: set[str] = set()
        calls: list[dict] = []
        om_compactions = 0
        compactions = 0
        after_first_om = False
        assistant_seq = 0
        assistant_after_om = 0

        index_by_id, observations, reflections = build_index_maps(entries)
        spans, obs_multi, ref_multi = source_spans(observations, reflections, index_by_id)
        source_span_multi["observations"].extend(obs_multi)
        source_span_multi["reflections"].extend(ref_multi)
        for key in ("observations", "reflections"):
            section = spans[key]
            source_span_totals[f"{key}_total"] += section["total"]
            source_span_totals[f"{key}_no_mapped"] += section["no_mapped"]
            source_span_totals[f"{key}_single"] += section["single_entry"]
            source_span_totals[f"{key}_multi"] += section["multi_entry"]
            for bucket, count in section["buckets"].items():
                source_span_buckets[f"{key}:{bucket}"] += count

        for entry in entries:
            if entry.get("type") == "message":
                msg = entry.get("message") or {}
                if msg.get("role") == "toolResult":
                    tool_call_id = msg.get("toolCallId")
                    if isinstance(tool_call_id, str):
                        results[tool_call_id] = msg

        had_call_after_om = False

        for entry in entries:
            entry_type = entry.get("type")
            if entry_type == "compaction":
                compactions += 1
                summary = entry.get("summary") or ""
                s_obs, s_ref, has_section = (
                    summary_sections(summary) if isinstance(summary, str) else (set(), set(), False)
                )
                details = entry.get("details")
                has_folded = isinstance(details, dict) and isinstance(details.get("om.folded"), dict)
                if has_section or has_folded:
                    om_compactions += 1
                    after_first_om = True
                    visible_obs |= s_obs
                    visible_ref |= s_ref
                    rendered_obs |= s_obs
                    rendered_ref |= s_ref
                ps["compactions"] += 1
                ps["om_compactions"] += int(has_section or has_folded)
                continue
            if entry_type != "message":
                continue
            msg = entry.get("message") or {}
            if msg.get("role") != "assistant":
                continue
            assistant_seq += 1
            if after_first_om:
                assistant_after_om += 1
            for block in msg.get("content") or []:
                if not isinstance(block, dict) or block.get("type") != "toolCall":
                    continue
                name = block.get("name")
                if name not in TOOL_NAMES:
                    continue
                call_args = parse_args(block.get("arguments"))
                kind = classify_query(call_args)
                result = results.get(block.get("id"))
                text = tool_result_text(result) if result else ""
                query = call_args.get("query")
                query = query.strip() if isinstance(query, str) else ""

                call = {
                    "file": path,
                    "project": cwd,
                    "tool": name,
                    "kind": kind,
                    "seq": assistant_seq,
                    "query": query,
                    "expand": call_args.get("expand"),
                    "mode": call_args.get("mode"),
                    "scope": call_args.get("scope"),
                    "after_om": after_first_om,
                    "om_compactions": om_compactions,
                    "compactions": compactions,
                    "result": text[:500] if args.dump_calls else None,
                }
                calls.append(call)
                if args.dump_calls:
                    calls_rows.append(call)

                by_kind[kind] += 1
                by_tool[name] += 1
                totals["recall_calls"] += 1
                ps["recall_calls"] += 1
                ps[f"kind:{kind}"] += 1
                after_om["after" if after_first_om else "before"] += 1
                after_om_kind[f"{'after' if after_first_om else 'before'}:{kind}"] += 1
                if after_first_om:
                    had_call_after_om = True

                mode = call_args.get("mode")
                scope = call_args.get("scope")
                if isinstance(mode, str):
                    mode_values[mode] += 1
                    if mode not in ALLOWED_MODES:
                        invalid_mode[mode] += 1
                if isinstance(scope, str):
                    scope_values[scope] += 1
                    if scope not in ALLOWED_SCOPES:
                        invalid_scope[scope] += 1

                if kind == "hex12":
                    hex_id = query.lower()
                    queried_hex.add(hex_id)
                    if hex_id in observations:
                        hk = "observation"
                    elif hex_id in reflections:
                        hk = "reflection"
                    else:
                        hk = "unknown-id"
                    hex_kind[hk] += 1
                    if hex_id in visible_obs and hex_id in visible_ref:
                        visible = "both"
                    elif hex_id in visible_obs:
                        visible = "observation"
                    elif hex_id in visible_ref:
                        visible = "reflection"
                    else:
                        visible = "not-visible-in-prior-compaction"
                    hex_visible[visible] += 1
                    result_kind = classify_hex_result(text, hex_id)
                    hex_result[result_kind] += 1
                    if result_kind == "not_found" and len(examples_hex_not_found) < args.examples:
                        examples_hex_not_found.append(
                            {
                                "project": project,
                                "query": hex_id,
                                "result": text[:200],
                            }
                        )
                else:
                    nonhex_result[classify_generic_result(text)] += 1

                if kind == "entry" or kind == "drill":
                    ref_shapes["pure_entry" if kind == "entry" else "drill"] += 1
                elif MIXED_ENTRY_RE.match(query):
                    ref_shapes["entry_plus_terms"] += 1
                    if len(examples_mixed) < args.examples:
                        examples_mixed.append({"project": project, "query": query[:200]})
                elif kind in ("hex12", "hex16", "hex-other"):
                    ref_shapes[kind] += 1
                elif HEX_IN_TEXT_RE.search(query):
                    ref_shapes["hex12_in_text"] += 1

                expand = call_args.get("expand")
                if isinstance(expand, list) and expand:
                    expand_lengths[len(expand)] += 1
                    if len(expand) > 1 and all(isinstance(value, int) for value in expand):
                        unique = sorted(set(expand))
                        if unique == list(range(unique[0], unique[-1] + 1)):
                            ref_shapes["expand_consecutive"] += 1

        # Session-level accounting must include sessions with no recall call.
        if compactions:
            sessions_with_compaction += 1
        totals["assistant_messages"] += assistant_seq
        totals["assistant_messages_after_om"] += assistant_after_om
        ps["assistant_messages"] += assistant_seq
        ps["assistant_messages_after_om"] += assistant_after_om

        rendered = rendered_obs | rendered_ref
        queried_rendered = queried_hex & rendered
        totals["rendered_unique_ids"] += len(rendered)
        totals["queried_unique_ids"] += len(queried_hex)
        totals["queried_rendered_ids"] += len(queried_rendered)
        totals["queried_not_rendered_ids"] += len(queried_hex - rendered)
        if rendered:
            sessions_with_rendered += 1
            if queried_rendered:
                sessions_using_rendered += 1

        if om_compactions:
            sessions_with_om += 1
            ps["sessions_with_om_compaction"] += 1
            if queried_hex:
                sessions_with_om_and_hex += 1
                ps["sessions_with_om_and_hex"] += 1
            if had_call_after_om:
                sessions_with_om_and_any_recall_after += 1
                ps["sessions_with_om_and_any_recall_after"] += 1
            else:
                sessions_with_om_and_no_recall_after += 1
                ps["sessions_with_om_and_no_recall_after"] += 1

        if not calls:
            continue

        sessions_with_recall += 1
        calls_per_session.append(len(calls))
        first_call_kind[calls[0]["kind"]] += 1
        present = {call["kind"] for call in calls}
        for kind in present:
            kind_sessions[kind] += 1
        if "hex12" in present:
            sessions_with_hex += 1
        if "entry" in present:
            sessions_with_entry += 1
        if "drill" in present:
            sessions_with_drill += 1
        if "text" in present:
            sessions_with_text += 1
        if "expand-only" in present:
            sessions_with_expand_only += 1
        if "touched" in present:
            sessions_with_touched += 1

        # Tangent: at least two calls within 10 assistant messages of the
        # previous call. This captures "the model learned it can dig" sessions.
        followups = 0
        for previous, current in zip(calls, calls[1:]):
            if current["seq"] - previous["seq"] <= 10:
                followups += 1
        if followups >= 2:
            tangent_sessions += 1
            tangent_followups += followups

        ps["sessions_with_recall"] += 1

        if not args.quiet and file_index % 200 == 0:
            print(f"  ... {file_index}/{len(files)} files", file=sys.stderr)

    if not args.quiet:
        print(f"  ... {len(files)}/{len(files)} files", file=sys.stderr)

    totals["sessions_with_compaction"] = sessions_with_compaction
    totals["sessions_with_om_compaction"] = sessions_with_om
    totals["sessions_with_recall"] = sessions_with_recall
    totals["sessions_with_hex_recall"] = sessions_with_hex
    totals["sessions_with_entry_recall"] = sessions_with_entry
    totals["sessions_with_drill_recall"] = sessions_with_drill
    totals["sessions_with_text_recall"] = sessions_with_text
    totals["sessions_with_expand_only"] = sessions_with_expand_only
    totals["sessions_with_touched"] = sessions_with_touched
    totals["sessions_with_rendered_ids"] = sessions_with_rendered
    totals["sessions_using_a_rendered_id"] = sessions_using_rendered
    totals["om_sessions_with_hex_recall"] = sessions_with_om_and_hex
    totals["om_sessions_with_any_recall_after"] = sessions_with_om_and_any_recall_after
    totals["om_sessions_with_no_recall_after"] = sessions_with_om_and_no_recall_after

    span_summary = {
        key: summarize_spans(values) for key, values in source_span_multi.items()
    }
    source_spans_summary = {
        "totals": dict(source_span_totals),
        "buckets": dict(source_span_buckets),
        "multi_span": span_summary,
    }

    calls_stats = {}
    if calls_per_session:
        ordered = sorted(calls_per_session)
        calls_stats = {
            "sessions": len(ordered),
            "min": min(ordered),
            "median": statistics.median(ordered),
            "mean": round(statistics.mean(ordered), 2),
            "max": max(ordered),
            "ge5": sum(1 for value in ordered if value >= 5),
            "ge10": sum(1 for value in ordered if value >= 10),
            "one_call": sum(1 for value in ordered if value == 1),
            "top5_calls": sum(sorted(ordered, reverse=True)[:5]),
            "total_calls": sum(ordered),
        }

    summary = {
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "sessions_root": args.sessions_root,
            "excludes": excludes,
            "limit": args.limit or None,
            "dump_calls": args.dump_calls,
        },
        "totals": dict(totals),
        "calls": calls_stats,
        "by_tool": dict(by_tool),
        "by_kind": dict(by_kind),
        "first_call_kind": dict(first_call_kind),
        "kind_sessions": dict(kind_sessions),
        "after_om": dict(after_om),
        "after_om_by_kind": dict(after_om_kind),
        "hex_result": dict(hex_result),
        "hex_kind": dict(hex_kind),
        "hex_visible": dict(hex_visible),
        "nonhex_result": dict(nonhex_result),
        "reference_shapes": dict(ref_shapes),
        "expand_lengths": dict(expand_lengths),
        "mode_values": dict(mode_values),
        "scope_values": dict(scope_values),
        "invalid_modes": dict(invalid_mode),
        "invalid_scopes": dict(invalid_scope),
        "tangents": {
            "sessions_with_two_followups_within_10_turns": tangent_sessions,
            "followup_calls_within_10_turns": tangent_followups,
        },
        "source_spans": source_spans_summary,
        "projects": {key: dict(value) for key, value in project_stats.items()},
        "examples": {
            "entry_plus_terms": examples_mixed,
            "hex_not_found": examples_hex_not_found,
        },
    }

    summary_path = os.path.join(args.out_dir, "summary.json")
    with open(summary_path, "w") as fh:
        json.dump(summary, fh, indent=2)

    if args.dump_calls:
        calls_path = os.path.join(args.out_dir, "calls.jsonl")
        with open(calls_path, "w") as fh:
            for row in calls_rows:
                fh.write(json.dumps(row) + "\n")

    lines: list[str] = []
    add = lines.append
    add("=" * 78)
    add("RECALL USAGE REPORT")
    add("=" * 78)
    add(f"sessions root: {args.sessions_root}")
    add(f"excludes: {', '.join(excludes) if excludes else '(none)'}")
    add(
        f"files: {totals['files_discovered']} discovered, {totals['files_included']} included, "
        f"{totals['files_excluded']} excluded, {totals['files_empty']} empty"
    )
    add("")
    add(
        f"sessions with compaction: {totals['sessions_with_compaction']}  "
        f"with OM compaction: {totals['sessions_with_om_compaction']}"
    )
    add(
        f"sessions with any recall: {sessions_with_recall} "
        f"({pct(sessions_with_recall, totals['files_included'])} of included; "
        f"{pct(sessions_with_recall, totals['sessions_with_compaction'])} of compacted)"
    )
    add(
        f"sessions with hex recall: {sessions_with_hex}  "
        f"with #N entry: {sessions_with_entry}  with drill: {sessions_with_drill}  "
        f"with text: {sessions_with_text}"
    )
    add("")
    add(
        f"recall calls: {totals['recall_calls']}  "
        + "  ".join(f"{key}={value}" for key, value in by_tool.most_common())
    )
    add("by query kind: " + "  ".join(f"{key}={value}" for key, value in by_kind.most_common()))
    add("first call kind: " + "  ".join(f"{key}={value}" for key, value in first_call_kind.most_common()))
    add("by timing: " + "  ".join(f"{key}={value}" for key, value in after_om.most_common()))
    add("")
    add("OM hex calls by record kind: " + "  ".join(f"{key}={value}" for key, value in hex_kind.most_common()))
    add(
        "OM hex calls visible in prior compaction: "
        + "  ".join(f"{key}={value}" for key, value in hex_visible.most_common())
    )
    add("OM hex call result: " + "  ".join(f"{key}={value}" for key, value in hex_result.most_common()))
    add("non-hex call result: " + "  ".join(f"{key}={value}" for key, value in nonhex_result.most_common()))
    add("")
    add(
        "reference shapes: "
        + "  ".join(f"{key}={value}" for key, value in ref_shapes.most_common())
    )
    add("invalid modes: " + ("  ".join(f"{key}={value}" for key, value in invalid_mode.most_common()) or "(none)"))
    add("invalid scopes: " + ("  ".join(f"{key}={value}" for key, value in invalid_scope.most_common()) or "(none)"))
    add("")
    add(
        f"assistant messages: {totals['assistant_messages']}  "
        f"after first OM compaction: {totals['assistant_messages_after_om']}"
    )
    if totals["assistant_messages_after_om"]:
        add(
            "recall calls per 1000 assistant messages after OM: "
            f"{1000 * after_om['after'] / totals['assistant_messages_after_om']:.2f}"
        )
    if totals["assistant_messages"]:
        add(
            "recall calls per 1000 assistant messages overall: "
            f"{1000 * totals['recall_calls'] / totals['assistant_messages']:.2f}"
        )
    add("")
    add(
        f"OM-compaction sessions with hex recall: {sessions_with_om_and_hex} / "
        f"{sessions_with_om} ({pct(sessions_with_om_and_hex, sessions_with_om)})"
    )
    add(
        f"OM-compaction sessions with any recall after OM: {sessions_with_om_and_any_recall_after} / "
        f"{sessions_with_om} ({pct(sessions_with_om_and_any_recall_after, sessions_with_om)})"
    )
    add("")
    add("Rendered vs queried OM ids (session scoped):")
    add(f"  rendered unique ids: {totals['rendered_unique_ids']}")
    add(f"  queried unique ids: {totals['queried_unique_ids']}")
    add(
        f"  queried ids that were rendered: {totals['queried_rendered_ids']} "
        f"({pct(totals['queried_rendered_ids'], totals['queried_unique_ids'])})"
    )
    add(f"  queried ids never rendered: {totals['queried_not_rendered_ids']}")
    add(f"  sessions with rendered ids: {sessions_with_rendered}")
    add(
        f"  ... that used at least one rendered id: {sessions_using_rendered} "
        f"({pct(sessions_using_rendered, sessions_with_rendered)})"
    )
    add("")
    if calls_stats:
        add("Calls per session with recall:")
        add(
            f"  min={calls_stats['min']} median={calls_stats['median']} "
            f"mean={calls_stats['mean']} max={calls_stats['max']}"
        )
        add(
            f"  one-call sessions={calls_stats['one_call']}  >=5={calls_stats['ge5']}  "
            f">=10={calls_stats['ge10']}  top5 sessions={calls_stats['top5_calls']}/"
            f"{calls_stats['total_calls']} calls"
        )
        add(
            f"  tangent sessions (>=2 follow-ups within 10 turns)={tangent_sessions}  "
            f"follow-up calls={tangent_followups}/{calls_stats['total_calls']}"
        )
        add("")
    add("Source spans in #N space:")
    for key in ("observations", "reflections"):
        total = source_span_totals[f"{key}_total"]
        no_mapped = source_span_totals[f"{key}_no_mapped"]
        single = source_span_totals[f"{key}_single"]
        multi = source_span_totals[f"{key}_multi"]
        multi_stats = span_summary[key]
        add(
            f"  {key}: total={total} no_mapped={no_mapped} single={single} "
            f"multi={multi} ({pct(multi, total)})"
        )
        if multi_stats.get("n"):
            add(
                f"    multi span: median={multi_stats['median']} p75={multi_stats['p75']} "
                f"p90={multi_stats['p90']} p99={multi_stats['p99']} max={multi_stats['max']}"
            )
        buckets = {
            bucket: source_span_buckets[f"{key}:{bucket}"]
            for bucket in ("1", "2", "3-5", "6-20", "21-100", ">100", "no_mapped")
        }
        add("    buckets: " + "  ".join(f"{bucket}={count}" for bucket, count in buckets.items()))
    add("")
    add("Top projects by recall calls:")
    for project, stats in sorted(
        project_stats.items(), key=lambda item: (-item[1]["recall_calls"], item[0])
    )[:15]:
        if stats["recall_calls"] == 0:
            continue
        add(
            f"  {stats['recall_calls']:5d} calls  hex={stats['kind:hex12']:4d}  "
            f"entry={stats['kind:entry']:4d}  text={stats['kind:text']:4d}  "
            f"om_sessions={stats['sessions_with_om_compaction']:3d}  {project}"
        )
    add("")
    if examples_mixed:
        add("Examples of #N + search terms in one query:")
        for example in examples_mixed:
            add(f"  {example['project']}: {example['query']!r}")
        add("")
    if examples_hex_not_found:
        add("Hex ids that did not resolve:")
        for example in examples_hex_not_found:
            add(f"  {example['project']}: {example['query']}")
        add("")

    report = "\n".join(lines) + "\n"
    report_path = os.path.join(args.out_dir, "report.txt")
    with open(report_path, "w") as fh:
        fh.write(report)
    print(report)
    print(f"wrote: {report_path}")
    print(f"wrote: {summary_path}")
    if args.dump_calls:
        print(f"wrote: {os.path.join(args.out_dir, 'calls.jsonl')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
