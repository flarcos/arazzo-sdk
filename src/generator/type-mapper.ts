/**
 * Type Mapper
 *
 * Maps JSON Schema property types to TypeScript type strings.
 * Used by the code generator to produce typed interfaces from
 * Arazzo workflow input/output schemas.
 */

import type { JsonSchemaProperty, JsonSchemaObject } from '../parser/types.js';

/**
 * Convert a JSON Schema type to its TypeScript equivalent.
 */
export function mapSchemaTypeToTS(prop: JsonSchemaProperty): string {
  switch (prop.type) {
    case 'string':
      if (prop.enum && prop.enum.length > 0) {
        return prop.enum.map((v) => `'${v}'`).join(' | ');
      }
      return 'string';

    case 'integer':
    case 'number':
      return 'number';

    case 'boolean':
      return 'boolean';

    case 'array':
      if (prop.items) {
        return `${mapSchemaTypeToTS(prop.items)}[]`;
      }
      return 'unknown[]';

    case 'object':
      if (prop.properties) {
        return generateInlineObjectType(prop.properties, prop.required);
      }
      return 'Record<string, unknown>';

    default:
      return 'unknown';
  }
}

/**
 * Generate a TypeScript interface body from JSON Schema properties.
 */
export function generateInterfaceProperties(
  properties: Record<string, JsonSchemaProperty>,
  required: string[] = [],
  indent: string = '  ',
): string {
  const lines: string[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    const isRequired = required.includes(name);
    const tsType = mapSchemaTypeToTS(prop);
    const optionalMarker = isRequired ? '' : '?';

    // JSDoc comment from description
    if (prop.description) {
      lines.push(`${indent}/** ${prop.description} */`);
    }

    lines.push(`${indent}${safeName(name)}${optionalMarker}: ${tsType};`);
  }

  return lines.join('\n');
}

/**
 * Generate a full TypeScript interface from a JSON Schema object.
 */
export function generateInterface(
  name: string,
  schema: JsonSchemaObject,
  exportInterface: boolean = true,
): string {
  const lines: string[] = [];
  const exportPrefix = exportInterface ? 'export ' : '';

  if (schema.description) {
    lines.push(`/** ${schema.description} */`);
  }

  lines.push(`${exportPrefix}interface ${name} {`);

  if (schema.properties) {
    lines.push(
      generateInterfaceProperties(
        schema.properties,
        schema.required,
      ),
    );
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Generate TypeScript type for workflow outputs based on output expression mappings.
 * Since Arazzo outputs are runtime expressions, we infer types as unknown
 * unless we can determine them from the expression pattern.
 */
export function generateOutputInterface(
  name: string,
  outputs: Record<string, string>,
): string {
  const lines: string[] = [];

  lines.push(`export interface ${name} {`);

  for (const [key, expression] of Object.entries(outputs)) {
    const inferredType = inferTypeFromExpression(expression);
    lines.push(`  /** Resolved from: ${expression} */`);
    lines.push(`  ${safeName(key)}: ${inferredType};`);
  }

  lines.push('}');

  return lines.join('\n');
}

// ─── Internals ───

function generateInlineObjectType(
  properties: Record<string, JsonSchemaProperty>,
  required?: string[],
): string {
  const entries: string[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    const isReq = required?.includes(name) ?? false;
    const opt = isReq ? '' : '?';
    const tsType = mapSchemaTypeToTS(prop);
    entries.push(`${safeName(name)}${opt}: ${tsType}`);
  }
  return `{ ${entries.join('; ')} }`;
}

/**
 * Infer a TypeScript type from an Arazzo expression pattern.
 */
function inferTypeFromExpression(expression: string): string {
  // Known patterns from Open Payments
  if (expression.includes('Amount')) return 'Amount';
  if (expression.includes('Url') || expression.includes('Uri')) return 'string';
  if (expression.includes('Id') || expression.includes('id')) return 'string';
  if (expression.includes('Token') || expression.includes('token'))
    return 'string';
  if (expression.includes('Nonce') || expression.includes('nonce'))
    return 'string';
  if (expression.includes('Failed') || expression.includes('failed'))
    return 'boolean';
  if (expression.includes('hasNext') || expression.includes('hasPrevious'))
    return 'boolean';
  if (expression.includes('Wait') || expression.includes('wait'))
    return 'number';

  return 'unknown';
}

/**
 * Ensure a property name is a valid TypeScript identifier.
 */
function safeName(name: string): string {
  // If name contains special characters, quote it
  if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) {
    return name;
  }
  return `'${name}'`;
}

/**
 * Convert a string to PascalCase for interface names.
 */
export function toPascalCase(str: string): string {
  return str
    .replace(/[-_\s]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^(.)/, (_, c) => c.toUpperCase());
}

/**
 * Convert a string to camelCase for function/variable names.
 */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
