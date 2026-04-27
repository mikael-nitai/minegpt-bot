const { spawn, spawnSync } = require('child_process')
const http = require('http')
const { Buffer } = require('buffer')
const { URL } = require('url')
const {
  checkLocalLlm,
  CANDIDATE_MODELS,
  PRIMARY_MODEL,
  OLLAMA_HOST
} = require('./check-local-llm')
const { getLocalLlmProfile } = require('../ai/local-llm-profiles')

const PULL_ONLY = process.argv.includes('--pull-only')
const PROFILE = getLocalLlmProfile({}, process.env)

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function runCommand (command, args, options = {}) {
  console.log(`> ${[command, ...args].join(' ')}`)
  return spawnSync(command, args, {
    stdio: 'inherit',
    ...options
  })
}

function commandExists (command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8' })
  return result.status === 0
}

function requestJson (path, body = null, timeoutMs = 30000) {
  return new Promise((resolve) => {
    const url = new URL(path, OLLAMA_HOST)
    const payload = body ? JSON.stringify(body) : null
    const request = http.request(url, {
      method: payload ? 'POST' : 'GET',
      timeout: timeoutMs,
      headers: payload
        ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload)
          }
        : undefined
    }, (response) => {
      let responseBody = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { responseBody += chunk })
      response.on('end', () => {
        try {
          resolve({
            ok: response.statusCode >= 200 && response.statusCode < 300,
            statusCode: response.statusCode,
            data: responseBody ? JSON.parse(responseBody) : null
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
    if (payload) request.write(payload)
    request.end()
  })
}

async function waitForServer (attempts = 8) {
  for (let i = 0; i < attempts; i++) {
    const response = await requestJson('/api/tags', null, 2000)
    if (response.ok) return true
    await sleep(1000)
  }
  return false
}

async function startServerIfNeeded () {
  const alreadyRunning = await waitForServer(1)
  if (alreadyRunning) return true

  console.log('Servidor Ollama nao respondeu; tentando iniciar com: ollama serve')
  const child = spawn('ollama', ['serve'], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()

  return waitForServer(10)
}

async function pullFirstAvailableModel () {
  for (const model of CANDIDATE_MODELS) {
    const result = runCommand('ollama', ['pull', model])
    if (result.status === 0) return model
    console.log(`Nao consegui baixar ${model}; tentando proxima opcao se existir.`)
  }
  return null
}

async function runMinimalGeneration (model) {
  console.log(`Rodando teste local minimo com ${model}...`)
  const response = await requestJson('/api/generate', {
    model,
    prompt: 'Responda apenas OK.',
    stream: false,
    keep_alive: PROFILE.keepAlive,
    options: {
      temperature: PROFILE.temperature,
      num_ctx: PROFILE.numCtx,
      num_predict: Math.min(8, PROFILE.maxOutputTokens)
    }
  }, PROFILE.timeoutMs)

  if (!response.ok) {
    console.log(`Teste local falhou: ${response.statusCode || response.error?.message || 'sem resposta'}`)
    return false
  }

  const text = String(response.data?.response || '').trim()
  console.log(`Resposta do modelo: ${text || '(vazia)'}`)
  return true
}

async function setupLocalLlm () {
  console.log('Preparando LLM local para MineGPT Bot.')
  console.log(`Host Ollama: ${OLLAMA_HOST}`)
  console.log(`Modelo preferido: ${PRIMARY_MODEL}`)
  console.log(`Perfil: ${PROFILE.name} | num_ctx=${PROFILE.numCtx} | max_output_tokens=${PROFILE.maxOutputTokens} | timeout_ms=${PROFILE.timeoutMs}`)
  console.log('Este script nao usa sudo, nao instala pacotes do sistema e nao salva modelos no repositorio.')
  console.log('')

  if (!commandExists('ollama')) {
    console.log('Ollama nao encontrado.')
    console.log('Instale pelo metodo oficial para Linux:')
    console.log('curl -fsSL https://ollama.com/install.sh | sh')
    console.log('')
    console.log('Depois rode novamente: npm run llm:setup')
    return
  }

  const serverOk = await startServerIfNeeded()
  if (!serverOk) {
    console.log('Nao consegui iniciar ou acessar o servidor Ollama.')
    console.log('Tente manualmente em outro terminal: ollama serve')
    return
  }

  let status = await checkLocalLlm()
  if (!status.modelFound) {
    const pulledModel = await pullFirstAvailableModel()
    if (!pulledModel) {
      console.log('Nao consegui baixar nenhum modelo alvo.')
      return
    }
    status = await checkLocalLlm()
    status.selectedModel = status.selectedModel || pulledModel
  } else if (PULL_ONLY) {
    console.log('Modelo ja encontrado; pull desnecessario.')
  }

  if (!PULL_ONLY && status.modelFound) {
    await runMinimalGeneration(status.selectedModel)
  }

  console.log('')
  console.log('Concluido. Para usar o provider local no bot:')
  console.log(`MINEGPT_AI_PROVIDER=ollama MINEGPT_AI_MODEL=${status.selectedModel || PRIMARY_MODEL} npm start`)
}

if (require.main === module) {
  setupLocalLlm().catch((error) => {
    console.error(`Falha inesperada no setup local: ${error.message}`)
    process.exit(1)
  })
}

module.exports = {
  setupLocalLlm
}
