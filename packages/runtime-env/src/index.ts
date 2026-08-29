export { RuntimeEnv, MIN_OPENCODE_VERSION, parseSemver, semverGte } from "./binaries.js"
export type {
  BinaryName,
  ResolvedBinary,
  RuntimeEnvOptions,
  OpencodeVersionProbe,
  OpencodeResolution,
} from "./binaries.js"

export { PROBE_TIMEOUT_MS, probeBinaryVersion } from "./probe-version.js"

export { createAgentResolver } from "./agent-resolution-cache.js"

export {
  PYTHON_MIN_VERSION,
  bundledPythonExe,
  probePythonVersion,
  resolvePython,
} from "./python.js"
export type { PythonVersionProbe, ResolvedPython } from "./python.js"

export { ProcessRunner } from "./process.js"
export { maskArgValues } from "./process.js"
export type { ExecSpec, ExecResult, SpawnSpec, DuplexSpec, DuplexHandle } from "./process.js"

export {
  EMBED_MODEL_NAME,
  LOCAL_EMBED_DIM,
  LOCAL_EMBED_PORT_DEFAULT,
  looksLikeModelDir,
  embedModelCandidates,
  probeEmbedAccelerator,
  probeEmbedModel,
  localEmbedBaseUrl,
  isLocalEmbedUsable,
  resolveEmbedGateway,
  formatEmbedStatusText,
  formatEmbedGatewayStatus,
} from "./embed-model.js"
export type {
  EmbedAccelerator,
  EmbedProbeReason,
  EmbedModelProbeResult,
  EmbedModelProbeOptions,
  EmbedGatewayMode,
  EmbedGatewayConfigSlice,
  ResolveEmbedGatewayInput,
  ResolvedEmbedGateway,
} from "./embed-model.js"
