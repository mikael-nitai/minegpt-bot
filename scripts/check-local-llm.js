const { spawnSync } = require('child_process')
const http = require('http')
const { URL } = require('url')
const { getLocalLlmProfile } = require('../ai/local-llm-profiles')

const PROFILE = getLocalLlmProfile({}, process.env)
const OLLAMA_HOST = PROFILE.baseUrl
const PRIMARY_MODEL = PROFILE.model
const FALLBACK_MODEL = PROFILE.fallbackModel
const CANDIDATE_MODELS = [...new Set([PRIMARY_MODEL, FALLBACK_MODEL])]

function printCheck (label, ok, detail = '') {
  console.log(`${label}: ${ok ? 'sim' : 'nao'}${detail ? ` (${detail})` : ''}`)
}

function commandExists (command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    output: (result.stdout || result.stderr || '').trim(),
    error: result.error
  }
}

function requestJson (path, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const url = new URL(path, OLLAMA_HOST)
    const request = http.request(url, { method: 'GET', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('end', () => {
        try {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            data: body ? JSON.parse(body) : null
          })
        } catch (error) {
          resolve({ ok: false, statusCode: response.statusCode, error })
        }
      })
    })

    request.on('timeout', () => {
      request.destroy(new Error('timeout'))
    })
    request.on('error', error => resolve({ ok: false, error }))
    request.end()
  })
}

function modelNameMatches (availableName, wantedName) {
  if (availableName === wantedName) return true
  if (availableName === `${wantedName}:latest`) return true
  return availableName.replace(/:latest$/, '') === wantedName
}

function chooseModel (models = []) {
  const names = models.map(model => model.name).filter(Boolean)
  for (const candidate of CANDIDATE_MODELS) {
    if (names.some(name => modelNameMatches(name, candidate))) return candidate
  }
  return null
}

function printSuggestions ({ installed, serverOk, modelFound }) {
  if (installed && serverOk && modelFound) return

  console.log('')
  console.log('Sugestoes:')

  if (!installed) {
    console.log('- Instale o Ollama pelo metodo oficial para Linux: curl -fsSL https://ollama.com/install.sh | sh')
    console.log('- Depois rode: npm run llm:setup')
    return
  }

  if (!serverOk) {
    console.log('- Inicie o servidor local com: ollama serve')
    console.log('- Se instalou via servico do sistema, verifique o status do servico Ollama.')
  }

  if (serverOk && !modelFound) {
    console.log('- Baixe o modelo com: npm run llm:pull')
    console.log(`- Modelo primario: ${PRIMARY_MODEL}`)
    console.log(`- Fallback aceito: ${FALLBACK_MODEL}`)
  }
}

async function checkLocalLlm () {
  const ollama = commandExists('ollama')
  const tags = ollama.ok ? await requestJson('/api/tags') : { ok: false, data: null }
  const models = Array.isArray(tags.data?.models) ? tags.data.models : []
  const selectedModel = chooseModel(models)

  printCheck('Ollama instalado', ollama.ok, ollama.output || ollama.error?.message || '')
  printCheck('Servidor respondendo', tags.ok, tags.statusCode ? `HTTP ${tags.statusCode}` : tags.error?.message || OLLAMA_HOST)
  printCheck('Modelo encontrado', Boolean(selectedModel), selectedModel || `esperado: ${CANDIDATE_MODELS.join(' ou ')}`)
  console.log(`Perfil escolhido: ${PROFILE.name}`)
  console.log(`num_ctx: ${PROFILE.numCtx}`)
  console.log(`max_output_tokens: ${PROFILE.maxOutputTokens}`)
  console.log(`timeout_ms: ${PROFILE.timeoutMs}`)
  console.log(`Modelo escolhido: ${selectedModel || PRIMARY_MODEL}`)

  printSuggestions({
    installed: ollama.ok,
    serverOk: tags.ok,
    modelFound: Boolean(selectedModel)
  })

  return {
    installed: ollama.ok,
    serverOk: tags.ok,
    modelFound: Boolean(selectedModel),
    selectedModel: selectedModel || PRIMARY_MODEL
  }
}

if (require.main === module) {
  checkLocalLlm().catch((error) => {
    console.error(`Falha inesperada no diagnostico local: ${error.message}`)
  })
}

module.exports = {
  checkLocalLlm,
  chooseModel,
  CANDIDATE_MODELS,
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  OLLAMA_HOST
}
