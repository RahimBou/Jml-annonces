#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const vm = require("node:vm");

const files = ["server.js", "public/index.html", "public/createur-post.html"];
let checkedScripts = 0;

for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  if (file.endsWith(".js")) {
    new vm.Script(source, { filename: file });
    checkedScripts++;
    continue;
  }

  const blocks = [...source.matchAll(/<script\\b[^>]*>([\\s\\S]*?)<\\/script>/gi)];
  if (!blocks.length) throw new Error("Aucun script inline trouvé dans " + file);
  blocks.forEach((match, index) => {
    const code = match[1].trim();
    if (!code) return;
    new vm.Script(code, { filename: file + "#script-" + (index + 1) });
    checkedScripts++;
  });
}

process.stdout.write("Syntaxe JavaScript valide : " + checkedScripts + " bloc(s) vérifié(s).\\n");
