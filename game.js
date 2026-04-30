/* ===========================
   最愛のガラテア — Game Logic + UI
   =========================== */

const NUM_ERAS = 5;
const NUM_PLAYERS = 4;
const MAX_ROUNDS = 8;
const MIN_CONF_ROUND = 4;

// ===== AI personalities =====
//
// Each AI gets one personality. They diverge on five axes that all reflect
// the current rule set (疾患はカード削除でしか治癒できない / 自家交配の
// 顕性→劣勢→疾患カスケード / Stud Fee 0・1・2 VP の任意指定 / etc.):
//
//   1. scoreMult     — per-action priority bias used by aiTakeTurn
//   2. freeUse(p,id) — which research cards to burn opportunistically
//   3. pickInterfereTarget / pickCollabTarget / pickNominateTarget
//                    — who the AI targets when it picks each action
//   4. pickNominateOptions(p, target) — Stud Fee policy:
//        returns { mine, myIdx?, theirs, theirIdx? } where each side is
//        either 'random' (1d6) or 'designate' (任意指定). Cost = number of
//        designated sides (0 / 1 / 2 VP). The helper pickBestSlot is used
//        to pick the slot to give away (worst contribution) or grab (best).
//   5. wantsSelfCross(p) — gate for the self-nominate action. With the new
//        cascade rule, a roll on a recessive slot turns it into 疾患, and
//        疾患 can only be cured by deleting the allele. So personalities
//        that hate disease should refuse self-cross when many recessives
//        are already on the board.
const PERSONALITIES = {
  attacker: {
    label: '攻撃型',
    icon: '⚔',
    color: '#d46b6b',
    flavor: '妨害と速攻。盤面をかき回し、リーダーから狙ったカードを引き抜く。Stud Fee は惜しまない。',
    scoreMult: {
      conference:     1.40,  // close it the moment I'm ahead
      draw_memory:    1.30,  // takes risks for high-tier rewards
      remove_allele:  0.55,  // tolerates disease (won't waste actions cleaning)
      self_nominate:  0.85,  // disease cascade is now too painful to chase recklessly
      nominate_other: 2.30,  // attack the leader
      draw_research:  1.05,
      pass:           0.20,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (cardId === 'r_present')   return has('r_present');
      if (cardId === 'r_paper')     return has('r_paper') && G.era >= 3;
      if (cardId === 'r_genome')    return has('r_genome');
      // Tolerates disease longer; only purges when stacked.
      if (cardId === 'r_antidote')  return has('r_antidote') && diseaseCount(p) >= 2;
      if (cardId === 'r_dominant')  return has('r_dominant') && p.slots.some(s => s && s.recessive && !s.disease) && G.era >= 3;
      if (cardId === 'r_collab')    return false;                               // refuses mutual benefit
      if (cardId === 'r_interfere') return has('r_interfere');                  // always swings
      if (cardId === 'r_foresight') return has('r_foresight') && G.era <= 3;
      return false;
    },
    pickInterfereTarget(p, others) {
      const goal = GOAL_BY_ID[G.goals[G.era - 1]];
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];
    },
    pickCollabTarget()                  { return null; },
    pickNominateTarget(p, others, goal) {
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];      // goal leader
    },
    pickNominateOptions(p, target) {
      // Pay 2 to grab a key card from the leader the moment I can afford it.
      // Pay 1 to designate target's side if 2 is unaffordable.
      const tgtBest = pickBestSlot(target, /*worstFirst*/ false);
      if (tgtBest == null) return { mine: 'random', theirs: 'random' };
      if (p.vp >= 2 && G.era >= 2) {
        const myWorst = pickBestSlot(p, /*worstFirst*/ true);
        if (myWorst != null) {
          return { mine: 'designate', myIdx: myWorst, theirs: 'designate', theirIdx: tgtBest };
        }
      }
      if (p.vp >= 1) return { mine: 'random', theirs: 'designate', theirIdx: tgtBest };
      return { mine: 'random', theirs: 'random' };
    },
    wantsSelfCross(p) {
      // Self-cross only when a flip would clearly help and disease risk is low.
      const recCount = recessiveCount(p);
      return recCount <= 1 && diseaseCount(p) === 0;
    },
  },

  defender: {
    label: '守備型',
    icon: '🛡',
    color: '#7aa8e9',
    flavor: '疾患を絶対に避け、削除アクションで盤面を磨き続ける。Stud Fee は払わず、平和的に交換する。',
    scoreMult: {
      claim:          1.15,
      remove_allele:  1.75,  // disease can only be removed via deletion
      draw_memory:    0.55,  // -VP risk on misses
      self_nominate:  0.20,  // self-cross risks disease cascade — almost never
      nominate_other: 0.45,  // peace-loving, occasional only
      conference:     0.90,
      draw_allele:    1.15,
      pass:           1.45,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (cardId === 'r_present')   return has('r_present');
      if (cardId === 'r_paper')     return has('r_paper') && G.era >= 3;
      if (cardId === 'r_genome')    return has('r_genome');
      if (cardId === 'r_antidote')  return has('r_antidote') && diseaseCount(p) > 0;        // any disease → cure ASAP
      if (cardId === 'r_dominant')  return has('r_dominant') && p.slots.some(s => s && s.recessive && !s.disease);  // pre-empt disease
      if (cardId === 'r_collab')    return has('r_collab');                                  // safe mutual gain
      if (cardId === 'r_interfere') return false;                                            // pacifist
      if (cardId === 'r_foresight') return has('r_foresight') && G.era <= 3;
      return false;
    },
    pickCollabTarget(p, others) {
      return [...others].sort((a, b) => a.vp - b.vp)[0];                                     // help the laggard
    },
    pickInterfereTarget()  { return null; },
    pickNominateTarget()   { return null; },
    pickNominateOptions()  {
      // If forced to nominate, never burn VP — random keeps the wallet safe.
      return { mine: 'random', theirs: 'random' };
    },
    wantsSelfCross() {
      // Defender never voluntarily self-crosses — it cascades to disease.
      return false;
    },
  },

  exploiter: {
    label: '搾取型',
    icon: '⚖',
    color: '#d4a851',
    flavor: '指名交換と共同研究で稼ぐ商人。1VP で相手の最善カードだけ抜き取るのが得意。',
    scoreMult: {
      claim:          1.10,
      conference:     1.10,
      draw_research:  1.30,                                                      // hoard tools to trade
      nominate_other: 1.95,                                                      // exchange-heavy
      remove_allele:  1.05,
      self_nominate:  0.70,
      draw_memory:    0.95,
      pass:           0.85,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (cardId === 'r_present')   return has('r_present');
      if (cardId === 'r_paper')     return has('r_paper') && G.era >= 3;
      if (cardId === 'r_genome')    return has('r_genome');
      if (cardId === 'r_antidote')  return has('r_antidote') && diseaseCount(p) > 0;
      if (cardId === 'r_dominant')  return has('r_dominant') && p.slots.some(s => s && s.recessive && !s.disease);
      if (cardId === 'r_collab')    return has('r_collab');                                  // always trade
      if (cardId === 'r_interfere') return has('r_interfere') && G.era >= 4;                 // late-game only
      if (cardId === 'r_foresight') return has('r_foresight');
      return false;
    },
    pickCollabTarget(p, others) {
      return [...others].sort((a, b) => a.vp - b.vp)[0];                                     // minimal threat boost
    },
    pickInterfereTarget(p, others) {
      const goal = GOAL_BY_ID[G.goals[G.era - 1]];
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];
    },
    pickNominateTarget(p, others) {
      // The richest source of variety — best chance of hitting a useful card.
      return [...others].sort((a, b) => uniqueAlleleCount(b) - uniqueAlleleCount(a))[0];
    },
    pickNominateOptions(p, target) {
      // Efficient: pay 1 to designate target's side (cherry-pick), keep own random.
      const tgtBest = pickBestSlot(target, /*worstFirst*/ false);
      if (p.vp >= 1 && tgtBest != null) {
        return { mine: 'random', theirs: 'designate', theirIdx: tgtBest };
      }
      // No VP for a fee — fall back to free random rather than skip the action.
      return { mine: 'random', theirs: 'random' };
    },
    wantsSelfCross(p) {
      // Only self-cross when it pays for a clear memory/goal jump and no disease tail.
      return diseaseCount(p) === 0 && recessiveCount(p) === 0;
    },
  },
};
const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

// ===== State =====
const G = {
  era: 1,
  round: 1,
  turnIndex: 0,        // 0..3, rotation order from startPlayer
  presidentIdx: 0,     // absolute player index
  players: [],
  alleleDeck: [],
  alleleDiscard: [],
  researchDeck: [],
  researchDiscard: [],
  memoryDeck: [],
  goals: [],           // 5 goal IDs (eras 1..5)
  log: [],
  pending: null,
  ended: false,
  conferenceVPs: [],   // [{era, playerId, rank, vp, goalId}]
  conferenceHistory: [],  // [{era, winnerId, goalId}]
  lastDieRoll: { value: null, reason: '' },
  setupChoice: { name: 'あなた', characterId: 'daughter' },
  charactersUsed: [],
};

// ===== Utilities =====
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const PIP_POSITIONS = {
  1: ['c'],
  2: ['tl', 'br'],
  3: ['tl', 'c', 'br'],
  4: ['tl', 'tr', 'bl', 'br'],
  5: ['tl', 'tr', 'c', 'bl', 'br'],
  6: ['tl', 'tr', 'ml', 'mr', 'bl', 'br'],
};
function buildDie(value) {
  const die = el('div', { class: 'die', 'data-face': String(value) });
  if (value == null) { die.className = 'die empty'; return die; }
  for (const pos of PIP_POSITIONS[value]) {
    die.appendChild(el('div', { class: `pip pip-${pos}` }));
  }
  return die;
}
// In-cutin die roll: tumbles and settles within a given slot element
function animateDieIn(slot, finalValue) {
  if (!slot) return;
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push(Math.floor(Math.random() * 6) + 1);
  frames.push(finalValue);
  let i = 0;
  slot.innerHTML = '';
  const place = (v, rolling) => {
    slot.innerHTML = '';
    const d = buildDie(v);
    if (rolling) d.classList.add('rolling');
    slot.appendChild(d);
  };
  place(frames[0], true);
  const tick = setInterval(() => {
    if (!slot.parentNode) { clearInterval(tick); return; }
    i++;
    if (i >= frames.length) {
      clearInterval(tick);
      place(finalValue, false);
      return;
    }
    place(frames[i], i < frames.length - 1);
  }, 90);
}

function rollD6(reason = '') {
  const v = Math.floor(Math.random() * 6) + 1;
  G.lastDieRoll = { value: v, reason };
  return v;
}

// ===== Cut-in system =====
//
// Strict invariants:
//   1. At most ONE cutin is in the DOM at a time. Never overlap.
//   2. The queue is FIFO. New cutins always go to the end.
//   3. After-cutin hooks run sequentially, ONE per drain cycle. A hook may
//      queue zero or more new cutins; if it queues any, those play before
//      the next hook fires.
//   4. Cutins NEVER auto-advance. Only the user's ▶ 次へ click progresses.
//
// State:
//   G.cutinQueue       — pending cutin opts (FIFO)
//   G.afterCutinHooks  — pending post-drain callbacks (FIFO)
//   G.cutinOnScreen    — true while a cutin is visible (display → dismiss)
//   G.cutinDriving     — re-entrancy guard for runDriver()
G.cutinQueue       = G.cutinQueue       || [];
G.afterCutinHooks  = G.afterCutinHooks  || [];
G.cutinOnScreen    = false;
G.cutinDriving     = false;

function showCutin(opts) {
  G.cutinQueue.push(opts);
  runDriver();
}

// Runs `fn` once all currently queued/displayed cutins have been dismissed
// AND any cutins those dismisses queue have also drained. If nothing is in
// flight, runs synchronously.
function runAfterCutins(fn) {
  if (G.cutinQueue.length === 0 && !G.cutinOnScreen && !G.cutinDriving) {
    return fn();
  }
  G.afterCutinHooks.push(fn);
}

// The driver loop. Idempotent and re-entrancy-safe: nested calls return
// immediately. The outer call drives until either a cutin is on screen
// (waiting for the user) or there is nothing left to do.
function runDriver() {
  if (G.cutinDriving) return;
  G.cutinDriving = true;
  const layer = $('cutin-layer');
  try {
    while (true) {
      // Cutin already visible → wait for its dismiss to wake us up.
      if (G.cutinOnScreen) return;

      // Pending cutin → display next.
      if (G.cutinQueue.length > 0) {
        const opts = G.cutinQueue.shift();
        displayCutin(opts, layer);
        return;  // cutinOnScreen is now true
      }

      // No cutins queued. Drain one hook. If it queues cutins, the loop
      // displays them on the next iteration. If it queues nothing, the
      // loop drains the next hook.
      if (G.afterCutinHooks.length > 0) {
        const h = G.afterCutinHooks.shift();
        try { h(); } catch (e) { console.error(e); }
        continue;
      }

      // Nothing to do.
      if (layer) layer.classList.remove('active');
      scheduleAITurnIfNeeded();
      return;
    }
  } finally {
    G.cutinDriving = false;
  }
}

// Back-compat shim — older code paths still call playNextCutin.
function playNextCutin() { runDriver(); }

