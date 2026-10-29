/**
 * dsh-team-model-router
 *
 * Agent Teams' `spawn_teammate` cannot carry a model: the roster builds
 * `ctx.subagents.startActivation({ request: { prompt, parent } })` and the child
 * therefore inherits the Lead's route. The API session controller also refuses
 * to own an addressed-subagent session, so the model cannot be changed after
 * creation either (that is why the Web UI hides the model picker there).
 *
 * This plugin adds the missing seam from above without touching DSH itself:
 *
 * 1. It wraps `ctx.subagents.startActivation` and injects `agentOptions` into
 *    the next reserved spawn whose prompt matches the reservation.
 * 2. It registers a Lead-scoped `spawn_teammate_modeled` tool that resolves the
 *    requested route, reserves it, and then calls the real Team service.
 *
 * Roster, task board, mailbox, and persistence stay owned by
 * `@deepseek-ai/dsh-experimental-agent-team`. Disposing this plugin restores the
 * original method, so removing it needs no DSH change.
 *
 * @module dsh-team-model-router
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** Cordis plugin name. */
export const name = 'team-model-router'

/**
 * Settings form rendered by the DSH settings page from this schema.
 * Each field's description becomes its label hint in the UI.
 */
export const Config = z.object({
  freshProvider: z
    .string()
    .default('spawn')
    .description('fresh 成员使用的子智能体提供方。默认 spawn，除非你装了自己的提供方，否则别改。'),
  forkProvider: z
    .string()
    .default('fork')
    .description('fork 成员使用的子智能体提供方。默认 fork，一般不需要改。'),
  enforceAllowedModels: z
    .boolean()
    .default(true)
    .description('是否跟随「子智能体」设置页的模型白名单。开启后本工具只能使用那里勾选过的模型。'),
})

/** Services this plugin needs before it can install anything. */
export const inject = ['agents', 'agentTeams', 'llm', 'subagents']

/**
 * Stable key for one spawn reservation. The Team roster hands the very same
 * content blocks to the subagent service, so the serialized prompt identifies
 * exactly one creation request.
 * @param blocks - prompt content blocks reserved by the calling tool.
 * @returns canonical reservation key.
 */
function promptKey(blocks) {
  return JSON.stringify(blocks)
}

/**
 * Serialize Team creations made through this plugin so a reservation is never
 * consumed by a concurrent spawn that carries the same prompt text.
 * @returns a runner that queues tasks one after another.
 */
