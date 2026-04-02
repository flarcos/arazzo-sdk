#!/usr/bin/env node

/**
 * Arazzo SDK CLI
 *
 * Usage:
 *   arazzo-sdk generate --input <glob> --output <dir> [--class-name <name>]
 *   arazzo-sdk validate --input <glob>
 *   arazzo-sdk inspect --input <file>
 */

import { parseArgs } from 'node:util';
import { glob } from 'glob';
import { parseArazzoFile, extractOperationIds } from './parser/arazzo-parser.js';
import { generateSDK, generateTypes } from './generator/codegen.js';
import type { ParsedWorkflow } from './parser/types.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    input: { type: 'string', short: 'i' },
    output: { type: 'string', short: 'o' },
    'class-name': { type: 'string' },
    'types-only': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
  strict: false,
});

const command = positionals[0] || 'help';

async function main(): Promise<void> {
  switch (command) {
    case 'generate':
      await runGenerate();
      break;
    case 'validate':
      await runValidate();
      break;
    case 'inspect':
      await runInspect();
      break;
    case 'help':
    default:
      printHelp();
  }
}

// ─── Generate Command ───

async function runGenerate(): Promise<void> {
  const inputGlob = values.input as string;
  const outputDir = values.output as string;

  if (!inputGlob || !outputDir) {
    console.error('Error: --input and --output are required for generate');
    process.exit(1);
  }

  const files = await glob(inputGlob);
  if (files.length === 0) {
    console.error(`Error: No files matched pattern "${inputGlob}"`);
    process.exit(1);
  }

  console.log(`📋 Parsing ${files.length} Arazzo file(s)...`);

  const parsed: ParsedWorkflow[] = [];
  for (const file of files) {
    try {
      const result = parseArazzoFile(file);
      console.log(`  ✅ ${file} — ${result.document.workflows.length} workflow(s)`);
      parsed.push(result);
    } catch (error) {
      console.error(
        `  ❌ ${file}: ${error instanceof Error ? error.message : error}`,
      );
      process.exit(1);
    }
  }

  const className = (values['class-name'] as string) || 'OpenPaymentsClient';
  const typesOnly = values['types-only'] as boolean;

  console.log(`\n⚡ Generating ${typesOnly ? 'types' : 'SDK'}...`);

  if (typesOnly) {
    generateTypes(parsed, { outputDir, className });
    console.log(`  📦 Types written to ${outputDir}/types.ts`);
  } else {
    generateSDK(parsed, { outputDir, className });
    console.log(
      `  📦 SDK written to ${outputDir}/open-payments-client.ts`,
    );
  }

  // Count totals
  let totalWorkflows = 0;
  let totalSteps = 0;
  for (const p of parsed) {
    for (const w of p.document.workflows) {
      totalWorkflows++;
      totalSteps += w.steps.length;
    }
  }

  console.log(
    `\n✨ Generated ${totalWorkflows} workflow(s), ${totalSteps} step(s)`,
  );
}

// ─── Validate Command ───

async function runValidate(): Promise<void> {
  const inputGlob = values.input as string;

  if (!inputGlob) {
    console.error('Error: --input is required for validate');
    process.exit(1);
  }

  const files = await glob(inputGlob);
  if (files.length === 0) {
    console.error(`Error: No files matched pattern "${inputGlob}"`);
    process.exit(1);
  }

  console.log(`🔍 Validating ${files.length} Arazzo file(s)...\n`);

  let hasErrors = false;

  for (const file of files) {
    try {
      const result = parseArazzoFile(file);
      const workflowCount = result.document.workflows.length;
      const stepCount = result.document.workflows.reduce(
        (acc, w) => acc + w.steps.length,
        0,
      );
      console.log(
        `  ✅ ${file} — v${result.document.arazzo}, ${workflowCount} workflow(s), ${stepCount} step(s)`,
      );
    } catch (error) {
      hasErrors = true;
      console.error(
        `  ❌ ${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  if (hasErrors) {
    console.error('\n❌ Validation failed');
    process.exit(1);
  } else {
    console.log('\n✅ All files valid');
  }
}

// ─── Inspect Command ───

async function runInspect(): Promise<void> {
  const inputGlob = values.input as string;

  if (!inputGlob) {
    console.error('Error: --input is required for inspect');
    process.exit(1);
  }

  const files = await glob(inputGlob);
  if (files.length === 0) {
    console.error(`Error: No files matched pattern "${inputGlob}"`);
    process.exit(1);
  }

  for (const file of files) {
    try {
      const result = parseArazzoFile(file);
      const doc = result.document;

      console.log(`\n📄 ${doc.info.title} (v${doc.info.version})`);
      console.log(`   Arazzo: ${doc.arazzo}`);
      console.log(`   Sources: ${doc.sourceDescriptions.map((s) => s.name).join(', ')}`);

      for (const workflow of doc.workflows) {
        console.log(`\n   📋 Workflow: ${workflow.workflowId}`);
        if (workflow.summary) {
          console.log(`      Summary: ${workflow.summary}`);
        }

        // Inputs
        if (workflow.inputs?.properties) {
          const required = workflow.inputs.required || [];
          console.log('      Inputs:');
          for (const [name, prop] of Object.entries(workflow.inputs.properties)) {
            const req = required.includes(name) ? ' (required)' : '';
            console.log(`        - ${name}: ${prop.type}${req}`);
          }
        }

        // Steps
        console.log('      Steps:');
        for (const step of workflow.steps) {
          const target = step.operationId || step.workflowId || 'unknown';
          console.log(`        ${step.stepId} → ${target}`);
        }

        // Outputs
        if (workflow.outputs) {
          console.log('      Outputs:');
          for (const [name, expr] of Object.entries(workflow.outputs)) {
            console.log(`        - ${name}: ${expr}`);
          }
        }
      }

      // Operation IDs
      const opIds = extractOperationIds(doc);
      console.log(`\n   🔗 Operation IDs referenced: ${opIds.join(', ')}`);
    } catch (error) {
      console.error(
        `  ❌ ${file}: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}

// ─── Help ───

function printHelp(): void {
  console.log(`
Arazzo SDK — Generate TypeScript SDKs from Arazzo workflow specifications

USAGE:
  arazzo-sdk <command> [options]

COMMANDS:
  generate    Generate TypeScript SDK from Arazzo files
  validate    Validate Arazzo files for correctness
  inspect     Display workflow structure and details
  help        Show this help message

OPTIONS:
  --input, -i     Glob pattern for input Arazzo files (required)
  --output, -o    Output directory for generated code (generate only)
  --class-name    Custom class name (default: OpenPaymentsClient)
  --types-only    Generate only TypeScript interfaces, no client class
  --help, -h      Show this help message

EXAMPLES:
  arazzo-sdk generate -i "arazzo/*.arazzo.yaml" -o src/generated/
  arazzo-sdk validate -i "arazzo/*.arazzo.yaml"
  arazzo-sdk inspect -i "arazzo/one-time-payment-fixed-receive.arazzo.yaml"
`);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