// Builds DOM for one cutin, attaches it to the layer, and wires up dismiss.
function displayCutin(opts, layer) {
  if (!layer) return;
  G.cutinOnScreen = true;
  layer.classList.add('active');

  const cutin = el('div', { class: 'cutin ' + (opts.kind || '') });
  const row = el('div', { class: 'cutin-row' });
  if (opts.image) {
    row.appendChild(el('div', { class: 'cutin-img', style: `background-image:url(${opts.image})` }));
  }
  const inner = el('div', {});
  if (opts.title) inner.appendChild(el('div', { class: 'cutin-title' }, opts.title));
  if (opts.subtitle) inner.appendChild(el('div', { class: 'cutin-subtitle' }, opts.subtitle));
  if (opts.lines) {
    const list = el('div', { class: 'cutin-lines' });
    opts.lines.forEach((ln, i) => {
      list.appendChild(el('div', { class: 'cutin-line rank-' + (i + 1) }, ln));
    });
    inner.appendChild(list);
  }
  if (opts.diceRolls && opts.diceRolls.length > 0) {
    const wrap = el('div', { class: 'cutin-dice-wrap' });
    opts.diceRolls.forEach((r, idx) => {
      const item = el('div', { class: 'cutin-dice-item' + (r.triggered ? ' triggered' : '') });
      item.appendChild(el('div', { class: 'cutin-dice-label' }, r.label || ''));
      const dieSlot = el('div', { class: 'cutin-dice-die' });
      dieSlot.appendChild(buildDie(null));
      item.appendChild(dieSlot);
      item.appendChild(el('div', { class: 'cutin-dice-outcome' }, r.outcome || ''));
      wrap.appendChild(item);
      setTimeout(() => animateDieIn(dieSlot, r.value), 350 + idx * 250);
    });
    inner.appendChild(wrap);
  }

  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    cutin.classList.add('leaving');
    setTimeout(() => {
      layer.innerHTML = '';
      G.cutinOnScreen = false;
      if (typeof opts.onDismiss === 'function') {
        try { opts.onDismiss(); } catch (e) { console.error(e); }
      }
      render();
      // Wake the driver to display the next cutin or drain the next hook.
      setTimeout(() => runDriver(), 60);
    }, 480);
  };
  const nextBtn = el('button', { class: 'cutin-next', onclick: dismiss }, '▶ 次へ');
  inner.appendChild(nextBtn);
  row.appendChild(inner);
  cutin.appendChild(row);
  layer.appendChild(cutin);
  // Auto-focus so Enter/Space on keyboard advances the queue.
  setTimeout(() => { try { nextBtn.focus(); } catch (e) {} }, 50);
}

// ===== Card render helpers (Yu-Gi-Oh-style) =====
const SYS_KEY = { 健: 'ken', 艶: 'en', 心: 'kokoro', 智: 'chi' };

function buildAlleleCard(slot, slotIdx, opts = {}) {
  if (!slot) {
    const cls = ['card', 'allele-card', 'empty'];
    if (opts.clickable) cls.push('clickable', 'target');
    const attrs = { class: cls.join(' '), 'data-pos': String(slotIdx + 1) };
    if (opts.onclick) attrs.onclick = opts.onclick;
    const e = el('div', attrs);
    e.appendChild(el('div', { class: 'card-pos' }, 'Slot ' + (slotIdx + 1)));
    return e;
  }
  const a = ALLELE_BY_ID[slot.type];
  const cls = ['card', 'allele-card'];
  if (slot.recessive) cls.push('recessive');
  if (slot.disease) cls.push('disease');
  if (opts.clickable) cls.push('clickable', 'target');
  const eff = slot.recessive ? a.rec : a.dom;
  const card = el('div', { class: cls.join(' '), 'data-sys': a.sys, ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/allele-${a.id}.jpg)` },
      el('span', { class: 'card-type' }, 'アレル'),
      el('span', { class: 'card-sys' }, a.sys)
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, a.name),
      el('div', { class: 'card-effect' }, formatEffect(eff)),
      slot.recessive ? el('div', { class: 'card-tag' }, '⚠ ' + a.dis) : null
    ),
    slot.disease ? el('div', { class: 'disease-token', title: '疾患マーカー: ' + a.dis }) : null
  );
  bindPreview(card, slot.recessive ? 'allele-recessive' : 'allele-dominant', { allele: a, slot });
  return card;
}

function buildMemoryCard(memId, p, opts = {}) {
  const m = MEMORY_BY_ID[memId];
  const ach = p.achievedMemories.includes(memId);
  const cls = ['card', 'memory-card', m.tier];
  if (ach) cls.push('achieved');
  if (opts.clickable) cls.push('clickable');
  const reward = MEMORY_REWARD[m.tier];
  const stars = m.tier === 'easy' ? '★' : m.tier === 'medium' ? '★★' : '★★★';
  const card = el('div', { class: cls.join(' '), ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/memory-${memId}.jpg)` },
      el('span', { class: 'card-type' }, '記憶'),
      el('span', { class: 'card-sys' }, stars)
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, m.name),
      el('div', { class: 'card-effect' }, m.desc),
      el('div', { class: 'card-tag' }, '+' + reward + ' / -' + reward)
    )
  );
  bindPreview(card, 'memory-' + m.tier, m);
  return card;
}

function buildResearchCard(rid, opts = {}) {
  const r = RESEARCH_BY_ID[rid];
  const cls = ['card', 'research-card'];
  if (opts.clickable) cls.push('clickable');
  const card = el('div', { class: cls.join(' '), ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/research-${rid}.jpg)` },
      el('span', { class: 'card-type' }, '研究'),
      el('span', { class: 'card-sys' }, '⚗')
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, r.name),
      el('div', { class: 'card-effect' }, r.desc)
    )
  );
  bindPreview(card, 'research', r);
  return card;
}

// Renders a face-down card back of the given kind ('memory' or 'research').
// Matches the size of regular cards so face-down hands sit nicely alongside
// face-up ones. The deck-stack back styles are reused for visual consistency.
function buildCardBack(kind) {
  return el('div', { class: 'card card-back ' + kind, title: '伏せ手札' });
}

function buildCharacterCard(charId, opts = {}) {
  const c = CHAR_BY_ID[charId];
  const cls = ['card', 'character-card'];
  if (opts.selected) cls.push('selected');
  if (opts.clickable || opts.onclick) cls.push('clickable');
  const card = el('div', { class: cls.join(' '), ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/char-${charId}.jpg)` },
      el('span', { class: 'card-type' }, c.title),
      el('span', { class: 'card-sys' }, '♛')
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, c.name),
      el('div', { class: 'card-effect' }, c.effect)
    )
  );
  bindPreview(card, 'character', c);
  return card;
}
function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const k of Object.keys(attrs)) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'onclick') e.onclick = attrs[k];
    else if (k === 'innerHTML') e.innerHTML = attrs[k];
    else if (k === 'style') e.setAttribute('style', attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    if (typeof c === 'string' || typeof c === 'number') e.appendChild(document.createTextNode(String(c)));
    else e.appendChild(c);
  }
  return e;
}
function log(msg, cls = 'event') {
  G.log.push({ msg, cls });
  if (G.log.length > 300) G.log.shift();
  renderLog();
}
function drawCard(deck, discard) {
  if (deck.length === 0) {
    if (!discard || discard.length === 0) return null;
    deck.push(...discard);
    discard.length = 0;
    shuffle(deck);
  }
  return deck.pop();
}
function activePlayer() {
  return G.players[(G.turnIndex + getStartPlayerIdx()) % NUM_PLAYERS];
}
function getStartPlayerIdx() {
  // After year end, president becomes next start player.
  // We track presidentIdx; turn order starts from president each era.
  return G.presidentIdx;
}

// ===== Setup =====
function renderSetup() {
  const picker = $('character-picker');
  picker.innerHTML = '';
  for (const c of CHARACTERS) {
    picker.appendChild(buildCharacterCard(c.id, {
      selected: G.setupChoice.characterId === c.id,
      onclick: () => { G.setupChoice.characterId = c.id; renderSetup(); }
    }));
  }
  $('player-name-input').oninput = e => { G.setupChoice.name = e.target.value || 'あなた'; };
  $('start-btn').onclick = startGame;
}

function startGame() {
  // Build decks
  G.alleleDeck = shuffle(buildAlleleDeck());
  G.alleleDiscard = [];
  G.researchDeck = shuffle(buildResearchDeck());
  G.researchDiscard = [];
  G.memoryDeck = shuffle(MEMORIES.map(m => m.id));
  // Pick 5 random goals for the eras
  const allGoalIds = shuffle(GOALS.map(g => g.id));
  G.goals = allGoalIds.slice(0, NUM_ERAS);

  // Assign characters: human first, then random AI characters
  const remainingChars = CHARACTERS.filter(c => c.id !== G.setupChoice.characterId).map(c => c.id);
  shuffle(remainingChars);

  // Assign one of each personality to the 3 AI opponents
  const personalityOrder = shuffle([...PERSONALITY_KEYS]);

  G.players = [];
  for (let i = 0; i < NUM_PLAYERS; i++) {
    const isHuman = i === 0;
    const charId = isHuman ? G.setupChoice.characterId : remainingChars[i - 1];
    const p = {
      id: i,
      name: isHuman ? G.setupChoice.name : aiName(i),
      characterId: charId,
      isAI: !isHuman,
      personality: isHuman ? null : personalityOrder[i - 1],
      slots: [null, null, null, null, null, null],
      memories: [],
      research: [],
      vp: 0,
      studFees: 0,
      maidUses: 0,    // for メイド character
      // tracking
      achievedMemories: [],  // ids
      diseaseLog: [],        // {era, slotIdx, name}
    };
    // Give 1 starting allele
    const a = drawCard(G.alleleDeck, G.alleleDiscard);
    p.slots[Math.floor(Math.random() * 6)] = { type: a, recessive: false, disease: false };
    G.players.push(p);
  }

  // Research draft: each player gets 1 research card
  // For simplicity, shown as: 8 face-up, each picks 1 in turn order.
  // We'll just give each player 1 random card.
  for (const p of G.players) {
    const r = drawCard(G.researchDeck, G.researchDiscard);
    if (r) p.research.push(r);
  }

  G.era = 1;
  G.round = 1;
  G.turnIndex = 0;
  G.presidentIdx = 0;  // human starts as president
  G.ended = false;
  G.conferenceVPs = [];

  log('★ 第一学会期、開幕。' + G.players.map(p => p.name + '(' + CHAR_BY_ID[p.characterId].name + ')').join('、') + 'が集った。', 'system');
  log('★ 公開目標: ' + GOAL_BY_ID[G.goals[0]].name + ' — ' + GOAL_BY_ID[G.goals[0]].desc, 'system');

  $('setup-screen').classList.add('hidden');
  $('game-screen').classList.remove('hidden');
  render();
  showSeasonStartCutin(1);
  scheduleAITurnIfNeeded();
}

const AI_NAMES = ['Dr. ヴァルター', 'Prof. ロザリンド', 'Mr. アシュレイ', 'Sir. レオンハルト', 'Lady ヴィヴィアン'];
function aiName(i) { return AI_NAMES[i - 1] || ('AI' + i); }

// ===== Allele placement & homozygous =====
// Returns { placed: bool, discardedNew: bool, log: string[] }
function placeAlleleInSlot(p, alleleId, slotIdx, recessive = false) {
  const allele = ALLELE_BY_ID[alleleId];
  // First, simply place
  p.slots[slotIdx] = { type: alleleId, recessive: !!recessive, disease: false };
  // Then check homozygous
  const sameSlots = [];
  for (let i = 0; i < p.slots.length; i++) {
    if (i === slotIdx) continue;
    if (p.slots[i] && p.slots[i].type === alleleId) sameSlots.push(i);
  }
  if (sameSlots.length === 0) {
    log(`${p.name}: ${allele.name} を Slot${slotIdx + 1} に配置。`);
    return;
  }
  // Find a recessive same-allele slot if any
  const recIdx = sameSlots.find(i => p.slots[i].recessive);
  if (recIdx != null) {
    // 3rd+: discard newly placed, force disease on existing recessive (if not already)
    p.slots[slotIdx] = null;
    G.alleleDiscard.push(alleleId);
    if (!p.slots[recIdx].disease) {
      p.slots[recIdx].disease = true;
      p.diseaseLog.push({ era: G.era, slotIdx: recIdx, name: allele.dis });
      log(`${p.name}: ホモ接合3枚目！ 「${allele.name}」消失、Slot${recIdx + 1}に疾患「${allele.dis}」発症。`, 'loss');
      showCutin({
        kind: 'disease',
        title: '☠ 疾患発症 ☠',
        subtitle: `${p.name} ─ 「${allele.dis}」`,
        image: `assets/disease-token.svg`,
        duration: 1900,
      });
    } else {
      log(`${p.name}: ホモ接合、新規${allele.name} 消失（既に疾患マーカーあり）。`);
    }
  } else {
    // 2nd: discard newly placed, flip existing to recessive
    p.slots[slotIdx] = null;
    G.alleleDiscard.push(alleleId);
    const otherIdx = sameSlots[0];
    p.slots[otherIdx].recessive = true;
    p.slots[otherIdx].disease = false;
    log(`${p.name}: ホモ接合発生！ 「${allele.name}」が裏返り、劣勢発現。`, 'event');
    showCutin({
      kind: 'homozygous',
      title: '⚠ ホモ接合発生 ⚠',
      subtitle: `${p.name} ─ 「${allele.name}」が劣勢発現`,
      image: `assets/allele-${alleleId}.jpg`,
      duration: 1900,
    });
  }
}

// ===== Trait calculation (already in data.js: calcTraits) =====

// ===== Action: Draw memory =====
function actDrawMemory() {
  const p = activePlayer();
  if (G.memoryDeck.length === 0) { log('記憶デッキが尽きた…'); return endTurn(); }

  const isDaughter = p.characterId === 'daughter';
  const drawN = isDaughter ? 2 : 1;
  const drawn = [];
  for (let i = 0; i < drawN && G.memoryDeck.length > 0; i++) drawn.push(G.memoryDeck.pop());

  if (p.isAI) {
    // AI picks the most achievable / valuable memory
    const pick = aiPickMemory(p, drawn);
    p.memories.push(pick);
    drawn.filter(m => m !== pick).forEach(m => G.memoryDeck.unshift(m));  // return to bottom
    log(`${p.name}: 記憶の断片「${MEMORY_BY_ID[pick].name}」を獲得。`);
    endTurn();
  } else if (drawN === 1) {
    p.memories.push(drawn[0]);
    log(`${p.name}: 記憶の断片「${MEMORY_BY_ID[drawn[0]].name}」を獲得。`);
    endTurn();
  } else {
    // Human + daughter: choose one
    showCardPickerModal('記憶の断片を選択', drawn.map(id => MEMORY_BY_ID[id]), card => {
      p.memories.push(card.id);
      drawn.filter(id => id !== card.id).forEach(id => G.memoryDeck.unshift(id));
      log(`${p.name}: 記憶の断片「${card.name}」を獲得（もう1枚は山札底へ）。`);
      endTurn();
    });
  }
}

