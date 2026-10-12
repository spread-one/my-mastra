import { describe, expect, it } from 'vitest';
import { formatSlack } from './format.js';
const texts = (text: string, secrets: string[] = []) => formatSlack(text, secrets).blocks.flatMap(b => b.type === 'divider' ? [] : [b.text.text]);

describe('synthetic Korean meeting summary (not real Slack E2E)', () => {
  it('renders headings, divider, lists, emphasis, tables, newlines and literal code', () => {
    const source = '## 주간 회의 요약\n\n### 결정 사항\n- **출시**합니다\n- *검토* 및 __담당__ 지정, ~~취소~~\n> 다음 주 확인\n---\n| 안건 | 담당 | 기한 |\n|---|---|---|\n| 검색 개선 | 민수 | 금요일 |\n\n`**literal**`\n```ts\n## 제목 아님\n**literal** <@U1>\n```';
    const output = formatSlack(source); const rendered = texts(source).join('\n');
    expect(output.blocks[0]).toMatchObject({ type: 'header', text: { text: '주간 회의 요약' } });
    expect(output.blocks.some(b => b.type === 'divider')).toBe(true);
    expect(rendered).toContain('• *출시* 합니다');
    expect(rendered).toContain('_검토_ 및 *담당* 지정, ~취소~');
    expect(rendered).toContain('> 다음 주 확인');
    expect(output.text).toContain('❯ 다음 주 확인');
    for (const cell of ['안건: 검색 개선', '담당: 민수', '기한: 금요일']) {
      expect(rendered).toContain(cell); expect(output.text).toContain(cell);
    }
    expect(rendered).toContain('`**literal**`');
    expect(rendered).toContain('```\n## 제목 아님\n**literal** &lt;@U1&gt;\n```');
    expect(output.text).not.toContain('## 주간');
    expect(output.text).toContain('## 제목 아님');
  });
  it('supports h1-h6 and long headings without truncation', () => {
    for (let n = 1; n <= 6; n++) expect(formatSlack(`${'#'.repeat(n)} 제목`).blocks[0]?.type).toBe('header');
    const heading = '제목😀'.repeat(100);
    expect(texts(`## ${heading}`).join('').replace(/\*/gu, '')).toBe(heading);
  });
  it('packs 60 table rows with intro/footer, retaining all cells and card boundaries', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| 안건${i} | 담당${i} | 기한${i} |`);
    const source = `## 회의\n소개 **내용**\n\n두 번째 문단\n\n| 안건 | 담당 | 기한 |\n|---|---|---|\n${rows.join('\n')}\n\n마무리 **확인**\n---\n## 다음 회의`;
    const result = formatSlack(source);
    expect(result.blocks.length).toBeLessThanOrEqual(40);
    const rendered = result.blocks.filter(b => b.type === 'section').map(b => b.text.text).join('');
    expect(rendered).toContain('소개 *내용*\n\n두 번째 문단\n\n• 안건: 안건0');
    expect(rendered).toContain('기한: 기한0\n\n• 안건: 안건1');
    expect(rendered).toContain('기한: 기한59\n\n마무리 *확인*');
    expect(result.blocks[0]?.type).toBe('header');
    expect(result.blocks.at(-2)?.type).toBe('divider');
    expect(result.blocks.at(-1)?.type).toBe('header');
    for (let i = 0; i < 60; i++) {
      const card = `• 안건: 안건${i}\n  담당: 담당${i}\n  기한: 기한${i}`;
      expect(result.blocks.some(b => b.type === 'section' && b.text.text.includes(card))).toBe(true);
      for (const column of ['안건', '담당', '기한']) {
        expect(rendered).toContain(`${column}: ${column}${i}`);
        expect(result.text).toContain(`${column}: ${column}${i}`);
      }
    }
    for (const block of result.blocks) if (block.type === 'section') expect(block.text.text.length).toBeLessThanOrEqual(2_800);
  });
  it('retains multiple blank lines when packing adjacent paragraphs', () => {
    const result = formatSlack('첫 문단\n\n\n**둘째 문단**\n\n마지막 문단');
    expect(result.blocks).toHaveLength(1);
    expect(texts('첫 문단\n\n\n**둘째 문단**\n\n마지막 문단').join('')).toBe('첫 문단\n\n\n*둘째 문단*\n\n마지막 문단');
    expect(result.text).toBe('첫 문단\n\n\n둘째 문단\n\n마지막 문단');
  });
  it('renders empty fences harmlessly and retains sanitized language info', () => {
    for (const source of ['```', '```\n```', '~~~\n~~~']) expect(texts(source).join('')).toBe('(빈 코드 블록)');
    const result = formatSlack('```ts <@U1> &lt;\n```');
    expect(result.text).toBe('ts &lt;@U1&gt; &amp;lt;\n(빈 코드 블록)');
    expect(texts('```ts <@U1> &lt;\n```').join('')).toContain('ts &lt;@U1&gt; &amp;lt;\n\n(빈 코드 블록)');
  });
  it('leaves intraword underscore identifiers literal and tests CJK bold boundaries synthetically', () => {
    expect(texts('foo_bar_baz foo__bar__baz _italic_ __bold__').join('')).toBe('foo_bar_baz foo__bar__baz _italic_ *bold*');
    expect(texts('앞**강조**뒤').join('')).toBe('앞 *강조* 뒤');
    expect(texts('前**強調**後').join('')).toBe('前 *強調* 後');
    expect(formatSlack('앞**강조**뒤').text).toBe('앞강조뒤');
    expect(texts('`앞**강조**뒤`').join('')).toBe('`앞**강조**뒤`');
  });
  it('retains every column, including empty, extra and escaped-pipe cells', () => {
    const result = formatSlack('| 항목 | 값 |\n|---|---|\n| 이름 | 테스트 |\n| a\\|b | | 추가 |');
    for (const value of ['항목: 이름', '값: 테스트', '항목: a|b', '값: ', '열 3: 추가']) expect(result.text).toContain(value);
  });
  it('preserves unusual code delimiters and unterminated fences readably', () => {
    expect(texts('```literal```').join('')).toBe('`literal`');
    expect(texts('``❯ **literal**``').join('')).toBe('`❯ **literal**`');
    const source = '~~~~\n```literal```\n**literal**\n~~~~';
    const result = formatSlack(source);
    expect(result.blocks[0]).toMatchObject({ type: 'section', text: { type: 'plain_text', text: '```literal```\n**literal**' } });
    expect(texts('```\n## literal\n**literal**').join('')).toBe('```\n## literal\n**literal**\n```');
  });
  it('handles multiline emphasis without rewriting inline code', () => {
    expect(texts('**첫 줄\n둘째 줄**야 *italic* ~~strike~~ `*literal*`').join('')).toBe('*첫 줄\n둘째 줄* 야 _italic_ ~strike~ `*literal*`');
  });
});

