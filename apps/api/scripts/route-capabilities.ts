import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * The route→capability manifest, derived from the API's controllers, and the client's call sites,
 * derived from the web app's `authFetch` calls. Ruled by the founder on 2026-09-06 as **step 1** of
 * the fix for a defect class that had by then cost four sessions.
 *
 * ## What was wrong
 *
 * A screen's knowledge of what it may do was written by hand in three places that nothing compared:
 * the nav item's capability string, the button's `me.permissions[...]` check, and the route's
 * `@RequirePermission`. **Both failure directions produce a green suite** — a wrongly hidden section
 * is silent, and a wrongly shown button is silent until somebody clicks it and gets a 403. Three
 * screens had already been patched one at a time (the transfer panel, the complete button, the
 * queue), and a fourth pair of bugs was found the day this was written: the owner's queue link
 * gated on a capability the owner had just lost, and a queue fetch of a route the owner may not
 * read that took the whole board down.
 *
 * The founder's ruling: *"A manifest generated from the API and asserted against the client turns
 * that into a test failure. One day is cheap for a defect class that has now cost four sessions."*
 *
 * ## Why this is a hand parser and not the TypeScript AST
 *
 * It should have been `ts.createSourceFile`. **TypeScript 7 does not ship the JavaScript compiler
 * API** — `require("typescript")` in this repo returns an object with `version` and
 * `versionMajorMinor` and nothing else, checked rather than assumed. Reaching for a parser
 * dependency is a decision CLAUDE.md says to bring to the founder, and it is not worth one here.
 *
 * **So do not "improve" this into an AST version without first checking that a compiler API
 * exists.** It was considered and rejected, on the founder's instruction to write the reason down:
 * *"otherwise someone will 'improve' it into an AST version and find the same wall."* The wall is
 * that `ts.ScriptTarget`, `ts.SyntaxKind` and `ts.createSourceFile` are all `undefined` here. If a
 * later TypeScript restores them, or a parser dependency is approved, this file is the right thing
 * to replace — but the three cross-check tests below must survive the replacement, because they are
 * what makes any extraction trustworthy, AST or not.
 *
 * That leaves text scanning, which is the technique this project distrusts most, because a pattern
 * that silently stops matching produces exactly the green-suite silence the manifest exists to end.
 * So the parser is written to make under-matching **loud**. `route-capability-manifest.spec.ts`
 * opens with three tests under "the extraction found everything, cross-checked two ways": one route
 * per HTTP-verb decorator, at least one route per controller file, and this extraction's capability
 * set equal to a second and deliberately dumber grep for `@RequirePermission`. Deleting `async `
 * from one regex in this file fails seven tests, three of them those — measured, not asserted.
 */

export interface RouteEntry {
  method: HttpMethod;
  /** `/doctors/:id`, with the controller prefix already joined on. No `/api` — that is a proxy. */
  path: string;
  /** `null` for a route with no `@RequirePermission`: the auth and health endpoints. */
  capability: string | null;
  /** Repo-relative, for a failure message that names where to look. */
  source: string;
}