function aiPickMemory(p, ids) {
  // Prefer easy that p already satisfies, else medium, else easy
  const sorted = ids.map(id => MEMORY_BY_ID[id]).sort((a, b) => {
    const aSat = a.cond(p) ? 1 : 0;
    const bSat = b.cond(p) ? 1 : 0;
    if (aSat !== bSat) return bSat - aSat;
    const tier = { easy: 1, medium: 2, hard: 3 };
    return tier[a.tier] - tier[b.tier];
  });
  return sorted[0].id;
}

// ===== Action: Draw allele =====
function actDrawAllele() {
  const p = activePlayer();
  const empty = p.slots.findIndex(s => s === null);

  const isImouto = p.characterId === 'imouto';
  const drawN = isImouto ? 2 : 1;
  const drawn = [];
  for (let i = 0; i < drawN; i++) {
    const a = drawCard(G.alleleDeck, G.alleleDiscard);
    if (a) drawn.push(a);
  }
  if (drawn.length === 0) { log('アレルデッキが尽きた…'); return endTurn(); }

  // Choose which to keep
  const proceed = (chosenId) => {
    drawn.filter(id => id !== chosenId).forEach(id => G.alleleDiscard.push(id));
    if (empty !== -1) {
      // Place in empty slot — for AI: pick first empty
      if (p.isAI) {
        placeAlleleInSlot(p, chosenId, empty);
        endTurn();
      } else {
        G.pending = { type: 'select_own_slot', message: `「${ALLELE_BY_ID[chosenId].name}」を配置するスロットを選んでください`, filter: i => p.slots[i] === null, cb: idx => {
          G.pending = null;
          placeAlleleInSlot(p, chosenId, idx);
          render();
          endTurn();
        }};
        render();
      }
    } else {
      // Slot full: roll d6 — apply overwrite on cutin dismiss so the player sees the result step-by-step.
      const roll = rollD6(`${p.name}: 上書き先`);
      const slotIdx = roll - 1;
      const old = p.slots[slotIdx];
      log(`${p.name}: 6スロット満杯、1d6=${roll} → Slot${slotIdx + 1}を上書き。`, 'event');
      const newName = ALLELE_BY_ID[chosenId].name;
      const oldName = old ? ALLELE_BY_ID[old.type].name : '空';
      showCutin({
        kind: 'dice-overwrite',
        title: `${p.name}: 上書き判定`,
        subtitle: `6スロット満杯のため上書き先を1d6で決定`,
        diceRolls: [{
          label: `Slot${slotIdx + 1}`,
          value: roll,
          outcome: `「${oldName}」 → 「${newName}」`,
          triggered: true,
        }],
        onDismiss: () => {
          if (old) G.alleleDiscard.push(old.type);
          p.slots[slotIdx] = null;
          placeAlleleInSlot(p, chosenId, slotIdx);
        },
      });
      runAfterCutins(() => endTurn());
    }
  };

  if (drawN === 1) {
    log(`${p.name}: アレル「${ALLELE_BY_ID[drawn[0]].name}」をドロー。`);
    proceed(drawn[0]);
  } else if (p.isAI) {
    // AI: pick the most useful for current goal
    const pick = aiPickAllele(p, drawn);
    log(`${p.name}: アレル2枚から「${ALLELE_BY_ID[pick].name}」を選択。`);
    proceed(pick);
  } else {
    showCardPickerModal('アレルを選択（妹効果）', drawn.map(id => ({
      id, name: ALLELE_BY_ID[id].name,
      desc: `顕性: ${formatEffect(ALLELE_BY_ID[id].dom)} / 劣勢: ${formatEffect(ALLELE_BY_ID[id].rec)} (${ALLELE_BY_ID[id].dis})`
    })), card => proceed(card.id));
  }
}

