// End-to-end assignment tests for all three session types (Open Play, Round
// Robin, Tournament). Loads the real index.html in headless Chromium, starts
// an offline Quick Play session (no Firebase), and drives it through the same
// App methods the buttons call. Prints a pass/fail summary and writes the
// full results (every match, every check) to JSON for the evidence report.
//
//   NODE_PATH=$(npm root -g) node tests/session-assignments.test.cjs [outDir]
//
// Exit code is non-zero if any hard check fails.
//
// To show the Round Robin regression check has teeth, point it at the
// pre-fix page: INDEX_HTML=<old index.html> ONLY_RR_STRESS=1 node ...
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'tests', 'out'));
fs.mkdirSync(OUT, { recursive: true });

const NAMES = ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jordan',
  'Kai', 'Logan', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Riley', 'Sage', 'Taylor'];

let browser;
async function freshPage() {
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.dismiss());
  await page.route(/^https?:/, r => r.abort()); // offline: never reach Firebase/CDNs
  await page.addInitScript(() => {
    // 9:00 AM on a fixed day, advanced explicitly by the tests.
    window.__simBase = Date.UTC(2026, 9, 17, 9, 0, 0);
    window.__simNow = window.__simBase;
    Date.now = () => window.__simNow;
  });
  await page.goto('file://' + (process.env.INDEX_HTML ? path.resolve(process.env.INDEX_HTML) : path.join(ROOT, 'index.html')));
  await page.addScriptTag({ path: path.join(__dirname, 'sim-helpers.js') });
  await page.addScriptTag({ content: `window.NAMES = ${JSON.stringify(NAMES)};\nwindow.analyzeRR = ${analyzeRR.toString()};\nwindow.linkAs = ${linkAs.toString()};` });
  return { page, ctx, errors };
}

// ═══════════════════════════════════════════════════════════════════
// OPEN PLAY
// ═══════════════════════════════════════════════════════════════════

// Courts free up at staggered times; every free court is Auto-filled and
// started right away; players join, sit out and come back mid-session.
// Checks, on every single Auto-fill, that the 4 players picked were the 4
// highest-priority people in the queue (most fills waited, then longest
// since they last played) — i.e. nobody got skipped over.
function openPlayDropIn(cfg) {
  const { courts, initial, events, endMin } = cfg;
  T.start('open', courts);
  initial.forEach(n => T.add(n));
  const ev = [...events].sort((a, b) => a.min - b.min);
  const fills = [];
  const violations = [];
  const doubleBooked = [];
  const sittingAssigned = [];
  const timeline = [];
  const courtEnds = {};
  const presence = {}; // name -> [{from,to}]
  const satStreak = {}, maxSatStreak = {};
  initial.forEach(n => { presence[n] = [{ from: 0, to: null }]; });
  // Independent statement of the rule, kept by the test itself rather than
  // read from the app: a player has been waiting since their last match
  // ENDED, or since they arrived if they haven't played yet. Whoever has sat
  // through more fills goes first; on a tie, whoever has been waiting longer.
  const waitingSince = {};
  initial.forEach(n => { waitingSince[n] = Date.now(); });
  const passedOverBy = []; // someone waiting was skipped for a player who started waiting later

  const fill = c => {
    const onCourt = App.getPlayersOnCourts();
    const eligible = App.state.players.filter(p => p.active && !onCourt.has(p.id))
      .map(p => ({ id: p.id, rw: App.state.roundsWaited[p.id] || 0, la: p.lastActiveAt }));
    if (eligible.length < 4) return false;
    const sitting = new Set(App.state.players.filter(p => !p.active).map(p => p.id));
    App.autoFillCourt(c);
    const g = App.state.proposedGames[c];
    if (!g) return false;
    const picked = [...g.side1, ...g.side2];
    const pickedSet = new Set(picked);
    const better = (q, p) => q.rw > p.rw || (q.rw === p.rw && q.la < p.la);
    const pk = eligible.filter(e => pickedSet.has(e.id));
    const since = e => waitingSince[T.name(e.id)];
    const ruleBetter = (q, p) => q.rw > p.rw || (q.rw === p.rw && since(q) < since(p));
    eligible.filter(e => !pickedSet.has(e.id)).forEach(q => pk.forEach(p => {
      if (better(q, p)) violations.push({ at: T.clock(), court: c, skipped: T.name(q.id), skippedWaited: q.rw, picked: T.name(p.id), pickedWaited: p.rw });
      if (ruleBetter(q, p)) passedOverBy.push({ at: T.clock(), court: c, skipped: T.name(q.id), picked: T.name(p.id) });
    }));
    picked.forEach(id => { if (sitting.has(id)) sittingAssigned.push(T.name(id)); if (onCourt.has(id)) doubleBooked.push(T.name(id)); });
    eligible.forEach(e => {
      const n = T.name(e.id);
      if (pickedSet.has(e.id)) satStreak[n] = 0;
      else { satStreak[n] = (satStreak[n] || 0) + 1; maxSatStreak[n] = Math.max(maxSatStreak[n] || 0, satStreak[n]); }
    });
    const waitingAfter = eligible.filter(e => !pickedSet.has(e.id)).map(e => T.name(e.id));
    App.startProposedMatch(c);
    const dur = 11 + Math.floor(Math.random() * 7);
    courtEnds[c] = T.minute() + dur;
    fills.push({ at: T.clock(), min: T.minute(), court: c, side1: T.names(g.side1), side2: T.names(g.side2),
      queueBefore: eligible.map(e => ({ name: T.name(e.id), waited: e.rw })), stillWaiting: waitingAfter, dur });
    timeline.push({ at: T.clock(), kind: 'start', text: `Court ${c}: ${T.names(g.side1).join(' & ')} vs ${T.names(g.side2).join(' & ')}`, waiting: waitingAfter });
    return true;
  };

  let guard = 0;
  while (guard++ < 500) {
    for (let c = 1; c <= courts; c++) {
      if (!App.state.activeGames[c] && !App.state.proposedGames[c] && T.minute() < endMin) fill(c);
    }
    const ends = Object.entries(courtEnds);
    const nextEnd = ends.length ? Math.min(...ends.map(([, m]) => m)) : Infinity;
    // Arrivals/returns land 30 s before the minute they're listed at, so one
    // never ties to the millisecond with a court finishing that same minute.
    const evAt = e => e.min - 0.5;
    const nextEv = ev.length ? evAt(ev[0]) : Infinity;
    if (nextEnd === Infinity && nextEv === Infinity) break;
    if (Math.min(nextEnd, nextEv) > endMin && ends.length === 0) break;
    if (nextEv <= nextEnd) {
      const e = ev.shift();
      T.advanceTo(evAt(e));
      if (e.type === 'join') { T.add(e.name); waitingSince[e.name] = Date.now(); (presence[e.name] = presence[e.name] || []).push({ from: e.min, to: null }); }
      if (e.type === 'sitOut') { T.sitOut(e.name); presence[e.name].slice(-1)[0].to = e.min; }
      if (e.type === 'rejoin') { T.rejoin(e.name); presence[e.name].push({ from: e.min, to: null }); }
      timeline.push({ at: T.clock(), kind: e.type, text: `${e.name} ${e.type === 'join' ? 'joins the session' : e.type === 'sitOut' ? 'sits out' : 'returns to the queue'}` });
      continue;
    }
    const c = Number(ends.find(([, m]) => m === nextEnd)[0]);
    T.advanceTo(nextEnd);
    const [s1, s2] = T.randomScore();
    const g = App.state.activeGames[c];
    [...g.side1, ...g.side2].forEach(id => { waitingSince[T.name(id)] = Date.now(); });
    T.finish(c, s1, s2, 'all');
    delete courtEnds[c];
    timeline.push({ at: T.clock(), kind: 'end', text: `Court ${c} finished ${s1}–${s2}, all 4 back to the queue` });
  }

  const finalMin = T.minute();
  const stats = {};
  App.state.players.forEach(p => {
    const mins = (presence[p.name] || []).reduce((s, iv) => s + ((iv.to == null ? finalMin : iv.to) - iv.from), 0);
    stats[p.name] = { games: 0, partners: {}, opponents: {}, presentMin: mins, joinedAt: T.clock(presence[p.name][0].from), maxFillsSatInARow: maxSatStreak[p.name] || 0 };
  });
  App.state.roundHistory.forEach(m => {
    [[m.side1, m.side2], [m.side2, m.side1]].forEach(([mine, theirs]) => mine.forEach(id => {
      const s = stats[T.name(id)]; s.games++;
      mine.filter(x => x !== id).forEach(x => { const n = T.name(x); s.partners[n] = (s.partners[n] || 0) + 1; });
      theirs.forEach(x => { const n = T.name(x); s.opponents[n] = (s.opponents[n] || 0) + 1; });
    }));
  });
  // First game for each late joiner: how long they waited from joining.
  const lateJoiners = events.filter(e => e.type === 'join').map(e => {
    const first = fills.find(f => f.min >= e.min && [...f.side1, ...f.side2].includes(e.name));
    const fillsBetween = fills.filter(f => f.min >= e.min && (!first || f.min < first.min || (f === first ? false : f.min === first.min && fills.indexOf(f) < fills.indexOf(first)))).length;
    return { name: e.name, joined: T.clock(e.min), firstGame: first ? first.at : null, minutesWaited: first ? first.min - e.min : null, courtFillsBeforeFirstGame: fillsBetween };
  });
  Object.values(stats).forEach(s => { s.gamesPerHour = s.presentMin ? +(s.games / (s.presentMin / 60)).toFixed(2) : 0; s.maxSamePartner = Math.max(0, ...Object.values(s.partners)); });
  return { fills, violations, passedOverBy, doubleBooked, sittingAssigned, stats, lateJoiners, timeline, matches: App.state.roundHistory.length, endedAt: T.clock() };
}

