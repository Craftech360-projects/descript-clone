import test from 'node:test';
import assert from 'node:assert/strict';

import { htmlToText } from './read-page.ts';

test('the title is read, and entities in it decoded', () => {
  const r = htmlToText('<html><head><title>Ben &amp; Jerry</title></head><body>hi</body></html>');
  assert.equal(r.title, 'Ben & Jerry');
});

/**
 * Script and style contents are not prose and would otherwise dominate a page's
 * word count — a site with an inline analytics blob would come back as mostly
 * JavaScript, which is the reading equivalent of noise.
 */
test('script, style and svg contents never reach the text', () => {
  const html = `<body><script>var secret = "TRACKER";</script><style>.a{color:red}</style><svg><path d="M0 0"/></svg><p>Real words.</p></body>`;
  const { text } = htmlToText(html);
  assert.ok(text.includes('Real words.'));
  assert.ok(!text.includes('TRACKER'));
  assert.ok(!text.includes('color:red'));
  assert.ok(!text.includes('M0 0'));
});

test('block tags become breaks, so headings do not run into the next sentence', () => {
  const { text } = htmlToText('<h1>Title</h1><p>Body.</p><li>One</li><li>Two</li>');
  assert.ok(/Title\s*\n/.test(text), 'a heading ends a line');
  assert.ok(text.includes('One'));
  assert.ok(text.includes('Two'));
  assert.ok(!/TitleBody/.test(text), 'words must not be fused across tags');
});

test('entities are decoded rather than left as noise', () => {
  const { text } = htmlToText('<p>Fish &amp; chips &lt;are&gt; &quot;good&quot; &#39;here&#39;</p>');
  assert.ok(text.includes('Fish & chips'));
  assert.ok(text.includes('<are>'));
  assert.ok(text.includes('"good"'));
  assert.ok(text.includes("'here'"));
});

test('runs of whitespace collapse, because HTML is full of them', () => {
  const { text } = htmlToText('<p>a       b</p>\n\n\n\n<p>c</p>');
  assert.ok(!/ {2}/.test(text), 'no double spaces');
  assert.ok(!/\n{3}/.test(text), 'no triple newlines');
});

test('a page with no title is not an error', () => {
  const r = htmlToText('<body><p>Words.</p></body>');
  assert.equal(r.title, '');
  assert.ok(r.text.includes('Words.'));
});

test('an empty document yields empty text rather than throwing', () => {
  assert.equal(htmlToText('').text, '');
});
