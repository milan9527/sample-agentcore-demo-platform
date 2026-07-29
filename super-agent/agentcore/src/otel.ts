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

let initialized = false;

/**
 * Initialize the global tracer + logger providers with OTLP export.
 * Idempotent. Safe to call when observability is disabled (becomes a no-op).
 * Providers are created dynamically so the OTEL SDK is only loaded when needed.
 */
export async function initOtel(): Promise<void> {
  if (initialized || !OBSERVABILITY_ENABLED) return;
  initialized = true;

  try {
    const { defaultResource, resourceFromAttributes } = await import('@opentelemetry/resources');
    const { NodeTracerProvider } = await import('@opentelemetry/sdk-trace-node');
    const { BatchSpanProcessor } = await import('@opentelemetry/sdk-trace-base');
    const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-proto');
    const {
      LoggerProvider,
      BatchLogRecordProcessor,
    } = await import('@opentelemetry/sdk-logs');
    const { OTLPLogExporter } = await import('@opentelemetry/exporter-logs-otlp-proto');

    // service.name / aws.log.group.names also come from OTEL_RESOURCE_ATTRIBUTES
    // set on the runtime container (merged into the default resource); we add a
    // sensible default service.name for the local/unset case.
    const resource = defaultResource().merge(
      resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME ?? 'super-agent-runtime' }),
    );

    // OTEL 2.x: processors are passed to the constructor (no addSpanProcessor).
    const tracerProvider = new NodeTracerProvider({
      resource,
      spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    });
    tracerProvider.register();

    const loggerProvider = new LoggerProvider({
      resource,
      processors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    });
    logs.setGlobalLoggerProvider(loggerProvider);

    console.log('[otel] Observability enabled — exporting spans + events via OTLP');
  } catch (err) {
    // Never let telemetry setup break the agent run.
    console.warn('[otel] init failed, continuing without telemetry:', err instanceof Error ? err.message : err);
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
