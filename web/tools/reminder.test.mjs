// Checks the reveal-reminder calendar file:  node web/tools/reminder.test.mjs
// No dependencies; exits non-zero on the first failed check.
import { buildRevealIcs, icsEscape, icsFold, icsUtc, revealIcsFilename } from "../js/ui/reminder.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; return; }
  failed++;
  console.error(`FAIL ${name}${detail ? `: ${detail}` : ""}`);
}

const commitEnd = 1790000000n; // 2026-09-21T14:13:20Z
const revealEnd = 1790003600n;
const url = "https://even.example/web/#/round/7";
const ics = buildRevealIcs({
  roundId: 7n, symbol: "PE,PE;X", bidder: "0xAbC0000000000000000000000000000000000001", chainId: 10143,
  engine: "0x00000000000000000000000000000000000000E1", commitEnd, revealEnd, url, now: 1789990000,
});

// Line endings: CRLF only, and the file ends with one.
check("ends with CRLF", ics.endsWith("\r\n"));
check("no bare LF", !/[^\r]\n/.test(ics));
check("no bare CR", !/\r(?!\n)/.test(ics));

// Unfold for property checks (RFC 5545 3.1).
const unfolded = ics.replace(/\r\n /g, "");
const lines = unfolded.split("\r\n").filter(Boolean);
check("first line", lines[0] === "BEGIN:VCALENDAR", lines[0]);
check("last line", lines.at(-1) === "END:VCALENDAR", lines.at(-1));
check("VERSION", lines.includes("VERSION:2.0"));
check("PRODID", lines.some((l) => l.startsWith("PRODID:")));
for (const c of ["VCALENDAR", "VEVENT", "VALARM"]) {
  const b = lines.indexOf(`BEGIN:${c}`);
  const e = lines.indexOf(`END:${c}`);
  check(`${c} balanced`, b >= 0 && e > b && lines.filter((l) => l === `BEGIN:${c}`).length === 1);
}
check("VALARM nested in VEVENT",
  lines.indexOf("BEGIN:VEVENT") < lines.indexOf("BEGIN:VALARM") && lines.indexOf("END:VALARM") < lines.indexOf("END:VEVENT"));

const prop = (name, from = lines) => from.find((l) => l.startsWith(`${name}:`))?.slice(name.length + 1);
const utc = /^\d{8}T\d{6}Z$/;
check("DTSTART is UTC", utc.test(prop("DTSTART")), prop("DTSTART"));
check("DTEND is UTC", utc.test(prop("DTEND")), prop("DTEND"));
check("DTSTAMP is UTC", utc.test(prop("DTSTAMP")), prop("DTSTAMP"));
check("DTSTART = commitEnd", prop("DTSTART") === "20260921T141320Z", prop("DTSTART"));
check("DTEND = revealEnd", prop("DTEND") === "20260921T151320Z", prop("DTEND"));
check("icsUtc", icsUtc(0) === "19700101T000000Z", icsUtc(0));

check("SUMMARY escaped", prop("SUMMARY") === "Reveal your bid · PE\\,PE\\;X launch round 7", prop("SUMMARY"));
const desc = prop("DESCRIPTION");
check("DESCRIPTION has the sentence", desc.startsWith("Reveal before the window closes or the deposit is burned."), desc);
check("DESCRIPTION has the URL", desc.includes(url), desc);
check("DESCRIPTION newline escaped", desc.includes("\\n") && !desc.includes("\n"), desc);
check("URL property", prop("URL") === url, prop("URL"));

// UID stable per round + wallet; changes with either.
const uid = prop("UID");
const again = buildRevealIcs({ roundId: 7n, symbol: "X", bidder: "0xabc0000000000000000000000000000000000001", chainId: 10143,
  engine: "0x00000000000000000000000000000000000000e1", commitEnd: 1n, revealEnd: 2n, url, now: 5 });
const uidOf = (s) => prop("UID", s.replace(/\r\n /g, "").split("\r\n"));
check("UID stable across calls and address case", uid && uidOf(again) === uid, `${uid} vs ${uidOf(again)}`);
check("UID differs per round", uidOf(buildRevealIcs({ roundId: 8n, symbol: "X", bidder: "0xabc0000000000000000000000000000000000001",
  chainId: 10143, engine: "0x00000000000000000000000000000000000000e1", commitEnd: 1n, revealEnd: 2n, url })) !== uid);
check("UID differs per wallet", uidOf(buildRevealIcs({ roundId: 7n, symbol: "X", bidder: "0xabc0000000000000000000000000000000000002",
  chainId: 10143, engine: "0x00000000000000000000000000000000000000e1", commitEnd: 1n, revealEnd: 2n, url })) !== uid);

// Alarm: display, 10 minutes before DTSTART.
const alarm = lines.slice(lines.indexOf("BEGIN:VALARM"), lines.indexOf("END:VALARM") + 1);
check("VALARM ACTION", prop("ACTION", alarm) === "DISPLAY");
check("VALARM TRIGGER", prop("TRIGGER", alarm) === "-PT10M", prop("TRIGGER", alarm));
check("VALARM DESCRIPTION", !!prop("DESCRIPTION", alarm));

// Escaping and folding helpers.
check("escape backslash", icsEscape("a\\b") === "a\\\\b");
check("escape newline", icsEscape("a\r\nb\nc") === "a\\nb\\nc");
check("escape comma/semicolon", icsEscape("a,b;c") === "a\\,b\\;c");
const enc = new TextEncoder();
const physical = ics.split("\r\n");
check("no physical line over 75 octets", physical.every((l) => enc.encode(l).length <= 75),
  physical.find((l) => enc.encode(l).length > 75));
const long = "DESCRIPTION:" + "·".repeat(100);
check("fold round-trips multibyte text", icsFold(long).replace(/\r\n /g, "") === long);
check("injected CRLF in symbol cannot add a property",
  !buildRevealIcs({ roundId: 1n, symbol: "X\r\nATTENDEE:mailto:x@y", bidder: "0x1", commitEnd: 1n, revealEnd: 2n, url })
    .split("\r\n").some((l) => l.startsWith("ATTENDEE")));
check("filename sanitised", revealIcsFilename("PE/PE..", 7n) === "even-reveal-PEPE-round-7.ics", revealIcsFilename("PE/PE..", 7n));

console.log(`reminder: ${passed}/${passed + failed} passed`);
if (failed) process.exit(1);
