#!/usr/bin/env python3
"""LoRA Fine-tuning for Ticket Field Extraction with Gemma."""

import json
import os
from pathlib import Path
from typing import Dict, List
import random

import torch
from torch.utils.data import Dataset, DataLoader
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    TrainingArguments,
    Trainer,
    BitsAndBytesConfig,
    EarlyStoppingCallback,
)
from peft import LoraConfig, get_peft_model, TaskType, prepare_model_for_kbit_training

# Configuration
MODEL_ID = "google/gemma-3-4b-it"  # Instruction-tuned — better base for extraction tasks
OUTPUT_DIR = Path(__file__).parent / "models" / "gemma3-4b-lora"
DATA_DIR = Path(__file__).parent / "data"
TRAINING_DATA_FILE = DATA_DIR / "training_data.jsonl"

# QLoRA: 4-bit quantization for 6GB VRAM (RTX 4050)
USE_4BIT = True

# LoRA hyperparameters
LORA_R = 8
LORA_ALPHA = 16
LORA_DROPOUT = 0.1
LORA_TARGET_MODULES = ["q_proj", "v_proj", "k_proj", "o_proj"]

# Training hyperparameters — tuned for 6GB VRAM
BATCH_SIZE = 1                    # Keep small for 6GB
GRADIENT_ACCUMULATION_STEPS = 8  # Effective batch = 8
LEARNING_RATE = 2e-4
MAX_STEPS = 140
WARMUP_STEPS = 50
EVAL_STEPS = 20
SAVE_STEPS = 20
MAX_SEQ_LENGTH = 256              # Reduced from 512 to save VRAM


def build_output_json(ticket: dict) -> str:
    """Build the expected JSON output for a ticket."""
    output = {"issue_type": ticket["issue_type"], "category": ticket["category"], "severity": ticket["severity"]}
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
    # Cyber-specific fields
    if "data_involved_flag" in ticket:
        output["data_involved_flag"] = ticket["data_involved_flag"]
    if ticket.get("external_party_involved") is not None:
        output["external_party_involved"] = ticket["external_party_involved"]
    # IT-specific fields
    if ticket.get("affected_asset"):
        output["affected_asset"] = ticket["affected_asset"]
    return json.dumps(output, ensure_ascii=False, sort_keys=True)


class TicketDataset(Dataset):
    """
    Instruction-tuning dataset for ticket field extraction.

    Each sample is formatted as:
        [INSTRUCTION] Extract fields from this incident report:
        {description}
        [/INSTRUCTION]
        {json_output}

    Loss is computed only on the output (JSON) tokens — the instruction
    prompt tokens are masked with -100.
    """

    INSTRUCTION_TEMPLATE = (
        "Extract the structured fields from this incident report.\n"
        "Respond ONLY with valid JSON.\n"
        "Do not include any extra text.\n"
        "Do not explain.\n\n"
        "Incident: {description}"
    )

    def __init__(self, data_file: str, tokenizer, max_length: int = 256, split: str = "train"):
        self.tokenizer = tokenizer
        self.max_length = max_length

        all_data = []
        with open(data_file, 'r', encoding='utf-8') as f:
            for line in f:
                if line.strip():
                    all_data.append(json.loads(line))

        random.seed(42)
        random.shuffle(all_data)
        split_idx = int(len(all_data) * 0.8)
        self.data = all_data[:split_idx] if split == "train" else all_data[split_idx:]
        print(f"Loaded {len(self.data)} {split} samples")

    def __len__(self):
        return len(self.data)

    def __getitem__(self, idx):
        ticket = self.data[idx]

        instruction = self.INSTRUCTION_TEMPLATE.format(description=ticket["description"])
        output_json = build_output_json(ticket)

        # Full sequence: instruction + output
        # Use chat-style separation so model learns the boundary clearly
        full_text = f"{instruction}\n\n{output_json}"

        # Tokenize full sequence
        full_enc = self.tokenizer(
            full_text,
            max_length=self.max_length,
            truncation=True,
            padding="max_length",
            return_tensors="pt",
        )

        # Tokenize only the instruction to find where output starts
        prompt_enc = self.tokenizer(
            f"{instruction}\n\n",
            truncation=True,
            return_tensors="pt",
        )
        prompt_len = prompt_enc["input_ids"].shape[1]

        input_ids = full_enc["input_ids"].squeeze()
        attention_mask = full_enc["attention_mask"].squeeze()

        # Labels: -100 for prompt tokens (no loss), real token ids for output
        labels = input_ids.clone()
        labels[:prompt_len] = -100                          # mask prompt
        labels[attention_mask == 0] = -100                  # mask padding

        return {
            "input_ids": input_ids,
            "attention_mask": attention_mask,
            "labels": labels,
        }


