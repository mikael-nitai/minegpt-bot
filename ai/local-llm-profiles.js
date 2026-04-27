const DEFAULT_LLM_PROFILE = 'equilibrio'
const DEFAULT_LLM_MODEL = 'qwen2.5:14b-instruct'
const FALLBACK_LLM_MODEL = 'qwen2.5:14b'

const LOCAL_LLM_PROFILES = {
  economia: {
    name: 'economia',
    label: 'economia',
    model: DEFAULT_LLM_MODEL,
    fallbackModel: FALLBACK_LLM_MODEL,
    numCtx: 2048,
    temperature: 0,
    maxOutputTokens: 160,
    maxSteps: 1,
    timeoutMs: 15000,
    keepAlive: '30s'
  },
  equilibrio: {
    name: 'equilibrio',
    label: 'equilibrio',
    model: DEFAULT_LLM_MODEL,
    fallbackModel: FALLBACK_LLM_MODEL,
    numCtx: 4096,
    temperature: 0,
    maxOutputTokens: 256,
    maxSteps: 1,
    timeoutMs: 20000,
    keepAlive: '5m'
  },
  performance: {
    name: 'performance',
    label: 'performance',
    model: DEFAULT_LLM_MODEL,
    fallbackModel: FALLBACK_LLM_MODEL,
    numCtx: 8192,
    temperature: 0.1,
    maxOutputTokens: 384,
    maxSteps: 1,
    timeoutMs: 30000,
    keepAlive: '15m'
  }
}

const PROFILE_ALIASES = {
  economy: 'economia',
  balanced: 'equilibrio',
  balanceado: 'equilibrio',
  desempenho: 'performance',
  perf: 'performance'
}

function normalizeProfileName (name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function coercePositiveInteger (value, fallback) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback
  return parsed
}

function coerceNumber (value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function resolveProfileName (rawName) {
  const normalized = normalizeProfileName(rawName)
  if (!normalized) return DEFAULT_LLM_PROFILE
  return PROFILE_ALIASES[normalized] || normalized
}

function readConfiguredProfileName (config = {}, env = process.env) {
  return env.MINEGPT_AI_PROFILE || config.ai?.profile || config.ai?.ollama?.profile || config.profile || DEFAULT_LLM_PROFILE
}

function getLocalLlmProfile (config = {}, env = process.env) {
  const requestedProfile = readConfiguredProfileName(config, env)
  const resolvedName = resolveProfileName(requestedProfile)
  const baseProfile = LOCAL_LLM_PROFILES[resolvedName] || LOCAL_LLM_PROFILES[DEFAULT_LLM_PROFILE]
  const fallbackReason = LOCAL_LLM_PROFILES[resolvedName]
    ? null
    : `perfil desconhecido: ${requestedProfile || '(vazio)'}; usando ${DEFAULT_LLM_PROFILE}`

  const envModel = env.MINEGPT_AI_MODEL || env.MINEGPT_OLLAMA_MODEL
  const configModel = config.ai?.model || config.ai?.ollama?.model
  const profile = {
    ...baseProfile,
    requestedProfile: String(requestedProfile || DEFAULT_LLM_PROFILE),
    fallbackReason
  }

  profile.model = envModel || configModel || profile.model
  profile.fallbackModel = env.MINEGPT_AI_FALLBACK_MODEL || config.ai?.ollama?.fallbackModel || config.ai?.ollama?.fallback_model || profile.fallbackModel
  profile.baseUrl = env.MINEGPT_AI_URL || env.MINEGPT_OLLAMA_BASE_URL || env.OLLAMA_HOST || config.ai?.ollama?.baseUrl || config.ai?.url || 'http://localhost:11434'
  profile.numCtx = coercePositiveInteger(env.MINEGPT_AI_NUM_CTX || config.ai?.ollama?.numCtx || config.ai?.ollama?.num_ctx, profile.numCtx)
  profile.temperature = coerceNumber(env.MINEGPT_AI_TEMPERATURE || config.ai?.ollama?.temperature, profile.temperature)
  profile.maxOutputTokens = coercePositiveInteger(
    env.MINEGPT_AI_MAX_OUTPUT_TOKENS || env.MINEGPT_OLLAMA_NUM_PREDICT || config.ai?.ollama?.maxOutputTokens || config.ai?.ollama?.max_output_tokens,
    profile.maxOutputTokens
  )
  profile.timeoutMs = coercePositiveInteger(env.MINEGPT_AI_TIMEOUT_MS || env.MINEGPT_OLLAMA_TIMEOUT_MS || config.ai?.ollama?.timeoutMs || config.ai?.ollama?.timeout_ms, profile.timeoutMs)
  profile.maxSteps = coercePositiveInteger(env.MINEGPT_AI_MAX_STEPS || config.ai?.maxSteps || config.ai?.max_steps, profile.maxSteps)
  profile.keepAlive = env.MINEGPT_AI_KEEP_ALIVE || config.ai?.ollama?.keepAlive || config.ai?.ollama?.keep_alive || profile.keepAlive

  if (profile.maxSteps > 1) profile.maxSteps = 1
  if (profile.numCtx > 8192) profile.numCtx = 8192
  if (profile.maxOutputTokens > 384) profile.maxOutputTokens = 384

  return profile
}

function describeLocalLlmProfile (config = {}, env = process.env) {
  const profile = getLocalLlmProfile(config, env)
  return [
    `perfil=${profile.name}`,
    `modelo=${profile.model}`,
    `num_ctx=${profile.numCtx}`,
    `max_output_tokens=${profile.maxOutputTokens}`,
    `timeout_ms=${profile.timeoutMs}`,
    `keep_alive=${profile.keepAlive}`
  ].join(' | ')
}

module.exports = {
  DEFAULT_LLM_PROFILE,
  DEFAULT_LLM_MODEL,
  FALLBACK_LLM_MODEL,
  LOCAL_LLM_PROFILES,
  normalizeProfileName,
  resolveProfileName,
  getLocalLlmProfile,
  describeLocalLlmProfile
}
