/**
 * Agent Runtime Factory — resolves the active AgentRuntime based on config.
 *
 * Usage:
 *   import { agentRuntime } from './agent-runtime-factory.js';
 *   yield* agentRuntime.runConversation(options, agentConfig, skills);
 */

import type { AgentRuntime } from './agent-runtime.js';
import { ClaudeAgentRuntime } from './agent-runtime-claude.js';
import { AgentCoreAgentRuntime } from './agent-runtime-agentcore.js';
import { OpenClawAgentRuntime } from './agent-runtime-openclaw.js';
import { BerriAIAgentRuntime } from './agent-runtime-berriai.js';

export type AgentRuntimeName = 'claude' | 'agentcore' | 'openclaw' | 'berriai';

function resolveRuntimeName(): AgentRuntimeName {
  const env = process.env.AGENT_RUNTIME?.toLowerCase().trim();
  if (env === 'berriai') return 'berriai';
  if (env === 'openclaw') return 'openclaw';
  if (env === 'agentcore') return 'agentcore';
  return 'claude'; // default
}

function createRuntime(name: AgentRuntimeName): AgentRuntime {
  switch (name) {
    case 'berriai':
      return new BerriAIAgentRuntime();
    case 'openclaw':
      return new OpenClawAgentRuntime();
    case 'agentcore':
      return new AgentCoreAgentRuntime();
    case 'claude':
    default:
      return new ClaudeAgentRuntime();
  }
}

const runtimeName = resolveRuntimeName();

/** The active agent runtime singleton. */
export const agentRuntime: AgentRuntime = createRuntime(runtimeName);

console.log(`[agent-runtime] Using "${agentRuntime.name}" runtime`);
