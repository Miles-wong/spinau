#!/usr/bin/env python3
"""Inference wrapper for LoRA-finetuned extraction model."""

import json
import re
from pathlib import Path
from typing import Dict, Any

import torch
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    BitsAndBytesConfig,
    StoppingCriteria,
    StoppingCriteriaList,
)
from transformers.utils import is_accelerate_available
from peft import PeftModel


def _use_device_map_auto() -> bool:
    """Match Transformers checks so we never pass device_map='auto' without a working Accelerate backend."""
    return bool(is_accelerate_available())


class _StopOnTokenSequence(StoppingCriteria):
    """Stop generation once a token sequence appears *after* the prompt boundary.
    
    The threshold prevents triggering on double-newlines that appear at the end
    of the prompt itself — we only activate once a minimum number of new tokens
    have been generated.
    """

    MIN_NEW_TOKENS = 8  # Don't trigger until at least this many tokens are generated

    def __init__(self, stop_ids, prompt_len: int = 0):
        self.stop_ids = stop_ids
        self.prompt_len = prompt_len

    def __call__(self, input_ids, scores, **kwargs):
        if not self.stop_ids:
            return False
        seq = input_ids[0].tolist()
        new_len = len(seq) - self.prompt_len
        if new_len < self.MIN_NEW_TOKENS:
            return False
        if len(seq) < len(self.stop_ids):
            return False
        return seq[-len(self.stop_ids):] == self.stop_ids


