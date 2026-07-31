/**
 * Agent Runner — wraps Claude Agent SDK query() for AgentCore invocations.
 *
 * Yields AgentEvent objects that get serialized as SSE `data:` lines.
 *
 * S3 sync strategy (replaces file-watcher.ts):
 *   - PostToolUse hook (Write|Edit): incremental sync of modified file to S3
 *   - Stop hook: full diff sync to S3 as safety net
 */

import { query } from '@anthropic-ai/claude-agent-sdk'; 
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { syncWorkspaceToS3 } from './workspace-sync.js';
import fs from 'fs';
import { execSync } from 'child_process';
import type { AgentPayload, AgentEvent, ContentBlock } from './types.js';
import { beginInvocation, parentContextFromHeaders, type InvocationTrace } from './otel.js';

const DEFAULT_TOOLS = [
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
  'WebSearch', 'WebFetch', 'Task', 'Skill',
  'TodoWrite', 'ToolSearch', 'NotebookEdit',
];

const s3 = new S3Client({ region: process.env.WORKSPACE_S3_REGION ?? 'us-east-1' });

// ---------------------------------------------------------------------------
// SDK Hooks for S3 sync (replaces file-watcher.ts)
// ---------------------------------------------------------------------------

/**
 * PostToolUse hook: after agent writes/edits a file, sync that single file to S3.
 * The hook input contains tool_input.file_path with the exact file modified.
 */
function createFileChangeHook(bucket: string, prefix: string) {
  return async (input: any, _toolUseId: string | undefined) => {
    const filePath: string | undefined = input?.tool_input?.file_path
      ?? input?.tool_input?.path;

    if (!filePath || !filePath.startsWith('/workspace/')) return {};

    const relativePath = filePath.replace('/workspace/', '');

    // Skip auto-generated directories that should never be synced to S3
    const firstSegment = relativePath.split('/')[0];
    const SKIP_PREFIXES = new Set([
      'node_modules', '.git', '__pycache__', '.venv', 'venv',
      '.next', '.nuxt', '.turbo', '.cache', '.parcel-cache',
      'bower_components', '.gradle', 'target', '.cargo',
    ]);
    if (SKIP_PREFIXES.has(firstSegment)) return {};

    const key = `${prefix}${relativePath}`;

    try {
      if (!fs.existsSync(filePath)) return {}; // file was deleted by the tool
      const content = fs.readFileSync(filePath);
      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: content,
        ContentLength: content.length,
      }));
      console.log(`[hook:PostToolUse] Synced ${relativePath} → s3://${bucket}/${key}`);
    } catch (err) {
      console.warn(`[hook:PostToolUse] Failed to sync ${relativePath}:`, err);
    }

    return {};
  };
}

/**
 * Stop hook: after agent finishes, do a full workspace sync to S3.
 * Catches files created by Bash tool or other indirect means.
 * Also extracts git diff and uploads it as __diff__.json.
 */
function createStopHook(bucket: string, prefix: string) {
  return async () => {
    // Fire-and-forget: run diff extraction + full S3 sync in the background
    // so the agent result is returned immediately without waiting for sync.
    // PostToolUse hooks already handle incremental file sync for Write/Edit,
    // and the frontend reads files directly from the container while it's alive.
    // This full sync is just a safety net for files created via Bash or other
    // indirect means.
    (async () => {
      try {
        extractAndUploadDiff(bucket, prefix);
      } catch (err) {
        console.warn('[hook:Stop] Diff extraction failed:', err);
      }

      try {
        const count = await syncWorkspaceToS3(s3, bucket, prefix);
        if (count > 0) {
          console.log(`[hook:Stop] Final sync: ${count} files → s3://${bucket}/${prefix}`);
        }
      } catch (err) {
        console.warn('[hook:Stop] Final sync failed:', err);
      }
    })();

    return {};
  };
}

// ---------------------------------------------------------------------------
// Git baseline & diff extraction
// ---------------------------------------------------------------------------

const WORKSPACE_DIR = '/workspace';

/**
 * Create a git baseline snapshot of the current workspace state.
 * Called BEFORE the agent runs so we can diff against it later.
 */
