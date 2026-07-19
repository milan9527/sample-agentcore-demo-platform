/**
 * Carry Forward Service
 *
 * After an agent session completes, this service reads the session workspace
 * from S3 and "carries forward" any new/modified skills, agents, CLAUDE.md
 * custom sections, settings, and hooks back to the scope's persistent DB config.
 *
 * This ensures that when a new session is created for the same scope, it
 * inherits all the configuration changes made by previous sessions.
 */

import { createHash } from 'crypto';
import { readdir, readFile, stat } from 'fs/promises';
import { join, relative } from 'path';
import {
  S3Client,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { config } from '../config/index.js';
import { prisma } from '../config/database.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CarryForwardResult {
  skills: string[];
  agents: string[];
  claudeMdUpdated: boolean;
  settingsUpdated: boolean;
  hooksUpdated: boolean;
  systemPromptUpdated: boolean;
}

// Marker used to separate auto-generated CLAUDE.md content from agent-customized content
const CLAUDE_MD_CUSTOM_MARKER = '<!-- CUSTOM_SECTION: Agent-generated rules below -->';

// ---------------------------------------------------------------------------
// File source abstraction (S3 or local disk)
//
// carry-forward was originally built to read from S3 (AgentCore flow).
// The local `claude` runtime keeps workspaces on disk and never uploads to S3,
// so we abstract file access behind a small interface and provide two impls.
// ---------------------------------------------------------------------------

interface FileEntry {
  /** Path of the file relative to the workspace root (uses forward slashes). */
  relativePath: string;
  size: number;
}

interface FileSource {
  /** List files under a directory path (relative to workspace root). */
  list(dirRelPath: string): Promise<FileEntry[]>;
  /** Read a file's UTF-8 text content. Returns null on miss or error. */
  readText(relPath: string): Promise<string | null>;
  /** Read a file's raw bytes. Returns null on miss or error. */
  readBuffer(relPath: string): Promise<Buffer | null>;
}

class S3FileSource implements FileSource {
  constructor(
    private readonly bucket: string,
    private readonly prefix: string
  ) {}

