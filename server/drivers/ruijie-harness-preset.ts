import { isMap, isSeq, parseDocument, type YAMLSeq } from "yaml";

/** Edit YAML nodes rather than parsing/stringifying JS values: !!js platform
 * guards belong to Harness and must survive without being evaluated by Bot. */
export function withoutHarnessWebSearch(base: string): string {
  const document = parseDocument(base);
  if (document.errors.length || !isSeq(document.contents)) throw new Error("Harness standard preset must be a valid YAML plugin list.");
  const walk = (rows: YAMLSeq) => {
    for (const row of rows.items) {
      if (!isMap(row)) throw new Error("Harness preset contains an invalid plugin row.");
      if (row.get("name") === "@deepseek-ai/dsh-tool-web") {
        // Native browser aliases replace both operations, including web_fetch.
        // Keep unrelated configuration, comments and platform guards intact.
        row.setIn(["config", "search"], false);
        row.setIn(["config", "fetch"], false);
      }
      if (row.get("name") === "cordis:group") {
        const children = row.get("config");
        if (!isSeq(children)) throw new Error("Harness preset contains an invalid plugin group.");
        walk(children);
      }
    }
  };
  walk(document.contents);
  return document.toString();
}
