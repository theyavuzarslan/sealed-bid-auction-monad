// What a visitor sees when this network has no engine yet: a plain "coming soon", never a config error.
// On the local network (developers) it keeps the setup hint.
import { esc } from "../format.js";

export function notLiveHtml(net, what = "Launches") {
  if (net.name === "local") {
    return `<section class="page page-narrow"><div class="panel"><div class="panel-in">
      <h1 class="panel-title">No local engine</h1>
      <p>Start anvil and run <code>forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast</code> in <code>contracts/</code>, then reload.</p>
    </div></div></section>`;
  }
  return `<section class="page page-narrow"><div class="panel panel-p2"><div class="panel-in">
    <h1 class="panel-title">${esc(what)} open on ${esc(net.label)} soon</h1>
    <p>Even is getting its contracts onto ${esc(net.label)}. Until then, watch the bot and the crowd play the same launch, or see how a vault exit auction handles a bank run.</p>
    <div class="btn-row" style="margin-top:16px">
      <a class="btn btn-start" href="#/">Watch the head-to-head</a>
      <a class="btn btn-panel" href="../demo/exit/">Vault exit demo</a>
    </div>
  </div></div></section>`;
}
