// Limits on the JSON Schemas a client may put in a job spec. Ajv compiles a
// schema into JavaScript, and some keywords let a hostile schema make
// validation take exponential or quadratic time:
//   pattern, patternProperties  run the schema's own regular expressions (ReDoS)
//   uniqueItems                 compares array items pairwise
//   format                      needs format plugins this kit does not load
//   $ref                        a chain of local refs with anyOf fan-out makes
//                               the validator exponential in the schema's size
//                               (Gpno finding N1), so refs are expanded and
//                               the expanded tree is capped; recursion is refused.
//                               A $ref may only point at a subschema, never into
//                               enum, const or other data, and its target is
//                               checked like the rest (Gpno finding N8)
// Both the registry (when a job is created) and the oracle (before compiling)
// apply this policy. The oracle also runs the validation in a worker with a
// hard timeout, in case something gets past these static limits.
export const MAX_SCHEMA_BYTES = 16_384;
export const MAX_SCHEMA_DEPTH = 32;
export const MAX_REFS = 64; // $ref occurrences in the schema as written
export const MAX_EXPANDED_NODES = 4_096; // objects and arrays after every $ref is inlined
export const BANNED_KEYWORDS = ["pattern", "patternProperties", "uniqueItems", "format", "$data"];

// Keywords whose values are maps of user-chosen names to subschemas, keywords
// whose values are lists of subschemas, and keywords whose values are plain
// data, not schemas. Anything else is a keyword whose value is one subschema
// (or, like "type" or "minLength", a scalar that holds no schema).
const NAME_MAPS = ["properties", "$defs", "definitions", "dependentSchemas", "dependencies"];
const SCHEMA_LISTS = ["allOf", "anyOf", "oneOf", "prefixItems", "items"];
const DATA_VALUES = ["enum", "const", "default", "examples", "required", "dependentRequired", "title", "description"];

type Position = "schema" | "names" | "list" | "data";

/** What sits under `key` in a schema object. */
function childPosition(key: string, value: unknown): Position {
  if (DATA_VALUES.includes(key)) return "data";
  if (NAME_MAPS.includes(key)) return "names";
  if (SCHEMA_LISTS.includes(key) && Array.isArray(value)) return "list";
  return "schema";
}

const pointerTokens = (ref: string): string[] | undefined => {
  if (ref === "#") return [];
  if (!ref.startsWith("#/")) return undefined;
  try {
    return ref.slice(2).split("/").map((raw) => decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~"));
  } catch {
    return undefined;
  }
};

/**
 * Resolve a local JSON pointer such as "#/$defs/a~1b" against `root`. Returns
 * undefined if it points nowhere, or anywhere that is not a subschema: into
 * `enum`, `const`, `default` or other data, or at a name map such as
 * `properties` itself. Ajv would compile whatever a $ref points at as a
 * schema, so data hidden under `enum` must never be reachable (Gpno N8).
 */
function resolveSchemaPointer(root: unknown, ref: string): unknown {
  const tokens = pointerTokens(ref);
  if (!tokens) return undefined;
  let node = root;
  let position: Position = "schema";
  for (const token of tokens) {
    if (position === "data") return undefined;
    if (Array.isArray(node)) {
      if (position !== "list" || !/^(0|[1-9][0-9]*)$/.test(token)) return undefined;
      node = node[Number(token)];
      position = "schema";
    } else if (typeof node === "object" && node !== null && Object.hasOwn(node, token)) {
      const value = (node as Record<string, unknown>)[token];
      position = position === "names" ? "schema" : position === "schema" ? childPosition(token, value) : "data";
      node = value;
    } else {
      return undefined;
    }
  }
  return position === "schema" && typeof node === "object" && node !== null && !Array.isArray(node) ? node : undefined;
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

  // One walk over the schema as Ajv will see it: every $ref is followed and
  // its target checked like any other subschema, so a banned keyword can't hide
  // behind a ref. Inlining also bounds the expanded size: a ref chain that
  // doubles at each step hits the node cap after a few thousand nodes instead
  // of running for hours (Gpno N1).
  // The first pass reads the schema as written (depth, $ref count); the second
  // follows every $ref.
  let refs = 0;
  let nodes = 0;
  const walk = (node: unknown, position: Position, depth: number, stack: string[] | null): string | null => {
    if (stack === null && depth > MAX_SCHEMA_DEPTH) return `schema is nested deeper than ${MAX_SCHEMA_DEPTH} levels`;
    if (position === "data" || typeof node !== "object" || node === null) return null;
    if (stack !== null && ++nodes > MAX_EXPANDED_NODES) {
      return `schema expands to more than ${MAX_EXPANDED_NODES} nodes once $ref is resolved`;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        const problem = walk(item, position === "list" ? "schema" : "data", depth + 1, stack);
        if (problem) return problem;
      }
      return null;
    }
    for (const [key, value] of Object.entries(node)) {
      if (position === "names") {
        const problem = walk(value, "schema", depth + 1, stack);
        if (problem) return problem;
        continue;
      }
      if (BANNED_KEYWORDS.includes(key)) return `schema keyword "${key}" is not allowed`;
      if (key === "$ref") {
        if (typeof value !== "string" || !value.startsWith("#")) return "only local $ref (#...) is allowed";
        const target = resolveSchemaPointer(schema, value);
        if (target === undefined) return `$ref "${value}" points nowhere in the schema, or at something that is not a subschema`;
        if (stack === null) {
          if (++refs > MAX_REFS) return `schema has more than ${MAX_REFS} $ref`;
          continue;
        }
        if (stack.includes(value)) return `recursive $ref "${value}" is not allowed`;
        const problem = walk(target, "schema", depth + 1, [...stack, value]);
        if (problem) return problem;
        continue;
      }
      const problem = walk(value, childPosition(key, value), depth + 1, stack);
      if (problem) return problem;
    }
    return null;
  };
  return walk(schema, "schema", 0, null) ?? walk(schema, "schema", 0, []);
}
