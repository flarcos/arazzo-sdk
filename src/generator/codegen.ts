/**
 * Code Generator
 *
 * Reads parsed Arazzo ASTs and emits TypeScript source code:
 * - One input interface per workflow (from JSON Schema inputs)
 * - One output interface per workflow (from output mappings)
 * - One async method per workflow on the client class
 * - JSDoc from Arazzo description fields
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ParsedWorkflow, WorkflowObject } from '../parser/types.js';
import {
  generateInterface,
  generateOutputInterface,
  toPascalCase,
  toCamelCase,
} from './type-mapper.js';
import {
  fileHeader,
  amountType,
  clientClassHeader,
  workflowMethod,
  clientClassFooter,
} from './templates.js';

export interface CodegenOptions {
  /** Output directory for generated files */
  outputDir: string;
  /** Class name for the generated client */
  className?: string;
  /** Output file name */
  fileName?: string;
}

/**
 * Generate TypeScript SDK from parsed Arazzo workflows.
 *
 * Produces a single file with:
 * - Input/output interfaces for each workflow
 * - A client class with one method per workflow
 */
export function generateSDK(
  parsedWorkflows: ParsedWorkflow[],
  options: CodegenOptions,
): string {
  const className = options.className || 'OpenPaymentsClient';
  const fileName = options.fileName || 'open-payments-client.ts';

  const parts: string[] = [];

  // File header
  parts.push(fileHeader());

  // Amount type (shared)
  parts.push(amountType());

  // Collect all workflows across files
  const allWorkflows: Array<{
    workflow: WorkflowObject;
    sourceFile: string;
  }> = [];

  for (const parsed of parsedWorkflows) {
    for (const workflow of parsed.document.workflows) {
      allWorkflows.push({
        workflow,
        sourceFile: parsed.filePath,
      });
    }
  }

  // Generate interfaces for each workflow
  for (const { workflow } of allWorkflows) {
    const pascalId = toPascalCase(workflow.workflowId);

    // Input interface
    if (workflow.inputs?.properties) {
      parts.push('');
      parts.push(
        generateInterface(`${pascalId}Inputs`, workflow.inputs),
      );
    }

    // Output interface
    if (workflow.outputs && Object.keys(workflow.outputs).length > 0) {
      parts.push('');
      parts.push(
        generateOutputInterface(`${pascalId}Outputs`, workflow.outputs),
      );
    }
  }

  // Generate client class
  parts.push('');
  parts.push(clientClassHeader(className));

  // Generate one method per workflow
  for (const { workflow } of allWorkflows) {
    const pascalId = toPascalCase(workflow.workflowId);
    const camelId = toCamelCase(workflow.workflowId);

    const inputType = workflow.inputs?.properties
      ? `${pascalId}Inputs`
      : 'Record<string, unknown>';
    const outputType =
      workflow.outputs && Object.keys(workflow.outputs).length > 0
        ? `${pascalId}Outputs`
        : 'Record<string, unknown>';

    const description =
      workflow.summary || workflow.description?.split('\n')[0] || workflow.workflowId;

    // Serialize the workflow definition for embedding
    const workflowDef = serializeWorkflowDefinition(workflow);

    parts.push(
      workflowMethod(
        camelId,
        inputType,
        outputType,
        workflow.workflowId,
        description,
        workflowDef,
      ),
    );
  }

  parts.push(clientClassFooter());

  const source = parts.join('\n');

  // Write to file
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, fileName);
  writeFileSync(outputPath, source, 'utf-8');

  return source;
}

/**
 * Generate only the TypeScript interfaces without the client class.
 * Useful for creating type-only packages.
 */
export function generateTypes(
  parsedWorkflows: ParsedWorkflow[],
  options: CodegenOptions,
): string {
  const fileName = options.fileName || 'types.ts';
  const parts: string[] = [];

  parts.push('/**');
  parts.push(' * Open Payments Workflow Types — Auto-generated');
  parts.push(' * @generated');
  parts.push(' */');
  parts.push('');

  parts.push(amountType());

  for (const parsed of parsedWorkflows) {
    for (const workflow of parsed.document.workflows) {
      const pascalId = toPascalCase(workflow.workflowId);

      if (workflow.inputs?.properties) {
        parts.push('');
        parts.push(
          generateInterface(`${pascalId}Inputs`, workflow.inputs),
        );
      }

      if (workflow.outputs && Object.keys(workflow.outputs).length > 0) {
        parts.push('');
        parts.push(
          generateOutputInterface(`${pascalId}Outputs`, workflow.outputs),
        );
      }
    }
  }

  const source = parts.join('\n');
  const outputDir = resolve(options.outputDir);
  mkdirSync(outputDir, { recursive: true });

  const outputPath = join(outputDir, fileName);
  writeFileSync(outputPath, source, 'utf-8');

  return source;
}

// ─── Internal ───

/**
 * Serialize a workflow definition to embeddable TypeScript code.
 * This embeds the workflow spec directly in the generated code
 * so the runtime can execute it without needing the YAML files.
 */
function serializeWorkflowDefinition(workflow: WorkflowObject): string {
  // Clean the workflow for serialization — remove undefined values
  const cleaned = JSON.parse(JSON.stringify(workflow));
  return JSON.stringify(cleaned, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `    ${line}`))
    .join('\n');
}
