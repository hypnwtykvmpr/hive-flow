# Using Claude Code with OpenAI Open Models (GPT-OSS) and Qwen3-Coder

Below is a practical, step-by-step tutorial that shows you how to aim Claude Code at any OpenAI "open-models" release (gpt-oss-20b / gpt-oss-120b) or Qwen3-Coder by self-hosting on **Hugging Face Inference Endpoints** or by routing through **OpenRouter**. It demonstrates the minimal environment-variable technique (URL + key) as well as an optional LiteLLM proxy for larger fleets. Follow the path that best fits your infrastructure.

---

## 1. Prerequisites

* **Claude Code ≥ 0.5.3** with gateway support (you can check with `claude --version`). ([LiteLLM][1])
* A Hugging Face account with a **read/write token** (Settings → Access Tokens). ([Hugging Face][2])
* For OpenRouter, an **OpenRouter API key**. ([OpenRouter][3])

---

## 2. Path A – Self-host GPT-OSS or Qwen on Hugging Face

### 2.1 Grab the model

1. Open the GPT-OSS repo (`openai/gpt-oss-20b` or `openai/gpt-oss-120b`) on Hugging Face and accept the Apache-2.0 license. ([Hugging Face][4], [OpenAI][5])
2. For Qwen choose `Qwen/Qwen3-Coder-480B-A35B-Instruct` (or a smaller GGUF spin-off if you lack GPUs). ([Hugging Face][6])

### 2.2 Deploy a Text Generation Inference endpoint

1. Click **Deploy → Inference Endpoint** on the model page.
2. Select the **Text Generation Inference (TGI)** template ≥ v1.4.0. TGI now ships an **OpenAI-compatible Messages API**—tick *"Enable OpenAI compatibility"* or add `--enable-openai` in advanced settings. ([Hugging Face][7])
3. Choose hardware (A10 G, A100, or CPU for 20 B) and create the endpoint. ([Hugging Face][2])

### 2.3 Collect the credentials

After the endpoint is "Running", copy:

* **ENDPOINT_URL** (ends in `/v1`).
* **HF_API_TOKEN** (your user or org token). ([Hugging Face][2])

### 2.4 Point Claude Code at the endpoint

Set environment variables in the shell that launches Claude Code:

```bash
export ANTHROPIC_BASE_URL="https://<your-endpoint>.us-east-1.aws.endpoints.huggingface.cloud"
export ANTHROPIC_AUTH_TOKEN="hf_xxxxxxxxxxxxxxxxx"
export ANTHROPIC_MODEL="gpt-oss-20b"        # or gpt-oss-120b / Qwen model id
```

Claude Code now believes it is talking to Anthropic yet routes to your open model because TGI mirrors the OpenAI schema. Test:

```bash
claude --model gpt-oss-20b
```

Streaming works—TGI returns token streams under `/v1/chat/completions` just like the real OpenAI API. ([Hugging Face][8])

### 2.5 Cost and scaling notes

* HF Inference Endpoints auto-scales, so watch credit burn. ([Hugging Face][2])
* If you need local control, run TGI in Docker with `docker run --name tgi -p 8080:80 ... --enable-openai`. ([Hugging Face][9], [GitHub][10])

---

## 3. Path B – Proxy through OpenRouter

OpenRouter exposes hundreds of models (including the new GPT-OSS and Qwen3-Coder slugs) behind one **OpenAI-compatible** endpoint.

### 3.1 Register and pick a model

* Sign up at openrouter.ai, copy your key. ([OpenRouter][3])
* Model slugs:
  * `openai/gpt-oss-20b` or `openai/gpt-oss-120b` (OpenAI open models). ([OpenRouter][11])
  * `qwen/qwen3-coder-480b` (Qwen coder). ([OpenRouter][12])

### 3.2 Configure Claude Code

```bash
export ANTHROPIC_BASE_URL="https://openrouter.ai/api/v1"
export ANTHROPIC_AUTH_TOKEN="or_xxxxxxxxx"
export ANTHROPIC_MODEL="openai/gpt-oss-20b"
```

Run:

```bash
claude --model openai/gpt-oss-20b
```

OpenRouter handles billing and fallback; Claude Code stays unchanged. ([OpenRouter][3])

---

## 4. Path C – Optional LiteLLM Proxy for Mixed Fleets

If you want Claude Code to hot-swap between Anthropic, GPT-OSS, Qwen, and Azure models, drop LiteLLM in front:

```yaml
model_list:
  - model_name: gpt-oss-20b
    litellm_params:
      model: openai/gpt-oss-20b           # via OpenRouter or local TGI
      api_key: os.environ/OPENROUTER_KEY
  - model_name: qwen3-coder
    litellm_params:
      model: openrouter/qwen/qwen3-coder
      api_key: os.environ/OPENROUTER_KEY
```

Start the proxy and then:

```bash
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_AUTH_TOKEN="litellm_master"
claude --model gpt-oss-20b
```

