# @flarcos/arazzo-sdk

Parse [Arazzo 1.0.1](https://spec.openapis.org/arazzo/v1.0.1) workflow specifications and generate typed TypeScript SDKs for the [Open Payments API](https://openpayments.dev).

**Turn 9 sequential API calls into one function call:**

```typescript
import { OpenPaymentsClient } from '@flarcos/arazzo-sdk/generated';

const client = new OpenPaymentsClient({
  serverUrls: {
    walletAddressServer: 'https://wallet.example.com',
    resourceServer: 'https://wallet.example.com',
    authServer: 'https://auth.wallet.example.com',
  },
  gnapConfig: {
    clientWalletAddress: 'https://wallet.example.com/me',
    privateKey: myPrivateKey,
    keyId: 'my-key-id',
  },
  interactionHandler: async ({ redirectUrl }) => {
    // Redirect user for consent, return the interact_ref
    return await redirectUserForConsent(redirectUrl);
  },
});

const payment = await client.oneTimePaymentFixedReceive({
  recipientWalletAddressUrl: 'https://wallet.example.com/alice',
  senderWalletAddressUrl: 'https://wallet.example.com/bob',
  amount: '2500',
  assetCode: 'USD',
  assetScale: 2,
  clientWalletAddress: 'https://wallet.example.com/me',
});

console.log(payment.outgoingPaymentId);  // fully typed
console.log(payment.debitAmount);        // { value, assetCode, assetScale }
```

## Features

- **Code Generator** — Parse Arazzo YAML → emit typed TypeScript SDK
- **Runtime Executor** — Execute workflows dynamically without code generation
- **CLI Tool** — `generate`, `validate`, and `inspect` commands
- **Dynamic Token Passing** — Automatically captures GNAP tokens from grant steps and injects them into subsequent resource server calls
- **Interactive Grant Handling** — Pauses for user consent on interactive grants, then resumes automatically
- **Dynamic Server Discovery** — Resolves `authServer` and `resourceServer` URLs from wallet address lookups
- **GNAP Integration** — Wires up [`@flarcos/kiota-authentication-gnap`](../kiota-authentication-gnap) for RFC 9635 auth

## Installation

```bash
npm install @flarcos/arazzo-sdk
```

## CLI Usage

### Generate SDK

```bash
# Generate typed TypeScript SDK from Arazzo workflow files
arazzo-sdk generate -i "arazzo/*.arazzo.yaml" -o src/generated/

# Generate types only (no client class)
arazzo-sdk generate -i "arazzo/*.arazzo.yaml" -o src/generated/ --types-only
```

### Validate

```bash
# Validate Arazzo files for spec compliance
arazzo-sdk validate -i "arazzo/*.arazzo.yaml"
```

### Inspect

```bash
# Display workflow structure, inputs, steps, and outputs
arazzo-sdk inspect -i "arazzo/one-time-payment-fixed-receive.arazzo.yaml"
```

Output:
```
📄 Open Payments — One-Time Payment (Fixed Receive) (v1.0.0)
   Arazzo: 1.0.1
   Sources: walletAddressServer, resourceServer, authServer

   📋 Workflow: oneTimePaymentFixedReceive
      Inputs:
        - recipientWalletAddressUrl: string (required)
        - senderWalletAddressUrl: string (required)
        - amount: string (required)
        ...
      Steps:
        getRecipientWalletAddress → walletAddressServer.get-wallet-address
        requestIncomingPaymentGrant → authServer.post-request
        createIncomingPayment → resourceServer.create-incoming-payment
        ...
      Outputs:
        - outgoingPaymentId: $steps.createOutgoingPayment.outputs.outgoingPaymentId
        - debitAmount: $steps.createQuote.outputs.debitAmount
```

## Generated Workflows

| Method | Description | Steps |
|--------|-------------|-------|
| `oneTimePaymentFixedReceive()` | Fixed receive amount payment | 9 |
| `oneTimePaymentFixedSend()` | Fixed send amount payment | 9 |
| `setupRecurringPayment()` | Recurring payment with interval limits | 9 |
| `listIncomingPayments()` | Paginated incoming payment listing | 3 |
| `listOutgoingPayments()` | Paginated outgoing payment listing | 3 |
| `getPaymentDetails()` | Get specific payment details | 4 |
| `rotateAccessToken()` | Rotate a GNAP access token | 1 |
| `revokeAccessToken()` | Revoke a GNAP access token | 1 |
| `cancelGrant()` | Cancel an active grant | 1 |

## Programmatic API

### Parser

```typescript
import { parseArazzoFile, extractOperationIds } from '@flarcos/arazzo-sdk';

const parsed = parseArazzoFile('arazzo/one-time-payment-fixed-receive.arazzo.yaml');

console.log(parsed.document.workflows[0].workflowId);
// → 'oneTimePaymentFixedReceive'

const opIds = extractOperationIds(parsed.document);
// → ['walletAddressServer.get-wallet-address', 'authServer.post-request', ...]
```

### Runtime Executor

```typescript
import { executeWorkflow } from '@flarcos/arazzo-sdk';

const result = await executeWorkflow(workflow, {
  inputs: { recipientWalletAddressUrl: '...', amount: '2500' },
  serverUrls: {
    walletAddressServer: 'https://wallet.example.com',
    resourceServer: 'https://wallet.example.com',
    authServer: 'https://auth.wallet.example.com',
  },
  interactionHandler: async ({ redirectUrl }) => {
    return await getConsentFromUser(redirectUrl);
  },
  hooks: {
    beforeStep: (stepId, request) => {
      console.log(`→ ${stepId}: ${request.method} ${request.url}`);
    },
    afterStep: (stepId, result) => {
      console.log(`← ${stepId}: ${result.response.status}`);
    },
    onTokenAcquired: (stepId, token, type) => {
      console.log(`🔑 ${stepId}: acquired ${type}`);
    },
    onServerResolved: (stepId, servers) => {
      console.log(`🌐 ${stepId}: resolved`, servers);
    },
  },
});
```

### Code Generator

```typescript
import { parseArazzoFiles } from '@flarcos/arazzo-sdk';
import { generateSDK } from '@flarcos/arazzo-sdk';

const parsed = parseArazzoFiles(['workflow1.arazzo.yaml', 'workflow2.arazzo.yaml']);

generateSDK(parsed, {
  outputDir: 'src/generated',
  className: 'MyPaymentsClient',
});
```

## How Token Passing Works

The executor automatically manages GNAP tokens across steps:

```
Step 2: requestIncomingPaymentGrant (authServer)
  → Response: { access_token: { value: "tok_abc" } }
  → Executor captures "tok_abc" as current token

Step 3: createIncomingPayment (resourceServer)
  → Executor injects: Authorization: GNAP tok_abc
  → Token used automatically, no manual wiring needed
```

Token capture triggers on any step output matching `*AccessToken` or `accessToken`.

## How Interactive Grants Work

When a step returns `interact.redirect`, the executor pauses:

```
Step 7: requestOutgoingPaymentGrant (authServer)
  → Response: { interact: { redirect: "https://auth.example.com/consent/..." } }
  → Executor calls your interactionHandler(redirectUrl)
  → You redirect the user, collect consent, return interact_ref
  → Executor stores interact_ref and continues

Step 8: continueOutgoingPaymentGrant (authServer)
  → Executor injects interact_ref into the request body
  → Grant finalized, outgoing payment token acquired
```

## How Dynamic Server Resolution Works

Wallet address resolution steps automatically update server URLs:

```
Step 1: getRecipientWalletAddress (walletAddressServer)
  → Response: { authServer: "https://auth.recipient.com", resourceServer: "https://rs.recipient.com" }
  → Executor updates serverUrls.authServer and serverUrls.resourceServer
  → All subsequent steps use the discovered URLs
```

## Project Structure

```
arazzo-sdk/
├── src/
│   ├── index.ts                        # Public exports
│   ├── cli.ts                          # CLI entry point
│   ├── parser/
│   │   ├── types.ts                    # Arazzo 1.0.1 type definitions
│   │   └── arazzo-parser.ts            # YAML → typed AST
│   ├── generator/
│   │   ├── type-mapper.ts              # JSON Schema → TypeScript
│   │   ├── templates.ts               # Code generation templates
│   │   └── codegen.ts                  # AST → TypeScript source
│   ├── runtime/
│   │   ├── types.ts                    # Runtime types
│   │   ├── expression-resolver.ts      # $inputs, $steps, $response
│   │   ├── http-client.ts             # Fetch + GNAP auth
│   │   └── workflow-executor.ts        # Step execution engine
│   └── generated/
│       └── open-payments-client.ts     # Generated SDK
└── test/
    ├── parser.test.ts
    ├── expression-resolver.test.ts
    └── codegen.test.ts
```

## License

Apache-2.0
