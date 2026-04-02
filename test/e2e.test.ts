/**
 * End-to-End Test
 *
 * Tests the full Arazzo SDK pipeline:
 *
 *   1. Parse real Arazzo YAML files
 *   2. Execute a workflow against a mock Open Payments server
 *   3. Verify dynamic token passing between steps
 *   4. Verify dynamic server URL resolution from wallet address
 *   5. Verify interactive grant handling with consent flow
 *   6. Verify final workflow outputs
 *
 * The mock server simulates the complete Open Payments API, returning
 * appropriate responses for each step in the one-time-payment-fixed-receive
 * workflow.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseArazzoFile } from '../src/parser/arazzo-parser.js';
import { executeWorkflow } from '../src/runtime/workflow-executor.js';
import type {
  WorkflowResult,
  HttpRequest,
  StepResult,
  InteractionContext,
} from '../src/runtime/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Mock Open Payments Server
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Tracks all requests received by the mock server for assertion.
 */
interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

let mockServer: ReturnType<typeof createServer>;
let baseUrl: string;
const requestLog: MockRequest[] = [];

/**
 * Create a local HTTP server that simulates the Open Payments API.
 * Returns appropriate responses for each operation in the workflow.
 */
function createMockServer() {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req);
    const url = req.url || '/';
    const method = req.method || 'GET';

    // Log the request
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers[key] = value;
    }
    requestLog.push({ method, url, headers, body });

    // ─── Route: Wallet Address Resolution ───
    if (method === 'GET' && url === '/') {
      // Determine which wallet address is being resolved based on Host or request sequence
      const reqCount = requestLog.filter(
        (r) => r.method === 'GET' && r.url === '/',
      ).length;

      if (reqCount <= 1) {
        // First wallet resolve → recipient
        respondJson(res, 200, {
          id: `${baseUrl}/alice`,
          assetCode: 'USD',
          assetScale: 2,
          authServer: `${baseUrl}/auth`,
          resourceServer: `${baseUrl}/rs`,
        });
      } else {
        // Second wallet resolve → sender
        respondJson(res, 200, {
          id: `${baseUrl}/bob`,
          assetCode: 'USD',
          assetScale: 2,
          authServer: `${baseUrl}/auth`,
          resourceServer: `${baseUrl}/rs`,
        });
      }
      return;
    }

    // ─── Route: GNAP Grant Request ───
    if (method === 'POST' && url === '/auth') {
      const payload = body as Record<string, unknown>;
      const accessTokenReq = payload?.access_token as Record<string, unknown>;
      const access = accessTokenReq?.access as Array<Record<string, unknown>>;
      const resourceType = access?.[0]?.type;

      // Check if it's an interactive grant (has interact field)
      const hasInteract = !!(payload?.interact);

      if (hasInteract) {
        // Interactive grant → return redirect URL
        respondJson(res, 200, {
          interact: {
            redirect: `${baseUrl}/consent?grant=outgoing-payment`,
            finish: 'server-nonce-xyz',
          },
          continue: {
            access_token: { value: 'continue_tok_456' },
            uri: `${baseUrl}/auth/continue/grant-id-789`,
            wait: 5,
          },
        });
      } else {
        // Non-interactive grant → return access token directly
        const tokenValue =
          resourceType === 'incoming-payment'
            ? 'incoming_tok_abc'
            : resourceType === 'quote'
              ? 'quote_tok_def'
              : resourceType === 'outgoing-payment'
                ? 'outgoing_tok_ghi'
                : `generic_tok_${Date.now()}`;

        respondJson(res, 200, {
          access_token: {
            value: tokenValue,
            manage: `${baseUrl}/auth/token/manage-${tokenValue}`,
            expires_in: 600,
            access: access,
          },
          continue: {
            access_token: { value: `cont_${tokenValue}` },
            uri: `${baseUrl}/auth/continue/${tokenValue}`,
          },
        });
      }
      return;
    }

    // ─── Route: Grant Continuation ───
    if (method === 'POST' && url.startsWith('/auth/continue/')) {
      const contBody = body as Record<string, unknown>;
      respondJson(res, 200, {
        access_token: {
          value: 'outgoing_tok_final',
          manage: `${baseUrl}/auth/token/manage-outgoing`,
          expires_in: 600,
          access: [
            {
              type: 'outgoing-payment',
              actions: ['create', 'read'],
            },
          ],
        },
        // Verify interact_ref was included
        _received_interact_ref: contBody?.interact_ref,
      });
      return;
    }

    // ─── Route: Create Incoming Payment ───
    if (method === 'POST' && url === '/rs/incoming-payments') {
      const ipBody = body as Record<string, unknown>;
      respondJson(res, 201, {
        id: `${baseUrl}/rs/incoming-payments/ip-12345`,
        walletAddress: ipBody?.walletAddress,
        incomingAmount: ipBody?.incomingAmount,
        receivedAmount: { value: '0', assetCode: 'USD', assetScale: 2 },
        completed: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        methods: [
          {
            type: 'ilp',
            ilpAddress: 'g.interledger.testnet.alice.ip-12345',
            sharedSecret: 'c2hhcmVkLXNlY3JldA==',
          },
        ],
      });
      return;
    }

    // ─── Route: Create Quote ───
    if (method === 'POST' && url === '/rs/quotes') {
      const qBody = body as Record<string, unknown>;
      respondJson(res, 201, {
        id: `${baseUrl}/rs/quotes/quote-67890`,
        walletAddress: qBody?.walletAddress,
        receiver: qBody?.receiver,
        method: 'ilp',
        debitAmount: { value: '2575', assetCode: 'USD', assetScale: 2 },
        receiveAmount: { value: '2500', assetCode: 'USD', assetScale: 2 },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
      });
      return;
    }

    // ─── Route: Create Outgoing Payment ───
    if (method === 'POST' && url === '/rs/outgoing-payments') {
      const opBody = body as Record<string, unknown>;
      respondJson(res, 201, {
        id: `${baseUrl}/rs/outgoing-payments/op-abcde`,
        walletAddress: opBody?.walletAddress,
        quoteId: opBody?.quoteId,
        failed: false,
        debitAmount: { value: '2575', assetCode: 'USD', assetScale: 2 },
        sentAmount: { value: '2575', assetCode: 'USD', assetScale: 2 },
        receiveAmount: { value: '2500', assetCode: 'USD', assetScale: 2 },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      return;
    }

    // ─── Route: Token Rotation ───
    if (method === 'POST' && url.startsWith('/auth/token/')) {
      respondJson(res, 200, {
        access_token: {
          value: 'rotated_tok_new',
          manage: `${baseUrl}/auth/token/manage-rotated`,
          expires_in: 3600,
        },
      });
      return;
    }

    // ─── Route: Token Revocation ───
    if (method === 'DELETE' && url.startsWith('/auth/token/')) {
      res.writeHead(204);
      res.end();
      return;
    }

    // ─── Route: Grant Cancellation ───
    if (method === 'DELETE' && url.startsWith('/auth/continue/')) {
      res.writeHead(204);
      res.end();
      return;
    }

    // ─── Fallback ───
    respondJson(res, 404, { error: `Unknown route: ${method} ${url}` });
  });
}

function respondJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw || null);
      }
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Test Setup
// ═══════════════════════════════════════════════════════════════════════════

beforeAll(async () => {
  mockServer = createMockServer();
  await new Promise<void>((resolve) => {
    mockServer.listen(0, '127.0.0.1', () => {
      const addr = mockServer.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    mockServer.close(() => resolve());
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E Tests
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: One-Time Payment Fixed Receive', () => {
  let result: WorkflowResult;
  const stepEvents: Array<{ event: string; stepId: string; detail?: string }> = [];
  const tokensAcquired: Array<{ stepId: string; token: string; type: string }> = [];
  const serversResolved: Array<{ stepId: string; servers: Record<string, string> }> = [];
  let interactionCalled = false;
  let interactionRedirectUrl = '';

  beforeAll(async () => {
    // Parse the real Arazzo workflow file
    const parsed = parseArazzoFile('../arazzo/one-time-payment-fixed-receive.arazzo.yaml');
    const workflow = parsed.document.workflows[0];

    // Clear tracking
    requestLog.length = 0;

    // Execute the workflow against the mock server
    result = await executeWorkflow(workflow, {
      inputs: {
        recipientWalletAddressUrl: `${baseUrl}/alice`,
        senderWalletAddressUrl: `${baseUrl}/bob`,
        amount: '2500',
        assetCode: 'USD',
        assetScale: 2,
        clientWalletAddress: `${baseUrl}/client`,
        finishUri: 'https://myapp.example.com/callback',
        finishNonce: 'test-nonce-12345',
      },
      serverUrls: {
        walletAddressServer: baseUrl,
        resourceServer: baseUrl,
        authServer: baseUrl,
      },
      // ─── Feature 2: Interactive grant handler ───
      interactionHandler: async (context: InteractionContext) => {
        interactionCalled = true;
        interactionRedirectUrl = context.redirectUrl;
        // Simulate: user consents, redirect callback returns interact_ref
        return 'mock-interact-ref-xyz';
      },
      // ─── Hooks for tracking ───
      hooks: {
        beforeStep: (stepId, request) => {
          stepEvents.push({
            event: 'before',
            stepId,
            detail: `${request.method} ${request.url}`,
          });
        },
        afterStep: (stepId, stepResult) => {
          stepEvents.push({
            event: 'after',
            stepId,
            detail: `${stepResult.response.status} ${stepResult.success ? '✓' : '✗'}`,
          });
        },
        onTokenAcquired: (stepId, token, type) => {
          tokensAcquired.push({ stepId, token, type });
        },
        onServerResolved: (stepId, servers) => {
          serversResolved.push({ stepId, servers });
        },
      },
    });
  });

  // ─── Overall Result ───

  it('should complete the workflow successfully', () => {
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.workflowId).toBe('oneTimePaymentFixedReceive');
  });

  it('should execute all 9 steps', () => {
    expect(result.steps).toHaveLength(9);
    expect(result.steps.every((s) => s.success)).toBe(true);
  });

  it('should complete in a reasonable time', () => {
    expect(result.duration).toBeLessThan(5000);
  });

  // ─── Feature 1: Dynamic Token Passing ───

  describe('dynamic token passing', () => {
    it('should capture tokens from grant steps', () => {
      expect(tokensAcquired.length).toBeGreaterThanOrEqual(3);

      const tokenTypes = tokensAcquired.map((t) => t.type);
      expect(tokenTypes).toContain('incomingPaymentAccessToken');
      expect(tokenTypes).toContain('quoteAccessToken');
    });

    it('should inject incoming payment token into create-incoming-payment request', () => {
      // Step 3: createIncomingPayment should have auth header
      const createIpRequest = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/incoming-payments',
      );
      expect(createIpRequest).toBeDefined();
      expect(createIpRequest!.headers['authorization']).toBe(
        'GNAP incoming_tok_abc',
      );
    });

    it('should inject quote token into create-quote request', () => {
      // Step 6: createQuote should have auth header
      const createQuoteRequest = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/quotes',
      );
      expect(createQuoteRequest).toBeDefined();
      expect(createQuoteRequest!.headers['authorization']).toBe(
        'GNAP quote_tok_def',
      );
    });

    it('should inject outgoing payment token into create-outgoing-payment request', () => {
      // Step 9: createOutgoingPayment should have the final token
      const createOpRequest = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/outgoing-payments',
      );
      expect(createOpRequest).toBeDefined();
      expect(createOpRequest!.headers['authorization']).toBe(
        'GNAP outgoing_tok_final',
      );
    });

    it('should NOT inject auth tokens into wallet address resolution requests', () => {
      const walletRequests = requestLog.filter(
        (r) => r.method === 'GET' && r.url === '/',
      );
      for (const req of walletRequests) {
        expect(req.headers['authorization']).toBeUndefined();
      }
    });
  });

  // ─── Feature 2: Interactive Grant Handling ───

  describe('interactive grant handling', () => {
    it('should call the interaction handler', () => {
      expect(interactionCalled).toBe(true);
    });

    it('should pass the redirect URL to the handler', () => {
      expect(interactionRedirectUrl).toContain('/consent?grant=outgoing-payment');
    });

    it('should inject interact_ref into the grant continuation request', () => {
      const continueRequest = requestLog.find(
        (r) => r.method === 'POST' && r.url.startsWith('/auth/continue/'),
      );
      expect(continueRequest).toBeDefined();
      const contBody = continueRequest!.body as Record<string, unknown>;
      expect(contBody.interact_ref).toBe('mock-interact-ref-xyz');
    });

    it('should capture the interaction context on the step result', () => {
      const interactiveStep = result.steps.find(
        (s) => s.stepId === 'requestOutgoingPaymentGrant',
      );
      expect(interactiveStep).toBeDefined();
      expect(interactiveStep!.interaction).toBeDefined();
      expect(interactiveStep!.interaction!.redirectUrl).toContain('/consent');
      expect(interactiveStep!.interaction!.continueAccessToken).toBe(
        'continue_tok_456',
      );
    });
  });

  // ─── Feature 3: Dynamic Server URL Resolution ───

  describe('dynamic server URL resolution', () => {
    it('should resolve server URLs from wallet address steps', () => {
      expect(serversResolved.length).toBeGreaterThanOrEqual(1);
    });

    it('should capture authServer and resourceServer from wallet address response', () => {
      const firstResolution = serversResolved[0];
      expect(firstResolution.servers).toHaveProperty('authServer');
      expect(firstResolution.servers).toHaveProperty('resourceServer');
    });

    it('should use the dynamically resolved URLs for subsequent requests', () => {
      // After wallet address resolution, auth requests should go to the resolved URL
      const authRequests = requestLog.filter(
        (r) => r.method === 'POST' && r.url === '/auth',
      );
      expect(authRequests.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Workflow Outputs ───

  describe('workflow outputs', () => {
    it('should return the incoming payment URL', () => {
      expect(result.outputs.incomingPaymentUrl).toContain(
        '/incoming-payments/ip-12345',
      );
    });

    it('should return the quote ID', () => {
      expect(result.outputs.quoteId).toContain('/quotes/quote-67890');
    });

    it('should return the outgoing payment ID', () => {
      expect(result.outputs.outgoingPaymentId).toContain(
        '/outgoing-payments/op-abcde',
      );
    });

    it('should return the debit amount', () => {
      const debit = result.outputs.debitAmount as Record<string, unknown>;
      expect(debit).toBeDefined();
      expect(debit.value).toBe('2575');
      expect(debit.assetCode).toBe('USD');
      expect(debit.assetScale).toBe(2);
    });

    it('should return the receive amount', () => {
      const receive = result.outputs.receiveAmount as Record<string, unknown>;
      expect(receive).toBeDefined();
      expect(receive.value).toBe('2500');
      expect(receive.assetCode).toBe('USD');
      expect(receive.assetScale).toBe(2);
    });
  });

  // ─── Step-by-Step Verification ───

  describe('step execution order', () => {
    it('should execute steps in the correct sequence', () => {
      const stepIds = result.steps.map((s) => s.stepId);
      expect(stepIds).toEqual([
        'getRecipientWalletAddress',
        'requestIncomingPaymentGrant',
        'createIncomingPayment',
        'getSenderWalletAddress',
        'requestQuoteGrant',
        'createQuote',
        'requestOutgoingPaymentGrant',
        'continueOutgoingPaymentGrant',
        'createOutgoingPayment',
      ]);
    });

    it('should pass expressions between steps correctly', () => {
      // createQuote should reference the incoming payment URL from createIncomingPayment
      const createQuoteReq = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/quotes',
      );
      const quoteBody = createQuoteReq!.body as Record<string, unknown>;
      expect(quoteBody.receiver).toContain('/incoming-payments/ip-12345');
    });

    it('should pass quote ID to outgoing payment creation', () => {
      const createOpReq = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/outgoing-payments',
      );
      const opBody = createOpReq!.body as Record<string, unknown>;
      expect(opBody.quoteId).toContain('/quotes/quote-67890');
    });
  });

  // ─── Hooks ───

  describe('execution hooks', () => {
    it('should fire beforeStep and afterStep for each step', () => {
      const beforeEvents = stepEvents.filter((e) => e.event === 'before');
      const afterEvents = stepEvents.filter((e) => e.event === 'after');

      expect(beforeEvents).toHaveLength(9);
      expect(afterEvents).toHaveLength(9);
    });

    it('should report all steps as successful', () => {
      const afterEvents = stepEvents.filter((e) => e.event === 'after');
      for (const event of afterEvents) {
        expect(event.detail).toContain('✓');
      }
    });
  });

  // ─── Request Body Verification ───

  describe('request body construction', () => {
    it('should resolve $inputs expressions in grant request bodies', () => {
      const firstGrantReq = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/auth',
      );
      const grantBody = firstGrantReq!.body as Record<string, unknown>;
      expect(grantBody.client).toContain('/client');
    });

    it('should resolve $inputs in incoming payment body', () => {
      const ipReq = requestLog.find(
        (r) => r.method === 'POST' && r.url === '/rs/incoming-payments',
      );
      const ipBody = ipReq!.body as Record<string, unknown>;
      expect(ipBody.walletAddress).toContain('/alice');

      const amount = ipBody.incomingAmount as Record<string, unknown>;
      expect(amount.value).toBe('2500');
      expect(amount.assetCode).toBe('USD');
      expect(amount.assetScale).toBe(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Token Management Workflows
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Token Management', () => {
  it('should execute rotateAccessToken workflow', async () => {
    const parsed = parseArazzoFile('../arazzo/token-management.arazzo.yaml');
    const rotateWorkflow = parsed.document.workflows.find(
      (w) => w.workflowId === 'rotateAccessToken',
    )!;

    const result = await executeWorkflow(rotateWorkflow, {
      inputs: {
        tokenManageUrl: `${baseUrl}/auth/token/manage-abc`,
      },
      serverUrls: {
        authServer: `${baseUrl}/auth`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.outputs.accessToken).toBe('rotated_tok_new');
    expect(result.outputs.manageUrl).toContain('/auth/token/manage-rotated');
  });

  it('should execute revokeAccessToken workflow', async () => {
    const parsed = parseArazzoFile('../arazzo/token-management.arazzo.yaml');
    const revokeWorkflow = parsed.document.workflows.find(
      (w) => w.workflowId === 'revokeAccessToken',
    )!;

    const result = await executeWorkflow(revokeWorkflow, {
      inputs: {
        tokenManageUrl: `${baseUrl}/auth/token/manage-abc`,
      },
      serverUrls: {
        authServer: `${baseUrl}/auth`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].response.status).toBe(204);
  });

  it('should execute cancelGrant workflow', async () => {
    const parsed = parseArazzoFile('../arazzo/token-management.arazzo.yaml');
    const cancelWorkflow = parsed.document.workflows.find(
      (w) => w.workflowId === 'cancelGrant',
    )!;

    const result = await executeWorkflow(cancelWorkflow, {
      inputs: {
        continueUri: `${baseUrl}/auth/continue/grant-xyz`,
      },
      serverUrls: {
        authServer: `${baseUrl}/auth`,
      },
    });

    expect(result.success).toBe(true);
    expect(result.steps).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// E2E: Error Handling
// ═══════════════════════════════════════════════════════════════════════════

describe('E2E: Error Handling', () => {
  it('should fail gracefully when interaction handler is missing', async () => {
    const parsed = parseArazzoFile('../arazzo/one-time-payment-fixed-receive.arazzo.yaml');
    const workflow = parsed.document.workflows[0];

    const result = await executeWorkflow(workflow, {
      inputs: {
        recipientWalletAddressUrl: `${baseUrl}/alice`,
        senderWalletAddressUrl: `${baseUrl}/bob`,
        amount: '2500',
        assetCode: 'USD',
        assetScale: 2,
        clientWalletAddress: `${baseUrl}/client`,
      },
      serverUrls: {
        walletAddressServer: baseUrl,
        resourceServer: baseUrl,
        authServer: baseUrl,
      },
      // No interactionHandler provided!
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('interactionHandler');
    // Should have completed the first 7 steps before failing
    expect(result.steps.length).toBeGreaterThanOrEqual(7);
  });
});
