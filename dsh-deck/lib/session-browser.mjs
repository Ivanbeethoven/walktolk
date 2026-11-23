import { fit } from './protocol.mjs';

/** The deck switches project groups with its left and right buttons. */
export class SessionPages {
  constructor(limit = 8) {
    this.limit = limit;
    this.page = 0;
    this.nav = new Map();
    this.order = [];
  }

  rows(entries, pinned = new Set()) {
    const limit = Math.max(1, Math.min(255, this.limit));
    this.nav.clear();
    const fixed = entries.filter(e => pinned.has(e.id));
    const rest = entries.filter(e => !pinned.has(e.id));
    const overflow = entries.length > limit;
    const controls = !overflow ? 0 : Math.min(2, Math.max(0, limit - fixed.length - 1));
    const size = Math.max(1, limit - controls - fixed.length);
    if (this.page) {
      const previous = new Map(this.order.map((id, i) => [id, i]));
      rest.sort((a, b) => (previous.get(a.id) ?? Infinity) - (previous.get(b.id) ?? Infinity));
    }
    this.order = rest.map(e => e.id);
    const pages = Math.ceil(rest.length / size) || 1;
    this.page = overflow && controls ? Math.min(this.page, pages - 1) : 0;
    const selected = overflow ? [...fixed, ...rest.slice(this.page * size, (this.page + 1) * size)].slice(0, limit) : entries;
    const counts = new Map();
    const currentGroups = Math.ceil(selected.filter(entry => !entry.historical).length / 6);
    const rows = selected.map(entry => {
      const section = entry.historical ? '历史会话' : '当前会话';
      const n = counts.get(section) ?? 0;
      counts.set(section, n + 1);
      const group = 1 + (entry.historical ? currentGroups : 0) + Math.floor(n / 6);
      return { ...entry, project: String(group).padStart(2, '0') + ' ' + section };
    });
    const add = (target, name, project) => {
      const id = '\u0000page/' + this.page + '/' + target;
      const item = { id, targetPage: target, name, task: name, title: '按 ENTER 翻页', project, state: 'idle' };
      this.nav.set(id, item);
      rows.push(item);
    };
    if (controls && pages > 1) {
      if (controls === 2 && this.page > 0) add(this.page - 1, '上一页', rows[0]?.project);
      if (this.page + 1 < pages) add(this.page + 1, '下一页', rows[selected.length - 1]?.project);
      else if (controls === 1) add(0, '返回首页', rows[selected.length - 1]?.project);
    }
    return rows;
  }

  turn(entry) {
    const item = this.nav.get(entry?.id);
    if (!item || item.targetPage === this.page) return false;
    this.page = item.targetPage;
    this.nav.clear();
    return true;
  }
}

export function wrapLines(text) {
  const lines = [];
  for (const part of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    let line = '', width = 0, bytes = 0;
    for (const char of part.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
      const len = Buffer.byteLength(char);
      const w = len >= 3 ? 2 : 1;
      if (line && (bytes + len > 48 || width + w > 30)) {
        lines.push(line);
        line = ''; width = 0; bytes = 0;
      }
      line += char;
      bytes += len; width += w;
    }
    lines.push(line);
  }
  return lines;
}

export function documentWindow(slot, kind, id, lines, first = 65535) {
  const total = Math.min(65535, lines.length);
  const tail = first === 65535;
  const start = tail ? Math.max(0, total - 17) : Math.max(0, Math.min(first, total - 1));
  const doc = { m: 'doc', agent: slot, d: kind, id, first: start, total, font: 'row', lines: lines.slice(start, Math.min(start + 17, total)) };
  while (doc.lines.length && Buffer.byteLength(JSON.stringify(doc)) + 1 > 1000) {
    if (tail) { doc.lines.shift(); doc.first++; } else doc.lines.pop();
  }
  return doc;
}

const states = { working: '运行中', question: '等待回答', error: '出错', ready: '空闲', idle: '未运行' };
export function statusText(entry) {
  return entry.historical ? '未运行' : (states[entry.state] ?? '空闲');
}

export function detailText(entry, kind) {
  if (kind === 'w') {
    return [entry.name, '状态 · ' + statusText(entry), entry.activity && '最近活动 · ' + entry.activity,
      entry.updatedAt && '最近更新 · ' + new Date(entry.updatedAt).toLocaleString('zh-CN', { hour12: false }),
      entry.prompt && '最近提问\n' + entry.prompt].filter(Boolean).join('\n');
  }
  return entry.answer ? '最近回复\n' + entry.answer : entry.prompt ? '最近提问\n' + entry.prompt : '暂无对话消息';
}

export function rosterTitle(entry) {
  return fit([statusText(entry), entry.activity || entry.answer || entry.prompt].filter(Boolean).join(' · '), 64);
}

function visibleText(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n').trim().slice(-16000);
}

/** Extract display text from public message blocks. Tool arguments and reasoning stay private. */
export function foldActivity(events, previous = {}) {
  const view = { ...previous };
  for (const event of events) {
    const data = event.data ?? {};
    switch (event.type) {
      case 'user/message': {
        if (data.source?.kind !== 'user') continue;
        const prompt = visibleText(data.content ?? data.message?.content);
        if (!prompt) continue;
        view.prompt = prompt;
        view.activity = prompt;
        break;
      }
      case 'assistant/message': {
        const content = data.message?.content ?? data.content;
        const answer = visibleText(content);
        const call = Array.isArray(content) && content.findLast(b => ['toolCall','tool-call','tool_use'].includes(b.type));
        if (answer) view.answer = answer;
        if (call?.name) view.activity = '调用工具 ' + call.name;
        else if (answer) view.activity = answer;
        else continue;
        break;
      }
      case 'tool/result': {
        const name = data.message?.toolName ?? data.toolName ?? data.source?.toolName;
        view.activity = (data.message?.isError ? '工具出错' : '已收到工具结果') + (name ? ' · ' + name : '');
        break;
      }
      default: continue;
    }
    if (Number.isFinite(event.time)) view.updatedAt = event.time;
  }
  return view;
}

export function listedSession(item) {
  const values = item.projections?.values ?? {};
  const turns = Array.isArray(values.turnOutline) ? values.turnOutline : [];
  const title = values.title?.title;
  const prompt = turns.at(-1)?.prompt ?? '';
  return {
    id: item.sessionId, name: title || prompt || '', prompt,
    answer: turns.findLast(turn => turn.response)?.response || '',
    state: item.running ? 'working' : item.agentAvailable ? 'ready' : 'idle',
    historical: !item.agentAvailable, updatedAt: item.updatedAt || 0,
  };
}
