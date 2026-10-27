// Minimal, dependency-free markdown renderer for streamed answers.
// Input is HTML-escaped first, so model output can never inject markup.
// Supports fenced code blocks, inline code, bold, italics, and ordered/unordered lists.

const PLACEHOLDER = /\u0000PRE(\d+)\u0000/g;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderMarkdown(source: string): string {
  if (!source) return '';
  let s = escapeHtml(source);

  // Lift fenced code blocks out so inline rules don't touch their contents.
  const codeBlocks: string[] = [];
  s = s.replace(/```([a-zA-Z0-9_+-]*)\r?\n?([\s\S]*?)```/g, (_match, _lang: string, code: string) => {
    codeBlocks.push(code.replace(/\n$/, ''));
    return `\u0000PRE${codeBlocks.length - 1}\u0000`;
  });

  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  const out: string[] = [];
  let paragraph: string[] = [];
  let list: 'ul' | 'ol' | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${paragraph.join(' ')}</p>`);
      paragraph = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };
  const openList = (kind: 'ul' | 'ol') => {
    if (list !== kind) {
      closeList();
      out.push(`<${kind}>`);
      list = kind;
    }
  };

  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      flushParagraph();
      closeList();
      continue;
    }

    const pre = /^\u0000PRE(\d+)\u0000$/.exec(trimmed);
    if (pre) {
      flushParagraph();
      closeList();
      out.push(`<pre><code>${codeBlocks[Number(pre[1])] ?? ''}</code></pre>`);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      openList(bullet ? 'ul' : 'ol');
      out.push(`<li>${(bullet ?? numbered)?.[1] ?? ''}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();

  // Code blocks that ended up inside a paragraph or list item.
  return out.join('\n').replace(PLACEHOLDER, (_match, i: string) => `<pre><code>${codeBlocks[Number(i)] ?? ''}</code></pre>`);
}