function aiPickAllele(p, ids) {
  // Prefer alleles that contribute to current goal & memory completions
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  let best = ids[0], bestScore = -Infinity;
  for (const id of ids) {
    const sim = JSON.parse(JSON.stringify(p));
    const empty = sim.slots.findIndex(s => s === null);
    if (empty !== -1) sim.slots[empty] = { type: id, recessive: false, disease: false };
    const score = goal.score(sim) * 2 + countAchievable(sim);
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}
function countAchievable(p) {
  let n = 0;
  for (const id of p.memories) {
    if (p.achievedMemories.includes(id)) continue;
    if (MEMORY_BY_ID[id].cond(p)) n++;
  }
  return n;
}

// ===== Action: Remove allele =====
function actRemoveAllele() {
  const p = activePlayer();
  if (filledCount(p) === 0) { log(`${p.name}: 削除可能なアレルがない。`); return endTurn(); }

  const removeAt = (slotIdx) => {
    const old = p.slots[slotIdx];
    G.alleleDiscard.push(old.type);
    p.slots[slotIdx] = null;
    log(`${p.name}: Slot${slotIdx + 1}「${ALLELE_BY_ID[old.type].name}」を削除${old.disease ? '（疾患マーカーも除去）' : ''}。`);
    if (p.characterId === 'osananaji') {
      p.vp += 1;
      log(`${p.name}: 幼馴染効果で +1VP。`, 'gain');
    }
    endTurn();
  };

  if (p.isAI) {
    // 1. Disease first
    let target = p.slots.findIndex(s => s && s.disease);
    if (target === -1) {
      // 2. Pick the slot whose removal scores best
      let bestIdx = -1, bestScore = -Infinity;
      for (let i = 0; i < p.slots.length; i++) {
        if (!p.slots[i]) continue;
        const sim = clonePlayer(p);
        sim.slots[i] = null;
        const ss = aiScoreState(sim);
        if (ss > bestScore) { bestScore = ss; bestIdx = i; }
      }
      target = bestIdx;
    }
    removeAt(target);
  } else {
    G.pending = { type: 'select_own_slot', message: '削除するアレルのスロットを選んでください',
      filter: i => p.slots[i] !== null, cb: removeAt };
    render();
  }
}

// ===== Action: Draw research =====
function actDrawResearch() {
  const p = activePlayer();
  const isTutor = p.characterId === 'tutor';
  const drawN = isTutor ? 2 : 1;
  const drawn = [];
  for (let i = 0; i < drawN; i++) {
    const r = drawCard(G.researchDeck, G.researchDiscard);
    if (r) drawn.push(r);
  }
  if (drawn.length === 0) { log('研究デッキが尽きた…'); return endTurn(); }

  // メイド: 引いたカードを山札底に戻して引き直せる(ゲーム中2回まで)
  if (drawN === 1 && p.characterId === 'maid' && p.maidUses < 2 && !p.isAI) {
    return showActionListModal('研究ドロー — メイド効果',
      `「${RESEARCH_BY_ID[drawn[0]].name}」: ${RESEARCH_BY_ID[drawn[0]].desc}`,
      [
        { label: `採用 — ${RESEARCH_BY_ID[drawn[0]].name}`, onclick: () => {
          closeModal();
          p.research.push(drawn[0]);
          log(`${p.name}: 研究「${RESEARCH_BY_ID[drawn[0]].name}」を獲得。`);
          endTurn();
        }},
        { label: `メイド効果で底へ戻して引き直す（残り${2 - p.maidUses}回）`, onclick: () => {
          closeModal();
          G.researchDeck.unshift(drawn[0]);
          p.maidUses++;
          const nu = drawCard(G.researchDeck, G.researchDiscard);
          if (nu) {
            p.research.push(nu);
            log(`${p.name}: メイド効果で「${RESEARCH_BY_ID[drawn[0]].name}」を底へ → 「${RESEARCH_BY_ID[nu].name}」獲得。`, 'event');
          } else {
            log(`${p.name}: メイド効果で底へ戻したが再ドロー失敗。`);
          }
          endTurn();
        }},
      ]
    );
  }

  if (drawN === 1) {
    p.research.push(drawn[0]);
    log(`${p.name}: 研究「${RESEARCH_BY_ID[drawn[0]].name}」を獲得。`);
    endTurn();
  } else if (p.isAI) {
    const pick = drawn[0];  // simple
    p.research.push(pick);
    drawn.filter(id => id !== pick).forEach(id => G.researchDiscard.push(id));
    log(`${p.name}: 研究「${RESEARCH_BY_ID[pick].name}」を獲得（家庭教師効果）。`);
    endTurn();
  } else {
    showCardPickerModal('研究を選択（家庭教師効果）',
      drawn.map(id => ({ id, name: RESEARCH_BY_ID[id].name, desc: RESEARCH_BY_ID[id].desc })),
      card => {
        p.research.push(card.id);
        drawn.filter(id => id !== card.id).forEach(id => G.researchDiscard.push(id));
        log(`${p.name}: 研究「${RESEARCH_BY_ID[card.id].name}」を獲得。`);
        endTurn();
      });
  }
}

// ===== Action: Nominate (other player or self) =====
//
// Stud Fee structure (paid by nominator to target on exchange):
//   0VP — both sides 1d6 random
//   1VP — one side designated (own OR target's), the other random
//   2VP — both sides designated
// Designation cannot select diseased slots. Random rolls follow the
// "shift-right past disease" rule from section 7.5a of the rule book.
function actNominate() {
  const p = activePlayer();
  if (filledCount(p) === 0) {
    log(`${p.name}: 自分のアレルがないと指名できない。`); return endTurn();
  }
  if (p.isAI) {
    const others = G.players.filter(o => o.id !== p.id && filledCount(o) > 0);
    if (Math.random() < 0.4 && others.length > 0) {
      const target = others[Math.floor(Math.random() * others.length)];
      aiNominateOther(p, target);
    } else {
      doSelfNominate(p);
    }
  } else {
    // Step 1: pick the target
    const buttons = [
      { label: '自家交配（自分を指名・コスト 0VP）', onclick: () => { closeModal(); doSelfNominate(p); } },
      ...G.players.filter(o => o.id !== p.id && filledCount(o) > 0).map(o => ({
        label: `${o.name} を指名…`,
        onclick: () => { closeModal(); promptNominateOptions(p, o); }
      })),
      { label: 'キャンセル', onclick: () => { closeModal(); render(); } }
    ];
    showActionListModal('指名交換', '指名相手を選んでください', buttons);
  }
}

// Step 2 (human): pick designation option.
function promptNominateOptions(p, target) {
  const ownDesignable = p.slots.some(s => s && !s.disease);
  const tgtDesignable = target.slots.some(s => s && !s.disease);
  const buttons = [
    {
      label: '完全ランダム（0VP）',
      onclick: () => { closeModal(); doNominateOther(p, target, { mine: 'random', theirs: 'random' }); }
    },
    {
      label: '自分のスロット指定（1VP・Stud Fee）',
      disabled: p.vp < 1 || !ownDesignable,
      onclick: () => { closeModal(); promptDesignateOwn(p, target, { theirs: 'random' }); }
    },
    {
      label: `${target.name} のスロット指定（1VP・Stud Fee）`,
      disabled: p.vp < 1 || !tgtDesignable,
      onclick: () => { closeModal(); promptDesignateTheir(p, target, { mine: 'random' }); }
    },
    {
      label: '両方指定（2VP・Stud Fee）',
      disabled: p.vp < 2 || !ownDesignable || !tgtDesignable,
      onclick: () => { closeModal(); promptDesignateOwn(p, target, { theirs: 'designate' }); }
    },
    { label: 'キャンセル', onclick: () => { closeModal(); render(); } }
  ];
  showActionListModal(
    `${target.name} を指名`,
    'Stud Fee を支払うとスロットを任意指定できます。\n疾患持ちスロットは指定不可。指定しない側は1d6でランダム決定します。',
    buttons
  );
}

function promptDesignateOwn(p, target, opts) {
  G.pending = {
    type: 'select_own_slot',
    message: `自分のスロットを選んでください（疾患持ちは選択不可）`,
    filter: i => p.slots[i] && !p.slots[i].disease,
    cb: idx => {
      G.pending = null;
      if (opts.theirs === 'designate') {
        promptDesignateTheir(p, target, { mine: 'designate', myIdx: idx });
      } else {
        doNominateOther(p, target, { mine: 'designate', myIdx: idx, theirs: 'random' });
      }
    },
  };
  render();
}

function promptDesignateTheir(p, target, opts) {
  G.pending = {
    type: 'select_other_slot',
    target: target.id,
    message: `${target.name} のスロットを選んでください（疾患持ちは選択不可）`,
    filter: i => target.slots[i] && !target.slots[i].disease,
    cb: idx => {
      G.pending = null;
      doNominateOther(p, target, { ...opts, theirs: 'designate', theirIdx: idx });
    },
  };
  render();
}

// AI nominator: each personality decides its own Stud Fee / designation policy.
function aiNominateOther(p, target) {
  const persona = PERSONALITIES[p.personality] || PERSONALITIES.exploiter;
  let opts = persona.pickNominateOptions
    ? persona.pickNominateOptions(p, target)
    : { mine: 'random', theirs: 'random' };
  // Safety: if the personality returned a designation but the index is null
  // (e.g., target has only diseased slots), fall back to random for that side.
  if (!opts) opts = { mine: 'random', theirs: 'random' };
  if (opts.mine === 'designate' && (opts.myIdx == null || !p.slots[opts.myIdx] || p.slots[opts.myIdx].disease)) {
    opts.mine = 'random'; delete opts.myIdx;
  }
  if (opts.theirs === 'designate' && (opts.theirIdx == null || !target.slots[opts.theirIdx] || target.slots[opts.theirIdx].disease)) {
    opts.theirs = 'random'; delete opts.theirIdx;
  }
  // Cap fee against current VP — never pay more than I have.
  let fee = (opts.mine === 'designate' ? 1 : 0) + (opts.theirs === 'designate' ? 1 : 0);
  while (fee > p.vp) {
    if (opts.mine === 'designate')      { opts.mine = 'random'; delete opts.myIdx; }
    else if (opts.theirs === 'designate') { opts.theirs = 'random'; delete opts.theirIdx; }
    fee = (opts.mine === 'designate' ? 1 : 0) + (opts.theirs === 'designate' ? 1 : 0);
  }
  doNominateOther(p, target, opts);
}

// Returns the slot index whose contribution to the current goal is
// maximal (worstFirst=false) or minimal (worstFirst=true), among non-disease
// non-empty slots. Returns null if no eligible slot.
function pickBestSlot(player, worstFirst) {
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  let best = null, bestScore = worstFirst ? Infinity : -Infinity;
  for (let i = 0; i < player.slots.length; i++) {
    const s = player.slots[i];
    if (!s || s.disease) continue;
    const sim = clonePlayer(player);
    sim.slots[i] = null;
    const score = goal.score(player) - goal.score(sim);  // marginal contribution
    if (worstFirst ? score < bestScore : score > bestScore) {
      bestScore = score; best = i;
    }
  }
  return best;
}

// Find the next non-empty, non-diseased slot to the right of `from` (mod 6).
// Returns -1 if no such slot exists.
function shiftRightToSwappable(slots, from) {
  for (let step = 1; step <= slots.length; step++) {
    const j = (from + step) % slots.length;
    if (slots[j] && !slots[j].disease) return j;
  }
  return -1;
}

// ----- Rule (self-nominate): roll a slot. Empty → wasted. Dominant → flip recessive
// (= homozygous expression). Already recessive → disease. Already diseased → wasted.
function doSelfNominate(p) {
  const isFiancee = p.characterId === 'fiancee';
  // Roll until we land on a non-empty slot, or give up.
  let attempts = 0, roll, slot;
  while (attempts < 12) {
    roll = rollD6(`${p.name}: 自家交配`);
    slot = p.slots[roll - 1];
    if (slot) break;
    attempts++;
  }
  if (!slot) {
    showCutin({
      kind: 'dice-cross',
      title: `${p.name}: 自家交配`,
      subtitle: '1d6 で対象スロット決定',
      diceRolls: [{ label: `Slot${roll}`, value: roll, outcome: 'スロット空白続き ─ アクション無駄', triggered: false }],
    });
    log(`${p.name}: 自家交配の対象なし、アクション無駄。`, 'loss');
    return endTurn();
  }
  // Fiancée may re-roll once if she dislikes the result (only if non-empty result lands on disease/recessive)
  let rerollVal = null;
  if (isFiancee && (slot.recessive || slot.disease)) {
    rerollVal = rollD6(`${p.name}: 婚約者振り直し`);
    if (p.slots[rerollVal - 1]) { roll = rerollVal; slot = p.slots[rerollVal - 1]; }
  }
  const a = ALLELE_BY_ID[slot.type];
  const idx = roll - 1;
  let outcome, triggered = false, kind = 'dice-cross', mutate = () => {};

  if (slot.disease) {
    outcome = `Slot${roll}「${a.name}」は疾患持ち ─ 操作不可。アクション無駄。`;
    log(`${p.name}: 自家交配 → 既に疾患マーカー、アクション無駄。`, 'loss');
  } else if (slot.recessive) {
    // Already homozygous-expressing → induce disease
    outcome = `Slot${roll}「${a.name}」は既にホモ接合 ─ 疾患「${a.dis}」発症!`;
    triggered = true;
    kind = 'dice-disease';
    mutate = () => {
      slot.disease = true;
      p.diseaseLog.push({ era: G.era, slotIdx: idx, name: a.dis });
      log(`${p.name}: 自家交配 → 既に劣勢発現、疾患「${a.dis}」発症。`, 'loss');
    };
  } else {
    // Dominant → flip to recessive (homozygous expression)
    outcome = `Slot${roll}「${a.name}」を劣勢発現!`;
    triggered = true;
    mutate = () => {
      slot.recessive = true;
      log(`${p.name}: 自家交配 → Slot${roll}「${a.name}」を劣勢発現。`, 'event');
    };
  }
  const rolls = [{ label: `Slot${roll}`, value: roll, outcome, triggered }];
  if (rerollVal !== null) {
    rolls.unshift({ label: '婚約者効果で振り直し', value: rerollVal, outcome: '振り直し成立' });
  }
  showCutin({
    kind,
    title: `${p.name}: 自家交配`,
    subtitle: '1d6 で対象スロット決定',
    diceRolls: rolls,
    onDismiss: mutate,
  });
  runAfterCutins(() => endTurn());
}

// Resolve a random swap slot for `who`: roll d6; if empty re-roll; if the
// rolled slot has a disease token, shift right to the nearest non-disease
// non-empty slot. Returns { ok, roll, idx, shiftedFrom?, reason? }.
function resolveRandomSwapSlot(who, label) {
  let roll, idx, attempts = 0;
  do {
    roll = rollD6(label || '');
    idx = roll - 1;
    attempts++;
  } while (!who.slots[idx] && attempts < 12);
  if (!who.slots[idx]) return { ok: false, roll, idx, reason: 'empty' };
  let shiftedFrom = null;
  if (who.slots[idx].disease) {
    const j = shiftRightToSwappable(who.slots, idx);
    if (j === -1) return { ok: false, roll, idx, reason: 'all-disease' };
    shiftedFrom = idx;
    idx = j;
  }
  return { ok: true, roll, idx, shiftedFrom };
}

// ----- Rule (nominate other): exchange two alleles between players.
// `options` shape:
//   { mine: 'random'|'designate', myIdx?, theirs: 'random'|'designate', theirIdx? }
// Stud Fee = number of designated sides (0–2). Designation cannot pick
// diseased slots; random rolls shift right past disease per the rule book.
function doNominateOther(p, target, options) {
  options = options || { mine: 'random', theirs: 'random' };
  const designatedCount = (options.mine === 'designate' ? 1 : 0)
                       + (options.theirs === 'designate' ? 1 : 0);
  const fee = designatedCount;  // 0 / 1 / 2
  if (fee > 0) {
    p.vp -= fee;
    const received = fee + (target.characterId === 'wife' ? 1 : 0);
    target.vp += received;
    target.studFees += received;
    log(`${p.name}: ${target.name} に Stud Fee ${received}VP 支払い (指定 ${fee}枚)。`, 'event');
  } else {
    log(`${p.name}: ${target.name} を完全ランダム指名 (Stud Fee なし)。`, 'event');
  }

  // Resolve each side: designated → use chosen idx; random → roll d6 with disease shift.
  const me = options.mine === 'designate'
    ? { ok: true, designated: true, idx: options.myIdx }
    : resolveRandomSwapSlot(p, `${p.name}: 自分のスロット`);
  if (!me.ok) {
    log(`${p.name}: 自身のスロット解決失敗 (${me.reason})。`, 'loss');
    return endTurn();
  }
  const tg = options.theirs === 'designate'
    ? { ok: true, designated: true, idx: options.theirIdx }
    : resolveRandomSwapSlot(target, `${target.name}: 相手のスロット`);
  if (!tg.ok) {
    log(`${target.name}: スロット解決失敗 (${tg.reason})。`, 'loss');
    return endTurn();
  }

  const a = p.slots[me.idx], b = target.slots[tg.idx];

  const fmtOutcome = (side, alleleName) => {
    if (side.designated) return `Slot${side.idx + 1}「${alleleName}」 (任意指定)`;
    if (side.shiftedFrom != null) {
      return `Slot${side.shiftedFrom + 1}は疾患 → 右へずれ Slot${side.idx + 1}「${alleleName}」`;
    }
    return `Slot${side.idx + 1}「${alleleName}」`;
  };
  // Cutin: lines for designated sides, dice rolls for random sides.
  const lines = [];
  const diceRolls = [];
  if (me.designated) {
    lines.push(`${p.name}: ${fmtOutcome(me, ALLELE_BY_ID[a.type].name)}`);
  } else {
    diceRolls.push({ label: p.name, value: me.roll, outcome: fmtOutcome(me, ALLELE_BY_ID[a.type].name), triggered: true });
  }
  if (tg.designated) {
    lines.push(`${target.name}: ${fmtOutcome(tg, ALLELE_BY_ID[b.type].name)}`);
  } else {
    diceRolls.push({ label: target.name, value: tg.roll, outcome: fmtOutcome(tg, ALLELE_BY_ID[b.type].name), triggered: true });
  }

  const subtitle = fee === 0
    ? '完全ランダム ─ 双方 1d6 で決定（疾患スロットは右へずれる）'
    : fee === 1
      ? `Stud Fee 1VP ─ 一方を任意指定、他方を 1d6 で決定`
      : `Stud Fee 2VP ─ 双方を任意指定`;

  showCutin({
    kind: 'dice-exchange',
    title: `指名交換: ${p.name} ⇄ ${target.name}`,
    subtitle,
    lines: lines.length > 0 ? lines : undefined,
    diceRolls: diceRolls.length > 0 ? diceRolls : undefined,
    onDismiss: () => {
      p.slots[me.idx] = null;
      target.slots[tg.idx] = null;
      log(`${p.name}↔${target.name}: Slot${me.idx + 1}(${ALLELE_BY_ID[a.type].name}) ↔ Slot${tg.idx + 1}(${ALLELE_BY_ID[b.type].name}) 交換。`);
      placeAlleleInSlot(p, b.type, me.idx, b.recessive);
      placeAlleleInSlot(target, a.type, tg.idx, a.recessive);
    },
  });
  runAfterCutins(() => endTurn());
}

// ===== Action: Claim memory =====
function actClaimMemory() {
  const p = activePlayer();
  const claimable = p.memories.filter(id => !p.achievedMemories.includes(id));
  if (claimable.length === 0) { log(`${p.name}: 宣言できる記憶がない。`); return endTurn(); }

  const tryClaim = (memId) => {
    const m = MEMORY_BY_ID[memId];
    if (m.cond(p)) {
      p.achievedMemories.push(memId);
      const reward = MEMORY_REWARD[m.tier];
      p.vp += reward;
      log(`${p.name}: 記憶「${m.name}」達成宣言成功！ +${reward}VP`, 'gain');
    } else {
      log(`${p.name}: 記憶「${m.name}」達成宣言失敗。アクション消費。`, 'loss');
    }
    endTurn();
  };

  if (p.isAI) {
    // Pick first that satisfies (only call this when we know one is satisfied)
    const target = claimable.find(id => MEMORY_BY_ID[id].cond(p));
    tryClaim(target || claimable[0]);
  } else {
    showCardPickerModal('達成宣言する記憶', claimable.map(id => {
      const m = MEMORY_BY_ID[id];
      return {
        id,
        name: m.name + (m.cond(p) ? ' ✓' : ''),
        desc: `[${m.tier.toUpperCase()}] ${m.desc} (達成 +${MEMORY_REWARD[m.tier]} / 失敗 -アクション)`
      };
    }), card => tryClaim(card.id));
  }
}

// ===== Action: Hold conference =====
function actHoldConference() {
  const p = activePlayer();
  if (p.id !== G.presidentIdx) { log(`${p.name}: 学会理事ではない。`); return; }
  if (G.round < MIN_CONF_ROUND) { log(`${p.name}: ラウンド${MIN_CONF_ROUND}以降にしか開催できない。`); return; }
  log(`★ ${p.name} が第${G.era}学会の開催を宣言。`, 'system');
  yearEnd();
}

function showSeasonStartCutin(era) {
  const goal = GOAL_BY_ID[G.goals[era - 1]];
  if (!goal) return;
  showCutin({
    kind: 'season',
    title: `第${era}学会期 開幕`,
    subtitle: `公開目標「${goal.name}」`,
    image: `assets/goal-${goal.id}.jpg`,
    lines: [
      goal.desc + (goal.desc_low ? '（最小値が勝利）' : ''),
      '1位:+5VP +研究  2位:+3VP  3位:+1VP',
    ],
  });
}

// ===== Action: Pass =====
function actPass() {
  const p = activePlayer();
  log(`${p.name}: パス。`);
  endTurn();
}

// ===== Use research card =====
function useResearch(p, cardId) {
  const card = RESEARCH_BY_ID[cardId];
  // Validate
  if (cardId === 'r_paper' && G.era < 3) {
    log(`${p.name}: 論文発表は学会期3以降のみ。`); return false;
  }
  // Apply
  switch (cardId) {
    case 'r_present': p.vp += 3; log(`${p.name}: 研究発表を発表！ +3VP`, 'gain'); break;
    case 'r_paper':   p.vp += 5; log(`${p.name}: 論文発表！ +5VP`, 'gain'); break;
    case 'r_genome':  p.vp += 2; log(`${p.name}: 遺伝子鑑定 +2VP`, 'gain'); break;
    case 'r_antidote': {
      // 新ルール: 疾患の治療法はカード削除のみ。解毒剤は疾患持ちアレルを疾患ごと完全に除去する。
      const idx = p.slots.findIndex(s => s && s.disease);
      if (idx === -1) { log(`${p.name}: 解毒剤を使用したが疾患なし。`); }
      else {
        const old = p.slots[idx];
        G.alleleDiscard.push(old.type);
        p.slots[idx] = null;
        log(`${p.name}: 解毒剤でSlot${idx + 1}「${ALLELE_BY_ID[old.type].name}」を疾患ごと除去！`, 'gain');
      }
      break;
    }
    case 'r_recess': {
      const target = pickOwnSlotAI(p, s => s && !s.recessive);
      if (target == null) { log(`${p.name}: 強制裏返しの対象なし。`); }
      else { p.slots[target].recessive = true; log(`${p.name}: 強制裏返し → Slot${target + 1}劣勢発現。`); }
      break;
    }
    case 'r_dominant': {
      // 新ルール: 疾患スロットは対象外（疾患は削除でしか治癒不可）
      const target = pickOwnSlotAI(p, s => s && s.recessive && !s.disease);
      if (target == null) { log(`${p.name}: 強制顕性化の対象なし（疾患持ちは対象外）。`); }
      else {
        p.slots[target].recessive = false;
        log(`${p.name}: 強制顕性化 → Slot${target + 1}を表向き化。`, 'gain');
      }
      break;
    }
    case 'r_mutate': {
      const target = pickOwnSlotAI(p, s => s !== null);
      if (target == null) { log(`${p.name}: 変異対象なし。`); }
      else {
        const oldType = p.slots[target].type;
        const newId = drawCard(G.alleleDeck, G.alleleDiscard);
        if (!newId) break;
        G.alleleDiscard.push(oldType);
        p.slots[target] = null;
        log(`${p.name}: 変異誘発 Slot${target + 1} ${ALLELE_BY_ID[oldType].name} → ${ALLELE_BY_ID[newId].name}`);
        placeAlleleInSlot(p, newId, target);
      }
      break;
    }
    case 'r_copy': {
      const src = pickOwnSlotAI(p, s => s !== null);
      const dst = p.slots.findIndex(s => s === null);
      if (src == null || dst === -1) { log(`${p.name}: 複製術の対象/空きなし。`); }
      else {
        const type = p.slots[src].type;
        log(`${p.name}: 複製術 Slot${src + 1}「${ALLELE_BY_ID[type].name}」をSlot${dst + 1}に複製（ホモ接合発生）。`);
        placeAlleleInSlot(p, type, dst);
      }
      break;
    }
    case 'r_oracle': {
      const peek = [];
      for (let i = 0; i < 3 && G.memoryDeck.length > 0; i++) peek.push(G.memoryDeck.pop());
      if (peek.length === 0) { log(`${p.name}: 記憶デッキが尽きていた。`); break; }
      if (p.isAI) {
        const pick = aiPickMemory(p, peek);
        p.memories.push(pick);
        peek.filter(id => id !== pick).forEach(id => G.memoryDeck.unshift(id));
        log(`${p.name}: 古文書解読 → 記憶「${MEMORY_BY_ID[pick].name}」獲得。`);
      } else {
        showCardPickerModal('古文書解読: 1枚をキープ', peek.map(id => MEMORY_BY_ID[id]), card => {
          p.memories.push(card.id);
          peek.filter(id => id !== card.id).forEach(id => G.memoryDeck.unshift(id));
          log(`${p.name}: 古文書解読 → 記憶「${card.name}」獲得。`);
          render();
        });
      }
      break;
    }
    case 'r_catalyst': {
      const peek = [];
      for (let i = 0; i < 3; i++) {
        const c = drawCard(G.researchDeck, G.researchDiscard);
        if (c) peek.push(c);
      }
      if (peek.length === 0) { log(`${p.name}: 研究デッキが尽きていた。`); break; }
      if (p.isAI) {
        const pick = peek[0];
        p.research.push(pick);
        peek.filter(id => id !== pick).forEach(id => G.researchDiscard.push(id));
        log(`${p.name}: 触媒研究 → 「${RESEARCH_BY_ID[pick].name}」獲得。`);
      } else {
        showCardPickerModal('触媒研究: 1枚をキープ',
          peek.map(id => ({ id, name: RESEARCH_BY_ID[id].name, desc: RESEARCH_BY_ID[id].desc })),
          card => {
            p.research.push(card.id);
            peek.filter(id => id !== card.id).forEach(id => G.researchDiscard.push(id));
            log(`${p.name}: 触媒研究 → 「${RESEARCH_BY_ID[card.id].name}」獲得。`);
            render();
          });
      }
      break;
    }
    case 'r_foresight': {
      const next = G.goals[G.era] ? GOAL_BY_ID[G.goals[G.era]] : null;
      const nnext = G.goals[G.era + 1] ? GOAL_BY_ID[G.goals[G.era + 1]] : null;
      const msg = `次学会期: ${next ? next.name + ' (' + next.desc + ')' : 'なし'} / 次々学会期: ${nnext ? nnext.name + ' (' + nnext.desc + ')' : 'なし'}`;
      log(`${p.name}: 学会先見 → ${msg}`);
      if (!p.isAI) showAlertModal('学会先見', msg);
      break;
    }
    case 'r_collab': {
      const others = G.players.filter(o => o.id !== p.id);
      if (p.isAI) {
        const persona = PERSONALITIES[p.personality];
        const ally = (persona && persona.pickCollabTarget && persona.pickCollabTarget(p, others))
          || others[Math.floor(Math.random() * others.length)];
        p.vp += 2; ally.vp += 2;
        log(`${p.name}: 共同研究 with ${ally.name} → 両者+2VP`, 'gain');
      } else {
        const buttons = others.map(o => ({
          label: `${o.name}と共同研究 (両者+2VP)`,
          onclick: () => {
            closeModal();
            p.vp += 2; o.vp += 2;
            log(`${p.name}: 共同研究 with ${o.name} → 両者+2VP`, 'gain');
            render();
          }
        }));
        buttons.push({ label: 'キャンセル', onclick: () => { closeModal(); render(); } });
        showActionListModal('共同研究', '相手を選んでください', buttons);
      }
      break;
    }
    case 'r_interfere': {
      const others = G.players.filter(o => o.id !== p.id && filledCount(o) > 0);
      if (others.length === 0) { log(`${p.name}: 干渉対象なし。`); break; }
      if (p.isAI) {
        const persona = PERSONALITIES[p.personality];
        const target = (persona && persona.pickInterfereTarget && persona.pickInterfereTarget(p, others))
          || others.sort((a, b) => b.vp - a.vp)[0];
        const slot = target.slots.findIndex(s => s && !s.recessive);
        if (slot === -1) { log(`${p.name}: ${target.name}は全て劣勢、干渉できず。`); break; }
        target.slots[slot].recessive = true;
        log(`${p.name}: 干渉術 → ${target.name}のSlot${slot + 1}を劣勢化。`, 'event');
      } else {
        const buttons = others.map(o => ({
          label: `${o.name}に干渉`,
          onclick: () => {
            closeModal();
            G.pending = { type: 'select_other_slot', target: o.id, message: `${o.name}のスロットを選んでください`,
              filter: i => o.slots[i] && !o.slots[i].recessive,
              cb: idx => {
                G.pending = null;
                o.slots[idx].recessive = true;
                log(`${p.name}: 干渉術 → ${o.name}のSlot${idx + 1}を劣勢化。`, 'event');
                render();
              }};
            render();
          }
        }));
        buttons.push({ label: 'キャンセル', onclick: () => { closeModal(); render(); } });
        showActionListModal('干渉術', '対象プレイヤーを選んでください', buttons);
      }
      break;
    }
  }
  // Remove from hand, discard
  const idx = p.research.indexOf(cardId);
  if (idx !== -1) p.research.splice(idx, 1);
  G.researchDiscard.push(cardId);
  return true;
}

function pickOwnSlotAI(p, filter) {
  for (let i = 0; i < p.slots.length; i++) if (filter(p.slots[i])) return i;
  return null;
}

// ===== End turn / next turn =====
function endTurn() {
  G.pending = null;
  closeModal();
  render();

  if (G.ended) return;
  // Advance turn
  G.turnIndex += 1;
  if (G.turnIndex >= NUM_PLAYERS) {
    // End of round
    G.turnIndex = 0;
    G.round += 1;
    if (G.round > MAX_ROUNDS) {
      log(`★ ラウンド${MAX_ROUNDS}終了、強制学会開催。`, 'system');
      return yearEnd();
    } else {
      log(`★ ラウンド${G.round} 開始。`, 'event');
    }
  }
  render();
  scheduleAITurnIfNeeded();
}

function scheduleAITurnIfNeeded() {
  if (G.ended) return;
  // If anything cutin-related is in flight, hold off — the driver will
  // call this back once everything has drained.
  if (G.cutinOnScreen || G.cutinQueue.length > 0 || G.afterCutinHooks.length > 0) return;
  // Idempotency guard: this function gets called both from endTurn() and from
  // the driver loop right after. Without a flag, two setTimeouts fire 700 ms
  // apart and aiTakeTurn runs twice for the same AI player — making the
  // president call yearEnd twice in a row.
  if (G.aiScheduled) return;
  const p = activePlayer();
  if (!p.isAI) return;
  G.aiScheduled = true;
  setTimeout(() => {
    G.aiScheduled = false;
    aiTakeTurn();
  }, 700);
}

// ===== AI logic =====
// Lightweight player snapshot for "what-if" scoring
function clonePlayer(p) {
  return {
    ...p,
    slots: p.slots.map(s => s ? { ...s } : null),
    memories: [...p.memories],
    achievedMemories: [...p.achievedMemories],
    research: [...p.research],
  };
}

// Estimate the value of a board position to the AI.
// Captures: current goal placement, expected memory outcomes, disease drag.
function aiScoreState(p) {
  let s = p.vp;
  const eraLeft = NUM_ERAS - G.era + 1;

  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  const myG = goal.score(p);
  const others = G.players.filter(o => o.id !== p.id);
  const better = others.filter(o => goal.desc_low ? goal.score(o) < myG : goal.score(o) > myG).length;
  s += [5, 3, 1, 0][better];

  // Memory expectation: achieved → reward, unfinished → tier-weighted by remaining uncertainty
  for (const id of p.memories) {
    if (p.achievedMemories.includes(id)) continue;
    const m = MEMORY_BY_ID[id];
    if (m.cond(p)) s += MEMORY_REWARD[m.tier];
    else s -= MEMORY_REWARD[m.tier] * (eraLeft / NUM_ERAS);
  }

  // Disease bleed across remaining eras
  s -= diseaseCount(p) * eraLeft;
  // Recessive surplus is risk
  s -= Math.max(0, recessiveCount(p) - 1) * 0.5;

  return s;
}

function aiBestSelfFlipBenefit(p) {
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  let best = 0;
  for (let i = 0; i < p.slots.length; i++) {
    const s = p.slots[i];
    if (!s || s.recessive) continue;
    const sim = clonePlayer(p);
    sim.slots[i].recessive = true;
    let benefit = 0;
    for (const mid of p.memories) {
      if (p.achievedMemories.includes(mid)) continue;
      const m = MEMORY_BY_ID[mid];
      if (!m.cond(p) && m.cond(sim)) benefit += MEMORY_REWARD[m.tier];
    }
    benefit += (goal.score(sim) - goal.score(p)) * 0.6;
    if (benefit > best) best = benefit;
  }
  return best;
}

function aiTakeTurn() {
  if (G.ended) return;
  const p = activePlayer();
  if (!p.isAI) return;
  const persona = PERSONALITIES[p.personality] || PERSONALITIES.exploiter;

  // ---- Phase 1: free research uses (don't consume action) ----
  // Persona dictates which cards are worth burning right now.
  const FREE_CANDIDATES = ['r_present','r_paper','r_genome','r_antidote','r_dominant','r_collab','r_interfere','r_foresight'];
  for (const cid of FREE_CANDIDATES) {
    if (!p.research.includes(cid)) continue;
    if (persona.freeUse(p, cid)) useResearch(p, cid);
  }
  render();

  // ---- Phase 2: score and pick the action ----
  const eraLeft = NUM_ERAS - G.era + 1;
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  const candidates = [];

  // Claim memory (highest priority when satisfied)
  const claimable = p.memories.filter(id => !p.achievedMemories.includes(id) && MEMORY_BY_ID[id].cond(p));
  if (claimable.length > 0) {
    const tierBest = claimable.map(id => MEMORY_BY_ID[id]).sort((a, b) => MEMORY_REWARD[b.tier] - MEMORY_REWARD[a.tier])[0];
    candidates.push({ kind: 'claim', score: 100 + MEMORY_REWARD[tierBest.tier] });
  }

  // Conference call (president only)
  if (p.id === G.presidentIdx && G.round >= MIN_CONF_ROUND) {
    const myG = goal.score(p);
    const better = G.players.filter(o => o.id !== p.id && (goal.desc_low ? goal.score(o) < myG : goal.score(o) > myG)).length;
    let cs = 0;
    if (better === 0) cs = 55 + G.round * 2;     // 1st place — close it
    else if (better === 1) cs = 22 + G.round;    // 2nd
    else if (better === 2) cs = 4 + G.round;     // 3rd
    else cs = G.round - 8;                        // last
    if (G.round >= MAX_ROUNDS - 1) cs += 28;     // running out anyway
    candidates.push({ kind: 'conference', score: cs });
  }

  // Draw allele
  if (filledCount(p) < 6) {
    let s = 30 - filledCount(p) * 2;
    if (G.era <= 2) s += 5;
    candidates.push({ kind: 'draw_allele', score: s });
  } else {
    candidates.push({ kind: 'draw_allele', score: -4 });  // forces overwrite
  }

  // Remove allele
  if (p.slots.some(s => s && s.disease)) {
    candidates.push({ kind: 'remove_allele', score: 40 + eraLeft * 2 });
  } else if (recessiveCount(p) >= 3 && eraLeft >= 3) {
    candidates.push({ kind: 'remove_allele', score: 18 });
  } else if (filledCount(p) === 6) {
    // Maybe room for a better allele — score what removing each slot would do
    let bestRemove = -Infinity;
    for (let i = 0; i < 6; i++) {
      if (!p.slots[i]) continue;
      const sim = clonePlayer(p);
      sim.slots[i] = null;
      const ds = aiScoreState(sim) - aiScoreState(p);
      if (ds > bestRemove) bestRemove = ds;
    }
    if (bestRemove > 0) candidates.push({ kind: 'remove_allele', score: 8 + bestRemove });
  }

  // Draw memory — risky late, valuable early
  let memScore = -100;
  if (p.memories.length === 0) memScore = 32;
  else if (p.memories.length < 3 && G.era <= 3) memScore = 22 - p.memories.length * 3;
  else if (p.memories.length < 5 && G.era <= 2) memScore = 12;
  else if (G.era <= 2) memScore = 6;
  if (memScore > -100) candidates.push({ kind: 'draw_memory', score: memScore });

  // Draw research
  if (p.research.length === 0) candidates.push({ kind: 'draw_research', score: 22 });
  else if (p.research.length < 2) candidates.push({ kind: 'draw_research', score: 14 });
  else if (p.research.length < 4 && G.era <= 3) candidates.push({ kind: 'draw_research', score: 6 });

  // Self-cross — only if benefit clears the disease-cascade risk and the
  // personality is willing to flip its own cards. With the new rule, a roll
  // landing on an already-recessive slot turns it into 疾患.
  const sb = aiBestSelfFlipBenefit(p);
  const willingToCross = persona.wantsSelfCross ? persona.wantsSelfCross(p) : (recessiveCount(p) <= 1);
  if (willingToCross && sb > 1.5 && filledCount(p) >= 2) {
    // Roll-onto-recessive probability scales with #recessive / #filled
    const rec = recessiveCount(p);
    const filled = filledCount(p);
    const cascadeRisk = (rec / Math.max(1, filled)) * 6;  // each disease costs ~remaining-eras VP
    const expectedRisk = G.era * 0.5 + cascadeRisk;
    candidates.push({ kind: 'self_nominate', score: 18 + sb - expectedRisk });
  }

  // Nominate another — personality picks the target. Free (0VP) random is
  // always available; designation costs are decided in aiNominateOther.
  if (filledCount(p) > 0) {
    const others = G.players.filter(o => o.id !== p.id && filledCount(o) > 0);
    if (others.length > 0 && persona.pickNominateTarget) {
      const target = persona.pickNominateTarget(p, others, goal);
      if (target) {
        const myG = goal.score(p);
        const tG = goal.score(target);
        // Attacker tolerates equal-goal targets; others demand a clear behind state
        const minBehind = (p.personality === 'attacker') ? -2 : 1;
        if (tG > myG + minBehind && G.era >= 2) {
          // Bonus when AI can afford a designation that grabs target's best card.
          const canDesignateTarget = p.vp >= 1 && pickBestSlot(target, false) != null;
          const designBonus = canDesignateTarget ? 3 : 0;
          candidates.push({ kind: 'nominate_other', target, score: 5 + Math.min(tG - myG, 5) + designBonus });
        }
      }
    }
  }

  // Pass — last resort
  candidates.push({ kind: 'pass', score: -15 });

  // Apply personality multipliers before sorting
  for (const c of candidates) {
    const m = persona.scoreMult[c.kind];
    if (m != null) c.score *= m;
  }

  candidates.sort((a, b) => b.score - a.score);
  const choice = candidates[0];

  switch (choice.kind) {
    case 'claim':           return actClaimMemory();
    case 'conference':      return actHoldConference();
    case 'draw_allele':     return actDrawAllele();
    case 'remove_allele':   return actRemoveAllele();
    case 'draw_memory':     return actDrawMemory();
    case 'draw_research':   return actDrawResearch();
    case 'self_nominate':   return doSelfNominate(p);
    case 'nominate_other':  return aiNominateOther(p, choice.target);  // persona picks Stud Fee policy
    case 'pass':            return actPass();
  }
}

// ===== Year-End / Conference =====
// Phases run sequentially through the cutin queue: each cutin must be
// dismissed (▶ 次へ) before the next phase's calculations run.
// Year-End is split into 4 independent phases. Each phase queues at most one
// cutin and waits for the user's ▶ 次へ before the next phase fires its hook.
// State mutations always happen inside that cutin's onDismiss — never together.
function yearEnd() {
  log(`━━━ 第${G.era}学会期 終了処理 ━━━`, 'system');
  evaluateGoal();                                    // phase 1 — ranking + VP award
  runAfterCutins(() => diseaseCheck());              // phase 2 — per-player disease rolls
  runAfterCutins(() => applyDiseasePenaltyPhase()); // phase 3 — disease VP penalty
  runAfterCutins(() => advanceEraPhase());           // phase 4 — era transition / endGame
}

function evaluateGoal() {
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  const ranking = G.players.map(p => ({ p, score: goal.score(p) }));
  ranking.sort((a, b) => goal.desc_low ? a.score - b.score : b.score - a.score);
  log(`公開目標「${goal.name}」評価: ${ranking.map(r => `${r.p.name}=${r.score}`).join(', ')}`);
  const vps = [5, 3, 1, 0];
  const cutinLines = [];
  // Capture per-rank VP awards; apply on cutin dismiss so the player can read the result first.
  const awards = [];
  for (let i = 0; i < ranking.length; i++) {
    let vp = vps[i];
    let suffix = '';
    if (vp > 0) {
      if (ranking[i].p.characterId === 'mistress') vp += 1;
      awards.push({ p: ranking[i].p, rank: i + 1, vp });
      suffix = ` +${vp}VP`;
      if (i === 0) suffix += ' +研究';
    }
    cutinLines.push(`${i + 1}位  ${ranking[i].p.name}  (${ranking[i].score})${suffix}`);
  }
  const winner = ranking[0].p;
  G.conferenceHistory.push({ era: G.era, winnerId: winner.id, goalId: goal.id });

  showCutin({
    kind: 'ranking',
    title: `第${G.era}学会 結果発表`,
    subtitle: `公開目標「${goal.name}」`,
    image: `assets/goal-${goal.id}.jpg`,
    lines: cutinLines,
    duration: 3200,
    onDismiss: () => {
      for (const a of awards) {
        a.p.vp += a.vp;
        log(`${a.p.name}: ${a.rank}位 → +${a.vp}VP`, 'gain');
        G.conferenceVPs.push({ era: G.era, playerId: a.p.id, rank: a.rank, vp: a.vp, goalId: goal.id });
      }
      const r = drawCard(G.researchDeck, G.researchDiscard);
      if (r) {
        winner.research.push(r);
        log(`${winner.name}: 1位賞として研究「${RESEARCH_BY_ID[r].name}」獲得。`, 'gain');
      }
    },
  });
}

function diseaseCheck() {
  // Roll all dice up front so the values are stable, but defer disease application
  // until each player's cutin is dismissed (board changes step-by-step).
  for (const p of G.players) {
    const rolls = [];
    const mutations = [];
    for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i];
      if (!s || !s.recessive || s.disease) continue;
      const roll = rollD6('');
      const allele = ALLELE_BY_ID[s.type];
      const triggered = roll <= G.era;
      let outcome;
      if (triggered) {
        const slotIdx = i, slotRef = s, eraNow = G.era;
        mutations.push(() => {
          slotRef.disease = true;
          p.diseaseLog.push({ era: eraNow, slotIdx, name: allele.dis });
          log(`${p.name}: Slot${slotIdx + 1}「${allele.name}」疾患判定 1d6=${roll}≤${eraNow} → 疾患「${allele.dis}」発症！`, 'loss');
        });
        outcome = `≤${G.era} → 発症「${allele.dis}」`;
      } else {
        outcome = `>${G.era} → 安全`;
      }
      rolls.push({ label: `Slot${i + 1} ${allele.name}(劣勢)`, value: roll, outcome, triggered });
    }
    if (rolls.length > 0) {
      showCutin({
        kind: 'dice-disease',
        title: `${p.name}: 疾患判定`,
        subtitle: `劣勢アレルごとに 1d6 ─ 出目 ≤ ${G.era} で発症`,
        diceRolls: rolls,
        onDismiss: () => { mutations.forEach(m => m()); },
      });
    }
  }
}