describe('untrusted model payload safety', () => {
  it('escapes controls and entities everywhere, and redacts before rendering', () => {
    const attack = '<@U1> <#C1> <!here> <!everyone> <!subteam^S1> <https://evil.example|click> &lt;!everyone&gt; SECRET xoxb-token';
    const tableAttack = attack.replace(/\|/gu, '\\|');
    const output = formatSlack(`## ${attack}\n\n${attack}\n\n| ${tableAttack} | 値 |\n|---|---|\n| ${tableAttack} | ${tableAttack} |\n\n\`${attack}\`\n\`\`\`\n${attack}\n\`\`\``, ['SECRET']);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toMatch(/SECRET|xoxb-token/u);
    expect(output.text).not.toMatch(/<[@#!]|<https:\/\/evil/u);
    for (const block of output.blocks) if (block.type === 'section' && block.text.type === 'mrkdwn') expect(block.text.text).not.toMatch(/<[@#!]|<https:\/\/evil/u);
    expect(serialized).toContain('• &lt;@U1&gt;');
    expect(serialized).toContain('&amp;lt;!everyone&amp;gt;');
    expect(output).toMatchObject({ mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
  });
  it('keeps literal plain payloads raw, escaping only mrkdwn and accessible fallback', () => {
    const literal = 'R&D <tag> &lt; <@U1> <!everyone> <#C1>';
    const header = formatSlack(`## ${literal}`);
    expect(header.blocks[0]).toEqual({ type: 'header', text: { type: 'plain_text', text: literal, emoji: false } });
    expect(header.text).toBe('R&amp;D &lt;tag&gt; &amp;lt; &lt;@U1&gt; &lt;!everyone&gt; &lt;#C1&gt;');
    const code = formatSlack(`~~~~\n${literal}\n\`\`\`\n~~~~`);
    expect(code.blocks[0]).toEqual({ type: 'section', text: { type: 'plain_text', text: literal + '\n```' } });
    expect(code.text).toBe(header.text + '\n```');
    const mrkdwn = formatSlack(`\`${literal}\`\n[${literal}](https://example.com/?x=1&y=2)`);
    for (const block of mrkdwn.blocks) if (block.type === 'section' && block.text.type === 'mrkdwn') {
      expect(block.text.text).not.toMatch(/<[@#!]/u);
      expect(block.text.text).toContain('&amp;lt;');
    }
    expect(mrkdwn.text).not.toMatch(/<[@#!]/u);
    expect(mrkdwn.text).toContain('&amp;lt;');
    expect(mrkdwn).toMatchObject({ mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    const link = texts('[R&D <tag> &lt;](https://example.com/?x=1&y=2)').join('');
    expect(link).toBe('<https://example.com/?x=1&amp;y=2|R&amp;D &lt;tag&gt; &amp;lt;>');
  });
  it('generates only validated http(s) labeled links, keeps rejected links readable', () => {
    const source = '[문서](https://example.com/a?q=1&b=2) [bad](javascript:alert) [local](http://127.0.0.1) [trailing](http://localhost.) [ipv6](http://[::1]) [auth](https://user:pass@example.com) [pipe|label](https://example.com) [inject](https://example.com/<!here>)';
    const rendered = texts(source).join('');
    expect(rendered).toContain('<https://example.com/a?q=1&amp;b=2|문서>');
    expect(rendered.match(/<https?:[^>]+>/gu)).toHaveLength(1);
    expect(rendered).toContain('bad (javascript:alert)');
    expect(rendered).not.toContain('<!here>');
    expect(formatSlack(source).text).toContain('문서 (https://example.com/a?q=1&amp;b=2)');
  });
});

describe('strict transformed limits and lossless Unicode splitting', () => {
  it.each(['한😀'.repeat(2_000), '**' + '한😀'.repeat(2_000) + '**', '`' + '한😀'.repeat(2_000) + '`', '```js\n' + '한😀'.repeat(2_000) + '\n```', '~~~\n' + '한😀'.repeat(2_000)])('splits long single lines and balanced code without dropping codepoints %#', source => {
    const result = formatSlack(source); const rendered = texts(source).join('');
    // Balanced wrappers can fall between codepoints, but no codepoint is lost.
    expect(rendered.match(/한/gu)).toHaveLength(2_000);
    expect(rendered.match(/😀/gu)).toHaveLength(2_000);
    for (const block of result.blocks) {
      if (block.type === 'divider') continue;
      expect(block.text.text.length).toBeLessThanOrEqual(2_800);
      expect(block.text.text).not.toMatch(/[\uD800-\uDBFF]$/u);
      if (block.text.text.startsWith('```')) expect(block.text.text.endsWith('```')).toBe(true);
    }
  });
  it('accounts raw plain-text and escaped output lengths separately with safe Unicode splits', () => {
    const heading = '&'.repeat(150);
    expect(formatSlack(`## ${heading}`).blocks[0]).toMatchObject({ type: 'header', text: { text: heading } });
    const literal = 'R&D <tag> &lt; <@U1> <!everyone> 한😀'.repeat(150) + '\n```';
    const result = formatSlack('~~~~\n' + literal + '\n~~~~');
    expect(result.blocks.flatMap(b => b.type === 'section' ? [b.text.text] : []).join('')).toBe(literal);
    for (const block of result.blocks) if (block.type === 'section') {
      expect(block.text.type).toBe('plain_text');
      expect(block.text.text.length).toBeLessThanOrEqual(2_800);
      expect(block.text.text).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
    // Raw plain payload fits, but its escaped accessible answer exceeds byte budget.
    expect(() => formatSlack('~~~~\n' + '&'.repeat(8_000) + '\n```\n~~~~')).toThrow('SLACK_OUTPUT_LIMIT');
    // Packing does not waive conversion expansion limits.
    expect(() => formatSlack(Array(100).fill('&'.repeat(41)).join('\n\n'))).toThrow('SLACK_OUTPUT_LIMIT');
  });
  it('does not split escaped entities or labeled-link controls', () => {
    const result = texts('x'.repeat(2_797) + '< [문서](https://example.com)');
    expect(result.join('')).toContain('&lt;');
    expect(result.some(text => text.includes('<https://example.com/|문서>'))).toBe(true);
    for (const text of result) expect(text).not.toMatch(/&(?:a|am|l|g)?$/u);
  });
  it.each(['', 'x'.repeat(20_001), '한'.repeat(13_334), '&'.repeat(4_001), Array(41).fill('## 제목').join('\n'), '| ' + '항목'.repeat(1_000) + ' | 값 |\n|---|---|\n' + Array(10).fill('| 짧음 | 값 |').join('\n')])('rejects rather than truncates source/expansion/block limits %#', source => {
    expect(() => formatSlack(source)).toThrow('SLACK_OUTPUT_LIMIT');
  });
});