export interface CallSite {
  method: HttpMethod;
  /** Path with every interpolated expression replaced by `:param`, query string dropped. */
  path: string;
  source: string;
  /** The text as written, so a failure can quote what the author actually typed. */
  raw: string;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const HTTP_DECORATORS: Record<string, HttpMethod> = {
  Get: "GET",
  Post: "POST",
  Patch: "PATCH",
  Put: "PUT",
  Delete: "DELETE",
};

/**
 * Comments removed, string and template literals left intact.
 *
 * Without this a commented-out `@Get()` becomes a route and a commented-out `authFetch` becomes a
 * call site — and both would be invisible failures of the "did we find everything" invariant, which
 * is the one thing this module cannot afford to get wrong.
 */
export function stripComments(source: string): string {
  let out = "";
  let index = 0;
  type Mode = "code" | "line" | "block" | "'" | '"' | "`";
  let mode: Mode = "code";

  while (index < source.length) {
    const two = source.slice(index, index + 2);
    const char = source[index] ?? "";

    if (mode === "code") {
      if (two === "//") { mode = "line"; index += 2; continue; }
      if (two === "/*") { mode = "block"; index += 2; continue; }
      if (char === "'" || char === '"' || char === "`") mode = char;
      out += char;
      index += 1;
      continue;
    }

    if (mode === "line") {
      if (char === "\n") { mode = "code"; out += char; }
      index += 1;
      continue;
    }

    if (mode === "block") {
      if (two === "*/") { mode = "code"; index += 2; continue; }
      // Newlines are kept so that reported line numbers stay honest.
      if (char === "\n") out += char;
      index += 1;
      continue;
    }

    // Inside a string or template. A backslash escapes whatever follows, including the quote.
    if (char === "\\") { out += source.slice(index, index + 2); index += 2; continue; }
    if (char === mode) mode = "code";
    out += char;
    index += 1;
  }

  return out;
}

/** The text between the parentheses of `name(` starting at `open`, and the index just past `)`. */
function balanced(source: string, open: number): { args: string; end: number } {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return { args: source.slice(open + 1, index), end: index + 1 };
    }
  }
  throw new Error(`Unbalanced parentheses from offset ${String(open)}`);
}

/** The first single- or double-quoted string in `text`, or null. Decorator paths are literals. */
function firstString(text: string): string | null {
  return /(["'])((?:\\.|(?!\1).)*)\1/.exec(text)?.[2] ?? null;
}

export function sourceFiles(directory: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory)) {
    if (entry === "node_modules" || entry === "generated" || entry === "dist") continue;
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full, extensions));
    else if (extensions.some((extension) => full.endsWith(extension))) out.push(full);
  }
  return out;
}

interface Decorator {
  name: string;
  args: string;
  /** Index just past the closing parenthesis, used to attach decorators to what follows them. */
  end: number;
}

