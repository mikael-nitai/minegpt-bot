const { parsePlaceCommand } = require('./placement')
const {
  isContainerCommandText,
  parseContainerSearchCommand,
  parseContainerWithdrawCommand,
  parseContainerDepositCommand
} = require('./containers')
const { actionFail } = require('./action-result')

function createCommandSystem ({
  context,
  inventory,
  perception,
  survivalGuard,
  collection,
  parseCoords,
  parsePositiveInteger,
  normalizeItemName,
  sendLongMessage
}) {
  const {
    formatItem,
    summarizeInventory,
    normalizeItemTarget,
    equipItemAction,
    dropItemAction,
    moveItemToHotbarAction,
    describeStatus,
    describeHotbar
  } = inventory

  const {
    perceptionState,
    objectiveWeights,
    refreshPerceptionCache,
    describePerceptionCache,
    describeCatalogResolution,
    describeAttention,
    describeScan,
    describeHazards,
    describeResources,
    describeEntities,
    describeSurroundings
  } = perception

  function bot () {
    if (!context.bot) throw new Error('bot ainda nao inicializado')
    return context.bot
  }

  function jumpOnce () {
    bot().setControlState('jump', true)
    setTimeout(() => bot().setControlState('jump', false), 500)
  }

  async function equipItemByName (itemName) {
    const result = await equipItemAction(itemName)

    if (result.ok) {
      bot().chat(`Segurando ${result.data.itemName || result.data.heldAfter || itemName}.`)
      return result
    }

    if (result.code === 'item_not_found') {
      bot().chat(`Nao tenho ${itemName}.`)
      return result
    }

    if (result.code === 'ambiguous_item') {
      bot().chat(`Nome ambiguo. Opcoes: ${(result.data.options || []).join(', ')}`)
      return result
    }

    bot().chat(result.reason || 'Falha ao segurar item.')
    return result
  }

  async function dropItemByName (itemName, amountText) {
    const amount = amountText == null ? null : parsePositiveInteger(amountText)

    if (amountText != null && !amount) {
      const result = actionFail('inventory.drop', 'Quantidade invalida para dropar item.', { item: itemName, amountText }, Date.now(), {
        code: 'invalid_amount',
        retryable: false
      })
      bot().chat('Use: drop ITEM QUANTIDADE')
      return result
    }

    const result = await dropItemAction(itemName, amount)
    if (result.ok) {
      bot().chat(result.message)
      return result
    }

    if (result.code === 'item_not_found') {
      bot().chat(`Nao tenho ${itemName}.`)
      return result
    }

    if (result.code === 'ambiguous_item') {
      bot().chat(`Nome ambiguo. Opcoes: ${(result.data.options || []).join(', ')}`)
      return result
    }

    bot().chat(result.reason || 'Falha ao dropar item.')
    return result
  }

  async function moveItemToHotbar (slotText, itemName) {
    const slotNumber = parsePositiveInteger(slotText)
    if (!slotNumber || slotNumber < 1 || slotNumber > 9) {
      const result = actionFail('inventory.hotbar', 'Slot invalido. Use 1 a 9.', { slot: slotText, item: itemName }, Date.now(), {
        code: 'invalid_slot',
        retryable: false
      })
      bot().chat('Use slot de 1 a 9.')
      return result
    }

    const result = await moveItemToHotbarAction(slotNumber, itemName)
    if (result.ok) {
      bot().chat(result.message)
      return result
    }

    if (result.code === 'item_not_found') {
      bot().chat(`Nao tenho ${itemName}.`)
      return result
    }

    if (result.code === 'ambiguous_item') {
      bot().chat(`Nome ambiguo. Opcoes: ${(result.data.options || []).join(', ')}`)
      return result
    }

    bot().chat(result.reason || 'Falha ao mover item para hotbar.')
    return result
  }

  async function handleCommand (username, message) {
    const text = message.trim().toLowerCase()

    if (text === 'seguir') {
      context.navigationController.followPlayer(username)
      return
    }

    if (text === 'vir aqui') {
      context.navigationController.comeHere(username)
      return
    }

    if (text === 'parar') {
      const cancelledSkill = context.cancelActiveSkill()
      context.navigationController.stop('comando parar')
      bot().pathfinder.stop()
      bot().clearControlStates()
      bot().chat(cancelledSkill ? 'Parando e cancelando skill atual.' : 'Parando.')
      return
    }

    if (text === 'destravar') {
      await context.navigationController.recover(true)
      return
    }

    if (text === 'navstatus') {
      bot().chat(context.navigationController.describe())
      return
    }

    if (text === 'reconectar') {
      bot().chat('Reconectando.')
      context.reconnectBot('comando reconectar')
      return
    }

    if (text.startsWith('nav modo ')) {
      const mode = text.slice(9).trim()
      if (!context.navigationController.setMode(mode)) {
        bot().chat('Use: nav modo seguro, nav modo blocos ou nav modo avancado')
        return
      }

      bot().chat(`Modo de navegacao: ${mode}.`)
      return
    }

    if (text === 'nav blocos on' || text === 'nav blocos off') {
      const enabled = text.endsWith('on')
      context.navigationController.setOption('allowScaffold', enabled)
      bot().chat(`Navegacao com blocos: ${enabled ? 'ligada' : 'desligada'}.`)
      return
    }

    if (text === 'nav quebrar on' || text === 'nav quebrar off') {
      const enabled = text.endsWith('on')
      context.navigationController.setOption('allowDig', enabled)
      bot().chat(`Quebrar blocos na navegacao: ${enabled ? 'ligado' : 'desligado'}.`)
      return
    }

    if (text === 'nav parkour on' || text === 'nav parkour off') {
      const enabled = text.endsWith('on')
      context.navigationController.setOption('allowParkour', enabled)
      bot().chat(`Parkour na navegacao: ${enabled ? 'ligado' : 'desligado'}.`)
      return
    }

    if (text === 'pular') {
      jumpOnce()
      bot().chat('Pulando.')
      return
    }

    if (text === 'onde voce esta') {
      const pos = bot().entity.position
      bot().chat(`Estou em ${pos.x.toFixed(1)} ${pos.y.toFixed(1)} ${pos.z.toFixed(1)}.`)
      return
    }

    if (text === 'status') {
      sendLongMessage(describeStatus())
      return
    }

    if (text === 'estado') {
      sendLongMessage(context.stateReporter.describeForChat())
      return
    }

    if (text === 'planner estado') {
      sendLongMessage(context.stateReporter.describeForPlanner())
      return
    }

    if (text === 'planner compacto') {
      sendLongMessage(context.stateReporter.describePlannerSnapshot())
      return
    }

    if (text === 'skills') {
      sendLongMessage(context.skillRegistry.describe())
      return
    }

    if (text === 'scan') {
      sendLongMessage(describeScan())
      return
    }

    if (text === 'percepcao') {
      refreshPerceptionCache(true)
      bot().chat(describePerceptionCache())
      return
    }

    if (text === 'atencao') {
      sendLongMessage(describeAttention())
      return
    }

    if (text === 'perigos') {
      sendLongMessage(describeHazards())
      return
    }

    if (text === 'recursos') {
      sendLongMessage(describeResources())
      return
    }

    if (text === 'entidades') {
      sendLongMessage(describeEntities())
      return
    }

    if (text === 'arredores') {
      bot().chat(describeSurroundings())
      return
    }

    if (text.startsWith('resolver ')) {
      sendLongMessage(describeCatalogResolution(text.slice(9)))
      return
    }

    if (text === 'objetivo') {
      bot().chat(`Objetivo perceptivo atual: ${perceptionState.objective}.`)
      return
    }

    if (text.startsWith('objetivo ')) {
      const objective = normalizeItemName(text.slice(9))
      if (!objectiveWeights[objective]) {
        bot().chat(`Objetivo invalido. Use: ${Object.keys(objectiveWeights).join(', ')}`)
        return
      }

      perceptionState.objective = objective
      bot().chat(`Objetivo perceptivo definido: ${objective}.`)
      return
    }

    if (text === 'survival' || text === 'survival status') {
      sendLongMessage(survivalGuard.describeStatus())
      return
    }

    if (text === 'survival debug') {
      sendLongMessage(survivalGuard.describeDebug())
      return
    }

    if (text === 'survival pedir') {
      const asked = survivalGuard.askForHelp()
      bot().chat(asked ? 'Pedido de ajuda enviado.' : 'Pedido recente; aguardando cooldown.')
      return
    }

    if (text === 'survival on' || text === 'survival off') {
      const enabled = text.endsWith('on')
      survivalGuard.setEnabled(enabled)
      bot().chat(`Survival guard: ${enabled ? 'ligado' : 'desligado'}.`)
      return
    }

    if (text === 'inventario') {
      const inventory = summarizeInventory()
      sendLongMessage(inventory.length === 0 ? 'Inventario vazio.' : `Inventario: ${inventory.join(', ')}`)
      return
    }

    if (text === 'coletas') {
      sendLongMessage(collection.describeRecentCollections())
      return
    }

    if (text === 'crafting status') {
      sendLongMessage(context.craftingHelpers.describeStatus())
      return
    }

    if (text === 'blocos') {
      sendLongMessage(context.placementHelpers.describePlaceableBlocks())
      return
    }

    if (text === 'containers' || text === 'containers conhecidos' || text === 'listar baus conhecidos' || text === 'listar baús conhecidos') {
      sendLongMessage(context.containerHelpers.describeKnownContainers())
      return
    }

    if (text === 'containers scan' || text === 'scan baus' || text === 'scan baús') {
      const result = await context.containerHelpers.scanAndInspectContainers()
      sendLongMessage(result.ok ? result.message : `Falha no scan de containers: ${result.reason}`)
      return
    }

    if (text === 'lembrar baus' || text === 'lembrar baús') {
      sendLongMessage(context.containerHelpers.describeScanOnly())
      return
    }

    if (text === 'containers esquecer' || text === 'esquecer baus' || text === 'esquecer baús') {
      const count = context.containerHelpers.clearMemory()
      bot().chat(`Esqueci ${count} container(s).`)
      return
    }

    if (text.startsWith('procurar ')) {
      const request = parseContainerSearchCommand(text)
      if (!request.target) {
        bot().chat('Use: procurar ITEM em baus proximos')
        return
      }

      const result = await context.containerHelpers.searchItemByQuery(request.target)
      sendLongMessage(result.ok ? result.message : `Falha ao procurar: ${result.reason}`)
      return
    }

    if (text.startsWith('buscar ')) {
      const request = parseContainerWithdrawCommand(text)
      if (!request.target) {
        bot().chat('Use: buscar ITEM em container')
        return
      }

      const result = await context.containerHelpers.withdrawItemByQuery(request.target, request.count)
      sendLongMessage(result.ok ? result.message : `Falha ao buscar: ${result.reason}`)
      return
    }

    if (text.startsWith('pegar ') && isContainerCommandText(text)) {
      const request = parseContainerWithdrawCommand(text)
      if (!request.target) {
        bot().chat('Use: pegar ITEM de bau')
        return
      }

      const result = await context.containerHelpers.withdrawItemByQuery(request.target, request.count)
      sendLongMessage(result.ok ? result.message : `Falha ao pegar de container: ${result.reason}`)
      return
    }

    if (text.startsWith('guardar ')) {
      const request = parseContainerDepositCommand(text)
      if (request.mode === 'target' && !request.target) {
        bot().chat('Use: guardar ITEM, guardar tudo, guardar recursos, guardar blocos ou guardar drops')
        return
      }

      const result = await context.containerHelpers.depositByRequest(request)
      sendLongMessage(result.ok ? result.message : `Falha ao guardar: ${result.reason}`)
      return
    }

    if (text.startsWith('receita ')) {
      sendLongMessage(context.craftingHelpers.describeRecipeByQuery(text.slice(8).trim()))
      return
    }

    if (text.startsWith('craft ')) {
      const craftText = text.slice(6).trim()
      const parts = craftText.split(/\s+/)
      const requestedCount = parsePositiveInteger(parts[0])
      const target = requestedCount ? parts.slice(1).join(' ') : craftText
      if (!target) {
        bot().chat('Use: craft ITEM ou craft QUANTIDADE ITEM')
        return
      }

      const result = await context.craftingHelpers.craftByQuery(target, requestedCount || 1)
      bot().chat(result.ok ? result.message : `Falha ao craftar: ${result.reason}`)
      return
    }

    if (text.startsWith('colocar ')) {
      const request = parsePlaceCommand(text.slice(8).trim())
      const result = await context.placementHelpers.placeByRequest(request)
      bot().chat(result.ok ? result.message : `Falha ao colocar: ${result.reason}`)
      return
    }

    if (text === 'drops') {
      bot().chat(`Busca automatica de drops: ${collection.collectionState.autoDrops ? 'ligada' : 'desligada'}.`)
      return
    }

    if (text === 'drops on' || text === 'drops off') {
      collection.collectionState.autoDrops = text.endsWith('on')
      bot().chat(`Busca automatica de drops: ${collection.collectionState.autoDrops ? 'ligada' : 'desligada'}.`)
      return
    }

    if (text === 'pegar drops') {
      const skill = context.startSkill('pegar_drops')
      if (!skill) {
        bot().chat(`Ja estou executando ${context.activeSkill.name}. Use parar para cancelar.`)
        return
      }

      context.navigationController.stop('skill pegar drops')
      try {
        await collection.collectDropsAround(bot().entity.position.clone(), {
          radius: 8,
          durationMs: 6000,
          maxDrops: 8,
          announce: true
        })
      } finally {
        bot().pathfinder.stop()
        bot().clearControlStates()
        context.finishSkill(skill)
      }
      return
    }

    if (text.startsWith('pegar ')) {
      const targetText = text.slice(6).trim()
      if (!targetText) {
        bot().chat('Use: pegar ALVO ou pegar drops')
        return
      }

      const target = normalizeItemTarget(targetText, 'dropped')
      const skill = context.startSkill('pegar_drops')
      if (!skill) {
        bot().chat(`Ja estou executando ${context.activeSkill.name}. Use parar para cancelar.`)
        return
      }

      context.navigationController.stop('skill pegar drops')
      try {
        await collection.collectDropsAround(bot().entity.position.clone(), {
          radius: 8,
          durationMs: 6000,
          maxDrops: 8,
          announce: true,
          target
        })
      } finally {
        bot().pathfinder.stop()
        bot().clearControlStates()
        context.finishSkill(skill)
      }
      return
    }

    if (text === 'hotbar') {
      sendLongMessage(`Hotbar: ${describeHotbar()}`)
      return
    }

    if (text === 'mao') {
      bot().chat(bot().heldItem ? `Mao: ${formatItem(bot().heldItem)}` : 'Mao vazia.')
      return
    }

    if (text.startsWith('ir ')) {
      const coords = parseCoords(text.slice(3).split(/\s+/))
      if (!coords) {
        bot().chat('Use: ir X Y Z')
        return
      }

      context.navigationController.goToCoords(coords)
      return
    }

    if (text.startsWith('segure ')) {
      await equipItemByName(text.slice(7))
      return
    }

    if (text.startsWith('drop ')) {
      const parts = text.slice(5).split(/\s+/)
      const maybeAmount = parts.length > 1 ? parts[parts.length - 1] : null
      const amount = maybeAmount ? parsePositiveInteger(maybeAmount) : null
      const itemName = amount ? parts.slice(0, -1).join(' ') : parts.join(' ')

      await dropItemByName(itemName, amount ? String(amount) : null)
      return
    }

    if (text.startsWith('coletar ')) {
      const collectText = text.slice(8).trim()
      const parts = collectText.split(/\s+/)
      const requestedCount = parsePositiveInteger(parts[0])
      const target = requestedCount ? parts.slice(1).join(' ') : collectText
      if (!target) {
        bot().chat('Use: coletar ALVO ou coletar QUANTIDADE ALVO')
        return
      }

      if (requestedCount) {
        if (requestedCount > collection.MAX_COLLECT_SEQUENCE) {
          bot().chat(`Limite atual: ${collection.MAX_COLLECT_SEQUENCE} blocos por comando.`)
        }
        await collection.collectMultipleBlocksByTarget(target, requestedCount)
      } else {
        await collection.collectBlockByTarget(target)
      }
      return
    }

    if (text.startsWith('hotbar ')) {
      const parts = text.slice(7).split(/\s+/)
      if (parts.length < 2) {
        bot().chat('Use: hotbar SLOT ITEM')
        return
      }

      await moveItemToHotbar(parts[0], parts.slice(1).join(' '))
      return
    }

    if (text === 'ajuda') {
      bot().chat('Movimento: seguir, vir aqui, parar, destravar, reconectar, navstatus, nav modo seguro|blocos|avancado, ir X Y Z')
      bot().chat('Percepcao: scan, atencao, perigos, recursos, entidades, arredores, percepcao, resolver ALVO, objetivo [NOME]')
      bot().chat('Planejamento: estado, planner estado, skills')
      bot().chat('Sobrevivencia: survival, survival status, survival on|off, survival pedir, survival debug (come automaticamente)')
      bot().chat('Inventario: status, inventario, hotbar, mao, segure ITEM, drop ITEM [QTD], hotbar SLOT ITEM, coletas')
      bot().chat('Crafting: receita ITEM, crafting status, craft ITEM, craft N ITEM')
      bot().chat('Coleta: coletar ALVO, coletar N ALVO, pegar ALVO, pegar drops, drops on|off. Exemplos: coletar 5 stone, pegar pao')
      bot().chat('Blocos: blocos, colocar BLOCO, colocar BLOCO na frente|abaixo|perto de mim|em X Y Z')
      bot().chat('Containers: containers, containers scan, procurar ITEM, buscar ITEM em container, pegar ITEM de bau, guardar ITEM|tudo|recursos|blocos|drops')
    }
  }

  return {
    handleCommand,
    equipItemByName,
    dropItemByName,
    moveItemToHotbar
  }
}

module.exports = {
  createCommandSystem
}
