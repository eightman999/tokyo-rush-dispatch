import "./style.css";
import { Simulation, CAPACITY } from "./engine.js";
import {
  STATIONS,
  LINES,
  CONNECTIONS,
  SCENARIOS,
  COMMANDS,
  lineById,
} from "./network.js";

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const number = (n) => Math.round(n).toLocaleString("ja-JP");
const clock = (seconds) => {
  const n = 27000 + Math.floor(seconds);
  return [Math.floor(n / 3600), Math.floor((n % 3600) / 60), n % 60]
    .map((x) => String(x).padStart(2, "0"))
    .join(":");
};
const minutes = (delay) => `${(delay / 60).toFixed(1)}分`;
const statusColor = (delay) =>
  delay >= 180 ? "#f1847b" : delay >= 60 ? "#edc46c" : "#78c6a1";
const statusName = (t) =>
  ({
    running: "走行",
    dwelling: "停車",
    blocked: "駅間抑止",
    pending: "出庫前",
    done: "運転終了",
    cancelled: "運休",
  })[t.status];
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

let sim = new Simulation();
let running = false,
  speed = 5,
  selectedLine = "toyoko",
  selectedTrain = "",
  selectedStation = "shibuya",
  selectedCommand = "cut";
let heatmap = true,
  mapMode = "network",
  lastUi = 0,
  accumulator = 0,
  lastFrame = performance.now(),
  renderedLog = "",
  renderedTable = "";
let renderDurations = [];

const icons = {
  rail: '<svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="7" y="4" width="18" height="21" rx="4" stroke="currentColor" stroke-width="1.8"/><path d="M7 15h18M16 5v10M10 29l3-4m9 4-3-4" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="20" r="1.5" fill="currentColor"/><circle cx="20" cy="20" r="1.5" fill="currentColor"/></svg>',
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 3 8 5-8 5z" fill="currentColor"/></svg>',
  pause:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h3v10H4zm5 0h3v10H9z" fill="currentColor"/></svg>',
};

