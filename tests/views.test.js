/* ---------------------------------------------------------------------------
 * Power Fund — view scope checks
 *
 * Each file in js/views/ is a separate <script>. It cannot see app.js's closure,
 * so every helper it uses has to arrive on `ctx`. Get that wrong and the view
 * throws a ReferenceError — but only once execution actually reaches that
 * branch, which may be treasurer-only, or need data the fixtures don't produce.
 *
 * That is exactly how `formatDateTime` shipped: it sat on the treasurer's review
 * queue behind `b.submittedAt ? … : "—"`, and the mock's pending row had no
 * timestamp, so the ternary took the other path and every browser test passed.
 * It only ever fired against real data, as a frozen screen.
 *
 * These are static checks over the source — no browser, no fixtures — so they
 * catch the whole class regardless of which branch a test happens to exercise.
 *
 * RUN:  node tests/views.test.js
 * ------------------------------------------------------------------------- */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VIEWS_DIR = path.join(ROOT, "js", "views");

let failed = 0;
function check(name, pass, detail) {
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

/** Comments carry prose that looks like code; strip them before scanning. */
function stripComments(src) {
  src = src.replace(/\/\*[\s\S]*?\*\//g, "");
  src = src.replace(/^\s*\/\/.*$/gm, "");
  return src;
}

/** The names app.js actually puts on ctx. */
function ctxProvidedByApp() {
  const src = stripComments(fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8"));
  const start = src.indexOf("const ctx = {");
  if (start === -1) throw new Error("could not find the ctx literal in app.js");
  // Walk to the matching brace so nested objects don't end it early.
  let i = src.indexOf("{", start);
  let depth = 0;
  let end = -1;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  const body = src.slice(src.indexOf("{", start) + 1, end);
  return new Set(
    body
      .split(",")
      .map((part) => part.split(":")[0].trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
  );
}

/** The names a view destructures off ctx. */
function ctxUsedByView(src) {
  const m = src.match(/const\s*\{([\s\S]*?)\}\s*=\s*ctx;/);
  if (!m) return new Set();
  return new Set(
    m[1]
      .split(",")
      .map((n) => n.split(":").pop().trim())
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
  );
}

/** Names the file declares itself. */
function locals(src) {
  const out = new Set();
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) out.add(m[1]);
  // Destructured locals, e.g. const { startCycle, endCycle } = C.roundCycleRange(r)
  for (const m of src.matchAll(/(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    for (const n of m[1].split(",")) {
      const name = n.split(":").pop().trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) out.add(m[1]);
  for (const m of src.matchAll(/\.(?:map|filter|forEach|find|some|every|reduce|sort)\(\s*\(?\s*([A-Za-z_$][\w$]*)/g))
    out.add(m[1]);
  return out;
}

console.log("\nEvery ctx name a view destructures is actually provided");
const provided = ctxProvidedByApp();
check("app.js ctx parsed", provided.size > 10, `${provided.size} names`);

const files = fs.readdirSync(VIEWS_DIR).filter((f) => f.endsWith(".js")).sort();
check("view files found", files.length > 0, files.join(", "));

for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(VIEWS_DIR, f), "utf8"));
  const used = ctxUsedByView(src);
  const missing = [...used].filter((n) => !provided.has(n));
  check(
    `${f}: destructures only provided names`,
    missing.length === 0,
    missing.length ? `not on ctx: ${missing.join(", ")}` : `${used.size} names`
  );
}

console.log("\nNo view reaches into app.js's closure");
/*
 * The precise invariant, and the one that broke: a view may only call an
 * app.js-scope helper if that helper was handed to it on ctx. Checking against
 * the actual list of functions app.js declares keeps this exact — no parsing of
 * the views' template literals, and no false alarms from user-facing copy that
 * happens to look like a call.
 */
const appSrc = stripComments(fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8"));
const appFns = new Set(
  [...appSrc.matchAll(/(?:^|\s)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])
);
check("app.js closure functions found", appFns.size > 20, `${appFns.size} functions`);

for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(VIEWS_DIR, f), "utf8"));
  const onCtx = ctxUsedByView(src);
  const own = locals(src);
  const leaked = [...appFns].filter(
    (fn) =>
      !onCtx.has(fn) &&
      !own.has(fn) &&
      // A bare call to it: `fn(` not preceded by a dot (PowerFund.fn( is fine,
      // that goes through the global and is resolved at click time).
      new RegExp("(?<![.\\w$])" + fn + "\\s*\\(").test(src)
  );
  check(
    `${f}: no app.js-only helpers`,
    leaked.length === 0,
    leaked.length ? `needs adding to ctx: ${leaked.join(", ")}` : "clean"
  );
}

console.log("\nNo view uses a ctx name it forgot to destructure");
/*
 * The mirror of the check above, and its blind spot: that one looks for app.js
 * FUNCTIONS, so a plain value like `isWide` slipped through — used in the
 * assembly, never destructured, and undefined at run time. Any ctx name a view
 * mentions has to be one it actually pulled off ctx.
 */
for (const f of files) {
  const src = stripComments(fs.readFileSync(path.join(VIEWS_DIR, f), "utf8"));
  const onCtx = ctxUsedByView(src);
  const own = locals(src);
  const forgotten = [...provided].filter(
    (n) =>
      !onCtx.has(n) &&
      !own.has(n) &&
      // Mentioned as a bare identifier: not after a dot, and not as an object
      // key or a string. Word boundaries either side.
      // Used as code, not as prose. A leading hyphen would make it a CSS class
      // ("detail-rounds"); a following letter makes it a sentence ("rounds in
      // total"). A real reference is followed by punctuation — `.`, `)`, `?`,
      // an operator, a comma — or nothing at all.
      new RegExp(
        "(?<![.\\w$\"'-])" + n + "(?![\\w$-])\\s*(?=[.,;:?)\\]}=<>+\\-*/&|!]|$)"
      ).test(src)
  );
  check(
    `${f}: no undeclared ctx names`,
    forgotten.length === 0,
    forgotten.length ? `used but not destructured: ${forgotten.join(", ")}` : "clean"
  );
}

console.log(failed ? `\n${failed} check(s) FAILED\n` : "\nall checks passed\n");
process.exit(failed ? 1 : 0);
