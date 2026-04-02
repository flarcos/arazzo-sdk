/**
 * Live Integration Test
 *
 * Tests the Arazzo SDK against the real Interledger test network at
 * https://wallet.interledger-test.dev
 *
 * This script executes a non-interactive grant flow to create an incoming
 * payment on the recipient's wallet, demonstrating:
 *
 *   1. Wallet address resolution (dynamic server URL discovery)
 *   2. GNAP grant request with HTTP message signatures
 *   3. Incoming payment creation with the acquired token
 *   4. Dynamic token passing between steps
 *
 * Usage:
 *   npx tsx test/live-integration.ts
 *
 * NOTE: This test uses real testnet wallets. The private keys are for
 * the Interledger test environment only.
 */

import { createPrivateKey, sign, createHash, randomUUID } from 'node:crypto';
import { parseArazzoFile } from '../src/parser/arazzo-parser.js';
import { executeWorkflow } from '../src/runtime/workflow-executor.js';
import type { WorkflowObject, StepObject } from '../src/parser/types.js';
import type {
  HttpRequest,
  HttpResponse,
  HttpClient,
  StepResult,
} from '../src/runtime/types.js';

// ═══════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════

const SENDER_WALLET = 'https://ilp.interledger-test.dev/f1d23a83';
const SENDER_KEY_ID = '48d90776-9205-4cf9-84bb-d80ef4f6c521';
const SENDER_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIGKgHIKkyciU4CeVPX205ymcia4H9yB/b9qOi3rd8Rm7
-----END PRIVATE KEY-----`;

const RECIPIENT_WALLET = 'https://ilp.interledger-test.dev/arazzotest';
const RECIPIENT_KEY_ID = '0f1862a0-481b-440d-b09e-6e11dca26782';
const RECIPIENT_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MC4CAQAwBQYDK2VwBCIEIFNX4jrFI6Xd4EqZlPKAwWBetg/kxB8KP++XmercHU9k
-----END PRIVATE KEY-----`;

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Client with GNAP Signatures
// ═══════════════════════════════════════════════════════════════════════════

/**
 * HTTP client that signs requests with HTTP Message Signatures (RFC 9421)
 * for GNAP authentication (RFC 9635).
 */
class SignedHttpClient implements HttpClient {
  private currentToken: string | null = null;
  private privateKeyPem: string;
  private keyId: string;

  constructor(privateKeyPem: string, keyId: string) {
    this.privateKeyPem = privateKeyPem;
    this.keyId = keyId;
  }

  setToken(token: string) {
    this.currentToken = token;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    const headers = new Headers(request.headers);

    // Add authorization if we have a token
    if (this.currentToken) {
      headers.set('Authorization', `GNAP ${this.currentToken}`);
    }

    // Add content-digest for requests with bodies
    let bodyStr: string | undefined;
    if (request.body) {
      bodyStr = JSON.stringify(request.body);
      const hash = createHash('sha-256').update(bodyStr).digest('base64');
      headers.set('Content-Digest', `sha-256=:${hash}:`);
      headers.set('Content-Length', Buffer.byteLength(bodyStr).toString());
      headers.set('Content-Type', 'application/json');
    }

    // Create HTTP Message Signature
    const sigInput = this.createSignatureInput(request.method, url, headers);
    const signature = this.signMessage(sigInput.base);

    headers.set('Signature-Input', sigInput.input);
    headers.set('Signature', `sig1=:${signature}:`);

    console.log(`  → ${request.method} ${request.url}`);

    const response = await fetch(request.url, {
      method: request.method,
      headers: Object.fromEntries(headers.entries()),
      body: bodyStr,
    });

    const responseBody = response.headers.get('content-type')?.includes('json')
      ? await response.json()
      : await response.text();

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    console.log(`  ← ${response.status} ${response.statusText}`);

    return {
      status: response.status,
      headers: responseHeaders,
      body: responseBody,
    };
  }

