function createNavigationSystem ({
  context,
  goals,
  reconnectBot
}) {
  function bot () {
    if (!context.bot) throw new Error('bot ainda nao inicializado')
    return context.bot
  }

  function resetPathfinderMovements (options = {}) {
    const current = bot()
    if (!context.defaultMovements) return
    context.defaultMovements.canDig = Boolean(options.allowDig)
    context.defaultMovements.allow1by1towers = Boolean(options.allowScaffold)
    context.defaultMovements.allowParkour = options.allowParkour !== false
    context.defaultMovements.scafoldingBlocks = options.allowScaffold
      ? [current.registry.itemsByName.dirt.id, current.registry.itemsByName.cobblestone.id]
      : []
    current.pathfinder.setMovements(context.defaultMovements)
  }

  function setTemporaryControls (controls, durationMs) {
    const current = bot()
    for (const control of controls) current.setControlState(control, true)

    return new Promise((resolve) => {
      setTimeout(() => {
        for (const control of controls) current.setControlState(control, false)
        resolve()
      }, durationMs)
    })
  }

  async function runUnstuckSequence () {
    const current = bot()
    current.clearControlStates()
    await setTemporaryControls(['jump'], 400)
    await setTemporaryControls(['back'], 500)
    await setTemporaryControls(['left'], 350)
    await setTemporaryControls(['right'], 700)
    await setTemporaryControls(['jump', 'back'], 500)
    current.clearControlStates()
  }

  function horizontalDistance (a, b) {
    const dx = a.x - b.x
    const dz = a.z - b.z
    return Math.sqrt(dx * dx + dz * dz)
  }

  function blockIsPassable (pos) {
    const block = bot().blockAt(pos)
    if (!block) return false
    return block.boundingBox === 'empty' || block.climbable
  }

  function blockIsStandable (pos) {
    const block = bot().blockAt(pos)
    if (!block) return false
    return block.boundingBox === 'block'
  }

  function getEscapeDirections () {
    const base = bot().entity.position.floored()
    const candidates = [
      { name: 'norte', yaw: Math.PI, dx: 0, dz: -1 },
      { name: 'sul', yaw: 0, dx: 0, dz: 1 },
      { name: 'oeste', yaw: Math.PI / 2, dx: -1, dz: 0 },
      { name: 'leste', yaw: -Math.PI / 2, dx: 1, dz: 0 }
    ]

    return candidates.filter((candidate) => {
      const foot = base.offset(candidate.dx, 0, candidate.dz)
      const head = base.offset(candidate.dx, 1, candidate.dz)
      const below = base.offset(candidate.dx, -1, candidate.dz)
      return blockIsPassable(foot) && blockIsPassable(head) && blockIsStandable(below)
    })
  }

  function createNavigationController () {
    const state = {
      intent: null,
      lastSample: null,
      lastProgressAt: Date.now(),
      recoveryAttempts: 0,
      recovering: false,
      locomotionBroken: false,
      recentDamageUntil: 0,
      lastDamageAt: 0,
      lastStopReason: 'inicial',
      options: {
        allowParkour: true,
        allowScaffold: false,
        allowDig: false
      }
    }

    function clearPathfinder () {
      const current = bot()
      current.pathfinder.stop()
      current.pathfinder.setGoal(null)
      current.clearControlStates()
    }

    function resetProgress () {
      state.lastSample = bot().entity?.position?.clone() || null
      state.lastProgressAt = Date.now()
    }

    function setIntent (intent) {
      state.intent = {
        ...intent,
        startedAt: Date.now()
      }
      state.recoveryAttempts = 0
      state.lastStopReason = 'navegando'
      resetProgress()
    }

    function stop (reason = 'parado') {
      clearPathfinder()
      state.intent = null
      state.lastSample = null
      state.recovering = false
      state.lastStopReason = reason
    }

    function applyMovements () {
      resetPathfinderMovements(state.options)
    }

    function setOption (name, value) {
      if (!(name in state.options)) return false
      state.options[name] = value
      applyMovements()
      return true
    }

    function setMode (mode) {
      if (mode === 'seguro') {
        state.options.allowParkour = true
        state.options.allowScaffold = false
        state.options.allowDig = false
        applyMovements()
        return true
      }

      if (mode === 'blocos') {
        state.options.allowParkour = true
        state.options.allowScaffold = true
        state.options.allowDig = false
        applyMovements()
        return true
      }

      if (mode === 'avancado') {
        state.options.allowParkour = true
        state.options.allowScaffold = true
        state.options.allowDig = true
        applyMovements()
        return true
      }

      return false
    }

    function followPlayer (username) {
      const current = bot()
      const target = current.players[username]?.entity
      if (!target) {
        current.chat(`Nao encontrei ${username} por perto.`)
        return
      }

      applyMovements()
      current.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      setIntent({ type: 'follow', username })
      current.chat(`Seguindo ${username}.`)
    }

    function comeHere (username) {
      const current = bot()
      const target = current.players[username]?.entity
      if (!target) {
        current.chat(`Nao encontrei ${username} por perto.`)
        return
      }

      applyMovements()
      current.pathfinder.setGoal(new goals.GoalNear(target.position.x, target.position.y, target.position.z, 1))
      setIntent({ type: 'come_here', username, target: target.position.clone() })
      current.chat('Indo ate voce.')
    }

    function goToCoords (coords) {
      const current = bot()
      applyMovements()
      current.pathfinder.setGoal(new goals.GoalBlock(coords.x, coords.y, coords.z))
      setIntent({ type: 'coords', target: coords })
      current.chat(`Indo para ${coords.x} ${coords.y} ${coords.z}.`)
    }

    async function escapeToFreeDirection () {
      const current = bot()
      const startPos = current.entity.position.clone()
      const directions = getEscapeDirections()

      if (directions.length === 0) {
        await runUnstuckSequence()
        return horizontalDistance(current.entity.position, startPos) > 0.35
      }

      for (const direction of directions) {
        await current.look(direction.yaw, 0)
        await setTemporaryControls(['forward', 'jump'], 600)
        if (horizontalDistance(current.entity.position, startPos) > 0.45) return true
      }

      return false
    }

    async function recover (manual = false) {
      if (state.recovering) return
      state.recovering = true
      state.recoveryAttempts += 1
      clearPathfinder()

      const escaped = await escapeToFreeDirection()

      bot().clearControlStates()
      state.recovering = false
      resetProgress()

      if (manual) {
        bot().chat(escaped ? 'Tentei sair usando espaco livre ao redor.' : 'Nao achei saida local.')
        return
      }

      if (state.recoveryAttempts >= 3) {
        stop('travado')
        bot().chat('Nao consegui me destravar. Preciso de ajuda ou novo comando.')
      } else if (escaped) {
        bot().chat('Detectei travamento e tentei liberar movimento.')
      } else {
        bot().chat('Nao consegui achar saida local.')
      }
    }

    function describe () {
      const current = bot()
      const intent = state.intent ? state.intent.type : 'nenhuma'
      const moving = current.pathfinder.isMoving() ? 'sim' : 'nao'
      const recovering = state.recovering ? 'sim' : 'nao'
      const broken = state.locomotionBroken ? 'sim' : 'nao'
      const stuckFor = Math.round((Date.now() - state.lastProgressAt) / 1000)
      const parkour = state.options.allowParkour ? 'on' : 'off'
      const blocos = state.options.allowScaffold ? 'on' : 'off'
      const quebrar = state.options.allowDig ? 'on' : 'off'
      return `nav intent=${intent} moving=${moving} recovering=${recovering} quebrada=${broken} tentativas=${state.recoveryAttempts} sem_progresso=${stuckFor}s parkour=${parkour} blocos=${blocos} quebrar=${quebrar} ultimo=${state.lastStopReason}`
    }

    function followTargetIsClose () {
      if (state.intent?.type !== 'follow') return false
      const target = bot().players[state.intent.username]?.entity
      if (!target) return false
      return bot().entity.position.distanceTo(target.position) <= 3.2
    }

    function tick () {
      const current = bot()
      if (!current.entity || !state.intent || state.recovering) return
      if (Date.now() < state.recentDamageUntil) return

      if (followTargetIsClose()) {
        resetProgress()
        return
      }

      const pos = current.entity.position
      if (!state.lastSample) {
        resetProgress()
        return
      }

      if (horizontalDistance(pos, state.lastSample) > 0.7) {
        resetProgress()
        return
      }

      const noProgressFor = Date.now() - state.lastProgressAt
      if (noProgressFor > 5000) {
        recover(false).catch((err) => {
          state.recovering = false
          console.error('Erro ao recuperar navegacao:', err)
        })
      }
    }

    function handleDamage () {
      const now = Date.now()
      if (now - state.lastDamageAt < 500) return

      state.lastDamageAt = now
      state.recentDamageUntil = now + 2000
      state.locomotionBroken = true
      state.lastStopReason = 'dano'
      clearPathfinder()
      resetProgress()
      state.recovering = false

      bot().chat('Tomei dano. Vou reconectar para evitar desync de posicao.')
      reconnectBot('dano recebido')
    }

    function onGoalReached () {
      state.intent = null
      state.lastSample = null
      state.lastStopReason = 'chegou'
    }

    function resetAfterDeath (reason) {
      stop(reason)
      applyMovements()
    }

    return {
      followPlayer,
      comeHere,
      goToCoords,
      stop,
      recover,
      describe,
      setMode,
      setOption,
      tick,
      handleDamage,
      onGoalReached,
      resetAfterDeath,
      applyMovements
    }
  }

  return {
    createNavigationController,
    getEscapeDirections,
    setTemporaryControls
  }
}

module.exports = {
  createNavigationSystem
}
