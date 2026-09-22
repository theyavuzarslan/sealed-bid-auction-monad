// JSON HTTP API over the indexer's in-memory views. node:http only. Read-only: GET (and HEAD/OPTIONS).
// Endpoint shapes are documented in README.md.

import http from "node:http";
import { jsonReplacer } from "./abi.mjs";

const ROUTES = [
  [/^\/health$/, (ix) => ({
    ok: true,
    engine: ix.engine,
    chainId: ix.chainId,
    indexedToBlock: ix.cursor - 1,
    head: ix.store.head,
  })],
  [/^\/rounds$/, (ix) => ({ rounds: ix.store.listRounds() })],
  [/^\/rounds\/(\d+)$/, (ix, [id]) => ix.store.summary(id)],
  [/^\/rounds\/(\d+)\/commitments$/, (ix, [id]) => ix.store.commitments(id)],
  [/^\/rounds\/(\d+)\/reveals$/, (ix, [id]) => ix.store.reveals(id)],
  [/^\/rounds\/(\d+)\/demand$/, (ix, [id]) => ix.store.demand(id)],
  [/^\/rounds\/(\d+)\/clearing$/, (ix, [id]) => ix.store.clearing(id)],
  [/^\/rounds\/(\d+)\/lp$/, (ix, [id]) => ix.store.lp(id)],
  [/^\/rounds\/(\d+)\/bidders$/, (ix, [id]) => ix.store.bidders(id)],
  [/^\/rounds\/(\d+)\/bidders\/(0x[0-9a-fA-F]{40})$/, (ix, [id, who]) => ix.store.journey(id, who)],
  [/^\/rounds\/(\d+)\/events$/, (ix, [id]) => ix.store.events(id)],
];

function send(res, status, body) {
  const json = JSON.stringify(body, jsonReplacer);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "cache-control": "no-store",
  });
  res.end(json);
}

export function createServer(indexer) {
  return http.createServer((req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" });
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "method not allowed" });
    const { pathname } = new URL(req.url, "http://localhost");
    const path = pathname.length > 1 ? pathname.replace(/\/$/, "") : pathname;
    for (const [re, handler] of ROUTES) {
      const m = path.match(re);
      if (!m) continue;
      const params = m.slice(1);
      if (path.startsWith("/rounds/") && !indexer.store.hasRound(params[0])) {
        return send(res, 404, { error: `round ${params[0]} not indexed` });
      }
      try {
        const body = handler(indexer, params);
        if (body == null) return send(res, 404, { error: "not found" });
        return send(res, 200, body);
      } catch (e) {
        return send(res, 500, { error: e.message });
      }
    }
    return send(res, 404, { error: "no such endpoint" });
  });
}
