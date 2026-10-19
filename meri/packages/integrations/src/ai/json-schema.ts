/**
 * Minimal Zod → JSON Schema (draft-07 subset) for tool `input_schema`. Covers what our output schemas use:
 * objects, strings (with min/max/email/datetime), numbers (int/min/max), booleans, enums, literals, arrays,
 * nullable, optional, records and unions of literals. Anything else throws, so a new schema shape is noticed in tests.
 */
import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export function zodToJsonSchema(schema: z.ZodTypeAny): JsonSchema {
  const def = schema._def as { typeName: string };
  switch (def.typeName) {
    case "ZodObject": {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(value);
        if (!(value instanceof z.ZodOptional)) required.push(key);
      }
      return { type: "object", properties, required, additionalProperties: false };
    }
    case "ZodString": {
      const out: JsonSchema = { type: "string" };
      for (const check of (schema as z.ZodString)._def.checks) {
        if (check.kind === "min") out.minLength = check.value;
        if (check.kind === "max") out.maxLength = check.value;
        if (check.kind === "email") out.format = "email";
        if (check.kind === "datetime") out.format = "date-time";
      }
      return out;
    }
    case "ZodNumber": {
      const out: JsonSchema = { type: "number" };
      for (const check of (schema as z.ZodNumber)._def.checks) {
        if (check.kind === "int") out.type = "integer";
        if (check.kind === "min") out.minimum = check.value;
        if (check.kind === "max") out.maximum = check.value;
      }
      return out;
    }
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodEnum":
      return { type: "string", enum: [...(schema as z.ZodEnum<[string, ...string[]]>).options] };
    case "ZodLiteral":
      return { const: (schema as z.ZodLiteral<unknown>).value };
    case "ZodArray": {
      const arr = schema as z.ZodArray<z.ZodTypeAny>;
      const out: JsonSchema = { type: "array", items: zodToJsonSchema(arr.element) };
      if (arr._def.maxLength) out.maxItems = arr._def.maxLength.value;
      if (arr._def.minLength) out.minItems = arr._def.minLength.value;
      return out;
    }
    case "ZodNullable": {
      const inner = zodToJsonSchema((schema as z.ZodNullable<z.ZodTypeAny>).unwrap());
      return { anyOf: [inner, { type: "null" }] };
    }
    case "ZodOptional":
      return zodToJsonSchema((schema as z.ZodOptional<z.ZodTypeAny>).unwrap());
    case "ZodDefault":
      return zodToJsonSchema((schema as z.ZodDefault<z.ZodTypeAny>)._def.innerType);
    case "ZodRecord":
      return {
        type: "object",
        additionalProperties: zodToJsonSchema((schema as z.ZodRecord)._def.valueType),
      };
    case "ZodUnion":
      return {
        anyOf: (schema as z.ZodUnion<[z.ZodTypeAny, ...z.ZodTypeAny[]]>).options.map(zodToJsonSchema),
      };
    default:
      throw new Error(`zodToJsonSchema: unsupported type ${def.typeName}`);
  }
}
