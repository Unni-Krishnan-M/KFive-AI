import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const refractorRequire = createRequire(require.resolve('refractor/package.json'));

describe('Chat syntax highlighting dependency boundary', () => {
  it('resolves the patched Prism version through refractor, not only the root package', () => {
    expect(refractorRequire('prismjs/package.json').version).toBe('1.30.0');
  });

  it('keeps supported language highlighting as syntax-tree data', () => {
    const refractor = require('refractor');
    for (const [language, code] of [['javascript', 'const value = 3;'], ['python', 'print("hello")'], ['markup', '<script>alert(1)</script>']]) {
      const nodes = refractor.highlight(code, language);
      expect(Array.isArray(nodes)).toBe(true);
      expect(nodes.length).toBeGreaterThan(0);
      const text = (items: Array<{ type: string; value?: string; children?: unknown[] }>): string => items.map(node => node.type === 'text' ? node.value : text((node.children ?? []) as typeof items)).join('');
      expect(text(nodes)).toBe(code);
    }
  });
});