$("#app").innerHTML = `
  <header class="topbar">
    <a href="#" class="brand" aria-label="首都圏輸送指令室">${icons.rail}<span>首都圏輸送指令室<small>朝ラッシュ 運行整理シミュレーション</small></span><span class="edition">訓練用</span></a>
    <nav class="top-actions" aria-label="演習操作"><span class="local-indicator"><i></i>ローカル演習</span><button id="help" class="quiet">操作ガイド <span class="key">?</span></button><button id="export" class="quiet">記録を書き出す ↗</button><button id="import" class="icon-btn" aria-label="演習記録を読み込む" title="演習記録を読み込む">↥</button><input type="file" id="replay-file" accept="application/json,.json" hidden /></nav>
  </header>

  <section class="shiftbar" aria-label="演習設定">
    <div class="shift-title"><span class="shift-label">Morning shift</span><h1>朝の輸送を、取り戻せ。</h1></div>
    <div class="scenario-control"><label for="scenario">担当シナリオ</label><select id="scenario">${Object.entries(
      SCENARIOS,
    )
      .map(
        ([id, s]) =>
          `<option value="${id}" ${id === sim.scenarioId ? "selected" : ""}>${s.name}</option>`,
      )
      .join("")}</select></div>
    <div class="seed-control"><label for="seed">乱数シード</label><input id="seed" type="number" min="0" max="4294967295" value="20261112" aria-label="乱数シード" /></div>
    <button class="quiet reset" id="reset">↻ 最初から</button>
    <div class="clock-block"><span class="clock-label">指令時刻</span><time id="clock">07:30:00</time></div>
    <div class="transport"><button id="play" class="play-btn">${icons.play}<span>演習開始</span></button><select id="speed" aria-label="再生速度"><option value="1">1×</option><option value="5" selected>5×</option><option value="15">15×</option><option value="60">60×</option></select><button id="step" class="icon-btn" aria-label="10秒進める" title="10秒進める">+10s</button></div>
  </section>

  <section class="metrics" aria-label="運行状況">
    <div class="metric score-metric"><span>輸送指令スコア <small>100,000点からの減点制</small></span><div><strong id="score">100,000</strong><span class="grade" id="grade">S</span></div><div class="score-track"><i id="score-bar"></i></div></div>
    <div class="metric"><span>遅延列車 <small>1分以上</small></span><div><strong id="delayed">0</strong><em>本</em><small id="active-count"></small></div></div>
    <div class="metric"><span>最大遅延</span><div><strong id="max-delay">0.0</strong><em>分</em><span class="metric-symbol">↗</span></div></div>
    <div class="metric"><span>ホーム待機旅客</span><div><strong id="waiting">0</strong><em>人</em><span class="metric-symbol">♧</span></div></div>
    <div class="metric"><span>累積旅客損失 <small>小さいほど良い</small></span><div><strong id="loss">0</strong><em>人・分相当</em></div></div>
  </section>

  <main class="workspace">
    <aside class="left-rail">
      <section class="line-panel"><div class="panel-heading"><h2>担当路線</h2><span id="line-count">7線区</span></div><div id="line-list"></div></section>
      <section class="situation"><span class="situation-label"><i class="alert-dot"></i>現在の運行障害</span><div id="incident-summary"></div><button id="locate" class="text-button">発生地点を確認 <span>↗</span></button></section>
      <section class="station-panel"><div class="panel-heading"><h2>駅モニター</h2><span class="tiny">駅を選択</span></div><div id="station-detail"></div></section>
      <div class="rail-footnote">実在路線を簡略化した架空ダイヤ<br>実際の運行情報ではありません。</div>
    </aside>

    <div class="center-stage">
      <section class="network-panel panel">
        <div class="panel-heading network-heading"><div><h2>広域運行モニター</h2><span class="panel-subtitle">首都圏・朝ラッシュ方面</span></div><div class="map-controls"><div class="segmented"><button id="all-lines" class="active">全線区</button><button id="focus-line">選択路線</button></div><button id="heat" class="icon-btn active" aria-pressed="true" title="ホーム混雑表示">◉ <span>混雑</span></button></div></div>
        <div class="network-canvas"><svg id="network" viewBox="0 0 1090 565" role="group" aria-label="路線網と在線列車。駅または列車を選択できます。"><defs><pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="0.65" fill="#2e414f"/></pattern></defs><rect width="1090" height="565" fill="url(#dots)"/><g id="route-layer"></g><g id="heat-layer"></g><g id="station-layer"></g><g id="train-layer"></g><g id="incident-layer"></g><text x="34" y="535" class="map-note">路線・配線・所要時間はゲーム用に簡略化しています</text><g transform="translate(1025 477)" class="north"><path d="M0 25V0m-5 8L0 0l5 8"/><text x="-4" y="-8">N</text></g></svg></div>
        <div class="map-legend"><span><i class="train-key normal"></i>定刻</span><span><i class="train-key minor"></i>1分以上</span><span><i class="train-key severe"></i>3分以上</span><span class="legend-divider"></span><span>◎ 直通・接続駅</span><span><i class="heat-key"></i>ホーム混雑</span><span class="map-count" id="map-count"></span></div>
      </section>

      <section class="diagram-panel panel"><div class="panel-heading"><div class="diagram-title"><h2>運行ダイヤグラム</h2><span id="diagram-line" class="line-chip"></span></div><div class="diagram-legend"><span>┄ 計画</span><span>━ 実績</span><small>停車中の点を右へドラッグ → 延発</small></div></div><svg id="diagram" viewBox="0 0 900 230" aria-label="計画と実際の運行ダイヤグラム。停車中の列車の点を右にドラッグして延発。"></svg><div class="diagram-footer"><span id="diagram-caption"></span><span>時間 →</span></div></section>

      <section class="trains-panel panel"><div class="panel-heading"><div class="diagram-title"><h2>列車運行一覧</h2><span id="train-table-count" class="tiny"></span></div><label class="table-toggle"><input id="only-delayed" type="checkbox" /> 遅延列車のみ</label></div><div class="table-scroll"><table><thead><tr><th>列車番号</th><th>種別</th><th>現在位置 / 状態</th><th>遅延</th><th>乗車率</th></tr></thead><tbody id="train-table"></tbody></table></div></section>
    </div>

    <aside class="right-rail"><section class="command-panel panel"><div class="panel-heading"><h2>運転整理</h2><span class="command-tag">指令操作</span></div><div class="command-body"><div id="selected-train"></div><label class="field-label" for="train-select">対象列車</label><select id="train-select"></select><div class="command-grid">${Object.entries(
      COMMANDS,
    )
      .map(
        ([id, c]) =>
          `<button class="command-choice ${id === selectedCommand ? "selected" : ""}" data-command="${id}"><span>${c.icon}</span>${c.short}</button>`,
      )
      .join(
        "",
      )}</div><div id="command-fields"></div><div class="command-explanation" id="command-explanation"></div><div id="command-validity" class="command-validity"></div><button class="issue-btn" id="issue">指令を発行 <span>↗</span></button><p class="command-hint">指令は即時反映されます。<br>取り消しはできません。旅客への影響を考慮してください。</p></div></section>
      <section class="journal panel"><div class="panel-heading"><h2>指令・運行ログ</h2><span class="live-dot"></span></div><div id="logs" class="log-list" aria-live="polite" aria-relevant="additions"></div></section>
    </aside>
  </main>

  <footer class="statusbar"><span><i class="live-dot"></i><span id="run-state">指令待機中</span></span><span>最小運転間隔 120秒 <b>／</b> 定員 1,200人 <b>／</b> シード <span id="seed-label">20261112</span></span><span id="progress-label">演習終了 08:00</span><div class="progress-track"><i id="progress"></i></div></footer>
  <div class="toast" id="toast" role="status"></div>
  <dialog id="guide"><button class="dialog-close" aria-label="ガイドを閉じる">×</button><span class="dialog-eyebrow">輸送指令員へようこそ</span><h2>列車の遅れを、<br>人の移動から考える。</h2><p>ドア点検による数分の停車が、後続列車と直通先へ波及しています。全列車を定刻にするより、乗客全体の待ち時間を減らすことが目標です。</p><ol><li><strong>状況を見る</strong><span>路線を選択。赤い列車と、混雑した駅を確認します。</span></li><li><strong>指令を出す</strong><span>列車・整理方法・対象駅を選び「指令を発行」。適用できない指令には理由が表示されます。</span></li><li><strong>結果を見守る</strong><span>演習を再生し、遅延・旅客損失・スコアの変化を見ます。スジ図の停車点を右へドラッグすると延発できます。</span></li></ol><div class="guide-ranks">S 90,000〜 <span>A 75,000〜</span> B 60,000〜 <span>C 40,000〜</span> F 40,000未満</div><p class="muted">Space：再生・一時停止　／　?：ガイド　／　同じシード・同じ指令時刻で結果を再現できます。</p><button class="primary guide-start">指令卓に戻る</button></dialog>
  <dialog id="results"><span class="dialog-eyebrow">朝ラッシュ 終了報告</span><h2>お疲れさまでした、指令員。</h2><div id="result-body"></div><div class="result-actions"><button class="quiet" id="result-export">記録を書き出す</button><button class="primary" id="result-restart">もう一度指令する</button><button class="quiet" id="result-close">指令卓を見る</button></div></dialog>
  <dialog id="restart-confirm"><h2>新しい演習を開始しますか？</h2><p>現在の演習はリセットされます。必要なら先に記録を書き出してください。</p><div class="result-actions"><button class="quiet" id="restart-cancel">続ける</button><button class="primary" id="restart-accept">最初から開始</button></div></dialog>
`;

