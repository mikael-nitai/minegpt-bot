function createStateReporter ({
  getBot,
  config,
  inventory,
  perception,
  survival,
  collectionState,
  getActiveSkill,
  getNavigationController,
  getReconnecting,
  getContainers = null
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
      distance: Number.isFinite(token.distance) ? Math.round(token.distance * 10) / 10 : null,
      position: positionSnapshot(token.position),
      heads: token.heads
        ? {
            danger: token.heads.danger || 0,
            resource: token.heads.resource || 0,
            navigation: token.heads.navigation || 0,
            objective: token.heads.objective || 0,
            opportunity: token.heads.opportunity || 0
          }
        : undefined,
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
    const containerState = getContainers?.()?.getStateSnapshot?.() || null

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
      recentCollections: collectionState.recent.slice(0, 5),
      containers: containerState
    }
  }

  function compactInventoryObjects (limit = 16) {
    return inventory.summarizeInventory()
      .slice(0, limit)
      .map((entry) => {
        const match = entry.match(/^(\d+)x\s+(.+)$/)
        if (!match) return { name: entry, count: null }
        return { name: match[2], count: Number(match[1]) }
      })
  }

  function inventoryFocus (items) {
    const isTool = name => /_(pickaxe|axe|shovel|hoe|sword)$/.test(name)
    const isFood = name => /bread|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|cookie|melon|berries/.test(name)
    const isBasicBlock = name => /dirt|cobblestone|stone|deepslate|planks|log|sand|gravel/.test(name)
    const isResource = name => /coal|iron|gold|copper|diamond|emerald|redstone|lapis|quartz|ingot|ore|raw_/.test(name)

    return {
      tools: items.filter(item => isTool(item.name)).slice(0, 6),
      food: items.filter(item => isFood(item.name)).slice(0, 6),
      basicBlocks: items.filter(item => isBasicBlock(item.name)).slice(0, 6),
      resources: items.filter(item => isResource(item.name)).slice(0, 8),
      hasFreeSlot: typeof inventory.inventoryHasFreeSlot === 'function' ? inventory.inventoryHasFreeSlot() : null
    }
  }

  function compactContainers (containerState, containerTokens) {
    if (!containerState && containerTokens.length === 0) return null

    return {
      known: containerState?.knownCount ?? null,
      recentlyScanned: containerState?.lastScanAgeMs != null ? containerState.lastScanAgeMs < 300000 : null,
      topRoles: (containerState?.roles || []).slice(0, 8),
      nearby: compactTokens(containerTokens, 5),
      importantKnownItems: (containerState?.knownItems || containerState?.items || []).slice?.(0, 10) || []
    }
  }

  function collectAllowedActions (tokens) {
    const collectTargets = new Set()
    const collectCategories = new Set()

    for (const token of tokens) {
      if (!token || (token.kind !== 'block' && token.kind !== 'block_group')) continue
      if (token.category === 'liquid_pool' || token.category === 'hazard_group') continue

      for (const blockName of token.blockNames || []) {
        if (typeof blockName === 'string' && blockName) collectTargets.add(blockName)
      }

      if (typeof token.name === 'string' && token.name && !/^arvore_/.test(token.name)) {
        collectTargets.add(token.name)
      }

      if (token.category === 'tree') collectCategories.add('wood')
      if (token.category === 'ore_vein') collectCategories.add('ore')
      if (token.category === 'stone_group') collectCategories.add('stone')
    }

    return {
      collectTargets: [...collectTargets].sort().slice(0, 24),
      collectCategories: [...collectCategories].sort().slice(0, 12)
    }
  }

  function getPlannerSnapshot () {
    const bot = getBot()
    const activeSkill = getActiveSkill()?.name || null
    const reconnecting = Boolean(getReconnecting())

    if (!bot?.entity) {
      return {
        online: false,
        username: config.username,
        owner: config.owner,
        canAct: false,
        busy: Boolean(activeSkill),
        reconnecting,
        activeSkill
      }
    }

    const tokens = perception.getWorldTokens()
    const survivalStatus = survival.assess()
    const containerState = getContainers?.()?.getStateSnapshot?.() || null
    const hazards = tokens.filter(token => token.heads?.danger >= 35)
    const drops = tokens.filter(token => token.kind === 'drop' || token.kind === 'dropped_item' || /drop|item/.test(token.category || ''))
    const containerTokens = tokens.filter(token => token.kind === 'container' || /container|chest|barrel|shulker/.test(token.category || ''))
    const inventoryItems = compactInventoryObjects(24)
    const allowedActions = collectAllowedActions(tokens)
    const timestamp = Date.now()

    return {
      online: true,
      username: bot.username,
      owner: config.owner,
      timestamp,
      canAct: !reconnecting && !activeSkill && survivalStatus.severity !== 'critical',
      busy: Boolean(activeSkill),
      reconnecting,
      activeSkill,
      health: bot.health,
      food: bot.food,
      saturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
      oxygen: bot.oxygenLevel ?? null,
      position: positionSnapshot(bot.entity.position),
      vitals: {
        health: bot.health,
        food: bot.food,
        saturation: Math.round((bot.foodSaturation || 0) * 10) / 10,
        oxygen: bot.oxygenLevel ?? null,
        position: positionSnapshot(bot.entity.position)
      },
      heldItem: bot.heldItem ? { name: bot.heldItem.name, count: bot.heldItem.count } : null,
      inventory: {
        items: inventoryItems.slice(0, 16),
        totalKinds: inventoryItems.length,
        focus: inventoryFocus(inventoryItems)
      },
      objective: perception.perceptionState.objective,
      perception: {
        topAttention: compactTokens(tokens, 6),
        hazards: compactTokens(hazards, 4),
        resources: compactTokens(tokens.filter(token => token.heads?.resource >= 35 || token.heads?.opportunity >= 55), 6),
        drops: compactTokens(drops, 5),
        containers: compactTokens(containerTokens, 5)
      },
      survival: {
        enabled: survival.state.enabled,
        severity: survivalStatus.severity,
        top: survivalStatus.top,
        summary: survivalStatus.summary,
        safeToAct: survivalStatus.severity !== 'critical' && survivalStatus.severity !== 'high'
      },
      navigation: {
        summary: getNavigationController()?.describe() || 'sem navigation controller'
      },
      containers: compactContainers(containerState, containerTokens),
      allowedActions,
      recentCollections: collectionState.recent.slice(0, 3)
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
    const state = getPlannerSnapshot()
    return JSON.stringify(state)
  }

  function describePlannerSnapshot () {
    return describeForPlanner()
  }

  return {
    getStateSnapshot,
    getPlannerSnapshot,
    describeForChat,
    describeForPlanner,
    describePlannerSnapshot
  }
}

module.exports = {
  createStateReporter
}
