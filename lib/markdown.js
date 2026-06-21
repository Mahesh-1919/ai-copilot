// Minimal markdown -> HTML renderer. Handles **bold**, *italic*, `inline code`,
// fenced ```code blocks```, paragraphs, unordered/ordered lists. Escapes HTML
// in the source first so untrusted LLM output cannot inject markup.
//
// Mirrored as an inline copy inside content/panel.js (content scripts cannot
// share ES modules with extension-page contexts at runtime). Keep both in
// sync if you change one.

export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function renderMarkdown(src) {
  if (!src) return "";
  let s = escapeHtml(src);

  // Lift fenced code blocks out of the text BEFORE we split on \n so the
  // internal newlines aren't lost when paragraphs are reassembled.
  const codeBlocks = [];
  s = s.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(code.replace(/\n$/, ""));
    return `\u0000PRE${idx}\u0000`;
  });

  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");

  const lines = s.split("\n");
  const out = [];
  let para = [];
  let inList = null;
  const flushPara = () => {
    if (para.length) { out.push(`<p>${para.join(" ")}</p>`); para = []; }
  };
  const closeList = () => {
    if (inList) { out.push(inList === "ul" ? "</ul>" : "</ol>"); inList = null; }
  };
  for (const ln of lines) {
    const trimmed = ln.trim();
    if (trimmed === "") { flushPara(); closeList(); continue; }
    const preM = trimmed.match(/^\u0000PRE(\d+)\u0000$/);
    if (preM) {
      flushPara(); closeList();
      out.push(`<pre>${codeBlocks[Number(preM[1])]}</pre>`);
      continue;
    }
    const ulM = ln.match(/^\s*[-*+]\s+(.*)$/);
    const olM = ln.match(/^\s*\d+\.\s+(.*)$/);
    if (ulM) {
      flushPara();
      if (inList !== "ul") { closeList(); out.push("<ul>"); inList = "ul"; }
      out.push(`<li>${ulM[1]}</li>`);
      continue;
    }
    if (olM) {
      flushPara();
      if (inList !== "ol") { closeList(); out.push("<ol>"); inList = "ol"; }
      out.push(`<li>${olM[1]}</li>`);
      continue;
    }
    closeList();
    para.push(ln);
  }
  flushPara();
  closeList();

  let html = out.join("\n");
  html = html.replace(/\u0000PRE(\d+)\u0000/g, (_m, i) => `<pre>${codeBlocks[Number(i)]}</pre>`);
  return html;
}
