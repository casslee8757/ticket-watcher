import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const EVENTS = [
  {
    id: '2027-03-04',
    label: '4 Mar 2027',
    url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-04-03-2027/event/2500651482031C06'
  },
  {
    id: '2027-03-05',
    label: '5 Mar 2027',
    url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-05-03-2027/event/2500651A89041AC3'
  },
  {
    id: '2027-03-08',
    label: '8 Mar 2027',
    url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-08-03-2027/event/2500651A89881B04'
  },
  {
    id: '2027-03-09',
    label: '9 Mar 2027',
    url: 'https://www.ticketmaster.com.au/bruno-mars-the-romantic-tour-sydney-olympic-park-09-03-2027/event/2500651A89891B06'
  }
];

const STATE_PATH = path.resolve('state.json');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const EXPLICIT_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TEST_NOTIFICATION = String(process.env.TEST_NOTIFICATION || 'false').toLowerCase() === 'true';
const PAGE_TIMEOUT_MS = 65000;
const PAGE_SETTLE_MS = 10000;
const BETWEEN_EVENTS_MS = 5000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      telegramChatId: parsed.telegramChatId || null,
      events: parsed.events || {}
    };
  } catch {
    return { telegramChatId: null, events: {} };
  }
}

async function saveState(state) {
  await fs.writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function telegram(method, body) {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing. Add it as a GitHub Actions secret.');
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    throw new Error(`Telegram ${method} failed: ${json?.description || response.status}`);
  }
  return json.result;
}

