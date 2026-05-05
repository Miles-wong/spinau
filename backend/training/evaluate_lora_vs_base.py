#!/usr/bin/env python3
"""
Compare field-level accuracy: base Gemma vs base + LoRA on held-out tickets.

Uses the same 80/20 shuffle (seed=42) as train_lora.TicketDataset so the
default split matches training (eval on validation portion only).
"""

from __future__ import annotations

import argparse
import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List

# training/ as cwd when run as `python evaluate_lora_vs_base.py`
_TRAINING_DIR = Path(__file__).resolve().parent
if str(_TRAINING_DIR) not in sys.path:
    sys.path.insert(0, str(_TRAINING_DIR))

from inference import LoRAExtractionModel  # noqa: E402

TRAINING_DATA_FILE = Path(__file__).resolve().parent / "data" / "training_data.jsonl"


def build_output_json(ticket: dict) -> str:
    """Same labels as train_lora.TicketDataset / build_output_json (stdlib only)."""
    output = {
        "issue_type": ticket["issue_type"],
        "category": ticket["category"],
        "severity": ticket["severity"],
    }
    if ticket.get("noticed_time"):
        output["noticed_time"] = ticket["noticed_time"]
    if ticket.get("location_detail"):
        output["location_detail"] = ticket["location_detail"]
    if ticket.get("response_taken"):
        output["response_taken"] = ticket["response_taken"]
        if ticket.get("response_details"):
            output["response_details"] = ticket["response_details"]
    if ticket.get("impact_scope"):
        output["impact_scope"] = ticket["impact_scope"]
    if ticket.get("work_continuity"):
        output["work_continuity"] = ticket["work_continuity"]
    if "data_involved_flag" in ticket:
        output["data_involved_flag"] = ticket["data_involved_flag"]
    if ticket.get("external_party_involved") is not None:
        output["external_party_involved"] = ticket["external_party_involved"]
    if ticket.get("affected_asset"):
        output["affected_asset"] = ticket["affected_asset"]
    return json.dumps(output, ensure_ascii=False, sort_keys=True)


@dataclass
class SplitResult:
    n: int
    json_ok: int
    issue_type_acc: float
    category_acc: float
    severity_acc: float
    core_all_acc: float  # issue_type + category + severity all correct
    field_micro_acc: float  # mean over (sample, field) for fields present in gold


def _normalize(val: Any) -> Any:
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return val
    if isinstance(val, str):
        s = val.strip().lower()
        if s in ("true", "1", "yes"):
            return True
        if s in ("false", "0", "no"):
            return False
        return s
    return val


def _gold_dict(ticket: Dict[str, Any]) -> Dict[str, Any]:
    return json.loads(build_output_json(ticket))


def _values_match(gold_val: Any, pred_val: Any) -> bool:
    g = _normalize(gold_val)
    p = _normalize(pred_val)
    if g is None and p in (None, "", False):
        return True
    if g is None or p is None:
        return False
    if isinstance(g, bool) or isinstance(p, bool):
        return bool(g) is bool(p)
    return g == p


def _evaluate_predictions(
    tickets: List[Dict[str, Any]],
    predictions: List[Dict[str, Any]],
) -> SplitResult:
    n = len(tickets)
    json_ok = 0
    issue_ok = category_ok = severity_ok = 0
    core_all = 0
    field_hits = 0
    field_total = 0

    for ticket, pred in zip(tickets, predictions):
        if "parse_error" not in pred:
            json_ok += 1

        gold = _gold_dict(ticket)
        if _values_match(gold.get("issue_type"), pred.get("issue_type")):
            issue_ok += 1
        if _values_match(gold.get("category"), pred.get("category")):
            category_ok += 1
        if _values_match(gold.get("severity"), pred.get("severity")):
            severity_ok += 1

        if (
            _values_match(gold.get("issue_type"), pred.get("issue_type"))
            and _values_match(gold.get("category"), pred.get("category"))
            and _values_match(gold.get("severity"), pred.get("severity"))
        ):
            core_all += 1

        for k, gv in gold.items():
            field_total += 1
            if k in pred and _values_match(gv, pred[k]):
                field_hits += 1

    def rate(x: int) -> float:
        return x / n if n else 0.0

    return SplitResult(
        n=n,
        json_ok=json_ok,
        issue_type_acc=rate(issue_ok),
        category_acc=rate(category_ok),
        severity_acc=rate(severity_ok),
        core_all_acc=rate(core_all),
        field_micro_acc=field_hits / field_total if field_total else 0.0,
    )


def _load_jsonl(path: Path) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _eval_rows_for_split(rows: List[Dict[str, Any]], split: str, seed: int = 42) -> List[Dict[str, Any]]:
    """Match train_lora.TicketDataset: shuffle(seed), then 80%% train / 20%% val."""
    if split == "all":
        return list(rows)
    shuffled = list(rows)
    random.seed(seed)
    random.shuffle(shuffled)
    cut = int(len(shuffled) * 0.8)
    if split == "train":
        return shuffled[:cut]
    if split == "val":
        return shuffled[cut:]
    raise ValueError(split)


