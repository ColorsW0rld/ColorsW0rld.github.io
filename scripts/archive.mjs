import { parse } from 'parse5';
import { readFile, writeFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const attr = (node, name) => node?.attrs?.find(a => a.name === name)?.value;
const text = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(text).join('');
function* walk(node) {
  yield node;
  for (const child of node.childNodes ?? []) yield* walk(child);
}
const escape = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeTitle = title => title.normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
const key = (date, title) => `${date}:${safeTitle(title.normalize('NFKC')).replace(/\s+/g, '').toLowerCase()}`;

export function parseDate(value) {
  const clean = value.replace(/\s+/g, ' ').trim();
  let year, month, day, hour, minute = 0;
  const numeric = clean.match(/^(\d{4})(?:年|-|\/)(\d{1,2})(?:月|-|\/)(\d{1,2})日?(?:[ T]+(\d{1,2})(?::(\d{2}))?)?$/);
  if (numeric) {
    [, year, month, day, hour, minute = '0'] = numeric;
  } else {
    const english = clean.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4}),?\s+(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!english) throw new Error(`无法识别发布日期：${clean || '空白'}。请重新保存显示完整日期的原文。`);
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    month = months.indexOf(english[1].slice(0, 3).toLowerCase()) + 1;
    [, , day, year, hour, minute] = english;
    if (+hour < 1 || +hour > 12) throw new Error('发布日期的小时无效。');
    hour = (+hour % 12) + (english[6].toUpperCase() === 'PM' ? 12 : 0);
  }
  const missingHour = hour === undefined;
  [year, month, day, hour, minute] = [year, month, day, hour, minute].map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2100 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || (!missingHour && hour > 23) || minute > 59) {
    throw new Error('发布日期无效；不会用下载日期代替。');
  }
  const pad = n => String(n).padStart(2, '0');
  return { year, date: `${year}-${pad(month)}-${pad(day)}`, hour: missingHour ? '99' : pad(hour) };
}

