function createBotRuntime ({
  context,
  mineflayer,
  pathfinder,
  Movements,
  config,
  ownerMatches,
  createNavigationController,
  handleCommand,
  refreshPerceptionCache,
  survivalGuard,
  runAutoDropCollection
}) {
  let tickTimer = null

  function reconnectBot (reason) {
    if (context.reconnecting) return
    context.reconnecting = true
    console.log(`Reconectando bot: ${reason}`)

    const oldBot = context.bot
    context.navigationController?.stop(`reconectando: ${reason}`)

    setTimeout(() => {
      createBotInstance()
      context.reconnecting = false
    }, 1500)

    if (oldBot) {
      oldBot.end()
    }
  }

  function registerBotEvents () {
    const bot = context.bot

    bot.once('spawn', () => {
      context.defaultMovements = new Movements(bot)
      context.navigationController = createNavigationController()
      context.navigationController.applyMovements()
      context.previousHealth = bot.health ?? context.previousHealth
      refreshPerceptionCache(true)
      bot.chat('Online. Digite ajuda no chat.')
      console.log('Bot entrou no mundo com sucesso.')
    })

    bot.on('chat', (username, message) => {
      if (username === bot.username) return
      if (!ownerMatches(username)) return

      console.log(`[chat] ${username}: ${message}`)
      handleCommand(username, message).catch((err) => {
        console.error('Erro ao executar comando:', err)
        bot.chat(`Erro no comando: ${err.message}`)
      })
    })

    bot.on('goal_reached', () => {
      if (context.activeSkill || context.collection.collectionState.autoDropsBusy) return
      context.navigationController?.onGoalReached()
      bot.chat('Cheguei.')
    })

    bot.on('health', () => {
      if (context.previousHealth != null && bot.health < context.previousHealth) {
        context.navigationController?.handleDamage()
      }

      context.previousHealth = bot.health
    })

    bot.on('entityHurt', (entity) => {
      if (entity === bot.entity) {
        context.navigationController?.handleDamage()
      }
    })

    bot.on('death', () => {
      context.navigationController?.resetAfterDeath('morreu')
      console.log('Bot morreu. Movimento resetado.')
    })

    bot.on('respawn', () => {
      context.navigationController?.resetAfterDeath('renasceu')
      context.previousHealth = null
      console.log('Bot renasceu. Movimento resetado.')
    })

    bot.on('forcedMove', () => {
      console.log('Servidor corrigiu a posicao do bot.')
    })

    bot.on('path_reset', (reason) => {
      console.log('Pathfinder resetou caminho:', reason)
    })

    bot.on('kicked', (reason) => {
      console.error('Bot foi expulso do servidor:', reason)
    })

    bot.on('error', (err) => {
      console.error('Erro no bot:', err)
    })

    bot.on('end', () => {
      console.log('Conexao encerrada.')
    })
  }

  function createBotInstance () {
    context.bot = mineflayer.createBot({
      host: config.host,
      port: config.port,
      version: config.version,
      username: config.username,
      auth: config.auth
    })

    context.bot.loadPlugin(pathfinder)
    context.defaultMovements = null
    context.navigationController = null
    context.previousHealth = null
    registerBotEvents()
  }

  function startTickLoop () {
    if (tickTimer) return
    tickTimer = setInterval(() => {
      if (!context.navigationController) return
      refreshPerceptionCache(false)
      context.navigationController.tick()
      survivalGuard.tick()
      runAutoDropCollection()
    }, 1000)
  }

  function start () {
    startTickLoop()
    createBotInstance()
  }

  return {
    start,
    reconnectBot,
    createBotInstance
  }
}

module.exports = {
  createBotRuntime
}
