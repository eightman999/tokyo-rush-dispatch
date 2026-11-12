import {
  STATIONS,
  LINES,
  CONNECTIONS,
  SCENARIOS,
  COMMANDS,
  lineById,
} from "./network.js";

export const HEADWAY = 120;
export const RUN_TIME = 150;
export const DWELL = 30;
export const CAPACITY = 1200;
export const SCORE_WEIGHTS = {
  loss: 0.0007,
  affected: 75,
  maxDelay: 3,
  command: 12,
};
export const grade = (score) =>
  score >= 90000
    ? "S"
    : score >= 75000
      ? "A"
      : score >= 60000
        ? "B"
        : score >= 40000
          ? "C"
          : "F";
export function calculateScore(loss, affected, maxDelay, penalty) {
  return Math.max(
    0,
    Math.round(
      100000 -
        SCORE_WEIGHTS.loss * loss -
        SCORE_WEIGHTS.affected * affected -
        SCORE_WEIGHTS.maxDelay * maxDelay -
        SCORE_WEIGHTS.command * penalty,
    ),
  );
}
export function passengerLoss(platforms, trains, dt = 1) {
  return (
    dt *
    (platforms.reduce((sum, s) => sum + s, 0) +
      trains.reduce((sum, t) => {
        const stopped =
          t.status === "blocked" ? (t.blockedFor >= 300 ? 8 : 3) : 1;
        return (
          sum +
          t.passengers * 0.65 * stopped * (1 + (t.passengers / CAPACITY) ** 2)
        );
      }, 0))
  );
}
export function maxPlusDeparture({
  actualArrival,
  dwell,
  previousDeparture = -Infinity,
  connectionDeparture = -Infinity,
  buffer = 0,
  plannedDeparture = -Infinity,
  holdUntil = -Infinity,
}) {
  return Math.max(
    actualArrival + dwell,
    previousDeparture + HEADWAY,
    connectionDeparture + buffer,
    plannedDeparture,
    holdUntil,
  );
}
const active = (t) => !["done", "cancelled", "pending"].includes(t.status);

