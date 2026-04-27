const DEFAULT_MAX_CALLS_PER_MINUTE = 6
const DEFAULT_SKILLS_CACHE_TTL_MS = 30000
const HARD_MAX_CALLS_PER_MINUTE = 60
const HARD_MAX_SKILLS_CACHE_TTL_MS = 300000

function coerceIntegerInRange (value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

function getAiMaxCallsPerMinute (config = {}, env = process.env) {
  return coerceIntegerInRange(
    env.MINEGPT_AI_MAX_CALLS_PER_MINUTE ||
      config.ai?.maxCallsPerMinute ||
      config.ai?.max_calls_per_minute,
    DEFAULT_MAX_CALLS_PER_MINUTE,
    0,
    HARD_MAX_CALLS_PER_MINUTE
  )
}

function getSkillsCacheTtlMs (config = {}, env = process.env) {
  return coerceIntegerInRange(
    env.MINEGPT_AI_SKILLS_CACHE_TTL_MS ||
      config.ai?.skillsCacheTtlMs ||
      config.ai?.skills_cache_ttl_ms,
    DEFAULT_SKILLS_CACHE_TTL_MS,
    0,
    HARD_MAX_SKILLS_CACHE_TTL_MS
  )
}

function createAiRateLimiter ({ windowMs = 60000, now = () => Date.now() } = {}) {
  const buckets = new Map()

  function check ({ key = 'ollama', limit = DEFAULT_MAX_CALLS_PER_MINUTE } = {}) {
    const maxCalls = Number(limit)
    if (!Number.isInteger(maxCalls) || maxCalls <= 0) {
      return {
        ok: false,
        retryAfterMs: windowMs,
        limit: Math.max(0, maxCalls || 0),
        remaining: 0
      }
    }

    const current = now()
    const minTime = current - windowMs
    const calls = (buckets.get(key) || []).filter(timestamp => timestamp > minTime)

    if (calls.length >= maxCalls) {
      const retryAfterMs = Math.max(1, windowMs - (current - calls[0]))
      buckets.set(key, calls)
      return {
        ok: false,
        retryAfterMs,
        limit: maxCalls,
        remaining: 0
      }
    }

    calls.push(current)
    buckets.set(key, calls)
    return {
      ok: true,
      retryAfterMs: 0,
      limit: maxCalls,
      remaining: Math.max(0, maxCalls - calls.length)
    }
  }

  function reset () {
    buckets.clear()
  }

  return {
    check,
    reset
  }
}

const defaultAiRateLimiter = createAiRateLimiter()

module.exports = {
  DEFAULT_MAX_CALLS_PER_MINUTE,
  DEFAULT_SKILLS_CACHE_TTL_MS,
  createAiRateLimiter,
  defaultAiRateLimiter,
  getAiMaxCallsPerMinute,
  getSkillsCacheTtlMs
}
