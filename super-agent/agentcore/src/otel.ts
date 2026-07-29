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

import { trace, type Span, type Tracer, SpanStatusCode } from '@opentelemetry/api';
import { logs, type Logger } from '@opentelemetry/api-logs';

const SCOPE = 'claudesdk.agent';
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
  /** Record a tool call: emits Converse-shaped toolUse/toolResult event bodies. */
  recordTool(name: string, input: unknown, result: unknown): void;
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
  try {
    span = getTracer().startSpan('agent.invocation');
    span.setAttribute('session.id', sessionId);          // contract item 1
    span.setAttribute('gen_ai.prompt', prompt);          // contract item 2
    // Roled input message body — SAES role-aware recovery reads this shape.
    emitEvent('gen_ai.user.message', { message: { role: 'user', content: [{ text: prompt }] } }, span);
  } catch {
    return NOOP_TRACE;
  }

  return {
    recordTool(name, input, result) {
      try {
        const ctx = span.spanContext();
        const toolUseId = `tooluse_${Math.random().toString(16).slice(2, 18)}`;
        // Converse-shaped toolUse / toolResult event bodies — the exact shape the
        // SAES tool supplement recovers for non-Strands agents.
        emitEvent('gen_ai.tool.request', {
          content: [{ toolUse: { toolUseId, name, input } }],
        }, span);
        emitEvent('gen_ai.tool.result', {
          content: [{ toolResult: { toolUseId, content: [{ text: typeof result === 'string' ? result : JSON.stringify(result) }] } }],
        }, span);
        void ctx;
      } catch { /* ignore */ }
    },
    end(answer, opts) {
      try {
        span.setAttribute('gen_ai.completion', answer);   // contract item 3
        if (opts?.tokenUsage) {
          if (opts.tokenUsage.input_tokens != null) span.setAttribute('gen_ai.usage.input_tokens', opts.tokenUsage.input_tokens);
          if (opts.tokenUsage.output_tokens != null) span.setAttribute('gen_ai.usage.output_tokens', opts.tokenUsage.output_tokens);
        }
        emitEvent('gen_ai.assistant.message', { message: { role: 'assistant', content: [{ text: answer }] } }, span);
        span.setStatus({ code: opts?.isError ? SpanStatusCode.ERROR : SpanStatusCode.OK });
      } catch { /* ignore */ } finally {
        try { span.end(); } catch { /* ignore */ }
      }
    },
  };
}

const NOOP_TRACE: InvocationTrace = {
  recordTool() { /* no-op */ },
  end() { /* no-op */ },
};
