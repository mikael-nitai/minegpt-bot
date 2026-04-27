function createSurvivalGuard ({
  getBot,
  owner,
  perception,
  inventory,
  getNavigationController,
  getActiveSkill,
  cancelActiveSkill,
  getReconnecting
}) {
  const state = {
    enabled: false,
    previousObjective: null,
    lastStatus: null,
    lastAlertAt: 0,
    lastAskAt: 0,
    lastInterventionAt: 0,
    lastEatAt: 0,
    lastReactAt: 0,
    eating: false,
    reacting: false
  }

  const HELP_COOLDOWN_MS = 30000
  const ALERT_COOLDOWN_MS = 12000
  const INTERVENTION_COOLDOWN_MS = 5000
  const EAT_COOLDOWN_MS = 2500
  const REACTION_COOLDOWN_MS = 1800

  const mobProfiles = {
    zombie: { posture: 'hostile', style: 'melee', base: 55, close: 82, canFightLater: true },
    husk: { posture: 'hostile', style: 'melee', base: 58, close: 84, canFightLater: true },
    drowned: { posture: 'hostile', style: 'melee_water', base: 60, close: 86, canFightLater: true },
    skeleton: { posture: 'hostile', style: 'ranged_los', base: 68, close: 90, canFightLater: false },
    stray: { posture: 'hostile', style: 'ranged_los', base: 72, close: 92, canFightLater: false },
    pillager: { posture: 'hostile', style: 'ranged_los', base: 70, close: 90, canFightLater: false },
    creeper: { posture: 'hostile', style: 'explosive', base: 85, close: 100, canFightLater: false },
    spider: { posture: 'conditional', style: 'spider', base: 35, close: 75, canFightLater: true },
    cave_spider: { posture: 'hostile', style: 'poison_melee', base: 78, close: 95, canFightLater: false },
    enderman: { posture: 'neutral', style: 'avoid_eye_contact', base: 25, close: 55, canFightLater: false },
    zombified_piglin: { posture: 'neutral', style: 'pack_neutral', base: 15, close: 45, canFightLater: false },
    piglin: { posture: 'conditional', style: 'conditional_neutral', base: 45, close: 75, canFightLater: false },
    witch: { posture: 'hostile', style: 'magic_ranged', base: 85, close: 95, canFightLater: false },
    slime: { posture: 'hostile', style: 'size_melee', base: 35, close: 65, canFightLater: true },
    magma_cube: { posture: 'hostile', style: 'fire_size_melee', base: 60, close: 82, canFightLater: false },
    phantom: { posture: 'hostile', style: 'flying', base: 70, close: 88, canFightLater: false },
    blaze: { posture: 'hostile', style: 'fire_ranged', base: 85, close: 95, canFightLater: false },
    ghast: { posture: 'hostile', style: 'explosive_ranged', base: 80, close: 90, canFightLater: false },
    warden: { posture: 'hostile', style: 'extreme', base: 100, close: 100, canFightLater: false },
    vindicator: { posture: 'hostile', style: 'strong_melee', base: 80, close: 95, canFightLater: false },
    evoker: { posture: 'hostile', style: 'magic_ranged', base: 90, close: 98, canFightLater: false },
    ravager: { posture: 'hostile', style: 'brute', base: 95, close: 100, canFightLater: false },
    silverfish: { posture: 'hostile', style: 'small_melee', base: 35, close: 65, canFightLater: true },
    endermite: { posture: 'hostile', style: 'small_melee', base: 35, close: 65, canFightLater: true },
    guardian: { posture: 'hostile', style: 'aquatic_ranged', base: 75, close: 88, canFightLater: false },
    elder_guardian: { posture: 'hostile', style: 'aquatic_boss', base: 95, close: 100, canFightLater: false }
  }

  function bot () {
    const current = getBot()
    if (!current) throw new Error('bot ainda nao inicializado')
    return current
  }

  function risk (type, severity, source, reason, recommendedAction, extra = {}) {
    return {
      type,
      severity: Math.max(0, Math.min(100, Math.round(severity))),
      urgency: Math.max(0, Math.min(100, Math.round(extra.urgency ?? severity))),
      source,
      reason,
      recommendedAction,
      ...extra
    }
  }

  function topRisk (risks) {
    return [...risks].sort((a, b) => b.severity - a.severity || b.urgency - a.urgency)[0] || null
  }

  function hasFood () {
    return inventory.findInventoryItems('comida').length > 0
  }

  function foodScore (item) {
    const name = item.name
    if (name.includes('golden')) return 100
    if (name.includes('cooked') || name === 'bread' || name === 'baked_potato') return 80
    if (name.includes('stew') || name.includes('soup')) return 70
    if (name.includes('apple') || name.includes('carrot')) return 60
    if (name.includes('raw') || name.includes('rotten') || name.includes('spider_eye')) return 20
    return 50
  }

  function chooseFoodItem () {
    return inventory.findInventoryItems('comida')
      .filter(item => !item.name.includes('rotten') && item.name !== 'spider_eye' && item.name !== 'poisonous_potato')
      .sort((a, b) => foodScore(b) - foodScore(a) || b.count - a.count || a.name.localeCompare(b.name))[0] || null
  }

  function hasWeapon () {
    return inventory.findInventoryItems('espada').length > 0 || inventory.findInventoryItems('machado').length > 0
  }

  function firstInventoryItemByNames (names) {
    for (const name of names) {
      const item = inventory.findInventoryItem(name)
      if (item) return item
    }
    return null
  }

  function hasAmmo () {
    return Boolean(firstInventoryItemByNames(['arrow', 'spectral_arrow', 'tipped_arrow']))
  }

  function hasRangedWeapon () {
    return Boolean(firstInventoryItemByNames(['bow', 'crossbow']))
  }

  function bestRangedWeapon () {
    return firstInventoryItemByNames(['bow', 'crossbow'])
  }

  function bestMeleeWeapon () {
    return firstInventoryItemByNames([
      'netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword',
      'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe',
      'trident', 'mace'
    ])
  }

  function shieldItem () {
    return firstInventoryItemByNames(['shield'])
  }

  function assessNeeds () {
    const current = bot()
    const risks = []

    if (current.health <= 6) {
      risks.push(risk(
        'needs',
        hasFood() ? 78 : 88,
        'health',
        `vida baixa (${current.health}/20)`,
        hasFood() ? 'eat' : 'ask_help'
      ))
    } else if (current.health <= 10) {
      risks.push(risk('needs', 55, 'health', `vida moderada (${current.health}/20)`, hasFood() ? 'eat' : 'watch'))
    }

    if (current.food <= 6) {
      risks.push(risk(
        'needs',
        hasFood() ? 70 : 82,
        'hunger',
        `fome baixa (${current.food}/20)`,
        hasFood() ? 'eat' : 'ask_help'
      ))
    } else if (current.food <= 10) {
      risks.push(risk('needs', 45, 'hunger', `fome moderada (${current.food}/20)`, hasFood() ? 'eat' : 'watch'))
    }

    if (!hasWeapon()) {
      risks.push(risk('needs', 30, 'weapon', 'sem arma dedicada no inventario', 'watch'))
    }

    if (hasRangedWeapon() && !hasAmmo()) {
      risks.push(risk('needs', 35, 'arrows', 'arma a distancia sem flechas', 'ask_help'))
    }

    return risks
  }

  function tokenForEntity (entity, tokens) {
    return tokens.find(token => token.kind === 'entity' && token.name === (entity.name || entity.type))
  }

  function spiderLikelyNeutral (entity) {
    const current = bot()
    const isDay = current.time?.isDay !== false
    const nearSurface = entity.position.y >= 55
    return isDay && nearSurface
  }

  function assessMobEntity (entity, tokens) {
    if (!entity.position || entity === bot().entity) return null
    const name = entity.name || entity.type
    const profile = mobProfiles[name]
    if (!profile) return null

    const current = bot()
    const distance = current.entity.position.distanceTo(entity.position)
    if (distance > 18) return null

    if (name === 'spider' && spiderLikelyNeutral(entity)) {
      return risk('mob', distance <= 4 ? 35 : 15, name, 'aranha provavelmente neutra de dia', 'watch', { distance })
    }

    if (profile.posture === 'neutral') {
      return risk(
        'mob',
        distance <= 4 ? profile.close : profile.base,
        name,
        `${name} neutro: evitar provocar`,
        name === 'enderman' ? 'avoid_eye_contact' : 'avoid',
        { distance }
      )
    }

    const perceived = tokenForEntity(entity, tokens)
    const perceivedDanger = perceived?.heads?.danger || 0
    let severity = distance <= 4 ? profile.close : profile.base

    if (profile.style.includes('ranged') && perceivedDanger >= 80) severity = Math.max(severity, 88)
    if (profile.style === 'explosive' && distance <= 6) severity = 100
    if (profile.style === 'extreme') severity = 100
    if (distance > 12) severity -= 20
    if (hasWeapon() && profile.canFightLater && current.health >= 16 && current.food >= 12) severity -= 18

    const action = severity >= 85 ? 'flee' : severity >= 65 ? 'avoid' : 'watch'
    return risk('mob', severity, name, `${name} a ${distance.toFixed(1)} blocos`, action, { distance })
  }

  function nearestBreathableAirEstimate () {
    const current = bot()
    const base = current.entity.position.floored()
    let best = null

    for (let radius = 0; radius <= 8; radius++) {
      for (let y = -1; y <= 12; y++) {
        for (let x = -radius; x <= radius; x++) {
          for (let z = -radius; z <= radius; z++) {
            if (Math.max(Math.abs(x), Math.abs(z)) !== radius) continue
            const pos = base.offset(x, y, z)
            const block = current.blockAt(pos)
            if (!block || block.name === 'water' || block.name === 'lava' || block.boundingBox === 'block') continue

            const distance = current.entity.position.distanceTo(pos)
            const estimateSeconds = distance / 3.8 + Math.max(0, pos.y - current.entity.position.y) * 0.25
            if (!best || estimateSeconds < best.estimateSeconds) {
              best = { position: { x: pos.x, y: pos.y, z: pos.z }, distance, estimateSeconds }
            }
          }
        }
      }
      if (best) return best
    }

    return null
  }

  function assessEnvironment () {
    const current = bot()
    const tokens = perception.getWorldTokens()
    const risks = []

    for (const token of tokens) {
      if (token.category === 'liquid_pool' && token.name === 'lava' && token.exposedFaces > 0 && token.distance <= 5) {
        risks.push(risk('environment', token.distance <= 2.5 ? 96 : 75, 'lava', 'lava exposta perto', 'avoid', { distance: token.distance }))
      }

      if (token.category === 'hazard_group' && token.distance <= 4) {
        risks.push(risk('environment', token.distance <= 2 ? 82 : 62, token.name, `${token.name} perto`, 'avoid', { distance: token.distance }))
      }

      if (token.category === 'fall_risk' && token.distance <= 2.5) {
        risks.push(risk('environment', token.distance <= 1.5 ? 80 : 58, 'fall', 'risco de queda perto', 'avoid', { distance: token.distance }))
      }
    }

    const feet = current.blockAt(current.entity.position.floored())
    const head = current.blockAt(current.entity.position.floored().offset(0, 1, 0))
    const underwater = feet?.name === 'water' && head?.name === 'water'
    if (underwater) {
      const oxygen = current.oxygenLevel ?? 20
      const oxygenSeconds = oxygen * 0.75
      const air = nearestBreathableAirEstimate()
      const required = air ? air.estimateSeconds : Infinity
      const severity = oxygenSeconds <= required + 2 ? 95 : oxygen <= 8 ? 82 : 45
      risks.push(risk(
        'environment',
        severity,
        'drowning',
        air
          ? `submerso: ar em ~${required.toFixed(1)}s, oxigenio ~${oxygenSeconds.toFixed(1)}s`
          : `submerso: nao achei ar proximo, oxigenio ~${oxygenSeconds.toFixed(1)}s`,
        severity >= 80 ? 'surface' : 'watch',
        { oxygen, oxygenSeconds, requiredSeconds: required, air }
      ))
    }

    return risks
  }

  function assessMobs () {
    const tokens = perception.getWorldTokens()
    return Object.values(bot().entities)
      .map(entity => assessMobEntity(entity, tokens))
      .filter(Boolean)
  }

  function assess () {
    if (!getBot()?.entity) {
      return { enabled: state.enabled, severity: 0, risks: [], needs: [], top: null, summary: 'Survival: bot nao inicializado.' }
    }

    const needs = assessNeeds()
    const environment = assessEnvironment()
    const mobs = assessMobs()
    const risks = [...needs, ...environment, ...mobs].sort((a, b) => b.severity - a.severity || b.urgency - a.urgency)
    const top = topRisk(risks)

    return {
      enabled: state.enabled,
      severity: top?.severity || 0,
      risks,
      needs,
      environment,
      mobs,
      top,
      summary: describeStatusFromRisks(risks)
    }
  }

  function describeRisk (entry) {
    return `${entry.source}:${entry.severity} ${entry.recommendedAction} (${entry.reason})`
  }

  function describeStatusFromRisks (risks) {
    if (risks.length === 0) return `Survival ${state.enabled ? 'on' : 'off'}: nenhum risco relevante.`
    const top = risks.slice(0, 5).map(describeRisk).join(' | ')
    return `Survival ${state.enabled ? 'on' : 'off'}: ${top}`
  }

  function describeStatus () {
    const status = assess()
    state.lastStatus = status
    return status.summary
  }

  function describeDebug () {
    const status = assess()
    state.lastStatus = status
    const objective = perception.perceptionState.objective
    const active = getActiveSkill()?.name || 'nenhuma'
    const reconnecting = getReconnecting() ? 'sim' : 'nao'
    return `${status.summary} | objetivo=${objective} skill=${active} reconectando=${reconnecting}`
  }

  function withTimeout (promise, durationMs, label) {
    let timeout
    const timeoutPromise = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(durationMs / 1000)}s`)), durationMs)
    })

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout))
  }

  function canEatNow (status) {
    if (!state.enabled || state.eating || getReconnecting()) return false
    const current = bot()
    if (current.food >= 20) return false
    if (Date.now() - state.lastEatAt < EAT_COOLDOWN_MS) return false
    if (!status.risks.some(entry => entry.recommendedAction === 'eat')) return false

    const criticalThreat = status.risks.find(entry =>
      entry.severity >= 90 &&
      (entry.type === 'mob' || entry.type === 'environment') &&
      entry.recommendedAction !== 'surface'
    )
    if (criticalThreat) return false

    return Boolean(chooseFoodItem())
  }

  async function eatIfNeeded (status = assess()) {
    if (!canEatNow(status)) return false

    const current = bot()
    const food = chooseFoodItem()
    if (!food) return false

    state.eating = true
    state.lastEatAt = Date.now()

    try {
      if (getActiveSkill()) cancelActiveSkill()
      getNavigationController()?.stop('survival: comer')
      current.pathfinder.stop()
      current.clearControlStates()

      if (current.heldItem?.name !== food.name) {
        await withTimeout(current.equip(food, 'hand'), 3000, `equipar comida ${food.name}`)
      }

      await withTimeout(current.consume(), 5000, `comer ${food.name}`)
      current.chat(`Survival: comi ${food.name}.`)
      return true
    } catch (err) {
      console.error('Erro ao comer automaticamente:', err)
      current.chat(`Survival: nao consegui comer (${err.message}).`)
      return false
    } finally {
      current.clearControlStates()
      state.eating = false
    }
  }

  function askForHelp (status = assess()) {
    const now = Date.now()
    if (now - state.lastAskAt < HELP_COOLDOWN_MS) return false

    const current = bot()
    const top = status.top
    let message = `${owner}, nao consigo continuar essa tarefa com seguranca.`

    if (status.risks.some(entry => entry.source === 'hunger' && entry.recommendedAction === 'ask_help')) {
      message = `${owner}, preciso de comida.`
    } else if (status.risks.some(entry => entry.source === 'health' && entry.recommendedAction === 'ask_help')) {
      message = `${owner}, estou em perigo e preciso de ajuda.`
    } else if (status.risks.some(entry => entry.source === 'arrows' && entry.recommendedAction === 'ask_help')) {
      message = `${owner}, preciso de flechas.`
    } else if (top?.severity >= 85) {
      message = `${owner}, estou em perigo e preciso de ajuda.`
    } else if (current.inventory.emptySlotCount?.() === 0) {
      message = `${owner}, meu inventario esta cheio.`
    }

    current.chat(message)
    state.lastAskAt = now
    return true
  }

  function findEntityForRisk (entry) {
    if (!entry || entry.type !== 'mob') return null
    return Object.values(bot().entities)
      .filter(entity => entity.position)
      .filter(entity => (entity.name || entity.type) === entry.source)
      .sort((a, b) => bot().entity.position.distanceTo(a.position) - bot().entity.position.distanceTo(b.position))[0] || null
  }

  function yawAwayFrom (targetPosition) {
    const current = bot()
    const dx = targetPosition.x - current.entity.position.x
    const dz = targetPosition.z - current.entity.position.z
    return Math.atan2(-dx, -dz)
  }

  async function equipShieldIfUseful (entry) {
    if (!entry || entry.type !== 'mob') return false
    if (!['skeleton', 'stray', 'pillager', 'creeper', 'blaze'].includes(entry.source)) return false

    const current = bot()
    const shield = shieldItem()
    if (!shield) return false

    try {
      await withTimeout(current.equip(shield, 'off-hand'), 2500, 'equipar escudo')
      current.activateItem(true)
      setTimeout(() => {
        try {
          current.deactivateItem()
        } catch {}
      }, 1200)
      return true
    } catch (err) {
      console.error('Erro ao usar escudo:', err)
      return false
    }
  }

  async function avoidEyeContact (entry) {
    if (entry?.source !== 'enderman') return false
    const entity = findEntityForRisk(entry)
    if (!entity) return false

    await bot().look(yawAwayFrom(entity.position), 0.45, true).catch(() => {})
    return true
  }

  async function surfaceIfNeeded (entry) {
    if (entry?.recommendedAction !== 'surface' || !entry.air?.position) return false
    const current = bot()

    getNavigationController()?.stop('survival: subir para ar')
    current.pathfinder.stop()
    current.clearControlStates()

    if (entry.air.position.y >= current.entity.position.y) {
      current.setControlState('jump', true)
      current.setControlState('forward', true)
      setTimeout(() => {
        current.setControlState('jump', false)
        current.setControlState('forward', false)
      }, 1000)
      return true
    }

    return false
  }

  async function shortAvoidanceMove (entry) {
    const current = bot()
    const entity = findEntityForRisk(entry)

    getNavigationController()?.stop(`survival: evitar ${entry.source}`)
    current.pathfinder.stop()
    current.clearControlStates()

    if (entity) {
      await current.look(yawAwayFrom(entity.position), 0, true).catch(() => {})
    }

    await equipShieldIfUseful(entry)
    current.setControlState(entity ? 'forward' : 'back', true)
    current.setControlState('sprint', true)
    if (entry.recommendedAction === 'flee') current.setControlState('jump', true)

    setTimeout(() => {
      current.setControlState('forward', false)
      current.setControlState('back', false)
      current.setControlState('sprint', false)
      current.setControlState('jump', false)
    }, entry.recommendedAction === 'flee' ? 1100 : 650)

    return true
  }

  function canMeleeSafely (entry) {
    if (!entry || entry.type !== 'mob') return false
    if (!['zombie', 'husk', 'spider', 'silverfish', 'endermite', 'slime'].includes(entry.source)) return false
    if (entry.severity >= 72) return false
    const current = bot()
    if (current.health < 16 || current.food < 12) return false
    if (!bestMeleeWeapon()) return false

    const nearbyHostiles = Object.values(current.entities)
      .filter(entity => entity.position && mobProfiles[entity.name || entity.type])
      .filter(entity => current.entity.position.distanceTo(entity.position) <= 7)
    return nearbyHostiles.length <= 1
  }

  async function meleeIfSafe (entry) {
    if (!canMeleeSafely(entry)) return false
    const current = bot()
    const entity = findEntityForRisk(entry)
    const weapon = bestMeleeWeapon()
    if (!entity || !weapon || current.entity.position.distanceTo(entity.position) > 3.3) return false

    try {
      getNavigationController()?.stop(`survival: combate ${entry.source}`)
      current.pathfinder.stop()
      current.clearControlStates()

      if (current.heldItem?.name !== weapon.name) {
        await withTimeout(current.equip(weapon, 'hand'), 2500, `equipar ${weapon.name}`)
      }

      await current.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.55 : 0.8, 0), true).catch(() => {})

      if (current.entity.onGround) {
        current.setControlState('jump', true)
        setTimeout(() => current.setControlState('jump', false), 180)
        await new Promise(resolve => setTimeout(resolve, 220))
      }

      current.attack(entity, true)
      return true
    } catch (err) {
      console.error('Erro no combate defensivo:', err)
      return false
    }
  }

  function wait (durationMs) {
    return new Promise(resolve => setTimeout(resolve, durationMs))
  }

  function canShootSafely (entry) {
    if (!entry || entry.type !== 'mob') return false
    if (!['creeper', 'skeleton', 'stray', 'pillager', 'zombie', 'husk', 'spider'].includes(entry.source)) return false
    if (!hasAmmo()) return false
    if (!bestRangedWeapon()) return false

    const current = bot()
    if (current.health < 14 || current.food < 10) return false
    if (getActiveSkill()) return false

    const entity = findEntityForRisk(entry)
    if (!entity) return false

    const distance = current.entity.position.distanceTo(entity.position)
    if (distance < 4.5 || distance > 14) return false

    const nearbyHostiles = Object.values(current.entities)
      .filter(other => other.position && mobProfiles[other.name || other.type])
      .filter(other => current.entity.position.distanceTo(other.position) <= 8)
    return nearbyHostiles.length <= 1
  }

  async function shootIfSafe (entry) {
    if (!canShootSafely(entry)) return false

    const current = bot()
    const entity = findEntityForRisk(entry)
    const weapon = bestRangedWeapon()
    if (!entity || !weapon) return false

    try {
      getNavigationController()?.stop(`survival: tiro ${entry.source}`)
      current.pathfinder.stop()
      current.clearControlStates()

      if (current.heldItem?.name !== weapon.name) {
        await withTimeout(current.equip(weapon, 'hand'), 2500, `equipar ${weapon.name}`)
      }

      await current.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.65 : 0.9, 0), true).catch(() => {})

      if (weapon.name === 'crossbow') {
        current.activateItem()
        await wait(1250)
        current.deactivateItem()
        await wait(150)
        await current.lookAt(entity.position.offset(0, entity.height ? entity.height * 0.65 : 0.9, 0), true).catch(() => {})
        current.activateItem()
        await wait(120)
        current.deactivateItem()
      } else {
        current.activateItem()
        await wait(950)
        current.deactivateItem()
      }

      return true
    } catch (err) {
      console.error('Erro no disparo defensivo:', err)
      try {
        current.deactivateItem()
      } catch {}
      return false
    }
  }

  async function reactToThreat (status) {
    if (!state.enabled || state.reacting || state.eating || getReconnecting()) return false
    const entry = status.top
    if (!entry || entry.severity < 65) return false
    if (Date.now() - state.lastReactAt < REACTION_COOLDOWN_MS) return false

    state.reacting = true
    state.lastReactAt = Date.now()

    try {
      if (entry.recommendedAction === 'surface') return await surfaceIfNeeded(entry)
      if (entry.recommendedAction === 'avoid_eye_contact') return await avoidEyeContact(entry)
      if (await shootIfSafe(entry)) return true
      if (await meleeIfSafe(entry)) return true
      if (entry.recommendedAction === 'avoid' || entry.recommendedAction === 'flee') return await shortAvoidanceMove(entry)
      return await equipShieldIfUseful(entry)
    } finally {
      state.reacting = false
    }
  }

  function setEnabled (enabled) {
    state.enabled = enabled
    if (!enabled && state.previousObjective) {
      perception.perceptionState.objective = state.previousObjective
      state.previousObjective = null
    }
    return state.enabled
  }

  function maybeApplySurvivalObjective (status) {
    if (!state.enabled) return
    if (status.severity >= 75 && perception.perceptionState.objective !== 'sobreviver') {
      state.previousObjective = perception.perceptionState.objective
      perception.perceptionState.objective = 'sobreviver'
    } else if (status.severity < 45 && state.previousObjective) {
      perception.perceptionState.objective = state.previousObjective
      state.previousObjective = null
    }
  }

  function maybeIntervene (status) {
    if (!state.enabled || getReconnecting()) return
    if (!status.top || status.top.severity < 90) return

    const now = Date.now()
    if (now - state.lastInterventionAt < INTERVENTION_COOLDOWN_MS) return

    if (getActiveSkill()) cancelActiveSkill()
    getNavigationController()?.stop(`survival: ${status.top.source}`)
    bot().pathfinder.stop()
    bot().clearControlStates()
    state.lastInterventionAt = now

    if (now - state.lastAlertAt > ALERT_COOLDOWN_MS) {
      bot().chat(`Survival: interrompi acao por risco critico (${status.top.source}).`)
      state.lastAlertAt = now
    }

    if (status.top.recommendedAction === 'ask_help' || status.top.severity >= 95) {
      askForHelp(status)
    }
  }

  function tick () {
    if (!state.enabled || !getBot()?.entity) return null
    const status = assess()
    state.lastStatus = status
    maybeApplySurvivalObjective(status)
    maybeIntervene(status)
    reactToThreat(status).catch((err) => {
      state.reacting = false
      console.error('Erro no reactToThreat:', err)
    })
    eatIfNeeded(status).catch((err) => {
      state.eating = false
      console.error('Erro no eatIfNeeded:', err)
    })

    const now = Date.now()
    if (status.top && status.top.severity >= 80 && now - state.lastAlertAt > ALERT_COOLDOWN_MS) {
      bot().chat(`Survival: ${status.top.reason}.`)
      state.lastAlertAt = now
    }

    if (status.top?.recommendedAction === 'ask_help') askForHelp(status)
    return status
  }

  return {
    state,
    mobProfiles,
    assess,
    describeStatus,
    describeDebug,
    askForHelp,
    eatIfNeeded,
    reactToThreat,
    setEnabled,
    tick
  }
}

module.exports = {
  createSurvivalGuard
}
