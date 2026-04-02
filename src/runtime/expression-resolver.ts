/**
 * Arazzo Runtime Expression Resolver
 *
 * Resolves Arazzo runtime expressions against execution context.
 * Supports the full Arazzo 1.0.1 expression syntax:
 *
 *   $inputs.fieldName           → workflow input values
 *   $steps.stepId.outputs.field → previous step outputs
 *   $statusCode                 → HTTP response status code
 *   $response.body              → full response body
 *   $response.body.field        → nested response body field
 *   $response.header.name       → response header value
 *   $url                        → request URL
 *   $method                     → request HTTP method
 */

import type { StepResult } from './types.js';

export interface ExpressionContext {
  /** Workflow inputs */
  inputs: Record<string, unknown>;
  /** Completed step results, keyed by stepId */
  steps: Record<string, StepResult>;
  /** Current step's response (available during output resolution) */
  currentResponse?: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
  /** Current request info */
  currentRequest?: {
    url: string;
    method: string;
  };
}

/**
 * Resolve an Arazzo runtime expression against the given context.
 *
 * @param expression - The expression string (e.g., "$inputs.amount")
 * @param context - The current execution context
 * @returns The resolved value
 */
export function resolveExpression(
  expression: string,
  context: ExpressionContext,
): unknown {
  // Not a runtime expression — return as literal
  if (typeof expression !== 'string' || !expression.startsWith('$')) {
    return expression;
  }

  const parts = expression.split('.');
  const root = parts[0];

  switch (root) {
    case '$inputs':
      return resolveInputExpression(parts, context);

    case '$steps':
      return resolveStepExpression(parts, context);

    case '$statusCode':
      return context.currentResponse?.status;

    case '$response':
      return resolveResponseExpression(parts, context);

    case '$url':
      return context.currentRequest?.url;

    case '$method':
      return context.currentRequest?.method;

    default:
      // Not a recognized expression, return as-is
      return expression;
  }
}

/**
 * Deep-resolve all expressions in an object/value tree.
 * Walks arrays and objects recursively, resolving any string that starts with $.
 */
export function resolveDeep(
  value: unknown,
  context: ExpressionContext,
): unknown {
  if (typeof value === 'string') {
    return resolveExpression(value, context);
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, context));
  }

  if (value !== null && typeof value === 'object') {
    const resolved: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      resolved[key] = resolveDeep(val, context);
    }
    return resolved;
  }

  return value;
}

// ─── Internal Resolvers ───

function resolveInputExpression(
  parts: string[],
  context: ExpressionContext,
): unknown {
  // $inputs.fieldName → context.inputs[fieldName]
  if (parts.length < 2) {
    return context.inputs;
  }

  return getNestedValue(context.inputs, parts.slice(1));
}

function resolveStepExpression(
  parts: string[],
  context: ExpressionContext,
): unknown {
  // $steps.stepId.outputs.fieldName
  if (parts.length < 2) {
    return undefined;
  }

  const stepId = parts[1];
  const stepResult = context.steps[stepId];

  if (!stepResult) {
    throw new ExpressionError(
      `Step "${stepId}" not found in context. Available: [${Object.keys(context.steps).join(', ')}]`,
      parts.join('.'),
    );
  }

  if (parts.length === 2) {
    return stepResult;
  }

  // $steps.stepId.outputs
  if (parts[2] === 'outputs') {
    if (parts.length === 3) {
      return stepResult.outputs;
    }
    return getNestedValue(stepResult.outputs, parts.slice(3));
  }

  return undefined;
}

function resolveResponseExpression(
  parts: string[],
  context: ExpressionContext,
): unknown {
  if (!context.currentResponse) {
    return undefined;
  }

  if (parts.length === 1) {
    return context.currentResponse;
  }

  const section = parts[1];

  switch (section) {
    case 'body': {
      if (parts.length === 2) {
        return context.currentResponse.body;
      }
      return getNestedValue(
        context.currentResponse.body as Record<string, unknown>,
        parts.slice(2),
      );
    }

    case 'header': {
      if (parts.length < 3) {
        return context.currentResponse.headers;
      }
      const headerName = parts[2].toLowerCase();
      // Case-insensitive header lookup
      for (const [key, val] of Object.entries(context.currentResponse.headers)) {
        if (key.toLowerCase() === headerName) {
          return val;
        }
      }
      return undefined;
    }

    default:
      return undefined;
  }
}

// ─── Utilities ───

function getNestedValue(obj: unknown, path: string[]): unknown {
  let current: unknown = obj;

  for (const key of path) {
    if (current === null || current === undefined) {
      return undefined;
    }
    if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }

  return current;
}

/**
 * Check if a string contains an Arazzo runtime expression.
 */
export function isExpression(value: unknown): boolean {
  return typeof value === 'string' && value.startsWith('$');
}

/**
 * Extract all expression references from a value tree.
 */
export function extractExpressionRefs(value: unknown): string[] {
  const refs: string[] = [];

  if (typeof value === 'string' && value.startsWith('$')) {
    refs.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      refs.push(...extractExpressionRefs(item));
    }
  } else if (value !== null && typeof value === 'object') {
    for (const val of Object.values(value as Record<string, unknown>)) {
      refs.push(...extractExpressionRefs(val));
    }
  }

  return refs;
}

export class ExpressionError extends Error {
  constructor(
    message: string,
    public expression: string,
  ) {
    super(`[ExpressionResolver] ${message} (expression: ${expression})`);
    this.name = 'ExpressionError';
  }
}
