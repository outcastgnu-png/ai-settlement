// Limits on the JSON Schemas a client may put in a job spec. Ajv compiles a
// schema into JavaScript, and some keywords let a hostile schema make
// validation take exponential or quadratic time:
//   pattern, patternProperties  run the schema's own regular expressions (ReDoS)
//   uniqueItems                 compares array items pairwise
//   format                      needs format plugins this kit does not load
// Both the registry (when a job is created) and the oracle (before compiling)
// apply this policy.
export const MAX_SCHEMA_BYTES = 16_384;
export const MAX_SCHEMA_DEPTH = 32;
export const BANNED_KEYWORDS = ["pattern", "patternProperties", "uniqueItems", "format", "$data"];

// Keywords whose values are maps of user-chosen names to subschemas, and
// keywords whose values are plain data, not schemas.
const NAME_MAPS = ["properties", "$defs", "definitions", "dependentSchemas"];
const DATA_VALUES = ["enum", "const", "default", "examples", "required", "dependentRequired", "title", "description"];

/** Why `schema` is not allowed, or null if it is. */
export function schemaProblem(schema: unknown): string | null {
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    return "schema is not plain JSON";
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES) return `schema is larger than ${MAX_SCHEMA_BYTES} bytes`;

  const walk = (node: unknown, depth: number): string | null => {
    if (depth > MAX_SCHEMA_DEPTH) return `schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`;
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = walk(item, depth + 1);
        if (problem) return problem;
      }
      return null;
    }
    if (typeof node !== "object" || node === null) return null;
    for (const [key, value] of Object.entries(node)) {
      if (BANNED_KEYWORDS.includes(key)) return `schema keyword "${key}" is not allowed`;
      if (key === "$ref" && typeof value === "string" && !value.startsWith("#")) return "only local $ref (#...) is allowed";
      if (DATA_VALUES.includes(key)) continue;
      if (NAME_MAPS.includes(key) && typeof value === "object" && value !== null) {
        for (const sub of Object.values(value)) {
          const problem = walk(sub, depth + 1);
          if (problem) return problem;
        }
        continue;
      }
      const problem = walk(value, depth + 1);
      if (problem) return problem;
    }
    return null;
  };
  return walk(schema, 0);
}
