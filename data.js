/* ===========================
   最愛のガラテア — Game Data
   =========================== */

// ----- Allele definitions (16 types) -----
const ALLELES = [
  // 艶 系統
  { id: 'kuroginu',     name: '黒絹の髪',    sys: '艶', dom: { 艶: 2 },         rec: { 艶: 4 }, dis: '虚栄' },
  { id: 'akakuchi',     name: '朱の唇',      sys: '艶', dom: { 艶: 1, 智: 1 }, rec: { 艶: 3 }, dis: '蠱惑過多' },
  { id: 'sukitooru',    name: '透き通る肌',  sys: '艶', dom: { 艶: 1, 健: 1 }, rec: { 艶: 3 }, dis: '病的な美' },
  { id: 'mitsunokyoku', name: '蜜の曲線',    sys: '艶', dom: { 艶: 1, 心: 1 }, rec: { 艶: 3 }, dis: '媚態過多' },
  // 健 系統
  { id: 'sukoyaka',     name: '健やかな脚',  sys: '健', dom: { 健: 2 },         rec: { 健: 4 }, dis: '多動' },
  { id: 'shinaru',      name: 'しなる筋肉',  sys: '健', dom: { 健: 1, 艶: 1 }, rec: { 健: 3 }, dis: '攣り' },
  { id: 'takumashii',   name: 'たくましい腕', sys: '健', dom: { 健: 1, 心: 1 }, rec: { 健: 3 }, dis: '暴力的' },
  { id: 'tsuyoishin',   name: '強い心肺',    sys: '健', dom: { 健: 1, 智: 1 }, rec: { 健: 3 }, dis: '興奮過多' },
  // 心 系統
  { id: 'hagane',       name: '鋼の意志',    sys: '心', dom: { 心: 2 },         rec: { 心: 4 }, dis: '頑迷' },
  { id: 'junjou',       name: '純情',        sys: '心', dom: { 心: 1, 艶: 1 }, rec: { 心: 3 }, dis: '涙脆い' },
  { id: 'jiai',         name: '慈愛',        sys: '心', dom: { 心: 1, 健: 1 }, rec: { 心: 3 }, dis: '慈愛過多' },
  { id: 'kyoumei',      name: '共鳴の心',    sys: '心', dom: { 心: 1, 智: 1 }, rec: { 心: 3 }, dis: '自我希薄' },
  // 智 系統
  { id: 'yutaka',       name: '豊かな学識',  sys: '智', dom: { 智: 2 },         rec: { 智: 4 }, dis: '衒学' },
  { id: 'dousatsu',     name: '鋭い洞察',    sys: '智', dom: { 智: 1, 心: 1 }, rec: { 智: 3 }, dis: '詮索過多' },
  { id: 'kibin',        name: '機敏な機転',  sys: '智', dom: { 智: 1, 艶: 1 }, rec: { 智: 3 }, dis: '軽薄' },
  { id: 'kansatsu',     name: '鋭い観察眼',  sys: '智', dom: { 智: 1, 健: 1 }, rec: { 智: 3 }, dis: '神経過敏' },
];
const ALLELE_BY_ID = Object.fromEntries(ALLELES.map(a => [a.id, a]));

function buildAlleleDeck() {
  const deck = [];
  for (const a of ALLELES) for (let i = 0; i < 4; i++) deck.push(a.id);
  return deck;
}

// ----- Helpers used by memory & goal conditions -----
function calcTraits(p) {
  const t = { 健: 0, 艶: 0, 心: 0, 智: 0 };
  for (const s of p.slots) {
    if (!s) continue;
    const a = ALLELE_BY_ID[s.type];
    const eff = s.recessive ? a.rec : a.dom;
    for (const k of Object.keys(eff)) t[k] += eff[k];
  }
  return t;
}
function hasAllele(p, id) { return p.slots.some(s => s && s.type === id); }
function hasDisease(p, name) {
  return p.slots.some(s => s && s.disease && ALLELE_BY_ID[s.type].dis === name);
}
function diseaseCount(p) { return p.slots.filter(s => s && s.disease).length; }
function recessiveCount(p) { return p.slots.filter(s => s && s.recessive).length; }
function dominantCount(p) { return p.slots.filter(s => s && !s.recessive).length; }
function filledCount(p) { return p.slots.filter(s => s).length; }
function uniqueAlleleCount(p) { return new Set(p.slots.filter(s => s).map(s => s.type)).size; }

