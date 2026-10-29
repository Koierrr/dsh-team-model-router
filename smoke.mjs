// Offline smoke test: no DSH host, all services mocked.
import { apply } from './lib/index.js'

const captured = []
let registered = null

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
  agents: { list: () => [lead] },
  agentTeams: {
    tryMembership: () => ({ role: 'lead' }),
    membership: () => ({ role: 'lead' }),
    async spawnTeammate(agent, request) {
      // Mirror what TeamRoster.spawnAdmitted does.
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
console.log('tool name:', registered.name)

// 1) modeled spawn carries agentOptions
const result = await registered.execute(
  {
    name: 'helper',
    description: 'test member',
    prompt: 'do the thing',
    provider: 'sophnet',
    model: 'qwen3.8-flash',
  },
  { agent: lead },
)
console.log('tool result:', JSON.stringify(result))
console.log('injected agentOptions:', JSON.stringify(captured[0].request.agentOptions))

// 2) plain spawn (no reservation) stays untouched
await ctx.agentTeams.spawnTeammate(lead, {
  name: 'plain',
  description: 'plain member',
  prompt: [{ type: 'text', text: 'unmodeled' }],
  context: 'fresh',
  provider: 'spawn',
})
console.log('plain request has agentOptions:', captured[1].request.agentOptions !== undefined)

// 3) unknown model fails before creation
try {
  await registered.execute(
    { name: 'bad', description: 'x', prompt: 'y', provider: 'sophnet', model: 'nope' },
    { agent: lead },
  )
  console.log('FAIL: unknown model was accepted')
} catch (error) {
  console.log('unknown model rejected:', error.message)
}
