/** DOM APIs that parse a string as HTML; the web app must never use them (threat model §4). */
const SINKS: readonly { readonly name: string; readonly re: RegExp }[] = [
  { name: "innerHTML", re: /\binnerHTML\b/ },
  { name: "outerHTML", re: /\bouterHTML\b/ },
  { name: "insertAdjacentHTML", re: /\binsertAdjacentHTML\b/ },
  { name: "document.write", re: /\bdocument\s*\.\s*write(ln)?\b/ },
  { name: "DOMParser", re: /\bDOMParser\b/ },
  { name: "createContextualFragment", re: /\bcreateContextualFragment\b/ },
  { name: "srcdoc", re: /\bsrcdoc\b/i },
  { name: "setHTMLUnsafe", re: /\bsetHTMLUnsafe\b/ },
  { name: "parseHTMLUnsafe", re: /\bparseHTMLUnsafe\b/ },
];

/** Names of the banned sinks that appear anywhere in `source` (comments included: keep them out too). */
export function findHtmlSinks(source: string): string[] {
  return SINKS.filter((s) => s.re.test(source)).map((s) => s.name);
}