// ----- Character cards -----
const CHARACTERS = [
  { id: 'daughter',  name: '最愛の娘',       title: '医師',   effect: '記憶の断片ドロー時、2枚見て1枚選ぶ' },
  { id: 'wife',      name: '最愛の妻',       title: '教授',   effect: 'Stud Fee 取得時 +1VP（受取が2VP）' },
  { id: 'mistress',  name: '最愛の愛人',     title: '詩人',   effect: '公開目標で受け取るVP +1' },
  { id: 'fiancee',   name: '最愛の婚約者',   title: '騎士',   effect: '自家交配時、1d6を振り直せる' },
  { id: 'osananaji', name: '最愛の幼馴染',   title: '医学生', effect: 'アレル削除時、+1VP' },
  { id: 'tutor',     name: '最愛の家庭教師', title: '修道女', effect: '研究ドロー時、+1枚見て選ぶ' },
  { id: 'imouto',    name: '最愛の妹',       title: '司書',   effect: 'アレルドロー時、2枚見て1枚選ぶ' },
  { id: 'maid',      name: '最愛のメイド',   title: '召使',   effect: 'ゲーム中2回、研究を山札底に戻して引き直せる' },
];
const CHAR_BY_ID = Object.fromEntries(CHARACTERS.map(c => [c.id, c]));

// ----- Research cards -----
// Effects are applied via game.applyResearch(player, card)
const RESEARCH = [
  { id: 'r_present',   name: '研究発表',     count: 4, type: 'instant', desc: '即座に +3VP' },
  { id: 'r_paper',     name: '論文発表',     count: 3, type: 'instant', desc: '即座に +5VP（学会期3以降）' },
  { id: 'r_antidote',  name: '解毒剤',       count: 3, type: 'target_disease', desc: '自分の疾患マーカー1個を除去' },
  { id: 'r_recess',    name: '強制裏返し',   count: 3, type: 'target_self_slot', desc: '自分のアレル1枚を強制裏返し' },
  { id: 'r_dominant',  name: '強制顕性化',   count: 3, type: 'target_self_slot', desc: '自分のアレル1枚を表向きに（疾患も解除）' },
  { id: 'r_mutate',    name: '変異誘発',     count: 3, type: 'target_self_slot', desc: 'アレル1枚をランダムなアレルと交換' },
  { id: 'r_copy',      name: '複製術',       count: 2, type: 'target_self_slot', desc: 'アレル1枚を別スロットへ複製（ホモ接合発生）' },
  { id: 'r_oracle',    name: '古文書解読',   count: 3, type: 'instant', desc: '記憶デッキ上3枚を見て1枚キープ' },
  { id: 'r_catalyst',  name: '触媒研究',     count: 3, type: 'instant', desc: '研究山札上3枚を見て1枚キープ' },
  { id: 'r_foresight', name: '学会先見',     count: 2, type: 'instant', desc: '次々学会期の公開目標を覗く' },
  { id: 'r_collab',    name: '共同研究',     count: 2, type: 'target_player', desc: '他プレイヤー1名と協力、両者+2VP' },
  { id: 'r_interfere', name: '干渉術',       count: 2, type: 'target_other_slot', desc: '相手のアレル1枚を強制裏返し' },
  { id: 'r_genome',    name: '遺伝子鑑定',   count: 2, type: 'instant', desc: '即座に +2VP（情報優位の対価）' },
];
const RESEARCH_BY_ID = Object.fromEntries(RESEARCH.map(r => [r.id, r]));

function buildResearchDeck() {
  const deck = [];
  for (const r of RESEARCH) for (let i = 0; i < r.count; i++) deck.push(r.id);
  return deck;
}