async function resolveTelegramChatId(state) {
  if (EXPLICIT_CHAT_ID) return EXPLICIT_CHAT_ID;
  if (state.telegramChatId) return String(state.telegramChatId);
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is missing.');

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?limit=100&timeout=0`);
  const json = await response.json().catch(() => null);
  if (!response.ok || !json?.ok) {
    throw new Error(`Could not read Telegram updates: ${json?.description || response.status}`);
  }

  const updates = Array.isArray(json.result) ? json.result : [];
  const candidates = updates
    .map(update => update?.message?.chat || update?.edited_message?.chat || update?.callback_query?.message?.chat)
    .filter(Boolean)
    .filter(chat => chat.type === 'private');

  const latest = candidates.at(-1);
  if (!latest?.id) {
    throw new Error('No Telegram private chat found. Open your new bot in Telegram, press Start, send it any message, then run this workflow again.');
  }

  state.telegramChatId = String(latest.id);
  await saveState(state);
  return String(latest.id);
}

async function sendTelegramMessage(chatId, text, url = null, buttonText = '🎟 Ticketmaster 열기') {
  const replyMarkup = url
    ? { inline_keyboard: [[{ text: buttonText, url }]] }
    : undefined;
  return telegram('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    reply_markup: replyMarkup
  });
}

function fingerprintMatches(matches) {
  return matches
    .map(m => `${m.section}|${m.row || ''}|${m.price || ''}|${m.ticketType || ''}`)
    .sort()
    .join(';;');
}

function summarizeMatch(match) {
  const bits = [`Section ${match.section}`];
  if (match.row) bits.push(`Row ${match.row}`);
  if (match.price) bits.push(match.price);
  if (match.ticketType) bits.push(match.ticketType);
  return bits.join(' · ');
}

async function scanPage(page) {
  return page.evaluate(async () => {
    const RESTRICTION_RE = /(restricted\s*view|limited\s*view|side\s*view|obstructed\s*view|partial\s*view|rear\s*view|behind\s*(the\s*)?stage|no\s*view|view\s*may\s*be\s*restricted|wheelchair|accessible\s*seating|companion\s*seat)/i;
    const LEVEL6_RE = /\blevel\s*6\b/i;
    const BOT_RE = /(pardon\s+the\s+interruption|are\s+you\s+a\s+real\s+fan|verify\s+you\s+are\s+human|access\s+denied|unusual\s+activity|captcha|robot\s+check)/i;
    const NO_TICKETS_RE = /(no\s+tickets\s+(available|found)|tickets\s+are\s+(currently\s+)?unavailable|we\s+couldn[’']?t\s+find\s+any\s+tickets|no\s+results)/i;

    function visible(el) {
      if (!(el instanceof Element)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function sectionFromText(text) {
      const patterns = [
        /\bSection\s*[:#-]?\s*([A-Z][A-Z0-9-]{0,7}|\d{1,3}[A-Z]?)\b/i,
        /\bSec(?:tion)?\.?\s*[:#-]?\s*([A-Z][A-Z0-9-]{0,7}|\d{1,3}[A-Z]?)\b/i
      ];
      for (const re of patterns) {
        const m = text.match(re);
        if (m) return m[1].toUpperCase();
      }
      return null;
    }

    function sectionAllowed(section) {
      if (!section) return false;
      const numeric = section.match(/\d{1,3}/)?.[0];
      if (!numeric) return true;
      const n = Number(numeric);
      return !(n >= 600 && n <= 699);
    }

    function rowFromText(text) {
      const m = text.match(/\bRow\s*[:#-]?\s*([A-Z0-9-]+)\b/i);
      return m ? m[1].toUpperCase() : null;
    }

    function priceFromText(text) {
      const prices = [...text.matchAll(/(?:A\$|\$)\s?\d{1,4}(?:,\d{3})*(?:\.\d{2})?/g)].map(m => m[0].replace(/\s+/g, ''));
      return prices[0] || null;
    }

    function ticketTypeFromText(text) {
      if (/resale/i.test(text)) return 'Resale';
      if (/standard\s+ticket/i.test(text)) return 'Standard';
      return null;
    }

    function quantityEvidenceInText(text) {
      return /\b(?:2\s*(?:tickets?|seats?)|qty(?:uantity)?\s*[:=-]?\s*2|tickets?\s*[:=-]?\s*2)\b/i.test(text);
    }

    function elementContext(el, depth = 2) {
      let node = el;
      const parts = [];
      for (let i = 0; i <= depth && node; i += 1, node = node.parentElement) {
        parts.push(cleanText(node.innerText || node.textContent));
      }
      return parts.join(' | ').slice(0, 1800);
    }

    async function setQuantityTwo() {
      for (const select of document.querySelectorAll('select')) {
        if (!visible(select)) continue;
        const context = elementContext(select, 2);
        if (!/(ticket|quantity|qty)/i.test(context)) continue;
        const option2 = [...select.options].find(o => cleanText(o.textContent) === '2' || cleanText(o.value) === '2' || /^2\s+tickets?$/i.test(cleanText(o.textContent)));
        if (option2) {
          if (select.value !== option2.value) {
            select.value = option2.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await new Promise(r => setTimeout(r, 2500));
          }
          return { confirmed: true, method: 'select' };
        }
      }

      const buttons = [...document.querySelectorAll("button,[role='button']")].filter(visible);
      for (const button of buttons) {
        const label = cleanText(`${button.getAttribute('aria-label') || ''} ${button.innerText || button.textContent || ''}`);
        if (/\b2\s*tickets?\b/i.test(label) || /\bquantity\s*2\b/i.test(label)) {
          return { confirmed: true, method: 'button-label' };
        }
      }

      for (const button of buttons) {
        const own = cleanText(button.innerText || button.textContent);
        if (own !== '2') continue;
        const context = elementContext(button, 3);
        if (!/(how many tickets|ticket quantity|quantity|number of tickets)/i.test(context)) continue;
        button.click();
        await new Promise(r => setTimeout(r, 2500));
        return { confirmed: true, method: 'quantity-button' };
      }

      const possibleGroups = [...document.querySelectorAll('div,section,fieldset')].filter(el => {
        if (!visible(el)) return false;
        const t = cleanText(el.innerText || el.textContent);
        return t.length < 500 && /(ticket quantity|quantity|how many tickets)/i.test(t);
      });
      for (const group of possibleGroups) {
        const text = cleanText(group.innerText || group.textContent);
        if (!/(^|\D)1(\D|$)/.test(text)) continue;
        const plus = [...group.querySelectorAll('button')].find(b => {
          const label = cleanText(`${b.getAttribute('aria-label') || ''} ${b.innerText || b.textContent || ''}`);
          return /(increase|add|plus|\+)/i.test(label);
        });
        if (plus) {
          plus.click();
          await new Promise(r => setTimeout(r, 2500));
          const after = cleanText(group.innerText || group.textContent);
          if (/(^|\D)2(\D|$)/.test(after)) return { confirmed: true, method: 'stepper' };
        }
      }
      return { confirmed: false, method: 'not-found' };
    }

    function collectCandidateNodes() {
      const selectors = [
        "[data-testid*='offer' i]",
        "[data-testid*='ticket' i]",
        "[data-component*='offer' i]",
        "[data-component*='ticket' i]",
        'article',
        "[role='listitem']",
        'li'
      ];
      const candidates = new Set();
      for (const selector of selectors) {
        for (const el of document.querySelectorAll(selector)) {
          if (!visible(el)) continue;
          const text = cleanText(el.innerText || el.textContent);
          if (text.length < 8 || text.length > 1800) continue;
          if (sectionFromText(text)) candidates.add(el);
        }
      }
      if (candidates.size === 0) {
        for (const el of document.querySelectorAll('div,section')) {
          if (!visible(el)) continue;
          const text = cleanText(el.innerText || el.textContent);
          if (text.length < 8 || text.length > 1000) continue;
          if (!sectionFromText(text)) continue;
          const childAlsoHasSection = [...el.children].some(child => visible(child) && sectionFromText(cleanText(child.innerText || child.textContent)));
          if (!childAlsoHasSection) candidates.add(el);
        }
      }
      return [...candidates];
    }

    function dedupeMatches(matches) {
      const seen = new Set();
      const out = [];
      for (const match of matches) {
        const key = `${match.section}|${match.row || ''}|${match.price || ''}|${match.ticketType || ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(match);
      }
      return out;
    }

    const bodyText = cleanText(document.body?.innerText || '');
    if (!bodyText) return { ok: true, challenge: false, matches: [], detail: 'Page text not ready' };
    if (BOT_RE.test(bodyText)) {
      return { ok: true, challenge: true, matches: [], detail: 'Ticketmaster verification/challenge detected; not bypassed.' };
    }

    const qty = await setQuantityTwo();
    await new Promise(r => setTimeout(r, 1800));

    const refreshedBody = cleanText(document.body?.innerText || '');
    if (BOT_RE.test(refreshedBody)) {
      return { ok: true, challenge: true, matches: [], detail: 'Ticketmaster verification/challenge detected after setting quantity; not bypassed.' };
    }
    if (NO_TICKETS_RE.test(refreshedBody)) {
      return { ok: true, challenge: false, matches: [], detail: 'Ticketmaster page says no tickets/results.', quantityConfirmed: qty.confirmed, quantityMethod: qty.method };
    }

    const matches = [];
    for (const node of collectCandidateNodes()) {
      const text = cleanText(node.innerText || node.textContent);
      const section = sectionFromText(text);
      if (!section || !sectionAllowed(section)) continue;
      if (RESTRICTION_RE.test(text) || LEVEL6_RE.test(text)) continue;
      const pairConfirmed = qty.confirmed || quantityEvidenceInText(text);
      if (!pairConfirmed) continue;
      matches.push({
        section,
        row: rowFromText(text),
        price: priceFromText(text),
        ticketType: ticketTypeFromText(text),
        evidence: text.slice(0, 500)
      });
    }

    const deduped = dedupeMatches(matches).slice(0, 20);
    return {
      ok: true,
      challenge: false,
      matches: deduped,
      quantityConfirmed: qty.confirmed,
      quantityMethod: qty.method,
      detail: deduped.length
        ? `${deduped.length} qualifying option(s); quantity=2 confirmed via ${qty.method}.`
        : `No qualifying pair detected. Quantity=2 ${qty.confirmed ? `confirmed via ${qty.method}` : 'could not be confirmed'}.`
    };
  });
}

