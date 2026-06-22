// Tests for per-file-type code preparation: profile mapping and comment-aware
// reading. Pure functions; bundled to test/.codeprep.cjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const C = require("./.codeprep.cjs");

test("profileFor: prose vs code", () => {
  for (const id of ["", "markdown", "plaintext", "latex"]) {
    assert.equal(C.profileFor(id), "prose", id);
  }
  for (const id of ["c", "cpp", "python", "typescript", "rust", "go"]) {
    assert.equal(C.profileFor(id), "code", id);
  }
});

const CSRC = `#include <stdio.h>
// entry point
int main(void) {
  printf("a // b"); /* trailing */
  return 0;
}`;

test("code 'all': comment markers stripped, comments + code kept, strings safe", () => {
  const out = C.stripCodeForSpeech(CSRC, "c", "all");
  assert.ok(out.includes("entry point"), "line comment text kept");
  assert.ok(out.includes("trailing"), "block comment text kept");
  assert.ok(out.includes("main"), "code kept in 'all' mode");
  assert.ok(out.includes("a // b"), "// inside a string is NOT treated as a comment");
  assert.ok(!/\/\/ entry/.test(out), "the // marker itself is removed");
});

test("code 'comments': only comments, code and code-strings dropped", () => {
  const out = C.stripCodeForSpeech(CSRC, "c", "comments");
  assert.ok(out.includes("entry point"));
  assert.ok(out.includes("trailing"));
  assert.ok(!out.includes("main"), "code dropped");
  assert.ok(!out.includes("printf"), "code dropped");
  assert.ok(!out.includes("a // b"), "ordinary string literal dropped");
});

const PYSRC = `# header note
def f(x):
    """Docstring here."""
    return x  # inline`;

test("python: # comments, and docstrings included in 'comments' mode", () => {
  const all = C.stripCodeForSpeech(PYSRC, "python", "all");
  assert.ok(all.includes("header note") && all.includes("inline"));
  assert.ok(!/#\s*header/.test(all), "# marker removed");

  const only = C.stripCodeForSpeech(PYSRC, "python", "comments");
  assert.ok(only.includes("header note"), "line comment");
  assert.ok(only.includes("Docstring here."), "docstring kept");
  assert.ok(only.includes("inline"), "inline comment");
  assert.ok(!only.includes("def f"), "code dropped");
});

test("lua: multi-line block comment (--[[ ]]) not cut off at first newline", () => {
  const lua = `local x = 1 --[[ a\nmultiline note ]] local y = 2`;
  const only = C.stripCodeForSpeech(lua, "lua", "comments");
  assert.ok(only.includes("multiline note"), "block comment spans newlines");
  // a plain -- line comment still works
  const line = C.stripCodeForSpeech(`x = 1 -- tail note`, "lua", "comments");
  assert.equal(line.trim(), "tail note");
});

test("segmentCode classifies comment / string / code in order", () => {
  const syn = C.syntaxFor("c");
  const kinds = C.segmentCode(`a; // c\n"s"`, syn).map((s) => s.kind);
  assert.deepEqual(kinds, ["code", "comment", "code", "string"]);
});