LiteLLM keeps a cost log and supports simple-shuffle routing—avoid the latency routing mode when you still call Anthropic models. ([LiteLLM][13])

---

## 5. Troubleshooting Checklist

| Symptom                       | Fix                                                                                 |
| ----------------------------- | ----------------------------------------------------------------------------------- |
| 404 on `/v1/chat/completions` | Ensure `--enable-openai` flag is active in TGI. ([Hugging Face][7])               |
| Empty responses               | Verify the `ANTHROPIC_MODEL` matches the slug you mapped. ([LiteLLM][1])           |
| 400 error after model swap    | Switch LiteLLM router to `simple-shuffle` not latency-based. ([LiteLLM][13])       |
| Slow first token              | Warm up the endpoint with a small prompt after scaling to zero. ([Hugging Face][14])|

---

## 6. Key Takeaways

* Claude Code needs only **ANTHROPIC_BASE_URL** and **AUTH_TOKEN** to talk to any OpenAI-compatible backend.
* Hugging Face TGI 1.4+ exposes that schema, letting you host GPT-OSS or Qwen in your own cloud with minimal glue.
* OpenRouter is the fastest route if you want zero DevOps.
* LiteLLM sits in front when you want policy-based routing across many vendors.

With these methods, you can mix and match open-source and proprietary models inside the same CLI workflow, keeping costs low while preserving the familiar Claude Code developer experience.

---

## Integration with Claude Flow

Claude Flow can enhance this setup with its swarm orchestration capabilities:

### Using Claude Flow with Open Models

1. **Initialize Claude Flow MCP**:
```bash
claude mcp add claude-flow npx claude-flow@alpha mcp start
```

2. **Configure for Open Models**:
```bash
# Set your chosen model backend
export ANTHROPIC_BASE_URL="https://openrouter.ai/api/v1"
export ANTHROPIC_AUTH_TOKEN="your_key"
export ANTHROPIC_MODEL="openai/gpt-oss-20b"

# Enable Claude Flow features
export CLAUDE_FLOW_HOOKS_ENABLED="true"
export CLAUDE_FLOW_TELEMETRY_ENABLED="true"
```

3. **Leverage Swarm Coordination**:
```bash
# Initialize a swarm for complex tasks
npx claude-flow@alpha swarm init --topology mesh --max-agents 5

# Use SPARC methodology with open models
npx claude-flow@alpha sparc run architect "Design authentication system"
```

### Benefits of Claude Flow + Open Models

- **Cost Optimization**: Route simple tasks to smaller models, complex ones to larger
- **Performance Tracking**: Monitor token usage across different models
- **Swarm Coordination**: Distribute work across multiple model instances
- **Memory Persistence**: Maintain context across sessions regardless of model

---

## References

[1]: https://docs.litellm.ai/docs/tutorials/claude_responses_api "Claude Code - LiteLLM"
[2]: https://huggingface.co/docs/inference-endpoints/index "Inference Endpoints - Hugging Face"
[3]: https://openrouter.ai/docs/quickstart "OpenRouter Quickstart Guide | Developer Documentation"
[4]: https://huggingface.co/openai/gpt-oss-20b "openai/gpt-oss-20b - Hugging Face"
[5]: https://openai.com/index/introducing-gpt-oss/ "Introducing gpt-oss | OpenAI"
[6]: https://huggingface.co/Qwen/Qwen3-Coder-480B-A35B-Instruct "Qwen/Qwen3-Coder-480B-A35B-Instruct - Hugging Face"
[7]: https://huggingface.co/docs/text-generation-inference/messages_api "Messages API - Hugging Face"
[8]: https://huggingface.co/docs/text-generation-inference/conceptual/streaming "Streaming - Hugging Face"
[9]: https://huggingface.co/docs/text-generation-inference/index "Text Generation Inference - Hugging Face"
[10]: https://github.com/huggingface/text-generation-inference "Large Language Model Text Generation Inference - GitHub"
[11]: https://openrouter.ai/openai "OpenAI - OpenRouter"
[12]: https://openrouter.ai/models "Models - OpenRouter"
[13]: https://docs.litellm.ai/docs/providers/anthropic "Anthropic - LiteLLM"
[14]: https://huggingface.co/blog/inference-endpoints-llm "Deploy LLMs with Hugging Face Inference Endpoints"
[15]: https://www.businessinsider.com/openai-gpt-oss-open-weight-llm-ai-model-2025-8 "Sam Altman launches GPT-oss, OpenAI's first open-weight AI language model in over 5 years"
[16]: https://huggingface.co/openai "OpenAI - Hugging Face"
[17]: https://www.wired.com/story/openai-just-released-its-first-open-weight-models-since-gpt-2 "OpenAI Just Released Its First Open-Weight Models Since GPT-2"

---

*Last updated: January 2025 | Part of Claude Flow v2.0.0-alpha.87 documentation*