class LoRAExtractionModel:
    """Wrapper for LoRA-finetuned Gemma model for ticket field extraction."""
    
    INSTRUCTION_TEMPLATE = (
        "Extract the structured fields from this incident report.\n"
        "Respond ONLY with valid JSON.\n"
        "Do not include any extra text.\n"
        "Do not explain.\n\n"
        "Incident: {description}"
    )

    def __init__(
        self,
        base_model: str = "google/gemma-3-4b-it",
        lora_adapter_path: str = None,
        use_4bit: bool = True,
        load_lora: bool = True,
    ):
        """
        Initialize the model.
        
        Args:
            base_model: Base model ID (default: google/gemma-3-4b)
            lora_adapter_path: Path to LoRA adapter weights
            use_4bit: Use 4-bit quantization for 6GB VRAM (default: True)
            load_lora: If False, use base weights only (for A/B eval vs adapter).
        """
        self.base_model_id = base_model
        default_model_dir = Path(__file__).parent / "models" / "gemma3-4b-lora"
        checkpoint_100 = default_model_dir / "checkpoint-100"
        self.lora_adapter_path = lora_adapter_path or str(checkpoint_100 if checkpoint_100.exists() else default_model_dir)
        
        print(f"Loading base model: {base_model}")
        use_map = _use_device_map_auto()
        if not use_map:
            print("Note: Accelerate unavailable — loading on a single device (pip install accelerate for device_map='auto').")

        want_4bit = use_4bit and torch.cuda.is_available()
        if want_4bit and not use_map:
            print("4-bit load needs `accelerate`; falling back to bf16 on GPU.")
            want_4bit = False

        common = {"attn_implementation": "eager"}
        if want_4bit:
            bnb_config = BitsAndBytesConfig(
                load_in_4bit=True,
                bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16,
                bnb_4bit_use_double_quant=True,
            )
            self.model = AutoModelForCausalLM.from_pretrained(
                base_model,
                quantization_config=bnb_config,
                device_map="auto" if use_map else None,
                **common,
            )
            if not use_map:
                self.model = self.model.cuda()
        else:
            dt = torch.bfloat16 if torch.cuda.is_available() else torch.float32
            kw = dict(torch_dtype=dt, **common)
            if use_map:
                kw["device_map"] = "auto"
            self.model = AutoModelForCausalLM.from_pretrained(base_model, **kw)
            if not use_map:
                dev = torch.device("cuda" if torch.cuda.is_available() else "cpu")
                self.model = self.model.to(dev)
        
        self.tokenizer = AutoTokenizer.from_pretrained(base_model, use_fast=False)
        if self.tokenizer.pad_token is None:
            self.tokenizer.pad_token = self.tokenizer.eos_token

        stop_ids = self.tokenizer("\n\n", add_special_tokens=False)["input_ids"]
        # Pass a lambda factory so prompt_len is bound fresh each call
        self._stop_ids = stop_ids

    def _make_stop_criteria(self, prompt_len: int) -> StoppingCriteriaList:
        return StoppingCriteriaList([_StopOnTokenSequence(self._stop_ids, prompt_len=prompt_len)])
        
        # Load LoRA adapter if requested and available
        if load_lora and Path(self.lora_adapter_path).exists():
            print(f"Loading LoRA adapter: {self.lora_adapter_path}")
            self.model = PeftModel.from_pretrained(self.model, self.lora_adapter_path)
        elif load_lora:
            print(f"⚠️  LoRA adapter not found at {self.lora_adapter_path}")
            print("Using base model only. Train first with: python train_lora.py")
        else:
            print("LoRA disabled: evaluating base model only.")
        
        self.model.eval()
    
    def extract_fields(self, description: str, issue_type: str = None) -> Dict[str, Any]:
        """
        Extract ticket fields from description.
        
        Args:
            description: The ticket description text
            issue_type: Optional pre-specified issue type (cyber or it_support)
        
        Returns:
            Dictionary with extracted fields
        """
        # Build prompt with the same format used during training.
        prompt = self.INSTRUCTION_TEMPLATE.format(description=description)
        if issue_type:
            prompt += f"\nIssue Type Hint: {issue_type}"
        
        # Tokenize
        inputs = self.tokenizer(
            prompt,
            return_tensors="pt",
            truncation=True,
            max_length=512,
        ).to(self.model.device)
        
        # Generate
        with torch.no_grad():
            outputs = self.model.generate(
                **inputs,
                max_new_tokens=256,
                num_beams=1,
                do_sample=False,
                temperature=0.1,
                stopping_criteria=self._make_stop_criteria(inputs["input_ids"].shape[1]),
            )

        # Decode only the generated continuation (exclude prompt tokens)
        prompt_len = inputs["input_ids"].shape[1]
        generated_ids = outputs[0][prompt_len:]
        response = self.tokenizer.decode(generated_ids, skip_special_tokens=True)

        response_text = response.strip()

        # Fast path: model returned plain JSON only
        try:
            parsed = json.loads(response_text)
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

        # Extract the broadest JSON object candidate from mixed output
        start = response_text.find("{")
        end = response_text.rfind("}")
        if start == -1 or end == -1 or end <= start:
            return self._fallback_extraction(response_text, "No JSON object found")

        json_text = response_text[start : end + 1]
        try:
            return json.loads(json_text)
        except json.JSONDecodeError as e:
            return self._fallback_extraction(json_text, f"Invalid JSON: {str(e)}")

    def _fallback_extraction(self, text: str, parse_error: str) -> Dict[str, Any]:
        """Best-effort fallback used when strict JSON parsing fails."""
        recovered: Dict[str, Any] = {}

        # 1) JSON-like fragments inside invalid output
        field_patterns = {
            "issue_type": r'"issue_type"\s*:\s*"([^"]+)"',
            "category": r'"category"\s*:\s*"([^"]+)"',
            "severity": r'"severity"\s*:\s*"([^"]+)"',
        }
        for field, pattern in field_patterns.items():
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                recovered[field] = match.group(1).strip()

        bool_patterns = {
            "response_taken": r'"response_taken"\s*:\s*(true|false)',
            "external_party_involved": r'"external_party_involved"\s*:\s*(true|false)',
            "data_involved_flag": r'"data_involved_flag"\s*:\s*(true|false)',
        }
        for field, pattern in bool_patterns.items():
            match = re.search(pattern, text, flags=re.IGNORECASE)
            if match:
                recovered[field] = match.group(1).lower() == "true"

        # 2) Key: Value fallback for non-JSON outputs
        if not recovered.get("issue_type"):
            issue_match = re.search(r"(?:^|\n)\s*issue\s*type\s*:\s*([^\n]+)", text, flags=re.IGNORECASE)
            if issue_match:
                issue_value = issue_match.group(1).strip().lower().replace("-", "_").replace(" ", "_")
                if issue_value in {"cyber", "it_support"}:
                    recovered["issue_type"] = issue_value

        if not recovered.get("category"):
            category_match = re.search(r"(?:^|\n)\s*category\s*:\s*([^\n]+)", text, flags=re.IGNORECASE)
            if category_match:
                category_value = category_match.group(1).strip().lower().replace("-", "_").replace(" ", "_")
                category_aliases = {
                    "security": "suspicious_activity",
                    "network": "network_issue",
                    "software": "software_issue",
                    "hardware": "hardware_issue",
                    "phishing_email": "phishing",
                }
                recovered["category"] = category_aliases.get(category_value, category_value)

        if not recovered.get("severity"):
            severity_match = re.search(r"(?:^|\n)\s*severity\s*:\s*([^\n]+)", text, flags=re.IGNORECASE)
            if severity_match:
                severity_value = severity_match.group(1).strip().lower()
                for level in ("critical", "high", "medium", "low"):
                    if level in severity_value:
                        recovered["severity"] = level
                        break

        if recovered:
            recovered["parse_warning"] = parse_error
            recovered["raw_output"] = text
            return recovered

        return {"raw_output": text, "parse_error": parse_error}


def batch_extract(descriptions: list, issue_type: str = None) -> list:
    """
    Extract fields from multiple descriptions.
    
    Args:
        descriptions: List of ticket descriptions
        issue_type: Optional pre-specified issue type
    
    Returns:
        List of extracted field dictionaries
    """
    model = LoRAExtractionModel()
    results = []
    
    for i, desc in enumerate(descriptions, 1):
        print(f"Extracting {i}/{len(descriptions)}...")
        extracted = model.extract_fields(desc, issue_type)
        results.append(extracted)
    
    return results


if __name__ == "__main__":
    # Example usage
    test_descriptions = [
        "Got a suspicious email from payroll asking for password verification. Looks like phishing.",
        "My WiFi keeps disconnecting every few minutes.",
        "Someone logged into my account from Tokyo.",
    ]
    
    print("=== LoRA Extraction Model Demo ===\n")
    
    model = LoRAExtractionModel()
    
    for desc in test_descriptions:
        print(f"Description: {desc}")
        extracted = model.extract_fields(desc)
        print(f"Extracted: {json.dumps(extracted, indent=2)}")
        print()
