/**
 * OpenTelemetry instrumentation for the Claude Agent SDK runtime, following the
 * SAES / AgentCore Evaluation OTEL contract (see CustomEval
 * .claude/skills/otel-eval-contract).
 *
 * Why hand-rolled: the Claude Agent SDK drives Bedrock through a bundled CLI
 * SUBPROCESS, so AgentCore's auto-instrumentation never sees the model calls —
 * nothing is captured for free. We satisfy the contract by hand:
 *   - one root span per invocation (= one trace per turn) carrying
 *     `session.id`, `gen_ai.prompt`, `gen_ai.completion`;
 *   - one OTEL event per turn with roled input/output message bodies (the shape
 *     SAES's role-aware recovery reads);
 *   - per tool call, Bedrock-Converse-shaped `toolUse`/`toolResult` event bodies
 *     so the tool supplement can recover the trajectory.
 *
 * Export: when AGENT_OBSERVABILITY_ENABLED=true the AgentCore Runtime provides
 * an OTLP receiver (localhost:4318) that forwards to CloudWatch/X-Ray using the
 * OTEL_EXPORTER_OTLP_*_HEADERS (x-aws-log-group etc.) set on the container. We
 * export spans + logs over OTLP/HTTP-protobuf to that endpoint. When the flag is
 * off (local dev without a collector) instrumentation is a no-op unless a test
 * harness installs in-memory providers first.
 */

