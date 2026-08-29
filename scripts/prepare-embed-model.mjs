#!/usr/bin/env node
/**
 * 旁路 Qwen3-Embedding-8B 资源探测（不下载、不入 git）。
 *
 * 约定布局（B2）：
 *   <sidecarRoot>/Qwen3-Embedding-8B/   （权重目录；发版另带）
 *
 * sidecarRoot 解析顺序：
 *   1. MYCONTEXT_EMBED_MODEL_DIR（显式）
 *   2. 打包态：process.resourcesPath/../models 或同级 models/
 *   3. 开发态：仓库根 vendor/models（仅占位 README，无权重）
 *
 * 退出码：0=就位；1=缺失（给 CI/发版脚本用）。
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MODEL_NAME = "Qwen3-Embedding-8B"

function candidates() {
  const out = []
  const env = process.env["MYCONTEXT_EMBED_MODEL_DIR"]
  if (env) out.push(env)
  out.push(join(root, "vendor", "models", MODEL_NAME))
  out.push(join(root, "models", MODEL_NAME))
  return out
}

function looksLikeModelDir(dir) {
  if (!existsSync(dir)) return false
  try {
    const entries = readdirSync(dir)
    // 常见：config.json + 权重分片；至少有 config 或 .safetensors/.bin
    return (
      entries.includes("config.json") ||
      entries.some((e) => e.endsWith(".safetensors") || e.endsWith(".bin") || e.endsWith(".gguf"))
    )
  } catch {
    return false
  }
}

const hit = candidates().find(looksLikeModelDir)
if (hit) {
  console.log(`✓ embedding 旁路模型就位：${hit}`)
  process.exit(0)
}

const readme = join(root, "vendor", "models", "README.md")
if (!existsSync(readme)) {
  // 仅写说明，不写权重
  writeFileSync(join(root, "vendor", "models", ".gitkeep"), "", "utf8")
}

console.error(
  [
    `✗ 未找到旁路模型 ${MODEL_NAME}`,
    "  期望目录（任选其一）：",
    ...candidates().map((p) => `    - ${p}`),
    "  将权重放到上述目录后重跑；不要把权重提交进 git。",
  ].join("\n"),
)
process.exit(1)