async function scanEvent(browser, event, previous, chatId) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await page.goto(event.url, { waitUntil: 'domcontentloaded', timeout: PAGE_TIMEOUT_MS });
    await sleep(PAGE_SETTLE_MS);
    const result = await scanPage(page);
    const now = new Date().toISOString();

    if (result.challenge) {
      if (!previous?.blocked) {
        await sendTelegramMessage(
          chatId,
          `⚠️ Bruno watcher: Ticketmaster verification 화면이 감지됐어.\n${event.label}\n\n우회하지 않고 이번 확인은 중단했어. 다음 15분 주기에 다시 시도할게.`,
          event.url,
          `Ticketmaster ${event.label} 열기`
        );
      }
      return {
        ...(previous || {}),
        blocked: true,
        lastChecked: now,
        lastDetail: result.detail
      };
    }

    const matches = Array.isArray(result.matches) ? result.matches : [];
    const hasMatch = matches.length > 0;
    const fingerprint = fingerprintMatches(matches);
    const shouldAlert = hasMatch && (!previous?.hasMatch || previous?.fingerprint !== fingerprint);

    if (shouldAlert) {
      const best = matches[0];
      const extra = matches.length > 1 ? `\n+ ${matches.length - 1}개 다른 조건 충족 옵션` : '';
      const text = [
        '🚨 Bruno Mars 좌석 발견',
        `📅 ${event.label} · Accor Stadium`,
        `🎟 2장 조건 충족`,
        `📍 ${summarizeMatch(best)}${extra}`,
        '',
        '✅ 6xx 제외',
        '✅ Restricted / Limited / Side / Obstructed View 제외',
        '',
        '아래 버튼을 누르면 이 날짜 Ticketmaster 페이지만 열려.'
      ].join('\n');
      await sendTelegramMessage(chatId, text, event.url, `🎟 ${event.label} Ticketmaster 열기`);
    }

    return {
      hasMatch,
      fingerprint: hasMatch ? fingerprint : '',
      blocked: false,
      lastChecked: now,
      lastDetail: result.detail,
      matches: matches.slice(0, 6)
    };
  } catch (error) {
    const now = new Date().toISOString();
    return {
      ...(previous || {}),
      blocked: previous?.blocked || false,
      lastChecked: now,
      lastDetail: `ERROR: ${String(error?.message || error)}`
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  const state = await loadState();
  const chatId = await resolveTelegramChatId(state);
  state.telegramChatId = String(chatId);
  await saveState(state);

  if (TEST_NOTIFICATION) {
    await sendTelegramMessage(
      chatId,
      '✅ Bruno Mars Telegram watcher 테스트 성공!\n\n실제 스캔은 시드니 4개 날짜를 확인하고, 조건 맞는 2장 좌석이 새로 보일 때만 알림을 보내.',
      EVENTS[0].url,
      '🎟 Ticketmaster 테스트 열기'
    );
  }

  const chromePath = process.env.CHROME_PATH || '';
  if (!chromePath) throw new Error('CHROME_PATH is not set. The GitHub workflow normally sets this automatically.');

  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    for (let i = 0; i < EVENTS.length; i += 1) {
      const event = EVENTS[i];
      const previous = state.events[event.id] || {};
      const next = await scanEvent(browser, event, previous, chatId);
      state.events[event.id] = next;
      await saveState(state);
      console.log(`${event.label}: ${next.lastDetail}`);
      if (i < EVENTS.length - 1) await sleep(BETWEEN_EVENTS_MS);
    }
  } finally {
    await browser.close().catch(() => {});
    await saveState(state);
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
