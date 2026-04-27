const test = require('node:test')
const assert = require('node:assert/strict')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')

const catalog = createMinecraftCatalog(minecraftData('1.20.4'))

function firstCandidate (query, context) {
  return catalog.resolveCatalogQuery(query, context).candidates[0]
}

test('catalogo carrega blocos, itens e categorias fundamentais', () => {
  assert.equal(catalog.blockNames.has('coal_ore'), true)
  assert.equal(catalog.itemNames.has('bread'), true)
  assert.equal(catalog.catalogBlockHasCategory('oak_log', 'wood'), true)
  assert.equal(catalog.catalogItemHasCategory('bread', 'food'), true)
  assert.equal(catalog.categoryNamesForItem('stone_pickaxe').includes('pickaxe'), true)
})

test('resolvedor prioriza contexto de coleta e inventario', () => {
  assert.equal(firstCandidate('coal_ore', 'collect').name, 'coal_ore')
  assert.equal(firstCandidate('stone_pickaxe', 'inventory').name, 'stone_pickaxe')

  const coal = firstCandidate('carvao', 'collect')
  assert.equal(coal.kind, 'block')
  assert.equal(['coal_ore', 'deepslate_coal_ore'].includes(coal.name), true)

  assert.deepEqual(firstCandidate('pao', 'inventory'), {
    kind: 'item',
    name: 'bread',
    score: 280,
    source: 'pt_alias'
  })
})

test('aliases e categorias de containers ficam disponiveis para futuro planner', () => {
  assert.equal(catalog.catalogBlockHasCategory('chest', 'container'), true)
  assert.equal(catalog.catalogBlockHasCategory('barrel', 'container'), true)
  assert.equal(catalog.catalogBlockHasCategory('white_shulker_box', 'container'), true)
  assert.equal(firstCandidate('baus', 'block').kind, 'block_category')
  assert.equal(firstCandidate('baus', 'block').name, 'container')
})
