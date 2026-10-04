#!/usr/bin/env node
// resmon24 protocol code generator.
//
// Reads the JSON Schemas in packages/protocol/schema/ (the single source of
// truth) and emits:
//   - packages/protocol/generated/typescript/index.ts
//   - packages/protocol/generated/cpp/resmon24_protocol.h
//
// Supported schema subset (intentionally small):
//   allOf, $ref (local + relative file), type, const, enum, properties,
//   required, items, and nullable via ["<type>", "null"].
//
// Usage:
//   node scripts/generate-protocol.mjs          # write generated files
//   node scripts/generate-protocol.mjs --check  # fail if generated files differ

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SCHEMA_DIR = join(ROOT, "packages/protocol/schema");
const TS_OUT = join(ROOT, "packages/protocol/generated/typescript/index.ts");
const CPP_OUT = join(ROOT, "packages/protocol/generated/cpp/resmon24_protocol.h");
const CHECK = process.argv.includes("--check");

const MESSAGE_ORDER = ["hello", "welcome", "resource_update", "config", "ack", "error", "ping", "pong"];
const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Schema loading and ref resolution
// ---------------------------------------------------------------------------

const schemaCache = new Map();

function loadSchema(path) {
  const abs = resolve(path);
  if (!schemaCache.has(abs)) {
    schemaCache.set(abs, JSON.parse(readFileSync(abs, "utf8")));
  }
  return schemaCache.get(abs);
}

function resolvePointer(doc, pointer) {
  if (!pointer || pointer === "#") return doc;
  const parts = pointer
    .replace(/^#\//, "")
    .split("/")
    .map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~"));
  let cur = doc;
  for (const part of parts) cur = cur[part];
  if (cur === undefined) throw new Error(`Could not resolve pointer #/${pointer}`);
  return cur;
}

function deref(schema, basePath, seen = new Set()) {
  if (!schema || typeof schema !== "object" || !schema.$ref) return schema;
  const [filePart, pointer = ""] = schema.$ref.split("#");
  const refBase = filePart ? resolve(dirname(basePath), filePart) : basePath;
  const key = `${refBase}#${pointer}`;
  if (seen.has(key)) throw new Error(`Circular $ref: ${key}`);
  seen.add(key);
  const target = resolvePointer(loadSchema(refBase), "#" + pointer);
  return deref(target, refBase, seen);
}

function flatten(schema, basePath) {
  const s = deref(schema, basePath);
  if (!s.allOf) return s;
  const merged = { ...s };
  delete merged.allOf;
  merged.properties = { ...(s.properties || {}) };
  const required = new Set(s.required || []);
  for (const sub of s.allOf) {
    const f = flatten(sub, basePath);
    Object.assign(merged.properties, f.properties || {});
    for (const r of f.required || []) required.add(r);
    if (f.type) merged.type = merged.type || f.type;
  }
  merged.required = [...required];
  if (!merged.type && Object.keys(merged.properties).length) merged.type = "object";
  return merged;
}

// ---------------------------------------------------------------------------
// Type analysis
// ---------------------------------------------------------------------------

function pascal(name) {
  return name
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
}

// Walks a schema and produces a type descriptor. Object schemas are registered
// in `registry` (parent-first) so they can be emitted as named declarations.
function analyze(schema, nameHint, basePath, registry) {
  let s = deref(schema, basePath) || {};
  let nullable = false;

  if (Array.isArray(s.type)) {
    nullable = s.type.includes("null");
    s = { ...s, type: s.type.find((t) => t !== "null") };
  }
  if (!s.type && s.properties) s = { ...s, type: "object" };

  if (s.const !== undefined) return { kind: "const", value: s.const, nullable };
  if (s.enum) return { kind: "enum", values: s.enum, nullable };

  switch (s.type) {
    case "object": {
      const name = nameHint;
      const required = new Set(s.required || []);
      const entry = { name, props: [] };
      registry.push(entry);
      for (const [prop, propSchema] of Object.entries(s.properties || {})) {
        const desc = analyze(propSchema, name + pascal(prop), basePath, registry);
        entry.props.push({ prop, desc, optional: !required.has(prop) });
      }
      return { kind: "object", name, nullable };
    }
    case "array": {
      const item = analyze(s.items || {}, nameHint + "Item", basePath, registry);
      return { kind: "array", item, nullable };
    }
    case "string":
    case "integer":
    case "number":
    case "boolean":
      return { kind: s.type, nullable };
    default:
      return { kind: "string", nullable };
  }
}

// ---------------------------------------------------------------------------
// TypeScript emission
// ---------------------------------------------------------------------------

function tsBase(desc) {
  switch (desc.kind) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "const":
      return desc.value === null ? "null" : JSON.stringify(desc.value);
    case "enum":
      return desc.values.map((v) => JSON.stringify(v)).join(" | ");
    case "object":
      return desc.name;
    case "array":
      return `Array<${tsType(desc.item)}>`;
    default:
      return "unknown";
  }
}

