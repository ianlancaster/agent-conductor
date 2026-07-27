import { InvalidRequestError } from './errors.js';

export interface JsonPropertySchema {
  type: 'string' | 'boolean' | 'number' | 'array';
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  items?: {
    type: 'string';
    minLength?: number;
    maxLength?: number;
  };
}

export interface OperationInputSchema {
  type: 'object';
  properties: Record<string, JsonPropertySchema>;
  required?: string[];
  additionalProperties: false;
}

export const stringProperty = (description?: string): JsonPropertySchema => ({
  type: 'string',
  minLength: 1,
  ...(description !== undefined ? { description } : {}),
});

export function operationSchema(
  properties: Record<string, JsonPropertySchema> = {},
  required: string[] = [],
): OperationInputSchema {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new InvalidRequestError(`'${name}' is required and must be a non-empty string`);
  }
  return value;
}

export function optionalString(args: Record<string, unknown>, name: string): string | undefined {
  const value = args[name];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

export function validateOperationInput(
  operationName: string,
  inputSchema: OperationInputSchema,
  args: Record<string, unknown>,
): void {
  const { properties, required = [] } = inputSchema;
  for (const name of required) {
    if (args[name] === undefined) throw new InvalidRequestError(`'${name}' is required`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = properties[name];
    if (property === undefined) throw new InvalidRequestError(`Unknown argument '${name}' for ${operationName}`);
    if (value === undefined) continue;
    const matchesType = property.type === 'array' ? Array.isArray(value) : typeof value === property.type;
    if (!matchesType || (property.type === 'number' && !Number.isFinite(value))) {
      throw new InvalidRequestError(`'${name}' must be a ${property.type}`);
    }
    if (typeof value === 'string') {
      if (property.minLength !== undefined && value.trim().length < property.minLength) {
        throw new InvalidRequestError(`'${name}' must be a non-empty string`);
      }
      if (property.maxLength !== undefined && [...value].length > property.maxLength) {
        throw new InvalidRequestError(`'${name}' must be at most ${String(property.maxLength)} characters`);
      }
      if (property.enum !== undefined && !property.enum.includes(value)) {
        throw new InvalidRequestError(`'${name}' must be one of: ${property.enum.join(', ')}`);
      }
    }
    if (typeof value === 'number' && property.minimum !== undefined && value < property.minimum) {
      throw new InvalidRequestError(`'${name}' must be at least ${String(property.minimum)}`);
    }
    if (Array.isArray(value)) {
      if (property.minItems !== undefined && value.length < property.minItems) {
        throw new InvalidRequestError(`'${name}' must contain at least ${String(property.minItems)} item(s)`);
      }
      if (property.maxItems !== undefined && value.length > property.maxItems) {
        throw new InvalidRequestError(`'${name}' must contain at most ${String(property.maxItems)} item(s)`);
      }
      for (const item of value) {
        if (typeof item !== 'string') throw new InvalidRequestError(`'${name}' items must be strings`);
        if (property.items?.minLength !== undefined && item.trim().length < property.items.minLength) {
          throw new InvalidRequestError(`'${name}' items must be non-empty strings`);
        }
        if (property.items?.maxLength !== undefined && [...item.trim()].length > property.items.maxLength) {
          throw new InvalidRequestError(
            `'${name}' items must be at most ${String(property.items.maxLength)} characters`,
          );
        }
      }
    }
  }
}
