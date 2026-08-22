---
name: oss-ai-catalog
context: fork
triggers:
  - "오픈소스 AI"
  - "OSS 추천"
  - "어떤 LLM"
  - "어떤 모델"
  - "vector DB"
  - "RAG framework"
  - "inference engine"
  - "LangChain"
  - "vLLM"
  - "open source AI"
description: |
  Curated open-source AI catalog reference. Auto-activates when llm-architect, content-marketer, data-analyst, mcp-developer, backend-developer, or any agent needs to RECOMMEND an open-source AI tool, model, framework, inference engine, vector DB, or agent/RAG library to the user. Provides category-indexed lookup across 14 domains (Deep learning frameworks, Foundation models, Inference engines, Agentic AI, RAG/Vector DBs, Generative media, Training/Fine-tuning, MLOps, Evaluation, Safety, Specialized domains, UIs, Dev tools, Learning resources).

  MUST trigger when user says any of:
  - "어떤 LLM 써", "어떤 모델 써", "오픈소스 AI 추천", "OSS 추천"
  - "vector DB 뭐가 좋아", "RAG framework", "inference engine 추천"
  - "음성 모델 / TTS / STT 추천", "이미지 생성 모델 추천", "영상 생성 모델"
  - "LangChain 말고 다른 거", "vLLM 같은 거"
  - any "what tool should I use for X" question in an AI/ML context

  DO NOT hardcode recommendations in agent prompts; consult this skill so recommendations stay fresh.
lang: [en, ko]
whenNotToUse: "Proprietary or commercial-only tool recommendations; do not apply when the user explicitly needs a managed SaaS product and open-source constraints do not apply."
platforms: [claude-code, gemini-cli, codex-cli, cursor]
level: 2
category: library
tokens: 2500
agents: [llm-architect, backend-developer, data-analyst]
auto-invoke: true
user-invocable: false
source_hash: 27c775bf
---

# oss-ai-catalog — Curated OSS AI Tool Index

Source: curated from `alvinreal/awesome-opensource-ai` (battle-tested, production-proven tier) as of 2026-04-15. Artibot agents consult this skill instead of hallucinating recommendations.

## Lookup Categories

| # | Category | Typical user request | Where to look |
|---|---|---|---|
| 1 | Deep Learning Frameworks | "training framework" | PyTorch, JAX, TensorFlow, Candle (Rust) |
| 2 | Foundation Models (LLM) | "base chat model" | Llama 3, Qwen, Mistral, DeepSeek, Gemma |
| 3 | Coding & Reasoning Models | "code model" | DeepSeek-Coder, Qwen-Coder, CodeLlama |
| 4 | Multimodal (Vision+Lang) | "vision model" | LLaVA, Qwen-VL, InternVL |
| 5 | Speech & Audio | "TTS / STT / music" | Whisper, Coqui-TTS, Bark, RVC, MusicGen |
| 6 | Video & Animation | "video gen" | AnimateDiff, Stable Video Diffusion, Open-Sora |
| 7 | Local / On-device Inference | "run local" | Ollama, llama.cpp, MLX, LM Studio (not OSS but built on OSS) |
| 8 | High-perf Serving | "serving" | vLLM, SGLang, TGI, LMDeploy |
| 9 | Quantization / Distillation | "compress model" | GPTQ, AWQ, bitsandbytes, GGUF |
| 10 | Single-Agent Frameworks | "agent framework" | LangChain, LlamaIndex, Haystack |
| 11 | Multi-Agent Orchestration | "multi-agent" | AutoGen, CrewAI, Swarm |
| 12 | Autonomous Coding Agents | "coding agent" | Aider, SWE-agent, OpenDevin |
| 13 | Vector DBs / Search | "vector store" | Milvus, Qdrant, Weaviate, LanceDB, pgvector |
| 14 | Embedding Models | "embeddings" | bge, e5, nomic-embed, jina-embeddings |
| 15 | RAG Frameworks | "RAG" | LlamaIndex, Haystack, RAGFlow, R2R |
| 16 | Knowledge Graphs | "KG RAG" | GraphRAG, LightRAG, Neo4j |
| 17 | Web Data Ingestion | "scraper / crawler" | Firecrawl, Crawl4AI, Scrapy |
| 18 | Image Generation | "image gen" | SDXL, Flux, Stable Diffusion ecosystem |
| 19 | Training / Fine-tune | "fine-tune" | Unsloth, Axolotl, TRL, DeepSpeed |
| 20 | MLOps / LLMOps | "monitoring" | MLflow, Weights & Biases (not OSS but common), Langfuse, Phoenix |
| 21 | Evaluation & Benchmarks | "eval" | lm-evaluation-harness, Promptfoo, DeepEval |
| 22 | Safety / Alignment | "safety" | Llama Guard, NeMo Guardrails |
| 23 | UI / Self-hosted Platforms | "chat UI" | Open WebUI, LibreChat, AnythingLLM |
| 24 | Dev Tools & Integrations | "dev tool" | LiteLLM, Instructor, Outlines |

## How agents should use this

1. Detect user's tool-recommendation intent
2. Map to a category row above
3. Cite 2–4 options with a **1-sentence trade-off each** (never a flat list)
4. Recommend the **simplest option that satisfies the user's scale**
5. If the user's constraint is unclear, ask **one** clarifying question (scale? latency budget? deployment target?) then recommend

## What NOT to do

- Don't paste this whole file to the user — summarize the relevant 2–4 options
- Don't recommend proprietary services when user asks for "open source"
- Don't hallucinate versions or benchmark numbers — if unsure, say "check the upstream repo"
- Don't replace this catalog with inline recommendations in other skills; always defer here

## Refresh

Source repo updates continuously. Artibot should re-scan `awesome-opensource-ai/README.md` + `EMERGING.md` when `/repo` is run against that URL with `--focus innovation`.
