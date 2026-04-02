/**
 * Live Integration Test — Full Payment Flow
 *
 * Executes the complete 9-step one-time payment workflow against the
 * Interledger test network:
 *
 *   1. Resolve recipient wallet address
 *   2. Request incoming payment grant (non-interactive)
 *   3. Create incoming payment
 *   4. Resolve sender wallet address
 *   5. Request quote grant (non-interactive)
 *   6. Create quote
 *   7. Request outgoing payment grant (interactive — opens browser)
 *   8. Continue grant after user consent
 *   9. Create outgoing payment → money moves!
 *
 * Usage:
 *   npx tsx test/live-integration.ts
 */

import { createPrivateKey, sign, createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exec } from 'node:child_process';
import type {
  HttpRequest,
  HttpResponse,
  HttpClient,
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

const PAYMENT_AMOUNT = '100'; // €1.00

// ═══════════════════════════════════════════════════════════════════════════
// HTTP Client with GNAP Signatures
// ═══════════════════════════════════════════════════════════════════════════

class SignedHttpClient implements HttpClient {
  private currentToken: string | null = null;
  private privateKeyPem: string;
  private keyId: string;
  private walletUrl: string;

  constructor(privateKeyPem: string, keyId: string, walletUrl: string) {
    this.privateKeyPem = privateKeyPem;
    this.keyId = keyId;
    this.walletUrl = walletUrl;
  }

  setToken(token: string | null) {
    this.currentToken = token;
  }

  async execute(request: HttpRequest): Promise<HttpResponse> {
    const url = new URL(request.url);
    const headers = new Headers();

    // Copy provided headers
    for (const [key, value] of Object.entries(request.headers)) {
      headers.set(key, value);
    }

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
    const components: string[] = ['"@method"', '"@target-uri"'];

    if (headers.has('Authorization')) {
      components.push('"authorization"');
    }
    if (headers.has('Content-Digest')) {
      components.push('"content-digest"');
      components.push('"content-length"');
      components.push('"content-type"');
    }

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
// Local Callback Server for Interactive Grant
// ═══════════════════════════════════════════════════════════════════════════

function startCallbackServer(): Promise<{
  callbackUrl: string;
  waitForCallback: () => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve) => {
    let resolveCallback: (interactRef: string) => void;
    const callbackPromise = new Promise<string>((res) => {
      resolveCallback = res;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost`);
      const interactRef = url.searchParams.get('interact_ref');
      const hash = url.searchParams.get('hash');

      console.log(`\n  🔔 Callback received!`);
      console.log(`  interact_ref: ${interactRef}`);
      console.log(`  hash: ${hash}`);

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`
        <html>
          <body style="font-family: system-ui; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background: #1a1a2e; color: #e0e0e0;">
            <div style="text-align: center;">
              <h1 style="color: #4ade80;">✅ Payment Authorized!</h1>
              <p>You can close this tab. The SDK is completing the payment...</p>
            </div>
          </body>
        </html>
      `);

      if (interactRef) {
        resolveCallback(interactRef);
      }
    });

    server.listen(3344, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const callbackUrl = `http://localhost:${addr.port}/callback`;
      console.log(`  📡 Callback server listening on ${callbackUrl}`);

      resolve({
        callbackUrl,
        waitForCallback: () => callbackPromise,
        close: () => server.close(),
      });
    });
  });
}

function openBrowser(url: string) {
  // macOS
  exec(`open "${url}"`);
}

// ═══════════════════════════════════════════════════════════════════════════
// Full Payment Flow
// ═══════════════════════════════════════════════════════════════════════════

async function runFullPaymentFlow() {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  Arazzo SDK — Full Payment Flow (Live)');
  console.log('  Network: Interledger Testnet');
  console.log(`  Sender:    ${SENDER_WALLET}`);
  console.log(`  Recipient: ${RECIPIENT_WALLET}`);
  console.log(`  Amount:    €${(parseInt(PAYMENT_AMOUNT) / 100).toFixed(2)} EUR`);
  console.log('═══════════════════════════════════════════════════════\n');

  const httpClient = new SignedHttpClient(SENDER_PRIVATE_KEY, SENDER_KEY_ID, SENDER_WALLET);

  // ─── Step 1: Resolve recipient wallet address ───
  console.log('Step 1: Resolving recipient wallet address...');
  const recipientWallet = await resolveWallet(RECIPIENT_WALLET);
  console.log(`  ✅ Auth Server: ${recipientWallet.authServer}`);
  console.log(`  ✅ Resource Server: ${recipientWallet.resourceServer}\n`);

  // ─── Step 2: Request grant for incoming payment ───
  console.log('Step 2: Requesting grant for incoming payment...');
  httpClient.setToken(null);

  const ipGrant = await httpClient.execute({
    url: recipientWallet.authServer,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      access_token: {
        access: [{
          type: 'incoming-payment',
          actions: ['create', 'read'],
          identifier: RECIPIENT_WALLET,
        }],
      },
      client: SENDER_WALLET,
    },
  });

  const ipToken = (ipGrant.body as any).access_token.value;
  console.log(`  ✅ Token: ${ipToken.substring(0, 20)}...\n`);

  // ─── Step 3: Create incoming payment ───
  console.log('Step 3: Creating incoming payment...');
  httpClient.setToken(ipToken);

  const ipResponse = await httpClient.execute({
    url: `${recipientWallet.resourceServer}/incoming-payments`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      walletAddress: RECIPIENT_WALLET,
      incomingAmount: {
        value: PAYMENT_AMOUNT,
        assetCode: 'EUR',
        assetScale: 2,
      },
    },
  });

  const incomingPaymentUrl = (ipResponse.body as any).id;
  console.log(`  ✅ Incoming Payment: ${incomingPaymentUrl}\n`);

  // ─── Step 4: Resolve sender wallet address ───
  console.log('Step 4: Resolving sender wallet address...');
  const senderWallet = await resolveWallet(SENDER_WALLET);
  console.log(`  ✅ Auth Server: ${senderWallet.authServer}`);
  console.log(`  ✅ Resource Server: ${senderWallet.resourceServer}\n`);

  // ─── Step 5: Request grant for quote ───
  console.log('Step 5: Requesting grant for quote...');
  httpClient.setToken(null);

  const quoteGrant = await httpClient.execute({
    url: senderWallet.authServer,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      access_token: {
        access: [{
          type: 'quote',
          actions: ['create', 'read'],
        }],
      },
      client: SENDER_WALLET,
    },
  });

  const quoteToken = (quoteGrant.body as any).access_token.value;
  console.log(`  ✅ Token: ${quoteToken.substring(0, 20)}...\n`);

  // ─── Step 6: Create quote ───
  console.log('Step 6: Creating quote...');
  httpClient.setToken(quoteToken);

  const quoteResponse = await httpClient.execute({
    url: `${senderWallet.resourceServer}/quotes`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      walletAddress: SENDER_WALLET,
      receiver: incomingPaymentUrl,
      method: 'ilp',
    },
  });

  const quoteData = quoteResponse.body as any;
  const quoteId = quoteData.id;
  console.log(`  ✅ Quote: ${quoteId}`);
  console.log(`  ✅ Debit:   ${quoteData.debitAmount.value} ${quoteData.debitAmount.assetCode}`);
  console.log(`  ✅ Receive: ${quoteData.receiveAmount.value} ${quoteData.receiveAmount.assetCode}\n`);

  // ─── Step 7: Request interactive grant for outgoing payment ───
  console.log('Step 7: Requesting interactive grant for outgoing payment...');

  // Start callback server first
  const callback = await startCallbackServer();
  const finishNonce = randomBytes(16).toString('hex');

  httpClient.setToken(null);

  const opGrant = await httpClient.execute({
    url: senderWallet.authServer,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      access_token: {
        access: [{
          type: 'outgoing-payment',
          actions: ['create', 'read'],
          identifier: SENDER_WALLET,
          limits: {
            debitAmount: quoteData.debitAmount,
          },
        }],
      },
      client: SENDER_WALLET,
      interact: {
        start: ['redirect'],
        finish: {
          method: 'redirect',
          uri: callback.callbackUrl,
          nonce: finishNonce,
        },
      },
    },
  });

  const opGrantData = opGrant.body as any;

  if (opGrant.status !== 200) {
    console.log(`  ❌ Grant request failed: ${opGrant.status}`);
    console.log(`  Response:`, JSON.stringify(opGrantData, null, 2));
    callback.close();
    process.exit(1);
  }

  const redirectUrl = opGrantData.interact.redirect;
  const continueToken = opGrantData.continue.access_token.value;
  const continueUri = opGrantData.continue.uri;

  console.log(`  ✅ Redirect URL: ${redirectUrl}`);
  console.log(`  ✅ Continue URI: ${continueUri}`);
  console.log(`\n  🌐 Opening browser for consent — please APPROVE the payment...\n`);

  // Open browser for user consent
  openBrowser(redirectUrl);

  // Wait for the callback
  const interactRef = await callback.waitForCallback();
  callback.close();

  console.log(`  ✅ interact_ref received: ${interactRef}\n`);

  // ─── Step 8: Continue grant after consent ───
  console.log('Step 8: Continuing grant with interact_ref...');
  httpClient.setToken(continueToken);

  const continueResponse = await httpClient.execute({
    url: continueUri,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      interact_ref: interactRef,
    },
  });

  const outgoingToken = (continueResponse.body as any).access_token.value;
  console.log(`  ✅ Outgoing payment token: ${outgoingToken.substring(0, 20)}...\n`);

  // ─── Step 9: Create outgoing payment ───
  console.log('Step 9: Creating outgoing payment (sending money!)...');
  httpClient.setToken(outgoingToken);

  const opResponse = await httpClient.execute({
    url: `${senderWallet.resourceServer}/outgoing-payments`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: {
      walletAddress: SENDER_WALLET,
      quoteId: quoteId,
    },
  });

  const opData = opResponse.body as any;

  if (opResponse.status === 201) {
    console.log(`  ✅ Outgoing Payment: ${opData.id}`);
    console.log(`  ✅ Failed: ${opData.failed}`);
    console.log(`  ✅ Sent Amount: ${opData.sentAmount?.value} ${opData.sentAmount?.assetCode}`);
    console.log(`  ✅ Receive Amount: ${opData.receiveAmount?.value} ${opData.receiveAmount?.assetCode}`);
  } else {
    console.log(`  ❌ Failed: ${opResponse.status}`);
    console.log(`  Response:`, JSON.stringify(opData, null, 2));
  }

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  💸 Payment Complete!');
  console.log('═══════════════════════════════════════════════════════');
}

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

async function resolveWallet(walletUrl: string): Promise<{
  authServer: string;
  resourceServer: string;
  assetCode: string;
  assetScale: number;
}> {
  const res = await fetch(walletUrl, {
    headers: { Accept: 'application/json' },
  });
  return res.json() as any;
}

// ═══════════════════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════════════════

runFullPaymentFlow().catch((err) => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
