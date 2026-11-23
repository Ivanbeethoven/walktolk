/**
 * dsh-deck 闂?the OpenWalkieTalkie deck as a DeepSeek Harness peripheral.
 *
 * The deck (https://github.com/conol-ai/openwalkietalkie) is a handheld with a
 * 480x480 screen, a wheel and six buttons. It speaks a small JSON protocol on
 * HID channel 5: a roster of up to eight agents, one card per agent, and events
 * for the keys. This plugin makes it the harness's own status board:
 *
 *   - every live agent becomes a roster row;
 *   - an `ask_user_question` or an approval becomes a card with the options as
 *     choices;
 *   - the button the user presses comes back as the answer to that request.
 *
 * Everything hardware-shaped lives in `transport/`; everything DSH-shaped lives
 * in `roster.mjs` and the two waterfall listeners below; `link.mjs` and
 * `protocol.mjs` are the wire.
 *
 * @module dsh-deck
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardBoard, approvalCard, questionCard } from './answerer.mjs';
import { askOnBoth } from './phone-answer.mjs';
import { FULL } from './caps.mjs';
import { DeckLink } from './link.mjs';
import { Roster, readAgent } from './roster.mjs';
import { detailText, documentWindow, foldActivity, listedSession, rosterTitle, SessionPages, statusText, wrapLines } from './session-browser.mjs';
import { fit } from './protocol.mjs';
import { openDeck } from './transport/hid-win.mjs';
import { remotePort } from './transport/remote.mjs';
import { FakeDeck } from './transport/sim.mjs';
import { DeckVoice } from './voice.mjs';

/** Cordis plugin name. */
export const name = 'deck';

/**
 * Append one line to the plugin's own trace file under the OS temp directory.
 *
 * Unconditional, and called at import time: when the harness refuses to load
 * this module at all, the absence of the file is the only evidence there is.
 *
 * @param {string} message
 */
