#!/usr/bin/env python3
"""
community_crate_map.py — Community-to-Crate Mapping for hive-flow v4 Porting

Propagates `rust_crate` annotations from annotated nodes to unannotated nodes
in a graphify-injected knowledge graph using two complementary strategies:

  Strategy 1 (Community Propagation):
    For each Louvain community with ≥3 annotated nodes at ≥80% crate purity,
    the dominant crate is assigned to all unannotated nodes in that community.

  Strategy 2 (Directory-to-Crate Mapping):
    Nodes with source_file paths are matched against a mapping from v3 source
    root directories to Rust crate names. This is safe because the v3 codebase
    directory structure mirrors the v4 crate structure.

Strategies are applied in cascade: Strategy 1 takes precedence; Strategy 2
is the fallback for nodes not covered by community propagation.

Input:  v3/@hive-flow/graphify-out/graph.json (or --input PATH)
Output: <outdir>/community_crate_mapping.jsonl  (or --output PATH)

Each output line is a JSON object:
    {"node_id": str, "rust_crate": str, "assignment_strategy": str,
     "assignment_confidence": "high"|"medium"}

Author: hive-flow Technical Editor
Date:   2026-05-05
License: MIT
"""

import json
import argparse
import sys
from collections import Counter, defaultdict
from pathlib import Path


# ---------------------------------------------------------------------------
# v3 Source Root Directory → v4 Rust Crate
#
# Each v3 module's top-level directory maps to exactly one v4 crate.
# CONFIDENCE levels:
#   high   — directory name is an unambiguous match for a single crate
#   medium — directory contains cross-cutting or shared artifacts; human review
#            recommended before finalizing
# ---------------------------------------------------------------------------
DIR_TO_CRATE: dict[str, tuple[str, str]] = {
    # High confidence — unambiguous 1:1 mappings
    'plugins':      ('hive-plugins',      'high'),
    'shared':       ('hive-shared',       'high'),
    'swarm':        ('hive-swarm',        'high'),
    'memory':       ('hive-memory',       'high'),
    'neural':       ('hive-neural',       'high'),
    'hooks':        ('hive-hooks',        'high'),
    'mcp':          ('hive-mcp',          'high'),
    'claims':       ('hive-claims',       'high'),
    'browser':      ('hive-appliance',    'high'),
    'embeddings':   ('hive-neural',       'high'),
    'security':     ('hive-guard',        'high'),
    'providers':    ('hive-services',     'high'),
    'transfer':     ('hive-transfer',     'high'),
    'cli':          ('hive-cli',          'high'),
    'aidefence':    ('hive-guard',        'high'),

    # Medium confidence — cross-cutting / shared / tentative
    'guidance':     ('hive-coordination', 'medium'),
    'integration':  ('hive-cli',          'medium'),
    'testing':      ('hive-cli',          'medium'),
    'performance':  ('hive-cli',          'medium'),
    'codex':        ('hive-cli',          'medium'),
    'v3':           ('hive-cli',          'medium'),
    'deployment':   ('hive-init',         'medium'),
    'rust-transliteration': ('hive-init', 'medium'),
    'context':      ('hive-shared',       'medium'),
}


def load_graph(path: Path) -> dict:
    """Load graph.json and return the parsed dict."""
    with open(path, 'r') as f:
        return json.load(f)


def build_community_index(nodes: list[dict]) -> dict[int, list[dict]]:
    """Group nodes by community ID."""
    index: dict[int, list[dict]] = defaultdict(list)
    for n in nodes:
        comm = n.get('community')
        if comm is not None:
            index[comm].append(n)
    return index


def find_dominant_crates(
    community_index: dict[int, list[dict]],
    min_assigned: int = 3,
    min_purity: float = 0.8,
) -> dict[int, str]:
    """
    For each community with ≥ `min_assigned` annotated nodes and ≥ `min_purity`
    dominant-crate purity, return the dominant crate name.

    Purity = (dominant crate count) / (total annotated nodes in community).
    """
    dominant: dict[int, str] = {}
    for cid, nlist in community_index.items():
        crate_counts = Counter()
        assigned = 0
        for n in nlist:
            rc = n.get('rust_crate')
            if rc and rc != '?':
                crate_counts[rc] += 1
                assigned += 1

        if assigned >= min_assigned:
            top = crate_counts.most_common(1)
            if top:
                purity = top[0][1] / assigned
                if purity >= min_purity:
                    dominant[cid] = top[0][0]
    return dominant


def apply_strategies(
    nodes: list[dict],
    community_dominant: dict[int, str],
    dir_map: dict[str, tuple[str, str]],
) -> tuple[list[dict], list[str]]:
    """
    Apply strategies 1 (community) then 2 (directory) to assign crates.
    Returns (assignments, unassigned_node_ids).
    """
    assignments: list[dict] = []
    unassigned: list[str] = []
    strategy_counts = Counter()
    crate_counts = Counter()

    for n in nodes:
        nid = n['id']
        rc = n.get('rust_crate')

        # Skip already-annotated nodes
        if rc and rc != '?':
            continue

        assigned = False

        # Strategy 1: Community propagation
        comm = n.get('community')
        if comm is not None and comm in community_dominant:
            crate = community_dominant[comm]
            assignments.append({
                'node_id': nid,
                'rust_crate': crate,
                'assignment_strategy': 'community',
                'assignment_confidence': 'high',
            })
            strategy_counts['community'] += 1
            crate_counts[crate] += 1
            assigned = True

        # Strategy 2: Directory-to-crate
        if not assigned:
            sf = n.get('source_file', '')
            root = sf.replace('\\', '/').split('/')[0]
            if root in dir_map:
                crate, confidence = dir_map[root]
                assignments.append({
                    'node_id': nid,
                    'rust_crate': crate,
                    'assignment_strategy': 'directory',
                    'assignment_confidence': confidence,
                })
                strategy_counts['directory'] += 1
                crate_counts[crate] += 1
                assigned = True

        if not assigned:
            unassigned.append(nid)

    return assignments, unassigned, strategy_counts, crate_counts


