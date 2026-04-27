const test = require('node:test')
const assert = require('node:assert/strict')
const { Vec3 } = require('vec3')
const minecraftData = require('minecraft-data')
const { createMinecraftCatalog } = require('../catalog')
const { createPerceptionHelpers } = require('../perception')

function createFakeBotWithBlocks (blocksByKey) {
  const position = new Vec3(0, 64, 0)

  return {
    entity: { position },
    entities: {},
    blockAt (pos) {
      const key = `${pos.x},${pos.y},${pos.z}`
      const name = blocksByKey.get(key) || 'air'
      return {
        name,
        displayName: name,
        position: pos.clone(),
        boundingBox: name === 'air' ? 'empty' : 'block'
      }
    }
  }
}

test('percepcao ranqueia containers como objetos uteis do mundo', () => {
  const catalog = createMinecraftCatalog(minecraftData('1.20.4'))
  const bot = createFakeBotWithBlocks(new Map([
    ['2,64,0', 'chest']
  ]))

  const perception = createPerceptionHelpers({
    getBot: () => bot,
    catalog,
    getDroppedItemFromEntity: () => null,
    isDroppedItemEntity: () => false,
    ownerMatches: () => false,
    getEscapeDirections: () => []
  })

  perception.perceptionState.objective = 'organizar'
  const tokens = perception.getWorldTokens({ fresh: true })
  const chest = tokens.find(token => token.name === 'chest')

  assert.ok(chest, 'chest deve aparecer como token percebido')
  assert.equal(chest.kind, 'block')
  assert.equal(chest.category, 'container')
  assert.ok(chest.score > 0)
  assert.ok(chest.heads.opportunity >= 85)
})
