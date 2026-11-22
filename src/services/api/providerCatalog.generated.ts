// 自动生成，勿手改。来源：models.dev api.json（MIT）。
// 生成命令：node scripts/gen-provider-catalog.mjs
// 这是「供应商品牌清单」：只存端点与 Key 名，模型元数据由 modelMeta.ts 运行时提供。
// 注意：协议(openai/anthropic)由端点 URL 启发式推断，端点可用性未逐家验证；
// 多数品牌只是「碰巧 OpenAI 兼容才可用」，Azure/Bedrock/Vertex/Ollama 等会 404。
// 完整能力（附件/搜索/语音/标题）仅 DeepSeek 支持。

export type CatalogProvider = {
  id: string
  name: string
  /** 对话接口 baseURL（不含 /chat/completions） */
  baseURL: string
  /** 模型清单地址 */
  modelsURL: string
  /** 需要的 API Key 环境变量名（用于提示用户） */
  env: string[]
  /** 该供应商在 models.dev 的模型数量（排序/展示用） */
  modelCount: number
  protocol: 'openai' | 'anthropic'
  /** 无需用户填 Key（如 OpenCode 免费网关，服务端注入伪装头） */
  noKey?: boolean
  /** 服务端代理注入的请求头（$session 为会话占位符） */
  injectHeaders?: Record<string, string>
}