function toast(message, error = false) {
  $("#toast").textContent = message;
  $("#toast").className = `toast show ${error ? "error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 4500);
}
function pickInitialTrain() {
  const list = sim.liveTrains.filter((t) => t.line === selectedLine);
  const t =
    list.find((t) => t.path[t.index + 1] === selectedStation) ||
    list.find((t) => t.status === "dwelling") ||
    list[0];
  selectedTrain = t?.id || "";
}
function chooseLine(id) {
  selectedLine = id;
  selectedStation = lineById(id).stations[0];
  pickInitialTrain();
  renderedTable = "";
  renderRoutes();
  renderStation();
  renderCommand(true);
  render();
}
function trainPosition(t, time = sim.time) {
  const a = STATIONS[t.path[t.index]];
  if (!["running", "blocked"].includes(t.status))
    return { x: a.x, y: a.y + (t.reverse ? 9 : -9) };
  const b = STATIONS[t.path[t.index + 1]];
  const departure = t.history[t.index]?.departure ?? sim.time;
  const f = Math.min(
    t.status === "blocked" ? 0.83 : 0.97,
    Math.max(0.04, (time - departure) / 150),
  );
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f - 7 };
}
function renderRoutes() {
  $("#line-count").textContent = `${sim.lines.length}線区`;
  $("#line-list").innerHTML = sim.lines
    .map(
      (l) =>
        `<button class="line-row ${l.id === selectedLine ? "selected" : ""}" data-line="${l.id}" style="--line:${l.color}"><span class="line-code">${l.code}</span><span>${l.name}<small id="line-status-${l.id}">平常運転</small></span><span class="line-delay" id="line-delay-${l.id}">—</span></button>`,
    )
    .join("");
  $("#route-layer").innerHTML = LINES.map((l) => {
    const dim =
      !sim.scenario.lines.includes(l.id) ||
      (mapMode === "line" && l.id !== selectedLine);
    const points = l.stations
      .map((sid) => `${STATIONS[sid].x},${STATIONS[sid].y}`)
      .join(" ");
    return `<g opacity="${dim ? ".10" : "1"}"><polyline points="${points}" fill="none" stroke="#101b25" stroke-width="11" stroke-linejoin="round"/><polyline points="${points}" fill="none" stroke="${l.color}" stroke-width="${l.id === selectedLine ? "5.5" : "3.5"}" stroke-linejoin="round" stroke-linecap="round"/></g>`;
  }).join("");
  $("#station-layer").innerHTML = Object.entries(STATIONS)
    .map(([id, s]) => {
      const inLine = lineById(selectedLine).stations.includes(id);
      const available = !!sim.stations[id];
      const dim = !available || (mapMode === "line" && !inLine);
      const boundary = CONNECTIONS.some((c) => c.station === id);
      const below = [
        "ikebukuro",
        "shibuya",
        "shinjukusanchome",
        "hiyoshi",
        "hazawa",
        "nishiya",
        "futamatagawa",
        "yokohama",
        "kikuna",
        "musashikosugi",
        "jiyugaoka",
        "nakameguro",
        "tokyo",
        "ochanomizu",
        "shinjuku",
      ].includes(id);
      return `<g data-station="${id}" class="station ${selectedStation === id ? "chosen" : ""}" role="button" tabindex="${available ? "0" : "-1"}" aria-label="${s.name}駅を選択" transform="translate(${s.x},${s.y})" opacity="${dim ? ".18" : "1"}"><title>${s.name}${s.siding ? "・待避可能" : ""}${s.turnback ? "・折返可能" : ""}</title><circle r="${boundary ? "7" : "4.5"}" fill="#14232e" stroke="${selectedStation === id ? "#fff" : "#c1ced7"}" stroke-width="${boundary ? "2" : "1.5"}"/>${boundary ? '<circle r="2.5" fill="#b3c2cf"/>' : ""}<text y="${below ? "23" : "-13"}" text-anchor="middle">${s.name}</text></g>`;
    })
    .join("");
  $("#diagram-line").textContent = lineById(selectedLine).name;
  $("#diagram-line").style.setProperty("--line", lineById(selectedLine).color);
}
function renderMap() {
  $("#heat-layer").innerHTML = heatmap
    ? Object.values(sim.stations)
        .filter(
          (s) =>
            s.waiting > 450 &&
            (mapMode !== "line" ||
              lineById(selectedLine).stations.includes(s.id)),
        )
        .map(
          (s) =>
            `<circle cx="${s.x}" cy="${s.y}" r="${Math.min(32, 10 + s.waiting / 130)}" fill="${s.waiting > s.capacity ? "#ef776e" : "#edba6a"}" opacity="${Math.min(0.25, (s.waiting / s.capacity) * 0.18)}"/>`,
        )
        .join("")
    : "";
  $("#train-layer").innerHTML = sim.liveTrains
    .filter((t) => mapMode !== "line" || t.line === selectedLine)
    .map((t) => {
      const p = trainPosition(t),
        selected = selectedTrain === t.id,
        c = statusColor(t.delay);
      return `<g data-train="${t.id}" class="train-marker ${selected ? "selected" : ""}" transform="translate(${p.x.toFixed(1)},${p.y.toFixed(1)})" role="button" tabindex="0" aria-label="${t.id} ${lineById(t.line).name} ${statusName(t)} 遅延${minutes(t.delay)}"><title>${t.id} ${statusName(t)} +${minutes(t.delay)}</title>${selected ? `<circle r="13" fill="${c}" opacity=".13"/><circle r="11" fill="none" stroke="${c}" stroke-width="1"/>` : ""}<rect x="-8" y="-4" width="16" height="8" rx="2" fill="${c}" stroke="#101b25" stroke-width="1.5"/><path d="M-3-2v4M2-2v4" stroke="#14232e" stroke-width="1"/>${selected ? `<text y="-18" text-anchor="middle" class="train-label">${t.id}</text>` : ""}${t.delay >= 180 ? '<text x="10" y="4" class="severity-label">!</text>' : ""}</g>`;
    })
    .join("");
  $("#incident-layer").innerHTML = sim.incidents
    .filter((i) => i.until > sim.time)
    .map((i) => {
      const s = STATIONS[i.station];
      return `<g class="incident-marker" transform="translate(${s.x},${s.y})"><circle r="20" fill="none" stroke="#f1847b" stroke-width="1.5" stroke-dasharray="3 4"/><g transform="translate(12,-36)"><rect x="-4" y="-13" width="94" height="25" rx="4" fill="#492d30" stroke="#865052"/><text x="3" y="4">! ${i.kind}</text></g></g>`;
    })
    .join("");
  $("#map-count").textContent = `${sim.liveTrains.length}本 運行中`;
}
function renderStation() {
  const s = sim.stations[selectedStation];
  if (!s) return;
  const ratio = Math.min(100, (s.waiting / s.capacity) * 100);
  $("#station-detail").innerHTML =
    `<div class="station-name">${s.name}<span>駅</span></div><div class="station-waiting"><strong>${number(s.waiting)}</strong><span>人 待機</span></div><div class="capacity-track ${ratio >= 100 ? "danger" : ""}"><i style="width:${ratio}%"></i></div><div class="station-caption"><span>混雑 ${number(ratio)}%</span><span>目安 ${number(s.capacity)}人</span></div><div class="station-facilities">${s.turnback ? "<span>↶ 折返設備</span>" : ""}${s.siding ? "<span>⇅ 待避設備</span>" : ""}${sim.connections.some((c) => c.station === s.id) ? `<span>${sim.cutConnections.has(s.id) ? "⇥ 直通中止中" : "◎ 直通境界"}</span>` : ""}</div>${s.waiting > s.capacity ? '<p class="overflow-warning">△ ホーム混雑・入場制限相当</p>' : ""}`;
}
function renderCommand(rebuild = false) {
  const list = sim.liveTrains.filter((t) => t.line === selectedLine);
  if (
    !sim.trainsById.has(selectedTrain) ||
    !list.some((t) => t.id === selectedTrain)
  ) {
    selectedTrain = list[0]?.id || "";
    rebuild = true;
  }
  const t = sim.trainsById.get(selectedTrain);
  const fieldKey = `${selectedTrain}:${t?.index}:${t?.status === "dwelling"}`;
  if ($("#command-fields").dataset.key !== fieldKey) {
    rebuild = true;
    $("#command-fields").dataset.key = fieldKey;
  }
  const options = list
    .map(
      (t) =>
        `<option value="${t.id}" ${t.id === selectedTrain ? "selected" : ""}>${t.id}　${t.type === "rapid" ? "快速" : "普通"}　+${minutes(t.delay)}</option>`,
    )
    .join("");
  if (
    $("#train-select").dataset.ids !== list.map((t) => t.id).join(",") ||
    rebuild
  ) {
    $("#train-select").innerHTML = options;
    $("#train-select").dataset.ids = list.map((t) => t.id).join(",");
  }
  $("#selected-train").innerHTML = t
    ? `<div class="selected-id"><span class="line-code" style="--line:${lineById(t.line).color}">${lineById(t.line).code}</span><strong>${t.id}</strong><span class="train-type ${t.type}">${t.type === "rapid" ? "快速" : "普通"}</span></div><div class="selected-destination">${STATIONS[t.path.at(-1)].name}方面 <span>${statusName(t)}</span></div><div class="train-state"><span>遅延<strong style="color:${statusColor(t.delay)}">+${minutes(t.delay)}</strong></span><span>乗車率<strong>${number((t.passengers / CAPACITY) * 100)}<small>%</small></strong></span></div><div class="car-load">${Array.from({ length: 8 }, () => `<i style="--load:${Math.min(100, (t.passengers / CAPACITY) * 62)}%;--load-color:${t.passengers > CAPACITY ? "#dfb567" : "#70b8a1"}"></i>`).join("")}</div><div class="tis-status">● ${t.reason}</div>`
    : '<div class="empty-state">この路線の運行中列車はありません。</div>';
  if (rebuild) renderCommandFields();
  validateCommand();
}
function renderCommandFields() {
  const t = sim.trainsById.get(selectedTrain);
  $$(".command-choice").forEach((b) =>
    b.classList.toggle("selected", b.dataset.command === selectedCommand),
  );
  if (selectedCommand === "cut") {
    $("#command-fields").innerHTML =
      `<label class="field-label" for="connection-select">直通境界駅</label><select id="connection-select">${sim.connections.length ? sim.connections.map((c) => `<option value="${c.id}">${c.name}（${lineById(c.from).name} → ${lineById(c.to).name}）</option>`).join("") : '<option value="">直通接続なし</option>'}</select>`;
    const preferred = sim.connections.find(
      (c) => c.from === selectedLine || c.to === selectedLine,
    );
    if (preferred) $("#connection-select").value = preferred.id;
  } else if (selectedCommand === "cancel")
    $("#command-fields").innerHTML =
      '<div class="field-label">運休範囲：選択列車の残り全区間</div>';
  else {
    const stations = t
      ? t.path
          .map((sid, i) => ({ sid, i }))
          .filter(
            ({ i }) => i >= t.index && (i > t.index || t.status === "dwelling"),
          )
      : [];
    $("#command-fields").innerHTML =
      `<label class="field-label" for="station-select">対象駅</label><select id="station-select">${stations.map(({ sid, i }) => `<option value="${sid}">${STATIONS[sid].name}${STATIONS[sid].siding ? " ・待避可" : ""}${STATIONS[sid].turnback ? " ・折返可" : ""}${i === t?.index ? "（現在駅）" : ""}</option>`).join("")}</select>`;
    const appropriate = stations.find(({ sid, i }) =>
      selectedCommand === "skip"
        ? i > t.index &&
          i < t.path.length - 1 &&
          !sim.connections.some((c) => c.station === sid)
        : selectedCommand === "turnback"
          ? i > 0 && i < t.path.length - 1 && STATIONS[sid].turnback
          : STATIONS[sid].siding,
    );
    if (appropriate) $("#station-select").value = appropriate.sid;
  }
  const c = COMMANDS[selectedCommand];
  $("#command-explanation").innerHTML =
    `<strong>${c.name}</strong><p>${c.description}</p><span>△ ${c.caution}</span>`;
  $$("#command-fields select").forEach((s) =>
    s.addEventListener("change", validateCommand),
  );
}
function currentCommand() {
  return {
    type: selectedCommand,
    trainId: selectedTrain,
    ...(selectedCommand === "cut"
      ? { connectionId: $("#connection-select")?.value }
      : selectedCommand !== "cancel"
        ? { stationId: $("#station-select")?.value }
        : {}),
  };
}
function validateCommand() {
  const error = sim.ended
    ? "演習終了。結果を確認してください。"
    : sim.validate(currentCommand());
  $("#command-validity").textContent =
    error || "✓ 発行可能。旅客への影響を確認してください。";
  $("#command-validity").classList.toggle("invalid", !!error);
  $("#issue").disabled = !!error;
}
function renderDiagram() {
  const l = lineById(selectedLine),
    w = 900,
    h = 230,
    left = 88,
    right = 18,
    top = 20,
    bottom = 25;
  const start = Math.max(-120, Math.floor((sim.time - 300) / 60) * 60),
    span = 900;
  const x = (time) => left + ((time - start) / span) * (w - left - right);
  const y = (i) => top + (i / (l.stations.length - 1)) * (h - top - bottom);
  let html =
    '<defs><clipPath id="plot-clip"><rect x="88" y="10" width="794" height="205"/></clipPath></defs>';
  for (let t = start; t <= start + span; t += 120)
    html += `<line x1="${x(t)}" y1="10" x2="${x(t)}" y2="210" stroke="#283946"/><text x="${x(t)}" y="227" text-anchor="middle" class="axis-label">${clock(t).slice(0, 5)}</text>`;
  l.stations.forEach((sid, i) => {
    html += `<line x1="${left}" y1="${y(i)}" x2="882" y2="${y(i)}" stroke="#283946"/><text data-station="${sid}" x="78" y="${y(i) + 4}" text-anchor="end" class="axis-label station-axis">${STATIONS[sid].name}</text>`;
  });
  html += '<g clip-path="url(#plot-clip)">';
  for (const t of sim.trains.filter(
    (t) =>
      t.line === selectedLine &&
      !t.reverse &&
      t.plan.at(-1) >= start &&
      t.plan[0] <= start + span,
  )) {
    const plan = t.plan.map((v, i) => `${x(v)},${y(i)}`).join(" ");
    html += `<polyline points="${plan}" class="planned-path"/>`;
    const history = t.history
      .filter(Boolean)
      .map(
        (v, i) =>
          `${x(v.arrival)},${y(i)} ${x(v.departure ?? Math.min(sim.time, start + span))},${y(i)}`,
      )
      .join(" ");
    if (history)
      html += `<polyline points="${history}" fill="none" stroke="${t.id === selectedTrain ? "#fff1d5" : statusColor(t.delay)}" stroke-width="${t.id === selectedTrain ? 2.6 : 1.3}" opacity="${t.id === selectedTrain ? 1 : 0.65}"/>`;
    if (
      t.status === "dwelling" &&
      sim.time >= start &&
      sim.time <= start + span
    )
      html += `<circle data-diagram-train="${t.id}" cx="${x(sim.time)}" cy="${y(t.index)}" r="${t.id === selectedTrain ? 6 : 4}" fill="${statusColor(t.delay)}" stroke="#14232e" stroke-width="2" class="diagram-point"><title>${t.id} ドラッグで10〜300秒延発</title></circle>`;
  }
  html += `<line x1="${x(sim.time)}" x2="${x(sim.time)}" y1="8" y2="210" stroke="#f4a15a" stroke-width="1.3"/><rect x="${x(sim.time) - 17}" y="1" width="34" height="13" rx="2" fill="#f4a15a"/><text x="${x(sim.time)}" y="10" text-anchor="middle" class="now-label">現在</text></g>`;
  $("#diagram").innerHTML = html;
  $("#diagram-caption").textContent =
    `${l.name}　${STATIONS[l.stations[0]].name} → ${STATIONS[l.stations.at(-1)].name}`;
  $("#diagram").dataset.secondsPerUnit = span / (w - left - right);
}
function renderTable() {
  const trains = sim.liveTrains
    .filter(
      (t) =>
        t.line === selectedLine &&
        (!$("#only-delayed").checked || t.delay >= 60),
    )
    .sort((a, b) => b.delay - a.delay || a.id.localeCompare(b.id));
  $("#train-table-count").textContent = `${trains.length}本`;
  const html =
    trains
      .map(
        (t) =>
          `<tr data-train="${t.id}" tabindex="0" class="${selectedTrain === t.id ? "selected" : ""}" aria-label="${t.id}を選択"><td><span class="table-train-icon" style="color:${lineById(t.line).color}">▰</span>${t.id}${t.reverse ? " ↶" : ""}</td><td><span class="train-type ${t.type}">${t.type === "rapid" ? "快速" : "普通"}</span></td><td>${STATIONS[t.path[t.index]].name}${["running", "blocked"].includes(t.status) ? ` → ${STATIONS[t.path[t.index + 1]].name}` : ""}<small>${t.reason}</small></td><td style="color:${statusColor(t.delay)}">${t.delay ? `+${minutes(t.delay)}` : "定刻"}</td><td><span class="load-bar"><i style="width:${Math.min(100, (t.passengers / CAPACITY) * 60)}%;background:${t.passengers > CAPACITY ? "#d5ac69" : "#6cae9a"}"></i></span>${number((t.passengers / CAPACITY) * 100)}%</td></tr>`,
      )
      .join("") ||
    '<tr><td colspan="5" class="empty-state">該当する列車はありません。</td></tr>';
  if (
    html !== renderedTable &&
    !$("#train-table").contains(document.activeElement)
  ) {
    $("#train-table").innerHTML = html;
    renderedTable = html;
  }
}
function renderLogs() {
  const key = sim.logs[0]?.id;
  if (renderedLog === key) return;
  renderedLog = key;
  $("#logs").innerHTML = sim.logs
    .slice(0, 25)
    .map(
      (l) =>
        `<div class="log-entry ${l.level}"><time>${clock(l.time).slice(0, 8)}</time><p>${escape(l.message)}</p></div>`,
    )
    .join("");
}
function render() {
  const started = performance.now();
  $("#clock").textContent = clock(sim.time);
  $("#score").textContent = number(sim.score);
  $("#grade").textContent = sim.grade;
  $("#grade").dataset.grade = sim.grade;
  $("#score-bar").style.width = `${sim.score / 1000}%`;
  $("#delayed").textContent = sim.delayedTrains.length;
  $("#active-count").textContent = `/ ${sim.liveTrains.length}本`;
  $("#max-delay").textContent = (sim.maxDelay / 60).toFixed(1);
  $("#waiting").textContent = number(sim.waiting);
  $("#loss").textContent = number(sim.loss / 60);
  $("#progress").style.width = `${(sim.time / sim.scenario.duration) * 100}%`;
  $("#run-state").textContent = sim.ended
    ? "演習終了"
    : running
      ? `運行中・${speed}倍速`
      : "一時停止・指令操作可能";
  for (const l of sim.lines) {
    const ts = sim.liveTrains.filter((t) => t.line === l.id),
      d = ts.length ? Math.max(...ts.map((t) => t.delay)) : 0;
    $(`#line-status-${l.id}`).textContent =
      d >= 180 ? "大幅な遅れ" : d >= 60 ? "遅れあり" : "平常運転";
    $(`#line-status-${l.id}`).style.color = statusColor(d);
    $(`#line-delay-${l.id}`).textContent =
      d >= 60 ? `+${(d / 60).toFixed(0)}分` : "●";
    $(`#line-delay-${l.id}`).style.color = statusColor(d);
  }
  const incidents = sim.incidents.filter((i) => i.until > sim.time);
  $("#incident-summary").innerHTML = incidents.length
    ? incidents
        .slice(0, 2)
        .map(
          (i) =>
            `<h3>${STATIONS[i.station].name}駅 <span>${i.kind}</span></h3><p>${lineById(i.line).name}<br>運転再開まで 約${Math.max(1, Math.ceil((i.until - sim.time) / 60))}分</p>`,
        )
        .join("")
    : '<h3 class="recovered">運行障害は解消</h3><p>残る遅延と旅客滞留の回復を目指してください。</p>';
  $("#locate").disabled = !incidents.length;
  renderMap();
  renderStation();
  renderTable();
  renderCommand();
  renderLogs();
  renderDiagram();
  renderDurations.push(performance.now() - started);
  if (renderDurations.length > 300) renderDurations.shift();
}
function setRunning(value) {
  running = value && !sim.ended;
  $("#play").innerHTML = running
    ? `${icons.pause}<span>一時停止</span>`
    : `${icons.play}<span>${sim.time ? "再開" : "演習開始"}</span>`;
  $("#play").disabled = sim.ended;
  $("#step").disabled = sim.ended;
  $("#play").classList.toggle("playing", running);
}
function reset() {
  const seed = Number($("#seed").value),
    scenario = $("#scenario").value;
  try {
    sim = new Simulation({ scenario, seed });
  } catch (e) {
    toast(e.message, true);
    return;
  }
  selectedLine = sim.scenario.incidentLine;
  selectedStation = sim.scenario.incidentStation;
  selectedCommand = sim.connections.length ? "cut" : "skip";
  renderedLog = "";
  renderedTable = "";
  accumulator = 0;
  $("#seed-label").textContent = seed;
  $("#progress-label").textContent =
    `演習終了 ${clock(sim.scenario.duration).slice(0, 5)}`;
  pickInitialTrain();
  setRunning(false);
  renderRoutes();
  renderCommand(true);
  render();
}
function showResults() {
  setRunning(false);
  $("#result-body").innerHTML =
    `<div class="result-score"><span class="grade">${sim.grade}</span><strong>${number(sim.score)}<small>点</small></strong></div><p>${{ S: "伝説の首席指令員", A: "熟練指令員", B: "中堅指令員", C: "駆け出し指令員", F: "輸送崩壊" }[sim.grade]}</p><dl><div><dt>累積旅客損失</dt><dd>${number(sim.loss / 60)} 人・分相当</dd></div><div><dt>5分以上遅延</dt><dd>${sim.affected.size} 本</dd></div><div><dt>最大遅延</dt><dd>${minutes(sim.maxDelay)}</dd></div><div><dt>整理指令</dt><dd>${sim.commandLog.length} 件 / ペナルティ ${sim.penalty}</dd></div><div><dt>混雑上限を超えた駅</dt><dd>${sim.overflow.size} 駅</dd></div><div><dt>目的駅到着旅客</dt><dd>${number(sim.delivered)} 人</dd></div></dl>`;
  $("#results").showModal();
}
function exportReplay() {
  const blob = new Blob([JSON.stringify(sim.exportReplay(), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = `dispatch-${sim.scenarioId}-${sim.seed}-${sim.time}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("シードと指令履歴をJSONで書き出しました。");
}
function selectTrain(id) {
  const t = sim.trainsById.get(id);
  if (!t) return;
  if (selectedLine !== t.line) {
    selectedLine = t.line;
    renderRoutes();
  }
  selectedTrain = id;
  selectedStation = t.path[t.index];
  renderRoutes();
  renderCommand(true);
  render();
}

$("#play").addEventListener("click", () => {
  setRunning(!running);
  render();
});
$("#speed").addEventListener("change", (e) => {
  speed = Number(e.target.value);
  render();
});
$("#step").addEventListener("click", () => {
  setRunning(false);
  sim.advance(10);
  render();
  if (sim.ended) showResults();
});
$("#reset").addEventListener("click", () => {
  setRunning(false);
  if (sim.time > 0 || sim.commandLog.length) $("#restart-confirm").showModal();
  else reset();
});
$("#restart-cancel").addEventListener("click", () =>
  $("#restart-confirm").close(),
);
$("#restart-accept").addEventListener("click", () => {
  $("#restart-confirm").close();
  reset();
});
$("#scenario").addEventListener("change", () =>
  toast("「最初から」で選択したシナリオを開始します。"),
);
$("#issue").addEventListener("click", () => {
  const result = sim.issue(currentCommand());
  toast(result.message, !result.ok);
  render();
});
$("#train-select").addEventListener("change", (e) => {
  selectedTrain = e.target.value;
  renderCommand(true);
  render();
});
$("#only-delayed").addEventListener("change", renderTable);
$(".command-grid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-command]");
  if (b) {
    selectedCommand = b.dataset.command;
    renderCommandFields();
    validateCommand();
  }
});
$("#line-list").addEventListener("click", (e) => {
  const b = e.target.closest("[data-line]");
  if (b) chooseLine(b.dataset.line);
});
function delegatedSelect(e) {
  const t = e.target.closest("[data-train]");
  if (t) return selectTrain(t.dataset.train);
  const s = e.target.closest("[data-station]");
  if (s && sim.stations[s.dataset.station]) {
    selectedStation = s.dataset.station;
    renderRoutes();
    renderStation();
  }
}
for (const el of [$("#network"), $("#train-table"), $("#diagram")]) {
  el.addEventListener("click", delegatedSelect);
  el.addEventListener("keydown", (e) => {
    if (["Enter", " "].includes(e.key)) {
      e.preventDefault();
      delegatedSelect(e);
    }
  });
}
$("#locate").addEventListener("click", () => {
  const i = sim.incidents.find((i) => i.until > sim.time);
  if (i) {
    chooseLine(i.line);
    selectedStation = i.station;
    pickInitialTrain();
    renderRoutes();
    renderCommand(true);
    render();
  }
});
$("#all-lines").addEventListener("click", () => {
  mapMode = "network";
  $("#all-lines").classList.add("active");
  $("#focus-line").classList.remove("active");
  renderRoutes();
  renderMap();
});
$("#focus-line").addEventListener("click", () => {
  mapMode = "line";
  $("#focus-line").classList.add("active");
  $("#all-lines").classList.remove("active");
  renderRoutes();
  renderMap();
});
$("#heat").addEventListener("click", () => {
  heatmap = !heatmap;
  $("#heat").classList.toggle("active", heatmap);
  $("#heat").setAttribute("aria-pressed", heatmap);
  renderMap();
});
$("#help").addEventListener("click", () => {
  setRunning(false);
  $("#guide").showModal();
});
$(".dialog-close").addEventListener("click", () => $("#guide").close());
$(".guide-start").addEventListener("click", () => $("#guide").close());
$("#export").addEventListener("click", exportReplay);
$("#result-export").addEventListener("click", exportReplay);
$("#result-restart").addEventListener("click", () => {
  $("#results").close();
  reset();
});
$("#result-close").addEventListener("click", () => $("#results").close());
$("#import").addEventListener("click", () => {
  setRunning(false);
  $("#replay-file").click();
});
$("#replay-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    if (file.size > 2_000_000)
      throw new Error("記録ファイルは2MB以下にしてください。");
    const restored = Simulation.replay(JSON.parse(await file.text()));
    sim = restored;
    selectedLine = sim.scenario.incidentLine;
    selectedStation = sim.scenario.incidentStation;
    $("#scenario").value = sim.scenarioId;
    $("#seed").value = sim.seed;
    $("#seed-label").textContent = sim.seed;
    $("#progress-label").textContent =
      `演習終了 ${clock(sim.scenario.duration).slice(0, 5)}`;
    renderedLog = "";
    accumulator = 0;
    pickInitialTrain();
    setRunning(false);
    renderRoutes();
    renderCommand(true);
    render();
    toast("演習記録を再現しました。");
  } catch (err) {
    toast(`読み込めません：${err.message}`, true);
  }
  e.target.value = "";
});
document.addEventListener("keydown", (e) => {
  if (
    ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(e.target.tagName) ||
    $("dialog[open]")
  )
    return;
  if (e.code === "Space") {
    e.preventDefault();
    setRunning(!running);
    render();
  }
  if (e.key === "?") {
    setRunning(false);
    $("#guide").showModal();
  }
});
let drag = null;
$("#diagram").addEventListener("pointerdown", (e) => {
  const point = e.target.closest("[data-diagram-train]");
  if (!point) return;
  const diagram = $("#diagram"),
    wasRunning = running;
  setRunning(false);
  drag = {
    trainId: point.dataset.diagramTrain,
    startX: e.clientX,
    wasRunning,
    rect: diagram.getBoundingClientRect(),
  };
  diagram.setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("#diagram").addEventListener("pointerup", (e) => {
  if (!drag) return;
  const d = drag;
  drag = null;
  const seconds =
    Math.round(
      (((e.clientX - d.startX) / d.rect.width) *
        900 *
        Number($("#diagram").dataset.secondsPerUnit)) /
        10,
    ) * 10;
  if (seconds >= 10) {
    const result = sim.issue({
      type: "hold",
      trainId: d.trainId,
      seconds: Math.min(300, seconds),
    });
    toast(result.message, !result.ok);
    selectTrain(d.trainId);
  } else {
    selectTrain(d.trainId);
    toast("点を右にドラッグすると10〜300秒の延発を設定できます。");
  }
  render();
});
$("#diagram").addEventListener("pointercancel", () => {
  drag = null;
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    setRunning(false);
    accumulator = 0;
  }
});
function frame(now) {
  const elapsed = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running) {
    accumulator += elapsed * speed;
    const ticks = Math.floor(accumulator);
    accumulator -= ticks;
    if (ticks) sim.advance(ticks);
    if (sim.ended) showResults();
    if (now - lastUi > 180 || sim.ended) {
      render();
      lastUi = now;
    }
    // Move the existing SVG markers every display frame; simulation remains 1 Hz.
    for (const marker of $$("#train-layer [data-train]")) {
      const train = sim.trainsById.get(marker.dataset.train);
      if (!train) continue;
      const p = trainPosition(train, sim.time + accumulator);
      marker.setAttribute(
        "transform",
        `translate(${p.x.toFixed(2)},${p.y.toFixed(2)})`,
      );
    }
  }
  requestAnimationFrame(frame);
}
pickInitialTrain();
renderRoutes();
renderCommand(true);
render();
requestAnimationFrame(frame);
// Read-only diagnostics for performance inspection; no simulation mutation API.
window.dispatchDiagnostics = () => ({
  scenario: sim.scenarioId,
  time: sim.time,
  score: sim.score,
  commands: sim.commandLog.length,
  liveTrains: sim.liveTrains.length,
  renderMs: renderDurations.slice(),
  replay: sim.exportReplay(),
});