export function metadata(html) {
  const doc = parse(html);
  const nodes = [...walk(doc)];
  const meta = name => nodes.find(n => n.tagName === 'meta' && (attr(n, 'property') === name || attr(n, 'name') === name));
  const title = (attr(meta('og:title'), 'content') || text(nodes.find(n => n.tagName === 'title') ?? {})).trim();
  if (!title || !safeTitle(title)) throw new Error('找不到文章标题，请确认保存的是文章正文。');
  const source = attr(meta('og:url'), 'content') || attr(meta('savepage-url'), 'content');
  let url;
  try { url = new URL(source); } catch { throw new Error('找不到微信原文链接，请用 Save Page WE 重新保存原文。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'mp.weixin.qq.com' || !/^\/s(?:\/|$)/.test(url.pathname)) throw new Error('文件不是微信文章存档。');
  const published = nodes.find(n => attr(n, 'id') === 'publish_time');
  const date = parseDate(published ? text(published) : '');
  const body = nodes.find(n => attr(n, 'id') === 'js_content');
  if (!body || text(body).trim().length < 10) throw new Error('正文缺失或过短，可能保存了验证页面。');
  for (const n of walk(body)) {
    if (n.tagName !== 'img') continue;
    const src = attr(n, 'src') || '';
    if (!/^data:image\//i.test(src)) throw new Error('正文有图片未保存在 HTML 中。请滚动到底，等图片加载后重新保存。');
  }
  if ([...walk(body)].some(n => ['video', 'audio', 'iframe', 'mpvoice', 'mp-common-videosnap', 'mp-common-videoplayer'].includes(n.tagName))) {
    throw new Error('正文包含音视频或嵌入内容，需人工确认并单独备份，不能当作完整单文件存档。');
  }
  return { title, source: url.href, ...date };
}

export function catalog(index) {
  const keys = new Set();
  const paths = new Set();
  for (const node of walk(parse(index))) {
    if (node.tagName !== 'a') continue;
    let href = attr(node, 'href') || '';
    try { href = decodeURIComponent(href); } catch { /* 历史路径可能含裸百分号。 */ }
    if (!href.startsWith('articles/')) continue;
    paths.add(href);
    const name = path.posix.basename(href).replace(/\.html?$/i, '');
    const prefixes = [...name.matchAll(/ColorsWorld_(\d{4})(?:年|-)(\d{1,2})(?:月|-)(\d{1,2})日?(?:[ _]+\d{1,2})?_+/g)];
    const last = prefixes.at(-1);
    if (last) {
      const date = `${last[1]}-${last[2].padStart(2, '0')}-${last[3].padStart(2, '0')}`;
      keys.add(key(date, name.slice(last.index + last[0].length)));
    } else {
      // 较早的存档仅以日期和编号命名，标题取自原有首页链接。
      const dateMatch = name.match(/(\d{4})(?:年|-)(\d{1,2})(?:月|-)(\d{1,2})日?/);
      const shortDate = name.match(/(?:^|_)(\d{1,2})月(\d{1,2})日/);
      const parts = dateMatch ? dateMatch.slice(1) : shortDate ? [href.split('/')[1], ...shortDate.slice(1)] : null;
      if (parts) keys.add(key(`${parts[0]}-${parts[1].padStart(2, '0')}-${parts[2].padStart(2, '0')}`, text(node).trim()));
    }
  }
  return { keys, paths };
}

export function addToIndex(index, article, destination) {
  const doc = parse(index, { sourceCodeLocationInfo: true });
  const headings = [...walk(doc)].filter(n => n.tagName === 'h3' && /^\d{4}$/.test(text(n).trim()));
  const heading = headings.find(n => text(n).trim() === String(article.year));
  const href = destination.split('/').map(encodeURIComponent).join('/');
  const link = `<li><a href="${escape(href)}">${escape(path.posix.basename(destination, '.html'))}</a></li>\n`;
  let position, addition;
  if (heading) {
    const siblings = heading.parentNode.childNodes;
    const next = siblings.slice(siblings.indexOf(heading) + 1).find(n => n.tagName);
    if (next?.tagName !== 'ul' || !next.sourceCodeLocation?.endTag) throw new Error('首页年份列表结构异常，请联系维护者。');
    position = next.sourceCodeLocation.endTag.startOffset;
    addition = link;
  } else {
    const before = headings.find(n => +text(n).trim() < article.year);
    const last = headings.at(-1);
    if (!last) throw new Error('首页没有年份列表，请联系维护者。');
    const siblings = last.parentNode.childNodes;
    const lastList = siblings.slice(siblings.indexOf(last) + 1).find(n => n.tagName);
    if (!before && lastList?.tagName !== 'ul') throw new Error('首页年份列表结构异常。');
    position = before ? before.sourceCodeLocation.startOffset : lastList.sourceCodeLocation.endOffset;
    addition = `\n<h3>${article.year}</h3>\n<ul>\n${link}</ul>\n`;
  }
  return index.slice(0, position) + addition + index.slice(position);
}

function filename(article) {
  let title = '';
  for (const char of safeTitle(article.title)) {
    if (Buffer.byteLength(title + char, 'utf8') > 160) break;
    title += char;
  }
  const [year, month, day] = article.date.split('-').map(Number);
  return `ColorsWorld_${year}年${month}月${day}日 ${article.hour}_${title.replace(/[. ]+$/g, '')}.html`;
}

export async function archive(root) {
  const inbox = path.join(root, 'incoming');
  const files = (await readdir(inbox, { withFileTypes: true })).filter(f => f.isFile() && /\.html?$/i.test(f.name)).map(f => f.name).sort();
  let index = await readFile(path.join(root, 'index.html'), 'utf8');
  const known = catalog(index);
  // 稀疏检出不下载旧文章，但仍须保护 Git 已跟踪且未列入首页的旧文件。
  if (existsSync(path.join(root, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'articles'], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    for (const name of tracked.split('\0').filter(Boolean)) known.paths.add(name);
  }
  const results = [];
  for (const file of files) {
    try {
      const input = path.join(inbox, file);
      const article = metadata(await readFile(input, 'utf8'));
      const identity = key(article.date, article.title);
      if (known.keys.has(identity)) {
        results.push({ file, status: 'duplicate', message: '同一发布日期和标题已在首页中；上传文件保留，请核对后删除。' });
        continue;
      }
      const destination = `articles/${article.year}/${filename(article)}`;
      const output = path.join(root, destination);
      if (known.paths.has(destination) || existsSync(output)) throw new Error('目标文件名已存在；为避免覆盖，上传文件已保留。');
      const updated = addToIndex(index, article, destination);
      await mkdir(path.dirname(output), { recursive: true });
      // 移动原文件，保留全部存档字节，不重写正文。
      await rename(input, output);
      try {
        await writeFile(path.join(root, 'index.html'), updated);
      } catch (error) {
        await rename(output, input);
        throw error;
      }
      index = updated;
      known.keys.add(identity);
      known.paths.add(destination);
      results.push({ file, status: 'archived', destination, message: `${article.date} ${article.title}` });
    } catch (error) {
      results.push({ file, status: 'failed', message: error.message });
    }
  }
  return results;
}

export function summary(results) {
  const labels = { archived: '已归档', duplicate: '重复，未导入', failed: '失败，原文件保留' };
  return '# 文章整理结果\n\n' + (results.length ? results.map(r => `- **${labels[r.status]}**：${escape(r.file)} — ${escape(r.message)}${r.destination ? `；文件：${escape(r.destination)}` : ''}`).join('\n') : '没有待处理的 HTML 文件。') + '\n\n只有后续“提交归档结果”步骤成功，归档才已保存到远端。Render 会检测该提交并发布；网站更新需要等待部署完成。\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const root = path.resolve(process.argv[2] || '.');
  try {
    const results = await archive(root);
    const report = summary(results);
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, report, { flag: 'a' });
    if (results.some(r => r.status === 'failed')) process.exitCode = 1;
  } catch (error) {
    console.error(`整理失败：${error.message}`);
    process.exitCode = 1;
  }
}
