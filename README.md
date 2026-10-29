# dsh-team-model-router

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Agent Teams 成员指定模型。

插件不改 DSH 任何源文件，只在运行时补一段缺失的参数。

## 解决什么问题

`spawn_teammate` 只有四个参数（`name` / `description` / `prompt` / `context`），
成员一律继承 Lead 的模型。底层 `roster.spawn` 调 `ctx.subagents.startActivation` 时只传
`{ prompt, parent }`，而子智能体服务本身是支持 `agentOptions` 的：

```js
resolveChildAgentOptions(parent, request.agentOptions, childDepth)
```

**通道是通的，团队这条路径没填这个字段。**

创建之后再改也不行：`dsh-api-session-controller` 对子智能体会话有所有权校验
（`apiSessionSubagentOwnershipError`），Web UI 隐藏模型切换项也是同一个原因。

本插件把这个缺口从上层补上。

## 原理

1. 包装 `ctx.subagents.startActivation`：按 prompt 内容摘要匹配预留，命中时把
   `agentOptions` 塞进即将创建的请求，然后原样调用原方法。
2. 新增 Lead 专用工具 `spawn_teammate_modeled`：先用 `ctx.llm.resolveCallConfig`
   校验 provider/model 存在，再预留，再调真实的 `ctx.agentTeams.spawnTeammate`。

创建流程用锁串行化，避免并发创建时预留错配。卸载插件会自动还原被包装的方法。

## 安装

```sh
dsh plugin --profile <profile> add Koierrr/dsh-team-model-router
```

或在 profile 的 `cordis.patch.yml` 里手动加：

```yaml
- insert:
    - id: team-model-router
      name: dsh-team-model-router
      config:
        freshProvider: spawn
        forkProvider: fork
```

装完重启 DSH。

## 用法

模型只在创建成员时需要指定。工具参数：

```
spawn_teammate_modeled({
  name: "researcher",
  description: "查资料",
  prompt: "把这批文档读完，只回结论，不超过 200 字",
  provider: "sophnet",
  model: "qwen3.8-flash",
  context: "fresh"
})
```

返回：

```json
{ "target": "researcher", "status": "provisioning",
  "context": "fresh", "provider": "sophnet", "model": "qwen3.8-flash" }
```

其余行为与 `spawn_teammate` 完全一致：成员进 roster、可 `send_message`、可 `interrupt_agent`、
参与共享任务板。

## 白名单：与「子智能体」设置页共用

插件不另做配置界面，直接读 `subagent-model-selection-settings` 服务——
也就是 **「子智能体」设置页里的那个开关和模型勾选列表**：

- 页面里「允许 Agent 为子智能体选择模型」关闭时，本工具不做限制。
- 打开时，只有被勾选的 provider/model 能用来创建成员，其余直接报错并列出可选清单。

用户只在一个地方维护允许的模型。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | `spawn` | fresh 成员使用的子智能体提供方 |
| `forkProvider` | `fork` | fork 成员使用的子智能体提供方 |
| `enforceAllowedModels` | `true` | 是否跟随「子智能体」页面的模型白名单 |

一般不需要改，除非你把 Agent Teams 的 `freshProvider` / `forkProvider` 换成了自定义提供方。

## 限制

- 依赖 `startActivation` 与 `agentOptions` 这两个名字。DSH 升级改名会让插件失效；
  只会失效，不会损坏 DSH，删掉插件即恢复。
- 创建之后再换模型仍然不行（宿主层封死），要换就重新建成员。
- `fork` 成员换成和 Lead 不同的模型会让 KV 缓存失效，更慢更贵。
- 部分模型不接受 `developer` 角色消息（DSH 对新接口规范会用它替代 `system`），
  例如 sophnet 的 `qwen3.8-flash` 会直接 400；同网关的 `glm-5.3-flash` 正常。

## 测试

```sh
node smoke.mjs
```

离线跑，所有服务都是 mock，验证三件事：注入生效、普通 spawn 不受影响、错误模型被拦截。

## License

MIT