// Phase 3: queue a single summary cutin showing each affected player's penalty.
// Mutations apply on dismiss. If no one has disease, this phase is a no-op
// and the next phase's hook fires immediately.
function applyDiseasePenaltyPhase() {
  const affected = G.players.filter(p => diseaseCount(p) > 0);
  if (affected.length === 0) return;
  const lines = affected.map(p => {
    const n = diseaseCount(p);
    return `${p.name}  疾患${n}個  →  -${n}VP`;
  });
  showCutin({
    kind: 'disease',
    title: `第${G.era}学会期  疾患ペナルティ`,
    subtitle: '疾患マーカー累積によるVP減少',
    lines,
    onDismiss: () => {
      for (const p of affected) {
        const n = diseaseCount(p);
        p.vp -= n;
        log(`${p.name}: 疾患マーカー${n}個 → -${n}VP`, 'loss');
      }
    },
  });
}

// Phase 4: queue the next-season opening cutin. State changes (era++, president
// rotation, round reset) happen on dismiss so the player sees the announcement
// while the board still reflects the previous era. On the final era, endGame
// runs immediately (no further cutin needed before the end screen).
function advanceEraPhase() {
  if (G.era === NUM_ERAS) return endGame();
  const newEra = G.era + 1;
  const newPrez = (G.presidentIdx + 1) % NUM_PLAYERS;
  const newGoal = GOAL_BY_ID[G.goals[newEra - 1]];
  showCutin({
    kind: 'season',
    title: `第${newEra}学会期 開幕`,
    subtitle: `公開目標「${newGoal.name}」`,
    image: `assets/goal-${newGoal.id}.jpg`,
    lines: [
      newGoal.desc + (newGoal.desc_low ? '（最小値が勝利）' : ''),
      `次任学会理事: ${G.players[newPrez].name}`,
      '1位:+5VP +研究  2位:+3VP  3位:+1VP',
    ],
    onDismiss: () => {
      G.era = newEra;
      G.presidentIdx = newPrez;
      G.round = 1;
      G.turnIndex = 0;
      log(`★ 第${G.era}学会期 公開目標: ${newGoal.name} — ${newGoal.desc}`, 'system');
      log(`★ 次任学会理事: ${G.players[G.presidentIdx].name}`, 'system');
      render();
    },
  });
}

