// Offline smoke test: no DSH host, all services mocked.
import { apply } from './lib/index.js'

const captured = []
let registered = null

const ALLOWED = [{ provider: 'sophnet', model: 'qwen3.8-flash' }]

const lead = {
  id: 'lead-agent',
  ctx: {
    tools: {
      register(tool) {
        registered = tool
        return () => {}
      },
    },
  },
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    return () => dispose?.()
  },
  on() {},
  get(service) {
    if (service !== 'subagentModelSelection') return undefined
    return {
      current() {
        return { enabled: true, allowedModels: ALLOWED.map(route => ({ ...route })) }
      },
    }
  },
  agents: { list: () => [lead] },
  agentTeams: {
    tryMembership: () => ({ role: 'lead' }),
    membership: () => ({ role: 'lead' }),
    async spawnTeammate(agent, request) {
      await ctx.subagents.startActivation({
        delivery: 'parent',
        childId: 'child-1',
        provider: request.provider,
        label: request.description,
        request: { prompt: request.prompt, parent: agent },
      })
      return { member: { name: request.name, status: 'provisioning' } }
    },
  },
  subagents: {
    async startActivation(spec) {
      captured.push(spec)
      return { messageId: 'm1' }
    },
  },
  llm: {
    async resolveCallConfig({ provider, model, reasoningEffort }) {
      if (model === 'nope') throw new Error('unknown model')
      return { provider, model, reasoningEffort }
    },
  },
}

apply(ctx, {})

if (registered === null) throw new Error('tool was not registered')
console.log('tool:', registered.name)

// 1) allowed model: injected
const ok = await registered.execute(
  { name: 'helper', description: 'd', prompt: 'p', provider: 'sophnet', model: 'qwen3.8-flash' },
  { agent: lead },
)
console.log('1 allowed ->', JSON.stringify(ok))
console.log('  agentOptions:', JSON.stringify(captured[0].request.agentOptions))

// 2) model outside the allowlist: rejected before creation
try {
  await registered.execute(
    { name: 'x', description: 'd', prompt: 'p', provider: 'siliconflow', model: 'Qwen/Qwen3.5-35B-A3B' },
    { agent: lead },
  )
  console.log('2 FAIL: disallowed model was accepted')
} catch (error) {
  console.log('2 disallowed rejected:', error.message)
}

// 3) unknown model: rejected by the LLM service
try {
  await registered.execute(
    { name: 'y', description: 'd', prompt: 'p', provider: 'sophnet', model: 'nope' },
    { agent: lead },
  )
  console.log('3 FAIL: unknown model was accepted')
} catch (error) {
  console.log('3 unknown rejected:', error.message)
}

// 4) plain spawn stays untouched
await ctx.agentTeams.spawnTeammate(lead, {
  name: 'plain',
  description: 'plain member',
  prompt: [{ type: 'text', text: 'unmodeled' }],
  context: 'fresh',
  provider: 'spawn',
})
console.log('4 plain spawn has agentOptions:', captured[1].request.agentOptions !== undefined)

// 5) enforcement can be turned off by config
let offRegistered = null
const lead2 = { id: 'lead2', ctx: { tools: { register(tool) { offRegistered = tool; return () => {} } } } }
const ctx2 = {
  ...ctx,
  agents: { list: () => [lead2] },
  on() {},
}
apply(ctx2, { enforceAllowedModels: false })
try {
  await offRegistered.execute(
    { name: 'z', description: 'd', prompt: 'p', provider: 'siliconflow', model: 'Qwen/Qwen3.5-35B-A3B' },
    { agent: lead2 },
  )
  console.log('5 enforceAllowedModels:false bypasses:', true)
} catch (error) {
  console.log('5 FAIL:', error.message)
}
