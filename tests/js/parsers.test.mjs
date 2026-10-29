// Проверки разбора вызовов инструментов и обрезки контекста. Запуск: node --test tests/js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTextToolCalls,
  normalizeBareToolCalls,
  stripToolBlocks,
  matchBrace,
  toolProtocolPrompt,
  TOOL_BLOCK_OPEN,
  TOOL_BLOCK_CLOSE,
} from "../../frontend/js/toolparse.js";
import { historyWithinBudget, messageSize } from "../../frontend/js/context.js";

const NAMES = ["write_file", "send_file", "run_code", "show_html"];

test("parses a closed block", () => {
  const src = `Читаю.\n${TOOL_BLOCK_OPEN}{"name":"read_file","arguments":{"path":"a.txt"}}${TOOL_BLOCK_CLOSE}`;
  assert.deepEqual(parseTextToolCalls(src), [{ name: "read_file", args: '{"path":"a.txt"}' }]);
});

test("ignores unclosed block until it is complete", () => {
  assert.deepEqual(parseTextToolCalls(`${TOOL_BLOCK_OPEN}{"name":"x"`), []);
});

test("invalid JSON inside block becomes invalid_call", () => {
  const [call] = parseTextToolCalls(`${TOOL_BLOCK_OPEN}{bad}${TOOL_BLOCK_CLOSE}`);
  assert.equal(call.name, "invalid_call");
});

test("strips blocks and partial marker for display", () => {
  assert.equal(stripToolBlocks(`Текст ${TOOL_BLOCK_OPEN}{"name"`), "Текст ");
  assert.equal(stripToolBlocks(`A${TOOL_BLOCK_OPEN}{}${TOOL_BLOCK_CLOSE}B`), "AB");
  assert.equal(stripToolBlocks("Текст <tool_"), "Текст ");
});

test("normalizes several bare JSON calls and keeps surrounding text", () => {
  const src = 'Создаю.\n{\n"name": "write_file",\n"arguments": {"path": "p.py", "content": "print(\\"x\\")"}\n}\n{"name": "send_file", "arguments": {"path": "p.py"}}\nГотово';
  const out = normalizeBareToolCalls(src, NAMES);
  const calls = parseTextToolCalls(out);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "write_file");
  assert.equal(calls[1].name, "send_file");
  assert.ok(out.startsWith("Создаю."));
  assert.ok(out.endsWith("Готово"));
});

test("does not treat unrelated JSON as a call", () => {
  const src = '{"days": [1, 2]}';
  assert.equal(normalizeBareToolCalls(src, NAMES), src);
});

test("does not convert JSON with unknown tool name", () => {
  const src = '{"name": "format_disk", "arguments": {}}';
  assert.equal(normalizeBareToolCalls(src, NAMES), src);
});

test("handles braces inside strings", () => {
  const src = '{"name":"show_html","arguments":{"html":"<style>a{color:red}</style>"}}';
  assert.equal(matchBrace(src, 0), src.length - 1);
  const out = normalizeBareToolCalls(src, NAMES);
  assert.equal(parseTextToolCalls(out)[0].name, "show_html");
});

test("fenced JSON is not converted (kept as text)", () => {
  // Блок ```json``` не распознаётся как вызов, если внутри нет валидного объекта с известным именем.
  const src = "```json\n{\"name\":\"nope\"}\n```";
  assert.equal(normalizeBareToolCalls(src, NAMES), src);
});

test("protocol prompt lists tools with descriptions", () => {
  const prompt = toolProtocolPrompt(["show_html"], { show_html: "панель" });
  assert.ok(prompt.includes("show_html: панель"));
  assert.ok(prompt.includes(TOOL_BLOCK_OPEN));
});

test("history is trimmed to budget and starts with a user message", () => {
  const history = [
    { role: "user", content: "a".repeat(100) },
    { role: "assistant", content: "b".repeat(100) },
    { role: "user", content: "c".repeat(100) },
    { role: "assistant", content: "d".repeat(100) },
  ];
  const { kept, dropped } = historyWithinBudget(history, 250);
  assert.equal(kept[0].role, "user");
  assert.equal(kept.at(-1).content, "d".repeat(100));
  assert.equal(dropped, history.length - kept.length);
  assert.ok(kept.reduce((s, m) => s + messageSize(m), 0) <= 250 || kept.length === 1);
});

test("last message is always kept even above budget", () => {
  const history = [{ role: "user", content: "x".repeat(5000) }];
  const { kept, dropped } = historyWithinBudget(history, 100);
  assert.equal(kept.length, 1);
  assert.equal(dropped, 0);
});

test("tool results count toward size", () => {
  const m = { role: "assistant", content: "", toolCalls: [{ args: "1234", result: "123456" }] };
  assert.equal(messageSize(m), 10);
});
