import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { MemoryStore } from "./store.ts";
import { renderMemories, selectMemories } from "./retrieve.ts";

export function autocomplete(current: AutocompleteProvider, getStore: () => MemoryStore | undefined): AutocompleteProvider {
  return {
    async getSuggestions(lines, line, col, options) {
      const token = lines[line]?.slice(0, col).match(/#"([^"\n]*)$/);
      const store = getStore();
      if (!token || !store) return current.getSuggestions(lines, line, col, options);
      if (options.signal.aborted) return null;
      const results = store.search(token[1], { limit: 10 });
      return results.length ? { prefix: token[0], items: results.map(item => ({ value: `#mem:${item.id}`, label: item.title, description: item.summary })) } : null;
    },
    applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
    shouldTriggerFileCompletion: (lines, line, col) => current.shouldTriggerFileCompletion?.(lines, line, col) ?? true,
  };
}

export function expandReferences(text: string, store: MemoryStore, budgetTokens: number): string | undefined {
  const found = new Map();
  const transformed = text.replace(/#"([^"\n]{1,500})"|#mem:(m_[a-zA-Z0-9_-]+)/g, (token, query: string | undefined, id: string | undefined) => {
    const items = id ? store.get([id]).filter(i => i.status === "active") : store.search(query!, { limit: 5 });
    for (const item of items) found.set(item.id, item);
    return query ? `[memory search: ${query}]` : token;
  });
  if (transformed === text && !found.size) return undefined;
  const items = selectMemories([...found.values()], { budgetTokens, maxItems: 8 });
  const rendered = renderMemories(items, budgetTokens);
  return `${transformed}${rendered ? `\n\n${rendered}` : "\n\n[No relevant memory found.]"}`;
}
