/**
 * ChatMessage Component
 *
 * Renders an array of content blocks for a single assistant turn.
 * Delegates to the appropriate content block component based on type.
 * Detects file-write operations and renders ArtifactCards for generated files.
 *
 * Requirements: 9.1, 9.2, 9.3
 *
 * @module components/chat/ChatMessage
 */

import { Bot } from 'lucide-react';
import { useState } from 'react';
import type { ContentBlock } from '@/services/chatStreamService';
import { TextContentBlock } from './TextContentBlock';
import { ToolUseBlock } from './ToolUseBlock';
import { ToolResultBlock } from './ToolResultBlock';
import { ArtifactCard, type ArtifactInfo } from './ArtifactCard';
import { SuggestedActions, inferSuggestedActions } from './SuggestedActions';

interface ChatMessageProps {
  /** Array of content blocks for this assistant turn. */
  content: ContentBlock[];
  /** Optional model name to display. */
  model?: string;
  /** Whether this message is currently being streamed. */
  isStreaming?: boolean;
  /** Sub-agent speaker name — shown instead of default avatar when set. */
  speakerAgentName?: string;
  /** Sub-agent speaker avatar URL — shown instead of default icon when set. */
  speakerAgentAvatar?: string | null;
  /** Callback when user clicks "查看" on an artifact card. */
  onArtifactView?: (path: string, name: string) => void;
  /** Callback when user clicks a suggested action. */
  onSendMessage?: (message: string) => void;
}

/** Tool names that indicate file creation/writing */
const WRITE_TOOL_NAMES = new Set([
  'write', 'create', 'save', 'Write', 'Create',
  'fsWrite', 'fswrite', 'write_file', 'create_file',
  'WriteFile', 'CreateFile', 'file_write',
  'Edit', 'edit', 'MultiEdit', 'multi_edit',
])

/** Check if a tool_use block represents a file write operation */
function isFileWriteTool(name: string): boolean {
  const lower = name.toLowerCase()
  return WRITE_TOOL_NAMES.has(name) ||
    lower.includes('write') ||
    lower.includes('create_file') ||
    lower.includes('save_file')
}