// ----- Memory cards -----
// tier: easy=+/-2, medium=+/-4, hard=+/-6
const MEMORIES = [
  // Easy (8)
  { id: 'm_smile', tier: 'easy', name: 'ささやかな笑顔', desc: '純情と慈愛を持つ', cond: p => hasAllele(p,'junjou') && hasAllele(p,'jiai') },
  { id: 'm_morn',  tier: 'easy', name: '健やかな朝',     desc: '健やかな脚と強い心肺', cond: p => hasAllele(p,'sukoyaka') && hasAllele(p,'tsuyoishin') },
  { id: 'm_wise',  tier: 'easy', name: '賢き眼差し',     desc: '豊かな学識と鋭い洞察', cond: p => hasAllele(p,'yutaka') && hasAllele(p,'dousatsu') },
  { id: 'm_hair',  tier: 'easy', name: '艶めく髪',       desc: '黒絹の髪を持つ', cond: p => hasAllele(p,'kuroginu') },
  { id: 'm_hand',  tier: 'easy', name: '優しき手',       desc: '慈愛とたくましい腕', cond: p => hasAllele(p,'jiai') && hasAllele(p,'takumashii') },
  { id: 'm_wit',   tier: 'easy', name: '機知の閃き',     desc: '機敏な機転と鋭い観察眼', cond: p => hasAllele(p,'kibin') && hasAllele(p,'kansatsu') },
  { id: 'm_pure',  tier: 'easy', name: '純真の心',       desc: '心 ≥ 3', cond: p => calcTraits(p).心 >= 3 },
  { id: 'm_body',  tier: 'easy', name: 'しなやかな身体', desc: '健 ≥ 3', cond: p => calcTraits(p).健 >= 3 },

  // Medium (16)
  { id: 'm_evil',  tier: 'medium', name: '妖艶な悪女',   desc: '疾患「蠱惑過多」+黒絹の髪', cond: p => hasDisease(p,'蠱惑過多') && hasAllele(p,'kuroginu') },
  { id: 'm_pass',  tier: 'medium', name: '燃える情熱',   desc: '心 ≥ 4 かつ 艶 ≥ 4', cond: p => { const t=calcTraits(p); return t.心>=4 && t.艶>=4; } },
  { id: 'm_brain', tier: 'medium', name: '知性の輝き',   desc: '智 ≥ 5', cond: p => calcTraits(p).智 >= 5 },
  { id: 'm_sick',  tier: 'medium', name: '病弱の美',     desc: '疾患「病的な美」+艶 ≥ 4', cond: p => hasDisease(p,'病的な美') && calcTraits(p).艶 >= 4 },
  { id: 'm_strong',tier: 'medium', name: '強き乙女',     desc: '健 ≥ 5', cond: p => calcTraits(p).健 >= 5 },
  { id: 'm_madonna',tier:'medium', name: '慈愛の聖母',   desc: '疾患「慈愛過多」+慈愛', cond: p => hasDisease(p,'慈愛過多') && hasAllele(p,'jiai') },
  { id: 'm_mask',  tier: 'medium', name: '偽りの仮面',   desc: '表向きアレル ≥ 4', cond: p => dominantCount(p) >= 4 },
  { id: 'm_dark',  tier: 'medium', name: '闇の貴婦人',   desc: '裏向きアレル ≥ 2', cond: p => recessiveCount(p) >= 2 },
  { id: 'm_vet',   tier: 'medium', name: '歴戦の研究者', desc: '智 + 心 ≥ 6', cond: p => { const t=calcTraits(p); return t.智+t.心 >= 6; } },
  { id: 'm_dance', tier: 'medium', name: '流麗の舞姫',   desc: '艶 + 健 ≥ 6', cond: p => { const t=calcTraits(p); return t.艶+t.健 >= 6; } },
  { id: 'm_multi', tier: 'medium', name: '多才の佳人',   desc: '4軸すべて ≥ 2', cond: p => { const t=calcTraits(p); return t.健>=2 && t.艶>=2 && t.心>=2 && t.智>=2; } },
  { id: 'm_iron',  tier: 'medium', name: '鋼の決意',     desc: '疾患「頑迷」+心 ≥ 4', cond: p => hasDisease(p,'頑迷') && calcTraits(p).心 >= 4 },
  { id: 'm_genius',tier: 'medium', name: '異端の天才',   desc: '疾患「衒学」+智 ≥ 5', cond: p => hasDisease(p,'衒学') && calcTraits(p).智 >= 5 },
  { id: 'm_diva',  tier: 'medium', name: '哀切の歌姫',   desc: '疾患「涙脆い」+純情', cond: p => hasDisease(p,'涙脆い') && hasAllele(p,'junjou') },
  { id: 'm_curse', tier: 'medium', name: '致命の魔性',   desc: '疾患マーカー ≥ 2', cond: p => diseaseCount(p) >= 2 },
  { id: 'm_perfect',tier:'medium', name: '完璧な肉体',   desc: '健 ≥ 4 かつ 艶 ≥ 4', cond: p => { const t=calcTraits(p); return t.健>=4 && t.艶>=4; } },

  // Hard (8)
  { id: 'm_ideal', tier: 'hard', name: '完璧なる彼女',   desc: '4軸すべて ≥ 4', cond: p => { const t=calcTraits(p); return t.健>=4 && t.艶>=4 && t.心>=4 && t.智>=4; } },
  { id: 'm_pure_master',tier:'hard',name:'純血の傑作',   desc: '裏向き ≥ 3 かつ 健 ≥ 5', cond: p => recessiveCount(p) >= 3 && calcTraits(p).健 >= 5 },
  { id: 'm_saint', tier: 'hard', name: '静謐の聖女',     desc: '心 ≥ 5 かつ 智 ≥ 5 かつ 疾患なし', cond: p => { const t=calcTraits(p); return t.心>=5 && t.智>=5 && diseaseCount(p)===0; } },
  { id: 'm_omni',  tier: 'hard', name: '万能の天才',     desc: '4軸 ≥ 3 かつ 智 ≥ 5', cond: p => { const t=calcTraits(p); return t.健>=3 && t.艶>=3 && t.心>=3 && t.智>=5; } },
  { id: 'm_venus', tier: 'hard', name: '永遠の美神',     desc: '艶 ≥ 7', cond: p => calcTraits(p).艶 >= 7 },
  { id: 'm_soul',  tier: 'hard', name: '不滅の魂',       desc: '心 ≥ 7', cond: p => calcTraits(p).心 >= 7 },
  { id: 'm_unique',tier: 'hard', name: '唯一の存在',     desc: '異種5枚以上で6スロット埋', cond: p => uniqueAlleleCount(p) >= 5 && filledCount(p) === 6 },
  { id: 'm_god',   tier: 'hard', name: '神に近き者',     desc: '4軸合計 ≥ 16', cond: p => { const t=calcTraits(p); return t.健+t.艶+t.心+t.智 >= 16; } },
];
const MEMORY_BY_ID = Object.fromEntries(MEMORIES.map(m => [m.id, m]));
const MEMORY_REWARD = { easy: 2, medium: 4, hard: 6 };

