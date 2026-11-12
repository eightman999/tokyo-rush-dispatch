import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Simulation,
  maxPlusDeparture,
  passengerLoss,
  calculateScore,
  grade,
  HEADWAY,
  CAPACITY,
} from "../src/engine.js";

const fresh = (extra = {}) =>
  new Simulation({
    scenario: "local",
    randomIncidents: false,
    initialIncident: false,
    ...extra,
  });
function isolatedTrain(
  sim,
  { type = "local", index = 2, id = "TEST", plan = 0, dwelling = true } = {},
) {
  const t = structuredClone(sim.trains.find((t) => t.line === "chuo"));
  Object.assign(t, {
    id,
    type,
    status: dwelling ? "dwelling" : "running",
    index,
    plan: t.path.map((_, i) => plan + (i - index) * 180),
    history: [],
    arrival: -60,
    dwell: 30,
    delay: 0,
    passengers: 800,
    holdUntil: -Infinity,
    turnbackAt: null,
    primaryUntil: -Infinity,
    due: 1,
    reverse: false,
    skips: [],
    priorityFor: null,
  });
  for (let i = 0; i <= index; i++)
    t.history[i] = {
      arrival: -200,
      departure: i === index && dwelling ? undefined : -150,
    };
  sim.trains.push(t);
  sim.trainsById.set(id, t);
  return t;
}
function empty(sim) {
  sim.trains = [];
  sim.trainsById.clear();
  sim.lastDeparture.clear();
}