def setup_lora_model(model_id: str):
    """Load model and configure QLoRA (4-bit quantization for 6GB VRAM)."""
    print(f"Loading model: {model_id}")
    print(f"Mode: {'QLoRA 4-bit' if USE_4BIT else 'LoRA bfloat16'}")
    
    # Gemma tokenizer may fail with the fast Rust backend on some cached files.
    # Use the slow tokenizer for stability.
    tokenizer = AutoTokenizer.from_pretrained(model_id, use_fast=False)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token
    
    if USE_4BIT and torch.cuda.is_available():
        # QLoRA: quantize to 4-bit to fit 6GB VRAM.
        # Keep a small GPU budget and offload remaining modules to CPU in fp32.
        offload_bnb_config = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_use_double_quant=True,
            llm_int8_enable_fp32_cpu_offload=True,
        )
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            quantization_config=offload_bnb_config,
            device_map="auto",
            max_memory={0: "5GiB", "cpu": "48GiB"},
            low_cpu_mem_usage=True,
            offload_folder="offload",
            attn_implementation="eager",
        )
        # Prepare for k-bit training (adds gradient hooks, casts norms to float32)
        model = prepare_model_for_kbit_training(model)
    else:
        model = AutoModelForCausalLM.from_pretrained(
            model_id,
            torch_dtype=torch.bfloat16 if torch.cuda.is_available() else torch.float32,
            device_map="auto",
            attn_implementation="eager",
        )
    
    # Configure LoRA
    lora_config = LoraConfig(
        r=LORA_R,
        lora_alpha=LORA_ALPHA,
        target_modules=LORA_TARGET_MODULES,
        lora_dropout=LORA_DROPOUT,
        bias="none",
        task_type=TaskType.CAUSAL_LM,
        use_rslora=True,
    )
    
    # Apply LoRA
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()
    
    return model, tokenizer


def train_lora(model, tokenizer, output_dir: str):
    """Train LoRA adapter."""
    
    # Create datasets
    train_dataset = TicketDataset(
        str(TRAINING_DATA_FILE),
        tokenizer,
        max_length=MAX_SEQ_LENGTH,
        split="train"
    )
    
    val_dataset = TicketDataset(
        str(TRAINING_DATA_FILE),
        tokenizer,
        max_length=MAX_SEQ_LENGTH,
        split="val"
    )
    
    # Training arguments — optimized for 6GB VRAM (RTX 4050)
    training_args = TrainingArguments(
        output_dir=output_dir,
        per_device_train_batch_size=BATCH_SIZE,
        per_device_eval_batch_size=BATCH_SIZE,
        gradient_accumulation_steps=GRADIENT_ACCUMULATION_STEPS,
        gradient_checkpointing=True,      # Trade compute for memory savings
        learning_rate=LEARNING_RATE,
        max_steps=MAX_STEPS,
        warmup_steps=WARMUP_STEPS,
        eval_strategy="steps",
        eval_steps=EVAL_STEPS,
        save_strategy="steps",
        save_steps=SAVE_STEPS,
        logging_steps=10,
        save_total_limit=2,
        load_best_model_at_end=True,
        metric_for_best_model="eval_loss",
        greater_is_better=False,
        weight_decay=0.05,
        bf16=torch.cuda.is_available(),
        optim="paged_adamw_8bit",         # 8-bit optimizer saves ~1GB VRAM
        remove_unused_columns=False,
        dataloader_pin_memory=False,      # Avoid extra memory allocation
    )
    
    # Trainer
    trainer = Trainer(
        model=model,
        args=training_args,
        train_dataset=train_dataset,
        eval_dataset=val_dataset,
        callbacks=[EarlyStoppingCallback(early_stopping_patience=2)],
        # Labels are already set in dataset with -100 masking on prompt tokens
        # Default collator handles padding correctly
    )
    
    # Train
    print("Starting training...")
    trainer.train()
    
    # Save model
    model.save_pretrained(output_dir)
    tokenizer.save_pretrained(output_dir)
    
    print(f"\n✅ Training complete! Model saved to {output_dir}")
    
    return model, tokenizer


def main():
    # Ensure output directory exists
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    # Check for training data
    if not TRAINING_DATA_FILE.exists():
        print(f"❌ Training data not found: {TRAINING_DATA_FILE}")
        print("Run: python generate_training_data.py")
        return
    
    # Setup model with LoRA
    model, tokenizer = setup_lora_model(MODEL_ID)
    
    # Train
    train_lora(model, tokenizer, str(OUTPUT_DIR))


if __name__ == "__main__":
    main()