// ===== End game =====
function endGame() {
  G.ended = true;
  log('━━━ ゲーム終了 ━━━', 'system');
  // Final memory scoring
  for (const p of G.players) {
    for (const id of p.memories) {
      if (p.achievedMemories.includes(id)) continue;  // already claimed
      const m = MEMORY_BY_ID[id];
      const reward = MEMORY_REWARD[m.tier];
      if (m.cond(p)) {
        p.vp += reward;
        p.achievedMemories.push(id);
        log(`${p.name}: 終了時記憶「${m.name}」自動達成 +${reward}VP`, 'gain');
      } else {
        p.vp -= reward;
        log(`${p.name}: 記憶「${m.name}」未達成 -${reward}VP`, 'loss');
      }
    }
  }
  showEndScreen();
}

function composeRecollection(p) {
  const charLabel = CHAR_LOVER_LABEL[p.characterId] || '人';
  const seenAlleles = new Set();
  const allelePhrases = [];
  const diseasePhrases = [];
  for (const s of p.slots) {
    if (!s) continue;
    if (!seenAlleles.has(s.type)) {
      seenAlleles.add(s.type);
      const phr = ALLELE_RECALL[s.type];
      if (phr) allelePhrases.push(phr);
    }
    if (s.disease) {
      const dis = ALLELE_BY_ID[s.type].dis;
      const phr = DISEASE_RECALL[dis];
      if (phr) diseasePhrases.push(phr);
    }
  }
  const memoryPhrases = (p.achievedMemories || [])
    .map(id => MEMORY_RECALL[id])
    .filter(Boolean);

  const lines = [];
  lines.push('───おお、そうだ。');
  lines.push(`私の最愛の${charLabel}は、`);
  lines.push('');

  if (allelePhrases.length > 0) {
    const tail = allelePhrases.length > 4 ? '…' : '。';
    lines.push(allelePhrases.slice(0, 5).join('、') + tail);
  }
  if (memoryPhrases.length > 0) {
    const last = memoryPhrases[memoryPhrases.length - 1];
    const head = memoryPhrases.slice(0, -1);
    if (head.length > 0) {
      lines.push(head.join('、') + '、');
      lines.push(`そして ── ${last}。`);
    } else {
      lines.push(`そして ── ${last}。`);
    }
  }
  if (diseasePhrases.length > 0) {
    lines.push('');
    lines.push(`けれど、${diseasePhrases.join('や')}も、`);
    lines.push('確かに、あの人のものだった。');
  }
  lines.push('');

  // Closing: vary with achievement count
  const totalAch = (p.achievedMemories || []).length;
  if (allelePhrases.length === 0 && memoryPhrases.length === 0) {
    lines.push('───でも、もう、思い出せない…');
    lines.push('');
    lines.push('彼女は、誰だったんだろう。');
  } else if (totalAch >= 6) {
    lines.push('やっと、また会えた───');
  } else if (totalAch >= 3) {
    lines.push('ああ、間違いなく ── あの人だ。');
  } else {
    lines.push('まだ、ほんの少し。');
    lines.push('それでも ── あの人の、欠片だ。');
  }
  return lines;
}