// ----- Public goal cards -----
const GOALS = [
  // 象限 (4)
  { id: 'g_otome',  name: '乙女の理想',   desc: '健 + 心 が最高',  score: p => calcTraits(p).健 + calcTraits(p).心, desc_low: false },
  { id: 'g_kensai', name: '賢妻の鑑',     desc: '心 + 智 が最高',  score: p => calcTraits(p).心 + calcTraits(p).智, desc_low: false },
  { id: 'g_nazo',   name: '謎の佳人',     desc: '艶 + 智 が最高',  score: p => calcTraits(p).艶 + calcTraits(p).智, desc_low: false },
  { id: 'g_jou',    name: '情熱の人',     desc: '艶 + 心 が最高',  score: p => calcTraits(p).艶 + calcTraits(p).心, desc_low: false },
  // 閾値 (4)
  { id: 'g_yuri',   name: '白百合のごとき', desc: '健 が最高',     score: p => calcTraits(p).健, desc_low: false },
  { id: 'g_shin',   name: '深淵の知',     desc: '智 が最高',       score: p => calcTraits(p).智, desc_low: false },
  { id: 'g_youen',  name: '妖艶の極み',   desc: '艶 が最高',       score: p => calcTraits(p).艶, desc_low: false },
  { id: 'g_seijo',  name: '聖女の心',     desc: '心 が最高',       score: p => calcTraits(p).心, desc_low: false },
  // 構造 (5)
  { id: 'g_chowa',  name: '完璧なる調和', desc: '4軸の最小値が最高', score: p => { const t=calcTraits(p); return Math.min(t.健,t.艶,t.心,t.智); }, desc_low: false },
  { id: 'g_hikaeme',name: '控えめな研究', desc: '4軸の最大値が最小', score: p => { const t=calcTraits(p); return Math.max(t.健,t.艶,t.心,t.智); }, desc_low: true },
  { id: 'g_junketsu',name:'純血の至高',   desc: '裏向きアレル数が最多', score: p => recessiveCount(p), desc_low: false },
  { id: 'g_tayou',  name: '多様の祝福',   desc: '異種アレル数が最多', score: p => uniqueAlleleCount(p), desc_low: false },
  { id: 'g_kinsei', name: '均整の美徳',   desc: '表向きアレル数が最多', score: p => dominantCount(p), desc_low: false },
];
const GOAL_BY_ID = Object.fromEntries(GOALS.map(g => [g.id, g]));

