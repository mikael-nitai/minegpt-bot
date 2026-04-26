function normalizeItemName (value) {
  return value.trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_')
}

function createNameSet (names, validNames) {
  return new Set(names.filter(name => validNames.has(name)))
}

const catalogAliases = {
  arvore: { blockCategories: ['wood'], itemCategories: ['wood'] },
  madeira: { blockCategories: ['wood'], itemCategories: ['wood'] },
  tronco: { blockCategories: ['wood'], itemCategories: ['wood'] },
  tronco_de_carvalho: { blocks: ['oak_log'], items: ['oak_log'] },
  madeira_de_carvalho: { blocks: ['oak_log'], items: ['oak_log', 'oak_planks'] },
  minerio: { blockCategories: ['ore'] },
  minerios: { blockCategories: ['ore'] },
  carvao: { blocks: ['coal_ore', 'deepslate_coal_ore'], items: ['coal', 'charcoal'] },
  coal: { blocks: ['coal_ore', 'deepslate_coal_ore'], items: ['coal', 'charcoal'] },
  minerio_de_carvao: { blocks: ['coal_ore', 'deepslate_coal_ore'] },
  ferro: { blocks: ['iron_ore', 'deepslate_iron_ore'], items: ['iron_ingot', 'raw_iron'] },
  iron: { blocks: ['iron_ore', 'deepslate_iron_ore'], items: ['iron_ingot', 'raw_iron'] },
  minerio_de_ferro: { blocks: ['iron_ore', 'deepslate_iron_ore'] },
  cobre: { blocks: ['copper_ore', 'deepslate_copper_ore'], items: ['copper_ingot', 'raw_copper'] },
  copper: { blocks: ['copper_ore', 'deepslate_copper_ore'], items: ['copper_ingot', 'raw_copper'] },
  minerio_de_cobre: { blocks: ['copper_ore', 'deepslate_copper_ore'] },
  ouro: { blocks: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], items: ['gold_ingot', 'raw_gold', 'gold_nugget'] },
  gold: { blocks: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'], items: ['gold_ingot', 'raw_gold', 'gold_nugget'] },
  minerio_de_ouro: { blocks: ['gold_ore', 'deepslate_gold_ore', 'nether_gold_ore'] },
  diamante: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], items: ['diamond'] },
  diamond: { blocks: ['diamond_ore', 'deepslate_diamond_ore'], items: ['diamond'] },
  minerio_de_diamante: { blocks: ['diamond_ore', 'deepslate_diamond_ore'] },
  esmeralda: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], items: ['emerald'] },
  emerald: { blocks: ['emerald_ore', 'deepslate_emerald_ore'], items: ['emerald'] },
  minerio_de_esmeralda: { blocks: ['emerald_ore', 'deepslate_emerald_ore'] },
  redstone: { blocks: ['redstone_ore', 'deepslate_redstone_ore'], items: ['redstone'] },
  lapis: { blocks: ['lapis_ore', 'deepslate_lapis_ore'], items: ['lapis_lazuli'] },
  pedra: { blocks: ['stone'], items: ['stone', 'cobblestone'] },
  pedregulho: { blocks: ['cobblestone'], items: ['cobblestone'] },
  terra: { blocks: ['dirt', 'grass_block'], items: ['dirt'] },
  tabua: { items: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'] },
  tabuas: { items: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'] },
  plank: { items: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'] },
  planks: { items: ['oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks'] },
  graveto: { items: ['stick'] },
  gravetos: { items: ['stick'] },
  palito: { items: ['stick'] },
  mesa: { blocks: ['crafting_table'], items: ['crafting_table'] },
  bancada: { blocks: ['crafting_table'], items: ['crafting_table'] },
  mesa_de_trabalho: { blocks: ['crafting_table'], items: ['crafting_table'] },
  tocha: { items: ['torch'] },
  tochas: { items: ['torch'] },
  bau: { blocks: ['chest'], items: ['chest'] },
  chest: { blocks: ['chest'], items: ['chest'] },
  fornalha: { blocks: ['furnace'], items: ['furnace'] },
  comida: { itemCategories: ['food'] },
  pao: { items: ['bread'] },
  maca: { items: ['apple'] },
  picareta: { itemCategories: ['pickaxe'] },
  picareta_de_madeira: { items: ['wooden_pickaxe'] },
  picareta_de_pedra: { items: ['stone_pickaxe'] },
  machado: { itemCategories: ['axe'] },
  pa: { itemCategories: ['shovel'] },
  espada: { itemCategories: ['sword'] },
  enxada: { itemCategories: ['hoe'] },
  ferramenta: { itemCategories: ['tool'] },
  escudo: { items: ['shield'] },
  arco: { items: ['bow'] },
  besta: { items: ['crossbow'] },
  flecha: { items: ['arrow'] },
  flechas: { items: ['arrow'] },
  tridente: { items: ['trident'] },
  lanca: { items: ['trident'] },
  spear: { items: ['trident'] },
  mace: { items: ['mace'] },
  maca_de_combate: { items: ['mace'] }
}

function createMinecraftCatalog (data) {
  const blockNames = new Set(Object.keys(data.blocksByName || {}))
  const itemNames = new Set(Object.keys(data.itemsByName || {}))
  const foodNames = new Set(Object.keys(data.foodsByName || {}))

  const blockCategories = {
    ore: new Set([...blockNames].filter(name => name.endsWith('_ore') || name === 'ancient_debris')),
    wood: new Set([...blockNames].filter(name => name.endsWith('_log') || name.endsWith('_stem') || name.endsWith('_hyphae'))),
    stone: createNameSet([
      'stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'granite', 'diorite', 'andesite',
      'tuff', 'calcite', 'basalt', 'blackstone', 'netherrack', 'end_stone'
    ], blockNames),
    dirt: createNameSet(['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol', 'mycelium'], blockNames),
    sand: createNameSet(['sand', 'red_sand', 'gravel'], blockNames)
  }

  const itemCategories = {
    food: foodNames,
    pickaxe: new Set([...itemNames].filter(name => name.endsWith('_pickaxe'))),
    axe: new Set([...itemNames].filter(name => name.endsWith('_axe'))),
    shovel: new Set([...itemNames].filter(name => name.endsWith('_shovel'))),
    sword: new Set([...itemNames].filter(name => name.endsWith('_sword'))),
    hoe: new Set([...itemNames].filter(name => name.endsWith('_hoe'))),
    tool: new Set([...itemNames].filter(name =>
      name.endsWith('_pickaxe') || name.endsWith('_axe') || name.endsWith('_shovel') ||
      name.endsWith('_sword') || name.endsWith('_hoe') || name === 'shears' || name === 'fishing_rod'
    )),
    wood: new Set([...itemNames].filter(name =>
      name.endsWith('_log') || name.endsWith('_stem') || name.endsWith('_hyphae') || name.endsWith('_planks')
    ))
  }

  const catalog = {
    data,
    blockNames,
    itemNames,
    foodNames,
    blockCategories,
    itemCategories
  }

  function addCatalogCandidate (candidates, candidate) {
    const key = `${candidate.kind}:${candidate.name}`
    const existing = candidates.get(key)
    if (!existing || candidate.score > existing.score) {
      candidates.set(key, candidate)
    }
  }

  function resolveCatalogQuery (query, context = 'any') {
    const normalized = normalizeItemName(query)
    const candidates = new Map()
    const wantsBlock = context === 'collect' || context === 'block'
    const wantsItem = context === 'inventory' || context === 'dropped' || context === 'item'

    if (catalog.blockNames.has(normalized)) {
      addCatalogCandidate(candidates, {
        kind: 'block',
        name: normalized,
        score: wantsBlock ? 300 : 120,
        source: 'internal_name'
      })
    }

    if (catalog.itemNames.has(normalized)) {
      addCatalogCandidate(candidates, {
        kind: 'item',
        name: normalized,
        score: wantsItem ? 300 : 120,
        source: 'internal_name'
      })
    }

    const alias = catalogAliases[normalized]
    if (alias) {
      for (const blockName of alias.blocks || []) {
        if (!catalog.blockNames.has(blockName)) continue
        addCatalogCandidate(candidates, {
          kind: 'block',
          name: blockName,
          score: wantsBlock ? 280 : 100,
          source: 'pt_alias'
        })
      }

      for (const itemName of alias.items || []) {
        if (!catalog.itemNames.has(itemName)) continue
        addCatalogCandidate(candidates, {
          kind: 'item',
          name: itemName,
          score: wantsItem ? 280 : 100,
          source: 'pt_alias'
        })
      }

      for (const category of alias.blockCategories || []) {
        addCatalogCandidate(candidates, {
          kind: 'block_category',
          name: category,
          score: wantsBlock ? 260 : 90,
          source: 'pt_alias'
        })
      }

      for (const category of alias.itemCategories || []) {
        addCatalogCandidate(candidates, {
          kind: 'item_category',
          name: category,
          score: wantsItem ? 260 : 90,
          source: 'pt_alias'
        })
      }
    }

    if (candidates.size === 0 || normalized.includes('_')) {
      for (const blockName of catalog.blockNames) {
        if (!blockName.includes(normalized)) continue
        addCatalogCandidate(candidates, {
          kind: 'block',
          name: blockName,
          score: wantsBlock ? 90 : 35,
          source: 'partial_name'
        })
      }

      for (const itemName of catalog.itemNames) {
        if (!itemName.includes(normalized)) continue
        addCatalogCandidate(candidates, {
          kind: 'item',
          name: itemName,
          score: wantsItem ? 90 : 35,
          source: 'partial_name'
        })
      }
    }

    return {
      raw: normalized,
      candidates: [...candidates.values()].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    }
  }

  function catalogBlockHasCategory (blockName, category) {
    return Boolean(catalog.blockCategories[category]?.has(blockName))
  }

  function catalogItemHasCategory (itemName, category) {
    return Boolean(catalog.itemCategories[category]?.has(itemName))
  }

  function categoryNamesForBlock (blockName) {
    return Object.entries(catalog.blockCategories)
      .filter(([, names]) => names.has(blockName))
      .map(([category]) => category)
  }

  function categoryNamesForItem (itemName) {
    return Object.entries(catalog.itemCategories)
      .filter(([, names]) => names.has(itemName))
      .map(([category]) => category)
  }

  return {
    ...catalog,
    aliases: catalogAliases,
    normalizeItemName,
    resolveCatalogQuery,
    catalogBlockHasCategory,
    catalogItemHasCategory,
    categoryNamesForBlock,
    categoryNamesForItem
  }
}

module.exports = {
  createMinecraftCatalog,
  normalizeItemName
}
