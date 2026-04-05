#!/usr/bin/env python3
"""
Deterministic daily log deduplication via Jaccard similarity.

Reads today's daily log + last N days from the given directory.
Compares entries pairwise. When similarity >= 0.6, keeps the
newer/more-specific entry and removes the older one.

Usage: python3 dedup-memory.py <daily-dir> [--days 3]
Output: JSON to stdout with dedup results.
"""

import json
import re
import sys
from datetime import date, timedelta
from pathlib import Path

STOPWORDS = frozenset({
    "the", "a", "an", "is", "was", "to", "for", "in", "on", "at",
    "of", "and", "or", "utc", "with", "that", "this", "from", "by",
})

ENTRY_PATTERN = re.compile(r'^- \d{2}:\d{2} UTC')
# Strip timestamp and optional [source] tag before tokenizing
CONTENT_PATTERN = re.compile(r'^- \d{2}:\d{2} UTC\s*(?:\[[^\]]*\]\s*)?(?:—\s*)?')


def extract_content(line):
    """Strip timestamp prefix and optional [source] tag, return content only."""
    return CONTENT_PATTERN.sub('', line)


def tokenize(text):
    """Tokenize on content only (timestamp/source already stripped)."""
    tokens = re.split(r'[^a-z0-9]+', text.lower())
    return frozenset(t for t in tokens if t and t not in STOPWORDS)


def jaccard(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def parse_file(filepath):
    """Returns (entries, structure) where entries is list of (line_idx, text, tokens)
    and structure is the full list of lines with None for entry lines."""
    lines = Path(filepath).read_text().splitlines()
    entries = []
    structure = []
    for i, line in enumerate(lines):
        if ENTRY_PATTERN.match(line):
            content = extract_content(line)
            tokens = tokenize(content)
            entries.append((i, line, tokens))
            structure.append(None)  # placeholder for entry
        else:
            structure.append(line)
    return entries, structure


def rewrite_file(filepath, entries_to_keep, structure):
    """Reconstruct file preserving non-entry lines, keeping only specified entries."""
    kept_by_idx = {e[0]: e[1] for e in entries_to_keep}
    result = []
    for i, line in enumerate(structure):
        if line is None:
            if i in kept_by_idx:
                result.append(kept_by_idx[i])
        else:
            result.append(line)

    while result and not result[-1].strip():
        result.pop()

    if not any(ENTRY_PATTERN.match(l) for l in result):
        Path(filepath).unlink()
        return

    Path(filepath).write_text('\n'.join(result) + '\n')


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: dedup-memory.py <daily-dir> [--days N]"}))
        sys.exit(1)

    daily_dir = Path(sys.argv[1])
    days = 3
    if '--days' in sys.argv:
        idx = sys.argv.index('--days')
        if idx + 1 >= len(sys.argv):
            print(json.dumps({"error": "Missing value for --days"}))
            sys.exit(1)
        try:
            days = int(sys.argv[idx + 1])
        except ValueError:
            print(json.dumps({"error": f"Invalid --days value: {sys.argv[idx + 1]!r}"}))
            sys.exit(1)

    if not daily_dir.exists():
        print(json.dumps({
            "files_processed": [], "duplicates_removed": [],
            "entries_before": 0, "entries_after": 0
        }))
        sys.exit(0)

    # Find daily files in date range (newest first)
    today = date.today()
    target_dates = [(today - timedelta(days=d)).isoformat() for d in range(days)]
    daily_files = [daily_dir / f"{d}.md" for d in target_dates if (daily_dir / f"{d}.md").exists()]

    if not daily_files:
        print(json.dumps({
            "files_processed": [], "duplicates_removed": [],
            "entries_before": 0, "entries_after": 0
        }))
        sys.exit(0)

    # Parse all files
    all_entries = {}
    total_before = 0
    for f in daily_files:
        entries, structure = parse_file(f)
        all_entries[str(f)] = (entries, structure)
        total_before += len(entries)

    # Find duplicates: newer files vs older files
    to_remove = {}
    duplicates_log = []

    file_list = list(all_entries.keys())
    for i, newer_file in enumerate(file_list):
        newer_entries = all_entries[newer_file][0]
        for j in range(i + 1, len(file_list)):
            older_file = file_list[j]
            older_entries = all_entries[older_file][0]
            for _, n_text, n_tokens in newer_entries:
                for o_idx, o_text, o_tokens in older_entries:
                    sim = jaccard(n_tokens, o_tokens)
                    if sim >= 0.6:
                        # Tie-breaker: if older entry has more tokens (more specific), keep it instead
                        if len(o_tokens) > len(n_tokens):
                            # Older is more specific — but we still prefer newer for freshness
                            # Only override if significantly more specific (50%+ more tokens)
                            if len(o_tokens) > len(n_tokens) * 1.5:
                                continue  # keep older, don't mark for removal
                        to_remove.setdefault(older_file, set()).add(o_idx)
                        duplicates_log.append({
                            "kept": {"file": Path(newer_file).name, "line": n_text},
                            "dropped": {"file": Path(older_file).name, "line": o_text},
                            "similarity": round(sim, 2)
                        })

    # Within-file dedup (later entry wins)
    for filepath, (entries, _) in all_entries.items():
        for i in range(len(entries)):
            for j in range(i + 1, len(entries)):
                sim = jaccard(entries[i][2], entries[j][2])
                if sim >= 0.6:
                    to_remove.setdefault(filepath, set()).add(entries[i][0])
                    duplicates_log.append({
                        "kept": {"file": Path(filepath).name, "line": entries[j][1]},
                        "dropped": {"file": Path(filepath).name, "line": entries[i][1]},
                        "similarity": round(sim, 2)
                    })

    # Rewrite modified files
    for filepath, (entries, structure) in all_entries.items():
        remove_set = to_remove.get(filepath, set())
        kept = [(idx, text, tokens) for idx, text, tokens in entries if idx not in remove_set]
        rewrite_file(filepath, kept, structure)

    # Recount from disk
    total_after = 0
    for f in daily_files:
        if f.exists():
            total_after += sum(1 for line in f.read_text().splitlines() if ENTRY_PATTERN.match(line))

    print(json.dumps({
        "files_processed": [f.name for f in daily_files],
        "duplicates_removed": duplicates_log,
        "entries_before": total_before,
        "entries_after": total_after
    }))


if __name__ == '__main__':
    main()
