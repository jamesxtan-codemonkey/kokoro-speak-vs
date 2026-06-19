// Markdown stripping + soft-break unwrap tests (offline).
// Module bundled to test/.textprep.cjs by the `test:build` npm script.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { stripMarkdown } = require("./.textprep.cjs");

test("unwraps soft line breaks within a paragraph (no mid-sentence break)", () => {
  const out = stripMarkdown("foo bar and in\nthe first conversation, ask.");
  assert.equal(out, "foo bar and in the first conversation, ask.");
  assert.ok(!out.includes("\n"), "single-paragraph output should have no newline");
});

test("preserves paragraph breaks (blank line)", () => {
  const out = stripMarkdown("First para line one\nline two.\n\nSecond para.");
  assert.equal(out, "First para line one line two.\n\nSecond para.");
});

test("strips inline emphasis that straddles a hard wrap", () => {
  const out = stripMarkdown('**Recruit a clinic — and in\nthe first conversation, ask:** done.');
  assert.equal(out, "Recruit a clinic — and in the first conversation, ask: done.");
  assert.ok(!/[*_`#]/.test(out), `no markdown markers left: ${out}`);
});

test("strips headings, bold, italic, links, code", () => {
  const out = stripMarkdown(
    "## Title\n\nA **bold** and *italic* word, a [link](http://x), and `code`."
  );
  assert.equal(out, "Title\n\nA bold and italic word, a link, and code.");
});

test("heading on a line is not merged with the next line", () => {
  // single newline after heading would otherwise unwrap into one line
  assert.equal(
    stripMarkdown("## The Assignment\nRecruit a clinic\nand ask one question."),
    "The Assignment\n\nRecruit a clinic and ask one question."
  );
  assert.equal(stripMarkdown("# H1\ntext"), "H1\n\ntext");
  assert.equal(stripMarkdown("### Done ###\nnext"), "Done\n\nnext");
});
