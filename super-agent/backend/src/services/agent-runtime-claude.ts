/**
 * Claude Agent Runtime — wraps the existing ClaudeAgentService behind the
 * AgentRuntime interface. This is a thin adapter; all real logic stays in
 * claude-agent.service.ts.
 */

import type { AgentRuntime, AgentRuntimeOptions } from './agent-runtime.js';
import type { ConversationEvent, AgentConfig, MCPServerSDKConfig } from './claude-agent.service.js';
import { claudeAgentService } from './claude-agent.service.js';
import type { SkillForWorkspace } from './workspace-manager.js';

export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude';

  async *runConversation(
    options: AgentRuntimeOptions,
    agentConfig: AgentConfig,
    skills: SkillForWorkspace[],
    pluginPaths?: string[],
    mcpServers?: Record<string, MCPServerSDKConfig>
  ): AsyncGenerator<ConversationEvent> {
    try {
      yield* claudeAgentService.runConversation(
        {
          agentId: options.agentId,
          sessionId: options.sessionId,
          claudeSessionId: options.providerSessionId,
          message: options.message,
          organizationId: options.organizationId,
          userId: options.userId,
          workspacePath: options.workspacePath,
        },
        agentConfig,
        skills,
        pluginPaths,
        mcpServers
      );
    } finally {
      // Fire-and-forget: carry agent-made workspace changes back to scope DB.
      // Mirrors the behavior of the AgentCore runtime, but reads from local disk
      // since the claude runtime keeps workspaces on the local filesystem and
      // does not sync to S3.
      if (
        options.workspacePath &&
        options.sessionId &&
        options.scopeId &&
        options.scopeId !== 'default'
      ) {
        const orgId = options.organizationId;
        const scopeId = options.scopeId;
        const sessionId = options.sessionId;
        const workspacePath = options.workspacePath;
        (async () => {
          try {
            const { carryForwardService } = await import('./carry-forward.service.js');
            const result = await carryForwardService.syncFromSession(orgId, scopeId, sessionId, {
              localWorkspacePath: workspacePath,
            });
            if (
              result.skills.length > 0 ||
              result.agents.length > 0 ||
              result.claudeMdUpdated ||
              result.settingsUpdated ||
              result.hooksUpdated ||
              result.systemPromptUpdated
            ) {
              console.log(
                `[claude-runtime] Carry-forward complete: skills=${result.skills.join(',')}, agents=${result.agents.join(',')}, systemPrompt=${result.systemPromptUpdated}`
              );
            }
          } catch (err) {
            console.warn(
              '[claude-runtime] Carry-forward failed:',
              err instanceof Error ? err.message : err
            );
          }
        })();
      }
    }
  }

  async disconnectSession(sessionId: string): Promise<void> {
    return claudeAgentService.disconnectSession(sessionId);
  }

  async disconnectAll(): Promise<number> {
    return claudeAgentService.disconnectAll();
  }

  get activeSessionCount(): number {
    return claudeAgentService.activeClientCount;
  }

  hasSession(sessionId: string): boolean {
    return claudeAgentService.hasSession(sessionId);
  }
}
