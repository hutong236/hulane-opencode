function typeMatches(type, value) {
  if (type === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (type === "array") return Array.isArray(value);
  if (type === "integer") return Number.isInteger(value);
  return typeof value === type;
}

export function validateInput(schema, value, path = "arguments") {
  const errors = [];
  if (schema.type && !typeMatches(schema.type, value)) return [`${path} must be ${schema.type}`];
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has invalid format`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path} needs at least ${schema.minItems} item(s)`);
    for (let index = 0; index < value.length; index += 1) errors.push(...validateInput(schema.items ?? {}, value[index], `${path}[${index}]`));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const required of schema.required ?? []) if (!(required in value)) errors.push(`${path}.${required} is required`);
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!(key in (schema.properties ?? {}))) errors.push(`${path}.${key} is not allowed`);
    }
    for (const [key, child] of Object.entries(schema.properties ?? {})) {
      if (key in value) errors.push(...validateInput(child, value[key], `${path}.${key}`));
    }
  }
  return errors;
}
