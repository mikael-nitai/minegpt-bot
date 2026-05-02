const mockProvider = require('./mock-provider')
const ruleBasedProvider = require('./rule-based-provider')
const ollamaProvider = require('./ollama-provider')

const DEFAULT_PROVIDER = 'ollama'
const PROVIDERS = {
  mock: mockProvider,
  rule_based: ruleBasedProvider,
  ollama: ollamaProvider
}

function normalizeProviderName (name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
}

function configuredProviderName (config = {}, env = process.env) {
  return normalizeProviderName(env.MINEGPT_AI_PROVIDER || config.ai?.provider || config.provider || DEFAULT_PROVIDER)
}

function configuredFallbackProviderName (config = {}, env = process.env) {
  return normalizeProviderName(env.MINEGPT_AI_FALLBACK_PROVIDER || config.ai?.fallbackProvider || config.ai?.fallback_provider || config.fallbackProvider || '')
}

function getPlannerProvider (config = {}, env = process.env) {
  const requestedName = configuredProviderName(config, env)
  const provider = PROVIDERS[requestedName]
  if (provider) {
    return {
      ...provider,
      requestedName,
      fallbackReason: null
    }
  }

  return {
    ...mockProvider,
    requestedName,
    fallbackReason: `provider desconhecido: ${requestedName || '(vazio)'}`
  }
}

function getFallbackPlannerProvider (config = {}, env = process.env) {
  const requestedName = configuredFallbackProviderName(config, env)
  if (!requestedName) return null
  if (requestedName === 'ollama') return null

  const provider = PROVIDERS[requestedName]
  if (provider) {
    return {
      ...provider,
      requestedName,
      fallbackReason: null
    }
  }

  return {
    ...mockProvider,
    requestedName,
    fallbackReason: `fallback provider desconhecido: ${requestedName}; usando mock`
  }
}

module.exports = {
  DEFAULT_PROVIDER,
  PROVIDERS,
  getPlannerProvider,
  getFallbackPlannerProvider,
  normalizeProviderName,
  configuredProviderName,
  configuredFallbackProviderName
}