export class Simulation {
  constructor({
    scenario = "network",
    seed = 20261112,
    randomIncidents = true,
    initialIncident = true,
  } = {}) {
    if (!SCENARIOS[scenario]) throw new Error("不明なシナリオ");
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)
      throw new Error("シードは0〜4294967295の整数");
    this.scenarioId = scenario;
    this.scenario = SCENARIOS[scenario];
    this.seed = seed;
    this.rngState = seed >>> 0;
    this.randomIncidents = randomIncidents;
    this.initialIncident = initialIncident;
    this.time = -2400;
    this.loss = 0;
    this.maxDelay = 0;
    this.penalty = 0;
    this.delivered = 0;
    this.commandLog = [];
    this.logs = [];
    this.incidents = [];
    this.affected = new Set();
    this.overflow = new Set();
    this.lastDeparture = new Map();
    this.cutConnections = new Set();
    this.priorityPairs = new Map();
    this.sequence = 0;
    this.lines = LINES.filter((l) => this.scenario.lines.includes(l.id));
    this.connections = CONNECTIONS.filter(
      (c) =>
        this.scenario.lines.includes(c.from) &&
        this.scenario.lines.includes(c.to),
    );
    const stationIds = [...new Set(this.lines.flatMap((l) => l.stations))];
    this.stations = Object.fromEntries(
      stationIds.map((id) => {
        const boardsHere = this.lines.some(
          (l) => l.stations.includes(id) && l.stations.at(-1) !== id,
        );
        return [
          id,
          {
            ...STATIONS[id],
            id,
            waiting: boardsHere ? 120 : 0,
            demand: boardsHere ? STATIONS[id].demand : 0,
            fraction: 0,
          },
        ];
      }),
    );
    this.trains = [];
    // Align connected planned services so a punctual connection adds no delay.
    const offsets = {};
    for (const l of this.lines) {
      offsets[l.id] = 0;
      for (const c of this.connections.filter((c) => c.to === l.id)) {
        const from = lineById(c.from);
        offsets[l.id] =
          offsets[c.from] +
          from.stations.indexOf(c.station) * (RUN_TIME + DWELL) +
          c.buffer -
          l.stations.indexOf(c.station) * (RUN_TIME + DWELL);
      }
      for (let k = -32; k < 22; k++) {
        const id = `${l.code}${String(k + 40).padStart(3, "0")}`;
        const start = k * HEADWAY + offsets[l.id];
        this.trains.push({
          id,
          line: l.id,
          k,
          type: (k + 40) % 4 === 0 ? "rapid" : "local",
          path: [...l.stations],
          plan: l.stations.map((_, i) => start + i * (RUN_TIME + DWELL)),
          history: [],
          index: 0,
          status: "pending",
          passengers: 0,
          arrival: 0,
          due: start,
          delay: 0,
          blockedFor: 0,
          holdUntil: -Infinity,
          skips: [],
          turnbackAt: null,
          reverse: false,
          reason: "定刻",
          primaryUntil: -Infinity,
          priorityFor: null,
        });
      }
    }
    this.trainsById = new Map(this.trains.map((t) => [t.id, t]));
    this.time = Math.min(...this.trains.map((t) => t.plan[0])) - DWELL - 1;
    while (this.time < 0) this.tick(true);
    this.loss = 0;
    this.maxDelay = Math.max(0, ...this.liveTrains.map((t) => t.delay));
    this.delivered = 0;
    this.affected.clear();
    this.overflow.clear();
    this.log(
      "info",
      "朝ラッシュ指令を開始。路線・列車を選び、運転整理を行ってください。",
    );
    if (initialIncident)
      this.injectIncident(
        this.scenario.incidentLine,
        this.scenario.incidentStation,
        this.scenario.severity,
        "ドア点検",
      );
  }
  random() {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let x = this.rngState;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  }
  log(level, message) {
    this.logs.unshift({ id: this.sequence++, time: this.time, level, message });
    this.logs = this.logs.slice(0, 120);
  }
  get ended() {
    return this.time >= this.scenario.duration;
  }
  get score() {
    return calculateScore(
      this.loss,
      this.affected.size,
      this.maxDelay,
      this.penalty,
    );
  }
  get grade() {
    return grade(this.score);
  }
  get liveTrains() {
    return this.trains.filter(active);
  }
  get delayedTrains() {
    return this.liveTrains.filter((t) => t.delay >= 60);
  }
  get waiting() {
    return Object.values(this.stations).reduce((n, s) => n + s.waiting, 0);
  }
  advance(seconds = 1) {
    for (let i = 0; i < seconds && !this.ended; i++) this.tick();
  }
  injectIncident(line, stationId, duration, kind = "急病人救護") {
    const incident = {
      id: `incident-${this.sequence++}`,
      line,
      station: stationId,
      start: this.time,
      until: this.time + duration,
      kind,
    };
    this.incidents.push(incident);
    this.log(
      "alert",
      `${lineById(line).name} ${STATIONS[stationId].name}駅：${kind}。約${Math.ceil(duration / 60)}分の運転見合わせ。`,
    );
    return incident;
  }
  hasBlock(line, station) {
    return this.incidents.find(
      (i) => i.line === line && i.station === station && i.until > this.time,
    );
  }
  occupied(line, index, reverse, except) {
    return this.trains.filter(
      (t) =>
        t !== except &&
        t.line === line &&
        t.reverse === reverse &&
        t.index === index &&
        t.status === "dwelling",
    );
  }
  key(t, index = t.index) {
    return `${t.line}:${t.reverse ? "reverse" : "forward"}:${index}`;
  }
  connectionFor(t) {
    return (
      !t.reverse &&
      this.connections.find(
        (c) =>
          c.to === t.line &&
          c.station === t.path[t.index] &&
          !this.cutConnections.has(c.id),
      )
    );
  }
  connectionDeparture(t) {
    const c = this.connectionFor(t);
    if (!c) return { departure: -Infinity, buffer: 0 };
    const feeder = this.trains.find(
      (f) => f.line === c.from && f.k === t.k && !f.reverse,
    );
    if (!feeder || feeder.status === "cancelled")
      return { departure: -Infinity, buffer: 0 };
    const idx = feeder.path.indexOf(c.station);
    // A short-turned service cannot provide a connection beyond its terminal.
    if (idx < 0 || (feeder.turnbackAt !== null && idx > feeder.turnbackAt))
      return { departure: -Infinity, buffer: 0 };
    return {
      departure: feeder.history[idx]?.departure ?? Infinity,
      buffer: c.buffer,
    };
  }
  tick(warmup = false) {
    this.time++;
    for (const s of Object.values(this.stations)) {
      s.fraction += s.demand * (warmup ? 0.7 : 1);
      const added = Math.floor(s.fraction);
      s.fraction -= added;
      s.waiting += added;
      // Cut direct services force additional transfers at the boundary.
      if (!warmup && this.cutConnections.has(s.id) && this.time % 10 === 0)
        s.waiting += 16;
      if (!warmup && s.waiting > s.capacity) this.overflow.add(s.id);
    }
    if (
      !warmup &&
      this.randomIncidents &&
      this.random() < this.scenario.randomRate
    ) {
      const l = this.lines[Math.floor(this.random() * this.lines.length)];
      const sid =
        l.stations[1 + Math.floor(this.random() * (l.stations.length - 2))];
      const kinds = ["急病人救護", "ドア再開閉", "車両点検", "線路内立ち入り"];
      this.injectIncident(
        l.id,
        sid,
        60 + Math.floor(this.random() * 180),
        kinds[Math.floor(this.random() * kinds.length)],
      );
    }
    for (const i of this.incidents)
      if (i.until === this.time)
        this.log(
          "success",
          `${STATIONS[i.station].name}駅：${i.kind}終了。順次運転を再開。`,
        );
    // First update arrivals. Two platform tracks at sidings permit overtaking.
    for (const t of this.trains) {
      if (t.status === "pending" && this.time >= t.plan[0] - DWELL) {
        if (this.occupied(t.line, 0, t.reverse, t).length < 1)
          this.arrive(t, warmup);
      } else if (
        (t.status === "running" || t.status === "blocked") &&
        this.time >= t.due
      ) {
        const next = t.index + 1;
        const sid = t.path[next];
        const slots = STATIONS[sid].siding ? 2 : 1;
        if (
          this.occupied(t.line, next, t.reverse, t).length >= slots ||
          this.hasBlock(t.line, sid)
        ) {
          t.status = "blocked";
          t.blockedFor++;
          t.reason = this.hasBlock(t.line, sid)
            ? "前方障害・駅間抑止"
            : "前方ホーム支障";
        } else {
          t.index = next;
          this.arrive(t, warmup);
        }
      }
    }
    // Priority services are evaluated first, retaining a safe station headway.
    const candidates = this.trains
      .filter((t) => t.status === "dwelling")
      .sort(
        (a, b) =>
          Number(!!b.priorityFor) - Number(!!a.priorityFor) ||
          a.plan[a.index] - b.plan[b.index] ||
          a.id.localeCompare(b.id),
      );
    for (const t of candidates) {
      const sid = t.path[t.index];
      const block = this.hasBlock(t.line, sid);
      const conn = this.connectionDeparture(t);
      const predecessor = this.lastDeparture.get(this.key(t)) ?? -Infinity;
      const orderedAfter = this.priorityPairs.get(`${t.id}:${sid}`);
      const orderedTrain = orderedAfter && this.trainsById.get(orderedAfter);
      const orderedDeparture = orderedTrain
        ? orderedTrain.history[orderedTrain.path.indexOf(sid)]?.departure
        : undefined;
      const waitForPriority = orderedAfter && orderedDeparture === undefined;
      const ready = maxPlusDeparture({
        actualArrival: t.arrival,
        dwell: t.dwell,
        previousDeparture: predecessor,
        plannedDeparture: t.plan[t.index],
        connectionDeparture: conn.departure,
        buffer: conn.buffer,
        holdUntil: Math.max(
          t.holdUntil,
          block?.until ?? -Infinity,
          orderedDeparture !== undefined
            ? orderedDeparture + HEADWAY
            : -Infinity,
        ),
      });
      t.reason = block
        ? block.kind
        : waitForPriority
          ? "快速先行・待避"
          : conn.departure === Infinity ||
              conn.departure + conn.buffer > this.time
            ? "直通接続待ち"
            : predecessor + HEADWAY > this.time
              ? "先行列車との間隔確保"
              : t.holdUntil > this.time
                ? "指令による延発"
                : "客扱い";
      if (!waitForPriority && this.time >= ready) this.depart(t, warmup);
    }
    for (const t of this.trains.filter(active)) {
      const at =
        t.status === "running" || t.status === "blocked"
          ? t.index + 1
          : t.index;
      const target =
        t.status === "running" || t.status === "blocked"
          ? t.plan[at] - DWELL
          : t.plan[at];
      t.delay = Math.max(
        0,
        this.time - target,
        t.history[t.index]?.departure !== undefined
          ? t.history[t.index].departure - t.plan[t.index]
          : 0,
      );
      if (!warmup) {
        this.maxDelay = Math.max(this.maxDelay, t.delay);
        if (t.delay >= 300) this.affected.add(t.id);
      }
    }
    if (!warmup)
      this.loss += passengerLoss(
        Object.values(this.stations).map((s) => s.waiting),
        this.liveTrains,
      );
  }
  arrive(t, warmup) {
    t.status = "dwelling";
    t.arrival = this.time;
    t.blockedFor = 0;
    const sid = t.path[t.index];
    const skipping = t.skips.includes(sid);
    const exit = skipping
      ? 0
      : Math.floor(t.passengers * (t.index === t.path.length - 1 ? 1 : 0.18));
    t.passengers -= exit;
    if (!warmup) this.delivered += exit;
    t.dwell = skipping
      ? 1
      : DWELL + Math.min(45, Math.floor(this.stations[sid].waiting / 100));
    t.history[t.index] = {
      arrival: this.time,
      departure: undefined,
      skipped: skipping,
    };
  }
  depart(t, warmup) {
    const sid = t.path[t.index];
    t.history[t.index].departure = this.time;
    this.lastDeparture.set(this.key(t), this.time);
    this.priorityPairs.delete(`${t.id}:${sid}`);
    t.priorityFor = null;
    if (t.index === t.path.length - 1) {
      t.status = "done";
      return;
    }
    if (t.turnbackAt === t.index) {
      const originalId = `${t.id}R`;
      this.stations[sid].waiting += t.passengers;
      t.passengers = 0;
      t.status = "done";
      const path = t.path.slice(0, t.index + 1).reverse();
      const start = this.time + 90;
      const reverse = {
        ...t,
        id: originalId,
        path,
        index: 0,
        reverse: true,
        plan: path.map((_, i) => start + i * (RUN_TIME + DWELL)),
        history: [],
        status: "pending",
        due: start,
        turnbackAt: null,
        holdUntil: -Infinity,
        skips: [],
        delay: 0,
      };
      this.trains.push(reverse);
      this.trainsById.set(reverse.id, reverse);
      this.log(
        "info",
        `${t.id}：${STATIONS[sid].name}で折り返し。救済列車 ${originalId} を設定。`,
      );
      return;
    }
    if (!t.skips.includes(sid)) {
      const board = Math.min(
        this.stations[sid].waiting,
        Math.floor(CAPACITY * 1.65) - t.passengers,
        t.dwell * 25,
      );
      this.stations[sid].waiting -= board;
      t.passengers += board;
    }
    t.status = "running";
    t.reason = "走行中";
    t.due = this.time + RUN_TIME;
  }
  validate(command) {
    const t = this.trainsById.get(command.trainId);
    if (command.type === "cut") {
      const c = this.connections.find((c) => c.id === command.connectionId);
      if (!c) return "このシナリオには該当する直通接続がありません。";
      if (this.cutConnections.has(c.id))
        return "この境界駅では直通運転を中止済みです。";
      return null;
    }
    if (!t || !active(t)) return "運行中の列車を選択してください。";
    if (command.type === "cancel") return null;
    if (command.type === "hold") {
      if (t.status !== "dwelling")
        return "延発は停車中の列車に指示してください。";
      if (
        !Number.isInteger(command.seconds) ||
        command.seconds < 10 ||
        command.seconds > 300
      )
        return "延発時間は10〜300秒で指定してください。";
      return null;
    }
    const index = command.stationId
      ? t.path.indexOf(command.stationId)
      : t.index + 1;
    if (
      index < t.index ||
      index >= t.path.length ||
      (index === t.index && t.status !== "dwelling")
    )
      return "現在駅またはこれから停車する駅を選択してください。";
    const sid = t.path[index];
    if (command.type === "skip") {
      if (
        index === 0 ||
        index === t.path.length - 1 ||
        this.connections.some((c) => c.station === sid)
      )
        return "始終着駅・直通境界駅は通過できません。";
      if (index === t.index) return "客扱い開始後は通過に変更できません。";
      if (t.skips.includes(sid)) return "この駅は既に通過設定されています。";
      return null;
    }
    if (command.type === "turnback") {
      if (t.reverse) return "救済列車には折り返しを重複設定できません。";
      if (t.turnbackAt !== null) return "折り返し設定済みです。";
      if (!STATIONS[sid].turnback || index === 0 || index === t.path.length - 1)
        return "渡り線のある中間駅を選択してください。";
      return null;
    }
    if (command.type === "priority") {
      if (!STATIONS[sid].siding) return "この駅には待避設備がありません。";
      const local = this.findLocal(t, index);
      if (t.type !== "rapid" || !local)
        return "快速を選び、同じ待避駅に停車・接近中の普通列車を指定してください。";
      if (this.priorityPairs.has(`${local.id}:${sid}`))
        return "この駅は順序変更済みです。";
      return null;
    }
    return "不明な指令です。";
  }
  findLocal(rapid, index) {
    return this.liveTrains.find(
      (t) =>
        t.id !== rapid.id &&
        t.line === rapid.line &&
        t.reverse === rapid.reverse &&
        t.type === "local" &&
        t.index <= index &&
        t.index >= index - 1 &&
        (t.index < index || t.status === "dwelling"),
    );
  }
  issue(command, record = true) {
    if (this.ended)
      return {
        ok: false,
        message: "演習は終了しています。再開するには最初から開始してください。",
      };
    const error = this.validate(command);
    if (error) return { ok: false, message: error };
    const t = this.trainsById.get(command.trainId);
    const index =
      t &&
      (command.stationId ? t.path.indexOf(command.stationId) : t.index + 1);
    let message;
    if (command.type === "cut") {
      const c = this.connections.find((c) => c.id === command.connectionId);
      this.cutConnections.add(c.id);
      this.stations[c.station].waiting += 350;
      this.penalty += 120;
      message = `${c.name}：直通運転中止。接続待ちを解除し、乗換対応へ移行。`;
    } else if (command.type === "cancel") {
      const sid =
        t.path[
          Math.min(
            t.index +
              (t.status === "running" || t.status === "blocked" ? 1 : 0),
            t.path.length - 1,
          )
        ];
      this.stations[sid].waiting += t.passengers;
      t.passengers = 0;
      t.status = "cancelled";
      this.penalty += 160;
      for (const [key, id] of this.priorityPairs)
        if (id === t.id) this.priorityPairs.delete(key);
      message = `${t.id}：間引き運休。乗客は${STATIONS[sid].name}で振替待機。`;
    } else if (command.type === "turnback") {
      t.turnbackAt = index;
      this.penalty += 80;
      message = `${t.id}：${STATIONS[t.path[index]].name}で部分折り返しを設定。`;
    } else if (command.type === "skip") {
      t.skips.push(t.path[index]);
      this.penalty += 25;
      message = `${t.id}：${STATIONS[t.path[index]].name}を通過に変更。`;
    } else if (command.type === "priority") {
      const local = this.findLocal(t, index);
      this.priorityPairs.set(`${local.id}:${t.path[index]}`, t.id);
      t.priorityFor = local.id;
      message = `${STATIONS[t.path[index]].name}：快速${t.id}を普通${local.id}より先行。`;
    } else if (command.type === "hold") {
      t.holdUntil = Math.max(this.time, t.holdUntil) + command.seconds;
      message = `${t.id}：${command.seconds}秒延発。運転間隔を調整。`;
    }
    if (record) this.commandLog.push({ ...command, time: this.time });
    this.log("command", message);
    return { ok: true, message };
  }
  snapshot() {
    return {
      time: this.time,
      loss: this.loss,
      score: this.score,
      maxDelay: this.maxDelay,
      penalty: this.penalty,
      waiting: this.waiting,
      delivered: this.delivered,
      trains: this.trains.map((t) => [
        t.id,
        t.status,
        t.index,
        t.passengers,
        t.delay,
        t.history.map((h) => h && [h.arrival, h.departure]),
      ]),
    };
  }
  exportReplay() {
    return {
      version: 1,
      scenario: this.scenarioId,
      seed: this.seed,
      randomIncidents: this.randomIncidents,
      initialIncident: this.initialIncident,
      time: this.time,
      commands: this.commandLog.map((c) => ({ ...c })),
    };
  }
  static replay(data) {
    if (
      !data ||
      data.version !== 1 ||
      !SCENARIOS[data.scenario] ||
      !Number.isInteger(data.time) ||
      data.time < 0 ||
      data.time > SCENARIOS[data.scenario].duration ||
      !Array.isArray(data.commands) ||
      data.commands.length > 5000
    )
      throw new Error("対応する演習記録ではありません。");
    const sim = new Simulation(data);
    let previous = 0;
    for (const c of data.commands) {
      if (!Number.isInteger(c.time) || c.time < previous || c.time > data.time)
        throw new Error("指令時刻が不正です。");
      sim.advance(c.time - sim.time);
      const result = sim.issue(c);
      if (!result.ok)
        throw new Error(`記録中の指令が無効です：${result.message}`);
      previous = c.time;
    }
    sim.advance(data.time - sim.time);
    return sim;
  }
}
