function createStateReporter ({
  getBot,
  config,
  inventory,
  perception,
  survival,
  collectionState,
  getActiveSkill,
  getNavigationController,
  getReconnecting
}) {
  function positionSnapshot (position) {
    if (!position) return null
    return {
      x: Math.round(position.x * 10) / 10,
      y: Math.round(position.y * 10) / 10,
      z: Math.round(position.z * 10) / 10
    }
  }

  function compactTokens (tokens, limit = 8) {
    return tokens.slice(0, limit).map(token => ({
      kind: token.kind,
      name: token.name,
      category: token.category,
      score: token.score,
      distance: Math.round(token.distance * 10) / 10,
      position: token.position,
      actionHint: token.recommendedAction || null
    }))
  }

  function getStateSnapshot () {
    const bot = getBot()
    if (!bot?.entity) {
      return {
        online: false,
        username: config.username,
        reconnecting: Boolean(getReconnecting()),
        activeSkill: getActiveSkill()?.name || null
      }
    }

    const tokens = perception.getWorldTokens()
    const survivalStatus = survival.assess()

    return {
      online: true,
      username: bot.username,
      owner: config.owner,
      reconnecting: Boolean(getReconnecting()),
      health: bot.health,
      food: bot.food,
      saturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
      oxygen: bot.oxygenLevel ?? null,
      position: positionSnapshot(bot.entity.position),
      heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
      inventory: inventory.summarizeInventory().slice(0, 20),
      objective: perception.perceptionState.objective,
      perception: {
        cache: perception.describePerceptionCache(),
        topAttention: compactTokens(tokens, 8),
        hazards: compactTokens(tokens.filter(token => token.heads?.danger >= 35), 6),
        resources: compactTokens(tokens.filter(token => token.heads?.resource >= 35 || token.heads?.opportunity >= 55), 6)
      },
      survival: {
        enabled: survival.state.enabled,
        severity: survivalStatus.severity,
        top: survivalStatus.top,
        summary: survivalStatus.summary
      },
      navigation: getNavigationController()?.describe() || 'sem navigation controller',
      activeSkill: getActiveSkill()?.name || null,
      recentCollections: collectionState.recent.slice(0, 5)
    }
  }

  function describeForChat () {
    const state = getStateSnapshot()
    if (!state.online) return `Estado: offline reconnecting=${state.reconnecting}`

    const pos = state.position
    const held = state.heldItem ? `${state.heldItem.count}x ${state.heldItem.name}` : 'mao vazia'
    const topAttention = state.perception.topAttention.slice(0, 3).map(token => `${token.name}/${token.category}:${token.score}`).join(', ') || 'nada'
    return [
      `Estado: vida=${state.health}/20 fome=${state.food}/20 pos=${pos.x} ${pos.y} ${pos.z}`,
      `mao=${held}`,
      `skill=${state.activeSkill || 'nenhuma'}`,
      `objetivo=${state.objective}`,
      `survival=${state.survival.severity}`,
      `top=${topAttention}`
    ].join(' | ')
  }

  function describeForPlanner () {
    const state = getStateSnapshot()
    return JSON.stringify(state)
  }

  return {
    getStateSnapshot,
    describeForChat,
    describeForPlanner
  }
}

module.exports = {
  createStateReporter
}