  async list(dirRelPath: string): Promise<FileEntry[]> {
    const fullPrefix = `${this.prefix}${dirRelPath}`;
    const entries: FileEntry[] = [];
    let continuationToken: string | undefined;
    do {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: fullPrefix,
          ContinuationToken: continuationToken,
        })
      );
      for (const obj of result.Contents ?? []) {
        if (obj.Key && obj.Size) {
          entries.push({
            relativePath: obj.Key.slice(this.prefix.length),
            size: obj.Size,
          });
        }
      }
      continuationToken = result.NextContinuationToken;
    } while (continuationToken);
    return entries;
  }

  async readText(relPath: string): Promise<string | null> {
    try {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}${relPath}`,
        })
      );
      return (await result.Body?.transformToString('utf-8')) ?? null;
    } catch {
      return null;
    }
  }

  async readBuffer(relPath: string): Promise<Buffer | null> {
    try {
      const result = await s3.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: `${this.prefix}${relPath}`,
        })
      );
      const bytes = await result.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : null;
    } catch {
      return null;
    }
  }
}

class LocalFileSource implements FileSource {
  constructor(private readonly rootPath: string) {}

  async list(dirRelPath: string): Promise<FileEntry[]> {
    const startDir = join(this.rootPath, dirRelPath);
    const entries: FileEntry[] = [];
    const walk = async (dir: string): Promise<void> => {
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const dirent of dirents) {
        const full = join(dir, dirent.name);
        if (dirent.isDirectory()) {
          await walk(full);
        } else if (dirent.isFile()) {
          try {
            const st = await stat(full);
            entries.push({
              relativePath: relative(this.rootPath, full).split('\\').join('/'),
              size: st.size,
            });
          } catch {
            /* skip */
          }
        }
      }
    };
    await walk(startDir);
    return entries;
  }

  async readText(relPath: string): Promise<string | null> {
    try {
      return await readFile(join(this.rootPath, relPath), 'utf-8');
    } catch {
      return null;
    }
  }

  async readBuffer(relPath: string): Promise<Buffer | null> {
    try {
      return await readFile(join(this.rootPath, relPath));
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const s3 = new S3Client({ region: config.agentcore.region ?? config.aws.region });
const WORKSPACE_BUCKET = config.agentcore.workspaceS3Bucket;
const SKILLS_BUCKET = config.s3.skillsBucket;

class CarryForwardService {
  /**
   * Per-scope locks to serialize concurrent carry-forward operations.
   * Without this, two sessions finishing at nearly the same moment can
   * interleave writes to the same scope (especially CLAUDE.md custom
   * section and hooks), causing lost updates.
   *
   * In-memory Mutex is enough for a single backend process. Scale-out to
   * multiple backend instances would require a Postgres advisory lock
   * (same key scheme: hash(scopeId)).
   */
  private scopeLocks = new Map<string, Promise<void>>();

  private async withScopeLock<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.scopeLocks.get(scopeId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.scopeLocks.set(
      scopeId,
      prev.then(() => next)
    );
    try {
      await prev;
      return await fn();
    } finally {
      release();
      // If no one chained after us, clear the map entry to avoid leak
      if (
        this.scopeLocks.get(scopeId) === next ||
        this.scopeLocks.get(scopeId) === prev.then(() => next)
      ) {
        this.scopeLocks.delete(scopeId);
      }
    }
  }

  /**
   * Main entry point: sync workspace changes from a completed session back to scope DB.
   *
   * @param opts.localWorkspacePath  Optional local workspace path. When provided,
   *   files are read from local disk instead of S3 (used by the local claude
   *   runtime, which doesn't sync to S3).
   */
  async syncFromSession(
    orgId: string,
    scopeId: string,
    sessionId: string,
    opts?: { localWorkspacePath?: string }
  ): Promise<CarryForwardResult> {
    return this.withScopeLock(scopeId, () =>
      this.doSyncFromSession(orgId, scopeId, sessionId, opts)
    );
  }

  private async doSyncFromSession(
    orgId: string,
    scopeId: string,
    sessionId: string,
    opts?: { localWorkspacePath?: string }
  ): Promise<CarryForwardResult> {
    const prefix = `${orgId}/${scopeId}/${sessionId}/`;
    const source: FileSource = opts?.localWorkspacePath
      ? new LocalFileSource(opts.localWorkspacePath)
      : new S3FileSource(WORKSPACE_BUCKET, prefix);

    const result: CarryForwardResult = {
      skills: [],
      agents: [],
      claudeMdUpdated: false,
      settingsUpdated: false,
      hooksUpdated: false,
      systemPromptUpdated: false,
    };

    try {
      // 1. Carry skills
      result.skills = await this.carrySkills(orgId, scopeId, source);

      // 2. Carry agents (subagent .md files)
      result.agents = await this.carryAgents(orgId, scopeId, source);

      // 3. Carry CLAUDE.md custom section
      result.claudeMdUpdated = await this.carryClaudeMd(orgId, scopeId, source);

      // 4. Carry scope system prompt
      result.systemPromptUpdated = await this.carrySystemPrompt(orgId, scopeId, source);

      // 5. Carry settings (MCP servers from settings.json)
      result.settingsUpdated = await this.carrySettings(orgId, scopeId, source);

      // 6. Carry hooks
      result.hooksUpdated = await this.carryHooks(orgId, scopeId, source);

      // 7. Bump config version if anything changed
      const hasChanges =
        result.skills.length > 0 ||
        result.agents.length > 0 ||
        result.claudeMdUpdated ||
        result.settingsUpdated ||
        result.hooksUpdated ||
        result.systemPromptUpdated;

      if (hasChanges) {
        await this.bumpConfigVersion(scopeId, orgId);
        console.log(
          `[carry-forward] Scope ${scopeId} updated: skills=${result.skills.length}, agents=${result.agents.length}, claudeMd=${result.claudeMdUpdated}, systemPrompt=${result.systemPromptUpdated}, settings=${result.settingsUpdated}, hooks=${result.hooksUpdated}`
        );
      } else {
        console.log(
          `[carry-forward] No changes detected for scope ${scopeId} from session ${sessionId}`
        );
      }
    } catch (err) {
      console.error(`[carry-forward] Failed for scope=${scopeId} session=${sessionId}:`, err);
    }

    return result;
  }

  // =========================================================================
  // Skills
  // =========================================================================

  /**
   * Carry skills from session workspace to scope.
   *
   * Behavior per skill (keyed by name):
   *   - Built-in skill name → skip
   *   - Skill with same name owned by OTHER scope / org-level → skip (conflict)
   *   - Skill with same name owned by THIS scope → update if contentHash changed
   *   - No existing skill with that name → create new (scope-owned)
   */
  private async carrySkills(orgId: string, scopeId: string, source: FileSource): Promise<string[]> {
    const entries = await source.list('.claude/skills/');
    if (entries.length === 0) return [];

    // Group files by skill name (first path segment after .claude/skills/)
    const skillFiles = new Map<string, FileEntry[]>();
    for (const entry of entries) {
      const sub = entry.relativePath.slice('.claude/skills/'.length);
      const skillName = sub.split('/')[0];
      if (!skillName) continue;
      if (!skillFiles.has(skillName)) skillFiles.set(skillName, []);
      skillFiles.get(skillName)!.push(entry);
    }

    // Skills owned by this scope (candidates for update)
    const scopeOwnedSkills = await prisma.skills.findMany({
      where: { organization_id: orgId, business_scope_id: scopeId, status: 'active' },
      select: {
        id: true,
        name: true,
        hash_id: true,
        version: true,
        s3_prefix: true,
        metadata: true,
      },
    });
    const scopeOwnedByName = new Map(scopeOwnedSkills.map((s) => [s.name, s]));

    // Skills with same names owned by OTHER scopes or at org level — cannot touch
    const candidateNames = Array.from(skillFiles.keys());
    const conflictingSkills =
      candidateNames.length > 0
        ? await prisma.skills.findMany({
            where: {
              organization_id: orgId,
              status: 'active',
              name: { in: candidateNames },
              NOT: { business_scope_id: scopeId },
            },
            select: { name: true },
          })
        : [];
    const cannotTouchNames = new Set(conflictingSkills.map((s) => s.name));

    // Built-in skill names to skip
    const BUILTIN_SKILLS = new Set([
      'app-builder',
      'app-publisher',
      'skill-creator',
      'knowledge-search',
    ]);

    const carried: string[] = [];

    for (const [skillName, files] of skillFiles) {
      if (BUILTIN_SKILLS.has(skillName)) continue;
      if (cannotTouchNames.has(skillName)) {
        console.log(
          `[carry-forward] Skill name "${skillName}" conflicts with existing skill in another scope — skipping`
        );
        continue;
      }

      const skillMdEntry = files.find((f) => f.relativePath.endsWith('SKILL.md'));
      if (!skillMdEntry) continue;

      try {
        // Read all files once; compute content hash and keep buffers for upload
        const fileBuffers: Array<{ relPath: string; buffer: Buffer }> = [];
        for (const file of files) {
          const buf = await source.readBuffer(file.relativePath);
          if (!buf) continue;
          // Strip ".claude/skills/{skillName}/" prefix to get path relative to skill root
          const sub = file.relativePath.slice('.claude/skills/'.length + skillName.length + 1);
          if (!sub) continue;
          fileBuffers.push({ relPath: sub, buffer: buf });
        }
        const skillMdBuf = fileBuffers.find((f) => f.relPath === 'SKILL.md')?.buffer;
        if (!skillMdBuf) continue;
        const skillMdContent = skillMdBuf.toString('utf-8');
        const contentHash = this.computeSkillContentHash(fileBuffers);

        const existing = scopeOwnedByName.get(skillName);

        if (existing) {
          // Update path: same name, same scope
          const meta = (existing.metadata as Record<string, unknown> | null) ?? {};
          const prevHash = meta.contentHash as string | undefined;
          if (prevHash === contentHash) continue; // content identical — nothing to do

          // Re-upload all files to the existing s3_prefix (overwrite)
          for (const { relPath, buffer } of fileBuffers) {
            await s3.send(
              new PutObjectCommand({
                Bucket: SKILLS_BUCKET,
                Key: `${existing.s3_prefix}${relPath}`,
                Body: buffer,
              })
            );
          }

          const newVersion = this.bumpPatchVersion(existing.version);
          const description = this.extractSkillDescription(skillMdContent);

          await prisma.skills.update({
            where: { id: existing.id },
            data: {
              description,
              version: newVersion,
              metadata: {
                ...meta,
                source: meta.source ?? 'carry-forward',
                contentHash,
                lastCarriedAt: new Date().toISOString(),
              },
            },
          });

          carried.push(skillName);
          console.log(`[carry-forward] Updated skill: ${skillName} → v${newVersion}`);
        } else {
          // Create path: brand new
          const hashId = this.generateHashId(orgId, skillName);
          const s3Prefix = `skills/${hashId}/`;

          for (const { relPath, buffer } of fileBuffers) {
            await s3.send(
              new PutObjectCommand({
                Bucket: SKILLS_BUCKET,
                Key: `${s3Prefix}${relPath}`,
                Body: buffer,
              })
            );
          }

          const description = this.extractSkillDescription(skillMdContent);

          await prisma.skills.create({
            data: {
              organization_id: orgId,
              business_scope_id: scopeId,
              name: skillName,
              display_name: skillName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              description,
              hash_id: hashId,
              s3_bucket: SKILLS_BUCKET,
              s3_prefix: s3Prefix,
              version: '1.0.0',
              status: 'active',
              skill_type: 'general',
              tags: ['session-generated'],
              metadata: { source: 'carry-forward', contentHash },
            },
          });

          carried.push(skillName);
          console.log(`[carry-forward] Carried skill: ${skillName}`);
        }
      } catch (err) {
        console.warn(`[carry-forward] Failed to carry skill "${skillName}":`, err);
      }
    }

    return carried;
  }

  /** Stable content hash over all files in a skill directory. */
  private computeSkillContentHash(files: Array<{ relPath: string; buffer: Buffer }>): string {
    const sorted = [...files].sort((a, b) => a.relPath.localeCompare(b.relPath));
    const h = createHash('sha256');
    for (const f of sorted) {
      h.update(f.relPath);
      h.update('\0');
      h.update(f.buffer);
      h.update('\0');
    }
    return h.digest('hex');
  }

  /** Bump the patch component of a semver string; safe on malformed input. */
  private bumpPatchVersion(version: string): string {
    const parts = version.split('.');
    if (parts.length !== 3) return '1.0.1';
    const patch = parseInt(parts[2] ?? '0', 10);
    return `${parts[0]}.${parts[1]}.${Number.isNaN(patch) ? 1 : patch + 1}`;
  }

  // =========================================================================
  // Agents (subagent .md files)
  // =========================================================================

  private async carryAgents(orgId: string, scopeId: string, source: FileSource): Promise<string[]> {
    const entries = await source.list('.claude/agents/');
    if (entries.length === 0) return [];

    // Only process .md files directly under .claude/agents/
    const AGENTS_DIR = '.claude/agents/';
    const agentMdFiles = entries.filter((e) => {
      if (!e.relativePath.startsWith(AGENTS_DIR)) return false;
      const sub = e.relativePath.slice(AGENTS_DIR.length);
      return sub.endsWith('.md') && !sub.includes('/');
    });

    // Get existing agents for this scope
    const existingAgents = await prisma.agents.findMany({
      where: { organization_id: orgId, business_scope_id: scopeId },
      select: { id: true, name: true, system_prompt: true },
    });
    const existingMap = new Map(existingAgents.map((a) => [a.name, a]));

    const carried: string[] = [];

    for (const entry of agentMdFiles) {
      const fileName = entry.relativePath.slice(AGENTS_DIR.length);
      const agentName = fileName.replace(/\.md$/, '');
      if (!agentName) continue;

      try {
        const mdContent = await source.readText(entry.relativePath);
        if (!mdContent) continue;

        // Parse frontmatter to extract metadata
        const parsed = this.parseAgentMd(mdContent);

        const existing = existingMap.get(agentName);
        if (existing) {
          // Agent exists — check if content changed
          if (existing.system_prompt !== parsed.systemPrompt) {
            await prisma.agents.update({
              where: { id: existing.id },
              data: { system_prompt: parsed.systemPrompt, role: parsed.role },
            });
            carried.push(agentName);
            console.log(`[carry-forward] Updated agent: ${agentName}`);
          }
        } else {
          // New agent — create it
          await prisma.agents.create({
            data: {
              organization_id: orgId,
              business_scope_id: scopeId,
              name: agentName,
              display_name:
                parsed.displayName ||
                agentName.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
              role: parsed.role,
              system_prompt: parsed.systemPrompt,
              status: 'idle',
              origin: 'session_generated',
              model_config: {},
              tools: [],
              scope: [],
              metrics: {},
            },
          });
          carried.push(agentName);
          console.log(`[carry-forward] Created agent: ${agentName}`);
        }
      } catch (err) {
        console.warn(`[carry-forward] Failed to carry agent "${agentName}":`, err);
      }
    }

    return carried;
  }

  // =========================================================================
  // CLAUDE.md custom section
  // =========================================================================

  private async carryClaudeMd(
    _orgId: string,
    scopeId: string,
    source: FileSource
  ): Promise<boolean> {
    const content = await source.readText('CLAUDE.md');
    if (!content) return false;

    // Extract custom section (below marker)
    const markerIdx = content.indexOf(CLAUDE_MD_CUSTOM_MARKER);
    if (markerIdx === -1) return false; // No custom section

    const customSection = content.substring(markerIdx + CLAUDE_MD_CUSTOM_MARKER.length).trim();
    if (!customSection) return false;

    // Read current scope settings
    const scope = await prisma.business_scopes.findUnique({
      where: { id: scopeId },
      select: { settings: true },
    });

    const currentSettings = (scope?.settings as Record<string, unknown>) ?? {};
    const currentCustomMd = (currentSettings.customClaudeMd as string) ?? '';

    if (currentCustomMd === customSection) return false; // No change

    // Update scope settings with custom CLAUDE.md section
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: {
        settings: { ...currentSettings, customClaudeMd: customSection } as any,
      },
    });

    console.log(`[carry-forward] Updated CLAUDE.md custom section (${customSection.length} chars)`);
    return true;
  }

  // =========================================================================
  // Scope system prompt
  //
  // The scope's system_prompt is surfaced into the workspace as a dedicated
  // editable file (.claude/scope-system-prompt.md). If the agent edits this
  // file during a session, carry the updated content back to the DB so future
  // sessions start with the evolved system prompt.
  //
  // A leading YAML frontmatter block (if present) is stripped; we only keep
  // the prose body as the effective system prompt.
  // =========================================================================

  private async carrySystemPrompt(
    _orgId: string,
    scopeId: string,
    source: FileSource
  ): Promise<boolean> {
    const content = await source.readText('.claude/scope-system-prompt.md');
    if (content === null) return false;

    // Strip leading frontmatter block, if any
    let body = content;
    if (body.startsWith('---')) {
      const endIdx = body.indexOf('\n---', 3);
      if (endIdx > 0) {
        body = body.slice(endIdx + 4).replace(/^\r?\n/, '');
      }
    }
    // Strip HTML comments (legacy markers that should not be persisted)
    body = body.replace(/<!--[\s\S]*?-->\s*/g, '');
    body = body.trim();

    const scope = await prisma.business_scopes.findUnique({
      where: { id: scopeId },
      select: { system_prompt: true },
    });
    if (!scope) return false;

    const current = (scope.system_prompt ?? '').trim();
    // Treat empty body as "clear the system prompt" only if it was non-empty before
    if (body === current) return false;

    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { system_prompt: body.length > 0 ? body : null },
    });

    console.log(`[carry-forward] Updated scope system_prompt (${body.length} chars)`);
    return true;
  }

  // =========================================================================
  // Settings (MCP servers)
  // =========================================================================

  private async carrySettings(
    orgId: string,
    scopeId: string,
    source: FileSource
  ): Promise<boolean> {
    const content = await source.readText('.claude/settings.json');
    if (!content) return false;

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(content);
    } catch {
      return false;
    }

    const mcpServers = settings.mcpServers as Record<string, unknown> | undefined;
    if (!mcpServers || Object.keys(mcpServers).length === 0) return false;

    // Get existing MCP servers for this scope
    const existingScopeMcp = await prisma.scope_mcp_servers.findMany({
      where: { business_scope_id: scopeId },
      include: { mcp_server: { select: { name: true } } },
    });
    const existingNames = new Set(existingScopeMcp.map((sm) => sm.mcp_server.name));

    // Built-in MCP server names to skip
    const BUILTIN_MCP = new Set(['agentcore-tools']);

    let added = false;

    for (const [name, serverConfig] of Object.entries(mcpServers)) {
      if (BUILTIN_MCP.has(name)) continue;
      if (existingNames.has(name)) continue;

      const cfg = serverConfig as Record<string, unknown>;
      const type = (cfg.type as string) || 'stdio';

      try {
        // Create MCP server record
        const mcpServer = await prisma.mcp_servers.create({
          data: {
            organization_id: orgId,
            name,
            description: `Auto-carried from session`,
            host_address:
              type === 'sse' || type === 'http'
                ? (cfg.url as string) || ''
                : [cfg.command, ...(Array.isArray(cfg.args) ? cfg.args : [])].join(' '),
            config: cfg as any,
            status: 'active',
          },
        });

        // Link to scope
        await prisma.scope_mcp_servers.create({
          data: {
            business_scope_id: scopeId,
            mcp_server_id: mcpServer.id,
          },
        });

        added = true;
        console.log(`[carry-forward] Carried MCP server: ${name}`);
      } catch (err) {
        console.warn(`[carry-forward] Failed to carry MCP server "${name}":`, err);
      }
    }

    return added;
  }

  // =========================================================================
  // Hooks
  // =========================================================================

  private async carryHooks(_orgId: string, scopeId: string, source: FileSource): Promise<boolean> {
    // Hooks are embedded in .claude/settings.json (same file parsed by carrySettings)
    const content = await source.readText('.claude/settings.json');
    if (!content) return false;

    let settings: Record<string, unknown>;
    try {
      settings = JSON.parse(content);
    } catch {
      return false;
    }

    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks || Object.keys(hooks).length === 0) return false;

    // Store hooks in scope settings JSON
    const scope = await prisma.business_scopes.findUnique({
      where: { id: scopeId },
      select: { settings: true },
    });

    const currentSettings = (scope?.settings as Record<string, unknown>) ?? {};
    const currentHooks = currentSettings.hooks as Record<string, unknown> | undefined;

    // Simple equality check
    if (JSON.stringify(currentHooks) === JSON.stringify(hooks)) return false;

    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: {
        settings: { ...currentSettings, hooks } as any,
      },
    });

    console.log(`[carry-forward] Updated hooks config`);
    return true;
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async bumpConfigVersion(scopeId: string, _orgId: string): Promise<void> {
    await prisma.business_scopes.update({
      where: { id: scopeId },
      data: { config_version: { increment: 1 } },
    });
  }

  private generateHashId(orgId: string, name: string): string {
    const hash = createHash('sha256');
    hash.update(`${orgId}:${name}:${Date.now()}`);
    return hash.digest('hex').substring(0, 16);
  }

  private extractSkillDescription(skillMd: string): string | null {
    const lines = skillMd.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('---')) continue;
      return trimmed.substring(0, 500);
    }
    return null;
  }

  private parseAgentMd(content: string): {
    displayName: string;
    role: string | null;
    systemPrompt: string;
    skills: string[];
  } {
    let displayName = '';
    let role: string | null = null;
    let systemPrompt = content;
    let skills: string[] = [];

    // Parse YAML frontmatter if present
    if (content.startsWith('---')) {
      const endIdx = content.indexOf('---', 3);
      if (endIdx > 0) {
        const frontmatter = content.substring(3, endIdx).trim();
        systemPrompt = content.substring(endIdx + 3).trim();

        for (const line of frontmatter.split('\n')) {
          const [key, ...valueParts] = line.split(':');
          const value = valueParts.join(':').trim();
          if (!key || !value) continue;

          switch (key.trim()) {
            case 'name':
              // name is the identifier, not display name
              break;
            case 'description':
              // "DisplayName — Role. Use when..."
              const dashIdx = value.indexOf('—');
              if (dashIdx > 0) {
                displayName = value.substring(0, dashIdx).trim();
                const afterDash = value.substring(dashIdx + 1).trim();
                const dotIdx = afterDash.indexOf('.');
                role = dotIdx > 0 ? afterDash.substring(0, dotIdx).trim() : afterDash;
              } else {
                displayName = value;
              }
              break;
            case 'skills':
              skills = value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
              break;
          }
        }
      }
    }

    return { displayName, role, systemPrompt, skills };
  }
}

export const carryForwardService = new CarryForwardService();
