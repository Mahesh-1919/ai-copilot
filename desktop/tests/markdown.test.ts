import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/renderer/lib/markdown';

describe('renderMarkdown', () => {
  it('escapes HTML from model output', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)>')).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('renders fenced code without applying inline rules inside it', () => {
    const html = renderMarkdown('Intro\n\n```python\nx = a * b * c\nprint(**kw)\n```');
    expect(html).toBe('<p>Intro</p>\n<pre><code>x = a * b * c\nprint(**kw)</code></pre>');
  });

  it('renders lists, bold, italics and inline code', () => {
    const html = renderMarkdown('- **Bold** item\n- *em* and `code`\n\n1. first\n2. second');
    expect(html).toBe(
      '<ul>\n<li><strong>Bold</strong> item</li>\n<li><em>em</em> and <code>code</code></li>\n</ul>\n<ol>\n<li>first</li>\n<li>second</li>\n</ol>',
    );
  });

  it('handles an unterminated code fence while streaming', () => {
    expect(renderMarkdown('```js\nconst a = 1;')).toBe('<p>```js const a = 1;</p>');
  });
});
