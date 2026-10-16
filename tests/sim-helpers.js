// Browser-side helpers for tests/session-assignments.test.cjs.
// Injected into the real index.html after it loads; drives the same App
// methods the on-screen buttons call (Auto-fill, Start Match, End, Save,
// Generate Schedule, Start Round, etc.) inside an offline Quick Play session,
// so nothing touches Firebase.
window.T = {
  // ─── Simulated clock ──────────────────────────────
  // Date.now() is overridden in an init script (see the runner) to read
  // window.__simNow, so join times / lastActiveAt / match start times follow
  // a realistic timeline instead of all landing in the same millisecond.
  minute() { return Math.round((window.__simNow - window.__simBase) / 60000); },
  advanceTo(min) { window.__simNow = Math.max(window.__simNow, window.__simBase + min * 60000); },
  clock(min) {
    const t = new Date(window.__simBase + (min == null ? this.minute() : min) * 60000);
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')}`;
  },

  // ─── Session setup ────────────────────────────────
  start(type, courts) {
    Onboard._startOfflineSession(type);
    App.setAvailableCourts(courts || 1);
  },
  // Same path as typing a name into "Add player" and tapping Add.
  add(name) {
    const el = document.getElementById('queueAddPlayerName');
    el.value = name;
    App.submitQueueAddPlayer();
    return this.id(name);
  },
  addMany(names) { return names.map(n => this.add(n)); },
  id(name) { const p = App.state.players.find(x => x.name === name); return p ? p.id : null; },
  name(id) { const p = App.getPlayer(id); return p ? p.name : '?'; },
  names(ids) { return (ids || []).map(id => this.name(id)); },
  // Same as dragging/tapping a player onto "Sit Out" / back to "Enter Queue".
  sitOut(name) { App._movePlayer(this.id(name), { type: 'queue' }, { type: 'waiting' }); },
  rejoin(name) { App._movePlayer(this.id(name), { type: 'waiting' }, { type: 'queue' }); },
  // A locked current partnership (what "Add Partner" creates).
  partner(a, b, extra) {
    App.state.teams.push({ id: App.state.nextId++, p1: this.id(a), p2: this.id(b), doNotSplit: true, current: true, ...(extra || {}) });
    App.saveState(); App.render();
  },

  // ─── Court actions ────────────────────────────────
  // End a running court and save its score, the same as tapping End, typing
  // both scores and tapping Save (mode 'all' = Return All 4) or one of the
  // Open Play rotation choices ('winners' / 'lastJoined').
  finish(courtId, score1, score2, mode) {
    if (!App.state.scoringGames[courtId]) App.endGame(courtId);
    const a = document.getElementById(`score-s1-${courtId}`);
    const b = document.getElementById(`score-s2-${courtId}`);
    if (!a || !b) throw new Error(`score inputs for court ${courtId} not rendered`);
    a.value = score1 == null ? '' : String(score1);
    b.value = score2 == null ? '' : String(score2);
    if (mode && mode !== 'all') App.chooseRotation(courtId, mode);
    else App.submitScore(courtId, 'all');
    return document.getElementById(`score-err-${courtId}`)?.textContent || '';
  },
  randomScore() {
    const loser = Math.floor(Math.random() * 10);
    return Math.random() < 0.5 ? [11, loser] : [loser, 11];
  },
  btn() {
    const b = document.getElementById('btnAssignAll');
    return { text: b.textContent.trim(), disabled: b.disabled, visible: b.offsetParent !== null };
  },
  clickBtn() { document.getElementById('btnAssignAll').click(); },
  activeCourts() {
    return Object.entries(App.state.activeGames).map(([c, g]) => ({ court: Number(c), side1: [...g.side1], side2: [...g.side2] }));
  },
  key(a, b) { return a < b ? `${a}-${b}` : `${b}-${a}`; },
  teamKey(side) { return [...side].sort((x, y) => x - y).join('&'); },
};