function trace(message) {
  try {
    appendFileSync(join(tmpdir(), 'dsh-deck.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Never let logging break loading.
  }
}

trace('module imported');

/**
 * Services the plugin uses, but not as a hard dependency.
 *
 * A declared `inject` list makes Cordis hold `apply()` until every named
 * service is present 闂?and a service this profile happens not to mount leaves
 * the plugin silently pending forever: imported, never applied, no error. The
 * deck does not need those services to be useful (it connects, shows a roster
 * of nothing and takes cards), so each one is attached from inside `apply` when
 * it becomes available instead.
 */
export const inject = [];

/** How long to wait before reopening a deck that went away. */
const REOPEN_MS = 2000;

/**
 * A shallow, safe description of a Cordis request payload.
 *
 * Never `JSON.stringify` a request: it carries scoped proxies whose getters
 * throw ("cannot get property toJSON without inject"), and a logging line that
 * throws inside an answerer fails the whole question closed.
 *
 * @param {any} request
 * @returns {string}
 */
function describe(request) {
  try {
    if (!request || typeof request !== 'object') return String(request);
    const list = Array.isArray(request.questions) ? request.questions : [];
    const first = list[0] ?? {};
    const options = Array.isArray(first.options) ? first.options : [];
    return JSON.stringify({
      keys: Object.keys(request),
      questions: list.length,
      questionKeys: Object.keys(first),
      options: options.length,
      optionKeys: options[0] && typeof options[0] === 'object' ? Object.keys(options[0]) : [],
      multi: first.multi_select ?? null,
      text: String(first.question ?? '').slice(0, 60),
    });
  } catch (error) {
    return `<unreadable: ${error?.message ?? error}>`;
  }
}

/**
 * A HID port that survives the deck going away and coming back.
 *
 * A handle dies for good when the device re-enumerates 闂?unplugging it, another
 * host closing it, a reset 闂?and `WriteFile` then answers
 * ERROR_DEVICE_NOT_CONNECTED forever. Opening once and hoping is what left the
 * plugin writing into a dead handle every five seconds, so the port reopens
 * itself and reports nothing while the device is away.
 *
 * @param {{ devicePath: string }} config
 * @param {(message: string) => void} log
 * @returns {{ start: (onReport: (report: Uint8Array|null) => void) => Promise<void>,
 *             write: (report: Uint8Array) => Promise<void>,
 *             stop: () => Promise<void> }}
 */
function hidPort(config, log) {
  let current = null;
  let onReport = null;
  let reopening = false;
  let stopped = false;

  const schedule = () => {
    if (reopening || stopped) return;
    reopening = true;
    setTimeout(() => {
      reopening = false;
      if (stopped) return;
      open().catch((error) => {
        log(`deck reopen failed: ${error?.message ?? error}`);
        schedule();
      });
    }, REOPEN_MS).unref?.();
  };

  const open = async () => {
    if (stopped || current) return current;
    const device = await openDeck({ path: config.devicePath || undefined, log });
    current = device;
    await device.start((report) => {
      if (report) {
        onReport?.(report);
        return;
      }
      const dead = current;
      current = null;
      log('deck gone; reopening');
      dead?.stop().catch(() => {});
      schedule();
    });
    log(`deck opened at ${device.path}`);
    return device;
  };

  return {
    async start(handler) {
      onReport = handler;
      try {
        await open();
      } catch (error) {
        log(`deck unavailable: ${error?.message ?? error}`);
        schedule();
      }
    },
    async write(report) {
      if (!current) {
        await open().catch(() => {});
        if (!current) return;
      }
      try {
        await current.write(report);
      } catch (error) {
        log(`deck write failed: ${error?.message ?? error}`);
        const dead = current;
        current = null;
        dead?.stop().catch(() => {});
        schedule();
      }
    },
    async stop() {
      stopped = true;
      const device = current;
      current = null;
      await device?.stop?.().catch(() => {});
    },
  };
}

/** Defaults, applied by `resolveConfig`. No `Config` export: the loader must
 *  not validate a plugin row's config against a schema this package does not
 *  ship, and a profile row may then simply name the plugin. */
/**
 * @param {Partial<{ transport: string, agentLimit: number, devicePath: string, log: boolean }>} [config]
 * @returns {{ transport: 'hid'|'sim', agentLimit: number, devicePath: string, log: boolean }}
 */
export function resolveConfig(config = {}) {
  const transport = ['sim', 'remote'].includes(config.transport) ? config.transport : 'hid';
  const limit = Number(config.agentLimit ?? 255);
  return {
    transport,
    agentLimit: Number.isFinite(limit) ? Math.max(1, Math.min(Math.trunc(limit), 255)) : 255,
    devicePath: String(config.devicePath ?? ''),
    log: config.log === true,
    autoAnswer: Number.isFinite(config.autoAnswer) ? Math.max(0, Number(config.autoAnswer)) : 0,
  };
}

/**
 * Cordis plugin entry.
 * @param {any} ctx plugin context.
 * @param {Partial<typeof Config>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  // Tagged so two instances of this plugin (a reload that did not dispose the
  // first) are visible in the log instead of looking like one flapping link.
  const instance = Math.random().toString(36).slice(2, 8);
  trace(`apply() entered (instance ${instance})`);
  const config = resolveConfig(rawConfig);
  const log = (message) => {
    // Unconditional: this file is the only window into a plugin that the host
    // loads silently. ctx.logger is the noisy one and stays opt-in.
    trace(`[deck] ${message}`);
    if (config.log) ctx.logger?.info?.(`[deck] ${message}`);
  };

  /** Agents currently blocked on one of our cards, for the roster state. */
  const waiting = new Map();
  const waitingIds = () => new Set(waiting.values());
  const pages = new SessionPages();
  let controller, query, workspaces, catalog = new Map(), visible = new Map();
  let loadingList = false, listAgain = false, disposed = false, selected, document, revision = 0;
  let kind = 'r', firstLine = 65535;
  let windowRequest = 0;
  const archivedDetails = new Map(), liveDetails = new WeakMap(), recordings = new Map(), readingKinds = new Map();
  const nextRevision = () => revision = revision % 65535 + 1;

  const deck = config.transport === 'sim' ? new FakeDeck({ autoAnswer: config.autoAnswer }) : null;
  let link = null;
  let roster = null;
  let board = null;

  const send = (message, isCurrent) => link?.send(message, isCurrent) ?? Promise.resolve();

  roster = new Roster(send, { limit: config.agentLimit, caps: () => link.caps ?? FULL });
  board = new CardBoard({
    send,
    isReady: () => link?.ready === true,
    slotFor: (agentId) => roster.slotOf(agentId),
    // A card needs a slot the deck already draws; allocate one for an agent the
    // roster has not shown yet rather than failing with `err range`.
    ensureSlot: (agentId) => {
      const known = roster.slotOf(agentId);
      if (known && roster.shown.has(known)) return known;
      refresh();
      const entry = visible.get(String(agentId));
      return roster.ensureSlot(agentId, entry?.name ?? 'agent');
    },
    caps: () => link.caps ?? FULL,
  });

  /**
   * The live agents service, once this profile mounts it.
   *
   * Read through a soft reference rather than a declared injection: a missing
   * service must cost the roster, not the whole plugin.
   *
   * @type {{ list?: () => any[] } | null}
   */
  let agentsService = null;

  /**
   * The session-title service, once this profile mounts it.
   *
   * `session-83e7bebc-f98d-45` is what an agent looks like without it, and it is
   * the worst thing to put on a 24-byte row: the user named that conversation,
   * so the row should show that name.
   *
   * @type {{ get?: (session: any) => { title?: string } | undefined } | null}
   */
  let titlesService = null;

  /** The title of one agent's session, or an empty string. */
  const sessionTitle = (agent) => {
    try {
      const session = agent?.session;
      if (!session || !titlesService?.get) return '';
      return String(titlesService.get(session)?.title ?? '');
    } catch {
      // A title is decoration: never let it cost the roster.
      return '';
    }
  };

  /** Merge the visible desktop catalog with currently attached agents. */
  const snapshot = () => {
    let live = [];
    try {
      live = agentsService?.list?.() ?? [];
    } catch (error) {
      // A cordis context throws on an undeclared property, so every read of a
      // service goes through a guard rather than a `?.`.
      trace(`agents list failed: ${error?.message ?? error}`);
    }
    const hidden = new Set(workspaces?.archivedSessionIds ?? []);
    const entries = new Map();
    for (const [id, entry] of catalog) {
      if (!hidden.has(id)) entries.set(id, { ...entry, ...archivedDetails.get(id),
        ...(agentsService ? { historical: true, state: 'idle' } : {}) });
    }
    for (const agent of live) {
      const entry = readAgent(agent, { waiting: (id) => waitingIds().has(id) });
      if (!entry || hidden.has(entry.id)) continue;
      archivedDetails.delete(entry.id);
      const session = agent.session;
      let info = {};
      if (session?.snapshotEvents) {
        const old = liveDetails.get(session);
        if (!old || old.seq !== session.seq) {
          const offset = old && old.seq <= session.seq ? old.seq : Math.max(0, Number(session.seq || 0) - 160);
          const view = foldActivity(session.snapshotEvents(offset), old?.view);
          liveDetails.set(session, { seq: session.seq, view });
        }
        info = liveDetails.get(session).view;
      }
      const saved = entries.get(entry.id);
      entries.set(entry.id, { ...saved, ...entry, ...info, historical: false,
        name: sessionTitle(agent) || saved?.name || info.prompt || entry.name,
        updatedAt: info.updatedAt || saved?.updatedAt || 0 });
    }
    const priority = { question: 0, error: 1, working: 2, ready: 3, idle: 4 };
    return [...entries.values()].sort((a, b) => (priority[a.state] - priority[b.state]) || b.updatedAt - a.updatedAt);
  };

  function renderDetail(force = false) {
    const entry = visible.get(selected);
    const slot = roster.slotOf(selected);
    if (!entry || !slot || !roster.shown.has(slot) || entry.targetPage !== undefined || !link?.caps?.sessionDetails) return;
    const text = detailText(entry, kind);
    if (!force && document?.owner === selected && document.kind === kind && document.text === text) return;
    const same = document?.owner === selected && document.kind === kind && document.text === text;
    if (!same) document = { owner: selected, kind, text, id: nextRevision(), lines: wrapLines(text) };
    const doc = document;
    send({ m: 'reply', agent: slot, text: fit(entry.answer || entry.activity || entry.prompt || statusText(entry), 190), rev: doc.id },
      () => document === doc && selected === doc.owner);
    sendWindow(slot, firstLine);
  }

  function sendWindow(slot, first) {
    const doc = document;
    const request = ++windowRequest;
    send(documentWindow(slot, doc.kind, doc.id, doc.lines, first),
      () => document === doc && selected === doc.owner && request === windowRequest);
  }

  let drawTimer, nextDrawAt = 0;
  const refresh = () => {
    try {
      if (!link?.caps || disposed) return;
      if (drawTimer) return;
      const delay = nextDrawAt - Date.now();
      if (delay > 0) {
        drawTimer = setTimeout(() => { drawTimer = undefined; refresh(); }, delay);
        return;
      }
      pages.limit = Math.min(link?.caps?.slots ?? 8, config.agentLimit);
      const entries = snapshot();
      const pins = new Set([...waiting.values(), ...recordings.values()]);
      if (selected) pins.add(selected);
      const rows = pages.rows(entries, pins);
      visible = new Map(rows.map(row => [row.id, row]));
      for (const row of rows) {
        if (row.targetPage !== undefined) continue;
        row.name ||= row.fallbackName || '未命名会话';
        row.task = row.name;
        row.title = rosterTitle(row);
      }
      const pending = roster.update(rows, { paged: true, budget: config.transport === 'remote' ? 2 : Infinity });
      if (config.transport === 'remote') nextDrawAt = Date.now() + 750;
      if (pending) drawTimer = setTimeout(() => { drawTimer = undefined; refresh(); }, 760);
      renderDetail();
    } catch (error) {
      log(`roster update failed: ${error?.message ?? error}`);
    }
  };

  async function updateCatalog() {
    if (!controller || disposed) return;
    if (loadingList) { listAgain = true; return; }
    loadingList = true;
    try {
      const { items } = await controller.list({});
      if (disposed) return;
      const next = new Map();
      for (const item of items) {
        if (!item.sessionId || item.blank && !item.agentAvailable) continue;
        const entry = listedSession(item);
        const lastModel = item.projections?.values?.modelSelection?.lastUsed;
        if (typeof lastModel?.model === 'string') {
          entry.model = lastModel.model;
          entry.effort = lastModel.reasoningEffort;
        }
        if ((catalog.get(entry.id)?.updatedAt ?? 0) < entry.updatedAt) archivedDetails.delete(entry.id);
        if (!entry.name) {
          const folder = item.cwd?.split(/[\\/]/).filter(Boolean).pop();
          const date = entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString('zh-CN') : '';
          entry.fallbackName = [folder || '未命名会话', date].filter(Boolean).join(' · ');
        }
        next.set(item.sessionId, entry);
      }
      const oldCount = catalog.size;
      catalog = next;
      for (const id of archivedDetails.keys()) if (!next.has(id)) archivedDetails.delete(id);
      if (oldCount !== next.size) log('session catalog: ' + next.size + ' entries');
      refresh();
    } catch (error) { log('session catalog unavailable: ' + error.message); }
    finally { loadingList = false; if (listAgain) { listAgain = false; void updateCatalog(); } }
  }

  async function openDetails(id) {
    const entry = visible.get(id);
    if (!entry || !query || !entry.historical) return;
    try {
      const surface = await query.readSurface(id);
      if (disposed || selected !== id || !visible.get(id)?.historical) return;
      const detail = foldActivity(surface.events ?? []);
      if (!catalog.get(id)?.name && detail.prompt) detail.name = detail.prompt;
      archivedDetails.set(id, detail);
      refresh();
    } catch (error) { log('session history unavailable: ' + error.message); }
  }

  const transport = config.transport === 'sim'
    ? {
      start: (onReport) => deck.start(onReport),
      write: (report) => deck.write(report),
      stop: () => deck.stop(),
    }
    : config.transport === 'remote' ? remotePort(ctx, log) : hidPort(config, log);

  link = new DeckLink(
    transport,
    {
      sync: () => {
        clearTimeout(drawTimer); drawTimer = undefined; nextDrawAt = 0;
        roster.reset();
        document = null;
        // The rows are pushed by `refresh()` as ordinary messages instead of
        // being returned here, so a sync never interleaves with the roster's
        // own sends: fragments of one line must not mix with another.
        refresh();
        return [];
      },
    },
  );

  // Device events.
  link.on('answer', (message) => {
    if (!board.answer(message.agent, message.card, message.choice)) return;
    log(`answer: agent ${message.agent} card ${message.card} choice ${message.choice}`);
  });

  // ---- push to talk ----------------------------------------------------------
  //
  // The button by itself only opens the LISTENING overlay. The words need a host
  // that listens on channel 7, decodes what arrives and answers with one
  // `transcript` line 鈥?without it the deck sits on "transcribing" for ever.
  let speechService = null;

  /** The live agent whose roster slot is `slot`, if any. */
  const agentForSlot = (slot) => {
    try {
      for (const agent of agentsService?.list?.() ?? []) {
        if (roster.slotOf(agent.id ?? agent.agentId) === slot) return agent;
      }
    } catch {
      // A roster miss only costs the follow-up.
    }
    return null;
  };

  const voice = new DeckVoice({
    sendRaw: (channel, payload) => link.sendRaw(channel, payload),
    send: (message) => link.send(message),
    transcribe: async (audio, signal) => {
      if (!speechService) {
        trace('voice: no speech-to-text service in this profile');
        return '';
      }
      const spec = speechService.resolve({ audio });
      const result = await speechService.transcribe(spec, signal);
      return String(result?.text ?? '').trim();
    },
    onText: (slot, text, press) => {
      const agent = press?.sessionId
        ? agentsService?.get?.(press.sessionId) ?? agentsService?.list?.().find(item => (item.id ?? item.agentId) === press.sessionId)
        : agentForSlot(slot);
      if (!agent) {
        trace(`voice: no live agent in slot ${slot}; the text stays on the deck`);
        return;
      }
      try {
        // The same path a typed message takes: the next step sees it.
        agent.followup({
          id: randomUUID(),
          role: 'user',
          source: { kind: 'user' },
          content: [{ type: 'text', text }],
        });
        trace(`voice: delivered to agent ${agent.id ?? agent.agentId}`);
      } catch (error) {
        trace(`voice: follow-up failed: ${error?.message ?? error}`);
      }
    },
    log,
  });

  link.on('report', (report) => voice.onReport(report));
  link.on('ptt', (message) => {
    if (message.act === 1) {
      recordings.set(message.p ?? 0, roster.idAt(message.agent));
      voice.press({ ...message, sessionId: roster.idAt(message.agent) });
      return;
    }
    void voice.release(message).finally(() => { recordings.delete(message.p ?? 0); refresh(); });
  });
  link.on('ready', () => { void voice.listen(); });

  link.on('snooze', (message) => board.snooze(message.agent, message.card));
  link.on('sent', (message) => {
    if (message.m === 'doc' || message.m === 'reply') {
      log(`-> ${message.m} slot=${message.agent} rev=${message.id ?? message.rev} kind=${message.d ?? 'r'} first=${message.first ?? 0} total=${message.total ?? 0}`);
    } else log(`-> ${JSON.stringify(message).slice(0, 150)}`);
  });
  link.on('message', (message) => log(`<- ${JSON.stringify(message).slice(0, 150)}`));
  link.on('hello', (message) => log(`[${instance}] hello fw ${message.fw} sid ${message.sid} mine ${link.sid} ready ${link.ready} slots ${link.caps.slots}`));
  link.on('ready', () => log('ready'));
  link.on('synced', () => { log('synced'); refresh(); });
  link.on('closed', () => { log('closed'); board.releaseAll(); });
  link.on('lost', () => { board.releaseAll(); voice.reset(); recordings.clear(); selected = document = undefined; });
  link.on('error', (error) => log(`link error: ${error?.message ?? error}`));
  link.on('channel', ({ agent, seq }) => {
    const id = roster.idAt(agent);
    const entry = visible.get(id);
    if (!entry) return;
    if (pages.turn(entry)) {
      selected = document = undefined;
      refresh();
      return;
    }
    selected = id;
    kind = readingKinds.get(id) ?? 'r'; firstLine = kind === 'w' ? 0 : 65535;
    if (Number.isInteger(seq)) send({ m: 'focus', agent, ack: seq });
    renderDetail(true);
    void openDetails(id);
  });
  link.on('doclines', ({ agent, d, id, first }) => {
    if (!document || roster.idAt(agent) !== selected || !['r', 'w'].includes(d) || !Number.isInteger(first)) return;
    // A quick view switch can reach the host before the deck receives its first revision.
    if (id !== 0 && document.id !== id) return;
    firstLine = first;
    if (d !== kind) { kind = d; readingKinds.set(selected, d); renderDetail(); }
    else if (id === 0) renderDetail(true);
    else sendWindow(agent, first);
  });
  link.on('session', ({ agent, f, i }) => {
    const entry = visible.get(roster.idAt(agent));
    if (!entry || entry.targetPage !== undefined || i !== 255 || f !== 0) return;
    send({ m: 'session', agent, rev: 1, field: 0, page: 0, model: fit(entry.model || '', 48), effort: fit(entry.effort || '', 16), status: 0,
      note: fit(statusText(entry) + ' · ' + entry.name, 96), total: 0, choices: [] });
  });

  // A genuine agent-status stream is the only thing that should move the roster.
  ctx.on('agent/status', () => refresh());
  ctx.on('agent/created', (event) => { attachAgent(event?.agent ?? event); refresh(); });
  ctx.on('agent/disposed', () => refresh());
  let eventRefresh;
  ctx.on('session/event', (_session, event) => {
    if (!['user/message','assistant/message','tool/result','session/title','turn/start','turn/end'].includes(event?.type)) return;
    if (!eventRefresh) eventRefresh = setTimeout(() => { eventRefresh = null; refresh(); }, 180);
  });

  // ---- the answerer, registered once per scope --------------------------------
  //
  // `ctx.userQuestions.ask()` dispatches through `scopeTarget(agent, agent)`, and
  // that filter admits only listeners inside *that agent's* scope. A listener
  // registered on the plugin's own context never sees an agent-scoped question 闂?  // which is exactly what happened: the request went to the Web answerer and this
  // plugin was never called. So the same handler goes on the root context (for
  // agentless callers) and on `agent.ctx` for every live agent.

  /** Agents already wired, so a repeated `agent/created` cannot double-register. */
  const wired = new WeakSet();

  /** The question answerer itself; safe to register in several scopes. */
  const presented = new WeakSet();
  const answerQuestion = async (request, next) => {
    if (presented.has(request)) return next();
    let started = false;
    try {
      trace(`uq request seen: ${describe(request)}`);
      const card = questionCard(request);
      if (!card) {
        trace('uq not drawn: no single selectable question of at most four options');
        return next();
      }
      if (!link.ready) {
        trace('uq not drawn: the deck is not linked');
        return next();
      }
      const agentId = card.agentId;
      waiting.set(request, agentId);
      refresh();
      presented.add(request);
      started = true;
      try {
        return await askOnBoth(request, card, board, next);
      } finally {
        presented.delete(request);
        waiting.delete(request);
        refresh();
      }
    } catch (error) {
      if (started) throw error;
      // A throwing answerer fails the whole question closed: log and let go.
      trace(`uq listener failed: ${error?.message ?? error}`);
      return next();
    }
  };

  /** The approval answerer; one-shot grants only, which is all the deck has. */
  const answerApproval = async (request, next) => {
    try {
      trace('approval request seen');
      if (!link.ready) return next();
      const card = approvalCard(request);
      waiting.set(request, card.agentId);
      refresh();
      const choice = await board.ask(card, request.signal);
      trace(`approval settled: ${choice === null ? 'let go' : `choice ${choice}`}`);
      if (request.signal?.aborted) return 'cancelled';
      if (choice === null) return next();
      return choice === 0 ? 'allowed-once' : 'rejected';
    } catch (error) {
      trace(`approval listener failed: ${error?.message ?? error}`);
      return next();
    } finally { waiting.delete(request); refresh(); }
  };

  /** Register both answerers on one context, if it can take listeners. */
  const wire = (target, label) => {
    if (!target || typeof target.on !== 'function') return false;
    try {
      target.on('user-questions/request', answerQuestion, { prepend: true });
      target.on('approval/request', answerApproval, { prepend: true });
      trace(`answerers registered (${label})`);
      return true;
    } catch (error) {
      trace(`answerer registration failed (${label}): ${error?.message ?? error}`);
      return false;
    }
  };

  // Agentless callers, plus every agent the registry already knows about.
  wire(ctx, 'root');
  const attachAgent = (agent) => {
    const id = String(agent?.id ?? agent?.agentId ?? '');
    if (!id || wired.has(agent)) return;
    if (wire(agent.ctx, `agent ${id}`)) wired.add(agent);
  };
  try {
    for (const agent of agentsService?.list?.() ?? []) attachAgent(agent);
  } catch (error) {
    trace(`agent wiring failed: ${error?.message ?? error}`);
  }

  // A model-facing tool, mostly so the wiring can be checked by hand.
  const tool = {
    name: 'deck_status',
    description: 'Report whether the OpenWalkieTalkie deck is connected and what it is showing.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          connected: { type: 'boolean' },
          synced: { type: 'boolean' },
          agents: { type: 'number' },
          cards: { type: 'number' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.connected
          ? `Deck connected (${value.synced ? 'synced' : 'handshaking'}), ${value.agents} agents shown, ${value.cards} cards open.`
          : 'Deck not connected.',
      }],
    },
    async execute() {
      return {
        connected: link.ready === true,
        synced: roster.shown.size > 0,
        agents: roster.shown.size,
        cards: board.size,
      };
    },
  };

  // Services attach when they appear; neither ever blocks `apply`. A host that
  // refuses the tool, or a profile without the agents service, costs only that
  // feature 闂?the link and the question cards keep working.
  ctx.inject?.(['agents'], (scope) => {
    agentsService = scope.agents ?? ctx.get?.('agents') ?? null;
    try {
      const live = agentsService?.list?.() ?? [];
      const first = live[0];
      trace(`agents service attached: ${live.length} live; first = ${first ? Object.keys(first).join(',') : 'none'}`);
      // Agents that already exist need their scoped answerer too, not only the
      // ones created from here on.
      for (const agent of live) attachAgent(agent);
    } catch (error) {
      trace(`agents list failed: ${error?.message ?? error}`);
    }
    refresh();
  });
  ctx.inject?.(['speechToText'], (scope) => {
    speechService = scope.speechToText ?? ctx.get?.('speechToText') ?? null;
    trace('speech-to-text attached');
    void voice.listen();
  });
  ctx.inject?.(['sessionQuery'], scope => { query = scope.sessionQuery; });
  ctx.inject?.(['workspaceRegistry'], scope => { workspaces = scope.workspaceRegistry; refresh(); });
  ctx.inject?.(['sessionController'], scope => { controller = scope.sessionController; void updateCatalog(); });
  const listTimer = setInterval(() => { if (link.ready) void updateCatalog(); }, 30000);
  listTimer.unref?.();
  ctx.inject?.(['sessionTitle'], (scope) => {
    titlesService = scope.sessionTitle ?? ctx.get?.('sessionTitle') ?? null;
    trace('session titles attached');
    // Rows written before this arrived carry the session id; redraw them.
    refresh();
  });
  ctx.inject?.(['tools'], (scope) => {
    try {
      (scope.tools ?? ctx.get?.('tools'))?.register?.(tool);
      trace('deck_status registered');
    } catch (error) {
      trace(`deck_status refused: ${error?.message ?? error}`);
    }
  });

  // Connect in the background: a missing deck must not fail the profile boot.
  link.start().catch((error) => log(`deck unavailable: ${error?.message ?? error}`));

  ctx.on('dispose', () => {
    disposed = true;
    clearInterval(listTimer);
    clearTimeout(eventRefresh);
    clearTimeout(drawTimer);
    board.releaseAll();
    return link.stop().catch(() => {});
  });

  log(`dsh-deck ready (transport: ${config.transport})`);
}