export function createGitBaseline(): boolean {
  try {
    // Check if git is available
    execSync('which git', { stdio: 'ignore' });
  } catch {
    console.warn('[git-diff] git not available in container, skipping baseline');
    return false;
  }

  try {
    // Configure git (required for commit)
    execSync('git config user.email "agent@superagent.local"', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    execSync('git config user.name "Agent"', { cwd: WORKSPACE_DIR, stdio: 'ignore' });

    // Init repo if not already (idempotent)
    execSync('git init', { cwd: WORKSPACE_DIR, stdio: 'ignore' });

    // Stage everything and commit as baseline
    execSync('git add -A', { cwd: WORKSPACE_DIR, stdio: 'ignore' });

    // Check if there's anything to commit
    try {
      execSync('git diff --cached --quiet', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
      // No changes staged — either empty workspace or already committed
      // Try committing anyway (might be initial commit)
      try {
        execSync('git commit -m "baseline" --allow-empty', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
      } catch { /* already committed, fine */ }
    } catch {
      // There are staged changes, commit them
      execSync('git commit -m "baseline"', { cwd: WORKSPACE_DIR, stdio: 'ignore' });
    }

    console.log('[git-diff] Baseline snapshot created');
    return true;
  } catch (err) {
    console.warn('[git-diff] Failed to create baseline:', err instanceof Error ? err.message : err);
    return false;
  }
}

/**
 * Extract diff between baseline and current state, upload as __diff__.json to S3.
 */
function extractAndUploadDiff(bucket: string, prefix: string): void {
  // Check if git repo exists
  if (!fs.existsSync(`${WORKSPACE_DIR}/.git`)) {
    console.log('[git-diff] No git repo found, skipping diff extraction');
    return;
  }

  try {
    // Stage all current changes
    execSync('git add -A', { cwd: WORKSPACE_DIR, stdio: 'ignore' });

    // Get diff stat (structured)
    let diffStatOutput = '';
    try {
      diffStatOutput = execSync('git diff --cached --numstat HEAD', {
        cwd: WORKSPACE_DIR,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch { /* no changes */ }

    if (!diffStatOutput) {
      console.log('[git-diff] No changes detected');
      return;
    }

    // Parse numstat: "insertions\tdeletions\tfilepath"
    const files: Array<{ path: string; status: string; insertions: number; deletions: number }> = [];
    for (const line of diffStatOutput.split('\n')) {
      if (!line.trim()) continue;
      const [ins, del, filePath] = line.split('\t');
      // Binary files show as "-\t-\tfilepath"
      const insertions = ins === '-' ? 0 : parseInt(ins, 10) || 0;
      const deletions = del === '-' ? 0 : parseInt(del, 10) || 0;
      files.push({ path: filePath, status: 'modified', insertions, deletions });
    }

    // Get name-status to determine add/modify/delete
    let nameStatusOutput = '';
    try {
      nameStatusOutput = execSync('git diff --cached --name-status HEAD', {
        cwd: WORKSPACE_DIR,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      }).trim();
    } catch { /* ignore */ }

    const statusMap = new Map<string, string>();
    for (const line of nameStatusOutput.split('\n')) {
      if (!line.trim()) continue;
      const [status, ...pathParts] = line.split('\t');
      const filePath = pathParts.join('\t'); // handle paths with tabs (unlikely but safe)
      const statusLabel = status.startsWith('A') ? 'added'
        : status.startsWith('D') ? 'deleted'
        : status.startsWith('R') ? 'renamed'
        : 'modified';
      statusMap.set(filePath, statusLabel);
    }

    // Merge status into files
    for (const f of files) {
      f.status = statusMap.get(f.path) ?? f.status;
    }

    const totalInsertions = files.reduce((sum, f) => sum + f.insertions, 0);
    const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

    const diffStat = {
      files_changed: files.length,
      insertions: totalInsertions,
      deletions: totalDeletions,
      files,
    };

    // Get full unified diff (capped at 1MB to avoid huge diffs)
    let diffPatch = '';
    try {
      diffPatch = execSync('git diff --cached HEAD', {
        cwd: WORKSPACE_DIR,
        encoding: 'utf-8',
        maxBuffer: 10 * 1024 * 1024,
      });
    } catch { /* ignore if too large */ }

    // Cap patch size at 1MB
    if (diffPatch.length > 1024 * 1024) {
      diffPatch = diffPatch.substring(0, 1024 * 1024) + '\n\n... (diff truncated, exceeded 1MB)';
    }

    const diffData = {
      diff_stat: diffStat,
      diff_patch: diffPatch,
      created_at: new Date().toISOString(),
    };

    // Upload to S3 as __diff__.json
    const key = `${prefix}__diff__.json`;
    s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: JSON.stringify(diffData),
      ContentType: 'application/json',
    })).then(() => {
      console.log(`[git-diff] Uploaded diff (${files.length} files, +${totalInsertions}/-${totalDeletions}) → s3://${bucket}/${key}`);
    }).catch(err => {
      console.warn('[git-diff] Failed to upload diff to S3:', err);
    });

  } catch (err) {
    console.warn('[git-diff] Diff extraction failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Agent execution
// ---------------------------------------------------------------------------

export async function* runAgent(
  payload: AgentPayload,
  requestHeaders?: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  // One OTEL invocation trace per turn. Created up front so PreToolUse/PostToolUse
  // hooks (registered below) can attach tool spans to it. Session correlation
  // uses the AgentCore session id (chat_session_id / session_id from backend).
  // If the platform forwarded a trace context (traceparent/X-Amzn-Trace-Id),
  // parent our root span on it so the platform's AgentCore.Runtime.Invoke span
  // and our spans form ONE connected trace (the console groups a session's work
  // into one trace this way) instead of two disconnected roots.
  const otelSessionId = payload.chat_session_id ?? payload.session_id ?? 'unknown-session';
  const parentCtx = parentContextFromHeaders(requestHeaders);
  const inv = beginInvocation(otelSessionId, payload.prompt, parentCtx);

  const baseOptions: Record<string, unknown> = {
    systemPrompt: payload.system_prompt ?? undefined,
    allowedTools: payload.allowed_tools ?? DEFAULT_TOOLS,
    cwd: '/workspace',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: ['project'],
  };

  // Dynamic model override: pass directly to SDK options so it takes effect
  // per-invocation (env var approach only works for the first call in a session).
  if (payload.model) {
    baseOptions.model = payload.model;
    console.log(`[agent-runner] Model override via options: ${payload.model}`);
  }

  // Per-invocation provider routing via SDK options.env (defaults to process.env).
  // litellm → point the SDK at an Anthropic-compatible gateway; bedrock → the
  // container's default Bedrock config. Never log the api_key.
  const provider = payload.provider ?? 'bedrock';
  if (provider === 'litellm') {
    // Drive the CLI with the `opus` alias and remap that alias to the gateway's
    // actual model id — the CLI rewrites its built-in aliases to canonical
    // Anthropic ids that a custom gateway may reject.
    const gatewayModel = payload.model;
    const env = { ...process.env } as Record<string, string | undefined>;
    if (payload.base_url) env.ANTHROPIC_BASE_URL = payload.base_url;
    if (payload.api_key) { env.ANTHROPIC_AUTH_TOKEN = payload.api_key; env.ANTHROPIC_API_KEY = payload.api_key; }
    if (gatewayModel) {
      env.ANTHROPIC_MODEL = 'opus';
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = gatewayModel;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = gatewayModel;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = gatewayModel;
      env.ANTHROPIC_SMALL_FAST_MODEL = gatewayModel;
      baseOptions.model = 'opus';
    }
    // Use gateway auth only — no Bedrock, no stored OAuth session.
    delete env.CLAUDE_CODE_USE_BEDROCK;
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_PROFILE;
    baseOptions.env = env;
    baseOptions.settingSources = ['project'];
    console.log(`[agent-runner] Provider=litellm base_url=${payload.base_url ?? '(none)'} model=${gatewayModel ?? '(none)'}`);
  } else {
    baseOptions.env = {
      ...process.env,
      CLAUDE_CODE_USE_BEDROCK: '1',
      ...(payload.model ? { ANTHROPIC_MODEL: payload.model } : {}),
    };
    delete (baseOptions.env as Record<string, string | undefined>).ANTHROPIC_BASE_URL;
    delete (baseOptions.env as Record<string, string | undefined>).ANTHROPIC_AUTH_TOKEN;
    console.log(`[agent-runner] Provider=bedrock model=${payload.model ?? '(default)'}`);
  }

  if (payload.mcp_servers && Object.keys(payload.mcp_servers).length > 0) {
    baseOptions.mcpServers = payload.mcp_servers;
  }

  // Register hooks: OTEL tool tracing (every tool) + S3 sync (Write/Edit).
  //
  // Tool spans are captured via PreToolUse/PostToolUse hooks rather than the
  // assistant event stream, because the SDK does NOT surface every tool_use as
  // an assistant-content block (multi-turn runs dropped ~1-2 tools that way).
  // Hooks fire for EVERY tool with tool_name/tool_input/tool_use_id (Pre) and
  // tool_response (Post) — 100% coverage, authoritative.
  const bucket = payload.workspace_s3_bucket;
  const prefix = payload.workspace_s3_prefix;
  const preToolHooks: unknown[] = [];
  const postToolMatchers: unknown[] = [];

  if (inv) {
    preToolHooks.push(async (input: any) => {
      try {
        inv.recordTool(input?.tool_name ?? 'unknown', input?.tool_input, '', input?.tool_use_id);
      } catch { /* telemetry must not break the tool */ }
      return {};
    });
    postToolMatchers.push({
      matcher: '.*',
      hooks: [async (input: any) => {
        try {
          if (input?.tool_use_id) inv.recordToolResult(input.tool_use_id, input?.tool_response ?? '');
        } catch { /* ignore */ }
        return {};
      }],
    });
  }
  if (bucket && prefix) {
    postToolMatchers.push({ matcher: 'Write|Edit', hooks: [createFileChangeHook(bucket, prefix)] });
  }

  const hooks: Record<string, unknown[]> = {};
  if (preToolHooks.length) hooks.PreToolUse = [{ matcher: '.*', hooks: preToolHooks }];
  if (postToolMatchers.length) hooks.PostToolUse = postToolMatchers;
  if (bucket && prefix) hooks.Stop = [{ hooks: [createStopHook(bucket, prefix)] }];
  if (Object.keys(hooks).length) {
    baseOptions.hooks = hooks;
    console.log(`[agent-runner] Hooks registered (tracing=${!!inv}, s3sync=${!!(bucket && prefix)})`);
  }

  // OTEL: one root span per invocation (= one trace per turn), carrying the
  // SAES/AgentCore-Evaluation contract fields. Session correlation uses the
  // AgentCore session id (chat_session_id / session_id from the backend).
  //
  // Conversation continuity comes from history injection (buildContextualPrompt
  // replays payload.history), NOT Claude Code's native `resume`. We deliberately
  // do NOT attempt resume first: AgentCore microVMs are frequently recycled
  // between turns, so `resume: <session_id>` almost always fails with "Claude
  // Code process exited with code 1", and the old try/resume-then-fallback path
  // (a) wasted a full failed invocation per turn and (b) polluted telemetry —
  // the failed run's runTraced.finally called inv.end() (error, 0 tokens) and
  // closed the single root span, so the successful fallback's real token usage
  // never landed on `agent.invocation` (it showed 0 every multi-turn turn).
  // History injection is one clean run: one agent.invocation span with the
  // correct model + token totals, one chat span. See git history for the
  // resume path if native session continuity is ever needed again.
  const prompt = buildContextualPrompt(payload);
  yield* runTraced(inv, runWithOptions(prompt, baseOptions));
}

/**
 * Wrap an agent event stream with the OTEL invocation trace `inv`. Tool spans
 * are recorded by PreToolUse/PostToolUse hooks (see runAgent) — NOT here — so
 * every tool call is captured regardless of whether it surfaces as an assistant
 * content block. This wrapper only observes the final answer + token usage from
 * the `result` event and finalizes the root span. Pass-through: yields every
 * event unchanged.
 */
async function* runTraced(
  inv: InvocationTrace,
  stream: AsyncGenerator<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  let finalAnswer = '';
  let isError = false;
  let model: string | undefined;
  let numTurns: number | undefined;
  let tokenUsage: Record<string, number> | undefined;
  try {
    for await (const event of stream) {
      // The model id surfaces on assistant events (msg.message.model); capture
      // the latest so the invoke_agent / chat spans can report it.
      if (event.type === 'assistant' && event.model) model = event.model;
      if (event.type === 'result') {
        if (typeof event.result === 'string') finalAnswer = event.result;
        if (event.is_error) isError = true;
        if (event.num_turns != null) numTurns = event.num_turns;
        if (event.token_usage) {
          // Forward the full usage (incl. cache read/write) so the chat span
          // carries all four counters the console sums — not just in/out.
          tokenUsage = {
            input_tokens: event.token_usage.input_tokens,
            output_tokens: event.token_usage.output_tokens,
            cache_read_input_tokens: event.token_usage.cache_read_input_tokens,
            cache_creation_input_tokens: event.token_usage.cache_creation_input_tokens,
          };
        }
      }
      yield event;
    }
  } catch (err) {
    isError = true;
    finalAnswer = finalAnswer || `error: ${err instanceof Error ? err.message : String(err)}`;
    throw err;
  } finally {
    inv.end(finalAnswer, { isError, model, numTurns, tokenUsage });
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function* runWithOptions(
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<AgentEvent> {
  for await (const message of query({ prompt, options })) {
    const msg = message as Record<string, unknown>;

    if (msg.type === 'system' && msg.subtype === 'init') {
      yield {
        type: 'session_start',
        session_id: msg.session_id as string,
      };
      continue;
    }

    if (msg.type === 'assistant') {
      const rawContent = (msg.message as Record<string, unknown>)?.content;
      const model = (msg.message as Record<string, unknown>)?.model as string | undefined;
      const blocks = Array.isArray(rawContent)
        ? rawContent.map(mapContentBlock)
        : [];
      yield {
        type: 'assistant',
        content: blocks,
        session_id: msg.session_id as string | undefined,
        model,
      };
      continue;
    }

    if (msg.type === 'result') {
      const resultMsg = msg as Record<string, unknown>;
      // Extract token usage from SDK result message
      const usage = resultMsg.usage as Record<string, number> | undefined;
      const modelUsage = resultMsg.modelUsage as Record<string, Record<string, number>> | undefined;
      let tokenUsage: import('./types.js').TokenUsage | undefined;

      if (usage) {
        tokenUsage = {
          input_tokens: usage.input_tokens ?? 0,
          output_tokens: usage.output_tokens ?? 0,
          cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
          cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
          total_cost_usd: (resultMsg.total_cost_usd as number) ?? 0,
        };
      } else if (modelUsage) {
        // Aggregate from per-model usage
        let inputTokens = 0, outputTokens = 0, cacheRead = 0, cacheCreation = 0, cost = 0;
        for (const mu of Object.values(modelUsage)) {
          inputTokens += mu.inputTokens ?? 0;
          outputTokens += mu.outputTokens ?? 0;
          cacheRead += mu.cacheReadInputTokens ?? 0;
          cacheCreation += mu.cacheCreationInputTokens ?? 0;
          cost += mu.costUSD ?? 0;
        }
        tokenUsage = {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreation,
          total_cost_usd: cost,
        };
      }

      yield {
        type: 'result',
        session_id: msg.session_id as string | undefined,
        duration_ms: msg.duration_ms as number | undefined,
        num_turns: msg.num_turns as number | undefined,
        is_error: msg.is_error as boolean | undefined,
        result: msg.result as string | undefined,
        token_usage: tokenUsage,
      };
      continue;
    }
  }
}

function buildContextualPrompt(payload: AgentPayload): string {
  const userMessage = payload.prompt;
  const history = payload.history;

  if (!history || history.length === 0) {
    return userMessage;
  }

  const contextParts = history.map(msg =>
    msg.role === 'user' ? `User: ${msg.content}` : `Assistant: ${msg.content}`,
  );

  return (
    `Here is our conversation so far:\n\n${contextParts.join('\n\n')}\n\n` +
    `Now the user says:\n${userMessage}\n\n` +
    `Please respond based on the full conversation context above.`
  );
}

function mapContentBlock(block: Record<string, unknown>): ContentBlock {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text as string };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id as string,
        name: block.name as string,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id as string,
        content: block.content as string | undefined,
        is_error: block.is_error as boolean | undefined,
      };
    default:
      return block as unknown as ContentBlock;
  }
}
