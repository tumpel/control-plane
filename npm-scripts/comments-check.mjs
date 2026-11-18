#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REGEX_AFTER = new Set([..."(,=:[!&|?{};+-*%<>~^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|case|in|of|delete|void|throw|new|else|do|yield|await)$/;

const tracked = execFileSync(
  "git",
  ["ls-files", "--", "packages/**.ts", "packages/**.tsx", "packages/**.mjs", "npm-scripts/*.mjs"],
  { cwd: ROOT, encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean);

const skipQuoted = (source, start, quote) => {
  let index = start + 1;
  while (index < source.length && source[index] !== quote) index += source[index] === "\\" ? 2 : 1;
  return index + 1;
};

const skipRegex = (source, start) => {
  let index = start + 1;
  let inClass = false;
  while (index < source.length && source[index] !== "\n") {
    const char = source[index];
    if (char === "\\") index += 1;
    else if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) return index + 1;
    index += 1;
  }
  return index;
};

const regexCanStart = (source, index) => {
  const before = source.slice(0, index).trimEnd();
  if (before === "") return true;
  return REGEX_AFTER.has(before.at(-1)) || REGEX_KEYWORDS.test(before);
};

const scan = (source) => {
  const comments = [];
  const templates = [];
  let index = 0;
  const lineAt = (position) => source.slice(0, position).split("\n").length;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (templates.length > 0 && templates.at(-1) === 0 && char !== "`") {
      if (char === "\\") index += 2;
      else if (char === "$" && next === "{") {
        templates[templates.length - 1] = 1;
        index += 2;
      } else index += 1;
      continue;
    }
    if (char === "`") {
      if (templates.length > 0 && templates.at(-1) === 0) templates.pop();
      else templates.push(0);
      index += 1;
      continue;
    }
    if (templates.length > 0 && char === "{") templates[templates.length - 1] += 1;
    if (templates.length > 0 && char === "}") templates[templates.length - 1] -= 1;
    if (char === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? source.indexOf("\n", index) : source.indexOf("*/", index + 2) + 2;
      comments.push(lineAt(index));
      index = end <= index ? source.length : end;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipQuoted(source, index, char);
      continue;
    }
    if (char === "/" && regexCanStart(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    index += char === "\\" ? 2 : 1;
  }
  return comments;
};

const failures = tracked.flatMap((file) =>
  scan(readFileSync(`${ROOT}${file}`, "utf8")).map((line) => `${file}:${line}`),
);

if (failures.length > 0) {
  console.error(`comments check failed: AGENTS.md says no comments in code.\n  ${failures.join("\n  ")}`);
  console.error("Fix: remove the comment and say it with names, or move the rationale to the commit message.");
  process.exit(1);
}
console.log(`comments: ${tracked.length} source files carry no comments`);
