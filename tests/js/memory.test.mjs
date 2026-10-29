// Проверки памяти о пользователе. Запуск: node --test tests/js/memory.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanFact, factKey, mergeFacts, parseFactLines, memoryPrompt, buildExtractionInput, MAX_FACTS } from "../../frontend/js/memory.js";

test("cleanFact removes list markers and extra spaces", () => {
  assert.equal(cleanFact("  - Я   программист  "), "Я программист");
  assert.equal(cleanFact("1. Люблю Python"), "Люблю Python");
  assert.equal(cleanFact(""), "");
});

test("factKey ignores case and punctuation", () => {
  assert.equal(factKey("Я — Программист!"), factKey("я программист"));
});

test("mergeFacts skips duplicates and empty facts", () => {
  const a = mergeFacts([], ["Зовут Анна", "зовут анна.", "", "  "], 1);
  assert.equal(a.length, 1);
  const b = mergeFacts(a, ["Работает инженером"], 2);
  assert.equal(b.length, 2);
  assert.equal(b[0].text, "Зовут Анна");
});

test("mergeFacts keeps only the newest MAX_FACTS", () => {
  const many = Array.from({ length: MAX_FACTS + 5 }, (_, i) => `факт ${i}`);
  const out = mergeFacts([], many, 1);
  assert.equal(out.length, MAX_FACTS);
  assert.equal(out[out.length - 1].text, `факт ${MAX_FACTS + 4}`);
});

test("parseFactLines reads only list items", () => {
  const text = "Вот что я нашёл:\n- Работает Python-разработчиком\n* Любит шахматы\n2. Живёт в Лиссабоне\nтекст без маркера\n-";
  assert.deepEqual(parseFactLines(text), ["Работает Python-разработчиком", "Любит шахматы", "Живёт в Лиссабоне"]);
  assert.deepEqual(parseFactLines("-"), []);
});

test("memoryPrompt lists facts and tells when to use remember", () => {
  assert.equal(memoryPrompt([]), "");
  const p = memoryPrompt([{ text: "Зовут Анна" }]);
  assert.match(p, /- Зовут Анна/);
  assert.match(p, /remember/);
  assert.match(p, /пароли/);
});

test("buildExtractionInput takes user messages from all chats within budget", () => {
  const chats = [
    { title: "Старый", updatedAt: 1, messages: [{ role: "user", content: "Я врач" }, { role: "assistant", content: "ответ" }] },
    { title: "Новый", updatedAt: 2, messages: [{ role: "user", content: "Пишу на Python" }] },
  ];
  const text = buildExtractionInput(chats, 10000);
  assert.ok(text.indexOf("Новый") < text.indexOf("Старый"));
  assert.match(text, /Я врач/);
  assert.ok(!text.includes("ответ"));
  assert.ok(buildExtractionInput(chats, 20).length <= 20);
  assert.equal(buildExtractionInput([], 1000), "");
});

import { VIDEO_PROMPT, previewHtml, videoName } from "../../frontend/js/video.js";
test("video prompt states the scene contract", () => {
  assert.match(VIDEO_PROMPT, /DURATION/);
  assert.match(VIDEO_PROMPT, /renderFrame\(t\)/);
  assert.match(VIDEO_PROMPT, /render_video/);
});
test("preview adds a loop that drives renderFrame, and names are sanitized", () => {
  const out = previewHtml("<html>x</html>");
  assert.ok(out.startsWith("<html>x</html>"));
  assert.match(out, /renderFrame\(\(\(now - t0\)/);
  assert.equal(videoName("../evil name!"), "evilname");
  assert.equal(videoName(""), "video");
});
