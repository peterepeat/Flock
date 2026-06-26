// Recent locations + runners localStorage cache (pure logic over a stubbed localStorage).
//   npx tsx scripts/_st_recent.ts

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

import {
  getRecentLocations, pushRecentLocation, matchLocations, locationKey,
  getRecentRunners, upsertRecentRunner, syncRecentRunners, matchRunners, recentRunnerToConstraints,
} from "../src/lib/recentStore";
import type { GeocodeResult, Participant, ParticipantConstraints } from "../src/lib/types";
import { ok, suite, section, finish } from "./_st_harness";

const loc = (shortName: string, lat: number, lng: number, displayName = shortName): GeocodeResult => ({ shortName, displayName, lat, lng });
const runner = (name: string, over: Partial<ParticipantConstraints> = {}): ParticipantConstraints =>
  ({ name, startPin: { kind: "auto" }, finishPin: { kind: "auto" }, maxDistanceKm: null, pace: null, earliestStartTime: null, latestFinishTime: null, ...over });
const asParticipant = (c: ParticipantConstraints): Participant => ({ id: "p_" + c.name, color: "#fff", addedAt: "", ...c });

function reset() { store.clear(); }

function main() {
  suite("recent");

  section("locations: order, dedup, cap");
  reset();
  pushRecentLocation(loc("Fed Square", -37.818, 144.969));
  pushRecentLocation(loc("NGV", -37.8226, 144.9689));
  ok(getRecentLocations().map((r) => r.shortName).join(",") === "NGV,Fed Square", "most-recent first");
  pushRecentLocation(loc("Fed Square", -37.818, 144.969)); // same spot again
  ok(getRecentLocations().length === 2, "same spot dedups (no duplicate)");
  ok(getRecentLocations()[0].shortName === "Fed Square", "re-selecting moves it to front");
  reset();
  for (let i = 0; i < 14; i++) pushRecentLocation(loc(`P${i}`, -37.8, 144.9 + i / 1000));
  ok(getRecentLocations().length === 10, "capped at 10");
  ok(getRecentLocations()[0].shortName === "P13", "newest kept, oldest evicted");

  section("locations: matching (drives the <4 → server rule in AddressSearch)");
  const recents = [loc("Federation Square", -37.818, 144.969), loc("Fitzroy Gardens", -37.81, 145.0), loc("NGV", -37.82, 144.97, "National Gallery of Victoria")];
  ok(matchLocations(recents, "").length === 3, "empty query → all recents (the before-typing list)");
  ok(matchLocations(recents, "fi").map((r) => r.shortName).join(",") === "Fitzroy Gardens", "substring filter on the label");
  ok(matchLocations(recents, "victoria").length === 1, "matches the displayName too");
  ok(matchLocations(recents, "zzz").length === 0, "no match → empty (caller falls through to server)");
  ok(locationKey(loc("X", -37.81801, 144.96899)) === locationKey(loc("Y", -37.81804, 144.96903)), "~11m apart ⇒ same key");

  section("runners: save (front, dedup by name, cap 10)");
  reset();
  upsertRecentRunner(runner("Tom", { pace: 360 }));
  upsertRecentRunner(runner("Pippa", { pace: 420 }));
  ok(getRecentRunners().map((r) => r.name).join(",") === "Pippa,Tom", "most-recently-saved first");
  upsertRecentRunner(runner("tom", { pace: 300 })); // same name, different case + new prefs
  ok(getRecentRunners().length === 2, "name-keyed dedup (case-insensitive)");
  ok(getRecentRunners()[0].name === "tom" && getRecentRunners()[0].pace === 300, "re-saving moves to front + updates prefs");
  ok(!("color" in (getRecentRunners()[0] as object)) && !("id" in (getRecentRunners()[0] as object)), "only constraint fields cached (no id/color)");

  section("runners: changes by anyone refresh the cached copy (in place)");
  reset();
  upsertRecentRunner(runner("Tom", { pace: 360 }));
  upsertRecentRunner(runner("Nia", { pace: 400 }));
  // Someone edits Tom's pace in a flock; Nia is untouched; a non-cached "Stranger" is ignored.
  syncRecentRunners([asParticipant(runner("Tom", { pace: 330 })), asParticipant(runner("Stranger", { pace: 999 }))]);
  ok(getRecentRunners().find((r) => r.name === "Tom")?.pace === 330, "cached Tom updated by the edit");
  ok(getRecentRunners().find((r) => r.name === "Nia")?.pace === 400, "Nia untouched");
  ok(getRecentRunners().length === 2 && !getRecentRunners().some((r) => r.name === "Stranger"), "sync never ADDS a non-cached runner");
  ok(getRecentRunners().map((r) => r.name).join(",") === "Nia,Tom", "sync keeps order (no reorder on others' edits)");

  section("runners: matching + cross-flock portability");
  ok(matchRunners(getRecentRunners(), "to").map((r) => r.name).join(",") === "Tom", "name substring match");
  ok(matchRunners(getRecentRunners(), "").length === 2, "empty query → all (quick-add list)");
  const wpRunner = runner("Jo", { startPin: { kind: "waypoint", waypointId: "wp_local" }, finishPin: { kind: "manual", location: { lat: -37.8, lng: 145 }, address: "Home" } });
  const portable = recentRunnerToConstraints(wpRunner);
  ok(portable.startPin.kind === "auto", "a waypoint start pin degrades to auto in a new flock");
  ok(portable.finishPin.kind === "manual", "a manual finish place carries across flocks");

  finish();
}

main();
