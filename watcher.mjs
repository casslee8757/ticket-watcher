import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const EVENTS = [
  { id: '2027-03-04', label: '4 Mar 2027', url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-04-03-2027/event/2500651482031C06' },
  { id: '2027-03-05', label: '5 Mar 2027', url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-05-03-2027/event/2500651A89041AC3' },
  { id: '2027-03-08', label: '8 Mar 2027', url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-08-03-2027/event/2500651A89881B04' },
  { id: '2027-03-09', label: '9 Mar 2027', url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-09-03-2027/event/2500651A89891B06' }
];

const STATE_PATH = path.resolve('state.json');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const EXPLICIT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TEST_NOTIFICATION = String(process.env.TEST_NOTIFICATION || 'false').toLowerCase() === 'true';
const PAGE_TIMEOUT_MS = 65000;
const PAGE_SETTLE_MS = 9000;
const BETWEEN_EVENTS_MS = 3500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function loadState() {
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_PATH, 'utf8'));
    return { telegramChatId: parsed.telegramChatId || null, events: parsed.events || {} };
  } catch {
    return { telegramChatId: null, events: {} };
  }
}
async function saveState(state) { await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); }

async function telegram(method, body) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing.');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) throw new Error(`Telegram ${method} failed: ${json?.description || response.status}`);
  return json.result;
}