// ===== Recollection (final scene) text fragments =====
const CHAR_LOVER_LABEL = {
  daughter:  '娘',
  wife:      '妻',
  mistress:  '愛人',
  fiancee:   '婚約者',
  osananaji: '幼馴染',
  tutor:     '家庭教師',
  imouto:    '妹',
  maid:      '彼女',
};

const ALLELE_RECALL = {
  kuroginu:     '黒く艶やかな絹のような髪',
  akakuchi:     '朱を引いたような唇',
  sukitooru:    '透き通るほどの白い肌',
  mitsunokyoku: '蜜のように滑らかな曲線',
  sukoyaka:     'すらりと健やかな脚',
  shinaru:      'しなやかにしなる筋肉',
  takumashii:   'たくましい腕',
  tsuyoishin:   '澄んだ歌声を響かせる強い心肺',
  hagane:       '何があっても折れない鋼の意志',
  junjou:       '少女のように清らかな純情',
  jiai:         'すべてを許す慈しみ深い心',
  kyoumei:      '人の痛みにそっと寄り添う共鳴の心',
  yutaka:       '夜更けまで頁をめくる豊かな学識',
  dousatsu:     '深いところまで届く鋭い洞察',
  kibin:        '機転の利く快活な閃き',
  kansatsu:     'すべてを見透かすような観察眼',
};

const DISEASE_RECALL = {
  '虚栄':         '時折ちらつく虚栄心',
  '蠱惑過多':     '蠱惑的すぎるその瞳',
  '病的な美':     '病的なほどに儚い美しさ',
  '媚態過多':     'あふれてしまう媚態',
  '多動':         '落ち着きのなさ',
  '攣り':         'ふとした時の引きつり',
  '暴力的':       'たまに荒れる気性',
  '興奮過多':     'すぐ興奮してしまうところ',
  '頑迷':         '頑なに譲らない一面',
  '涙脆い':       '涙脆さ',
  '慈愛過多':     '自分を犠牲にしすぎる慈しみ',
  '自我希薄':     '他人と境を失くしてしまう希薄な自我',
  '衒学':         '鼻につく衒学趣味',
  '詮索過多':     '人の心まで覗き込む詮索癖',
  '軽薄':         '人を煙に巻く軽薄さ',
  '神経過敏':     'ささいな物音にも怯える神経',
};

const MEMORY_RECALL = {
  m_smile:       'あの控えめなはにかみ笑い',
  m_morn:        '朝の窓辺、伸びをするしなやかな姿',
  m_wise:        '本を閉じる時の凛とした眼差し',
  m_hair:        'すれ違いざまに揺れた艶やかな髪',
  m_hand:        '触れた手のあたたかさ',
  m_wit:         'ふと放たれる機知の閃き',
  m_pure:        '曇りひとつない真っ直ぐな心',
  m_body:        '振り向きざまの軽やかな身のこなし',
  m_evil:        '人を惑わせるあの妖艶さ',
  m_pass:        '胸を焦がすほどの情熱',
  m_brain:       '夜更けに語った頭脳の輝き',
  m_sick:        '病弱さに宿った儚い美しさ',
  m_strong:      '気高く凛と立つ強さ',
  m_madonna:     '聖母のような慈しみの眼差し',
  m_mask:        '時に被ったあの偽りの仮面',
  m_dark:        '夜のように静かな佇まい',
  m_vet:         '学問に命を賭ける真剣な横顔',
  m_dance:       '舞踏室で流れるように踊った姿',
  m_multi:       'あらゆる才に恵まれた佳人ぶり',
  m_iron:        '誰にも揺るがされぬ鋼の決意',
  m_genius:      '常人離れした異端の閃き',
  m_diva:        '哀切に響くあの歌声',
  m_curse:       '触れた者を狂わせる魔性',
  m_perfect:     '神が彫ったような肉体',
  m_ideal:       '完璧そのものの姿',
  m_pure_master: '純血の傑作とでも呼ぶしかない造形',
  m_saint:       '静謐な聖女のような佇まい',
  m_omni:        'あらゆる学問に通じた万能さ',
  m_venus:       '永遠に色褪せない美',
  m_soul:        '何があっても消えない不滅の魂',
  m_unique:      '世にふたつとない、ただ一人の存在',
  m_god:         '神々しさすら宿す存在感',
};
