const { actionFail, runAction } = require('./action-result')

function createSkillRegistry () {
  const skills = new Map()

  function register (definition) {
    if (!definition?.id) throw new Error('skill sem id')
    if (typeof definition.run !== 'function') throw new Error(`skill ${definition.id} sem run()`)
    skills.set(definition.id, {
      description: '',
      inputSchema: {},
      risk: 'low',
      timeoutMs: 10000,
      interruptible: true,
      ...definition
    })
  }

  function get (id) {
    return skills.get(id) || null
  }

  function list () {
    return [...skills.values()]
      .map(({ id, description, risk, timeoutMs, interruptible }) => ({ id, description, risk, timeoutMs, interruptible }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  function describe () {
    const entries = list()
    if (entries.length === 0) return 'Skills: nenhuma registrada.'
    return `Skills: ${entries.map(skill => `${skill.id}(${skill.risk})`).join(', ')}`
  }

  async function execute (id, args = {}, context = {}) {
    const skill = get(id)
    if (!skill) return actionFail(id, `skill desconhecida: ${id}`)
    return runAction(id, () => skill.run(args, context))
  }

  return {
    register,
    get,
    list,
    describe,
    execute
  }
}

module.exports = {
  createSkillRegistry
}