function createLock() {
  let chain = Promise.resolve()
  return function withLock(task) {
    const run = chain.then(task, task)
    chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}

/**
 * Install the plugin.
 * @param ctx - Cordis context carrying Agent, Team, LLM, and subagent services.
 * @param config - optional provider names used for fresh and fork teammates.
 */
export function apply(ctx, config = {}) {
  const freshProvider = typeof config.freshProvider === 'string' ? config.freshProvider : 'spawn'
  const forkProvider = typeof config.forkProvider === 'string' ? config.forkProvider : 'fork'
  const enforceAllowedModels = config.enforceAllowedModels !== false

  /**
   * Read the model-selection policy owned by `subagent-model-selection-settings`.
   * That plugin owns the 子智能体 settings page (toggle + checkbox list), so this
   * tool obeys the same allowlist instead of inventing a second one.
   * @returns the policy, or undefined when that plugin is not mounted.
   */
  function readModelPolicy() {
    const service = typeof ctx.get === 'function' ? ctx.get('subagentModelSelection') : undefined
    if (service === undefined || typeof service.current !== 'function') return undefined
    try {
      return service.current()
    } catch {
      return undefined
    }
  }

  /**
   * Reject a route the user did not enable, naming what is enabled so the caller
   * can correct itself instead of retrying blindly.
   * @param selected - the resolved provider/model pair.
   */
  function assertAllowed(selected) {
    if (!enforceAllowedModels) return
    const policy = readModelPolicy()
    if (policy === undefined || policy.enabled !== true) return
    const allowed = policy.allowedModels
    if (allowed.some(route => route.provider === selected.provider && route.model === selected.model)) return
    const listing = allowed.map(route => `${route.provider}/${route.model}`).join(', ')
    throw new Error(
      `model "${selected.provider}/${selected.model}" is not enabled for subagents. ` +
        `Enabled models: ${listing === '' ? '(none)' : listing}. ` +
        'Enable it on the 子智能体 settings page, or set enforceAllowedModels: false for this plugin.',
    )
  }

  /** Prompt key -> agentOptions reserved by the next modeled spawn. */
  const reservations = new Map()
  const withLock = createLock()

  /**
   * Install the reserved route on the activation the Team roster is about to
   * create, then delegate unchanged.
   */
  const subagents = ctx.subagents
  const originalStartActivation = subagents.startActivation
  const patchedStartActivation = async function startActivationWithModel(spec) {
    const request = spec?.request
    if (request !== undefined && Array.isArray(request.prompt) && request.agentOptions === undefined) {
      const key = promptKey(request.prompt)
      const reserved = reservations.get(key)
      if (reserved !== undefined) {
        reservations.delete(key)
        spec = { ...spec, request: { ...request, agentOptions: reserved } }
      }
    }
    return await originalStartActivation.call(this, spec)
  }
  subagents.startActivation = patchedStartActivation
  ctx.effect(() => () => {
    if (subagents.startActivation === patchedStartActivation) subagents.startActivation = originalStartActivation
  })

  /**
   * Resolve and normalize one requested route through the LLM service so an
   * unknown provider or model fails before any teammate is created.
   */
  async function resolveRoute(provider, model, reasoningEffort) {
    const llm = ctx.llm
    const resolveCallConfig = llm?.resolveCallConfig
    if (typeof resolveCallConfig !== 'function') {
      return {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      }
    }
    const resolved = await resolveCallConfig.call(llm, {
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    return {
      provider: resolved.provider,
      model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
    }
  }

  /** One Lead-only tool that creates a teammate on an explicitly chosen route. */
  const tool = defineTool({
    name: 'spawn_teammate_modeled',
    description:
      'Create one named, durable teammate on a model chosen now. Same as spawn_teammate, plus an explicit provider and model that the built-in tool cannot express. Only the Team Lead may call this tool.',
    parameters: {
      name: {
        type: 'string',
        required: true,
        description: 'Unique lower-kebab-case teammate name.',
      },
      description: {
        type: 'string',
        required: true,
        description: 'Short description of the delegated responsibility.',
      },
      prompt: {
        type: 'string',
        required: true,
        description: 'Complete initial task for the teammate.',
      },
      context: {
        type: 'string',
        enum: ['fresh', 'fork'],
        description: 'fresh starts without Lead history; fork inherits completed Lead turns. Defaults to fresh.',
      },
      provider: {
        type: 'string',
        required: true,
        description: 'LLM provider id for the teammate, for example "sophnet".',
      },
      model: {
        type: 'string',
        required: true,
        description: 'LLM model id for the teammate, for example "qwen3.8-flash".',
      },
      reasoning_effort: {
        type: 'string',
        description: 'Optional provider-specific reasoning effort for the teammate.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          target: { type: 'string', required: true },
          status: { type: 'string', required: true, enum: ['running', 'inactive', 'provisioning', 'failed'] },
          context: { type: 'string', enum: ['fresh', 'fork'] },
          provider: { type: 'string' },
          model: { type: 'string' },
          reasoningEffort: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (agent === undefined) throw new Error('spawn_teammate_modeled requires a calling Agent')
      const membership = ctx.agentTeams.membership(agent)
      if (membership.role !== 'lead') throw new Error('only the Team Lead can create teammates')

      const selected = await resolveRoute(args.provider, args.model, args.reasoning_effort)
      assertAllowed(selected)
      const prompt = [{ type: 'text', text: args.prompt }]
      const key = promptKey(prompt)
      const context = args.context ?? 'fresh'

      return await withLock(async () => {
        reservations.set(key, selected)
        try {
          const result = await ctx.agentTeams.spawnTeammate(agent, {
            name: args.name,
            description: args.description,
            prompt,
            context,
            provider: context === 'fork' ? forkProvider : freshProvider,
            signal: exec.signal,
          })
          return {
            target: result.member.name,
            status: result.member.status,
            context,
            provider: selected.provider,
            model: selected.model,
            ...(selected.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: selected.reasoningEffort }),
          }
        } finally {
          reservations.delete(key)
        }
      })
    },
  })

  /** Register the tool in every live Lead scope, and in later Leads. */
  const installed = new Map()
  const maybeInstall = (agent) => {
    if (installed.has(agent)) return
    if (ctx.agentTeams.tryMembership(agent)?.role !== 'lead') return
    installed.set(agent, agent.ctx.tools.register(tool))
  }
  for (const agent of ctx.agents.list()) maybeInstall(agent)
  ctx.on('agent/created', ({ agent }) => maybeInstall(agent))
  ctx.on('agent/disposed', ({ agent }) => {
    const dispose = installed.get(agent)
    installed.delete(agent)
    if (dispose !== undefined) dispose()
  })
  ctx.effect(() => () => {
    for (const dispose of installed.values()) dispose()
    installed.clear()
  })
}