import { trace, context, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';
import { logs, type Logger } from '@opentelemetry/api-logs';

// The managed AgentCore Evaluate API only accepts spans whose instrumentation
// scope is on its allow-list; for the Claude Agent SDK that is exactly
// `openinference.instrumentation.claude_agent_sdk`. Using any other scope name
// makes Evaluate reject the session ("no spans with supported scope").
const SCOPE = 'openinference.instrumentation.claude_agent_sdk';
const OBSERVABILITY_ENABLED = process.env.AGENT_OBSERVABILITY_ENABLED === 'true';

/**
 * Observability setup is NOT done here. The AWS Distro for OpenTelemetry (ADOT)
 * Node package is preloaded via the container entrypoint:
 *
 *   node --require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register dist/index.js
 *
 * That CJS `register` hook (loaded before this ESM app) installs the global
 * TracerProvider + LoggerProvider and the SigV4-signed OTLP export pipeline that
 * delivers to CloudWatch (the /aws/bedrock-agentcore/runtimes/<id> log group),
 * reading AGENT_OBSERVABILITY_ENABLED + OTEL_* from the environment.
 *
 * Why not a self-built NodeTracerProvider: there is no standalone OTLP collector
 * on AgentCore Runtime ("ADOT Collector not supported for agent observability")
 * and plain OTEL-JS exporters can't SigV4-sign to CloudWatch. ADOT's register
 * provides both. It's CJS (works via --require) so it coexists with our ESM app
 * and the ESM-only Claude Agent SDK.
 *
 * This module therefore only EMITS spans/events through the global OTEL API,
 * which resolves to whatever provider `register` installed (or a no-op provider
 * when observability is disabled / register wasn't preloaded).
 */
export async function initOtel(): Promise<void> {
  if (OBSERVABILITY_ENABLED) {
    console.log('[otel] Observability enabled — emitting spans/events via the ADOT global provider');
  }
}

function getTracer(): Tracer {
  return trace.getTracer(SCOPE);
}

function getLogger(): Logger {
  return logs.getLogger(SCOPE);
}

/** Emit an OTEL log record (used as an "event" — the contract's event bodies). */
function emitEvent(name: string, body: unknown, span?: Span): void {
  try {
    const ctx = span?.spanContext();
    getLogger().emit({
      // event.name marks this log record as a semantic event.
      attributes: { 'event.name': name },
      body: body as never,
      ...(ctx ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
    });
  } catch {
    /* telemetry must never throw into the agent path */
  }
}

/**
 * Handle to the active invocation span so tool calls and the final answer can
 * attach to it. Returned by beginInvocation; caller must call end().
 */
export interface InvocationTrace {
  /**
   * Record a tool call as a child span. Called when the tool_use block is seen
   * (root span still active). `callId` is the SDK's tool_use id — pass it so a
   * later tool_result can be matched via recordToolResult. `result` is usually
   * '' at this point (results arrive later / out of band).
   */
  recordTool(name: string, input: unknown, result: unknown, callId?: string): void;
  /** Attach a tool's result to its already-recorded span (matched by callId). */
  recordToolResult(callId: string, result: unknown): void;
  /** Finalize with the assistant's final answer + optional token usage. */
  end(answer: string, opts?: { isError?: boolean; tokenUsage?: Record<string, number> }): void;
}

/**
 * Start a root span for one agent invocation (= one trace per turn) and stamp
 * the three contract attributes. Returns a no-op handle when observability is
 * off. Never throws — telemetry failures must not affect the agent.
 */
export function beginInvocation(sessionId: string, prompt: string): InvocationTrace {
  if (!OBSERVABILITY_ENABLED) return NOOP_TRACE;

  let span: Span;
  let rootCtx: ReturnType<typeof trace.setSpan>;
  try {
    span = getTracer().startSpan('agent.invocation');
    rootCtx = trace.setSpan(context.active(), span);

    // --- Agent Traces UI rendering (gen_ai.* semantic conventions) ---
    // gen_ai.operation.name categorizes the span so the UI renders it as an
    // agent invocation and shows input/output; without it the span is a bare
    // skeleton. input/output.messages carry the content the UI displays.
    span.setAttribute('gen_ai.operation.name', 'invoke_agent');
    span.setAttribute('gen_ai.provider.name', 'anthropic');
    span.setAttribute('gen_ai.agent.name', 'super-agent');
    span.setAttribute('gen_ai.input.messages', JSON.stringify([{ role: 'user', content: [{ type: 'text', text: prompt }] }]));

    span.setAttribute('session.id', sessionId);          // contract item 1
    span.setAttribute('gen_ai.prompt', prompt);          // contract item 2

    // --- OpenInference attributes (managed Evaluate API's claude_agent_sdk
    // mapper reads these; without them Evaluate rejects the session). ---
    span.setAttribute('openinference.span.kind', 'AGENT');
    span.setAttribute('input.value', prompt);
    span.setAttribute('llm.input_messages.0.message.role', 'user');
    span.setAttribute('llm.input_messages.0.message.content', prompt);
  } catch {
    return NOOP_TRACE;
  }

    // Open tool spans awaiting their result (keyed by the SDK tool_use id).
    // Kept open so a later tool_result can attach; closed in end() otherwise.
    const openToolSpans = new Map<string, Span>();
  return {
    recordTool(name, input, result, callId) {
      try {
        // A real CHILD span (parented to the invocation via rootCtx) so the tool
        // call shows as its own step in the trace UI. execute_tool + gen_ai.tool.*
        // are what the UI/eval read; input/output.value mirror it for OpenInference.
        const inputText = typeof input === 'string' ? input : JSON.stringify(input);
        const resultText = result == null || result === '' ? '' : (typeof result === 'string' ? result : JSON.stringify(result));
        const id = callId || `tooluse_${Math.random().toString(16).slice(2, 18)}`;
        const toolSpan = getTracer().startSpan(`execute_tool ${name}`, undefined, rootCtx);
        toolSpan.setAttribute('gen_ai.operation.name', 'execute_tool');
        toolSpan.setAttribute('gen_ai.tool.name', name);
        toolSpan.setAttribute('gen_ai.tool.call.id', id);
        toolSpan.setAttribute('gen_ai.tool.call.arguments', inputText);
        toolSpan.setAttribute('openinference.span.kind', 'TOOL');
        toolSpan.setAttribute('tool.name', name);
        toolSpan.setAttribute('input.value', inputText);
        if (resultText) {
          toolSpan.setAttribute('gen_ai.tool.call.result', resultText);
          toolSpan.setAttribute('output.value', resultText);
        }
        emitEvent('gen_ai.tool.request', { content: [{ toolUse: { toolUseId: id, name, input } }] }, span);
        if (resultText) {
          emitEvent('gen_ai.tool.result', { content: [{ toolResult: { toolUseId: id, content: [{ text: resultText }] } }] }, span);
          toolSpan.setStatus({ code: SpanStatusCode.OK });
          toolSpan.end();
        } else {
          // Leave open for a possible recordToolResult; end() closes it if not.
          openToolSpans.set(id, toolSpan);
        }
      } catch { /* ignore */ }
    },
    recordToolResult(callId, result) {
      try {
        const toolSpan = openToolSpans.get(callId);
        if (!toolSpan) return;
        const resultText = typeof result === 'string' ? result : JSON.stringify(result);
        toolSpan.setAttribute('gen_ai.tool.call.result', resultText);
        toolSpan.setAttribute('output.value', resultText);
        toolSpan.setStatus({ code: SpanStatusCode.OK });
        toolSpan.end();
        openToolSpans.delete(callId);
        emitEvent('gen_ai.tool.result', { content: [{ toolResult: { toolUseId: callId, content: [{ text: resultText }] } }] }, span);
      } catch { /* ignore */ }
    },
    end(answer, opts) {
      try {
        // Close any tool spans whose result never arrived.
        for (const ts of openToolSpans.values()) {
          try { ts.setStatus({ code: SpanStatusCode.OK }); ts.end(); } catch { /* ignore */ }
        }
        openToolSpans.clear();
        // Agent Traces UI output content.
        span.setAttribute('gen_ai.output.messages', JSON.stringify([{ role: 'assistant', content: [{ type: 'text', text: answer }] }]));
        span.setAttribute('gen_ai.completion', answer);   // contract item 3
        span.setAttribute('output.value', answer);        // OpenInference
        span.setAttribute('llm.output_messages.0.message.role', 'assistant');
        span.setAttribute('llm.output_messages.0.message.content', answer);
        if (opts?.tokenUsage) {
          if (opts.tokenUsage.input_tokens != null) span.setAttribute('gen_ai.usage.input_tokens', opts.tokenUsage.input_tokens);
          if (opts.tokenUsage.output_tokens != null) span.setAttribute('gen_ai.usage.output_tokens', opts.tokenUsage.output_tokens);
        }
        span.setStatus({ code: opts?.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      } catch { /* ignore */ } finally {
        try { span.end(); } catch { /* ignore */ }
      }
    },
  };
}

const NOOP_TRACE: InvocationTrace = {
  recordTool() { /* no-op */ },
  recordToolResult() { /* no-op */ },
  end() { /* no-op */ },
};
