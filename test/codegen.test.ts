/**
 * Code Generator Tests
 *
 * Tests for TypeScript code generation from Arazzo specs.
 */

import { describe, it, expect } from 'vitest';
import {
  mapSchemaTypeToTS,
  generateInterface,
  generateOutputInterface,
  toPascalCase,
  toCamelCase,
} from '../src/generator/type-mapper.js';
import { parseArazzoContent } from '../src/parser/arazzo-parser.js';
import type { JsonSchemaProperty, JsonSchemaObject } from '../src/parser/types.js';

// ─── mapSchemaTypeToTS ───

describe('mapSchemaTypeToTS', () => {
  it('should map string to string', () => {
    expect(mapSchemaTypeToTS({ type: 'string' })).toBe('string');
  });

  it('should map integer to number', () => {
    expect(mapSchemaTypeToTS({ type: 'integer' })).toBe('number');
  });

  it('should map number to number', () => {
    expect(mapSchemaTypeToTS({ type: 'number' })).toBe('number');
  });

  it('should map boolean to boolean', () => {
    expect(mapSchemaTypeToTS({ type: 'boolean' })).toBe('boolean');
  });

  it('should map string enum to union type', () => {
    const prop: JsonSchemaProperty = {
      type: 'string',
      enum: ['active', 'pending', 'completed'],
    };
    expect(mapSchemaTypeToTS(prop)).toBe("'active' | 'pending' | 'completed'");
  });

  it('should map array with items', () => {
    const prop: JsonSchemaProperty = {
      type: 'array',
      items: { type: 'string' },
    };
    expect(mapSchemaTypeToTS(prop)).toBe('string[]');
  });

  it('should map array without items to unknown[]', () => {
    expect(mapSchemaTypeToTS({ type: 'array' })).toBe('unknown[]');
  });

  it('should map object without properties to Record', () => {
    expect(mapSchemaTypeToTS({ type: 'object' })).toBe(
      'Record<string, unknown>',
    );
  });
});

// ─── generateInterface ───

describe('generateInterface', () => {
  it('should generate interface from schema', () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      required: ['walletUrl', 'amount'],
      properties: {
        walletUrl: { type: 'string', description: 'Wallet address URL' },
        amount: { type: 'string', description: 'Payment amount' },
        assetScale: { type: 'integer' },
      },
    };

    const result = generateInterface('PaymentInputs', schema);

    expect(result).toContain('export interface PaymentInputs');
    expect(result).toContain('walletUrl: string;');
    expect(result).toContain('amount: string;');
    expect(result).toContain('assetScale?: number;');
    expect(result).toContain('/** Wallet address URL */');
  });

  it('should mark required fields without ?', () => {
    const schema: JsonSchemaObject = {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string' },
        optional: { type: 'string' },
      },
    };

    const result = generateInterface('Test', schema);
    expect(result).toContain('name: string;');
    expect(result).toContain('optional?: string;');
  });
});

// ─── generateOutputInterface ───

describe('generateOutputInterface', () => {
  it('should generate output interface from expression mappings', () => {
    const outputs: Record<string, string> = {
      paymentId: '$steps.createPayment.outputs.id',
      debitAmount: '$steps.createQuote.outputs.debitAmount',
      failed: '$steps.createOutgoing.outputs.outgoingPaymentFailed',
    };

    const result = generateOutputInterface('PaymentOutputs', outputs);

    expect(result).toContain('export interface PaymentOutputs');
    expect(result).toContain('paymentId: string;');
    expect(result).toContain('debitAmount: Amount;');
    expect(result).toContain('failed: boolean;');
    expect(result).toContain('Resolved from:');
  });
});

// ─── toPascalCase / toCamelCase ───

describe('case conversion', () => {
  it('should convert to PascalCase', () => {
    expect(toPascalCase('oneTimePaymentFixedReceive')).toBe(
      'OneTimePaymentFixedReceive',
    );
    expect(toPascalCase('rotate-access-token')).toBe('RotateAccessToken');
    expect(toPascalCase('list_incoming_payments')).toBe(
      'ListIncomingPayments',
    );
  });

  it('should convert to camelCase', () => {
    expect(toCamelCase('OneTimePayment')).toBe('oneTimePayment');
    expect(toCamelCase('rotate-access-token')).toBe('rotateAccessToken');
  });
});

// ─── End-to-end: parse → generate types ───

describe('parse → type generation', () => {
  it('should generate correct input types from parsed Arazzo', () => {
    const yaml = `
arazzo: "1.0.1"
info:
  title: "Test"
  version: "1.0.0"
sourceDescriptions:
  - name: api
    url: ./api.yaml
    type: openapi
workflows:
  - workflowId: sendPayment
    inputs:
      type: object
      required:
        - recipientUrl
        - amount
        - assetCode
      properties:
        recipientUrl:
          type: string
          description: "Recipient wallet address"
        amount:
          type: string
          description: "Amount in minor units"
        assetCode:
          type: string
        assetScale:
          type: integer
    steps:
      - stepId: resolve
        operationId: api.resolve-wallet
    outputs:
      paymentId: $steps.resolve.outputs.id
`;
    const parsed = parseArazzoContent(yaml);
    const workflow = parsed.document.workflows[0];

    // Generate input interface
    const inputInterface = generateInterface(
      'SendPaymentInputs',
      workflow.inputs!,
    );
    expect(inputInterface).toContain('recipientUrl: string;');
    expect(inputInterface).toContain('amount: string;');
    expect(inputInterface).toContain('assetCode: string;');
    expect(inputInterface).toContain('assetScale?: number;');

    // Generate output interface
    const outputInterface = generateOutputInterface(
      'SendPaymentOutputs',
      workflow.outputs!,
    );
    expect(outputInterface).toContain('paymentId: string;');
  });
});