def run_eval(
    data_file: Path,
    split: str,
    max_samples: int | None,
    base_model: str,
    lora_path: str | None,
    use_4bit: bool,
    use_issue_type_hint: bool,
) -> None:
    if not data_file.exists():
        print(f"Missing data file: {data_file}")
        print("Run: python generate_training_data.py")
        sys.exit(1)

    all_rows = _load_jsonl(data_file)
    eval_rows = _eval_rows_for_split(all_rows, split=split, seed=42)

    if max_samples is not None:
        eval_rows = eval_rows[: max_samples]

    print(f"Samples: {len(eval_rows)}  split={split}  data={data_file}\n")

    def predict_rows(model: LoRAExtractionModel) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        for i, t in enumerate(eval_rows, 1):
            hint = t.get("issue_type") if use_issue_type_hint else None
            pred = model.extract_fields(t["description"], hint)
            out.append(pred)
            if i % 5 == 0 or i == len(eval_rows):
                print(f"  generated {i}/{len(eval_rows)}", flush=True)
        return out

    print("=== Base model (no LoRA) ===\n")
    base_model_obj = LoRAExtractionModel(
        base_model=base_model,
        lora_adapter_path=lora_path,
        use_4bit=use_4bit,
        load_lora=False,
    )
    base_preds = predict_rows(base_model_obj)
    del base_model_obj

    import gc

    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass

    print("\n=== Base + LoRA ===\n")
    lora_model_obj = LoRAExtractionModel(
        base_model=base_model,
        lora_adapter_path=lora_path,
        use_4bit=use_4bit,
        load_lora=True,
    )
    lora_preds = predict_rows(lora_model_obj)

    base_metrics = _evaluate_predictions(eval_rows, base_preds)
    lora_metrics = _evaluate_predictions(eval_rows, lora_preds)

    def fmt(m: SplitResult) -> str:
        return (
            f"  n={m.n}\n"
            f"  JSON parse success (no parse_error): {m.json_ok}/{m.n} ({100 * m.json_ok / m.n:.1f}%)\n"
            f"  issue_type accuracy:  {100 * m.issue_type_acc:.1f}%\n"
            f"  category accuracy:    {100 * m.category_acc:.1f}%\n"
            f"  severity accuracy:    {100 * m.severity_acc:.1f}%\n"
            f"  core triple (all 3):  {100 * m.core_all_acc:.1f}%\n"
            f"  field micro-average:    {100 * m.field_micro_acc:.1f}% (all keys in gold JSON)\n"
        )

    print("\n" + "=" * 60)
    print("RESULTS")
    print("=" * 60)
    print("\n[Base only]\n" + fmt(base_metrics))
    print("[+ LoRA]\n" + fmt(lora_metrics))
    print("--- Deltas (LoRA - Base), percentage points ---\n")
    print(f"  issue_type:  {100 * (lora_metrics.issue_type_acc - base_metrics.issue_type_acc):+.1f}")
    print(f"  category:    {100 * (lora_metrics.category_acc - base_metrics.category_acc):+.1f}")
    print(f"  severity:    {100 * (lora_metrics.severity_acc - base_metrics.severity_acc):+.1f}")
    print(f"  core triple: {100 * (lora_metrics.core_all_acc - base_metrics.core_all_acc):+.1f}")
    print(f"  field micro: {100 * (lora_metrics.field_micro_acc - base_metrics.field_micro_acc):+.1f}")


def main() -> None:
    p = argparse.ArgumentParser(description="Compare base vs LoRA extraction accuracy.")
    p.add_argument("--data", type=Path, default=TRAINING_DATA_FILE, help="JSONL tickets (default: training data)")
    p.add_argument(
        "--split",
        choices=("val", "train", "all"),
        default="val",
        help="val=last 20%% (held-out, matches Trainer); train=first 80%%; all=full file",
    )
    p.add_argument("--max-samples", type=int, default=None, help="Cap number of evaluated rows")
    p.add_argument("--base-model", type=str, default="google/gemma-3-4b-it")
    p.add_argument("--lora-path", type=str, default=None, help="Adapter dir or checkpoint (default: inference default)")
    p.add_argument("--no-4bit", action="store_true", help="Disable 4-bit loading (more VRAM)")
    p.add_argument(
        "--issue-type-hint",
        action="store_true",
        help="Pass gold issue_type to the model (not used during training; optional oracle hint)",
    )
    args = p.parse_args()

    run_eval(
        data_file=args.data,
        split=args.split,
        max_samples=args.max_samples,
        base_model=args.base_model,
        lora_path=args.lora_path,
        use_4bit=not args.no_4bit,
        use_issue_type_hint=args.issue_type_hint,
    )


if __name__ == "__main__":
    main()
