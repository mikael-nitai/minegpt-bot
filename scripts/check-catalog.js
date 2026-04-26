const assert = require('assert')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')

const catalog = createMinecraftCatalog(minecraftData('1.20.4'))

function firstCandidate (query, context) {
  return catalog.resolveCatalogQuery(query, context).candidates[0]
}

assert(catalog.blockNames.has('coal_ore'), 'catalogo deve conter coal_ore')
assert(catalog.itemNames.has('bread'), 'catalogo deve conter bread')
assert(catalog.catalogBlockHasCategory('oak_log', 'wood'), 'oak_log deve ser madeira')
assert(catalog.catalogItemHasCategory('bread', 'food'), 'bread deve ser comida')
assert(catalog.categoryNamesForItem('stone_pickaxe').includes('pickaxe'), 'stone_pickaxe deve ser picareta')

assert.strictEqual(firstCandidate('coal_ore', 'collect').name, 'coal_ore')
assert.strictEqual(firstCandidate('stone_pickaxe', 'inventory').name, 'stone_pickaxe')

const coal = firstCandidate('carvao', 'collect')
assert.strictEqual(coal.kind, 'block')
assert(coal.name === 'coal_ore' || coal.name === 'deepslate_coal_ore', 'carvao deve resolver para minerio coletavel')

const bread = firstCandidate('pao', 'inventory')
assert.strictEqual(bread.kind, 'item')
assert.strictEqual(bread.name, 'bread')

const pickaxe = firstCandidate('picareta', 'inventory')
assert.strictEqual(pickaxe.kind, 'item_category')
assert.strictEqual(pickaxe.name, 'pickaxe')

console.log('Catalog smoke test passou.')
