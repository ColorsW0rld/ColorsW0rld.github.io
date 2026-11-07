import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { metadata, parseDate, catalog, addToIndex, archive } from './archive.mjs';

const saved = ({ title = '议题招募丨秋日会客厅：最微小的火种', date = 'Oct 31, 2026, 6:00 PM', body = '<p>这是用于测试的完整文章正文。</p><img src="data:image/png;base64,AAAA">' } = {}) => `<!doctype html><html><head><meta property="og:title" content="${title}"><meta property="og:url" content="https://mp.weixin.qq.com/s/example"></head><body><em id="publish_time">${date}</em><div id="js_content">${body}</div></body></html>`;
const index = '<html><body><h1>存档</h1><h3>2026</h3>\n<ul>\n</ul><h3>2024</h3><ul></ul></body></html>';

async function workspace(t) {
  const base = path.resolve('.tmp');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'archive-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'incoming'));
  await writeFile(path.join(root, 'index.html'), index);
  return root;
}

test('publication dates support saved English, Chinese and numeric formats', () => {
  for (const value of ['Oct 31, 2026, 6:00 PM', '2026年10月31日 18:00', '2026-10-31 18:00']) {
    assert.deepEqual(parseDate(value), { year: 2026, date: '2026-10-31', hour: '18' });
  }
  assert.equal(parseDate('Jan 1, 2026, 12:00 AM').hour, '00');
  assert.equal(parseDate('Jan 1, 2026, 12:00 PM').hour, '12');
  for (const invalid of ['', 'Unknown', '昨天', '2026-02-30 18:00', '2026年13月01日 18:00', '2026-01-01 24:00', 'Oct 31, 2026, 13:00 PM']) assert.throws(() => parseDate(invalid));
});

test('metadata reads HTML entities and requires article source, publication date and body', () => {
  assert.equal(metadata(saved({ title: 'A &amp; B &#x4e2d;' })).title, 'A & B 中');
  assert.throws(() => metadata(saved().replace('https://mp.weixin.qq.com/s/example', 'https://example.org/s/example')));
  assert.throws(() => metadata(saved({ body: '验证' })));
  assert.throws(() => metadata(saved().replace('id="publish_time"', 'id="missing"')));
});

test('missing body images and embedded media fail; decorative images outside body do not', () => {
  for (const img of ['<img data-src="https://example.org/a.jpg">', '<img src="https://example.org/a.jpg">', '<img src="">']) {
    assert.throws(() => metadata(saved({ body: `<p>这是一段足够长的文章正文。</p>${img}` })), /图片/);
  }
  assert.throws(() => metadata(saved({ body: '<p>这是一段足够长的文章正文。</p><iframe src=""></iframe>' })), /音视频/);
  assert.equal(metadata(saved().replace('</body>', '<img></body>')).year, 2026);
});

test('historical index names with Chinese dates and repeated prefixes are recognized', () => {
  const html = '<a href="articles/2024/ColorsWorld_2024年05月17日__标题.html">标题</a><a href="articles/2022/ColorsWorld_2022-01-03 12_ColorsWorld_2022-01-03 12_标题二.html">标题二</a>';
  const known = catalog(html + '<a href="articles/2015/2015-04-19_001.html">历史标题</a><a href="articles/2021/ColorsWorld_5月17日_标题三.html">标题三</a>');
  assert.equal(known.keys.size, 4);
  assert.ok(known.keys.has('2015-04-19:历史标题'));
  assert.ok(known.keys.has('2021-05-17:标题三'));
  assert.ok(known.keys.has('2024-05-17:标题'));
  assert.ok(known.keys.has('2022-01-03:标题二'));
});

test('index inserts escaped links and years while keeping old markup byte for byte', () => {
  const destination = 'articles/2026/a&b#100%.html';
  const added = addToIndex(index, { year: 2026, date: '2026-10-31', title: 'A & B < C' }, destination);
  assert.ok(added.includes('a%26b%23100%25.html'));
  assert.ok(catalog(added).paths.has(destination));
  assert.ok(added.includes('A &amp; B &lt; C'));
  assert.equal(added.replace(/<li>.*<\/li>\n/, ''), index);
  const middle = addToIndex(index, { year: 2025, date: '2025-01-01', title: '新文章' }, 'articles/2025/new.html');
  assert.ok(middle.indexOf('<h3>2025') < middle.indexOf('<h3>2024'));
  const newest = addToIndex(index, { year: 2027, date: '2027-01-01', title: '新文章' }, 'articles/2027/new.html');
  assert.ok(newest.indexOf('<h3>2027') < newest.indexOf('<h3>2026'));
  assert.ok(addToIndex(index, { year: 2023, date: '2023-01-01', title: '新文章' }, 'articles/2023/new.html').includes('<h3>2023</h3>'));
});

test('batch preserves original bytes, keeps failed files, and repeated runs add no duplicate links', async t => {
  const root = await workspace(t);
  const original = Buffer.from('\ufeff' + saved());
  await writeFile(path.join(root, 'incoming', '原始下载文件.html'), original);
  await writeFile(path.join(root, 'incoming', '验证页面.html'), '<p>请验证</p>');
  const results = await archive(root);
  const success = results.find(r => r.status === 'archived');
  assert.ok(success.destination.startsWith('articles/2026/ColorsWorld_2026-10-31 18_'));
  assert.deepEqual(await readFile(path.join(root, success.destination)), original);
  assert.equal(results.filter(r => r.status === 'failed').length, 1);
  await writeFile(path.join(root, 'incoming', '重复下载.html'), original);
  const second = await archive(root);
  assert.equal(second.filter(r => r.status === 'duplicate').length, 1);
  assert.equal((await readFile(path.join(root, 'index.html'), 'utf8')).match(/<li>/g).length, 1);
  assert.deepEqual((await readdir(path.join(root, 'incoming'))).sort(), ['重复下载.html', '验证页面.html'].sort());
});

test('filename collision does not overwrite existing files', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'articles', '2026');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'ColorsWorld_2026-10-31 18_测试.html');
  await writeFile(output, 'existing');
  await writeFile(path.join(root, 'incoming', 'new.html'), saved({ title: '测试' }));
  assert.equal((await archive(root))[0].status, 'failed');
  assert.equal(await readFile(output, 'utf8'), 'existing');
});

test('tracked files omitted by sparse checkout remain protected', async t => {
  const root = await workspace(t);
  const directory = path.join(root, 'articles', '2026');
  await mkdir(directory, { recursive: true });
  const output = path.join(directory, 'ColorsWorld_2026-10-31 18_测试.html');
  await writeFile(output, 'existing');
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', 'articles'], { cwd: root });
  await rm(output);
  await writeFile(path.join(root, 'incoming', 'new.html'), saved({ title: '测试' }));
  assert.equal((await archive(root))[0].status, 'failed');
});