// Keep Winners / Keep Last-Joined: the kept pair stays on court and the
// incoming two are the top of the queue.
function openPlayRotation() {
  T.start('open', 1);
  NAMES.slice(0, 7).forEach(n => T.add(n));
  const steps = [];
  const problems = [];
  T.advanceTo(1);
  App.autoFillCourt(1); App.startProposedMatch(1);
  const modes = ['winners', 'winners', 'lastJoined', 'winners', 'all', 'lastJoined'];
  let min = 1;
  for (const mode of modes) {
    min += 14; T.advanceTo(min);
    const g = App.state.activeGames[1];
    const before = { side1: [...g.side1], side2: [...g.side2], j1: g.side1JoinedAt, j2: g.side2JoinedAt };
    const onCourt = new Set([...g.side1, ...g.side2]);
    const queue = App.state.players.filter(p => p.active && !onCourt.has(p.id))
      .map(p => ({ id: p.id, rw: App.state.roundsWaited[p.id] || 0, la: p.lastActiveAt }))
      .sort((a, b) => b.rw - a.rw || a.la - b.la);
    const [s1, s2] = T.randomScore();
    T.finish(1, s1, s2, mode);
    const winner = s1 > s2 ? before.side1 : before.side2;
    const lastJoinedEligible = before.j1 !== before.j2;
    const newer = before.j1 > before.j2 ? before.side1 : before.side2;
    let expectedStay = null;
    if (mode === 'winners') expectedStay = winner;
    if (mode === 'lastJoined' && lastJoinedEligible) expectedStay = newer;
    let after = App.state.activeGames[1];
    if (!after) { App.autoFillCourt(1); App.startProposedMatch(1); after = App.state.activeGames[1]; }
    const afterIds = [...after.side1, ...after.side2];
    const stayed = expectedStay ? expectedStay.every(id => afterIds.includes(id)) : null;
    const sameSide = expectedStay ? (T.teamKey(after.side1) === T.teamKey(expectedStay) || T.teamKey(after.side2) === T.teamKey(expectedStay)) : null;
    const incoming = afterIds.filter(id => !(expectedStay || []).includes(id));
    const topQueue = queue.slice(0, incoming.length).map(q => q.id);
    // Ties on (waited, last played) are broken randomly by design, so only
    // flag an incoming player if someone strictly ahead of them was skipped.
    const strictlySkipped = queue.filter(q => !incoming.includes(q.id) && incoming.some(i => {
      const iq = queue.find(x => x.id === i); return iq && (q.rw > iq.rw || (q.rw === iq.rw && q.la < iq.la));
    }));
    if (expectedStay && (!stayed || !sameSide)) problems.push(`${mode}: kept pair ${T.names(expectedStay).join(' & ')} did not stay together`);
    if (expectedStay && strictlySkipped.length) problems.push(`${mode}: skipped ${T.names(strictlySkipped.map(q => q.id)).join(', ')}`);
    steps.push({
      at: T.clock(), mode, score: `${s1}–${s2}`,
      before: `${T.names(before.side1).join(' & ')} vs ${T.names(before.side2).join(' & ')}`,
      kept: expectedStay ? T.names(expectedStay).join(' & ') : (mode === 'lastJoined' ? '(not eligible — both sides joined together, behaves like Return All 4)' : '(none — all 4 back to queue)'),
      queueOrder: queue.map(q => `${T.name(q.id)} (waited ${q.rw})`),
      incoming: T.names(incoming), topOfQueue: T.names(topQueue),
      after: `${T.names(after.side1).join(' & ')} vs ${T.names(after.side2).join(' & ')}`,
      ok: !expectedStay || (stayed && sameSide && strictlySkipped.length === 0),
    });
  }
  return { steps, problems };
}

// Locked partners in Open Play always come in together, on the same side.
function openPlayPartners() {
  T.start('open', 2);
  NAMES.slice(0, 10).forEach(n => T.add(n));
  T.partner('Avery', 'Blake');
  T.partner('Casey', 'Devon');
  const problems = [];
  let pairGames = { 'Avery & Blake': 0, 'Casey & Devon': 0 };
  let min = 0;
  for (let i = 0; i < 16; i++) {
    for (let c = 1; c <= 2; c++) if (!App.state.activeGames[c]) { App.autoFillCourt(c); App.startProposedMatch(c); }
    min += 7; T.advanceTo(min);
    const c = (i % 2) + 1;
    if (App.state.activeGames[c]) { const [a, b] = T.randomScore(); T.finish(c, a, b, 'all'); }
  }
  App.state.roundHistory.forEach(m => {
    [['Avery', 'Blake'], ['Casey', 'Devon']].forEach(([a, b]) => {
      const ia = T.id(a), ib = T.id(b);
      const all = [...m.side1, ...m.side2];
      if (all.includes(ia) !== all.includes(ib)) problems.push(`${a}/${b} split up in a match`);
      if (all.includes(ia) && all.includes(ib)) {
        const same = (m.side1.includes(ia) && m.side1.includes(ib)) || (m.side2.includes(ia) && m.side2.includes(ib));
        if (!same) problems.push(`${a}/${b} put on opposite sides`); else pairGames[`${a} & ${b}`]++;
      }
    });
  });
  const games = {};
  App.state.roundHistory.forEach(m => [...m.side1, ...m.side2].forEach(id => { const n = T.name(id); games[n] = (games[n] || 0) + 1; }));
  return { matches: App.state.roundHistory.length, pairGames, games, problems };
}