async function resolveTelegramChatId(state) {
  if (EXPLICIT_CHAT_ID) return EXPLICIT_CHAT_ID;
  if (state.telegramChatId) return String(state.telegramChatId);
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=100&timeout=0`);
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) throw new Error(`Could not read Telegram updates: ${json?.description || response.status}`);
  const chats = (Array.isArray(json.result) ? json.result : [])
    .map(u => u?.message?.chat || u?.edited_message?.chat || u?.callback_query?.message?.chat)
    .filter(c => c?.type === 'private');
  const latest = chats.at(-1);
  if (!latest?.id) throw new Error('No Telegram private chat found. Send the bot a message first.');
  state.telegramChatId = String(latest.id);
  await saveState(state);
  return String(latest.id);
}

async function sendTelegramMessage(chatId, text, url = null, buttonText = '🎟 Ticketmaster 열기') {
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: url ? { inline_keyboard: [[{ text: buttonText, url }]] } : undefined
  });
}

function fingerprintMatches(matches) {
  return matches.map(m => `${m.section}|${m.row || ''}|${m.price || ''}|${m.ticketType || ''}|${m.availableCount ?? ''}`).sort().join(';;');
}
function summarizeMatch(match) {
  const bits = [`Section ${match.section}`];
  if (match.row) bits.push(`Row ${match.row}`);
  if (match.price) bits.push(match.price);
  if (match.ticketType) bits.push(match.ticketType);
  if (match.availableCount != null) bits.push(`${match.availableCount} available`);
  return bits.join(' · ');
}

async function scanPage(page) {
  return page.evaluate(async () => {
    const RESTRICTION_RE = /(restricted\s*view|limited\s*view|side\s*view|obstructed\s*view|partial\s*view|rear\s*view|behind\s*(the\s*)?stage|no\s*view|view\s*may\s*be\s*restricted|wheelchair|accessible\s*seating|companion\s*seat)/i;
    const BOT_RE = /(pardon\s+the\s+interruption|are\s+you\s+a\s+real\s+fan|verify\s+you\s+are\s+human|access\s+denied|unusual\s+activity|captcha|robot\s+check)/i;
    const NO_TICKETS_RE = /(no\s+tickets\s+(available|found)|tickets\s+are\s+(currently\s+)?unavailable|we\s+couldn[’']?t\s+find\s+any\s+tickets|no\s+results|not\s+enough\s+tickets)/i;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const clean = v => String(v || '').replace(/\s+/g, ' ').trim();

    function visible(el) {
      if (!(el instanceof Element)) return false;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    function richText(el) {
      if (!(el instanceof Element)) return '';
      const parts = [el.innerText, el.textContent, el.getAttribute('aria-label'), el.getAttribute('title')];
      for (const child of el.querySelectorAll('[aria-label],[title]')) {
        parts.push(child.getAttribute('aria-label'), child.getAttribute('title'));
        if (parts.join(' ').length > 2600) break;
      }
      return clean(parts.filter(Boolean).join(' | ')).slice(0, 3000);
    }
    function sectionFromText(text) {
      for (const re of [/\bSection\s*[:#-]?\s*([A-Z][A-Z0-9-]{0,10}|\d{1,3}[A-Z]?)\b/i, /\bSec(?:tion)?\.?\s*[:#-]?\s*([A-Z][A-Z0-9-]{0,10}|\d{1,3}[A-Z]?)\b/i]) {
        const m = text.match(re); if (m) return m[1].toUpperCase();
      }
      return null;
    }
    function sectionAllowed(section) {
      const n = Number(section?.match(/\d{1,3}/)?.[0]);
      return !Number.isFinite(n) || !(n >= 600 && n <= 699);
    }
    function rowFromText(text) { const m = text.match(/\bRow\s*[:#-]?\s*([A-Z0-9-]+)\b/i); return m ? m[1].toUpperCase() : null; }
    function priceFromText(text) { const m = text.match(/(?:A\$|\$)\s?\d{1,4}(?:,\d{3})*(?:\.\d{2})?/); return m ? m[0].replace(/\s+/g, '') : null; }
    function ticketTypeFromText(text) { if (/verified\s+resale\s+ticket|resale/i.test(text)) return 'Resale'; if (/standard\s+ticket|standard/i.test(text)) return 'Standard'; return null; }
    function availableCountFromText(text) { const m = text.match(/\b(\d+)\s+(?:tickets?\s+)?available\b/i); return m ? Number(m[1]) : null; }
    function readStepperQty(root) {
      if (!root) return null;
      const vals = [...root.querySelectorAll('input,span,div')].map(e => clean(e.value || e.textContent)).filter(t => /^\d+$/.test(t)).map(Number);
      return vals.find(n => n >= 1 && n <= 20) ?? null;
    }

    async function setQuantityTwo() {
      const stepper = document.querySelector('div[data-testid="quantityStepper"]');
      if (stepper && visible(stepper)) {
        let qty = readStepperQty(stepper);
        if (qty === 2) return { confirmed: true, method: 'quantityStepper', uiSeen: true };
        const buttons = [...stepper.querySelectorAll('button')].filter(visible);
        const plus = buttons.find(b => /(increase|add|plus|\+)/i.test(clean(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`))) || buttons.at(-1);
        const minus = buttons.find(b => /(decrease|subtract|minus|−|-)/i.test(clean(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`))) || buttons.at(0);
        for (let i = 0; i < 5 && qty !== 2; i++) {
          if (qty == null || qty < 2) plus?.click(); else minus?.click();
          await sleep(500); qty = readStepperQty(stepper);
        }
        return { confirmed: qty === 2, method: 'quantityStepper', uiSeen: true };
      }
      for (const select of document.querySelectorAll('select')) {
        if (!visible(select)) continue;
        const context = clean(`${select.getAttribute('aria-label') || ''} ${select.parentElement?.innerText || ''}`);
        if (!/(ticket|quantity|qty)/i.test(context)) continue;
        const option2 = [...select.options].find(o => clean(o.textContent) === '2' || clean(o.value) === '2' || /^2\s+tickets?$/i.test(clean(o.textContent)));
        if (option2) {
          select.value = option2.value; select.dispatchEvent(new Event('input', { bubbles: true })); select.dispatchEvent(new Event('change', { bubbles: true }));
          await sleep(900); return { confirmed: true, method: 'select', uiSeen: true };
        }
      }
      const buttons = [...document.querySelectorAll("button,[role='button']")].filter(visible);
      for (const b of buttons) {
        const label = clean(`${b.getAttribute('aria-label') || ''} ${b.innerText || b.textContent || ''}`);
        if (/\b2\s*tickets?\b/i.test(label) || /\bquantity\s*2\b/i.test(label)) return { confirmed: true, method: 'button-label', uiSeen: true };
      }
      for (const b of buttons) {
        if (clean(b.innerText || b.textContent) !== '2') continue;
        let p = b.parentElement, context = '';
        for (let i = 0; i < 3 && p; i++, p = p.parentElement) context += ` ${p.innerText || ''}`;
        if (!/(how many tickets|ticket quantity|quantity|number of tickets)/i.test(context)) continue;
        b.click(); await sleep(900); return { confirmed: true, method: 'quantity-button', uiSeen: true };
      }
      return { confirmed: false, method: 'not-found', uiSeen: false };
    }

    async function openBestAvailableIfPresent() {
      const b = [...document.querySelectorAll("button,[role='button']")].filter(visible).find(el => /see\s+best\s+available|best\s+available|best\s+seats/i.test(clean(`${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`)));
      if (!b) return false;
      if (b.getAttribute('aria-pressed') !== 'true') { b.click(); await sleep(700); }
      return true;
    }
    async function clickFindTicketsIfPresent() {
      let b = document.querySelector('button[data-testid="findTicketsBtn"]');
      if (!(b && visible(b))) b = [...document.querySelectorAll("button,[role='button']")].filter(visible).find(el => /^\s*(find tickets|search again|search tickets)\s*$/i.test(clean(el.innerText || el.textContent || el.getAttribute('aria-label'))));
      if (!b) return { clicked: false, uiSeen: false };
      b.click(); await sleep(1000);
      const started = Date.now();
      while (Date.now() - started < 12000) {
        if (document.querySelector('div[data-testid="reserveView"]')) break;
        const t = clean(document.body?.innerText || '');
        if (NO_TICKETS_RE.test(t) || BOT_RE.test(t)) break;
        await sleep(500);
      }
      await sleep(900); return { clicked: true, uiSeen: true };
    }
    function collectResultNodes() {
      const out = [], seen = new Set();
      const add = el => { if (!(el instanceof Element) || !visible(el) || seen.has(el)) return; const text = richText(el); if (text.length < 5 || text.length > 3000) return; seen.add(el); out.push(el); };
      for (const root of document.querySelectorAll('div[data-testid="reserveView"], [data-testid*="reserve" i]')) {
        if (!visible(root)) continue;
        const lis = root.querySelectorAll("li,[role='listitem']"); if (lis.length) lis.forEach(add); else add(root);
      }
      for (const sel of ["[data-testid*='offer' i]","[data-testid*='ticket' i]","[data-testid*='resale' i]","[data-component*='offer' i]","[data-component*='ticket' i]","article","[role='listitem']","li"]) document.querySelectorAll(sel).forEach(add);
      return out;
    }
    function dedupe(matches) {
      const seen = new Set();
      return matches.filter(m => { const k = `${m.section}|${m.row || ''}|${m.price || ''}|${m.ticketType || ''}|${m.availableCount ?? ''}`; if (seen.has(k)) return false; seen.add(k); return true; });
    }

    const firstBody = clean(document.body?.innerText || '');
    if (!firstBody) return { ok: true, verified: false, challenge: false, matches: [], detail: 'Ticket page text not ready.' };
    if (BOT_RE.test(firstBody)) return { ok: true, verified: false, challenge: true, matches: [], detail: 'Ticketmaster verification/challenge detected; not bypassed.' };
    const consent = [...document.querySelectorAll('button')].filter(visible).find(b => /^(accept all|accept all cookies|allow all)$/i.test(clean(b.innerText || b.textContent)));
    if (consent) { consent.click(); await sleep(500); }

    await openBestAvailableIfPresent();
    const qty = await setQuantityTwo();
    const find = await clickFindTicketsIfPresent();
    const body = clean(document.body?.innerText || '');
    if (BOT_RE.test(body)) return { ok: true, verified: false, challenge: true, matches: [], detail: 'Ticketmaster verification/challenge detected after search.' };

    const reserveView = document.querySelector('div[data-testid="reserveView"]');
    const nodes = collectResultNodes();
    if (!(qty.uiSeen || find.uiSeen || reserveView)) return { ok: true, verified: false, challenge: false, matches: [], detail: 'UNVERIFIED: Ticketmaster ticket-search UI not detected.' };
    if (!qty.confirmed) return { ok: true, verified: false, challenge: false, matches: [], detail: `UNVERIFIED: ticket quantity could not be confirmed as 2 (${qty.method}).` };

    const matches = [];
    let resaleListingsSeen = 0, parsedListings = 0;
    for (const node of nodes) {
      const text = richText(node);
      if (/verified\s+resale\s+ticket|\bresale\b/i.test(text)) resaleListingsSeen += 1;
      const section = sectionFromText(text); if (!section) continue;
      parsedListings += 1;
      if (!sectionAllowed(section) || RESTRICTION_RE.test(text)) continue;
      const availableCount = availableCountFromText(text); if (availableCount !== null && availableCount < 2) continue;
      matches.push({ section, row: rowFromText(text), price: priceFromText(text), ticketType: ticketTypeFromText(text), availableCount, evidence: text.slice(0,700) });
    }
    const finalMatches = dedupe(matches).slice(0,20);
    if (finalMatches.length) return { ok:true, verified:true, challenge:false, matches:finalMatches, quantityConfirmed:true, quantityMethod:qty.method, detail:`${finalMatches.length} qualifying option(s) found. Resale listings seen: ${resaleListingsSeen}.` };
    const resultUiPresent = Boolean(reserveView) || find.clicked || nodes.length > 0 || NO_TICKETS_RE.test(body);
    if (resultUiPresent) return { ok:true, verified:true, challenge:false, matches:[], quantityConfirmed:true, quantityMethod:qty.method, detail:`No qualifying pair. Result nodes=${nodes.length}, parsed listings=${parsedListings}, resale listings=${resaleListingsSeen}.` };
    return { ok:true, verified:false, challenge:false, matches:[], detail:'UNVERIFIED: search ran but no recognizable result UI appeared.' };
  });
}

async function scanEvent(browser, event, previous, chatId) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-AU,en;q=0.9' });
    await page.goto(event.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await sleep(PAGE_SETTLE_MS);
    const result = await scanPage(page);
    const now = new Date().toISOString();

    if (result.challenge) {
      if (previous?.lastStatus !== 'blocked') {
        await sendTelegramMessage(chatId, `⚠️ Bruno watcher: Ticketmaster verification 화면이 감지됐어.\n${event.label}\n\n이번 확인은 신뢰할 수 없어서 좌석 없음으로 처리하지 않았어.`, event.url, `Ticketmaster ${event.label} 열기`);
      }
      return { ...previous, lastStatus:'blocked', blocked:true, hasMatch:false, lastChecked:now, lastDetail:result.detail };
    }

    if (result.verified === false) {
      if (previous?.lastStatus !== 'unverified') {
        await sendTelegramMessage(chatId, `⚠️ Bruno watcher가 ${event.label}의 Ticketmaster 좌석 결과를 제대로 읽지 못했어.\n\n${result.detail}\n\n중요: 이 상태를 '좌석 없음'으로 간주하지 않아.`, event.url, `Ticketmaster ${event.label} 확인`);
      }
      return { ...previous, lastStatus:'unverified', blocked:false, hasMatch:false, fingerprint:'', lastChecked:now, lastDetail:result.detail };
    }

    const matches = Array.isArray(result.matches) ? result.matches : [];
    const hasMatch = matches.length > 0;
    const fingerprint = fingerprintMatches(matches);
    const shouldAlert = hasMatch && (!previous?.hasMatch || previous?.fingerprint !== fingerprint);
    if (shouldAlert) {
      const best = matches[0];
      const extra = matches.length > 1 ? `\n+ ${matches.length - 1}개 다른 조건 충족 옵션` : '';
      await sendTelegramMessage(chatId, [
        '🚨 Bruno Mars 좌석 발견',
        `📅 ${event.label} · Accor Stadium`,
        '🎟 2장 조건 충족',
        `📍 ${summarizeMatch(best)}${extra}`,
        '',
        '✅ 6xx 제외',
        '✅ Restricted / Limited / Side / Obstructed View 제외',
        '',
        '아래 버튼을 누르면 이 날짜 Ticketmaster 페이지만 열려.'
      ].join('\n'), event.url, `🎟 ${event.label} Ticketmaster 열기`);
    }
    return { lastStatus:hasMatch?'match':'clear', hasMatch, fingerprint:hasMatch?fingerprint:'', blocked:false, lastChecked:now, lastDetail:result.detail, matches:matches.slice(0,6) };
  } catch (error) {
    const now = new Date().toISOString();
    const detail = `ERROR: ${String(error?.message || error)}`;
    if (previous?.lastStatus !== 'error') await sendTelegramMessage(chatId, `⚠️ Bruno watcher 오류\n${event.label}\n${detail}`, event.url, `Ticketmaster ${event.label} 확인`).catch(()=>{});
    return { ...previous, lastStatus:'error', hasMatch:false, fingerprint:'', lastChecked:now, lastDetail:detail };
  } finally {
    await page.close().catch(()=>{});
  }
}

async function main() {
  const state = await loadState();
  const chatId = await resolveTelegramChatId(state);
  state.telegramChatId = String(chatId); await saveState(state);
  if (TEST_NOTIFICATION) await sendTelegramMessage(chatId, '✅ Bruno Mars Telegram watcher v2 테스트 성공!\n\n이번 버전은 Ticketmaster 검색 결과를 확인하지 못하면 No match로 오판하지 않아.', EVENTS[0].url, '🎟 Ticketmaster 테스트 열기');

  const chromePath = process.env.CHROME_PATH || '';
  if (!chromePath) throw new Error('CHROME_PATH is not set.');
  const browser = await puppeteer.launch({ executablePath:chromePath, headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--window-size=1440,1000'] });
  try {
    for (let i=0;i<EVENTS.length;i++) {
      const event=EVENTS[i];
      const previous=state.events[event.id] || {};
      const next=await scanEvent(browser,event,previous,chatId);
      state.events[event.id]=next; await saveState(state);
      console.log(`${event.label}: [${next.lastStatus}] ${next.lastDetail}`);
      if (i<EVENTS.length-1) await sleep(BETWEEN_EVENTS_MS);
    }
  } finally {
    await browser.close().catch(()=>{}); await saveState(state);
  }
}

main().catch(error => { console.error(error); process.exitCode=1; });
