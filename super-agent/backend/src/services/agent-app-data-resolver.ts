/**
 * Agent App Data Resolver
 *
 * Resolves InsForge backend MCP configurations for agents operating within
 * a business scope. When a Scope Agent or Digital Twin needs to access app
 * data, this service:
 *
 * 1. Finds all published apps with InsForge backends in the given scope
 * 2. Generates MCP server configurations pointing to each app's InsForge instance
 * 3. Returns configs that can be injected into the agent's workspace settings
 *
 * This enables agents to discover and access app data through the standard
 * MCP protocol without any manual configuration.
 */

import { prisma } from '../config/database.js';
import type { MCPServerSDKConfig } from './claude-agent.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AppBackendMcpConfig {
  /** Unique key for the MCP server entry (e.g., "app-backend-crm-app") */
  key: string;
  /** Human-readable name */
  displayName: string;
  /** The app this backend belongs to */
  appId: string;
  appName: string;
  /** MCP server SDK config (compatible with Claude Agent SDK) */
  config: MCPServerSDKConfig;
}

export interface ResolverOptions {
  /** Only include apps in this scope */
  scopeId?: string;
  /** Only include a specific app */
  appId?: string;
  /** Only include active backends (default: true) */
  activeOnly?: boolean;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AgentAppDataResolverService {

  /**
   * Resolve all available InsForge MCP configs for an agent in a given org/scope.
   *
   * Returns a Record<string, MCPServerSDKConfig> that can be merged into
   * the agent's workspace settings.json mcpServers section.
   */
  async resolveForAgent(
    organizationId: string,
    options: ResolverOptions = {},
  ): Promise<Record<string, MCPServerSDKConfig>> {
    const configs = await this.getAppBackendConfigs(organizationId, options);
    const result: Record<string, MCPServerSDKConfig> = {};

    for (const cfg of configs) {
      result[cfg.key] = cfg.config;
    }

    return result;
  }

  /**
   * Get detailed app backend MCP configs (includes app metadata).
   */
  async getAppBackendConfigs(
    organizationId: string,
    options: ResolverOptions = {},
  ): Promise<AppBackendMcpConfig[]> {
    const { scopeId, appId, activeOnly = true } = options;

    // Build query conditions
    const where: Record<string, unknown> = {
      org_id: organizationId,
      backend_type: 'insforge',
      backend_instance: {
        isNot: null,
        ...(activeOnly ? { status: 'active' } : {}),
      },
    };

    if (scopeId) {
      where.business_scope_id = scopeId;
    }

    if (appId) {
      where.id = appId;
    }

    const apps = await prisma.published_apps.findMany({
      where: where as any,
      include: {
        backend_instance: true,
      },
      orderBy: { name: 'asc' },
    });

    return apps
      .filter(app => app.backend_instance)
      .map(app => {
        const instance = app.backend_instance!;
        const sanitizedName = app.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 30);

        const key = `app-data-${sanitizedName}-${app.id.slice(0, 8)}`;

        return {
          key,
          displayName: `${app.name} 数据`,
          appId: app.id,
          appName: app.name,
          config: this.buildMcpConfig(instance, app.id),
        };
      });
  }

  /**
   * Build an MCPServerSDKConfig for a single InsForge instance.
   *
   * The InsForge MCP server is accessed via streamable HTTP transport
   * at the project's app port.
   */
  private buildMcpConfig(instance: {
    host: string;
    port_app: number;
    api_key: string;
    mcp_endpoint: string | null;
  }, appId: string): MCPServerSDKConfig {
    // InsForge MCP uses stdio transport via npx
    // The schema context tells the MCP server which schema to operate on
    const schemaName = `app_${appId.replace(/-/g, '').slice(0, 12)}`;

    return {
      type: 'stdio',
      command: 'npx',
      args: [
        '-y',
        'insforge-mcp@latest',
        '--url', `http://${instance.host}:${instance.port_app}`,
        '--api-key', instance.api_key,
      ],
      env: {
        INSFORGE_URL: `http://${instance.host}:${instance.port_app}`,
        INSFORGE_API_KEY: instance.api_key,
        INSFORGE_SCHEMA: schemaName,
      },
    };
  }

  /**
   * Inject InsForge MCP configs into a workspace's settings.json.
   *
   * Called during workspace provisioning (ensureSessionWorkspace) to make
   * app backends automatically available to the agent.
   */
  async injectIntoWorkspace(
    workspacePath: string,
    organizationId: string,
    scopeId: string,
  ): Promise<number> {
    const { join } = await import('path');
    const { readFile, writeFile, mkdir } = await import('fs/promises');
    const { existsSync } = await import('fs');

    const configs = await this.resolveForAgent(organizationId, { scopeId });
    if (Object.keys(configs).length === 0) return 0;

    const settingsDir = join(workspacePath, '.claude');
    const settingsPath = join(settingsDir, 'settings.json');

    // Read existing settings or create new
    let settings: Record<string, unknown> = {};
    try {
      if (existsSync(settingsPath)) {
        const content = await readFile(settingsPath, 'utf-8');
        settings = JSON.parse(content);
      }
    } catch {
      settings = {};
    }

    // Merge MCP servers (don't overwrite existing ones)
    const existingMcp = (settings.mcpServers as Record<string, unknown>) || {};
    settings.mcpServers = { ...existingMcp, ...configs };

    // Write back
    await mkdir(settingsDir, { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

    return Object.keys(configs).length;
  }

  /**
   * Remove InsForge MCP configs from a workspace (e.g., when backend is destroyed).
   */
  async removeFromWorkspace(
    workspacePath: string,
    appId: string,
  ): Promise<void> {
    const { join } = await import('path');
    const { readFile, writeFile } = await import('fs/promises');
    const { existsSync } = await import('fs');

    const settingsPath = join(workspacePath, '.claude', 'settings.json');
    if (!existsSync(settingsPath)) return;

    try {
      const content = await readFile(settingsPath, 'utf-8');
      const settings = JSON.parse(content);
      const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
      if (!mcpServers) return;

      // Remove entries that match the app ID pattern
      const prefix = `app-data-`;
      const suffix = `-${appId.slice(0, 8)}`;
      for (const key of Object.keys(mcpServers)) {
        if (key.startsWith(prefix) && key.endsWith(suffix)) {
          delete mcpServers[key];
        }
      }

      settings.mcpServers = mcpServers;
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    } catch {
      // Non-critical — workspace may not exist
    }
  }

  /**
   * Touch activity on the InsForge instance when an agent accesses it.
   * Called by the agent runtime when MCP tools from an app backend are invoked.
   */
  async recordAgentAccess(appId: string, agentId: string, operation: string): Promise<void> {
    // Update last_active_at
    await prisma.app_backend_instances.updateMany({
      where: { app_id: appId, status: 'active' },
      data: { last_active_at: new Date() },
    });

    // TODO: Write to audit log table (agent_data_access_log)
    // For now, just log
    console.log(`[AgentAppData] Agent ${agentId} accessed app ${appId}: ${operation}`);
  }
}

export const agentAppDataResolver = new AgentAppDataResolverService();