// ─── Partners in a signed-in session ─────────────────────────────
// Partners are linked the way a signed-in player does it from Settings >
// Your Partner (App.addTeamWithSelf, acting as that player). The
// assignment code is the same one a live session runs.
function linkAs(selfName, partnerName) {
  Onboard.selfId = T.id(selfName);
  App.addTeamWithSelf(T.id(partnerName));
}

// The exact case: Player 1 is already playing; Player 2 arrives and links
// up with them mid-match.
function partnerLateLink() {
  const problems = [];
  const steps = [];
  const unitFor = name => App._rankedQueueUnits(App.state.players.filter(p => p.active && !App.getPlayersOnCourts().has(p.id)))
    .find(u => u.ids.includes(T.id(name)));
  const fmt = u => u ? `${u.type === 'pair' ? T.names(u.ids).join(' & ') : T.name(u.ids[0])}: waited ${u.roundsWaited} fills, available since ${T.clock(Math.round((u.lastActiveAt - window.__simBase) / 60000))}` : '(not in line)';
  T.start('open', 2);
  NAMES.slice(0, 8).forEach(n => T.add(n));
  App.autoFillCourt(1); App.startProposedMatch(1);
  App.autoFillCourt(2); App.startProposedMatch(2);
  const aveCourt = App.getPlayerCourt(T.id('Avery'));
  const otherCourt = aveCourt === 1 ? 2 : 1;
  steps.push(`9:00 Both courts start. Avery is on Court ${aveCourt}.`);
  T.advanceTo(8); T.add('Indy'); T.add('Jordan');
  linkAs('Indy', 'Avery');
  App.render();
  const held = App._heldForPartner ? App._heldForPartner(T.id('Indy')) : null;
  const heldText = [...document.querySelectorAll('#queueActiveList .queue-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()).find(t => t.includes('Indy')) || '';
  steps.push(`9:08 Indy and Jordan arrive. Indy links Avery as partner while Avery is on Court ${aveCourt}. Queue shows: "${heldText}".`);
  if (!held || held.name !== 'Avery') problems.push('Indy not held for Avery');
  if (!/waiting for Avery/.test(heldText)) problems.push('Queue does not show "waiting for Avery"');

  T.advanceTo(14);
  const [a1, b1] = T.randomScore(); T.finish(otherCourt, a1, b1, 'all');
  App.autoFillCourt(otherCourt);
  const g1 = App.state.proposedGames[otherCourt];
  const ids1 = [...g1.side1, ...g1.side2];
  steps.push(`9:14 Court ${otherCourt} finishes and is auto-filled: ${T.names(g1.side1).join(' & ')} vs ${T.names(g1.side2).join(' & ')}. Jordan (new) goes in; Indy waits for Avery.`);
  if (ids1.includes(T.id('Indy'))) problems.push('Indy was assigned without Avery');
  if (!ids1.includes(T.id('Jordan'))) problems.push('Jordan (newcomer) did not get the open spot');
  App.startProposedMatch(otherCourt);

  T.advanceTo(20);
  const [a2, b2] = T.randomScore(); T.finish(aveCourt, a2, b2, 'all');
  const indyAlone = { rw: App.state.roundsWaited[T.id('Indy')] || 0, la: App.getPlayer(T.id('Indy')).lastActiveAt };
  const pair = unitFor('Avery');
  const aveAlone = { rw: App.state.roundsWaited[T.id('Avery')] || 0, la: App.getPlayer(T.id('Avery')).lastActiveAt };
  steps.push(`9:20 Avery's court finishes. Avery: waited ${aveAlone.rw} fills, available since 9:20. Indy: waited ${indyAlone.rw} fill, available since 9:08. The pair ranks as the average: "${fmt(pair)}".`);
  if (!pair || pair.type !== 'pair') problems.push('Avery & Indy are not one unit');
  else if (pair.roundsWaited !== (aveAlone.rw + indyAlone.rw) / 2 || pair.lastActiveAt !== (aveAlone.la + indyAlone.la) / 2) problems.push('Pair did not rank as the average of the two partners');
  const queueOrder = App._rankedQueueUnits(App.state.players.filter(p => p.active && !App.getPlayersOnCourts().has(p.id))).map(fmt);
  steps.push(`Line at 9:20: ${queueOrder.join(' · ')}`);
  // Play on until the pair gets a court; they must go on together.
  let guard = 0, together = null;
  let min = 20;
  while (guard++ < 10 && together == null) {
    App.autoFillCourt(aveCourt);
    const g = App.state.proposedGames[aveCourt];
    if (g) {
      const all = [...g.side1, ...g.side2];
      const hasA = all.includes(T.id('Avery')), hasI = all.includes(T.id('Indy'));
      if (hasA !== hasI) problems.push('Avery and Indy split up');
      if (hasA && hasI) {
        const same = (g.side1.includes(T.id('Avery')) && g.side1.includes(T.id('Indy'))) || (g.side2.includes(T.id('Avery')) && g.side2.includes(T.id('Indy')));
        together = same; steps.push(`${T.clock()} Court ${aveCourt}: ${T.names(g.side1).join(' & ')} vs ${T.names(g.side2).join(' & ')}. Avery & Indy on ${same ? 'the same side' : 'OPPOSITE sides'}.`);
        if (!same) problems.push('Avery and Indy on opposite sides');
      } else steps.push(`${T.clock()} Court ${aveCourt}: ${T.names(g.side1).join(' & ')} vs ${T.names(g.side2).join(' & ')} (pair still behind people waiting longer).`);
      App.startProposedMatch(aveCourt);
    }
    min += 13; T.advanceTo(min);
    for (const c of [aveCourt, otherCourt]) if (App.state.activeGames[c] && together == null) { const [x, y] = T.randomScore(); T.finish(c, x, y, 'all'); if (c === otherCourt) { App.autoFillCourt(c); const og = App.state.proposedGames[c]; if (og) { const all = [...og.side1, ...og.side2]; if (all.includes(T.id('Avery')) !== all.includes(T.id('Indy'))) problems.push('Avery and Indy split up'); if (all.includes(T.id('Avery')) && all.includes(T.id('Indy'))) { together = true; steps.push(`${T.clock()} Court ${c}: ${T.names(og.side1).join(' & ')} vs ${T.names(og.side2).join(' & ')}. Avery & Indy together.`); } App.startProposedMatch(c); } } }
  }
  if (!together) problems.push('Pair never got a court together');
  return { steps, problems };
}

// A player who has been waiting a while links with a newcomer: the pair
// ranks as the average of the two partners' places in line.
function partnerRanksAsAverage() {
  const problems = [];
  T.start('open', 1);
  NAMES.slice(0, 9).forEach(n => T.add(n));
  // Two fills: 8 of 9 players have sat through fills unevenly.
  App.autoFillCourt(1); App.startProposedMatch(1);
  T.advanceTo(12); { const [a, b] = T.randomScore(); T.finish(1, a, b, 'all'); }
  const queuedBefore = App.state.players.filter(p => !App.getPlayersOnCourts().has(p.id)).map(p => ({ name: p.name, waited: App.state.roundsWaited[p.id] || 0 }));
  const veteran = [...queuedBefore].sort((a, b) => b.waited - a.waited)[0].name;
  T.advanceTo(13); T.add('Jordan');
  linkAs('Jordan', veteran);
  const queue = App.state.players.filter(p => p.active && !App.getPlayersOnCourts().has(p.id));
  const units = App._rankedQueueUnits(queue);
  const pair = units.find(u => u.ids.includes(T.id('Jordan')));
  const vet = { rw: App.state.roundsWaited[T.id(veteran)] || 0, la: App.getPlayer(T.id(veteran)).lastActiveAt };
  const jor = { rw: App.state.roundsWaited[T.id('Jordan')] || 0, la: App.getPlayer(T.id('Jordan')).lastActiveAt };
  if (!pair || pair.type !== 'pair') problems.push('Not paired');
  else if (pair.roundsWaited !== (vet.rw + jor.rw) / 2 || pair.lastActiveAt !== (vet.la + jor.la) / 2) problems.push('Pair did not rank as the average of the two partners');
  const ahead = units.slice(0, units.indexOf(pair)).map(u => `${T.names(u.ids).join(' & ')} (waited ${u.roundsWaited})`);
  return { veteran, veteranWaited: vet.rw, pairWaited: pair && pair.roundsWaited, aheadOfPair: ahead, problems };
}

// One partner at a time, from the Settings card itself.
function onePartnerAtATime() {
  const problems = [];
  T.start('open', 1);
  NAMES.slice(0, 6).forEach(n => T.add(n));
  linkAs('Avery', 'Blake');
  linkAs('Avery', 'Casey'); // Change Partner → Casey replaces Blake
  const avTeams = App.state.teams.filter(t => !t.type && (t.p1 === T.id('Avery') || t.p2 === T.id('Avery')));
  if (avTeams.length !== 1 || ![avTeams[0].p1, avTeams[0].p2].includes(T.id('Casey'))) problems.push('Avery does not have exactly one partner (Casey)');
  App.renderPartners();
  const card = document.getElementById('partnerDisplay').textContent.replace(/\s+/g, ' ').trim();
  const btn = document.getElementById('btnAddPartner').textContent.trim();
  if (!/Casey/.test(card) || /Blake/.test(card)) problems.push('Partner card wrong: ' + card);
  if (btn !== 'Change Partner') problems.push('Button reads ' + btn);
  // Someone else can't take Casey while she's partnered.
  Onboard.selfId = T.id('Devon');
  App.renderPartnerPicker();
  const pickable = [...document.querySelectorAll('#partnerPickerList .partner-picker-item')].map(e => e.textContent.trim());
  if (pickable.includes('Casey') || pickable.includes('Avery')) problems.push('Picker offers already-partnered players');
  App.addTeamWithSelf(T.id('Casey'));
  if (App.state.teams.some(t => !t.type && [t.p1, t.p2].includes(T.id('Devon')))) problems.push('Devon was able to take Casey');
  // Old sessions with several partners saved collapse to one each on load.
  App.state.teams = [
    { id: 901, p1: T.id('Emery'), p2: T.id('Finley'), doNotSplit: true, current: false },
    { id: 902, p1: T.id('Emery'), p2: T.id('Blake'), doNotSplit: true, current: true },
    { id: 903, p1: T.id('Finley'), p2: T.id('Devon'), doNotSplit: true, current: true },
  ];
  App._normState();
  const after = App.state.teams.map(t => T.names([t.p1, t.p2]).join(' & '));
  const counts = {};
  App.state.teams.forEach(t => [t.p1, t.p2].forEach(id => { counts[id] = (counts[id] || 0) + 1; }));
  if (Object.values(counts).some(c => c > 1)) problems.push('Migration left someone with two partners');
  // Partner in Sitting Out → you're queued on your own.
  App.state.teams = [];
  linkAs('Avery', 'Blake');
  T.sitOut('Blake');
  const units = App._rankedQueueUnits(App.state.players.filter(p => p.active));
  const av = units.find(u => u.ids.includes(T.id('Avery')));
  if (!av || av.type !== 'solo') problems.push('Avery not queued solo while Blake sits out');
  return { card, button: btn, pickerForDevon: pickable, migratedTeams: after, problems };
}

// Randomized: drop-in session where two pairs form mid-session (one while a
// partner is on court). Checks every Auto-fill against the rule, worked out
// independently: partners go together or not at all, never while one is on
// court, and a pair ranks as the average of its two partners.
function partnerDropIn() {
  T.start('open', 2);
  NAMES.slice(0, 8).forEach(n => T.add(n));
  const since = {};
  NAMES.slice(0, 8).forEach(n => { since[T.id(n)] = Date.now(); });
  const events = [
    { min: 7.5, f: () => { T.add('Indy'); since[T.id('Indy')] = Date.now(); linkAs('Indy', 'Avery'); } },
    { min: 15.5, f: () => { T.add('Jordan'); since[T.id('Jordan')] = Date.now(); } },
    { min: 21.5, f: () => { T.add('Kai'); since[T.id('Kai')] = Date.now(); linkAs('Kai', 'Blake'); } },
    { min: 33.5, f: () => { T.add('Logan'); since[T.id('Logan')] = Date.now(); } },
  ];
  const problems = [];
  const courtEnds = {};
  let fills = 0;
  const rank = id => [App.state.roundsWaited[id] || 0, since[id]];
  const avg = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const better = (a, b) => a[0] > b[0] || (a[0] === b[0] && a[1] < b[1]);
  const partnerOf = id => { const t = App.state.teams.find(x => x.current && (x.p1 === id || x.p2 === id)); return t ? (t.p1 === id ? t.p2 : t.p1) : null; };
  const fill = c => {
    const onCourt = App.getPlayersOnCourts();
    const queue = App.state.players.filter(p => p.active && !onCourt.has(p.id)).map(p => p.id);
    const qs = new Set(queue);
    // Units by the rule.
    const units = [], seen = new Set();
    queue.forEach(id => {
      if (seen.has(id)) return;
      const pt = partnerOf(id);
      const ptP = pt != null ? App.getPlayer(pt) : null;
      if (pt != null && qs.has(pt)) { seen.add(id); seen.add(pt); units.push({ ids: [id, pt], r: avg(rank(id), rank(pt)) }); }
      else if (pt != null && ptP && ptP.active) { seen.add(id); /* held */ }
      else { seen.add(id); units.push({ ids: [id], r: rank(id) }); }
    });
    App.autoFillCourt(c);
    const g = App.state.proposedGames[c];
    if (!g) return;
    fills++;
    const picked = new Set([...g.side1, ...g.side2]);
    picked.forEach(id => {
      const pt = partnerOf(id);
      if (pt != null && App.getPlayer(pt)?.active && !picked.has(pt)) problems.push(`${T.clock()}: ${T.name(id)} assigned without partner ${T.name(pt)}`);
    });
    [g.side1, g.side2].forEach(side => side.forEach(id => { const pt = partnerOf(id); if (pt != null && picked.has(pt) && !side.includes(pt)) problems.push(`${T.clock()}: ${T.name(id)}/${T.name(pt)} on opposite sides`); }));
    // The rule: whoever is furthest back among the 4 picked should be as
    // close to the front as any valid pick (exactly 4 seats, pairs kept
    // whole) allows — nobody from further back gets in when a pick that
    // stops sooner exists. Checked by brute force over every valid pick.
    const pickedUnits = units.filter(u => u.ids.every(id => picked.has(id)));
    const worstOf = combo => combo.reduce((w, u) => (w == null || better(w, u.r) ? u.r : w), null);
    const appWorst = worstOf(pickedUnits);
    let bestWorst = null;
    const search = (i, seats, combo) => {
      if (seats === 0) { const w = worstOf(combo); if (bestWorst == null || better(w, bestWorst)) bestWorst = w; return; }
      for (let j = i; j < units.length; j++) if (units[j].ids.length <= seats) search(j + 1, seats - units[j].ids.length, [...combo, units[j]]);
    };
    search(0, 4, []);
    if (bestWorst && better(bestWorst, appWorst)) problems.push(`${T.clock()}: picked ${pickedUnits.map(u => T.names(u.ids).join(' & ')).join(', ')} reaches further back in line than needed`);
    App.startProposedMatch(c);
    courtEnds[c] = T.minute() + 11 + Math.floor(Math.random() * 7);
  };
  let guard = 0;
  while (guard++ < 200 && T.minute() < 120) {
    for (let c = 1; c <= 2; c++) if (!App.state.activeGames[c] && !App.state.proposedGames[c]) fill(c);
    const ends = Object.entries(courtEnds);
    const nextEnd = ends.length ? Math.min(...ends.map(([, m]) => m)) : Infinity;
    const nextEv = events.length ? events[0].min : Infinity;
    if (nextEnd === Infinity && nextEv === Infinity) break;
    if (nextEv < nextEnd) { const e = events.shift(); T.advanceTo(e.min); e.f(); continue; }
    const c = Number(ends.find(([, m]) => m === nextEnd)[0]);
    T.advanceTo(nextEnd);
    const g = App.state.activeGames[c];
    [...g.side1, ...g.side2].forEach(id => { since[id] = Date.now(); });
    const [a, b] = T.randomScore(); T.finish(c, a, b, 'all');
    delete courtEnds[c];
  }
  const games = {};
  App.state.roundHistory.forEach(m => [...m.side1, ...m.side2].forEach(id => { const n = T.name(id); games[n] = (games[n] || 0) + 1; }));
  return { fills, problems, games };
}

// ═══════════════════════════════════════════════════════════════════
// ROUND ROBIN
// ═══════════════════════════════════════════════════════════════════

function analyzeRR(schedule, activeIds) {
  const teamOf = {};
  const partnerChanges = [];
  const doubleInRound = [];
  const matchupCount = {};
  const teamGames = {};
  const teamByes = {};
  const allTeams = new Set();
  schedule.forEach(r => r.games.forEach(g => [g.side1, g.side2].forEach(s => allTeams.add(T.teamKey(s)))));
  schedule.forEach(r => {
    const seen = new Set();
    const playing = new Set();
    r.games.forEach(g => {
      [g.side1, g.side2].forEach(side => side.forEach(id => {
        if (seen.has(id)) doubleInRound.push({ round: r.round, player: T.name(id) });
        seen.add(id);
        const k = T.teamKey(side);
        if (teamOf[id] && teamOf[id] !== k) partnerChanges.push({ round: r.round, player: T.name(id) });
        teamOf[id] = k;
      }));
      const a = T.teamKey(g.side1), b = T.teamKey(g.side2);
      const mk = a < b ? `${a} vs ${b}` : `${b} vs ${a}`;
      matchupCount[mk] = (matchupCount[mk] || 0) + 1;
      teamGames[a] = (teamGames[a] || 0) + 1; teamGames[b] = (teamGames[b] || 0) + 1;
      playing.add(a); playing.add(b);
    });
    allTeams.forEach(t => { if (!playing.has(t)) teamByes[t] = (teamByes[t] || 0) + 1; });
  });
  const teams = [...allTeams];
  const repeats = Object.entries(matchupCount).filter(([, n]) => n > 1).map(([k, n]) => ({ matchup: k, times: n }));
  const possible = teams.length * (teams.length - 1) / 2;
  const benched = activeIds.filter(id => !teamOf[id]);
  const label = k => k.split('&').map(Number).map(id => T.name(id)).join(' & ');
  return {
    teams: teams.map(label), teamCount: teams.length, rounds: schedule.length,
    gamesPerRound: schedule.map(r => r.games.length),
    repeats, partnerChanges, doubleInRound, uniqueMatchups: Object.keys(matchupCount).length, possibleMatchups: possible,
    gamesPerTeam: Object.fromEntries(teams.map(t => [label(t), teamGames[t] || 0])),
    byesPerTeam: Object.fromEntries(teams.map(t => [label(t), teamByes[t] || 0])),
    benched: benched.map(id => T.name(id)),
  };
}

function roundRobinRun(cfg) {
  const { players, courts, partners, timeLimit, play } = cfg;
  T.start('roundrobin', courts);
  players.forEach(n => T.add(n));
  (partners || []).forEach(([a, b]) => T.partner(a, b));
  const ui = { lockLabel: document.getElementById('queueCount')?.textContent || '' };
  App.rrLockPlayers();
  if (timeLimit) {
    App.toggleScheduleTimeLimitEnabled();
    document.getElementById('matchTimeMinutes').value = timeLimit.matchMinutes;
    document.getElementById('sessionTimeHours').value = timeLimit.sessionHours;
    document.getElementById('scheduleBufferMinutes').value = timeLimit.buffer;
    App.updateScheduleTimeOptions();
  }
  const warn = document.getElementById('scheduleTimeWarning');
  ui.warning = warn && warn.style.display !== 'none' ? warn.textContent.trim() : '';
  ui.roundsInfo = document.getElementById('scheduleRoundsInfo')?.textContent.trim() || '';
  ui.beforeGenerate = T.btn();
  T.clickBtn(); // Generate Schedule
  const schedule = JSON.parse(JSON.stringify(App.state._rrSchedule));
  ui.afterGenerate = T.btn();
  ui.courtsAfterGenerate = Object.keys(App.state.activeGames).length; // must be 0 — Round 1 isn't auto-started
  const activeIds = App.state.players.filter(p => p.active).map(p => p.id);
  const analysis = analyzeRR(schedule, activeIds);
  const flow = [];
  const problems = [];
  if (play) {
    let min = 0;
    for (const round of schedule) {
      const b = T.btn();
      T.clickBtn(); // Start Round N
      const onCourts = T.activeCourts();
      const matchesSchedule = round.games.every(g => onCourts.some(c => c.court === g.court && T.teamKey(c.side1) === T.teamKey(g.side1) && T.teamKey(c.side2) === T.teamKey(g.side2))) && onCourts.length === round.games.length;
      const duringBtn = T.btn();
      App.startAllCourts();
      min += 15; T.advanceTo(min);
      App.endAllCourts();
      const scores = round.games.map(g => { const [a, c] = T.randomScore(); T.finish(g.court, a, c, 'all'); return `${a}–${c}`; });
      if (!matchesSchedule) problems.push(`Round ${round.round}: courts did not match the schedule`);
      if (b.disabled) problems.push(`Round ${round.round}: start button was disabled`);
      if (!duringBtn.disabled) problems.push(`Round ${round.round}: next-round button enabled while games running`);
      flow.push({ round: round.round, buttonBefore: b.text, buttonWhilePlaying: `${duringBtn.text}${duringBtn.disabled ? ' (disabled)' : ''}`, courtsMatchSchedule: matchesSchedule,
        games: round.games.map((g, i) => `C${g.court}: ${T.names(g.side1).join(' & ')} vs ${T.names(g.side2).join(' & ')}  ${scores[i]}`) });
    }
    ui.final = T.btn();
    const hist = App.state.roundHistory.map(m => `${T.teamKey(m.side1)}|${T.teamKey(m.side2)}`);
    const sched = schedule.flatMap(r => r.games.map(g => `${T.teamKey(g.side1)}|${T.teamKey(g.side2)}`));
    if (JSON.stringify(hist) !== JSON.stringify(sched)) problems.push('Match History does not match the schedule');
    ui.historyMatchesSchedule = JSON.stringify(hist) === JSON.stringify(sched);
  }
  if (ui.courtsAfterGenerate !== 0) problems.push('Round 1 auto-started on Generate');
  return {
    ui, analysis, flow, problems,
    schedule: schedule.map(r => ({ round: r.round, games: r.games.map(g => `C${g.court}: ${T.names(g.side1).join(' & ')} vs ${T.names(g.side2).join(' & ')}`) })),
  };
}

// Many fresh generations per team count, to show the no-repeat guarantee
// holds every time, not just on one lucky shuffle.
function roundRobinStress({ trials, configs }) {
  const out = [];
  for (const { players, courts } of configs) {
    let repeatSchedules = 0, fullCoverage = 0, byeOk = 0, partnerChanges = 0, doubleBook = 0, benchedOk = 0;
    let rounds = null, teams = null;
    const gamesSpread = [];
    for (let t = 0; t < trials; t++) {
      T.start('roundrobin', courts);
      NAMES.slice(0, players).forEach(n => T.add(n));
      App.rrLockPlayers();
      App.rrGenerateSchedule();
      const a = analyzeRR(App.state._rrSchedule, App.state.players.filter(p => p.active).map(p => p.id));
      rounds = a.rounds; teams = a.teamCount;
      if (a.repeats.length) repeatSchedules++;
      if (a.uniqueMatchups === a.possibleMatchups) fullCoverage++;
      const byes = Object.values(a.byesPerTeam);
      if (byes.every(b => b === byes[0])) byeOk++;
      partnerChanges += a.partnerChanges.length;
      doubleBook += a.doubleInRound.length;
      if (a.benched.length === players % 2) benchedOk++;
      const g = Object.values(a.gamesPerTeam);
      gamesSpread.push(Math.max(...g) - Math.min(...g));
    }
    out.push({ players, courts, teams, rounds, trials, schedulesWithRepeatOpponents: repeatSchedules,
      schedulesCoveringEveryMatchup: fullCoverage, schedulesWithEqualByes: byeOk, partnerChanges, playersDoubleBooked: doubleBook,
      schedulesBenchingExactlyOddPlayer: benchedOk, maxGamesSpreadBetweenTeams: Math.max(...gamesSpread) });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════
// TOURNAMENT
// ═══════════════════════════════════════════════════════════════════

function tournamentRun(cfg) {
  const { players, courts, partners, skills } = cfg;
  T.start('tournament', courts);
  players.forEach(n => T.add(n));
  (partners || []).forEach(([a, b]) => T.partner(a, b));
  Object.entries(skills || {}).forEach(([n, lvl]) => App.setPlayerSkillLevel(T.id(n), lvl));
  App.bracketLockPlayers();
  const ui = { beforeGenerate: T.btn() };
  T.clickBtn(); // Generate Bracket (also starts round 1 on the available courts)
  const bracket0 = JSON.parse(JSON.stringify(App.state._bracket));
  const label = side => side ? T.names(side).join(' & ') : '(bye)';
  const round1 = bracket0[0].map(m => ({ match: m.id, side1: label(m.side1), side2: label(m.side2), bye: m.bye }));
  const teamCount = new Set(bracket0[0].flatMap(m => [m.side1, m.side2].filter(Boolean).map(T.teamKey))).size;
  const problems = [];
  const log = [];
  const losses = {};
  let min = 0, played = 0, guard = 0;
  // Tie and blank scores must be refused, and must not advance anyone.
  const firstCourt = Number(Object.keys(App.state.activeGames)[0]);
  const tieErr = T.finish(firstCourt, 9, 9, 'all');
  const blankErr = T.finish(firstCourt, null, null, 'all');
  const stillActive = !!App.state.activeGames[firstCourt];
  App.cancelScoring(firstCourt);
  if (!tieErr || !blankErr || !stillActive) problems.push('Tie/blank score was not rejected');
  while (!App.bracketIsComplete() && guard++ < 50) {
    const courtsNow = T.activeCourts();
    if (courtsNow.length) {
      const roundName = App._bracketRoundName(App.state._bracketCurrentRound, App.state._bracket.length);
      min += 15; T.advanceTo(min);
      for (const c of courtsNow) {
        const [a, b] = T.randomScore();
        T.finish(c.court, a, b, 'all');
        played++;
        const loser = a > b ? c.side2 : c.side1, winner = a > b ? c.side1 : c.side2;
        losses[T.teamKey(loser)] = (losses[T.teamKey(loser)] || 0) + 1;
        log.push(`${roundName} · C${c.court}: ${label(c.side1)} vs ${label(c.side2)}  ${a}–${b}  → ${label(winner)} advance`);
      }
      continue;
    }
    const b = T.btn();
    if (b.disabled) { problems.push(`Stuck: button "${b.text}" disabled with no active courts`); break; }
    log.push(`[button] ${b.text}`);
    T.clickBtn();
  }
  const champ = App.bracketGetChampion();
  const final = App.state._bracket;
  // Winners must be exactly the side that won each recorded score.
  final.forEach((r, ri) => r.forEach(m => {
    if (m.bye || !m.side1 || !m.side2) return;
    const w = m.score1 > m.score2 ? 1 : 2;
    if (m.winner !== w) problems.push(`Match ${m.id}: recorded winner does not match score`);
    if (ri + 1 < final.length) {
      const next = final[ri + 1].find(n => [n.side1, n.side2].some(s => s && T.teamKey(s) === T.teamKey(w === 1 ? m.side1 : m.side2)));
      if (!next) problems.push(`Match ${m.id}: winner did not advance`);
    }
  }));
  const multiLoss = Object.entries(losses).filter(([, n]) => n > 1);
  if (multiLoss.length) problems.push('A team lost more than once (single elimination broken)');
  if (played !== teamCount - 1) problems.push(`Expected ${teamCount - 1} matches, played ${played}`);
  if (!champ) problems.push('No champion');
  return {
    teamCount, bracketSize: bracket0[0].length * 2, rounds: final.length,
    byes: bracket0[0].filter(m => m.bye).length, round1, ui, log, played,
    champion: champ ? champ.map(p => p.name).join(' & ') : null,
    rejected: { tie: tieErr, blank: blankErr }, finalButton: T.btn().text, problems,
  };
}

// ═══════════════════════════════════════════════════════════════════

async function run(name, fn, arg, screenshot) {
  const { page, ctx, errors } = await freshPage();
  const t0 = Date.now();
  const result = await page.evaluate(`(${fn.toString()})(${JSON.stringify(arg || {})})`);
  if (screenshot) {
    await page.evaluate(() => { App.switchTab('courts'); window.scrollTo(0, 0); });
    await page.screenshot({ path: path.join(OUT, screenshot), fullPage: true });
  }
  await ctx.close();
  return { name, ms: Date.now() - t0, pageErrors: errors, ...result };
}

async function shoot(file, setup) {
  const { page, ctx } = await freshPage();
  await page.evaluate(setup);
  await page.evaluate(() => { App.switchTab('courts'); window.scrollTo(0, 0); });
  await page.waitForTimeout(150);
  await page.screenshot({ path: path.join(OUT, file), fullPage: true });
  await ctx.close();
}

(async () => {
  browser = await chromium.launch();
  const results = {};

  // ── Open Play ──
  const dropIn = {
    courts: 2,
    initial: NAMES.slice(0, 8),
    endMin: 120,
    events: [
      { min: 8, type: 'join', name: 'Indy' },
      { min: 17, type: 'join', name: 'Jordan' },
      { min: 31, type: 'join', name: 'Kai' },
      { min: 31, type: 'join', name: 'Logan' },
      { min: 44, type: 'sitOut', name: 'Casey' },
      { min: 52, type: 'join', name: 'Morgan' },
      { min: 66, type: 'rejoin', name: 'Casey' },
      { min: 75, type: 'sitOut', name: 'Emery' },
      { min: 88, type: 'join', name: 'Noel' },
    ],
  };
  results.openDropIn = await run('Open Play — drop-in session', openPlayDropIn, dropIn);
  // Same timeline 30 more times with random match lengths/scores, to show
  // the priority rule holds every time, not just once.
  const repeats = [];
  const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
  const FULL = ['Avery', 'Blake', 'Devon', 'Finley', 'Gray', 'Harper']; // there 9:00 to the end, never sat out
  const LATE = ['Indy', 'Jordan', 'Kai', 'Logan', 'Morgan']; // Noel arrives too late for a fair per-hour number
  for (let i = 0; i < 30; i++) repeats.push(await run('dropIn', openPlayDropIn, dropIn));
  results.openDropInRepeat = {
    runs: repeats.length,
    totalFills: repeats.reduce((s, r) => s + r.fills.length, 0),
    priorityViolations: repeats.reduce((s, r) => s + r.violations.length, 0),
    passedOverBy: repeats.reduce((s, r) => s + r.passedOverBy.length, 0),
    passedOverExamples: repeats.flatMap(r => r.passedOverBy).slice(0, 5),
    lateJoinersPassedOver: repeats.reduce((s, r) => s + r.lateJoiners.filter(l => l.courtFillsBeforeFirstGame > 0).length, 0),
    // A late joiner may only wait behind people who were already waiting
    // when they arrived — never behind someone who came off a court after
    // they got there.
    lateJoinersSkippedForNewer: repeats.reduce((s, r) => {
      const late = new Set(r.lateJoiners.map(l => l.name));
      return s + r.passedOverBy.filter(v => late.has(v.skipped)).length;
    }, 0),
    lateJoinerCount: repeats.reduce((s, r) => s + r.lateJoiners.length, 0),
    // Games per hour present: players there all session vs. late joiners.
    // Close numbers mean late joiners neither miss out nor get extra games.
    gamesPerHourFullSession: +(avg(repeats.flatMap(r => FULL.map(n => r.stats[n].gamesPerHour)))).toFixed(2),
    gamesPerHourLateJoiners: +(avg(repeats.flatMap(r => LATE.map(n => r.stats[n].gamesPerHour)))).toFixed(2),
    doubleBooked: repeats.reduce((s, r) => s + r.doubleBooked.length, 0),
    sittingAssigned: repeats.reduce((s, r) => s + r.sittingAssigned.length, 0),
    maxFillsSatInARow: Math.max(...repeats.flatMap(r => Object.values(r.stats).map(s => s.maxFillsSatInARow))),
    lateJoinerMaxMinutesWaited: Math.max(...repeats.flatMap(r => r.lateJoiners.map(l => l.minutesWaited ?? 0))),
    lateJoinerMaxFillsBeforeFirstGame: Math.max(...repeats.flatMap(r => r.lateJoiners.map(l => l.courtFillsBeforeFirstGame))),
    fullSessionGamesSpread: Math.max(...repeats.map(r => {
      const g = ['Avery', 'Blake', 'Devon', 'Finley', 'Gray', 'Harper'].map(n => r.stats[n].games);
      return Math.max(...g) - Math.min(...g);
    })),
    pageErrors: repeats.flatMap(r => r.pageErrors),
  };
  results.openSmall = await run('Open Play — 5 players, 1 court', openPlayDropIn, { courts: 1, initial: NAMES.slice(0, 5), endMin: 90, events: [] });
  {
    const small = [];
    for (let i = 0; i < 30; i++) small.push(await run('small', openPlayDropIn, { courts: 1, initial: NAMES.slice(0, 5), endMin: 90, events: [] }));
    const spreads = small.map(r => { const g = Object.values(r.stats).map(s => s.games); return Math.max(...g) - Math.min(...g); });
    results.openSmallRepeat = { runs: small.length, matchesEach: small.map(r => r.matches), priorityViolations: small.reduce((s, r) => s + r.violations.length, 0),
      gamesSpreadHistogram: spreads.reduce((h, x) => { h[x] = (h[x] || 0) + 1; return h; }, {}),
      maxFillsSatInARow: Math.max(...small.flatMap(r => Object.values(r.stats).map(s => s.maxFillsSatInARow))) };
  }
  if (process.env.ONLY_RR_STRESS) {
    const { page, ctx } = await freshPage();
    const st = await page.evaluate(`(${roundRobinStress.toString()})(${JSON.stringify({ trials: 100, configs: [8, 10, 12, 14, 16].map(n => ({ players: n, courts: Math.ceil(Math.floor(n / 2) / 2) })) })})`);
    console.log(JSON.stringify(st.map(s => ({ players: s.players, teams: s.teams, rounds: s.rounds, schedulesWithRepeatOpponents: s.schedulesWithRepeatOpponents, of: s.trials }))));
    await browser.close(); process.exit(0);
  }
  results.openRotation = await run('Open Play — rotation choices', openPlayRotation);
  results.openPartners = await run('Open Play — locked partners', openPlayPartners);
  results.partnerLateLink = await run('Partners — Player 2 links while Player 1 is on court', partnerLateLink);
  results.partnerRanksAsAverage = await run('Partners — pair ranks as the average of the two', partnerRanksAsAverage);
  results.onePartner = await run('Partners — one at a time', onePartnerAtATime);
  {
    const runs = [];
    for (let i = 0; i < 30; i++) runs.push(await run('partnerDropIn', partnerDropIn));
    results.partnerDropIn = { runs: runs.length, fills: runs.reduce((s, r) => s + r.fills, 0), problems: runs.flatMap(r => r.problems), pageErrors: runs.flatMap(r => r.pageErrors), sampleGames: runs[0].games };
  }

  // ── Round Robin ──
  results.rrFull8 = await run('Round Robin — 8 players, 2 courts (full rounds)', roundRobinRun, { players: NAMES.slice(0, 8), courts: 2, play: true });
  results.rrOdd10 = await run('Round Robin — 10 players / 5 teams, 2 courts (bye each round)', roundRobinRun, { players: NAMES.slice(0, 10), courts: 2, play: true });
  results.rrOddPlayer9 = await run('Round Robin — 9 players (odd player benched)', roundRobinRun, { players: NAMES.slice(0, 9), courts: 2, play: false });
  results.rrPartners12 = await run('Round Robin — 12 players with 2 locked partner pairs, 3 courts', roundRobinRun, { players: NAMES.slice(0, 12), courts: 3, partners: [['Avery', 'Blake'], ['Casey', 'Devon']], play: true });
  results.rrTimeCap = await run('Round Robin — 12 players, 3 courts, 1 hr time limit', roundRobinRun, { players: NAMES.slice(0, 12), courts: 3, timeLimit: { matchMinutes: 12, sessionHours: 1, buffer: 3 }, play: true });
  results.rrFewCourts = await run('Round Robin — 16 players / 8 teams, only 2 courts', roundRobinRun, { players: NAMES.slice(0, 16), courts: 2, play: true });
  {
    const { page, ctx } = await freshPage();
    results.rrStress = await page.evaluate(`(${roundRobinStress.toString()})(${JSON.stringify({
      trials: 100,
      configs: [4, 6, 8, 9, 10, 12, 14, 16, 18, 20].map(n => ({ players: n, courts: Math.ceil(Math.floor(n / 2) / 2) })),
    })})`);
    results.rrFewCourtsStress = await page.evaluate(`(${roundRobinStress.toString()})(${JSON.stringify({
      trials: 100, configs: [{ players: 12, courts: 2 }, { players: 16, courts: 2 }, { players: 16, courts: 3 }],
    })})`);
    await ctx.close();
  }

  // ── Tournament ──
  results.t8 = await run('Tournament — 8 players / 4 teams, 2 courts', tournamentRun, { players: NAMES.slice(0, 8), courts: 2 });
  results.t10seeded = await run('Tournament — 5 seeded teams (3 byes), 2 courts', tournamentRun, {
    players: NAMES.slice(0, 10), courts: 2,
    partners: [['Avery', 'Blake'], ['Casey', 'Devon'], ['Emery', 'Finley'], ['Gray', 'Harper'], ['Indy', 'Jordan']],
    skills: { Avery: 'advanced', Blake: 'advanced', Casey: 'advanced', Devon: 'intermediate', Emery: 'intermediate', Finley: 'intermediate', Gray: 'beginner', Harper: 'intermediate', Indy: 'beginner', Jordan: 'beginner' },
  });
  results.t14 = await run('Tournament — 14 players / 7 teams, only 2 courts', tournamentRun, { players: NAMES.slice(0, 14), courts: 2 });
  const tStress = [];
  for (const n of [4, 6, 8, 10, 12, 16, 20]) for (let i = 0; i < 8; i++) tStress.push({ n, ...(await run('t', tournamentRun, { players: NAMES.slice(0, n), courts: 2 })) });
  results.tStress = [4, 6, 8, 10, 12, 16, 20].map(n => {
    const rs = tStress.filter(r => r.n === n);
    return { players: n, teams: rs[0].teamCount, bracketSize: rs[0].bracketSize, byes: rs[0].byes, runs: rs.length,
      allCompletedWithChampion: rs.every(r => r.champion), matchesPlayed: rs[0].played, problems: rs.flatMap(r => r.problems), pageErrors: rs.flatMap(r => r.pageErrors) };
  });

  // ── Screenshots of the real UI mid-session ──
  await shoot('open-play.png', () => {
    T.start('open', 2); ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jordan', 'Kai'].forEach(n => T.add(n));
    App.autoFillCourt(1); App.startProposedMatch(1); T.advanceTo(6); App.autoFillCourt(2);
  });
  await shoot('round-robin.png', () => {
    T.start('roundrobin', 2); ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jordan'].forEach(n => T.add(n));
    App.rrLockPlayers(); T.clickBtn(); T.clickBtn();
  });
  await shoot('tournament.png', () => {
    T.start('tournament', 2); ['Avery', 'Blake', 'Casey', 'Devon', 'Emery', 'Finley', 'Gray', 'Harper', 'Indy', 'Jordan'].forEach(n => T.add(n));
    App.bracketLockPlayers(); T.clickBtn();
  });

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));

  // ── Summary ──
  const checks = [];
  const ck = (label, ok, detail) => checks.push({ label, ok, detail });
  const d = results.openDropIn;
  ck('Open Play: every Auto-fill picked the longest-waiting players', d.violations.length === 0, `${d.fills.length} fills, ${d.violations.length} violations`);
  ck('Open Play: 30 randomized repeats, zero priority violations', results.openDropInRepeat.priorityViolations === 0, `${results.openDropInRepeat.totalFills} fills`);
  ck('Open Play: nobody waiting is passed over by someone who started waiting later (incl. players coming off court)', d.passedOverBy.length === 0 && results.openDropInRepeat.passedOverBy === 0, `${results.openDropInRepeat.passedOverBy} across ${results.openDropInRepeat.totalFills} fills`);
  ck('Open Play: a late joiner only ever waits behind people who were already waiting when they arrived', results.openDropInRepeat.lateJoinersSkippedForNewer === 0, `${results.openDropInRepeat.lateJoinersSkippedForNewer} times skipped for a newer player; ${results.openDropInRepeat.lateJoinersPassedOver} of ${results.openDropInRepeat.lateJoinerCount} arrivals waited at least one fill`);
  ck('Open Play: late joiners get no extra games (games/hr within 0.25 of full-session players)', results.openDropInRepeat.gamesPerHourLateJoiners - results.openDropInRepeat.gamesPerHourFullSession <= 0.25, `late ${results.openDropInRepeat.gamesPerHourLateJoiners}/hr vs full-session ${results.openDropInRepeat.gamesPerHourFullSession}/hr`);
  ck('Open Play: nobody double-booked or pulled from Sitting Out', results.openDropInRepeat.doubleBooked + results.openDropInRepeat.sittingAssigned + d.doubleBooked.length + d.sittingAssigned.length === 0);
  ck('Open Play: Keep Winners / Keep Last-Joined behave correctly', results.openRotation.problems.length === 0, results.openRotation.problems.join('; '));
  ck('Open Play: locked partners never split', results.openPartners.problems.length === 0, results.openPartners.problems.join('; '));
  ck('Partners: Player 2 linking mid-match waits for Player 1, then they go on together', results.partnerLateLink.problems.length === 0, results.partnerLateLink.problems.join('; '));
  ck('Partners: a pair ranks as the average of the two partners', results.partnerRanksAsAverage.problems.length === 0, results.partnerRanksAsAverage.problems.join('; '));
  ck('Partners: one partner at a time (change, picker, old sessions, Sitting Out)', results.onePartner.problems.length === 0, results.onePartner.problems.join('; '));
  ck('Partners: 30 randomized sessions, every fill follows the pair rules', results.partnerDropIn.problems.length === 0, `${results.partnerDropIn.fills} fills; ${results.partnerDropIn.problems.slice(0, 3).join('; ')}`);
  for (const k of ['rrFull8', 'rrOdd10', 'rrOddPlayer9', 'rrPartners12', 'rrTimeCap', 'rrFewCourts']) {
    const r = results[k];
    ck(`${r.name}: no repeat opponents, fixed partners, nobody double-booked`, !r.analysis.repeats.length && !r.analysis.partnerChanges.length && !r.analysis.doubleInRound.length && !r.problems.length, r.problems.join('; '));
  }
  ck('Round Robin stress: 0 schedules with repeat opponents', results.rrStress.every(s => s.schedulesWithRepeatOpponents === 0) && results.rrFewCourtsStress.every(s => s.schedulesWithRepeatOpponents === 0));
  ck('Round Robin stress: full courts → every matchup covered, equal byes', results.rrStress.every(s => s.schedulesCoveringEveryMatchup === s.trials && s.schedulesWithEqualByes === s.trials));
  for (const k of ['t8', 't10seeded', 't14']) ck(`${results[k].name}: completes with a champion`, results[k].problems.length === 0, results[k].problems.join('; '));
  ck('Tournament stress: every bracket completes correctly', results.tStress.every(s => s.allCompletedWithChampion && !s.problems.length));
  const pageErrs = Object.values(results).flatMap(r => (r && r.pageErrors) || []);
  ck('No JavaScript errors on the page', pageErrs.length === 0, pageErrs.slice(0, 3).join(' | '));
  fs.writeFileSync(path.join(OUT, 'checks.json'), JSON.stringify(checks, null, 2));
  checks.forEach(c => console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  — ${c.detail}` : ''}`));
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed. Results: ${path.join(OUT, 'results.json')}`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
