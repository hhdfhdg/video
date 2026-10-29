// Проверки скилов и режима веб-разработки. Запуск: node --test tests/js/skills_webdev.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BUILTIN_SKILLS, BUILTIN_NAMES, slugifySkillName, parseSkillMd, skillToMd, normalizeSkill,
  allSkills, enabledSkills, findSlashSkill, skillCatalogPrompt, activeSkillPrompt,
} from "../../frontend/js/skills.js";
import {
  findHtmlBlocks, extractHtml, splitByHtml, elideHtml, injectCsp, suggestFileName,
  cleanContinuation, trimOverlap, stripReopenedFence, stripThink, PREVIEW_CSP,
} from "../../frontend/js/webdev.js";

const FENCE = "```";
const PAGE = "<!DOCTYPE html>\n<html><head><title>Тест Страница</title></head><body><h1>Привет</h1></body></html>";

test("three built-in skills with unique names", () => {
  assert.equal(BUILTIN_SKILLS.length, 6);
  assert.equal(new Set(BUILTIN_NAMES).size, 6);
  for (const n of ["python-coding", "python-debugging", "python-tests"]) assert.ok(BUILTIN_NAMES.includes(n));
  for (const s of BUILTIN_SKILLS) {
    assert.match(s.name, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(s.description.length > 20);
    assert.ok(s.instructions.length > 100);
  }
});

test("slugify transliterates Cyrillic and cleans punctuation", () => {
  assert.equal(slugifySkillName("Протокол встречи!"), "protokol-vstrechi");
  assert.equal(slugifySkillName("  My  Skill__v2 "), "my-skill-v2");
  assert.equal(slugifySkillName("!!!"), "");
});

test("parseSkillMd reads frontmatter and body", () => {
  const md = '---\nname: demo\ndescription: "Делает демо"\n---\n\n# Тело\nтекст';
  assert.deepEqual(parseSkillMd(md), { name: "demo", description: "Делает демо", instructions: "# Тело\nтекст" });
  assert.deepEqual(parseSkillMd("без шапки"), { name: "", description: "", instructions: "без шапки" });
});

test("skillToMd round-trips through parseSkillMd", () => {
  const md = skillToMd({ name: "x-y", description: "Описание\nв две строки", instructions: "# Шаги\nсделай так, как написано" });
  const back = parseSkillMd(md);
  assert.equal(back.name, "x-y");
  assert.equal(back.description, "Описание в две строки");
  assert.equal(back.instructions, "# Шаги\nсделай так, как написано");
});

test("normalizeSkill accepts a good skill and slugifies its name", () => {
  const r = normalizeSkill({ name: "Заметки Встречи", description: "Оформляет заметки", instructions: "Шаг один. Шаг два. Шаг три, достаточно длинно." });
  assert.equal(r.ok, true);
  assert.equal(r.skill.name, "zametki-vstrechi");
});

test("normalizeSkill rejects bad input", () => {
  assert.equal(normalizeSkill({ name: "", description: "d", instructions: "x".repeat(50) }).ok, false);
  assert.equal(normalizeSkill({ name: "ok", description: "", instructions: "x".repeat(50) }).ok, false);
  assert.equal(normalizeSkill({ name: "ok", description: "d", instructions: "коротко" }).ok, false);
  assert.equal(normalizeSkill({ name: "ok", description: "d", instructions: "x".repeat(20001) }).ok, false);
  assert.equal(normalizeSkill(null).ok, false);
});

test("normalizeSkill recovers name and description from a full SKILL.md pasted into instructions", () => {
  const r = normalizeSkill({ instructions: '---\nname: from-md\ndescription: "Из файла"\n---\n' + "Инструкция. ".repeat(5) });
  assert.equal(r.ok, true);
  assert.equal(r.skill.name, "from-md");
  assert.equal(r.skill.description, "Из файла");
  assert.ok(!r.skill.instructions.startsWith("---"));
});

test("allSkills keeps built-ins and drops user skills with taken names", () => {
  const all = allSkills([{ name: "code-review", description: "d", instructions: "i" }, { name: "mine", description: "d", instructions: "i" }]);
  assert.equal(all.filter((s) => s.name === "code-review").length, 1);
  assert.equal(all.find((s) => s.name === "code-review").builtin, true);
  assert.equal(all.find((s) => s.name === "mine").builtin, false);
});

test("enabledSkills respects the off map", () => {
  const list = enabledSkills([], { "code-review": true });
  assert.ok(!list.some((s) => s.name === "code-review"));
  assert.equal(list.length, 5);
});

test("findSlashSkill matches /name at the start only", () => {
  const list = allSkills([]);
  const hit = findSlashSkill("/explain-simply что такое DNS", list);
  assert.equal(hit.skill.name, "explain-simply");
  assert.equal(hit.rest, "что такое DNS");
  assert.equal(findSlashSkill("текст /code-review", list), null);
  assert.equal(findSlashSkill("/unknown-skill x", list), null);
});

test("catalog and active prompts contain skill names and instructions", () => {
  const list = allSkills([]);
  assert.match(skillCatalogPrompt(list), /code-review/);
  assert.match(skillCatalogPrompt(list), /load_skill/);
  assert.ok(activeSkillPrompt(list[0]).includes(list[0].instructions));
});

test("finds a closed html fence and reports completeness", () => {
  const text = `Вот страница:\n${FENCE}html\n${PAGE}\n${FENCE}\nГотово.`;
  const blocks = findHtmlBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].complete, true);
  assert.equal(blocks[0].html, PAGE);
});

test("finds an unclosed (streaming) html fence as incomplete", () => {
  const text = `${FENCE}html\n<!DOCTYPE html><html><body><p>пишу`;
  const block = extractHtml(text);
  assert.equal(block.complete, false);
  assert.match(block.html, /пишу$/);
});