function showEndScreen() {
  $('game-screen').classList.add('hidden');
  $('end-screen').classList.remove('hidden');
  const ranking = [...G.players].sort((a, b) => {
    if (b.vp !== a.vp) return b.vp - a.vp;
    if (b.achievedMemories.length !== a.achievedMemories.length) return b.achievedMemories.length - a.achievedMemories.length;
    return recessiveCount(a) - recessiveCount(b);
  });
  const container = $('final-results');
  container.innerHTML = '';

  // ----- Recollection panel for the human player -----
  const human = G.players.find(p => !p.isAI);
  if (human) {
    const lines = composeRecollection(human);
    const charImg = `assets/char-${human.characterId}.jpg`;
    const recall = el('div', { class: 'recall-panel' });
    recall.appendChild(el('div', { class: 'recall-bg', style: `background-image:url(${charImg})` }));
    const inner = el('div', { class: 'recall-inner' });
    lines.forEach((ln, i) => {
      const lineEl = el('div', { class: 'recall-line' + (ln === '' ? ' blank' : ''), style: `animation-delay: ${0.4 + i * 0.55}s` }, ln || ' ');
      inner.appendChild(lineEl);
    });
    recall.appendChild(inner);
    container.appendChild(recall);
  }

  ranking.forEach((p, i) => {
    const t = calcTraits(p);
    const card = el('div', { class: 'result-row' + (i === 0 ? ' winner' : '') },
      el('div', {},
        el('span', { class: 'rank' }, (i + 1) + '位'),
        el('span', { class: 'player-name' }, p.name),
        el('span', { class: 'player-char' }, ' / ' + CHAR_BY_ID[p.characterId].name),
        el('span', { class: 'player-vp', style: 'float:right' }, '合計 ', el('span', { class: 'num' }, String(p.vp)), ' VP')
      ),
      el('div', { class: 'traits' },
        el('div', { class: 'trait' }, el('span', { class: 'key' }, '健'), el('span', { class: 'val' }, String(t.健))),
        el('div', { class: 'trait' }, el('span', { class: 'key' }, '艶'), el('span', { class: 'val' }, String(t.艶))),
        el('div', { class: 'trait' }, el('span', { class: 'key' }, '心'), el('span', { class: 'val' }, String(t.心))),
        el('div', { class: 'trait' }, el('span', { class: 'key' }, '智'), el('span', { class: 'val' }, String(t.智)))
      ),
      el('div', { class: 'score-breakdown' },
        el('div', { class: 'item' }, '記憶達成', el('span', { class: 'pos' }, p.achievedMemories.length + '枚')),
        el('div', { class: 'item' }, 'Stud Fee', el('span', { class: 'pos' }, '+' + p.studFees)),
        el('div', { class: 'item' }, '疾患マーカー', el('span', { class: 'neg' }, diseaseCount(p) + '個')),
        el('div', { class: 'item' }, 'スロット', String(filledCount(p)) + '/6')
      )
    );
    container.appendChild(card);
  });
  $('restart-btn').onclick = () => location.reload();
}

// ===== Render =====
function render() {
  if (G.ended) return;
  renderInfoBar();
  renderGoalDisplay();
  renderTraitTracks();
  renderPlayers();
  renderActionPanel();
}

function renderInfoBar() {
  const bar = $('info-bar');
  bar.innerHTML = '';

  // Era track (5 slots)
  const track = el('div', { class: 'era-track' });
  for (let i = 0; i < NUM_ERAS; i++) {
    const era = i + 1;
    const cls = ['era-slot'];
    if (era === G.era) cls.push('active');
    else if (era < G.era) cls.push('past');
    const slot = el('div', { class: cls.join(' ') });
    slot.appendChild(el('div', { class: 'era-num' }, '第' + era + '期'));
    if (era < G.era) {
      const conf = G.conferenceHistory.find(c => c.era === era);
      if (conf) slot.appendChild(el('div', { class: 'era-winner' }, '🏆 ' + G.players[conf.winnerId].name));
    } else if (era === G.era) {
      const goal = GOAL_BY_ID[G.goals[era - 1]];
      slot.appendChild(el('div', { class: 'era-mini-goal' }, goal.name));
    }
    track.appendChild(slot);
  }
  bar.appendChild(track);

  // Row 2: round dots (left, fills available width) + president (right).
  // Wrapping to a second row lets the era track on row 1 use the full width
  // so the era boxes are big and readable.
  const row2 = el('div', { class: 'info-bar-row2' });

  const roundEl = el('div', { class: 'round-track' });
  roundEl.appendChild(el('span', { class: 'label' }, 'ラウンド'));
  const dots = el('div', { class: 'round-dots' });
  for (let r = 1; r <= MAX_ROUNDS; r++) {
    const cls = ['round-dot'];
    if (r === G.round) cls.push('active');
    else if (r < G.round) cls.push('past');
    if (r >= MIN_CONF_ROUND) cls.push('conf-allowed');
    dots.appendChild(el('div', { class: cls.join(' '), title: r >= MIN_CONF_ROUND ? '学会開催可' : '' }));
  }
  roundEl.appendChild(dots);
  roundEl.appendChild(el('span', { class: 'label' }, `${G.round}/${MAX_ROUNDS}`));
  row2.appendChild(roundEl);

  const prez = el('div', { class: 'president-display' },
    el('span', { class: 'crown' }, '♛'),
    el('span', { class: 'label' }, '学会理事:'),
    el('span', { class: 'prez-name' }, G.players[G.presidentIdx].name)
  );
  row2.appendChild(prez);

  bar.appendChild(row2);
}

// The prominent vertical goal card on the right side of the public area —
// it's the most important card on the board. Deck stacks sit at the bottom
// of the same column so the main (left) column stays compact.
function renderGoalDisplay() {
  const host = $('goal-display');
  if (!host) return;
  host.innerHTML = '';
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  if (!goal) return;
  host.appendChild(el('div', { class: 'goal-prominent' },
    el('div', { class: 'gp-label' }, `第${G.era}学会期  公開目標`),
    el('div', { class: 'gp-img', style: `background-image:url(assets/goal-${goal.id}.jpg)` }),
    el('div', { class: 'gp-name' }, goal.name),
    el('div', { class: 'gp-desc' }, goal.desc + (goal.desc_low ? '（最小値が勝利）' : '')),
    el('div', { class: 'gp-divider' }),
    el('div', { class: 'gp-rewards' },
      el('div', { class: 'gp-reward-label' }, '報酬'),
      el('div', { class: 'gp-reward rank-1' }, '1位  +5VP  +研究'),
      el('div', { class: 'gp-reward rank-2' }, '2位  +3VP'),
      el('div', { class: 'gp-reward rank-3' }, '3位  +1VP')
    ),
    el('div', { class: 'gp-divider' }),
    el('div', { class: 'gp-decks' },
      makeDeckStack('allele', 'アレル', G.alleleDeck.length, G.alleleDiscard.length),
      makeDeckStack('research', '研究', G.researchDeck.length, G.researchDiscard.length),
      makeDeckStack('memory', '記憶', G.memoryDeck.length, 0)
    )
  ));
}

// ===== Player piece (board-game-style meeple) =====
const PLAYER_PIECE_SVG = `
<svg viewBox="0 0 30 36" preserveAspectRatio="xMidYMid meet">
  <ellipse cx="15" cy="34.5" rx="10" ry="1.4" fill="rgba(0,0,0,0.55)"/>
  <path d="M9 12 Q8 13 8 14 L3 19 Q2 20.2 3.2 21.2 L10 20 Q10 22.5 9 26 L7 33.5 L13 33.5 L15 27 L17 33.5 L23 33.5 L21 26 Q20 22.5 20 20 L26.8 21.2 Q28 20.2 27 19 L22 14 Q22 13 21 12 Z"
    fill="currentColor" stroke="rgba(0,0,0,0.7)" stroke-width="0.7" stroke-linejoin="round"/>
  <circle cx="15" cy="7" r="5.2" fill="currentColor" stroke="rgba(0,0,0,0.7)" stroke-width="0.7"/>
  <ellipse cx="13.2" cy="5.4" rx="1.6" ry="1.1" fill="rgba(255,255,255,0.55)"/>
  <ellipse cx="11.5" cy="22" rx="1.4" ry="2.2" fill="rgba(255,255,255,0.18)"/>
</svg>`;

function buildPlayerPiece(idx, sizeClass = '') {
  return el('span', {
    class: 'player-piece p' + idx + (sizeClass ? ' ' + sizeClass : ''),
    innerHTML: PLAYER_PIECE_SVG,
  });
}

// ===== Public trait track (shared score board) =====
function renderTraitTracks() {
  const host = $('trait-tracks');
  if (!host) return;
  host.innerHTML = '';
  const TRACK_MAX = 10;  // shows 0..10 cells

  const scores = G.players.map(p => calcTraits(p));

  for (const k of ['健', '艶', '心', '智']) {
    const row = el('div', { class: 'trait-track', 'data-sys': k });
    row.appendChild(el('div', { class: 'tt-key' }, k));

    const cells = el('div', { class: 'tt-cells' });
    for (let i = 0; i <= TRACK_MAX; i++) {
      const cellCls = ['tt-cell'];
      if (i % 5 === 0) cellCls.push('milestone');
      cells.appendChild(el('div', { class: cellCls.join(' ') }, String(i)));
    }
    // Group players by score so multiple pieces on the same cell stack with offset.
    const tokens = el('div', { class: 'tt-tokens' });
    const byScore = {};
    G.players.forEach((_p, i) => {
      const v = Math.min(TRACK_MAX, scores[i][k]);
      (byScore[v] = byScore[v] || []).push(i);
    });
    for (const v of Object.keys(byScore)) {
      const ids = byScore[v];
      const baseLeft = (Number(v) / TRACK_MAX) * 100;
      ids.forEach((idx, j) => {
        const p = G.players[idx];
        const tok = el('div', {
          class: 'tt-token',
          style: `left: calc(${baseLeft}% - 12px + ${j * 7}px); bottom: ${j * 2}px`,
          title: `${p.name}: ${k}=${scores[idx][k]}`,
        });
        tok.appendChild(buildPlayerPiece(idx));
        tokens.appendChild(tok);
      });
    }
    cells.appendChild(tokens);
    row.appendChild(cells);
    host.appendChild(row);
  }
}

function makeDeckStack(kind, label, count, discard) {
  const stack = el('div', { class: 'deck-stack ' + kind });
  stack.appendChild(el('div', { class: 'deck-back' }));
  stack.appendChild(el('div', { class: 'deck-label' }, label));
  stack.appendChild(el('div', { class: 'deck-count' }, String(count)));
  if (discard > 0 || kind !== 'memory') {
    stack.appendChild(el('div', { class: 'deck-discard' }, '捨' + discard));
  }
  return stack;
}

function renderPlayers() {
  const grid = $('players-grid');
  grid.innerHTML = '';
  for (const p of G.players) grid.appendChild(renderPlayerBoard(p));
}

function renderPlayerBoard(p) {
  const isActive = p.id === activePlayer().id;
  const isPresident = p.id === G.presidentIdx;
  const board = el('div', {
    class: 'player-board' + (isActive ? ' active' : '') + (isPresident ? ' president' : ''),
    'data-pid': String(p.id),
    style: `--char-bg:url(assets/char-${p.characterId}.jpg)`,
  });
  board.appendChild(el('div', { class: 'player-stripe' }));

  const persona = p.isAI && p.personality ? PERSONALITIES[p.personality] : null;
  const headerLeft = el('span', { class: 'player-header-left' },
    buildPlayerPiece(p.id, 'header-piece'),
    el('span', { class: 'player-name' }, p.name + (p.isAI ? '' : ' [あなた]')),
    el('span', { class: 'player-char' }, ' — ' + CHAR_BY_ID[p.characterId].name),
    persona ? el('span', {
      class: 'persona-badge',
      style: `color:${persona.color};border-color:${persona.color}`,
      title: persona.flavor
    }, persona.icon + ' ' + persona.label) : null
  );
  board.appendChild(el('div', { class: 'player-header' },
    headerLeft,
    el('span', { class: 'player-vp' }, el('span', { class: 'num' }, String(p.vp)), ' VP')
  ));

  // Achieved memory fragments — publicly visible cards (not just chips).
  // These are the player's "trophies" so they get a proper card display.
  if (p.achievedMemories.length > 0) {
    const section = el('div', { class: 'achieved-section' });
    section.appendChild(el('div', { class: 'achieved-section-label' },
      `✓ 達成済み記憶の断片 (${p.achievedMemories.length})`));
    const row = el('div', { class: 'achieved-cards' });
    for (const id of p.achievedMemories) {
      row.appendChild(buildMemoryCard(id, p));
    }
    section.appendChild(row);
    board.appendChild(section);
  }

  // Slot row label
  board.appendChild(el('div', { class: 'slot-row-label' }, '遺伝子スロット'));

  // Slots — built as cards
  const slotsDiv = el('div', { class: 'slots' });
  for (let i = 0; i < 6; i++) {
    const s = p.slots[i];
    let opts = {};
    // G.pending is only set during human turns. Make slots clickable on the
    // appropriate board — own slots on the human's own board, target slots on
    // the AI's board for "select_other_slot" (干渉術 etc).
    if (G.pending && !activePlayer().isAI) {
      if (G.pending.type === 'select_own_slot' && p.id === activePlayer().id && G.pending.filter(i)) {
        opts = { clickable: true, onclick: () => G.pending.cb(i) };
      } else if (G.pending.type === 'select_other_slot' && p.id === G.pending.target && G.pending.filter(i)) {
        opts = { clickable: true, onclick: () => G.pending.cb(i) };
      }
    }
    slotsDiv.appendChild(buildAlleleCard(s, i, opts));
  }
  board.appendChild(slotsDiv);

  // Memories — private to each player (only the human sees their unachieved ones).
  // Achieved memories are already shown publicly as chips above.
  const isHuman = !p.isAI;
  const unachieved = p.memories.filter(id => !p.achievedMemories.includes(id));
  const memSection = el('div', { class: 'cards-section' });
  memSection.appendChild(el('div', { class: 'label' }, '記憶の断片',
    el('span', { class: 'count' }, '手札' + unachieved.length + ' / 達成' + p.achievedMemories.length)));
  if (isHuman) {
    if (unachieved.length === 0) {
      memSection.appendChild(el('div', { class: 'hint' }, '（手札なし）'));
    } else {
      const row = el('div', { class: 'card-row' });
      for (const id of unachieved) {
        row.appendChild(buildMemoryCard(id, p));
      }
      memSection.appendChild(row);
    }
  } else {
    if (unachieved.length === 0) {
      memSection.appendChild(el('div', { class: 'hint' }, '（手札なし）'));
    } else {
      const row = el('div', { class: 'card-row' });
      for (let i = 0; i < unachieved.length; i++) row.appendChild(buildCardBack('memory'));
      memSection.appendChild(row);
    }
  }
  board.appendChild(memSection);

  // Research
  const resSection = el('div', { class: 'cards-section' });
  resSection.appendChild(el('div', { class: 'label' }, '研究', el('span', { class: 'count' }, p.research.length + '枚')));
  if (isHuman) {
    if (p.research.length === 0) {
      resSection.appendChild(el('div', { class: 'hint' }, '（まだ無し）'));
    } else {
      const row = el('div', { class: 'card-row' });
      for (const id of p.research) {
        const r = RESEARCH_BY_ID[id];
        const usable = isActive && !p.isAI && !G.pending;
        row.appendChild(buildResearchCard(id, {
          clickable: usable,
          onclick: usable ? (() => {
            if (id === 'r_paper' && G.era < 3) { alert('論文発表は学会期3以降のみ。'); return; }
            if (confirm(`研究「${r.name}」を使用？\n${r.desc}`)) {
              useResearch(p, id);
              render();
            }
          }) : undefined
        }));
      }
      resSection.appendChild(row);
    }
  } else {
    if (p.research.length === 0) {
      resSection.appendChild(el('div', { class: 'hint' }, '（まだ無し）'));
    } else {
      const row = el('div', { class: 'card-row' });
      for (let i = 0; i < p.research.length; i++) row.appendChild(buildCardBack('research'));
      resSection.appendChild(row);
    }
  }
  board.appendChild(resSection);

  return board;
}

