import { describe, expect, test } from "bun:test";
import { extractSymbols } from "../src/context-symbols";

describe("TypeScript extraction", () => {
  const source = [
    "import { x } from './y';",
    "export function setMemory(cwd, key, value, expectedVersion?) { return 1 }",
    "function helper() {}",
    "export default function main() {}",
    "export class Foo extends Bar {}",
    "class Baz {}",
    "export type T = string;",
    "interface I {}",
    "export enum E { a }",
    "const arrow = (x) => x;",
    "const twoLines = (x) =>",
    "  x + 1;",
    "const long = (x: number): string => {",
    "  return String(x);",
    "};",
    "export const WRITE_TOOLS = new Set(['a']);",
    "export async function many(a, b, c, d, e): Promise<void> {}",
  ].join("\n");

  test("extracts module-scope declarations with kinds, anchors and export truth", () => {
    const { symbols, unparsed } = extractSymbols(source, "ts");
    expect(unparsed).toBe(false);
    expect(symbols.map(({ name, kind, line, exported }) => [name, kind, line, exported])).toEqual([
      ["setMemory", "fn", 2, true],
      ["helper", "fn", 3, false],
      ["main", "fn", 4, true],
      ["Foo", "class", 5, true],
      ["Baz", "class", 6, false],
      ["T", "type", 7, true],
      ["long", "const", 13, false],
      ["WRITE_TOOLS", "const", 16, true],
      ["many", "fn", 17, true],
    ]);
  });

  test("keeps optional-marker params and collapses more than four", () => {
    const { symbols } = extractSymbols(source, "ts");
    const setMemory = symbols.find(({ name }) => name === "setMemory")!;
    expect(setMemory.params).toBe("cwd, key, value, expectedVersion?");
    const many = symbols.find(({ name }) => name === "many")!;
    expect(many.params).toBe("a, b, c, …");
    expect(many.returns).toBe("Promise<void>");
  });

  test("reads returns only when declared", () => {
    const { symbols } = extractSymbols(source, "ts");
    expect(symbols.find(({ name }) => name === "helper")?.returns).toBeUndefined();
    expect(symbols.find(({ name }) => name === "long")?.returns).toBe("string");
  });

  test("skips arrow consts under three lines, keeps longer ones", () => {
    const { symbols } = extractSymbols(source, "ts");
    expect(symbols.some(({ name }) => name === "arrow")).toBe(false);
    expect(symbols.some(({ name }) => name === "twoLines")).toBe(false);
    expect(symbols.some(({ name }) => name === "long")).toBe(true);
  });

  test("skips imports, interfaces, enums and re-exports", () => {
    const { symbols } = extractSymbols(source, "ts");
    expect(symbols.some(({ name }) => name === "I")).toBe(false);
    expect(symbols.some(({ name }) => name === "E")).toBe(false);
  });
});

describe("const object literals with nested arrows", () => {
  const source = [
    "const serveOptions = {",
    "  port,",
    "  hostname: '127.0.0.1',",
    "  async fetch(request) {",
    "    const url = new URL(request.url);",
    "    // a comment with { a brace }",
    "    const label = 'text with } and { braces';",
    "    if (url.pathname === '/x') {",
    "      return items.map((i) => { return i; }).filter((i) => i > 0);",
    "    }",
    "    return new Response(label);",
    "  },",
    "};",
    "export function after() { return 1 }",
  ].join("\n");

  test("does not leak the object body into params or returns", () => {
    const { symbols, unparsed } = extractSymbols(source, "ts");
    expect(unparsed).toBe(false);
    const serveOptions = symbols.find(({ name }) => name === "serveOptions")!;
    expect(serveOptions.kind).toBe("const");
    expect(serveOptions.params).toBeUndefined();
    expect(serveOptions.returns).toBeUndefined();
    expect(symbols.map(({ name }) => name)).toEqual(["serveOptions", "after"]);
  });
});

describe("Swift extraction", () => {
  const source = [
    "import SwiftUI",
    "public struct ContentView: View {",
    "  var body: some View { Text('hi') }",
    "}",
    "struct Helper {}",
    "enum Mode { case a }",
    "class Store {}",
    "extension Helper: Equatable {}",
    "func add(a: Int, b: Int = 5) -> Int { a + b }",
    "@MainActor private func hidden(label x: String) {}",
    "struct Plain: Codable {}",
  ].join("\n");

  test("maps kinds, public truth, and view for View conformers", () => {
    const { symbols, unparsed } = extractSymbols(source, "swift");
    expect(unparsed).toBe(false);
    expect(symbols.map(({ name, kind, exported }) => [name, kind, exported])).toEqual([
      ["ContentView", "view", true],
      ["Helper", "struct", false],
      ["Mode", "enum", false],
      ["Store", "class", false],
      ["Helper", "ext", false],
      ["add", "fn", false],
      ["hidden", "fn", false],
      ["Plain", "struct", false],
    ]);
  });

  test("reads Swift param names past labels and the declared return", () => {
    const { symbols } = extractSymbols(source, "swift");
    const add = symbols.find(({ name }) => name === "add")!;
    expect(add.params).toBe("a, b");
    expect(add.returns).toBe("Int");
    const hidden = symbols.find(({ name }) => name === "hidden")!;
    expect(hidden.params).toBe("x");
  });
});

describe("parse failure", () => {
  test("marks unbalanced or unparseable source as unparsed with no symbols", () => {
    expect(extractSymbols("function broken( {", "ts")).toEqual({ symbols: [], unparsed: true });
    expect(extractSymbols("struct A {", "swift").unparsed).toBe(true);
  });

  test("ignores braces inside strings, comments and templates", () => {
    const source = [
      "const message = '} {';",
      "// const fake = 1",
      "const tpl = `x { y }`;",
      "export function ok() { return 1 }",
    ].join("\n");
    const { symbols, unparsed } = extractSymbols(source, "ts");
    expect(unparsed).toBe(false);
    expect(symbols.map(({ name }) => name)).toEqual(["message", "tpl", "ok"]);
  });
});