export const PROVIDER_CATALOG: CatalogProvider[] = [
  {
    "id": "opencode-free",
    "name": "OpenCode Free",
    "baseURL": "https://opencode.ai/zen/v1",
    "modelsURL": "https://opencode.ai/zen/v1/models",
    "env": [],
    "modelCount": 105,
    "protocol": "openai",
    "noKey": true,
    "injectHeaders": {
      "Authorization": "Bearer public",
      "User-Agent": "opencode/stable/1.2.3/opencode",
      "x-opencode-session": "$session",
      "x-opencode-session-id": "$session",
      "x-session-affinity": "$session",
      "X-Session-Id": "$session",
      "x-opencode-project": "global",
      "x-opencode-client": "opencode"
    }
  },
  {
    "id": "google",
    "name": "Google",
    "baseURL": "https://generativelanguage.googleapis.com/v1beta/openai",
    "modelsURL": "https://generativelanguage.googleapis.com/v1beta/openai/models",
    "env": [
      "GOOGLE_API_KEY"
    ],
    "modelCount": 39,
    "protocol": "openai"
  },
  {
    "id": "anthropic",
    "name": "Anthropic",
    "baseURL": "https://api.anthropic.com/v1",
    "modelsURL": "https://api.anthropic.com/v1/models",
    "env": [
      "ANTHROPIC_API_KEY"
    ],
    "modelCount": 18,
    "protocol": "anthropic"
  },
  {
    "id": "openai",
    "name": "OpenAI",
    "baseURL": "https://api.openai.com/v1",
    "modelsURL": "https://api.openai.com/v1/models",
    "env": [
      "OPENAI_API_KEY"
    ],
    "modelCount": 53,
    "protocol": "openai"
  },
  {
    "id": "alibaba",
    "name": "Alibaba",
    "baseURL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "modelsURL": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
    "env": [
      "DASHSCOPE_API_KEY"
    ],
    "modelCount": 53,
    "protocol": "openai"
  },
  {
    "id": "lmstudio",
    "name": "LMStudio",
    "baseURL": "http://127.0.0.1:1234/v1",
    "modelsURL": "http://127.0.0.1:1234/v1/models",
    "env": [
      "LMSTUDIO_API_KEY"
    ],
    "modelCount": 3,
    "protocol": "openai"
  },
  {
    "id": "nvidia",
    "name": "Nvidia",
    "baseURL": "https://integrate.api.nvidia.com/v1",
    "modelsURL": "https://integrate.api.nvidia.com/v1/models",
    "env": [
      "NVIDIA_API_KEY"
    ],
    "modelCount": 52,
    "protocol": "openai"
  },
  {
    "id": "siliconflow",
    "name": "SiliconFlow",
    "baseURL": "https://api.siliconflow.com/v1",
    "modelsURL": "https://api.siliconflow.com/v1/models",
    "env": [
      "SILICONFLOW_API_KEY"
    ],
    "modelCount": 57,
    "protocol": "openai"
  },
  {
    "id": "openrouter",
    "name": "OpenRouter",
    "baseURL": "https://openrouter.ai/api/v1",
    "modelsURL": "https://openrouter.ai/api/v1/models",
    "env": [
      "OPENROUTER_API_KEY"
    ],
    "modelCount": 379,
    "protocol": "openai"
  },
  {
    "id": "zai",
    "name": "Z.AI",
    "baseURL": "https://api.z.ai/api/paas/v4",
    "modelsURL": "https://api.z.ai/api/paas/v4/models",
    "env": [
      "ZHIPU_API_KEY"
    ],
    "modelCount": 18,
    "protocol": "openai"
  },
  {
    "id": "scaleway",
    "name": "Scaleway",
    "baseURL": "https://api.scaleway.ai/v1",
    "modelsURL": "https://api.scaleway.ai/v1/models",
    "env": [
      "SCALEWAY_API_KEY"
    ],
    "modelCount": 17,
    "protocol": "openai"
  },
  {
    "id": "minimax-cn",
    "name": "MiniMax (minimax.cn)",
    "baseURL": "https://api.minimax.cn/anthropic/v1",
    "modelsURL": "https://api.minimax.cn/anthropic/v1/models",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "modelCount": 8,
    "protocol": "anthropic"
  },
  {
    "id": "agnes",
    "name": "Agnes AI",
    "baseURL": "https://apihub.agnes-ai.com/v1",
    "modelsURL": "https://apihub.agnes-ai.com/v1/models",
    "env": [
      "AGNES_API_KEY"
    ],
    "modelCount": 4,
    "protocol": "openai"
  },
  {
    "id": "volcengine",
    "name": "Volcengine Ark",
    "baseURL": "https://ark.cn-beijing.volces.com/api/v3",
    "modelsURL": "https://ark.cn-beijing.volces.com/api/v3/models",
    "env": [
      "ARK_API_KEY"
    ],
    "modelCount": 16,
    "protocol": "openai"
  },
  {
    "id": "deepseek",
    "name": "DeepSeek",
    "baseURL": "https://api.deepseek.com",
    "modelsURL": "https://api.deepseek.com/models",
    "env": [
      "DEEPSEEK_API_KEY"
    ],
    "modelCount": 4,
    "protocol": "openai"
  },
  {
    "id": "opencode",
    "name": "OpenCode",
    "baseURL": "https://opencode.ai/inference/openai/v1",
    "modelsURL": "https://opencode.ai/inference/openai/v1/models",
    "env": [
      "OPENCODE_API_KEY"
    ],
    "modelCount": 144,
    "protocol": "openai"
  },
  {
    "id": "moonshotai",
    "name": "Moonshot AI",
    "baseURL": "https://api.moonshot.ai/v1",
    "modelsURL": "https://api.moonshot.ai/v1/models",
    "env": [
      "MOONSHOT_API_KEY"
    ],
    "modelCount": 6,
    "protocol": "openai"
  },
  {
    "id": "github-copilot",
    "name": "GitHub Copilot",
    "baseURL": "https://api.githubcopilot.com",
    "modelsURL": "https://api.githubcopilot.com/models",
    "env": [
      "GITHUB_TOKEN"
    ],
    "modelCount": 44,
    "protocol": "openai"
  },
  {
    "id": "minimax",
    "name": "MiniMax (minimax.io)",
    "baseURL": "https://api.minimax.io/anthropic/v1",
    "modelsURL": "https://api.minimax.io/anthropic/v1/models",
    "env": [
      "MINIMAX_API_KEY"
    ],
    "modelCount": 8,
    "protocol": "anthropic"
  },
  {
    "id": "nano-gpt",
    "name": "NanoGPT",
    "baseURL": "https://nano-gpt.com/api/v1",
    "modelsURL": "https://nano-gpt.com/api/v1/models",
    "env": [
      "NANO_GPT_API_KEY"
    ],
    "modelCount": 613,
    "protocol": "openai"
  },
  {
    "id": "llmgateway-providers",
    "name": "LLM Gateway",
    "baseURL": "https://api.llmgateway.io/v1",
    "modelsURL": "https://api.llmgateway.io/v1/models",
    "env": [
      "LLMGATEWAY_API_KEY"
    ],
    "modelCount": 507,
    "protocol": "openai"
  },
  {
    "id": "kilo",
    "name": "Kilo Gateway",
    "baseURL": "https://api.kilo.ai/api/gateway",
    "modelsURL": "https://api.kilo.ai/api/gateway/models",
    "env": [
      "KILO_API_KEY"
    ],
    "modelCount": 465,
    "protocol": "openai"
  },
  {
    "id": "edenai",
    "name": "Eden AI",
    "baseURL": "https://api.edenai.run/v3",
    "modelsURL": "https://api.edenai.run/v3/models",
    "env": [
      "EDENAI_API_KEY"
    ],
    "modelCount": 388,
    "protocol": "openai"
  },
  {
    "id": "llmgateway",
    "name": "DevPass (LLM Gateway)",
    "baseURL": "https://api.llmgateway.io/v1",
    "modelsURL": "https://api.llmgateway.io/v1/models",
    "env": [
      "LLMGATEWAY_API_KEY"
    ],
    "modelCount": 218,
    "protocol": "openai"
  },
  {
    "id": "merge-gateway",
    "name": "Merge Gateway",
    "baseURL": "https://api-gateway.merge.dev/v1/ai-sdk",
    "modelsURL": "https://api-gateway.merge.dev/v1/ai-sdk/models",
    "env": [
      "MERGE_GATEWAY_API_KEY"
    ],
    "modelCount": 209,
    "protocol": "openai"
  },
  {
    "id": "requesty",
    "name": "Requesty",
    "baseURL": "https://router.requesty.ai/v1",
    "modelsURL": "https://router.requesty.ai/v1/models",
    "env": [
      "REQUESTY_API_KEY"
    ],
    "modelCount": 182,
    "protocol": "openai"
  },
  {
    "id": "aimlapi",
    "name": "AI/ML API",
    "baseURL": "https://api.aimlapi.com/v1",
    "modelsURL": "https://api.aimlapi.com/v1/models",
    "env": [
      "AIMLAPI_API_KEY"
    ],
    "modelCount": 163,
    "protocol": "openai"
  },
  {
    "id": "ofox",
    "name": "Ofox",
    "baseURL": "https://api.ofox.ai/v1",
    "modelsURL": "https://api.ofox.ai/v1/models",
    "env": [
      "OFOX_API_KEY"
    ],
    "modelCount": 157,
    "protocol": "openai"
  },
  {
    "id": "poe",
    "name": "Poe",
    "baseURL": "https://api.poe.com/v1",
    "modelsURL": "https://api.poe.com/v1/models",
    "env": [
      "POE_API_KEY"
    ],
    "modelCount": 139,
    "protocol": "openai"
  },
  {
    "id": "302ai",
    "name": "302.AI",
    "baseURL": "https://api.302.ai/v1",
    "modelsURL": "https://api.302.ai/v1/models",
    "env": [
      "302AI_API_KEY"
    ],
    "modelCount": 127,
    "protocol": "openai"
  },
  {
    "id": "orcarouter",
    "name": "OrcaRouter",
    "baseURL": "https://api.orcarouter.ai/v1",
    "modelsURL": "https://api.orcarouter.ai/v1/models",
    "env": [
      "ORCAROUTER_API_KEY"
    ],
    "modelCount": 117,
    "protocol": "openai"
  },
  {
    "id": "zenmux",
    "name": "ZenMux",
    "baseURL": "https://zenmux.ai/api/v1",
    "modelsURL": "https://zenmux.ai/api/v1/models",
    "env": [
      "ZENMUX_API_KEY"
    ],
    "modelCount": 110,
    "protocol": "openai"
  },
  {
    "id": "cortecs",
    "name": "Cortecs",
    "baseURL": "https://api.cortecs.ai/v1",
    "modelsURL": "https://api.cortecs.ai/v1/models",
    "env": [
      "CORTECS_API_KEY"
    ],
    "modelCount": 110,
    "protocol": "openai"
  },
  {
    "id": "abacus",
    "name": "Abacus",
    "baseURL": "https://routellm.abacus.ai/v1",
    "modelsURL": "https://routellm.abacus.ai/v1/models",
    "env": [
      "ABACUS_API_KEY"
    ],
    "modelCount": 108,
    "protocol": "openai"
  },
  {
    "id": "novita-ai",
    "name": "Novita AI",
    "baseURL": "https://api.novita.ai/openai",
    "modelsURL": "https://api.novita.ai/openai/models",
    "env": [
      "NOVITA_API_KEY"
    ],
    "modelCount": 97,
    "protocol": "openai"
  },
  {
    "id": "huggingface",
    "name": "Hugging Face",
    "baseURL": "https://router.huggingface.co/v1",
    "modelsURL": "https://router.huggingface.co/v1/models",
    "env": [
      "HF_TOKEN"
    ],
    "modelCount": 93,
    "protocol": "openai"
  },
  {
    "id": "commandcode",
    "name": "CommandCode",
    "baseURL": "https://api.commandcode.ai/provider/v1",
    "modelsURL": "https://api.commandcode.ai/provider/v1/models",
    "env": [
      "CMD_API_KEY"
    ],
    "modelCount": 93,
    "protocol": "openai"
  },
  {
    "id": "helicone",
    "name": "Helicone",
    "baseURL": "https://ai-gateway.helicone.ai/v1",
    "modelsURL": "https://ai-gateway.helicone.ai/v1/models",
    "env": [
      "HELICONE_API_KEY"
    ],
    "modelCount": 90,
    "protocol": "openai"
  },
  {
    "id": "digitalocean",
    "name": "DigitalOcean",
    "baseURL": "https://inference.do-ai.run/v1",
    "modelsURL": "https://inference.do-ai.run/v1/models",
    "env": [
      "DIGITALOCEAN_ACCESS_TOKEN"
    ],
    "modelCount": 88,
    "protocol": "openai"
  },
  {
    "id": "qiniu-ai",
    "name": "Qiniu",
    "baseURL": "https://api.qnaigc.com/v1",
    "modelsURL": "https://api.qnaigc.com/v1/models",
    "env": [
      "QINIU_API_KEY"
    ],
    "modelCount": 87,
    "protocol": "openai"
  },
  {
    "id": "kenari",
    "name": "Kenari",
    "baseURL": "https://kenari.id/v1",
    "modelsURL": "https://kenari.id/v1/models",
    "env": [
      "KENARI_API_KEY"
    ],
    "modelCount": 83,
    "protocol": "openai"
  },
  {
    "id": "alibaba-cn",
    "name": "Alibaba (China)",
    "baseURL": "https://dashscope.aliyuncs.com/compatible-mode/v1",
    "modelsURL": "https://dashscope.aliyuncs.com/compatible-mode/v1/models",
    "env": [
      "DASHSCOPE_API_KEY"
    ],
    "modelCount": 80,
    "protocol": "openai"
  },
  {
    "id": "impossibl",
    "name": "Impossibl",
    "baseURL": "https://api.impossibl.com/v1",
    "modelsURL": "https://api.impossibl.com/v1/models",
    "env": [
      "IMPOSSIBL_API_KEY"
    ],
    "modelCount": 76,
    "protocol": "openai"
  },
  {
    "id": "crossmodel",
    "name": "CrossModel",
    "baseURL": "https://api.crossmodel.ai/v1",
    "modelsURL": "https://api.crossmodel.ai/v1/models",
    "env": [
      "CROSSMODEL_API_KEY"
    ],
    "modelCount": 76,
    "protocol": "openai"
  },
  {
    "id": "prime",
    "name": "Prime Inference",
    "baseURL": "https://api.pinference.ai/api/v1",
    "modelsURL": "https://api.pinference.ai/api/v1/models",
    "env": [
      "PRIME_API_KEY"
    ],
    "modelCount": 69,
    "protocol": "openai"
  },
  {
    "id": "empiriolabs",
    "name": "EmpirioLabs AI",
    "baseURL": "https://api.empiriolabs.ai/v1",
    "modelsURL": "https://api.empiriolabs.ai/v1/models",
    "env": [
      "EMPIRIOLABS_API_KEY"
    ],
    "modelCount": 63,
    "protocol": "openai"
  },
  {
    "id": "jiekou",
    "name": "Jiekou.AI",
    "baseURL": "https://api.jiekou.ai/openai",
    "modelsURL": "https://api.jiekou.ai/openai/models",
    "env": [
      "JIEKOU_API_KEY"
    ],
    "modelCount": 61,
    "protocol": "openai"
  },
  {
    "id": "nearai",
    "name": "NEAR AI Cloud",
    "baseURL": "https://cloud-api.near.ai/v1",
    "modelsURL": "https://cloud-api.near.ai/v1/models",
    "env": [
      "NEARAI_API_KEY"
    ],
    "modelCount": 61,
    "protocol": "openai"
  },
  {
    "id": "opper",
    "name": "Opper",
    "baseURL": "https://api.opper.ai/v3/compat",
    "modelsURL": "https://api.opper.ai/v3/compat/models",
    "env": [
      "OPPER_API_KEY"
    ],
    "modelCount": 56,
    "protocol": "openai"
  },
  {
    "id": "fastrouter",
    "name": "FastRouter",
    "baseURL": "https://go.fastrouter.ai/api/v1",
    "modelsURL": "https://go.fastrouter.ai/api/v1/models",
    "env": [
      "FASTROUTER_API_KEY"
    ],
    "modelCount": 55,
    "protocol": "openai"
  },
  {
    "id": "frogbot",
    "name": "FrogBot",
    "baseURL": "https://app.frogbot.ai/api/v1",
    "modelsURL": "https://app.frogbot.ai/api/v1/models",
    "env": [
      "FROGBOT_API_KEY"
    ],
    "modelCount": 51,
    "protocol": "openai"
  },
  {
    "id": "siliconflow-cn",
    "name": "SiliconFlow (China)",
    "baseURL": "https://api.siliconflow.cn/v1",
    "modelsURL": "https://api.siliconflow.cn/v1/models",
    "env": [
      "SILICONFLOW_CN_API_KEY"
    ],
    "modelCount": 46,
    "protocol": "openai"
  },
  {
    "id": "lowrouter",
    "name": "LowRouter",
    "baseURL": "https://api.lowrouter.ai/v1",
    "modelsURL": "https://api.lowrouter.ai/v1/models",
    "env": [
      "LOWROUTER_API_KEY"
    ],
    "modelCount": 45,
    "protocol": "openai"
  },
  {
    "id": "perplexity-agent",
    "name": "Perplexity Agent",
    "baseURL": "https://api.perplexity.ai/v1",
    "modelsURL": "https://api.perplexity.ai/v1/models",
    "env": [
      "PERPLEXITY_API_KEY"
    ],
    "modelCount": 45,
    "protocol": "openai"
  },
  {
    "id": "vivgrid",
    "name": "Vivgrid",
    "baseURL": "https://api.vivgrid.com/v1",
    "modelsURL": "https://api.vivgrid.com/v1/models",
    "env": [
      "VIVGRID_API_KEY"
    ],
    "modelCount": 45,
    "protocol": "openai"
  },
  {
    "id": "opencode-go",
    "name": "OpenCode Go",
    "baseURL": "https://opencode.ai/inference/go/openai/v1",
    "modelsURL": "https://opencode.ai/inference/go/openai/v1/models",
    "env": [
      "OPENCODE_API_KEY"
    ],
    "modelCount": 42,
    "protocol": "openai"
  },
  {
    "id": "greenpt",
    "name": "GreenPT",
    "baseURL": "https://api.greenpt.ai/v1",
    "modelsURL": "https://api.greenpt.ai/v1/models",
    "env": [
      "GREENPT_API_KEY"
    ],
    "modelCount": 41,
    "protocol": "openai"
  },
  {
    "id": "standardcompute",
    "name": "Standard Compute",
    "baseURL": "https://api.stdcmpt.com/v1",
    "modelsURL": "https://api.stdcmpt.com/v1/models",
    "env": [
      "STANDARDCOMPUTE_API_KEY"
    ],
    "modelCount": 40,
    "protocol": "openai"
  },
  {
    "id": "thinkingmachines",
    "name": "Thinking Machines",
    "baseURL": "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1",
    "modelsURL": "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1/models",
    "env": [
      "TINKER_API_KEY"
    ],
    "modelCount": 38,
    "protocol": "anthropic"
  },
  {
    "id": "llmtr",
    "name": "LLMTR",
    "baseURL": "https://llmtr.com/v1",
    "modelsURL": "https://llmtr.com/v1/models",
    "env": [
      "LLMTR_API_KEY"
    ],
    "modelCount": 32,
    "protocol": "openai"
  },
  {
    "id": "databricks",
    "name": "Databricks",
    "baseURL": "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1",
    "modelsURL": "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1/models",
    "env": [
      "DATABRICKS_HOST"
    ],
    "modelCount": 31,
    "protocol": "openai"
  },
  {
    "id": "anyapi",
    "name": "AnyAPI",
    "baseURL": "https://api.anyapi.ai/v1",
    "modelsURL": "https://api.anyapi.ai/v1/models",
    "env": [
      "ANYAPI_API_KEY"
    ],
    "modelCount": 30,
    "protocol": "openai"
  },
  {
    "id": "cloudflare-workers-ai",
    "name": "Cloudflare Workers AI",
    "baseURL": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
    "modelsURL": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/models",
    "env": [
      "CLOUDFLARE_ACCOUNT_ID"
    ],
    "modelCount": 30,
    "protocol": "openai"
  },
  {
    "id": "alibaba-token-plan-cn",
    "name": "Alibaba Token Plan (China)",
    "baseURL": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "modelsURL": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models",
    "env": [
      "ALIBABA_TOKEN_PLAN_API_KEY"
    ],
    "modelCount": 29,
    "protocol": "openai"
  },
  {
    "id": "alibaba-token-plan",
    "name": "Alibaba Token Plan",
    "baseURL": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "modelsURL": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1/models",
    "env": [
      "ALIBABA_TOKEN_PLAN_API_KEY"
    ],
    "modelCount": 29,
    "protocol": "openai"
  },
  {
    "id": "iteracompute",
    "name": "IteraCompute",
    "baseURL": "https://api.iteracompute.com/v1",
    "modelsURL": "https://api.iteracompute.com/v1/models",
    "env": [
      "ITERACOMPUTE_API_KEY"
    ],
    "modelCount": 27,
    "protocol": "openai"
  },
  {
    "id": "ollama-cloud",
    "name": "Ollama Cloud",
    "baseURL": "https://ollama.com/v1",
    "modelsURL": "https://ollama.com/v1/models",
    "env": [
      "OLLAMA_API_KEY"
    ],
    "modelCount": 27,
    "protocol": "openai"
  },
  {
    "id": "fireworks-ai",
    "name": "Fireworks AI",
    "baseURL": "https://api.fireworks.ai/inference/v1/",
    "modelsURL": "https://api.fireworks.ai/inference/v1/models",
    "env": [
      "FIREWORKS_API_KEY"
    ],
    "modelCount": 27,
    "protocol": "openai"
  },
  {
    "id": "snowflake-cortex",
    "name": "Snowflake Cortex",
    "baseURL": "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
    "modelsURL": "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1/models",
    "env": [
      "SNOWFLAKE_ACCOUNT"
    ],
    "modelCount": 25,
    "protocol": "openai"
  },
  {
    "id": "tensorx",
    "name": "TensorX",
    "baseURL": "https://api.tensorx.ai/v1",
    "modelsURL": "https://api.tensorx.ai/v1/models",
    "env": [
      "TENSORX_API_KEY"
    ],
    "modelCount": 25,
    "protocol": "openai"
  },
  {
    "id": "pioneer",
    "name": "Pioneer",
    "baseURL": "https://api.fastino.ai/v1",
    "modelsURL": "https://api.fastino.ai/v1/models",
    "env": [
      "PIONEER_API_KEY"
    ],
    "modelCount": 25,
    "protocol": "openai"
  },
  {
    "id": "wandb",
    "name": "CoreWeave",
    "baseURL": "https://api.inference.wandb.ai/v1",
    "modelsURL": "https://api.inference.wandb.ai/v1/models",
    "env": [
      "WANDB_API_KEY"
    ],
    "modelCount": 24,
    "protocol": "openai"
  },
  {
    "id": "nebius",
    "name": "Nebius Token Factory",
    "baseURL": "https://api.tokenfactory.nebius.com/v1",
    "modelsURL": "https://api.tokenfactory.nebius.com/v1/models",
    "env": [
      "NEBIUS_API_KEY"
    ],
    "modelCount": 24,
    "protocol": "openai"
  },
  {
    "id": "neuralwatt",
    "name": "Neuralwatt",
    "baseURL": "https://api.neuralwatt.com/v1",
    "modelsURL": "https://api.neuralwatt.com/v1/models",
    "env": [
      "NEURALWATT_API_KEY"
    ],
    "modelCount": 23,
    "protocol": "openai"
  },
  {
    "id": "unorouter",
    "name": "UnoRouter",
    "baseURL": "https://api.unorouter.com/v1",
    "modelsURL": "https://api.unorouter.com/v1/models",
    "env": [
      "UNOROUTER_API_KEY"
    ],
    "modelCount": 23,
    "protocol": "openai"
  },
  {
    "id": "jzstoken",
    "name": "JZSTOKEN",
    "baseURL": "https://jzstoken.com/api/v1",
    "modelsURL": "https://jzstoken.com/api/v1/models",
    "env": [
      "JZSTOKEN_API_KEY"
    ],
    "modelCount": 22,
    "protocol": "openai"
  },
  {
    "id": "cline-pass",
    "name": "ClinePass",
    "baseURL": "https://api.cline.bot/api/v1",
    "modelsURL": "https://api.cline.bot/api/v1/models",
    "env": [
      "CLINE_API_KEY"
    ],
    "modelCount": 21,
    "protocol": "openai"
  },
  {
    "id": "steadyrouter",
    "name": "SteadyRouter",
    "baseURL": "https://api.steadyrouter.com/v1",
    "modelsURL": "https://api.steadyrouter.com/v1/models",
    "env": [
      "STEADYROUTER_API_KEY"
    ],
    "modelCount": 21,
    "protocol": "openai"
  },
  {
    "id": "bumo",
    "name": "Bumo Router",
    "baseURL": "https://router.bumo.ai/v1",
    "modelsURL": "https://router.bumo.ai/v1/models",
    "env": [
      "BUMO_API_KEY"
    ],
    "modelCount": 20,
    "protocol": "openai"
  },
  {
    "id": "hyper",
    "name": "Charm Hyper",
    "baseURL": "https://hyper.charm.land/v1",
    "modelsURL": "https://hyper.charm.land/v1/models",
    "env": [
      "HYPER_API_KEY"
    ],
    "modelCount": 20,
    "protocol": "openai"
  },
  {
    "id": "boundless",
    "name": "Boundless",
    "baseURL": "https://api.inference.boundless.network/v1",
    "modelsURL": "https://api.inference.boundless.network/v1/models",
    "env": [
      "BOUNDLESS_API_KEY"
    ],
    "modelCount": 20,
    "protocol": "openai"
  },
  {
    "id": "meganova",
    "name": "Meganova",
    "baseURL": "https://api.meganova.ai/v1",
    "modelsURL": "https://api.meganova.ai/v1/models",
    "env": [
      "MEGANOVA_API_KEY"
    ],
    "modelCount": 19,
    "protocol": "openai"
  },
  {
    "id": "phala",
    "name": "Phala",
    "baseURL": "https://inference.phala.com/v1",
    "modelsURL": "https://inference.phala.com/v1/models",
    "env": [
      "PHALA_AI_API_KEY"
    ],
    "modelCount": 19,
    "protocol": "openai"
  },
  {
    "id": "korouter",
    "name": "KoRouter",
    "baseURL": "https://korouter.ai/v1",
    "modelsURL": "https://korouter.ai/v1/models",
    "env": [
      "KOROUTER_API_KEY"
    ],
    "modelCount": 19,
    "protocol": "openai"
  }
]