test("TC-001: max-plus uses actual arrival, dwell, headway and connection constraints", () => {
  assert.equal(
    maxPlusDeparture({ actualArrival: 30, dwell: 40, previousDeparture: 100 }),
    220,
  );
  assert.equal(
    maxPlusDeparture({ actualArrival: 200, dwell: 40, previousDeparture: 0 }),
    240,
  );
  assert.equal(
    maxPlusDeparture({
      actualArrival: 30,
      dwell: 40,
      connectionDeparture: 300,
      buffer: 35,
    }),
    335,
  );
  assert.equal(
    maxPlusDeparture({
      actualArrival: 30,
      dwell: 40,
      plannedDeparture: 400,
      holdUntil: 500,
    }),
    500,
  );
});
test("TC-001: all actual departures preserve 120s headway under disruption", () => {
  const s = fresh({ initialIncident: true });
  s.advance(800);
  for (let index = 0; index < 7; index++) {
    const departures = s.trains
      .map((t) => t.history[index]?.departure)
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    for (let i = 1; i < departures.length; i++)
      assert.ok(
        departures[i] - departures[i - 1] >= HEADWAY,
        `station ${index}: ${departures[i - 1]} to ${departures[i]}`,
      );
  }
  assert.ok(s.delayedTrains.length >= 2, "primary delay must affect followers");
});
test("TC-002: cut through operations removes feeder constraint, increases waiting and penalty", () => {
  const s = fresh({ scenario: "through", initialIncident: true });
  const t = s.trains.find((t) => t.line === "tozai" && t.index === 0);
  assert.ok(t);
  const before = s.stations.nakano.waiting;
  assert.ok(s.connectionFor(t));
  assert.equal(s.issue({ type: "cut", connectionId: "nakano" }).ok, true);
  assert.ok(!s.connectionFor(t));
  assert.equal(s.connectionDeparture(t).departure, -Infinity);
  assert.equal(s.stations.nakano.waiting, before + 350);
  assert.equal(s.penalty, 120);
  const snapshot = s.snapshot();
  assert.equal(s.issue({ type: "cut", connectionId: "nakano" }).ok, false);
  assert.deepEqual(s.snapshot(), snapshot);
});
test("TC-002: cut isolates downstream delays compared with connected baseline", () => {
  const baseline = fresh({ scenario: "through", initialIncident: true });
  const cut = fresh({ scenario: "through", initialIncident: true });
  cut.issue({ type: "cut", connectionId: "nakano" });
  baseline.advance(500);
  cut.advance(500);
  const downstream = (s) =>
    s.trains
      .filter((t) => t.line === "tozai")
      .reduce((sum, t) => sum + t.delay, 0);
  assert.ok(downstream(cut) < downstream(baseline));
});
test("TC-003: rapid departs before local after reordering at a siding", () => {
  const s = fresh();
  const template = structuredClone(s.trains[0]);
  empty(s);
  s.trains.push(template);
  const local = isolatedTrain(s, { id: "LOCAL", type: "local" });
  const rapid = isolatedTrain(s, { id: "RAPID", type: "rapid", plan: 30 });
  s.trains = [local, rapid];
  s.trainsById = new Map(s.trains.map((t) => [t.id, t]));
  const result = s.issue({
    type: "priority",
    trainId: rapid.id,
    stationId: "ogikubo",
  });
  assert.equal(result.ok, true, result.message);
  s.advance(200);
  assert.ok(rapid.history[2].departure < local.history[2].departure);
  assert.ok(local.history[2].departure - rapid.history[2].departure >= HEADWAY);
});
test("TC-004: grade boundaries and score arithmetic are exact", () => {
  for (const [score, expected] of [
    [100000, "S"],
    [90000, "S"],
    [89999, "A"],
    [75000, "A"],
    [74999, "B"],
    [60000, "B"],
    [59999, "C"],
    [40000, "C"],
    [39999, "F"],
    [0, "F"],
  ])
    assert.equal(grade(score), expected);
  assert.equal(calculateScore(1000000, 2, 300, 120), 96810);
  assert.equal(calculateScore(1e12, 10000, 10000, 10000), 0);
});
test("TC-005: blocked and overcrowded trains accrue nonlinear loss", () => {
  const t = { passengers: CAPACITY, status: "running", blockedFor: 0 };
  const normal = passengerLoss([100], [t]);
  const blocked = passengerLoss(
    [100],
    [{ ...t, status: "blocked", blockedFor: 300 }],
  );
  const crowded = passengerLoss(
    [100],
    [{ ...t, passengers: CAPACITY * 1.6, status: "blocked", blockedFor: 300 }],
  );
  assert.ok(blocked > normal * 5);
  assert.ok(crowded > blocked * 2);
  assert.equal(passengerLoss([100], [], 5), 500);
});
test("short turn generates a reverse rescue service and transfers remaining riders", () => {
  const s = fresh();
  const template = structuredClone(s.trains[0]);
  empty(s);
  s.trains.push(template);
  const t = isolatedTrain(s, { id: "TURN" });
  s.trains = [t];
  const before = s.stations.ogikubo.waiting;
  assert.equal(
    s.issue({ type: "turnback", trainId: t.id, stationId: "ogikubo" }).ok,
    true,
  );
  s.advance(1);
  const rescue = s.trainsById.get("TURNR");
  assert.ok(rescue);
  assert.equal(rescue.reverse, true);
  assert.equal(t.status, "done");
  assert.deepEqual(rescue.path, ["ogikubo", "kichijoji", "mitaka"]);
  assert.ok(s.stations.ogikubo.waiting >= before + 800);
  assert.equal(s.penalty, 80);
  s.advance(500);
  assert.equal(rescue.status, "done");
});
test("skip station does not board or alight and reduces station dwell", () => {
  const s = fresh();
  const template = structuredClone(s.trains[0]);
  empty(s);
  s.trains.push(template);
  const t = isolatedTrain(s, {
    id: "SKIP",
    index: 1,
    dwelling: false,
    plan: -180,
  });
  s.trains = [t];
  assert.equal(
    s.issue({ type: "skip", trainId: t.id, stationId: "ogikubo" }).ok,
    true,
  );
  const before = s.stations.ogikubo.waiting;
  s.advance(2);
  assert.equal(t.passengers, 800);
  assert.equal(t.history[2].skipped, true);
  assert.equal(t.history[2].departure - t.history[2].arrival, 1);
  assert.ok(s.stations.ogikubo.waiting >= before);
});
test("skip boundary, end station and station already passed are rejected without mutation", () => {
  const s = fresh({ scenario: "through" });
  const t = s.liveTrains.find((t) => t.line === "chuo" && t.index <= 2);
  assert.ok(t);
  const before = s.snapshot();
  for (const stationId of ["nakano", "tokyo", "mitaka"])
    assert.equal(s.issue({ type: "skip", trainId: t.id, stationId }).ok, false);
  assert.deepEqual(s.snapshot(), before);
});
test("cancellation frees a service and retains its passengers at a station", () => {
  const s = fresh();
  const t = s.liveTrains.find((t) => t.passengers > 0);
  const before = s.waiting,
    riders = t.passengers;
  assert.equal(s.issue({ type: "cancel", trainId: t.id }).ok, true);
  assert.equal(t.status, "cancelled");
  assert.equal(t.passengers, 0);
  assert.equal(s.waiting, before + riders);
  assert.equal(s.penalty, 160);
});
test("manual hold obeys 10–300s validation and affects actual departure", () => {
  const s = fresh();
  const template = structuredClone(s.trains[0]);
  empty(s);
  s.trains.push(template);
  const t = isolatedTrain(s, { id: "HOLD" });
  s.trains = [t];
  assert.equal(
    s.issue({ type: "hold", trainId: t.id, seconds: 500 }).ok,
    false,
  );
  assert.equal(s.issue({ type: "hold", trainId: t.id, seconds: 60 }).ok, true);
  s.advance(59);
  assert.equal(t.status, "dwelling");
  s.advance(1);
  assert.equal(t.history[2].departure, 60);
});
test("same seed and timestamped command replay reproduces full simulation exactly", () => {
  const s = fresh({
    scenario: "network",
    seed: 1234,
    randomIncidents: true,
    initialIncident: true,
  });
  s.advance(20);
  s.issue({ type: "cut", connectionId: "shibuya" });
  s.advance(50);
  s.issue({ type: "cancel", trainId: s.liveTrains[0].id });
  s.advance(400);
  const restored = Simulation.replay(
    JSON.parse(JSON.stringify(s.exportReplay())),
  );
  assert.deepEqual(restored.snapshot(), s.snapshot());
  assert.deepEqual(restored.incidents, s.incidents);
  assert.deepEqual(restored.logs, s.logs);
});
test("different seeds change random incidents, independent of advance chunk size", () => {
  const a = fresh({ seed: 42, randomIncidents: true }),
    b = fresh({ seed: 42, randomIncidents: true }),
    c = fresh({ seed: 43, randomIncidents: true });
  a.advance(1200);
  for (let i = 0; i < 120; i++) b.advance(10);
  c.advance(1200);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.notEqual(a.rngState, c.rngState);
});
test("reject malformed replay and non-integer seed before mutating anything", () => {
  assert.throws(() => fresh({ seed: NaN }));
  assert.throws(() => fresh({ seed: -1 }));
  assert.throws(() =>
    Simulation.replay({
      version: 1,
      scenario: "network",
      seed: 1,
      time: Infinity,
      commands: [],
    }),
  );
  assert.throws(() =>
    Simulation.replay({
      version: 1,
      scenario: "local",
      seed: 1,
      time: 10,
      commands: [{ time: 20, type: "cut" }],
    }),
  );
});
test("all three scenarios finish with bounded score, no negative passengers and frozen end time", () => {
  for (const scenario of ["local", "through", "network"]) {
    const s = fresh({ scenario });
    s.advance(2000);
    assert.equal(s.time, s.scenario.duration);
    assert.equal(s.ended, true);
    assert.ok(s.score >= 0 && s.score <= 100000);
    assert.ok(
      s.trains.every((t) => t.passengers >= 0 && Number.isFinite(t.passengers)),
    );
    assert.ok(Object.values(s.stations).every((st) => st.waiting >= 0));
    const before = s.snapshot();
    s.advance(20);
    assert.deepEqual(s.snapshot(), before);
    assert.equal(
      s.issue({ type: "cancel", trainId: s.liveTrains[0]?.id }).ok,
      false,
    );
  }
});