function tsType(desc) {
  const base = tsBase(desc);
  return desc.nullable ? `${base} | null` : base;
}

function emitTypeScript(messages, registry) {
  const lines = [];
  lines.push("// AUTO-GENERATED by scripts/generate-protocol.mjs — DO NOT EDIT.");
  lines.push("// Source of truth: packages/protocol/schema/*.schema.json");
  lines.push("");
  lines.push(`export const PROTOCOL_VERSION = ${PROTOCOL_VERSION} as const;`);
  lines.push("");

  for (const entry of registry) {
    lines.push(`export interface ${entry.name} {`);
    for (const { prop, desc, optional } of entry.props) {
      const opt = optional ? "?" : "";
      lines.push(`  ${prop}${opt}: ${tsType(desc)};`);
    }
    lines.push("}");
    lines.push("");
  }

  const names = messages.map((m) => m.messageName);
  lines.push(`export type ProtocolMessage = ${names.join(" | ")};`);
  lines.push("");
  lines.push(`export type MessageType = ProtocolMessage["type"];`);
  lines.push("");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// C++ emission
// ---------------------------------------------------------------------------

function cppType(desc) {
  switch (desc.kind) {
    case "string":
    case "enum":
      return "String";
    case "const":
      return typeof desc.value === "string" ? "String" : typeof desc.value === "boolean" ? "bool" : "int64_t";
    case "integer":
      return "int64_t";
    case "number":
      return "double";
    case "boolean":
      return "bool";
    case "object":
      return desc.name;
    case "array":
      return `std::vector<${cppType(desc.item)}>`;
    default:
      return "String";
  }
}

function cppDefault(desc) {
  switch (desc.kind) {
    case "boolean":
      return " = false";
    case "integer":
    case "number":
      return " = 0";
    case "const":
      if (typeof desc.value === "boolean") return ` = ${desc.value}`;
      if (typeof desc.value === "number") return ` = ${desc.value}`;
      if (typeof desc.value === "string") return ` = ${JSON.stringify(desc.value)}`;
      return "";
    default:
      return "";
  }
}

function hasFlagProp(desc, optional) {
  return optional || desc.nullable;
}

function cppAccessor(desc) {
  switch (desc.kind) {
    case "string":
    case "enum":
      return '.as<const char*>()';
    case "const":
      return typeof desc.value === "string" ? '.as<const char*>()' : typeof desc.value === "boolean" ? '.as<bool>()' : '.as<int64_t>()';
    case "integer":
      return ".as<int64_t>()";
    case "number":
      return ".as<double>()";
    case "boolean":
      return ".as<bool>()";
    default:
      return ".as<const char*>()";
  }
}

function cppEmitValue(prop, desc, optional, ind) {
  const pad = " ".repeat(ind);
  const key = `src["${prop}"]`;
  const out = `out.${prop}`;
  const flag = hasFlagProp(desc, optional);

  const wrap = (body) =>
    flag
      ? [`${pad}if (!${key}.isNull()) {`, `${pad}  out.has${pascal(prop)} = true;`, ...body.map((l) => "  " + l), `${pad}} else {`, `${pad}  out.has${pascal(prop)} = false;`, `${pad}}`]
      : body;

  if (desc.kind === "object") {
    return wrap([
      `${out} = ${cppType(desc)}();`,
      `if (!fromJson(${key}, ${out})) return false;`,
    ]);
  }
  if (desc.kind === "array") {
    const item = desc.item;
    const loop = [];
    if (item.kind === "object") {
      loop.push(`${out}.clear();`);
      loop.push(`for (JsonVariantConst item : ${key}.as<JsonArrayConst>()) {`);
      loop.push(`  ${cppType(item)} element;`);
      loop.push(`  if (fromJson(item, element)) ${out}.push_back(element);`);
      loop.push(`}`);
    } else {
      loop.push(`${out}.clear();`);
      loop.push(`for (JsonVariantConst item : ${key}.as<JsonArrayConst>()) ${out}.push_back(item${cppAccessor(item)});`);
    }
    return wrap(loop);
  }
  if (desc.kind === "const") {
    if (typeof desc.value === "string") {
      return wrap([`if (${key}.isNull()) return false;`, `if (String(${key}.as<const char*>()) != ${JSON.stringify(desc.value)}) return false;`, `${out} = ${JSON.stringify(desc.value)};`]);
    }
    return wrap([`if (${key}.as<int64_t>() != ${desc.value}) return false;`, `${out} = ${desc.value};`]);
  }
  if (flag) {
    return wrap([`${out} = ${key}${cppAccessor(desc)};`]);
  }
  if (desc.kind === "string" || desc.kind === "enum") {
    return [`${pad}if (!${key}.is<const char*>()) return false;`, `${pad}${out} = ${key}${cppAccessor(desc)};`];
  }
  return [`${pad}${out} = ${key}${cppAccessor(desc)};`];
}

function cppEmitTo(prop, desc, optional, ind) {
  const pad = " ".repeat(ind);
  const flag = hasFlagProp(desc, optional);
  const value = `v.${prop}`;
  const target = `dst["${prop}"]`;

  const body = () => {
    if (desc.kind === "const") {
      return [`${target} = ${JSON.stringify(desc.value)};`];
    }
    if (desc.kind === "object") {
      return [`JsonObject nested = ${target}.to<JsonObject>();`, `toJson(${value}, nested);`];
    }
    if (desc.kind === "array") {
      const item = desc.item;
      const open = [`JsonArray array = ${target}.to<JsonArray>();`, `for (const auto& element : ${value}) {`];
      if (item.kind === "object") {
        open.push(`  JsonObject nested = array.add<JsonObject>();`);
        open.push(`  toJson(element, nested);`);
      } else {
        open.push(`  array.add(element);`);
      }
      open.push(`}`);
      return open;
    }
    return [`${target} = ${value};`];
  };

  const lines = body().map((l) => pad + l);
  if (flag) return [`${pad}if (v.has${pascal(prop)}) {`, ...lines.map((l) => "  " + l), `${pad}}`];
  return lines;
}

function emitCpp(registry) {
  const out = [];
  out.push("// AUTO-GENERATED by scripts/generate-protocol.mjs — DO NOT EDIT.");
  out.push("// Source of truth: packages/protocol/schema/*.schema.json");
  out.push("#pragma once");
  out.push("");
  out.push("#include <Arduino.h>");
  out.push("#include <ArduinoJson.h>");
  out.push("");
  out.push("#include <vector>");
  out.push("");
  out.push("namespace resmon24 {");
  out.push("namespace protocol {");
  out.push("");
  out.push(`constexpr int PROTOCOL_VERSION = ${PROTOCOL_VERSION};`);
  out.push("");

  // Children must be declared before parents because structs hold them by value.
  const ordered = [...registry].reverse();

  for (const entry of ordered) {
    out.push(`struct ${entry.name} {`);
    for (const { prop, desc, optional } of entry.props) {
      const flag = hasFlagProp(desc, optional);
      out.push(`    ${cppType(desc)} ${prop}${cppDefault(desc)};`);
      if (flag) out.push(`    bool has${pascal(prop)} = false;`);
    }
    out.push("};");
    out.push("");
  }

  for (const entry of ordered) {
    out.push(`inline bool fromJson(JsonVariantConst src, ${entry.name}& out) {`);
    out.push("    if (src.isNull()) return false;");
    for (const { prop, desc, optional } of entry.props) {
      for (const line of cppEmitValue(prop, desc, optional, 4)) out.push(line);
    }
    out.push("    return true;");
    out.push("}");
    out.push("");
    out.push(`inline void toJson(const ${entry.name}& v, JsonObject dst) {`);
    for (const { prop, desc, optional } of entry.props) {
      for (const line of cppEmitTo(prop, desc, optional, 4)) out.push(line);
    }
    out.push("}");
    out.push("");
  }

  out.push("} // namespace protocol");
  out.push("} // namespace resmon24");
  out.push("");

  return out.join("\n");
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function buildMessages() {
  const files = ["hello", "welcome", "resource_update", "config", "ack", "error", "ping", "pong"];
  const messages = [];
  for (const file of files) {
    const path = join(SCHEMA_DIR, `${file}.schema.json`);
    const schema = flatten(loadSchema(path), path);
    const typeConst = schema.properties?.type?.const;
    if (!typeConst) continue;
    messages.push({ type: typeConst, messageName: pascal(typeConst) + "Message", schema, path });
  }
  messages.sort((a, b) => {
    const ai = MESSAGE_ORDER.indexOf(a.type);
    const bi = MESSAGE_ORDER.indexOf(b.type);
    return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
  });
  return messages;
}

function buildRegistry(messages) {
  const registry = [];
  for (const message of messages) {
    const desc = analyze(message.schema, message.messageName, message.path, registry);
    if (desc.kind !== "object") throw new Error(`${message.path} root must be an object`);
  }
  return registry;
}

function generate() {
  const messages = buildMessages();
  const registry = buildRegistry(messages);
  const ts = emitTypeScript(messages, registry);
  const cpp = emitCpp(registry);

  if (CHECK) {
    let failed = false;
    for (const [path, expected] of [[TS_OUT, ts], [CPP_OUT, cpp]]) {
      let actual = null;
      try {
        actual = readFileSync(path, "utf8");
      } catch {
        actual = null;
      }
      if (actual !== expected) {
        console.error(`✗ Out of date: ${path}`);
        failed = true;
      }
    }
    if (failed) {
      console.error("Run: node scripts/generate-protocol.mjs");
      process.exit(1);
    }
    console.log(`✓ Generated protocol files are up to date (${messages.length} messages).`);
    return;
  }

  for (const [path, content] of [[TS_OUT, ts], [CPP_OUT, cpp]]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
  console.log(`✓ Generated ${messages.length} messages:`);
  console.log(`  - ${TS_OUT}`);
  console.log(`  - ${CPP_OUT}`);
}

generate();