/** Normalize an absolute/agent-reported path to a workspace-relative path. */
function normalizeToWorkspaceRelative(val: string): string {
  let normalized = val
  // Strip common absolute prefixes that agents use:
  //   /workspace/documents/file.md → documents/file.md
  //   /mnt/efs/<org>/<user>/<scope>/sessions/<id>/app/x.pptx → app/x.pptx
  //   /tmp/workspaces/<id>/<id>/documents/file.md → documents/file.md
  //   /home/user/documents/file.md → documents/file.md
  const prefixPatterns = [
    /^\/workspace\//,                                                  // /workspace/rest
    /^\/mnt\/efs\/[^/]+\/[^/]+\/[^/]+\/sessions\/[^/]+\//,             // EFS per-user session dir
    /^\/mnt\/efs\/[^/]+\/[^/]+\/sessions\/[^/]+\//,                    // EFS (no userId) session dir
    /^\/tmp\/workspaces\/[^/]+\/[^/]+\//,                              // /tmp/workspaces/agentId/sessionId/rest
    /^\/tmp\/workspaces\/[^/]+\//,                                     // /tmp/workspaces/agentId/rest
    /^\/workspaces\/[^/]+\/[^/]+\//,                                   // /workspaces/agentId/sessionId/rest
    /^\/workspaces\/[^/]+\//,                                          // /workspaces/agentId/rest
    /^\/home\/[^/]+\//,                                               // /home/user/rest
  ]
  for (const pattern of prefixPatterns) {
    if (pattern.test(normalized)) {
      normalized = normalized.replace(pattern, '')
      break
    }
  }
  // Strip leading ./ or /
  return normalized.replace(/^\.\//, '').replace(/^\//, '')
}

/** Extract file path from tool_use input */
function extractFilePath(input: Record<string, unknown>): string | null {
  // Common field names for file path in various tool schemas
  const pathFields = ['file_path', 'path', 'filePath', 'filename', 'target', 'targetFile']
  for (const field of pathFields) {
    const val = input[field]
    if (typeof val === 'string' && val.length > 0) {
      return normalizeToWorkspaceRelative(val)
    }
  }
  return null
}

/**
 * "Output" file extensions — deliverables the user actually wants to preview.
 * Scripts (.py, .sh, .js…) that merely produce these are lower priority.
 */
const OUTPUT_EXTENSIONS = new Set([
  'pptx', 'ppt', 'pdf', 'xlsx', 'xls', 'csv', 'docx', 'doc',
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp',
  'md', 'txt', 'html', 'htm', 'json', 'zip',
])
const SCRIPT_EXTENSIONS = new Set(['py', 'sh', 'js', 'ts', 'rb', 'pl', 'bash'])

function extOf(p: string): string {
  return p.split('.').pop()?.toLowerCase() ?? ''
}

/**
 * Extract file paths mentioned in assistant text (e.g. "已生成 app/x.pptx" or
 * `app/x.pptx`). Catches deliverables produced via Bash/scripts that never show
 * up as a Write tool_use. Only keeps paths that carry a known file extension.
 */
function extractPathsFromText(text: string): string[] {
  const found: string[] = []
  // Match backticked paths and bare path-like tokens containing a dot-extension.
  const re = /`([^`\n]+?\.[a-zA-Z0-9]{1,5})`|(?:^|[\s(（"'"：:])((?:\/|\.\/|[\w.-]+\/)?[\w./-]+\.[a-zA-Z0-9]{1,5})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const raw = (m[1] || m[2] || '').trim()
    if (!raw) continue
    const norm = normalizeToWorkspaceRelative(raw)
    if (norm && OUTPUT_EXTENSIONS.has(extOf(norm))) found.push(norm)
  }
  return found
}

/**
 * Extract artifacts a message produced. Combines two signals so deliverables
 * created by scripts (e.g. python make_ppt.py → app/x.pptx run via Bash) are
 * surfaced, not just files written by a Write tool:
 *   1. successful file-write tool_use blocks
 *   2. file paths named in the assistant's text (output extensions only)
 * When real output files (pptx/pdf/xlsx/…) are present, intermediate scripts
 * (.py/.sh/…) are dropped so the preview points at the actual deliverable.
 */
function extractArtifacts(content: ContentBlock[]): ArtifactInfo[] {
  const seenPaths = new Set<string>()
  const collected: ArtifactInfo[] = []
  const add = (path: string) => {
    if (!path || seenPaths.has(path)) return
    seenPaths.add(path)
    collected.push({ path, name: path.split('/').pop() || path })
  }

  for (let i = 0; i < content.length; i++) {
    const block = content[i]
    // 1) File-write tool calls with a successful result.
    if (block.type === 'tool_use' && isFileWriteTool(block.name)) {
      const path = extractFilePath(block.input as Record<string, unknown>)
      if (!path) continue
      const resultBlock = content.slice(i + 1).find(
        b => b.type === 'tool_result' && b.tool_use_id === block.id
      )
      if (resultBlock && resultBlock.type === 'tool_result' && resultBlock.is_error) continue
      add(path)
    }
    // 2) File paths named in assistant text (catches Bash/script-produced files).
    if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
      for (const p of extractPathsFromText(block.text)) add(p)
    }
  }

  // Prefer real deliverables: if any output-type file is present, drop scripts.
  const hasOutput = collected.some(a => OUTPUT_EXTENSIONS.has(extOf(a.path)))
  if (hasOutput) {
    return collected.filter(a => !SCRIPT_EXTENSIONS.has(extOf(a.path)))
  }
  return collected
}

/**
 * Renders a single content block by delegating to the appropriate component.
 */
function renderContentBlock(block: ContentBlock, index: number, isStreaming: boolean, isLastToolUse: boolean): React.ReactNode {
  switch (block.type) {
    case 'text':
      return <TextContentBlock key={`text-${index}`} block={block} />;
    case 'tool_use':
      return <ToolUseBlock key={`tool-use-${block.id}`} block={block} isStreaming={isStreaming && isLastToolUse} />;
    case 'tool_result':
      return <ToolResultBlock key={`tool-result-${block.tool_use_id}`} block={block} />;
    default:
      return null;
  }
}

/**
 * Renders a complete assistant message with an avatar and all content blocks.
 * When file-write operations are detected, shows ArtifactCards at the end.
 */
export function ChatMessage({ content, model, isStreaming = false, speakerAgentName, speakerAgentAvatar, onArtifactView, onSendMessage }: ChatMessageProps) {
  const [avatarError, setAvatarError] = useState(false);

  if (content.length === 0) {
    return null;
  }

  // Find the last tool_use block index (to show streaming indicator only on the latest one)
  let lastToolUseIdx = -1;
  for (let i = content.length - 1; i >= 0; i--) {
    if (content[i].type === 'tool_use') {
      lastToolUseIdx = i;
      break;
    }
  }
  // Only mark the last tool_use as streaming if there's no tool_result after it
  const hasResultAfterLastTool = lastToolUseIdx >= 0 && content.slice(lastToolUseIdx + 1).some(b => b.type === 'tool_result');

  // Extract artifacts from completed file-write operations
  const artifacts = isStreaming ? [] : extractArtifacts(content)

  const showImage = speakerAgentAvatar && !avatarError;

  return (
    <div className="flex gap-3" data-testid="chat-message">
      {/* Avatar */}
      {showImage ? (
        <img
          src={speakerAgentAvatar}
          alt={speakerAgentName ?? 'Agent'}
          className="w-8 h-8 rounded-full flex-shrink-0 object-cover"
          onError={() => setAvatarError(true)}
        />
      ) : (
        <div className="w-8 h-8 rounded-full bg-purple-600 flex items-center justify-center flex-shrink-0 text-white text-xs font-bold select-none">
          {speakerAgentName ? speakerAgentName.charAt(0).toUpperCase() : <Bot className="w-4 h-4 text-white" />}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 space-y-2">
        {speakerAgentName && (
          <span className="text-xs font-medium text-purple-400">{speakerAgentName}</span>
        )}
        {model && !speakerAgentName && (
          <span className="text-xs text-gray-500 font-mono">{model}</span>
        )}
        {content.map((block, idx) =>
          renderContentBlock(block, idx, isStreaming, idx === lastToolUseIdx && !hasResultAfterLastTool)
        )}

        {/* Artifact Cards — shown after all content blocks when files were generated */}
        {artifacts.length > 0 && (
          <div className="space-y-2 mt-3">
            {artifacts.map(artifact => (
              <ArtifactCard
                key={artifact.path}
                artifact={artifact}
                onView={(path, name) => {
                  if (onArtifactView) {
                    onArtifactView(path, name)
                  } else {
                    // Fallback: dispatch custom event for Chat page to pick up
                    window.dispatchEvent(new CustomEvent('artifact-view', { detail: { path, name } }))
                  }
                }}
              />
            ))}
            {/* Suggested next actions */}
            {onSendMessage && (
              <SuggestedActions
                actions={inferSuggestedActions(artifacts[artifacts.length - 1].name)}
                onAction={onSendMessage}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
