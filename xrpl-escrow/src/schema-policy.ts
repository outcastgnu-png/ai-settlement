// Limits on the JSON Schemas a client may put in a job spec. Ajv compiles a
// schema into JavaScript, and some keywords let a hostile schema make
// validation take exponential or quadratic time:
//   pattern, patternProperties  run the schema's own regular expressions (ReDoS)
//   uniqueItems                 compares array items pairwise
//   format                      needs format plugins this kit does not load
//   $ref                        a chain of local refs with anyOf fan-out makes
//                               the validator exponential in the schema's size
//                               (Gpno finding N1), so refs are expanded and
//                               the expanded tree is capped; recursion is refused
// Both the registry (when a job is created) and the oracle (before compiling)
// apply this policy. The oracle also runs the validation in a worker with a
// hard timeout, in case something gets past these static limits.
export const MAX_SCHEMA_BYTES = 16_384;
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_REFS = 64; // $ref occurrences in the schema as written
export const MAX_EXPANDED_NODES = 4_096; // objects and arrays after every $ref is inlined
export const BANNED_KEYWORDS = ["pattern", "patternProperties", "uniqueItems", "format", "$data"];

// Keywords whose values are maps of user-chosen names to subschemas, and
// keywords whose values are plain data, not schemas.
const NAME_MAPS = ["properties", "$defs", "definitions", "dependentSchemas"];
const DATA_VALUES = ["enum", "const", "default", "examples", "required", "dependentRequired", "title", "description"];

/** Resolve a local JSON pointer such as "#/$defs/a~1b" against `root`; undefined if it points nowhere. */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node = root;
  for (const raw of ref.slice(2).split("/")) {
    let token: string;
    try {
      token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node)) node = node[Number(token)];
    else if (typeof node === "object" && node !== null && Object.hasOwn(node, token)) node = (node as Record<string, unknown>)[token];
    else return undefined;
  }
  return node;
}

/** Why `schema` is not allowed, or null if it is. */
export function schemaProblem(schema: unknown): string | null {
  let text: string;
  try {
    text = JSON.stringify(schema);
  } catch {
    return "schema is not plain JSON";
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES) return `schema is larger than ${MAX_SCHEMA_BYTES} bytes`;

  let refs = 0;
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
      if (key === "$ref") {
        if (typeof value !== "string" || !value.startsWith("#")) return "only local $ref (#...) is allowed";
        if (resolvePointer(schema, value) === undefined) return `$ref "${value}" points nowhere in the schema`;
        if (++refs > MAX_REFS) return `schema has more than ${MAX_REFS} $ref`;
      }
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
  const problem = walk(schema, 0);
  if (problem) return problem;

  // Inline every $ref and count the result. A ref chain that doubles at each
  // step hits the cap after a few thousand nodes instead of running for hours.
  let nodes = 0;
  const expand = (node: unknown, stack: string[]): string | null => {
    if (typeof node !== "object" || node === null) return null;
    if (++nodes > MAX_EXPANDED_NODES) return `schema expands to more than ${MAX_EXPANDED_NODES} nodes once $ref is resolved`;
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = expand(item, stack);
        if (problem) return problem;
      }
      return null;
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref" && typeof value === "string") {
        if (stack.includes(value)) return `recursive $ref "${value}" is not allowed`;
        const problem = expand(resolvePointer(schema, value), [...stack, value]);
        if (problem) return problem;
        continue;
      }
      if (DATA_VALUES.includes(key)) continue;
      const problem = expand(value, stack);
      if (problem) return problem;
    }
    return null;
  };
  return expand(schema, []);
}