  private createSignatureInput(
    method: string,
    url: URL,
    headers: Headers,
  ): { base: string; input: string } {
    // Covered components for GNAP
    const components: string[] = ['"@method"', '"@target-uri"'];

    if (headers.has('Authorization')) {
      components.push('"authorization"');
    }
    if (headers.has('Content-Digest')) {
      components.push('"content-digest"');
      components.push('"content-length"');
      components.push('"content-type"');
    }

    // Build signature base
    const lines: string[] = [];
    for (const comp of components) {
      const name = comp.replace(/"/g, '');
      if (name === '@method') {
        lines.push(`"@method": ${method.toUpperCase()}`);
      } else if (name === '@target-uri') {
        lines.push(`"@target-uri": ${url.toString()}`);
      } else {
        lines.push(`"${name}": ${headers.get(name) || ''}`);
      }
    }

    const created = Math.floor(Date.now() / 1000);
    const keyIdUri = `${SENDER_WALLET}/jwks.json`;
    const params = `(${components.join(' ')});created=${created};keyid="${this.keyId}";alg="ed25519"`;
    lines.push(`"@signature-params": ${params}`);

    return {
      base: lines.join('\n'),
      input: `sig1=${params}`,
    };
  }

  private signMessage(base: string): string {
    const key = createPrivateKey(this.privateKeyPem);
    const signature = sign(null, Buffer.from(base), key);
    return signature.toString('base64');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Test: Partial Workflow (Steps 1-3)
// ═══════════════════════════════════════════════════════════════════════════

async function runLiveTest() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Arazzo SDK — Live Integration Test');
  console.log('  Network: Interledger Testnet');
  console.log('═══════════════════════════════════════════════════════\n');

  // ─── Step 1: Resolve recipient wallet address ───
  console.log('Step 1: Resolving recipient wallet address...');
  const walletResponse = await fetch(RECIPIENT_WALLET, {
    headers: { Accept: 'application/json' },
  });
  const walletData = await walletResponse.json() as Record<string, unknown>;
  console.log(`  ✅ Wallet: ${walletData.id}`);
  console.log(`  ✅ Auth Server: ${walletData.authServer}`);
  console.log(`  ✅ Resource Server: ${walletData.resourceServer}`);
  console.log(`  ✅ Asset: ${walletData.assetCode} (scale ${walletData.assetScale})\n`);

  const authServer = walletData.authServer as string;
  const resourceServer = walletData.resourceServer as string;

  // ─── Step 2: Request non-interactive grant for incoming payment ───
  console.log('Step 2: Requesting GNAP grant for incoming payment...');

  const httpClient = new SignedHttpClient(SENDER_PRIVATE_KEY, SENDER_KEY_ID);

  const grantBody = {
    access_token: {
      access: [
        {
          type: 'incoming-payment',
          actions: ['create', 'read', 'list'],
          identifier: RECIPIENT_WALLET,
        },
      ],
    },
    client: SENDER_WALLET,
  };

  const grantResponse = await httpClient.execute({
    url: authServer,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: grantBody,
  });

  if (grantResponse.status !== 200) {
    console.error(`  ❌ Grant request failed: ${grantResponse.status}`);
    console.error(`  Response:`, JSON.stringify(grantResponse.body, null, 2));
    process.exit(1);
  }

  const grantData = grantResponse.body as Record<string, unknown>;
  const accessTokenObj = grantData.access_token as Record<string, unknown>;
  const accessToken = accessTokenObj.value as string;
  console.log(`  ✅ Access token acquired: ${accessToken.substring(0, 20)}...`);
  console.log(`  ✅ Token expires in: ${accessTokenObj.expires_in}s\n`);

  // ─── Step 3: Create incoming payment ───
  console.log('Step 3: Creating incoming payment on recipient wallet...');

  httpClient.setToken(accessToken);

  const incomingPaymentBody = {
    walletAddress: RECIPIENT_WALLET,
    incomingAmount: {
      value: '100',
      assetCode: 'EUR',
      assetScale: 2,
    },
  };

  const ipResponse = await httpClient.execute({
    url: `${resourceServer}/incoming-payments`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: incomingPaymentBody,
  });

  if (ipResponse.status === 201) {
    const ipData = ipResponse.body as Record<string, unknown>;
    console.log(`  ✅ Incoming payment created!`);
    console.log(`  ✅ ID: ${ipData.id}`);
    console.log(`  ✅ Amount: ${(ipData.incomingAmount as Record<string, unknown>)?.value} ${(ipData.incomingAmount as Record<string, unknown>)?.assetCode}`);
    console.log(`  ✅ Completed: ${ipData.completed}`);
  } else {
    console.error(`  ❌ Failed: ${ipResponse.status}`);
    console.error(`  Response:`, JSON.stringify(ipResponse.body, null, 2));
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  Test Complete');
  console.log('═══════════════════════════════════════════════════════');
}

runLiveTest().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
