/**
 * Expression Resolver Tests
 *
 * Tests for Arazzo runtime expression resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveExpression,
  resolveDeep,
  isExpression,
  extractExpressionRefs,
  ExpressionError,
} from '../src/runtime/expression-resolver.js';
import type { ExpressionContext } from '../src/runtime/expression-resolver.js';
import type { StepResult } from '../src/runtime/types.js';

// ─── Test Helpers ───

function makeStepResult(
  stepId: string,
  outputs: Record<string, unknown>,
  status: number = 200,
  body: unknown = {},
): StepResult {
  return {
    stepId,
    request: { url: 'https://example.com', method: 'POST', headers: {} },
    response: { status, headers: {}, body },
    outputs,
    success: true,
    duration: 100,
  };
}

function makeContext(overrides: Partial<ExpressionContext> = {}): ExpressionContext {
  return {
    inputs: {},
    steps: {},
    ...overrides,
  };
}

// ─── $inputs ───

describe('$inputs expressions', () => {
  it('should resolve simple input value', () => {
    const ctx = makeContext({
      inputs: { walletUrl: 'https://wallet.example.com/alice' },
    });
    expect(resolveExpression('$inputs.walletUrl', ctx)).toBe(
      'https://wallet.example.com/alice',
    );
  });

  it('should resolve nested input value', () => {
    const ctx = makeContext({
      inputs: {
        amount: { value: '2500', assetCode: 'USD' },
      },
    });
    // Note: deep nesting not supported in simple dot path,
    // but we handle it through getNestedValue
    expect(resolveExpression('$inputs.amount', ctx)).toEqual({
      value: '2500',
      assetCode: 'USD',
    });
  });

  it('should return all inputs when no field specified', () => {
    const inputs = { a: 1, b: 2 };
    const ctx = makeContext({ inputs });
    expect(resolveExpression('$inputs', ctx)).toEqual(inputs);
  });

  it('should return undefined for missing input', () => {
    const ctx = makeContext({ inputs: { foo: 'bar' } });
    expect(resolveExpression('$inputs.missing', ctx)).toBeUndefined();
  });
});

// ─── $steps ───

describe('$steps expressions', () => {
  it('should resolve step output value', () => {
    const ctx = makeContext({
      steps: {
        createPayment: makeStepResult('createPayment', {
          paymentUrl: 'https://wallet.example.com/payments/123',
        }),
      },
    });

    expect(
      resolveExpression('$steps.createPayment.outputs.paymentUrl', ctx),
    ).toBe('https://wallet.example.com/payments/123');
  });

  it('should resolve all outputs when stopping at outputs level', () => {
    const outputs = { a: 1, b: 'two' };
    const ctx = makeContext({
      steps: { step1: makeStepResult('step1', outputs) },
    });

    expect(resolveExpression('$steps.step1.outputs', ctx)).toEqual(outputs);
  });

  it('should throw for missing step', () => {
    const ctx = makeContext({ steps: {} });
    expect(() =>
      resolveExpression('$steps.missingStep.outputs.value', ctx),
    ).toThrow(ExpressionError);
  });
});

// ─── $statusCode ───

describe('$statusCode expression', () => {
  it('should resolve status code from current response', () => {
    const ctx = makeContext({
      currentResponse: { status: 201, headers: {}, body: {} },
    });
    expect(resolveExpression('$statusCode', ctx)).toBe(201);
  });

  it('should return undefined when no response', () => {
    const ctx = makeContext();
    expect(resolveExpression('$statusCode', ctx)).toBeUndefined();
  });
});

// ─── $response.body ───

describe('$response.body expressions', () => {
  it('should resolve full response body', () => {
    const body = { id: '123', name: 'test' };
    const ctx = makeContext({
      currentResponse: { status: 200, headers: {}, body },
    });
    expect(resolveExpression('$response.body', ctx)).toEqual(body);
  });

  it('should resolve nested body field', () => {
    const body = { access_token: { value: 'tok_abc', manage: 'https://example.com' } };
    const ctx = makeContext({
      currentResponse: { status: 200, headers: {}, body },
    });
    expect(resolveExpression('$response.body.access_token.value', ctx)).toBe(
      'tok_abc',
    );
  });

  it('should resolve deeply nested body field', () => {
    const body = {
      continue: {
        access_token: { value: 'continue_tok' },
        uri: 'https://auth.example.com/continue/abc',
      },
    };
    const ctx = makeContext({
      currentResponse: { status: 200, headers: {}, body },
    });
    expect(
      resolveExpression('$response.body.continue.access_token.value', ctx),
    ).toBe('continue_tok');
  });
});

// ─── $response.header ───

describe('$response.header expressions', () => {
  it('should resolve response header (case-insensitive)', () => {
    const ctx = makeContext({
      currentResponse: {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-request-id': 'abc123' },
        body: {},
      },
    });
    expect(resolveExpression('$response.header.content-type', ctx)).toBe(
      'application/json',
    );
    expect(resolveExpression('$response.header.x-request-id', ctx)).toBe(
      'abc123',
    );
  });
});

// ─── $url and $method ───

describe('$url and $method expressions', () => {
  it('should resolve current request URL and method', () => {
    const ctx = makeContext({
      currentRequest: {
        url: 'https://wallet.example.com/payments',
        method: 'POST',
      },
    });
    expect(resolveExpression('$url', ctx)).toBe(
      'https://wallet.example.com/payments',
    );
    expect(resolveExpression('$method', ctx)).toBe('POST');
  });
});

// ─── Non-expression values ───

describe('non-expression values', () => {
  it('should return literal strings as-is', () => {
    const ctx = makeContext();
    expect(resolveExpression('just a string', ctx)).toBe('just a string');
  });

  it('should return numbers as-is', () => {
    const ctx = makeContext();
    expect(resolveExpression(42 as unknown as string, ctx)).toBe(42);
  });
});

// ─── resolveDeep ───

describe('resolveDeep', () => {
  it('should resolve expressions in nested objects', () => {
    const ctx = makeContext({
      inputs: {
        walletAddress: 'https://wallet.example.com/alice',
        amount: '2500',
        assetCode: 'USD',
      },
    });

    const payload = {
      walletAddress: '$inputs.walletAddress',
      incomingAmount: {
        value: '$inputs.amount',
        assetCode: '$inputs.assetCode',
        assetScale: 2,
      },
    };

    const resolved = resolveDeep(payload, ctx);

    expect(resolved).toEqual({
      walletAddress: 'https://wallet.example.com/alice',
      incomingAmount: {
        value: '2500',
        assetCode: 'USD',
        assetScale: 2,
      },
    });
  });

  it('should resolve expressions in arrays', () => {
    const ctx = makeContext({
      inputs: { action1: 'create', action2: 'read' },
    });

    const payload = {
      actions: ['$inputs.action1', '$inputs.action2'],
    };

    const resolved = resolveDeep(payload, ctx) as Record<string, unknown>;
    expect(resolved.actions).toEqual(['create', 'read']);
  });
});

// ─── isExpression ───

describe('isExpression', () => {
  it('should identify expressions', () => {
    expect(isExpression('$inputs.foo')).toBe(true);
    expect(isExpression('$steps.bar.outputs.baz')).toBe(true);
    expect(isExpression('$statusCode')).toBe(true);
  });

  it('should reject non-expressions', () => {
    expect(isExpression('not an expression')).toBe(false);
    expect(isExpression(42)).toBe(false);
    expect(isExpression(null)).toBe(false);
  });
});

// ─── extractExpressionRefs ───

describe('extractExpressionRefs', () => {
  it('should extract all expression references from nested structure', () => {
    const value = {
      field1: '$inputs.a',
      nested: {
        field2: '$steps.s1.outputs.b',
        items: ['$response.body.c', 'literal'],
      },
    };

    const refs = extractExpressionRefs(value);
    expect(refs).toContain('$inputs.a');
    expect(refs).toContain('$steps.s1.outputs.b');
    expect(refs).toContain('$response.body.c');
    expect(refs).not.toContain('literal');
  });
});