function renderActionPanel() {
  const panel = $('action-panel');
  panel.innerHTML = '';
  const p = activePlayer();
  const isHuman = !p.isAI;
  const isPresident = p.id === G.presidentIdx;

  const top = el('div', { class: 'row' });
  top.appendChild(el('span', { class: 'turn-label' },
    `第${G.era}期 R${G.round}: ${p.name} の手番` + (isHuman ? '' : ' (AI 思考中…)')
  ));
  panel.appendChild(top);

  if (G.pending) {
    panel.appendChild(el('div', { class: 'pending' }, '→ ' + G.pending.message + '（クリックで選択）'));
    return;
  }

  if (!isHuman) {
    panel.appendChild(el('div', { class: 'pending' }, '→ AIが思考中…'));
    return;
  }

  const row = el('div', { class: 'row' });
  const btn = (label, fn, disabled = false, title = '') => el('button', {
    class: 'btn',
    onclick: fn,
    title,
    ...(disabled ? { disabled: 'disabled' } : {})
  }, label);

  row.appendChild(btn('① 記憶ドロー', actDrawMemory, G.memoryDeck.length === 0, '記憶の断片山札から1枚引く'));
  row.appendChild(btn('② アレルドロー', actDrawAllele, G.alleleDeck.length === 0 && G.alleleDiscard.length === 0, '新しいアレルを獲得'));
  row.appendChild(btn('③ アレル削除', actRemoveAllele, filledCount(p) === 0, '自分のアレル1枚を削除'));
  row.appendChild(btn('④ 研究ドロー', actDrawResearch, G.researchDeck.length === 0 && G.researchDiscard.length === 0, '研究カードを1枚獲得'));
  row.appendChild(btn('⑤ 指名交換', actNominate, false, '他プレイヤー指名 or 自家交配'));
  row.appendChild(btn('⑥ 達成宣言', actClaimMemory, p.memories.filter(id => !p.achievedMemories.includes(id)).length === 0, '記憶の達成を宣言'));
  if (isPresident && G.round >= MIN_CONF_ROUND) {
    row.appendChild(btn('⑦ 学会開催', actHoldConference, false, 'この学会期を即終了'));
  }
  row.appendChild(btn('パス', actPass, false, '何もしない'));

  panel.appendChild(row);
}

function renderLog() {
  const panel = $('log-panel');
  if (!panel) return;
  panel.innerHTML = '';
  for (const e of G.log) {
    panel.appendChild(el('div', { class: 'entry ' + e.cls }, e.msg));
  }
  panel.scrollTop = panel.scrollHeight;
}

// ===== Modals =====
function showModal(content) {
  $('modal-content').innerHTML = '';
  $('modal-content').appendChild(content);
  $('modal-overlay').classList.remove('hidden');
}
function closeModal() {
  $('modal-overlay').classList.add('hidden');
  $('modal-content').innerHTML = '';
}
function showCardPickerModal(title, cards, cb) {
  const list = el('div', { class: 'modal-card-list' });
  for (const c of cards) {
    let cardEl;
    const onclick = () => { closeModal(); cb(c); };
    // Try to detect type by id prefix
    if (c.id && c.id.startsWith('m_')) {
      // Memory card — synthesize a fake "player" with this memory so condition check works against current viewer
      const fakeP = { memories: [c.id], achievedMemories: [], slots: [] };
      cardEl = buildMemoryCard(c.id, fakeP, { clickable: true, onclick });
    } else if (c.id && c.id.startsWith('r_')) {
      cardEl = buildResearchCard(c.id, { clickable: true, onclick });
    } else if (ALLELE_BY_ID[c.id]) {
      const slot = { type: c.id, recessive: false, disease: false };
      cardEl = buildAlleleCard(slot, 0, { clickable: true, onclick });
    } else {
      cardEl = el('div', { class: 'card', onclick },
        el('div', { class: 'card-text' }, el('div', { class: 'card-name' }, c.name), el('div', { class: 'card-effect' }, c.desc || ''))
      );
    }
    list.appendChild(cardEl);
  }
  const content = el('div', {},
    el('h3', {}, title),
    el('div', { class: 'modal-body' }, list)
  );
  showModal(content);
}
function showActionListModal(title, message, buttons) {
  const list = el('div', { class: 'modal-actions', style: 'flex-direction:column;align-items:stretch' });
  for (const b of buttons) {
    list.appendChild(el('button', {
      class: 'btn' + (b.disabled ? ' disabled' : ''),
      ...(b.disabled ? { disabled: 'disabled' } : {}),
      onclick: b.onclick
    }, b.label));
  }
  const content = el('div', {},
    el('h3', {}, title),
    el('div', { class: 'modal-body' }, message),
    list
  );
  showModal(content);
}
function showAlertModal(title, message) {
  const content = el('div', {},
    el('h3', {}, title),
    el('div', { class: 'modal-body' }, message),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn primary', onclick: () => { closeModal(); render(); } }, 'OK')
    )
  );
  showModal(content);
}

function formatEffect(eff) {
  return Object.entries(eff).map(([k, v]) => `${k}+${v}`).join(' ');
}

// ===== Rules viewer =====
// Tiny markdown renderer (headers, lists, tables, hr, blockquote, code, paragraphs).
function renderMarkdown(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inUl = false, inOl = false, inTable = false, inCode = false;
  let para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; }
  };
  const closeLists = () => {
    if (inUl) { out.push('</ul>'); inUl = false; }
    if (inOl) { out.push('</ol>'); inOl = false; }
  };
  const closeTable = () => {
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  };
  const inline = s => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];

    if (ln.match(/^```/)) { flushPara(); closeLists(); closeTable(); inCode = !inCode; out.push(inCode ? '<pre><code>' : '</code></pre>'); continue; }
    if (inCode) { out.push(ln.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')); continue; }

    // Table: a row starts with | and the next line has --- separators
    if (ln.match(/^\|.*\|$/) && lines[i+1] && lines[i+1].match(/^\|[\s\-:|]+\|$/)) {
      flushPara(); closeLists();
      const headers = ln.split('|').slice(1, -1).map(s => s.trim());
      out.push('<table><thead><tr>' + headers.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr></thead><tbody>');
      i++;  // skip separator
      inTable = true;
      continue;
    }
    if (inTable) {
      if (ln.match(/^\|.*\|$/)) {
        const cells = ln.split('|').slice(1, -1).map(s => s.trim());
        out.push('<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
        continue;
      } else {
        closeTable();
      }
    }

    let m;
    if (ln.match(/^\s*$/)) { flushPara(); closeLists(); continue; }
    if (ln.match(/^---+$/) || ln.match(/^===+$/)) { flushPara(); closeLists(); out.push('<hr>'); continue; }
    if ((m = ln.match(/^(#{1,6})\s+(.*)$/))) { flushPara(); closeLists(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); continue; }
    if ((m = ln.match(/^>\s?(.*)$/))) { flushPara(); closeLists(); out.push('<blockquote>' + inline(m[1]) + '</blockquote>'); continue; }
    if ((m = ln.match(/^[-*]\s+(.*)$/))) {
      flushPara();
      if (inOl) { out.push('</ol>'); inOl = false; }
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    if ((m = ln.match(/^\d+\.\s+(.*)$/))) {
      flushPara();
      if (inUl) { out.push('</ul>'); inUl = false; }
      if (!inOl) { out.push('<ol>'); inOl = true; }
      out.push('<li>' + inline(m[1]) + '</li>');
      continue;
    }
    para.push(ln);
  }
  flushPara(); closeLists(); closeTable();
  if (inCode) out.push('</code></pre>');
  return out.join('\n');
}

let _rulesCache = null;
async function showRulesModal() {
  if (_rulesCache == null) {
    try {
      const res = await fetch('最愛のガラテア_ルールブック.md');
      _rulesCache = await res.text();
    } catch (e) {
      _rulesCache = '# ルールブックを読み込めませんでした\n\nlocalhost 等で起動してください。';
    }
  }
  const overlay = $('modal-overlay');
  const content = $('modal-content');
  content.innerHTML = '';
  const wrap = el('div', { id: 'rules-modal-content' });
  wrap.innerHTML = renderMarkdown(_rulesCache);
  const closeBtn = el('button', { id: 'rules-modal-close', onclick: () => closeModal() }, '×');
  wrap.insertBefore(closeBtn, wrap.firstChild);
  content.appendChild(wrap);
  overlay.classList.remove('hidden');
}

// ===== Card hover preview =====
let _previewEl = null;
function getPreviewEl() {
  if (!_previewEl) {
    _previewEl = el('div', { class: 'card-preview' });
    document.body.appendChild(_previewEl);
  }
  return _previewEl;
}
function hidePreview() {
  const p = getPreviewEl();
  p.classList.remove('visible');
}
function showPreview(kind, data, mouseEvt) {
  const p = getPreviewEl();
  p.className = 'card-preview ' + kind;
  let html = '';
  if (kind.startsWith('allele')) {
    const a = data.allele;
    const slot = data.slot;  // may be null
    const eff = (slot && slot.recessive) ? a.rec : a.dom;
    const stateText = slot ? (slot.recessive ? '裏向き(劣勢発現)' : '表向き(顕性)') : '表向き';
    html = `
      <div class="pv-img" style="background-image:url(assets/allele-${a.id}.jpg)"></div>
      <div class="pv-body">
        <div class="pv-type">アレル / ${a.sys}系統 — ${stateText}</div>
        <div class="pv-name">${a.name}</div>
        <div class="pv-effect">効果: ${formatEffect(eff)}</div>
        <div class="pv-desc">顕性: ${formatEffect(a.dom)} ／ 劣勢: ${formatEffect(a.rec)}</div>
        ${(slot && slot.recessive) ? `<div class="pv-tag">⚠ 劣勢時の疾患: 「${a.dis}」 (年末に1d6 ≤ 学会期 で発症)</div>` : `<div class="pv-desc">劣勢時の疾患: 「${a.dis}」</div>`}
        ${(slot && slot.disease) ? `<div class="pv-tag">☠ 疾患マーカー所持中: 年末ごとに -1VP / 指名交換の対象外</div>` : ''}
      </div>`;
  } else if (kind.startsWith('memory')) {
    const m = data;
    const reward = MEMORY_REWARD[m.tier];
    html = `
      <div class="pv-img" style="background-image:url(assets/memory-${m.id}.jpg)"></div>
      <div class="pv-body">
        <div class="pv-type">記憶の断片 / ${m.tier.toUpperCase()}</div>
        <div class="pv-name">${m.name}</div>
        <div class="pv-effect">条件: ${m.desc}</div>
        <div class="pv-desc">達成宣言成功で +${reward}VP / 終了時未達成は -${reward}VP</div>
      </div>`;
  } else if (kind === 'research') {
    const r = data;
    html = `
      <div class="pv-img" style="background-image:url(assets/research-${r.id}.jpg)"></div>
      <div class="pv-body">
        <div class="pv-type">研究カード</div>
        <div class="pv-name">${r.name}</div>
        <div class="pv-effect">${r.desc}</div>
      </div>`;
  } else if (kind === 'character') {
    const c = data;
    html = `
      <div class="pv-img" style="background-image:url(assets/char-${c.id}.jpg)"></div>
      <div class="pv-body">
        <div class="pv-type">研究者 / ${c.title}</div>
        <div class="pv-name">${c.name}</div>
        <div class="pv-effect">${c.effect}</div>
      </div>`;
  }
  p.innerHTML = html;
  p.classList.add('visible');
  // Position near cursor but inside viewport
  const W = 280, H = p.offsetHeight || 380;
  const margin = 12;
  let x = mouseEvt.clientX + margin;
  let y = mouseEvt.clientY + margin;
  if (x + W > window.innerWidth - 6) x = mouseEvt.clientX - W - margin;
  if (y + H > window.innerHeight - 6) y = window.innerHeight - H - 6;
  if (y < 6) y = 6;
  p.style.left = x + 'px';
  p.style.top = y + 'px';
}
function bindPreview(elNode, kind, data) {
  elNode.addEventListener('mouseenter', e => showPreview(kind, data, e));
  elNode.addEventListener('mousemove',  e => showPreview(kind, data, e));
  elNode.addEventListener('mouseleave', hidePreview);
}

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  renderSetup();
  $('rules-btn').onclick = showRulesModal;
});
