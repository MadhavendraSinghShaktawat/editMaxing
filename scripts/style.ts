import { mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HOME, SHARED_STYLES } from "../engine/src/config.ts";
import { checkSharedStyle, slugOf, toSharedStyle } from "../engine/src/styles.ts";

/** Moves a style from someone's Mac into the repo. See library/styles/README.md. */
const [command, ...rest] = process.argv.slice(2);
const flag = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i < 0 ? undefined : rest.splice(i, 2)[1];
};

function saved() {
  const path = join(HOME, "dojo.db");
  if (!existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  return db.prepare("SELECT name, status, mode, card FROM styles ORDER BY created_at").all() as { name: string; status: string; mode: string | null; card: string }[];
}

function check() {
  const slugs = existsSync(SHARED_STYLES) ? readdirSync(SHARED_STYLES).filter((slug) => existsSync(join(SHARED_STYLES, slug, "style.json"))) : [];
  if (!slugs.length) console.log("The dojo is empty, and that's fine. No styles to check.");
  let bad = 0;
  for (const slug of slugs) {
    const problems = checkSharedStyle(JSON.parse(readFileSync(join(SHARED_STYLES, slug, "style.json"), "utf8")));
    if (problems.length) bad++;
    console.log(problems.length ? `✗ ${slug}\n${problems.map((p) => `    ${p}`).join("\n")}` : `✓ ${slug}`);
  }
  process.exit(bad ? 1 : 0);
}

function list() {
  const styles = saved();
  if (!styles.length) console.log("No saved styles on this Mac yet. Make one in the Styles board first.");
  for (const s of styles) console.log(`${s.status === "approved" ? "✓" : "…"} ${s.name}${s.status === "approved" ? "" : " (still a draft)"}`);
}

function add() {
  const author = flag("author");
  const name = rest.join(" ").trim();
  if (!name || !author) {
    console.error('Usage: npm run style -- add "Style name" --author "Your name"');
    process.exit(2);
  }
  const style = saved().find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!style) {
    console.error(`There's no saved style called "${name}". Run: npm run style -- list`);
    process.exit(1);
  }
  if (style.status !== "approved") {
    console.error(`"${style.name}" is still a draft. Approve it in the Styles board first.`);
    process.exit(1);
  }
  const shared = toSharedStyle({ name: style.name, mode: style.mode, card: JSON.parse(style.card) }, author);
  const problems = checkSharedStyle(shared);
  if (problems.length) {
    console.error(`"${style.name}" isn't ready:\n${problems.map((p) => `  ${p}`).join("\n")}`);
    process.exit(1);
  }
  const dir = join(SHARED_STYLES, slugOf(style.name));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "style.json"), `${JSON.stringify(shared, null, 2)}\n`);
  console.log(`Added ${join("library/styles", slugOf(style.name), "style.json")}. Now open a pull request.`);
}

if (command === "check") check();
else if (command === "list") list();
else if (command === "add") add();
else {
  console.error('Commands: list, add "Style name" --author "Your name", check');
  process.exit(2);
}