function decorators(text: string): Decorator[] {
  const out: Decorator[] = [];
  for (const match of text.matchAll(/@([A-Za-z_$][\w$]*)\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    const { args, end } = balanced(text, open);
    out.push({ name: match[1] ?? "", args, end });
  }
  return out;
}

/**
 * Joins a controller prefix and a method path into one absolute path.
 *
 * `@Controller()` with no argument is five of this API's controllers, and `@Get()` with no argument
 * is the index route of several — so both halves are optional and the join has to survive either
 * being empty without producing `//` or a trailing slash.
 */
function joinPath(prefix: string, sub: string): string {
  const segments = [...prefix.split("/"), ...sub.split("/")].filter((part) => part.length > 0);
  return `/${segments.join("/")}`;
}

/** Every route the API's controllers declare, with the capability guarding it. */
export function apiRoutes(apiSrcDirectory: string, repoRoot: string): RouteEntry[] {
  const out: RouteEntry[] = [];

  for (const file of sourceFiles(apiSrcDirectory, [".controller.ts"])) {
    const text = stripComments(readFileSync(file, "utf8"));
    const source = path.relative(repoRoot, file).split(path.sep).join("/");
    const found = decorators(text);

    // Every `@Controller` in the file, not the first: two controllers in one file is a real shape
    // here (`bot-credential.controller.ts`), and taking the first gave the second one's routes a
    // path the API does not serve — a manifest that disagrees with the server it describes.
    const controllers = found.filter((decorator) => decorator.name === "Controller");
    const prefixAt = (position: number): string => {
      const owning = controllers.filter((decorator) => decorator.end <= position).at(-1);
      return owning === undefined ? "" : (firstString(owning.args) ?? "");
    };

    // A method declaration: `async list(`, `list(`, `private caller(`. Attaching decorators by
    // position rather than by proximity is what makes an extra decorator between them harmless.
    const methodStarts = [...text.matchAll(/\n[ \t]*(?:public |private |protected )?(?:async )?([A-Za-z_$][\w$]*)\s*\(/g)]
      .map((match) => match.index);

    for (let index = 0; index < methodStarts.length; index += 1) {
      const start = methodStarts[index] ?? 0;
      const previousEnd = index === 0 ? 0 : (methodStarts[index - 1] ?? 0);
      // `<= start` and not `< start`: a method-start match begins at the newline that terminates
      // the decorator line, so the decorator's exclusive end index and the method's start index are
      // the same number. `<` lost `@Get()` on `health.controller.ts` -- one route, silently, which
      // is precisely the failure `countVerbDecorators` exists to make loud, and did.
      const mine = found.filter(
        (decorator) => decorator.end > previousEnd && decorator.end <= start,
      );


      const verb = mine.find((decorator) => decorator.name in HTTP_DECORATORS);
      if (verb === undefined) continue;

      const permission = mine.find((decorator) => decorator.name === "RequirePermission");
      out.push({
        method: HTTP_DECORATORS[verb.name] as HttpMethod,
        path: joinPath(prefixAt(start), firstString(verb.args) ?? ""),
        capability: permission === undefined ? null : firstString(permission.args),
        source,
      });
    }
  }

  return out.sort((a, b) => `${a.path} ${a.method}`.localeCompare(`${b.path} ${b.method}`));
}

/**
 * The number of HTTP-verb decorators in the API's controllers.
 *
 * The invariant the spec asserts against `apiRoutes().length`. If the method-declaration regex ever
 * stops matching a declaration shape somebody introduces — a getter, a decorator placed after the
 * signature, a generic — this count and the manifest diverge and the suite says so, instead of the
 * manifest quietly losing a route and every assertion built on it passing.
 */
export function countVerbDecorators(apiSrcDirectory: string): number {
  let total = 0;
  for (const file of sourceFiles(apiSrcDirectory, [".controller.ts"])) {
    const text = stripComments(readFileSync(file, "utf8"));
    for (const decorator of decorators(text)) if (decorator.name in HTTP_DECORATORS) total += 1;
  }
  return total;
}

/**
 * A client path as written, reduced to the shape the manifest speaks.
 *
 * `/api` comes off (it is the Vite/nginx proxy prefix, not part of any route), the query string
 * comes off, and every `${...}` becomes `:param` — a hole whose value the scanner cannot know.
 * `/api/queue/${appointmentId}/${move}` becomes `/queue/:param/:param`, which is honest: that one
 * call site can reach `check-in`, `start`, `complete` and `no-show`, and `matchingRoutes` returns
 * all four.
 */
export function normalisePath(written: string): string {
  const withoutQuery = written.split("?")[0] ?? "";
  const withoutParams = withoutQuery.replace(/\$\{[^}]*\}/g, ":param");
  return withoutParams.startsWith("/api/")
    ? withoutParams.slice("/api".length)
    : withoutParams === "/api"
      ? "/"
      : withoutParams;
}

/**
 * Every `authFetch(...)` in the web app, with the path and method it uses.
 *
 * Two of these call sites take the path as a **parameter** — `json()` in `patients-api.ts` and
 * `write()` in `services-api.ts` — so the call is resolved one level up: when an argument is an
 * identifier rather than a literal, the callers of the enclosing function *within the same file*
 * are read and their arguments substituted. Anything still unresolvable is returned with
 * `path: null` rather than dropped, so the spec can fail on it instead of the scanner quietly
 * shrinking.
 */
export function webCallSites(
  webSrcDirectory: string,
  repoRoot: string,
): { resolved: CallSite[]; unresolved: { source: string; raw: string }[] } {
  const resolved: CallSite[] = [];
  const unresolved: { source: string; raw: string }[] = [];

  for (const file of sourceFiles(webSrcDirectory, [".ts", ".tsx"])) {
    const text = stripComments(readFileSync(file, "utf8"));
    const source = path.relative(repoRoot, file).split(path.sep).join("/");

    for (const match of text.matchAll(/authFetch\s*\(/g)) {
      const open = match.index + match[0].length - 1;
      const { args } = balanced(text, open);
      for (const site of resolveCall(args, text, open)) {
        if (site.path === null) unresolved.push({ source, raw: site.raw });
        else resolved.push({ method: site.method, path: site.path, source, raw: site.raw });
      }
    }
  }

  return { resolved, unresolved };
}

interface PartialSite {
  method: HttpMethod;
  path: string | null;
  raw: string;
}

/** `"..."`, `` `...` ``, or an identifier we have to chase. */
function literalPath(expression: string): string | null {
  const trimmed = expression.trim();
  if (/^`[^`]*`$/.test(trimmed)) return normalisePath(trimmed.slice(1, -1));
  const quoted = /^(["'])((?:\\.|(?!\1).)*)\1$/.exec(trimmed);
  return quoted === null ? null : normalisePath(quoted[2] ?? "");
}

function literalMethod(argsAfterPath: string): HttpMethod | "UNKNOWN" {
  const match = /\bmethod\s*:\s*"([A-Z]+)"/.exec(argsAfterPath);
  if (match !== null) return (match[1] ?? "GET") as HttpMethod;
  // `method,` shorthand or `method: someVariable` -- present in the services write helper.
  return /\bmethod\s*[,:]/.test(argsAfterPath) ? "UNKNOWN" : "GET";
}

/** Splits a decorator/call argument list on top-level commas. */
function topLevelArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of args) {
    if ("([{".includes(char)) depth += 1;
    if (")]}".includes(char)) depth -= 1;
    if (char === "," && depth === 0) { out.push(current); current = ""; continue; }
    current += char;
  }
  if (current.trim().length > 0) out.push(current);
  return out;
}

function resolveCall(args: string, fileText: string, callOffset: number): PartialSite[] {
  const parts = topLevelArgs(args);
  const pathExpression = parts[0] ?? "";
  const rest = parts.slice(1).join(",");
  const raw = `authFetch(${args.replace(/\s+/g, " ").trim().slice(0, 120)})`;

  const direct = literalPath(pathExpression);
  const method = literalMethod(rest);
  if (direct !== null && method !== "UNKNOWN") return [{ method, path: direct, raw }];

  // One level of chasing: the path (and possibly the method) is a parameter of the enclosing
  // helper, so read what this file passes to that helper.
  const helper = enclosingFunctionName(fileText, callOffset);
  if (helper === null) return [{ method: "GET", path: null, raw }];

  const sites: PartialSite[] = [];
  for (const call of callsTo(fileText, helper)) {
    const callArgs = topLevelArgs(call);
    const substituted = substitute(pathExpression, helper, fileText, callArgs);
    const substitutedMethod =
      method === "UNKNOWN" ? substituteMethod(rest, helper, fileText, callArgs) : method;
    if (substituted === null || substitutedMethod === null) {
      sites.push({ method: "GET", path: null, raw });
      continue;
    }
    sites.push({ method: substitutedMethod, path: substituted, raw: `${helper}(${call.trim().slice(0, 100)})` });
  }
  return sites.length === 0 ? [{ method: "GET", path: null, raw }] : sites;
}

/**
 * The name of the function whose body contains the call at `offset`.
 *
 * The last **function** declared before that point — a `function name(`, or a `const name = (`
 * arrow. Two things it deliberately is not:
 *
 * It is not found by searching for the call's own text. `authFetch(path)` has the argument text
 * `path`, and `indexOf("path")` lands on the first occurrence of those four letters anywhere in the
 * file — for `patients-api.ts` a type annotation two hundred lines earlier.
 *
 * And it does not accept any `const name =`. The line the call actually sits on is
 * `const response = await authFetch(path)`, so a pattern that took the nearest `const` answered
 * `response` and the chase ended there. Requiring a `(` after the `=` is what tells a function
 * binding apart from an ordinary one. Both mistakes produced "unresolvable" rather than a wrong
 * answer, which is the safe direction — the spec fails on an unresolvable call site.
 */
function enclosingFunctionName(fileText: string, offset: number): string | null {
  const declaration =
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]*)?=\s*(?:async\s*)?\(/g;
  const matches = [...fileText.slice(0, offset).matchAll(declaration)];
  const last = matches[matches.length - 1];
  return last?.[1] ?? last?.[2] ?? null;
}

/** Argument lists of every call to `name` in the file, excluding its own declaration. */
function callsTo(fileText: string, name: string): string[] {
  const out: string[] = [];
  // `(?:<[^<>()]*>)?` because `json<PatientDetail>(...)` is a call to `json`. Without it a generic
  // helper looked like it had no callers at all, so its path stayed unresolved and two real routes
  // went unchecked while the suite stayed green -- the exact silence this file exists to end.
  const call = new RegExp(`(?<![\\w$.])${name}\\s*(?:<[^<>()]*>)?\\s*\\(`, "g");
  for (const match of fileText.matchAll(call)) {
    const before = fileText.slice(Math.max(0, match.index - 30), match.index);
    if (/(?:function|const|async)\s*$/.test(before)) continue;
    out.push(balanced(fileText, match.index + match[0].length - 1).args);
  }
  return out;
}

/** The index of `parameterName` in `helper`'s declared parameter list, or -1. */
function parameterIndex(fileText: string, helper: string, parameterName: string): number {
  const declaration = new RegExp(
    `(?:function|const)\\s+${helper}\\s*(?:<[^<>()]*>)?\\s*[(=]`,
  ).exec(fileText);
  if (declaration === null) return -1;
  const open = fileText.indexOf("(", declaration.index);
  const names = topLevelArgs(balanced(fileText, open).args).map(
    (parameter) => /^\s*([A-Za-z_$][\w$]*)/.exec(parameter)?.[1] ?? "",
  );
  return names.indexOf(parameterName);
}

function substitute(
  expression: string,
  helper: string,
  fileText: string,
  callArgs: string[],
): string | null {
  const name = expression.trim();
  const index = parameterIndex(fileText, helper, name);
  if (index === -1) return literalPath(expression);
  return literalPath(callArgs[index] ?? "");
}

function substituteMethod(
  rest: string,
  helper: string,
  fileText: string,
  callArgs: string[],
): HttpMethod | null {
  // `{ method: verb }` names `verb`; `{ method, ... }` is shorthand and names `method` itself.
  // Reading them with one pattern captured the *next* property after the shorthand comma --
  // `headers` -- looked it up as a parameter, found none, and reported the call unresolvable.
  const explicit = /\bmethod\s*:\s*([A-Za-z_$][\w$]*)/.exec(rest)?.[1];
  const name = explicit ?? (/\bmethod\s*[,}]/.test(rest) ? "method" : null);
  if (name === null) return null;
  const index = parameterIndex(fileText, helper, name);
  if (index === -1) return null;
  const literal = /^\s*"([A-Z]+)"\s*$/.exec(callArgs[index] ?? "")?.[1];
  return literal === undefined ? null : (literal as HttpMethod);
}

/**
 * Every manifest route a call site could reach.
 *
 * A `:param` segment on the client side matches **any** manifest segment, because the scanner
 * cannot know what the expression evaluates to. That makes the check "this call could hit a real
 * route", which is the strongest claim available without running the code, and it is enough to
 * catch a renamed path, a wrong verb and a route that has moved. The capability such a call site
 * may need is the union over everything it matches.
 */
export function matchingRoutes(site: CallSite, routes: readonly RouteEntry[]): RouteEntry[] {
  const wanted = site.path.split("/");
  return routes.filter((route) => {
    if (route.method !== site.method) return false;
    const actual = route.path.split("/");
    if (actual.length !== wanted.length) return false;
    return wanted.every((segment, index) => {
      const other = actual[index] ?? "";
      return segment === ":param" || other.startsWith(":") || segment === other;
    });
  });
}
