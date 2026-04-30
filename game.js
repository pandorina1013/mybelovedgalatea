/* ===========================
   最愛のガラテア — Game Logic + UI
   =========================== */

const NUM_ERAS = 5;
const NUM_PLAYERS = 4;
const MAX_ROUNDS = 8;
const MIN_CONF_ROUND = 4;

// ===== AI personalities =====
// Each AI opponent is assigned one of these. They differ in:
//   - which research cards they free-use opportunistically
//   - per-action score multipliers (priority bias)
//   - targeting logic for nominate_other / interfere
const PERSONALITIES = {
  attacker: {
    label: '攻撃型',
    icon: '⚔',
    color: '#d46b6b',
    flavor: '妨害と速攻。盤面をかき回し、自分が一歩リードしたら即閉幕を狙う。',
    scoreMult: {
      conference:     1.30,  // close it the moment I'm ahead
      draw_memory:    1.35,  // bolder, lives by the sword
      remove_allele:  0.70,  // less cleanup
      self_nominate:  1.25,
      nominate_other: 2.40,  // attack the leader
      pass:           0.30,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (has('r_present')) return cardId === 'r_present';
      if (has('r_paper') && G.era >= 3) return cardId === 'r_paper';
      if (has('r_genome')) return cardId === 'r_genome';
      // Tolerate disease longer
      if (cardId === 'r_antidote') return has('r_antidote') && diseaseCount(p) >= 2;
      if (cardId === 'r_dominant') return has('r_dominant') && diseaseCount(p) >= 2;
      if (cardId === 'r_collab')   return false;          // refuse mutual benefit
      if (cardId === 'r_interfere') return has('r_interfere');  // always swing
      if (cardId === 'r_foresight') return has('r_foresight') && G.era <= 3;
      return false;
    },
    pickInterfereTarget(p, others) {
      const goal = GOAL_BY_ID[G.goals[G.era - 1]];
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];
    },
    pickCollabTarget(p, others) { return null; },
    pickNominateTarget(p, others, goal) {
      // Steal from current goal leader regardless of VP
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];
    },
  },

  defender: {
    label: '守備型',
    icon: '🛡',
    color: '#7aa8e9',
    flavor: '疾患除去と安定構築。波風を避け、最後まで盤面を綺麗に保つ。',
    scoreMult: {
      claim:          1.10,
      remove_allele:  1.55,  // clean obsessively
      draw_memory:    0.50,  // avoid -VP risk
      self_nominate:  0.35,  // recessive risk
      nominate_other: 0.30,  // peace-loving
      conference:     0.85,
      draw_allele:    1.10,
      pass:           1.40,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (cardId === 'r_present')   return has('r_present');
      if (cardId === 'r_paper')     return has('r_paper') && G.era >= 3;
      if (cardId === 'r_genome')    return has('r_genome');
      if (cardId === 'r_antidote')  return has('r_antidote') && diseaseCount(p) > 0;   // ASAP
      if (cardId === 'r_dominant')  return has('r_dominant') && p.slots.some(s => s && s.disease);
      if (cardId === 'r_collab')    return has('r_collab');     // safe mutual gain
      if (cardId === 'r_interfere') return false;               // pacifist
      if (cardId === 'r_foresight') return has('r_foresight') && G.era <= 3;
      return false;
    },
    pickCollabTarget(p, others) {
      // Help anyone equally — pick lowest-VP for fairness
      return [...others].sort((a, b) => a.vp - b.vp)[0];
    },
    pickInterfereTarget() { return null; },
    pickNominateTarget() { return null; },
  },

  exploiter: {
    label: '搾取型',
    icon: '⚖',
    color: '#d4a851',
    flavor: '交易と公開目標で稼ぐ。共同研究や指名交換を多用、損な戦闘は避ける。',
    scoreMult: {
      claim:          1.05,
      conference:     1.05,
      draw_research:  1.30,  // hoard tools to trade
      nominate_other: 1.80,  // exchange-heavy
      remove_allele:  0.95,
      self_nominate:  0.75,
      pass:           0.85,
    },
    freeUse(p, cardId) {
      const has = id => p.research.includes(id);
      if (cardId === 'r_present')   return has('r_present');
      if (cardId === 'r_paper')     return has('r_paper') && G.era >= 3;
      if (cardId === 'r_genome')    return has('r_genome');
      if (cardId === 'r_antidote')  return has('r_antidote') && diseaseCount(p) > 0;
      if (cardId === 'r_dominant')  return has('r_dominant') && p.slots.some(s => s && s.disease);
      if (cardId === 'r_collab')    return has('r_collab');     // always trade
      if (cardId === 'r_interfere') return has('r_interfere') && G.era >= 4;  // late-game only
      if (cardId === 'r_foresight') return has('r_foresight');
      return false;
    },
    pickCollabTarget(p, others) {
      // Help the lowest-VP opponent — minimal threat boost
      return [...others].sort((a, b) => a.vp - b.vp)[0];
    },
    pickInterfereTarget(p, others) {
      const goal = GOAL_BY_ID[G.goals[G.era - 1]];
      return [...others].sort((a, b) => goal.score(b) - goal.score(a))[0];
    },
    pickNominateTarget(p, others, goal) {
      // Pick the opponent whose alleles best fit my needs (highest unique alleles)
      return [...others].sort((a, b) => uniqueAlleleCount(b) - uniqueAlleleCount(a))[0];
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

function animateDie(finalValue) {
  const dieSlot = $('die-slot');
  if (!dieSlot) return;
  // Tumble through random faces, then settle
  const frames = [];
  for (let i = 0; i < 6; i++) frames.push(Math.floor(Math.random() * 6) + 1);
  frames.push(finalValue);
  let i = 0;
  dieSlot.innerHTML = '';
  const die = buildDie(frames[0]);
  die.classList.add('rolling');
  dieSlot.appendChild(die);
  const tick = setInterval(() => {
    i++;
    if (i >= frames.length) {
      clearInterval(tick);
      dieSlot.innerHTML = '';
      dieSlot.appendChild(buildDie(finalValue));
      return;
    }
    dieSlot.innerHTML = '';
    const d = buildDie(frames[i]);
    d.classList.add('rolling');
    dieSlot.appendChild(d);
  }, 90);
}
function rollD6(reason = '') {
  const v = Math.floor(Math.random() * 6) + 1;
  G.lastDieRoll = { value: v, reason };
  animateDie(v);
  const r = $('die-reason');
  if (r) r.textContent = reason || '';
  return v;
}

// ===== Cut-in system =====
G.cutinQueue = G.cutinQueue || [];
G.cutinPlaying = false;

function showCutin(opts) {
  G.cutinQueue.push(opts);
  if (!G.cutinPlaying) playNextCutin();
}

function playNextCutin() {
  const layer = $('cutin-layer');
  if (!layer || G.cutinQueue.length === 0) {
    G.cutinPlaying = false;
    if (layer) layer.classList.remove('active');
    // Resume AI loop if pending
    scheduleAITurnIfNeeded();
    return;
  }
  G.cutinPlaying = true;
  layer.classList.add('active');
  const opts = G.cutinQueue.shift();

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
  // Dice rolls
  if (opts.diceRolls && opts.diceRolls.length > 0) {
    const wrap = el('div', { class: 'cutin-dice-wrap' });
    opts.diceRolls.forEach((r, idx) => {
      const item = el('div', { class: 'cutin-dice-item' + (r.triggered ? ' triggered' : '') });
      item.appendChild(el('div', { class: 'cutin-dice-label' }, r.label || ''));
      const dieSlot = el('div', { class: 'cutin-dice-die' });
      // Show empty die placeholder; animation fills it
      dieSlot.appendChild(buildDie(null));
      item.appendChild(dieSlot);
      item.appendChild(el('div', { class: 'cutin-dice-outcome' }, r.outcome || ''));
      wrap.appendChild(item);
      // Animate the die after a small staggered delay
      setTimeout(() => animateDieIn(dieSlot, r.value), 350 + idx * 250);
    });
    inner.appendChild(wrap);
  }
  // Next button
  const dismiss = () => {
    cutin.classList.add('leaving');
    setTimeout(() => {
      layer.innerHTML = '';
      setTimeout(() => playNextCutin(), 60);
    }, 480);
  };
  inner.appendChild(el('button', { class: 'cutin-next', onclick: dismiss }, '▶ 次へ'));
  row.appendChild(inner);
  cutin.appendChild(row);
  layer.appendChild(cutin);

  // Failsafe: auto-dismiss after 12s
  setTimeout(() => {
    if (cutin.parentNode) dismiss();
  }, opts.maxWait || 12000);
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
  return el('div', { class: cls.join(' '), title: m.desc, ...(opts.onclick ? { onclick: opts.onclick } : {}) },
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
}

function buildResearchCard(rid, opts = {}) {
  const r = RESEARCH_BY_ID[rid];
  const cls = ['card', 'research-card'];
  if (opts.clickable) cls.push('clickable');
  return el('div', { class: cls.join(' '), title: r.desc, ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/research-${rid}.jpg)` },
      el('span', { class: 'card-type' }, '研究'),
      el('span', { class: 'card-sys' }, '⚗')
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, r.name),
      el('div', { class: 'card-effect' }, r.desc)
    )
  );
}

function buildCharacterCard(charId, opts = {}) {
  const c = CHAR_BY_ID[charId];
  const cls = ['card', 'character-card'];
  if (opts.selected) cls.push('selected');
  if (opts.clickable || opts.onclick) cls.push('clickable');
  return el('div', { class: cls.join(' '), ...(opts.onclick ? { onclick: opts.onclick } : {}) },
    el('div', { class: 'card-img', style: `background-image:url(assets/char-${charId}.jpg)` },
      el('span', { class: 'card-type' }, c.title),
      el('span', { class: 'card-sys' }, '♛')
    ),
    el('div', { class: 'card-text' },
      el('div', { class: 'card-name' }, c.name),
      el('div', { class: 'card-effect' }, c.effect)
    )
  );
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
      // Slot full: roll d6
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
      });
      if (old) {
        G.alleleDiscard.push(old.type);
      }
      p.slots[slotIdx] = null;
      placeAlleleInSlot(p, chosenId, slotIdx);
      render();
      endTurn();
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
function actNominate() {
  const p = activePlayer();
  if (filledCount(p) === 0) {
    log(`${p.name}: 自分のアレルがないと指名できない。`); return endTurn();
  }
  if (p.isAI) {
    // AI: simple — sometimes self-nominate, sometimes target weakest opponent
    const others = G.players.filter(o => o.id !== p.id && filledCount(o) > 0);
    if (Math.random() < 0.4 && others.length > 0 && p.vp >= 1) {
      const target = others[Math.floor(Math.random() * others.length)];
      doNominateOther(p, target);
    } else {
      doSelfNominate(p);
    }
  } else {
    // Human: show modal to select self or other
    const buttons = [
      { label: '自家交配（1d6でランダム裏返し）', onclick: () => { closeModal(); doSelfNominate(p); } },
      ...G.players.filter(o => o.id !== p.id && filledCount(o) > 0).map(o => ({
        label: `${o.name} を指名（1VP支払う）`,
        disabled: p.vp < 1,
        onclick: () => { closeModal(); doNominateOther(p, o); }
      })),
      { label: 'キャンセル', onclick: () => { closeModal(); render(); } }
    ];
    showActionListModal('アレル指名交換', '相手を選んでください', buttons);
  }
}

function doSelfNominate(p) {
  const isFiancee = p.characterId === 'fiancee';
  let attempts = 0;
  let roll, slot;
  while (attempts < 6) {
    roll = rollD6(`${p.name}: 自家交配`);
    slot = p.slots[roll - 1];
    if (slot) break;
    attempts++;
  }
  log(`${p.name}: 自家交配 1d6=${roll}。`);
  if (!slot) {
    showCutin({
      kind: 'dice-cross',
      title: `${p.name}: 自家交配`,
      subtitle: '1d6 で対象スロット決定',
      diceRolls: [{ label: `Slot${roll}`, value: roll, outcome: 'スロット空白 ─ アクション無駄', triggered: false }],
    });
    log(`${p.name}: 該当スロットが空白続きでアクション無駄に。`, 'loss');
    return endTurn();
  }
  // Allow re-roll once for fiancee if recessive
  let rerollVal = null;
  if (isFiancee && slot.recessive) {
    rerollVal = rollD6(`${p.name}: 婚約者振り直し`);
    log(`${p.name}: 婚約者効果で振り直し → 1d6=${rerollVal}。`);
    if (p.slots[rerollVal - 1]) { roll = rerollVal; slot = p.slots[rerollVal - 1]; }
  }
  let outcome, triggered = false;
  if (slot.recessive) {
    outcome = `Slot${roll}「${ALLELE_BY_ID[slot.type].name}」既に劣勢発現中`;
    log(`${p.name}: 既に劣勢発現中、アクション無駄。`, 'loss');
  } else {
    slot.recessive = true;
    outcome = `Slot${roll}「${ALLELE_BY_ID[slot.type].name}」を劣勢発現!`;
    triggered = true;
    log(`${p.name}: Slot${roll}「${ALLELE_BY_ID[slot.type].name}」を劣勢発現。`, 'event');
  }
  const rolls = [{ label: `Slot${roll}`, value: roll, outcome, triggered }];
  if (rerollVal !== null) {
    rolls.unshift({ label: '婚約者効果で振り直し', value: rerollVal, outcome: '振り直し成立' });
  }
  showCutin({
    kind: 'dice-cross',
    title: `${p.name}: 自家交配`,
    subtitle: '1d6 で対象スロット決定',
    diceRolls: rolls,
  });
  endTurn();
}

function doNominateOther(p, target) {
  // Pay 1 VP to target as Stud Fee
  p.vp -= 1;
  const fee = (target.characterId === 'wife') ? 2 : 1;
  target.vp += fee;
  target.studFees += fee;
  log(`${p.name}: ${target.name} に Stud Fee ${fee}VP 支払い。`, 'event');

  // Roll for own slot
  let myRoll, myIdx, myEmpty = 0;
  do { myRoll = rollD6(`${p.name}: 自分のスロット`); myIdx = myRoll - 1; myEmpty++; } while (!p.slots[myIdx] && myEmpty < 12);
  if (!p.slots[myIdx]) { log(`${p.name}: 自身のスロットが空白続きでアクション無駄に。`, 'loss'); return endTurn(); }

  let tRoll, tIdx, tEmpty = 0;
  do { tRoll = rollD6(`${target.name}: 相手のスロット`); tIdx = tRoll - 1; tEmpty++; } while (!target.slots[tIdx] && tEmpty < 12);
  if (!target.slots[tIdx]) { log(`${target.name}: スロットが空白続きで交換失敗。`, 'loss'); return endTurn(); }

  // Swap
  const a = p.slots[myIdx], b = target.slots[tIdx];
  showCutin({
    kind: 'dice-exchange',
    title: `指名交換: ${p.name} ⇄ ${target.name}`,
    subtitle: `双方が1d6で対象スロットを決定`,
    diceRolls: [
      { label: `${p.name}`,      value: myRoll, outcome: `Slot${myIdx + 1}「${ALLELE_BY_ID[a.type].name}」` , triggered: true },
      { label: `${target.name}`, value: tRoll,  outcome: `Slot${tIdx + 1}「${ALLELE_BY_ID[b.type].name}」`, triggered: true },
    ],
  });
  p.slots[myIdx] = null;
  target.slots[tIdx] = null;
  log(`${p.name}↔${target.name}: Slot${myIdx + 1}(${ALLELE_BY_ID[a.type].name}) ↔ Slot${tIdx + 1}(${ALLELE_BY_ID[b.type].name}) 交換。`);
  // Place each
  placeAlleleInSlot(p, b.type, myIdx, b.recessive);
  placeAlleleInSlot(target, a.type, tIdx, a.recessive);
  endTurn();
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
      const idx = p.slots.findIndex(s => s && s.disease);
      if (idx === -1) { log(`${p.name}: 解毒剤を使用したが疾患なし。`); }
      else {
        p.slots[idx].disease = false;
        log(`${p.name}: 解毒剤でSlot${idx + 1}の疾患を除去！`, 'gain');
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
      const target = pickOwnSlotAI(p, s => s && s.recessive);
      if (target == null) { log(`${p.name}: 強制顕性化の対象なし。`); }
      else {
        p.slots[target].recessive = false;
        p.slots[target].disease = false;
        log(`${p.name}: 強制顕性化 → Slot${target + 1}を表向き化（疾患も除去）。`, 'gain');
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
  // If a cutin is on screen waiting for user, hold off — playNextCutin
  // will call this back once the queue is drained.
  if (G.cutinPlaying || G.cutinQueue.length > 0) return;
  const p = activePlayer();
  if (p.isAI) {
    setTimeout(() => aiTakeTurn(), 700);
  }
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

  // Self-cross — only if expected benefit > expected disease risk
  const sb = aiBestSelfFlipBenefit(p);
  if (sb > 1.5 && filledCount(p) >= 2) {
    const expectedRisk = G.era * 0.5;
    candidates.push({ kind: 'self_nominate', score: 18 + sb - expectedRisk });
  }

  // Nominate another — personality picks the target
  if (p.vp >= 1 && filledCount(p) > 0) {
    const others = G.players.filter(o => o.id !== p.id && filledCount(o) > 0);
    if (others.length > 0 && persona.pickNominateTarget) {
      const target = persona.pickNominateTarget(p, others, goal);
      if (target) {
        const myG = goal.score(p);
        const tG = goal.score(target);
        // Attacker tolerates equal-goal targets; others demand a clear behind state
        const minBehind = (p.personality === 'attacker') ? -2 : 1;
        if (tG > myG + minBehind && G.era >= 2) {
          candidates.push({ kind: 'nominate_other', target, score: 5 + Math.min(tG - myG, 5) });
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
    case 'nominate_other':  return doNominateOther(p, choice.target);
    case 'pass':            return actPass();
  }
}

// ===== Year-End / Conference =====
function yearEnd() {
  log(`━━━ 第${G.era}学会期 終了処理 ━━━`, 'system');
  // 1. Reveal & evaluate goal
  evaluateGoal();
  // 2. Disease check
  diseaseCheck();
  // 3. Disease cumulative penalty
  applyDiseasePenalty();

  if (G.era === NUM_ERAS) {
    return endGame();
  }
  // 4. Reveal next goal
  G.era += 1;
  log(`★ 第${G.era}学会期 公開目標: ${GOAL_BY_ID[G.goals[G.era - 1]].name} — ${GOAL_BY_ID[G.goals[G.era - 1]].desc}`, 'system');
  // 5. President picks next president (simplified: cycle to next)
  G.presidentIdx = (G.presidentIdx + 1) % NUM_PLAYERS;
  log(`★ 次任学会理事: ${G.players[G.presidentIdx].name}`, 'system');
  G.round = 1;
  G.turnIndex = 0;
  render();
  showSeasonStartCutin(G.era);
  scheduleAITurnIfNeeded();
}

function evaluateGoal() {
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  const ranking = G.players.map(p => ({ p, score: goal.score(p) }));
  ranking.sort((a, b) => goal.desc_low ? a.score - b.score : b.score - a.score);
  log(`公開目標「${goal.name}」評価: ${ranking.map(r => `${r.p.name}=${r.score}`).join(', ')}`);
  const vps = [5, 3, 1, 0];
  const cutinLines = [];
  for (let i = 0; i < ranking.length; i++) {
    let vp = vps[i];
    let suffix = '';
    if (vp > 0) {
      if (ranking[i].p.characterId === 'mistress') vp += 1;
      ranking[i].p.vp += vp;
      log(`${ranking[i].p.name}: ${i + 1}位 → +${vp}VP`, 'gain');
      G.conferenceVPs.push({ era: G.era, playerId: ranking[i].p.id, rank: i + 1, vp, goalId: goal.id });
      suffix = ` +${vp}VP`;
      if (i === 0) suffix += ' +研究';
    }
    cutinLines.push(`${i + 1}位  ${ranking[i].p.name}  (${ranking[i].score})${suffix}`);
  }
  // 1st place gets a research card
  const winner = ranking[0].p;
  const r = drawCard(G.researchDeck, G.researchDiscard);
  if (r) {
    winner.research.push(r);
    log(`${winner.name}: 1位賞として研究「${RESEARCH_BY_ID[r].name}」獲得。`, 'gain');
  }
  // Track winner for era track display
  G.conferenceHistory.push({ era: G.era, winnerId: winner.id, goalId: goal.id });

  // Cutin
  showCutin({
    kind: 'ranking',
    title: `第${G.era}学会 結果発表`,
    subtitle: `公開目標「${goal.name}」`,
    image: `assets/goal-${goal.id}.jpg`,
    lines: cutinLines,
    duration: 3200,
  });
}

function diseaseCheck() {
  for (const p of G.players) {
    const rolls = [];
    for (let i = 0; i < p.slots.length; i++) {
      const s = p.slots[i];
      if (!s || !s.recessive || s.disease) continue;
      const roll = rollD6('');  // suppress reason in public-area die
      const allele = ALLELE_BY_ID[s.type];
      const triggered = roll <= G.era;
      let outcome;
      if (triggered) {
        s.disease = true;
        p.diseaseLog.push({ era: G.era, slotIdx: i, name: allele.dis });
        log(`${p.name}: Slot${i + 1}「${allele.name}」疾患判定 1d6=${roll}≤${G.era} → 疾患「${allele.dis}」発症！`, 'loss');
        outcome = `≤${G.era} → 発症「${allele.dis}」`;
      } else {
        outcome = `>${G.era} → 安全`;
      }
      rolls.push({
        label: `Slot${i + 1} ${allele.name}(劣勢)`,
        value: roll,
        outcome,
        triggered,
      });
    }
    if (rolls.length > 0) {
      showCutin({
        kind: 'dice-disease',
        title: `${p.name}: 疾患判定`,
        subtitle: `劣勢アレルごとに 1d6 ─ 出目 ≤ ${G.era} で発症`,
        diceRolls: rolls,
      });
    }
  }
}

function applyDiseasePenalty() {
  for (const p of G.players) {
    const n = diseaseCount(p);
    if (n > 0) {
      p.vp -= n;
      log(`${p.name}: 疾患マーカー${n}個 → -${n}VP`, 'loss');
    }
  }
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
  renderGoalBar();
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

  // Round dots
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
  bar.appendChild(roundEl);

  // President
  const prez = el('div', { class: 'president-display' },
    el('span', { class: 'crown' }, '♛'),
    el('span', { class: 'label' }, '学会理事:'),
    el('span', { class: 'prez-name' }, G.players[G.presidentIdx].name)
  );
  bar.appendChild(prez);
}

function renderGoalBar() {
  const bar = $('goal-bar');
  bar.innerHTML = '';

  // Decks
  bar.appendChild(makeDeckStack('allele', 'アレル', G.alleleDeck.length, G.alleleDiscard.length));
  bar.appendChild(makeDeckStack('research', '研究', G.researchDeck.length, G.researchDiscard.length));
  bar.appendChild(makeDeckStack('memory', '記憶', G.memoryDeck.length, 0));

  // Goal card (wide banner with image + text)
  const goal = GOAL_BY_ID[G.goals[G.era - 1]];
  const goalCard = el('div', { class: 'goal-card' },
    el('div', { class: 'goal-img', style: `background-image:url(assets/goal-${goal.id}.jpg)` }),
    el('div', { class: 'goal-text' },
      el('div', { class: 'goal-label' }, '第' + G.era + '学会期 公開目標'),
      el('div', { class: 'goal-name' }, goal.name),
      el('div', { class: 'goal-desc' }, goal.desc + (goal.desc_low ? ' (最小値が勝利)' : ''))
    )
  );
  bar.appendChild(goalCard);

  // Dice display
  const diceArea = el('div', { class: 'dice-area' });
  diceArea.appendChild(el('div', { class: 'dice-label' }, '1d6'));
  const dieSlot = el('div', { id: 'die-slot' });
  const lr = G.lastDieRoll || {};
  dieSlot.appendChild(buildDie(lr.value || null));
  diceArea.appendChild(dieSlot);
  diceArea.appendChild(el('div', { class: 'dice-reason', id: 'die-reason' }, lr.reason || '—'));
  bar.appendChild(diceArea);
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
  const t = calcTraits(p);
  const board = el('div', {
    class: 'player-board' + (isActive ? ' active' : '') + (isPresident ? ' president' : ''),
    style: `--char-bg:url(assets/char-${p.characterId}.jpg)`
  });

  const persona = p.isAI && p.personality ? PERSONALITIES[p.personality] : null;
  board.appendChild(el('div', { class: 'player-header' },
    el('span', {},
      el('span', { class: 'player-name' }, p.name + (p.isAI ? '' : ' [あなた]')),
      el('span', { class: 'player-char' }, ' — ' + CHAR_BY_ID[p.characterId].name),
      persona ? el('span', {
        class: 'persona-badge',
        style: `color:${persona.color};border-color:${persona.color}`,
        title: persona.flavor
      }, persona.icon + ' ' + persona.label) : null
    ),
    el('span', { class: 'player-vp' }, el('span', { class: 'num' }, String(p.vp)), ' VP')
  ));

  // Traits with gauge bars (cap at 8 for full bar)
  const TMAX = 8;
  const traitsDiv = el('div', { class: 'traits' });
  for (const k of ['健', '艶', '心', '智']) {
    const v = t[k];
    const bar = Math.min(100, Math.round(v / TMAX * 100));
    const tdiv = el('div', { class: 'trait', 'data-sys': k, style: '--bar:' + bar + '%' },
      el('span', { class: 'key' }, k),
      el('span', { class: 'val' }, String(v))
    );
    traitsDiv.appendChild(tdiv);
  }
  board.appendChild(traitsDiv);

  // Slot row label
  board.appendChild(el('div', { class: 'slot-row-label' }, '遺伝子スロット'));

  // Slots — built as cards
  const slotsDiv = el('div', { class: 'slots' });
  for (let i = 0; i < 6; i++) {
    const s = p.slots[i];
    let opts = {};
    if (G.pending && !p.isAI) {
      if (G.pending.type === 'select_own_slot' && p.id === activePlayer().id && G.pending.filter(i)) {
        opts = { clickable: true, onclick: () => G.pending.cb(i) };
      } else if (G.pending.type === 'select_other_slot' && p.id === G.pending.target && G.pending.filter(i)) {
        opts = { clickable: true, onclick: () => G.pending.cb(i) };
      }
    }
    slotsDiv.appendChild(buildAlleleCard(s, i, opts));
  }
  board.appendChild(slotsDiv);

  // Memories (visible only to human player)
  const isHuman = !p.isAI;
  const memSection = el('div', { class: 'cards-section' });
  memSection.appendChild(el('div', { class: 'label' }, '記憶の断片', el('span', { class: 'count' }, p.memories.length + '枚 / 達成' + p.achievedMemories.length)));
  if (isHuman) {
    if (p.memories.length === 0) {
      memSection.appendChild(el('div', { class: 'hint' }, '（まだ無し）'));
    } else {
      const row = el('div', { class: 'card-row' });
      for (const id of p.memories) {
        row.appendChild(buildMemoryCard(id, p));
      }
      memSection.appendChild(row);
    }
  } else {
    memSection.appendChild(el('div', { class: 'hint' }, '（伏せ手札）'));
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
    resSection.appendChild(el('div', { class: 'hint' }, '（伏せ手札）'));
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

// ===== Init =====
window.addEventListener('DOMContentLoaded', () => {
  renderSetup();
});