def report(
    assignments: list[dict],
    unassigned: list[str],
    strategy_counts: Counter,
    annotated_counts: Counter,
    mapped_crate_counts: Counter,
    total_nodes: int,
):
    """Print a human-readable summary to stdout."""
    sep = "=" * 70
    print(sep)
    print("COMMUNITY-TO-CRATE MAPPING: COMPLETE RESULTS")
    print(sep)

    total_annotated = sum(annotated_counts.values())
    total_unassigned = total_nodes - total_annotated
    total_mapped = len(assignments)

    print(f"\nAlready annotated: {total_annotated:,} nodes ({total_annotated/total_nodes*100:.1f}%)")
    print(f"Unassigned:        {total_unassigned:,} nodes ({total_unassigned/total_nodes*100:.1f}%)")
    print(f"  └─ Mapped:       {total_mapped:,} nodes ({total_mapped/total_unassigned*100:.1f}%)" if total_unassigned else "")
    print(f"  └─ Unmapped:     {len(unassigned):,} nodes ({len(unassigned)/total_unassigned*100:.1f}%)" if total_unassigned else "")

    print(f"\n--- Strategy Breakdown ---")
    for s, cnt in strategy_counts.most_common():
        pct = cnt / total_mapped * 100 if total_mapped else 0
        print(f"  {s}: {cnt:,} nodes ({pct:.1f}%)")

    print(f"\n--- Confidence Distribution ---")
    conf_dist = Counter(a['assignment_confidence'] for a in assignments)
    for conf, cnt in conf_dist.most_common():
        pct = cnt / total_mapped * 100 if total_mapped else 0
        print(f"  {conf}: {cnt:,} nodes ({pct:.1f}%)")

    print(f"\n--- Final Crate Assignments ---")
    print(f"{'Crate':<28} {'Annotated':>10} {'Mapped':>10} {'Total':>10}")
    print("-" * 60)
    all_crates = sorted(set(list(annotated_counts.keys()) + list(mapped_crate_counts.keys())))
    for crate in all_crates:
        a = annotated_counts.get(crate, 0)
        m = mapped_crate_counts.get(crate, 0)
        print(f"{crate:<28} {a:>10,} {m:>10,} {a + m:>10,}")
    print("-" * 60)
    print(f"{'TOTAL':<28} {sum(annotated_counts.values()):>10,} {sum(mapped_crate_counts.values()):>10,} {sum(annotated_counts.values()) + sum(mapped_crate_counts.values()):>10,}")


def export_assignments(assignments: list[dict], path: Path):
    """Write assignments as JSONL."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'w') as f:
        for entry in assignments:
            f.write(json.dumps(entry) + '\n')
    print(f"\nMapping exported to: {path} ({len(assignments):,} entries)")


def main():
    parser = argparse.ArgumentParser(
        description="Community-to-crate mapping for hive-flow v4 porting",
    )
    parser.add_argument(
        '--input', '-i',
        default='v3/@hive-flow/graphify-out/graph.json',
        help='Path to graph.json (default: v3/@hive-flow/graphify-out/graph.json)',
    )
    parser.add_argument(
        '--output', '-o',
        default='v4-plans/community_crate_mapping.jsonl',
        help='Output path for JSONL assignments (default: v4-plans/community_crate_mapping.jsonl)',
    )
    parser.add_argument(
        '--min-assigned',
        type=int,
        default=3,
        help='Minimum annotated nodes per community for propagation (default: 3)',
    )
    parser.add_argument(
        '--min-purity',
        type=float,
        default=0.8,
        help='Minimum dominant-crate purity for propagation (default: 0.8)',
    )
    parser.add_argument(
        '--quiet', '-q',
        action='store_true',
        help='Suppress report output',
    )
    args = parser.parse_args()

    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: input file not found: {input_path}", file=sys.stderr)
        sys.exit(1)

    # Load
    g = load_graph(input_path)
    nodes = g.get('nodes', g if isinstance(g, list) else [])
    if not nodes:
        print("Error: no nodes found in graph", file=sys.stderr)
        sys.exit(1)

    # Count pre-existing annotations
    annotated_counts = Counter()
    for n in nodes:
        rc = n.get('rust_crate')
        if rc and rc != '?':
            annotated_counts[rc] += 1

    # Strategy 1: Community propagation
    comm_index = build_community_index(nodes)
    community_dominant = find_dominant_crates(
        comm_index,
        min_assigned=args.min_assigned,
        min_purity=args.min_purity,
    )

    # Apply both strategies
    assignments, unassigned, strategy_counts, mapped_crate_counts = apply_strategies(
        nodes, community_dominant, DIR_TO_CRATE,
    )

    # Report
    if not args.quiet:
        report(
            assignments, unassigned, strategy_counts,
            annotated_counts, mapped_crate_counts,
            total_nodes=len(nodes),
        )

    # Export
    export_assignments(assignments, Path(args.output))

    # Unmapped detail (always print if any remain)
    if unassigned:
        print(f"\nWARNING: {len(unassigned)} nodes could not be mapped:")
        for nid in unassigned:
            n = next(n for n in nodes if n['id'] == nid)
            print(f"  id={nid}  label={n.get('label','?')[:80]}  source_file={n.get('source_file','?')}")

    return 0 if not unassigned else 1


if __name__ == '__main__':
    sys.exit(main())
