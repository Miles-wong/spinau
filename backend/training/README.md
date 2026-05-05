# LoRA Fine-tuning for Ticket Field Extraction

完整的 Transformers + PEFT + LoRA 微调系统，用于增强 Gemma 模型的工单字段提取能力。

## 快速开始

### 1️⃣ 环境配置

```bash
# 进入 training 目录
cd "d:\React\Blazor\Reporting System\backend\training"

# 创建虚拟环境（可选）
python -m venv venv
venv\Scripts\activate

# 安装依赖
pip install -r requirements.txt
```

### 2️⃣ 生成训练数据

```bash
python generate_training_data.py
```

**输出:**
- 200 条多样化的训练工单
- 保存至 `data/training_data.jsonl`
- 自动分为 80% 训练 / 20% 验证

**数据特点：**
- ✅ 100 条 Cyber + 100 条 IT Support
- ✅ 明确的和模糊的描述混合
- ✅ 覆盖所有字段和类别
- ✅ 多样化的时间、地点、行为表达

### 3️⃣ 微调模型

```bash
python train_lora.py
```

**训练配置：**
- 模型：Gemma 2B（轻量级）
- 方法：LoRA (Low-Rank Adaptation)
- r = 8（低秩维度）
- 学习率：3e-4
- 最大步骤：500
- 批大小：4

**训练过程：**
1. 加载 Gemma 2B 模型
2. 配置 LoRA 适配器
3. 在 160 个样本上训练
4. 在 40 个样本上验证
5. 保存最佳模型至 `models/gemma-lora/`

**预期耗时：**
- NVIDIA GPU：15-30 分钟
- CPU：30-60 分钟

### 4️⃣ 测试推理

```bash
python inference.py
```

**输出：**
```
Description: Got a suspicious email from payroll asking for password verification. Looks like phishing.
Extracted: {
  "category": "phishing",
  "severity": "high",
  ...
}
```

## 文件结构

```
training/
├── generate_training_data.py    # 生成 200 条训练数据
├── train_lora.py               # LoRA 微调脚本
├── inference.py                # 推理和集成接口
├── requirements.txt            # 依赖列表
├── data/
│   └── training_data.jsonl     # 生成的训练数据（80/20 split）
└── models/
    └── gemma-lora/             # 微调后的模型和适配器权重
        ├── adapter_config.json
        ├── adapter_model.bin
        ├── config.json
        ├── tokenizer.json
        └── ...
```

## 集成到现有系统

### Option A: 替换现有提取器

在 `backend_app/ai/extraction.py` 中：

```python
from training.inference import LoRAExtractionModel

# 初始化（一次）
lora_model = LoRAExtractionModel()

# 在提取流程中使用
extracted_fields = lora_model.extract_fields(description, issue_type)
```

### Option B: 混合使用

结合现有的 prompt-based 提取和 LoRA 模型：

```python
# 使用 LoRA 获得快速初步提取
lora_result = lora_model.extract_fields(description)

# 用现有的高质量 prompt 验证关键字段
if not lora_result.get('category'):
    lora_result['category'] = classify_with_prompt(description)
```

## 性能指标

### 微调前 vs 微调后（预期）

| 指标 | 原始 Gemma | 微调后 |
|------|-----------|--------|
| Category 准确率 | 70-75% | 80-85% |
| Severity 推断 | 65-70% | 75-80% |
| 字段完整度 | 60% | 75-80% |
| 推理速度 | ~500ms | ~300ms |

## 调试和优化

### 问题 1：GPU 内存不足

**解决：** 在 `train_lora.py` 中减小 BATCH_SIZE：
```python
BATCH_SIZE = 2  # 从 4 改为 2
```

### 问题 2：训练收敛慢

**解决：** 增加学习率或调整 MAX_STEPS：
```python
LEARNING_RATE = 5e-4  # 提高学习率
MAX_STEPS = 1000      # 增加训练步数
```

### 问题 3：过拟合

**解决：** 增加 dropout 或减少 LoRA rank：
```python
LORA_DROPOUT = 0.1    # 从 0.05 改为 0.1
LORA_R = 4            # 从 8 改为 4
```

## 高级用法

### 自定义训练数据

修改 `generate_training_data.py` 中的：
- `CYBER_DESCRIPTIONS`：添加更多网络安全例子
- `IT_DESCRIPTIONS`：添加更多 IT 支持例子
- `TIMES`, `LOCATIONS`：添加更多多样化表达

### 使用不同的基础模型

在 `train_lora.py` 和 `inference.py` 中修改：
```python
MODEL_ID = "google/gemma-7b"      # 使用 7B 版本
MODEL_ID = "mistral-ai/Mistral-7B"  # 切换到 Mistral
```

### 批量提取

```python
from training.inference import batch_extract

descriptions = [...]  # 一堆工单描述
results = batch_extract(descriptions, issue_type="cyber")
```

## 下一步

1. ✅ 生成 200 条训练数据
2. ✅ 微调 Gemma 模型（~30 分钟）
3. ✅ 评估模型性能
4. ⏳ 集成到 API（可选）
5. ⏳ A/B 测试现有系统
6. ⏳ 监控生产环境中的性能

## 参考资源

- [Transformers 文档](https://huggingface.co/docs/transformers/)
- [PEFT + LoRA 指南](https://huggingface.co/docs/peft/index)
- [Gemma 模型卡](https://huggingface.co/google/gemma-2b)
- [LoRA 论文](https://arxiv.org/abs/2106.09714)

## 许可

与项目一致
