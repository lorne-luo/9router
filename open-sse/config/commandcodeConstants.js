// CommandCode (/alpha/generate) reasoning-effort contract.
//
// Wire enum (probed live 2026-10-02): params.reasoning_effort must be one of
// off|low|medium|high|xhigh|max — anything else ("none", "minimal", "auto", …)
// is a 400 "Invalid option". 9router's "none" level goes out as "off".
export const COMMANDCODE_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"];
export const COMMANDCODE_EFFORT_OFF = "off";

// Per-model offered levels, copied from the official CLI's model table
// (npm command-code@1.74.0, dist/cli.mjs; "off" renamed to "none").
// Models not listed fall back to getThinkingLevels' generic pattern/format levels.
const L_M_H_X_MAX = ["low", "medium", "high", "xhigh", "max"];
const L_M_H_X = ["low", "medium", "high", "xhigh"];
const L_M_H = ["low", "medium", "high"];
const N_H_MAX = ["none", "high", "max"];
const L_H_MAX = ["low", "high", "max"];
const N_L_H_MAX = ["none", "low", "high", "max"];
const H_MAX = ["high", "max"];
const L_M_H_MAX = ["low", "medium", "high", "max"];
const L_M_X = ["low", "medium", "xhigh"];
const H_X = ["high", "xhigh"];

export const COMMANDCODE_MODEL_LEVELS = {
  "claude-sonnet-5-5": L_M_H_X_MAX,
  "claude-sonnet-5": L_M_H_X_MAX,
  "claude-sonnet-4-6": L_M_H_X_MAX,
  "claude-fable-5-1": L_M_H_X_MAX,
  "claude-fable-5": L_M_H_X_MAX,
  "claude-opus-5-5": L_M_H_X_MAX,
  "claude-opus-5": L_M_H_X_MAX,
  "claude-opus-4-8": L_M_H_X_MAX,
  "claude-opus-4-7": L_M_H_X_MAX,
  "gpt-6-astra": L_M_H_X_MAX,
  "gpt-6.1-sol": L_M_H_X_MAX,
  "gpt-6-sol": L_M_H_X_MAX,
  "gpt-6-luna": L_M_H_X_MAX,
  "gpt-5.6-sol": L_M_H_X_MAX,
  "gpt-5.6-terra": L_M_H_X_MAX,
  "gpt-5.6-luna": L_M_H_X_MAX,
  "gpt-5.5": L_M_H_X,
  "gpt-5.4": L_M_H_X,
  "gpt-5.3-codex": L_M_H_X,
  "gpt-5.4-mini": L_M_H,
  "deepseek/deepseek-v4-pro": N_H_MAX,
  "deepseek/deepseek-v4-flash": N_H_MAX,
  "deepseek/deepseek-v4-flash-vision-exp": N_H_MAX,
  "deepseek/deepseek-v4-flash-fast": L_H_MAX,
  "deepseek/deepseek-v4.1-flash": N_L_H_MAX,
  "deepseek/deepseek-v4.1-flash-fast": N_L_H_MAX,
  "moonshotai/Kimi-K3": L_H_MAX,
  "zai-org/GLM-5.3": L_H_MAX,
  "z-ai/glm-5.3-flash": L_H_MAX,
  "z-ai/glm-5.3-flashx": L_H_MAX,
  "zai-org/GLM-5.2": H_MAX,
  "google/gemini-3.8-flash": L_M_H,
  "google/gemini-3.7-flash": L_M_H,
  "stealth/space-bunny-alpha": L_M_H_MAX,
  "stealth/pixel-canary": L_M_X,
  "google/gemini-3.6-flash": L_M_H,
  "google/gemini-3.5-flash": L_M_H,
  "google/gemini-3.5-flash-lite": L_M_H,
  "google/gemini-3.1-flash-lite": L_M_H,
  "tencent/hy4-preview": L_M_H,
  "inclusionai/ling-3.1-flash:free": L_M_H,
  "sakana/fugu-ultra": H_X,
  "xai/grok-4.5": L_M_H,
  "xai/grok-4.6": L_M_H_X,
  "xai/grok-4.7": L_M_H_X,
  "Qwen/Qwen3.8-Omni-Flash": L_M_X,
  "Qwen/Qwen3.8-Max-0902": L_M_X,
  "Qwen/Qwen3.8-Max": L_M_X,
  "Qwen/Qwen3.8-27B": L_M_X,
  "Qwen/Qwen3.8-Flash": L_M_X,
  "meta/muse-spark-1.1": L_M_H_X,
  "meta/muse-spark-1.2": L_M_H_X,
  "meta/muse-spark-1.2-contributor": L_M_H_X,
  "meta/muse-spark-1.3": L_M_H_X_MAX,
  "meta/muse-spark-1.3-contributor": L_M_H_X,
  "stepfun/Step-5-Preview": L_M_H,
  "MiniMaxAI/MiniMax-M3": L_M_H,
  "minimax/minimax-m3-free": L_M_H,
  "MiniMaxAI/MiniMax-M3-Free": L_M_H,
};
