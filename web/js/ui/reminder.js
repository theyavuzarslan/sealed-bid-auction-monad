// Reveal reminders: a calendar file (RFC 5545) for the reveal window. Pure, no DOM, so Node can test it
// (web/tools/reminder.test.mjs). The Notification half lives in screens/round.js, because it needs the
// chain clock and the screen's cleanup.

const CRLF = "\r\n";

// DATE-TIME in UTC form: YYYYMMDDTHHMMSSZ. `sec` is unix seconds (number or bigint).
export function icsUtc(sec) {
  return new Date(Number(sec) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

// TEXT value escaping (RFC 5545 3.3.11): backslash, semicolon, comma, and newlines as \n.
export function icsEscape(text) {
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// Lines longer than 75 octets are folded: CRLF plus one space (RFC 5545 3.1). Counts UTF-8 bytes and
// never splits a character.
export function icsFold(line) {
  const enc = new TextEncoder();
  const out = [];
  let cur = "";
  let bytes = 0;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74; // continuation lines start with a space
    if (bytes + n > limit) { out.push(cur); cur = ""; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join(`${CRLF} `);
}

// The reveal window as one event: DTSTART = reveal opens (commitEnd), DTEND = reveal closes (revealEnd),
// with a display alarm 10 minutes before it opens. The UID is stable per chain, engine, round and wallet,
// so importing the file twice updates the same event instead of adding a second one.
export function buildRevealIcs({ roundId, symbol, bidder, chainId = "", engine = "", commitEnd, revealEnd, url, now = Date.now() / 1000 }) {
  const summary = `Reveal your bid · ${symbol} launch round ${roundId}`;
  const description = `Reveal before the window closes or the deposit is burned.\n${url}`;
  const uid = `even-reveal-${chainId}-${engine}-${roundId}-${bidder}`.toLowerCase().replace(/[^a-z0-9-]/g, "") + "@even";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Even//Sealed-bid launches on Monad//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsUtc(Math.floor(Number(now)))}`,
    `DTSTART:${icsUtc(commitEnd)}`,
    `DTEND:${icsUtc(revealEnd)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    `URL:${String(url).replace(/[\r\n]/g, "")}`,
    "TRANSP:TRANSPARENT",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    `DESCRIPTION:${icsEscape(summary)}`,
    "TRIGGER:-PT10M",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(icsFold).join(CRLF) + CRLF;
}

export function revealIcsFilename(symbol, roundId) {
  const safe = String(symbol ?? "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || "token";
  return `even-reveal-${safe}-round-${roundId}.ics`;
}
