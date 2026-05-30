/**
 * corellium_search — discovery. Renders ranked matches from the unified index
 * (operations + wrappers + recipes) at a chosen verbosity.
 */
import { searchIndex, countByKind, type ItemKind } from "../spec/index.js";

export type Detail = "name" | "summary" | "full";

const TAG: Record<ItemKind, string> = { recipe: "RECIPE", wrapper: "WRAP", operation: "OP" };

export function formatSearch(
  query: string,
  detail: Detail = "summary",
  kind?: ItemKind,
  limit = 12,
): string {
  const results = searchIndex(query, { kind, limit });
  const counts = countByKind();
  if (results.length === 0) {
    return (
      `No matches for "${query}".\n` +
      `The index has ${counts.operation} operations, ${counts.wrapper} wrappers, ${counts.recipe} recipes.\n` +
      `Try broader terms, or fall back to corellium.request({ path }) — it reaches any operation.`
    );
  }

  const lines: string[] = [
    `${results.length} match(es) for "${query}"  ·  index: ${counts.operation} ops / ${counts.wrapper} wrappers / ${counts.recipe} recipes`,
    `(use these inside corellium_run; everything is callable on the in-sandbox \`corellium\` client)`,
    "",
  ];

  for (const r of results) {
    const t = TAG[r.kind];
    if (detail === "name") {
      lines.push(`[${t}] ${r.signature}`);
    } else if (detail === "full") {
      lines.push(`## [${t}] ${r.signature}`);
      if (r.summary) lines.push(r.summary);
      if (r.kind === "operation") {
        if (r.paramNames?.length) lines.push(`params: ${r.paramNames.join(", ")}`);
        if (r.bodyProps?.length) lines.push(`body: { ${r.bodyProps.join(", ")} }`);
        lines.push(
          `call: corellium.request({ method: '${r.method}', path: '${r.path}'` +
            (r.method !== "GET" ? ", body: { … }" : "") +
            " })",
        );
      } else if (r.body) {
        lines.push(r.body.trim());
      }
      lines.push("");
    } else {
      lines.push(`[${t}] ${r.signature}${r.summary ? ` — ${r.summary}` : ""}`);
    }
  }

  let out = lines.join("\n");
  const cap = detail === "full" ? 9000 : 4500;
  if (out.length > cap) out = out.slice(0, cap) + `\n…(truncated — narrow the query or lower 'limit')`;
  return out;
}