test("finds bare html without fence", () => {
  const block = extractHtml(`Сейчас:\n${PAGE}\nконец`);
  assert.equal(block.complete, true);
  assert.match(block.html, /<\/html>$/);
});

test("ignores html inside think tags", () => {
  const text = `<think>${FENCE}html\n<html></html>\n${FENCE}</think>\nТекст без страницы`;
  assert.equal(extractHtml(text), null);
  assert.equal(stripThink("a<think>x</think>b"), "ab");
});

test("extractHtml returns the last page when there are several", () => {
  const text = `${FENCE}html\n<html>first</html>\n${FENCE}\n\n${FENCE}html\n<html>second</html>\n${FENCE}`;
  assert.match(extractHtml(text).html, /second/);
});

test("splitByHtml separates text from pages in order", () => {
  const parts = splitByHtml(`до\n${FENCE}html\n${PAGE}\n${FENCE}\nпосле`);
  assert.deepEqual(parts.map((p) => p.type), ["text", "html", "text"]);
  assert.match(parts[0].text, /до/);
  assert.match(parts[2].text, /после/);
});

test("elideHtml removes every page from old context", () => {
  const out = elideHtml(`Вот:\n${FENCE}html\n${PAGE}\n${FENCE}\nКонец`);
  assert.ok(!out.includes("<html"));
  assert.match(out, /Вот:/);
  assert.match(out, /Конец/);
});

test("injectCsp places the policy inside head and keeps the doctype first", () => {
  const out = injectCsp(PAGE);
  assert.ok(out.startsWith("<!DOCTYPE html>"));
  assert.ok(out.indexOf("Content-Security-Policy") < out.indexOf("<title>"));
  assert.ok(PREVIEW_CSP.includes("default-src 'none'"));
});

test("injectCsp works for a fragment without head", () => {
  const out = injectCsp("<div>кусок</div>");
  assert.ok(out.includes("Content-Security-Policy"));
  assert.ok(out.endsWith("<div>кусок</div>"));
});

test("suggestFileName uses the title", () => {
  assert.equal(suggestFileName(PAGE), "тест-страница.html");
  assert.equal(suggestFileName("<p>без заголовка</p>"), "index.html");
});

test("continuation drops a repeated overlap", () => {
  const prev = "<div class=\"card\">первая часть текста страницы";
  const next = "первая часть текста страницы и вторая";
  assert.equal(trimOverlap(prev, next), " и вторая");
});

test("continuation drops a reopened fence when the previous one was cut", () => {
  const prev = `${FENCE}html\n<html><body><p>обрыв`;
  const next = `${FENCE}html\n продолжение</body></html>\n${FENCE}`;
  const clean = cleanContinuation(prev, next);
  assert.ok(!clean.startsWith(FENCE));
  assert.match(clean, /^ продолжение/);
});

test("continuation keeps text when there is nothing to remove", () => {
  assert.equal(cleanContinuation("короткий", "совсем новый кусок текста"), "совсем новый кусок текста");
  assert.equal(stripReopenedFence("без блоков", "текст"), "текст");
});

// Формат вызовов модели: name{key:<|"|>значение<|"|>} — ключи без кавычек, строки в маркерах.
import { parseTextToolCalls, gemmaObjectToJson, parseCallBody } from "../../frontend/js/toolparse.js";

test("parses the model's marker-quoted call format", () => {
  const body = 'show_html{height:400,html:<|"|><div class="a">x</div><|"|>,title:<|"|>Окно<|"|>}';
  const [call] = parseTextToolCalls(`<tool_call>${body}</tool_call>`);
  assert.equal(call.name, "show_html");
  assert.deepEqual(JSON.parse(call.args), { height: 400, html: '<div class="a">x</div>', title: "Окно" });
});

test("gemma object converter keeps quotes inside values", () => {
  const json = gemmaObjectToJson('{a:<|"|>say "hi"<|"|>,b:true}');
  assert.deepEqual(JSON.parse(json), { a: 'say "hi"', b: true });
  assert.equal(gemmaObjectToJson('{a:<|"|>open'), null);
});

test("standard JSON calls still parse", () => {
  assert.deepEqual(parseCallBody('{"name":"read_file","arguments":{"path":"a"}}'), { name: "read_file", args: { path: "a" } });
  assert.equal(parseCallBody("мусор"), null);
});

import { parseAspect } from "../../frontend/js/webdev.js";
test("window aspect comes from the fence line or a comment, default 16:9", () => {
  assert.deepEqual(parseAspect("9:16", ""), { w: 9, h: 16 });
  assert.deepEqual(parseAspect("", "<!-- aspect: 1:1 -->\n<html>"), { w: 1, h: 1 });
  assert.deepEqual(parseAspect("", "<html>"), { w: 16, h: 9 });
  assert.deepEqual(parseAspect("10:1", ""), { w: 3, h: 1 }); // слишком широко — ограничено
  const block = findHtmlBlocks(`${FENCE}html 4:3\n<html></html>\n${FENCE}`)[0];
  assert.deepEqual(block.aspect, { w: 4, h: 3 });
});

test("catalog tells the model when NOT to load a skill", () => {
  const prompt = skillCatalogPrompt(allSkills([]));
  assert.match(prompt, /ТОЛЬКО тогда/);
  assert.match(prompt, /не нужен/);
  assert.match(prompt, /уже был загружен/);
  for (const s of allSkills([]).filter((x) => x.name.startsWith("python"))) {
    assert.ok(s.description.includes("Не применяй") || s.description.includes("Применяй"), s.name);
  }
});
