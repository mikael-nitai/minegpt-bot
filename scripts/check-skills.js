const assert = require('assert')
const { actionOk, actionFail, itemRequirement } = require('../action-result')
const { createSkillRegistry } = require('../skills')

const ok = actionOk('test.ok', 'feito', { value: 1 }, Date.now() - 5)
assert.strictEqual(ok.ok, true)
assert.strictEqual(ok.skill, 'test.ok')
assert(ok.durationMs >= 0)

const fail = actionFail('test.fail', 'falhou')
assert.strictEqual(fail.ok, false)
assert.strictEqual(fail.reason, 'falhou')
assert.strictEqual(fail.code, 'error')

const missing = actionFail('test.missing', 'faltou item', {}, Date.now(), {
  code: 'missing_materials',
  retryable: true,
  missingRequirements: [itemRequirement('coal', 1)]
})
assert.strictEqual(missing.code, 'missing_materials')
assert.strictEqual(missing.retryable, true)
assert.strictEqual(missing.missingRequirements[0].name, 'coal')

const registry = createSkillRegistry()
registry.register({
  id: 'demo.echo',
  description: 'eco',
  inputSchema: { text: 'string' },
  effects: ['chat'],
  run: ({ text }) => actionOk('demo.echo', text, { text })
})

assert.strictEqual(registry.get('demo.echo').id, 'demo.echo')
assert(registry.describe().includes('demo.echo'))

registry.plan('demo.echo', { text: 'ok' }).then((plan) => {
  assert.strictEqual(plan.ok, true)
  assert.deepStrictEqual(plan.effects, ['chat'])
  return registry.execute('demo.echo', { text: 'ok' })
}).then((result) => {
  assert.strictEqual(result.ok, true)
  assert.strictEqual(result.data.text, 'ok')
  return registry.execute('missing.skill')
}).then((result) => {
  assert.strictEqual(result.ok, false)
  console.log('Skills smoke test passou.')
}).catch((err) => {
  console.error(err)
  process.exit(1)
})
