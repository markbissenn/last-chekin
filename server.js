'use strict';
/*
 * «Последний чек-ин» — мультиплеерная браузерная игра-викторина на выживание.
 * Сервер без внешних библиотек: только встроенные модули Node.js.
 * Запуск: node server.js   (порт берётся из переменной PORT, по умолчанию 3000)
 *
 * Связь с браузерами: сервер шлёт состояние через Server-Sent Events (/events),
 * браузеры отправляют действия обычными POST-запросами (/api/...).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---------------------------------------------------------------
// НАСТРОЙКИ: можно менять числа
// ---------------------------------------------------------------
const CFG = {
  QUESTIONS: 8,          // вопросов в основной части
  INTRO: 13,             // длина вступительной катсцены
  Q_TIME: 20,            // секунд на вопрос
  REVEAL_TIME: 7,        // показ правильного ответа
  TRIAL_INTRO: 7,        // объяснение испытания
  TRIAL_TIME: 15,        // выбор в испытании (бокал, лифт, память)
  MATH_TIME: 25,         // испытание «Счёт»
  MATH_SOLO_NEED: 6,     // сколько примеров надо решить, если в подвале один
  MEMO_SHOW: 5,          // сколько секунд показывать символы в «Памяти»
  RESULT_TIME: 8,        // итоги испытания
  FINALE_INTRO: 10,      // объяснение финала
  FINALE_Q_TIME: 20,     // вопрос финала
  FINALE_REVEAL: 7,      // итоги вопроса финала
  MAX_FINALE: 8,         // максимум вопросов в финале
  EXIT: 10,              // на какой клетке выход
  KEYS_TO_REVIVE: 3,     // сколько ключей нужно призраку, чтобы воскреснуть
  MONEY: 1000,           // монет за правильный ответ (+ до 500 за скорость)
  MIN_PLAYERS: 2,
  MAX_PLAYERS: 12,
};
// Ускоренный режим для проверки: FAST=1 node server.js
const SPEED = process.env.FAST ? (Number(process.env.FAST) > 0 && Number(process.env.FAST) < 1 ? Number(process.env.FAST) : 0.08) : 1;
const sec = (s) => Math.max(300, Math.round(s * 1000 * SPEED));

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;

// ---------------------------------------------------------------
// Вопросы
// ---------------------------------------------------------------
function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  } catch (e) {
    console.error(`Не смог прочитать ${file}:`, e.message);
    return [];
  }
}
const QUESTIONS = loadJSON('questions.json').filter(
  (q) => q && q.text && Array.isArray(q.options) && q.options.length === 4
);
const FINALE = loadJSON('finale.json').filter(
  (q) => q && q.category && Array.isArray(q.items) && q.items.length === 4
);
console.log(`Вопросов: ${QUESTIONS.length}, вопросов финала: ${FINALE.length}`);

// ---------------------------------------------------------------
// Реплики хозяина отеля
// ---------------------------------------------------------------
const LINES = {
  intro: [
    'Добро пожаловать в отель «Последний чек-ин». Выезд отсюда не предусмотрен… почти.',
    'Ваши номера готовы. Правила простые: отвечайте правильно, и, возможно, увидите утро.',
    'Я портье этого отеля. Отвечайте честно, а то подвал у нас холодный.',
  ],
  reveal_all: [
    'Все ответили верно. Как скучно. Подвал сегодня отдыхает.',
    'Ни одной ошибки? Я впечатлён и немного разочарован.',
  ],
  reveal_some: [
    'Ошиблись? Прошу пройти в подвал. Там уютно. Почти.',
    'Неправильные ответы я записываю в книгу постояльцев. Красными чернилами.',
    'О, у нас гости для подвала. Обожаю этот момент.',
  ],
  death_many: [
    'Сразу несколько номеров освободилось. Горничная в ярости.',
    'Подвал сегодня сыт. Новые призраки, добро пожаловать.',
  ],
  death: [
    'Минус один постоялец. Номер освободился.',
    'Не волнуйтесь, призраки у нас тоже играют. Просто тише.',
    'Ох. Горничной будет работы.',
    'Выезд оформлен. Навсегда.',
  ],
  survive: [
    'Все выжили. Повезло. В следующий раз будет иначе.',
    'Хм. Живучие попались.',
  ],
  revive: ['Призрак нашёл ключи и вернулся в мир живых. Не привыкай.'],
  finale: [
    'Утро близко. Бегите к выходу. Только помните: призраки бегут тоже.',
  ],
  win: ['Кто-то всё-таки выехал из отеля. Остальных я жду в следующий раз.'],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const randInt = (n) => Math.floor(Math.random() * n);
function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// портреты гостей: файлы media/guest_1.webp … media/guest_15.webp
const AVATARS = Array.from({ length: 15 }, (_, i) => i + 1);
const COLORS = ['#e4572e', '#29a3a3', '#f2c14e', '#9b5de5', '#4cb944', '#f15bb5', '#3a86ff', '#ff8c42', '#00bbf9', '#c9b37e', '#ef476f', '#8ac926'];
const MEMO_POOL = ['🔑', '🕯️', '💀', '🪓', '🕷️', '🍷', '🎩', '🧳', '🛎️', '🚪', '🦴', '🧸', '⌛', '🗝️', '📜', '🪞'];

const TRIALS = {
  glass: {
    title: 'Отравленный бокал',
    rules: 'Перед вами три бокала. В одном яд. Выберите свой и выпейте.',
  },
  elevator: {
    title: 'Лифт',
    rules: 'Выберите этаж. На одном из этажей трос оборвётся. И если двое выбрали один этаж, лифт не выдержит обоих.',
  },
  math: {
    title: 'Счёт на выживание',
    rules: 'Решайте примеры как можно быстрее. Кто решит меньше всех, остаётся в подвале навсегда.',
  },
  memory: {
    title: 'Память',
    rules: 'Сейчас я покажу несколько символов. Запомните их порядок. Потом спрошу один.',
  },
};

// ---------------------------------------------------------------
// Комнаты и игроки
// ---------------------------------------------------------------
const rooms = new Map(); // code -> room
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

function newCode() {
  for (let tries = 0; tries < 1000; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_LETTERS[randInt(CODE_LETTERS.length)];
    if (!rooms.has(c)) return c;
  }
  throw new Error('no codes');
}
const token = () => crypto.randomBytes(12).toString('hex');
const shortId = () => crypto.randomBytes(4).toString('hex');

function makeRoom() {
  const room = {
    code: newCode(),
    hostId: null,
    players: new Map(), // secret id -> player
    clients: new Set(), // {pid, res}
    phase: 'lobby',
    pub: {},
    priv: {},
    deadline: null,
    round: 0,
    gameToken: 0,
    check: null,
    cancel: null,
    usedQ: new Set(),
    usedF: new Set(),
    lastTrial: null,
    lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name, spectator) {
  const used = new Set([...room.players.values()].map((p) => p.avatar));
  const free = AVATARS.filter((a) => !used.has(a));
  const idx = room.players.size;
  const p = {
    id: token(),
    pub: shortId(),
    name,
    avatar: spectator ? 'tv' : pick(free.length ? free : AVATARS),
    color: COLORS[idx % COLORS.length],
    spectator: !!spectator,
    alive: room.phase === 'lobby', // кто зашёл посреди игры, заселяется призраком
    money: 0,
    keys: 0,
    pos: 0,
    conns: 0,
    joinedAt: Date.now(),
  };
  room.players.set(p.id, p);
  if (!room.hostId && !p.spectator) room.hostId = p.id;
  return p;
}

const gamers = (room) => [...room.players.values()].filter((p) => !p.spectator);
const connectedGamers = (room) => gamers(room).filter((p) => p.conns > 0);
const byPub = (room, pub) => [...room.players.values()].find((p) => p.pub === pub);

function ensureHost(room) {
  const host = room.players.get(room.hostId);
  if (host && host.conns > 0) return;
  const next = connectedGamers(room)[0];
  if (next) room.hostId = next.id;
}

// ---------------------------------------------------------------
// Рассылка состояния
// ---------------------------------------------------------------
function acted(room, p) {
  const pr = room.priv;
  switch (room.phase) {
    case 'question':
      return pr.answers.has(p.id);
    case 'trial':
      if (room.pub.type === 'math') return false;
      return pr.picks.has(p.id);
    case 'finale_q':
      return pr.picks.has(p.id);
    default:
      return false;
  }
}

function view(room, me) {
  const players = [...room.players.values()].map((p) => ({
    id: p.pub,
    name: p.name,
    avatar: p.avatar,
    color: p.color,
    spectator: p.spectator,
    alive: p.alive,
    money: p.money,
    keys: p.keys,
    pos: p.pos,
    online: p.conns > 0,
    host: p.id === room.hostId,
    acted: acted(room, p),
  }));
  const data = { ...room.pub };
  const pr = room.priv;
  // Личные данные: только то, что можно видеть этому игроку
  if (room.phase === 'question') {
    const a = pr.answers.get(me.id);
    data.myChoice = a ? a.choice : null;
  } else if (room.phase === 'trial') {
    if (room.pub.type === 'math') {
      const prog = pr.prog.get(me.id);
      data.myProblem = prog ? pr.problems[prog.idx].text : null;
      data.myIdx = prog ? prog.idx : null;
      data.scores = Object.fromEntries(
        [...pr.prog.entries()].map(([id, v]) => [room.players.get(id).pub, v.score])
      );
    } else {
      data.myPick = pr.picks.has(me.id) ? pr.picks.get(me.id) : null;
    }
  } else if (room.phase === 'finale_q') {
    data.myPicks = pr.picks.has(me.id) ? pr.picks.get(me.id) : null;
  }
  return {
    now: Date.now(),
    code: room.code,
    me: me.pub,
    isHost: me.id === room.hostId,
    phase: room.phase,
    deadline: room.deadline,
    phaseAt: room.phaseAt || null,
    round: room.round,
    totalRounds: CFG.QUESTIONS,
    cfg: { exit: CFG.EXIT, keys: CFG.KEYS_TO_REVIVE, min: CFG.MIN_PLAYERS },
    players,
    data,
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  for (const c of room.clients) {
    const me = room.players.get(c.pid);
    if (!me) continue;
    try {
      c.res.write(`data: ${JSON.stringify(view(room, me))}\n\n`);
    } catch (e) {
      /* соединение уже закрыто */
    }
  }
}

// ---------------------------------------------------------------
// Фазы игры
// ---------------------------------------------------------------
function phase(room, tk, name, pub, priv, ms, doneFn) {
  return new Promise((resolve) => {
    if (room.gameToken !== tk) return resolve(false);
    room.phase = name;
    room.pub = pub || {};
    room.priv = priv || {};
    room.deadline = ms ? Date.now() + ms : null;
    room.phaseAt = Date.now();
    let finished = false;
    let timer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      room.check = null;
      room.cancel = null;
      resolve(room.gameToken === tk);
    };
    if (ms) timer = setTimeout(finish, ms);
    room.check = () => {
      if (room.gameToken !== tk) return finish();
      if (doneFn && doneFn()) setTimeout(finish, 700);
    };
    room.cancel = finish;
    broadcast(room);
    if (!ms && !doneFn) resolve(room.gameToken === tk); // фаза без таймера (итоги)
  });
}

function stopGame(room) {
  room.gameToken++;
  if (room.cancel) room.cancel();
}

function drawFrom(list, used) {
  let pool = list.map((_, i) => i).filter((i) => !used.has(i));
  if (!pool.length) {
    used.clear();
    pool = list.map((_, i) => i);
  }
  const i = pick(pool);
  used.add(i);
  return list[i];
}

async function runGame(room) {
  const tk = ++room.gameToken;
  for (const p of gamers(room)) {
    p.alive = true;
    p.money = 0;
    p.keys = 0;
    p.pos = 0;
  }
  room.round = 0;
  room.lastTrial = null;

  if (!(await phase(room, tk, 'intro', { line: pick(LINES.intro) }, {}, sec(CFG.INTRO)))) return;

  for (let r = 1; r <= CFG.QUESTIONS; r++) {
    room.round = r;
    const q = drawFrom(QUESTIONS, room.usedQ);
    const order = shuffle([0, 1, 2, 3]);
    const options = order.map((i) => q.options[i]);
    const correct = order.indexOf(q.answer || 0);
    const answers = new Map();
    const startedAt = Date.now();
    const qMs = sec(CFG.Q_TIME);
    const aliveAtStart = new Set(gamers(room).filter((p) => p.alive).map((p) => p.id));

    const ok = await phase(
      room, tk, 'question',
      { category: q.category || 'Вопрос', text: q.text, options },
      { answers, startedAt, qMs, n: options.length },
      qMs,
      () => connectedGamers(room).every((p) => answers.has(p.id))
    );
    if (!ok) return;

    const results = {};
    const revived = [];
    const condemned = [];
    for (const p of gamers(room)) {
      const a = answers.get(p.id);
      const right = !!a && a.choice === correct;
      let gain = 0;
      if (aliveAtStart.has(p.id)) {
        if (right) {
          const frac = Math.max(0, 1 - (a.t - startedAt) / qMs);
          gain = CFG.MONEY + Math.round((500 * frac) / 100) * 100;
          p.money += gain;
        } else {
          condemned.push(p);
        }
      } else if (right) {
        p.keys += 1;
        if (p.keys >= CFG.KEYS_TO_REVIVE) {
          p.alive = true;
          p.keys = 0;
          revived.push(p.pub);
        }
      }
      results[p.pub] = { choice: a ? a.choice : null, right, gain, ghost: !aliveAtStart.has(p.id) };
    }
    let line = condemned.length ? pick(LINES.reveal_some) : pick(LINES.reveal_all);
    if (revived.length) line = pick(LINES.revive);
    if (
      !(await phase(
        room, tk, 'reveal',
        { category: q.category || 'Вопрос', text: q.text, options, correct, results, revived, line },
        {}, sec(CFG.REVEAL_TIME)
      ))
    )
      return;

    if (condemned.length) {
      if (!(await runTrial(room, tk, condemned))) return;
    }
  }

  if (!(await runFinale(room, tk))) return;
}

async function runTrial(room, tk, condemned) {
  const types = Object.keys(TRIALS).filter((t) => t !== room.lastTrial);
  const type = pick(types);
  room.lastTrial = type;
  const info = TRIALS[type];
  const ids = condemned.map((p) => p.pub);
  const isCondemned = (id) => condemned.some((p) => p.id === id);
  const allPicked = (picks) => () =>
    condemned.filter((p) => p.conns > 0).every((p) => picks.has(p.id));

  if (
    !(await phase(room, tk, 'trial_intro',
      { type, title: info.title, rules: info.rules, condemned: ids },
      {}, sec(CFG.TRIAL_INTRO)))
  )
    return false;

  let dead = [];
  let extra = {};

  if (type === 'glass' || type === 'elevator') {
    const count = type === 'glass' ? 3 : Math.min(12, Math.max(4, condemned.length * 2 + 1));
    const bad = randInt(count);
    const picks = new Map();
    if (
      !(await phase(room, tk, 'trial',
        { type, title: info.title, count, condemned: ids },
        { picks, count, isCondemned },
        sec(CFG.TRIAL_TIME), allPicked(picks)))
    )
      return false;
    const tally = {};
    for (const v of picks.values()) tally[v] = (tally[v] || 0) + 1;
    dead = condemned.filter((p) => {
      if (!picks.has(p.id)) return true;
      const v = picks.get(p.id);
      if (v === bad) return true;
      return type === 'elevator' && tally[v] > 1;
    });
    extra = {
      count,
      bad,
      picks: Object.fromEntries([...picks.entries()].map(([id, v]) => [room.players.get(id).pub, v])),
    };
  } else if (type === 'math') {
    const problems = [];
    for (let i = 0; i < 80; i++) {
      const kind = randInt(3);
      let a, b, text, ans;
      if (kind === 0) {
        a = 10 + randInt(80); b = 2 + randInt(9); text = `${a} + ${b}`; ans = a + b;
      } else if (kind === 1) {
        a = 20 + randInt(80); b = 2 + randInt(9); text = `${a} − ${b}`; ans = a - b;
      } else {
        a = 2 + randInt(8); b = 2 + randInt(8); text = `${a} × ${b}`; ans = a * b;
      }
      problems.push({ text, ans });
    }
    const prog = new Map(condemned.map((p) => [p.id, { idx: 0, score: 0 }]));
    if (
      !(await phase(room, tk, 'trial',
        { type, title: info.title, condemned: ids, solo: condemned.length === 1, need: CFG.MATH_SOLO_NEED },
        { problems, prog, isCondemned },
        sec(CFG.MATH_TIME)))
    )
      return false;
    const scores = condemned.map((p) => prog.get(p.id).score);
    if (condemned.length === 1) {
      dead = scores[0] < CFG.MATH_SOLO_NEED ? condemned.slice() : [];
    } else {
      const min = Math.min(...scores);
      dead = condemned.filter((p) => prog.get(p.id).score === min);
    }
    extra = {
      solo: condemned.length === 1,
      need: CFG.MATH_SOLO_NEED,
      scores: Object.fromEntries(condemned.map((p) => [p.pub, prog.get(p.id).score])),
    };
  } else if (type === 'memory') {
    const seq = shuffle(MEMO_POOL).slice(0, 6);
    const pos = randInt(seq.length);
    const answer = seq[pos];
    const distract = shuffle(MEMO_POOL.filter((s) => s !== answer)).slice(0, 3);
    const options = shuffle([answer, ...distract]);
    if (
      !(await phase(room, tk, 'trial_memo',
        { type, title: info.title, seq, condemned: ids }, {}, sec(CFG.MEMO_SHOW)))
    )
      return false;
    const picks = new Map();
    if (
      !(await phase(room, tk, 'trial',
        { type, title: info.title, position: pos + 1, options, condemned: ids },
        { picks, count: options.length, isCondemned },
        sec(CFG.TRIAL_TIME), allPicked(picks)))
    )
      return false;
    const ansIdx = options.indexOf(answer);
    dead = condemned.filter((p) => picks.get(p.id) !== ansIdx);
    extra = {
      seq,
      position: pos + 1,
      options,
      answerIdx: ansIdx,
      picks: Object.fromEntries([...picks.entries()].map(([id, v]) => [room.players.get(id).pub, v])),
    };
  }

  for (const p of dead) p.alive = false;
  return phase(room, tk, 'trial_result',
    {
      type, title: info.title, condemned: ids, dead: dead.map((p) => p.pub),
      line: dead.length > 1 ? pick(LINES.death_many) : dead.length ? pick(LINES.death) : pick(LINES.survive),
      ...extra,
    },
    {}, sec(CFG.RESULT_TIME));
}

async function runFinale(room, tk) {
  const players = gamers(room);
  const alive = players.filter((p) => p.alive);
  for (const p of players) p.pos = p.alive ? 3 : 0;
  if (alive.length) {
    const richest = alive.reduce((a, b) => (b.money > a.money ? b : a));
    richest.pos += 1;
  }
  room.round = 0;
  if (
    !(await phase(room, tk, 'finale_intro',
      { exit: CFG.EXIT, line: pick(LINES.finale) }, {}, sec(CFG.FINALE_INTRO)))
  )
    return false;

  for (let i = 0; i < CFG.MAX_FINALE; i++) {
    room.round = i + 1;
    const fq = drawFrom(FINALE, room.usedF);
    const items = shuffle(fq.items);
    const picks = new Map();
    if (
      !(await phase(room, tk, 'finale_q',
        { category: fq.category, items: items.map((it) => it.label), exit: CFG.EXIT, num: i + 1, max: CFG.MAX_FINALE },
        { picks, n: items.length },
        sec(CFG.FINALE_Q_TIME),
        () => connectedGamers(room).every((p) => picks.has(p.id))))
    )
      return false;
    const moves = {};
    for (const p of gamers(room)) {
      const sel = picks.get(p.id) || [];
      let d = 0;
      for (const k of sel) d += items[k].ok ? 1 : -1;
      d = Math.max(0, d);
      p.pos = Math.min(CFG.EXIT, p.pos + d);
      moves[p.pub] = { picks: sel, delta: d };
    }
    const done = gamers(room).some((p) => p.pos >= CFG.EXIT);
    if (
      !(await phase(room, tk, 'finale_reveal',
        { category: fq.category, items: items.map((it) => ({ label: it.label, ok: !!it.ok })), moves, exit: CFG.EXIT, num: i + 1, max: CFG.MAX_FINALE },
        {}, sec(CFG.FINALE_REVEAL)))
    )
      return false;
    if (done) break;
  }

  const ranking = gamers(room)
    .slice()
    .sort((a, b) => b.pos - a.pos || b.money - a.money)
    .map((p) => p.pub);
  room.round = 0;
  await phase(room, tk, 'gameover', { ranking, winner: ranking[0], line: pick(LINES.win) }, {}, 0);
  return true;
}

// ---------------------------------------------------------------
// Действия игроков
// ---------------------------------------------------------------
function handleAction(room, p, body) {
  const t = body.type;
  const pr = room.priv;

  if (t === 'start') {
    if (p.id !== room.hostId) return 'Начать может только хозяин комнаты';
    if (room.phase !== 'lobby') return 'Игра уже идёт';
    if (connectedGamers(room).length < CFG.MIN_PLAYERS) return `Нужно минимум ${CFG.MIN_PLAYERS} игрока`;
    runGame(room).catch((e) => console.error('Ошибка игры', e));
    return null;
  }
  if (t === 'restart') {
    if (p.id !== room.hostId) return 'Только хозяин комнаты';
    stopGame(room);
    room.phase = 'lobby';
    room.pub = {};
    room.priv = {};
    room.deadline = null;
    room.round = 0;
    for (const g of gamers(room)) {
      g.alive = true; g.money = 0; g.keys = 0; g.pos = 0;
    }
    // убираем тех, кто ушёл совсем
    for (const [id, g] of room.players) if (g.conns === 0 && id !== room.hostId) room.players.delete(id);
    broadcast(room);
    return null;
  }
  if (t === 'leave') {
    room.players.delete(p.id);
    for (const c of [...room.clients]) if (c.pid === p.id) { try { c.res.end(); } catch (e) {} room.clients.delete(c); }
    if (room.hostId === p.id) { room.hostId = null; ensureHost(room); }
    broadcast(room);
    return null;
  }
  if (p.spectator) return 'Зрители не играют';

  if (t === 'answer' && room.phase === 'question') {
    const c = Number(body.choice);
    if (!Number.isInteger(c) || c < 0 || c >= pr.n) return 'Неверный выбор';
    if (pr.answers.has(p.id)) return 'Ответ уже принят';
    pr.answers.set(p.id, { choice: c, t: Date.now() });
  } else if (t === 'pick' && room.phase === 'trial' && room.pub.type !== 'math') {
    if (!pr.isCondemned(p.id)) return 'Ты не в подвале';
    const v = Number(body.value);
    if (!Number.isInteger(v) || v < 0 || v >= pr.count) return 'Неверный выбор';
    if (pr.picks.has(p.id)) return 'Выбор уже сделан';
    pr.picks.set(p.id, v);
  } else if (t === 'math' && room.phase === 'trial' && room.pub.type === 'math') {
    const prog = pr.prog.get(p.id);
    if (!prog) return 'Ты не в подвале';
    if (Number(body.idx) !== prog.idx) return null; // устаревший ответ, тихо игнорируем
    const right = Number(String(body.answer).trim()) === pr.problems[prog.idx].ans;
    if (right) prog.score += 1;
    prog.idx = Math.min(prog.idx + 1, pr.problems.length - 1);
    broadcast(room);
    return right ? null : 'wrong';
  } else if (t === 'finale' && room.phase === 'finale_q') {
    if (pr.picks.has(p.id)) return 'Ответ уже принят';
    const sel = Array.isArray(body.picks) ? body.picks.map(Number) : [];
    const uniq = [...new Set(sel)].filter((k) => Number.isInteger(k) && k >= 0 && k < pr.n);
    pr.picks.set(p.id, uniq);
  } else {
    return 'Сейчас это действие недоступно';
  }
  broadcast(room);
  if (room.check) room.check();
  return null;
}

// ---------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (ch) => {
      data += ch;
      if (data.length > 10000) req.destroy();
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); }
    });
  });
}
function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const MEDIA_TYPES = { '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };
// Отдаёт файл с кэшированием и поддержкой перемотки видео (Range)
function sendFile(req, res, file, type) {
  const size = fs.statSync(file).size;
  const headers = { 'Content-Type': type, 'Cache-Control': 'public, max-age=604800', 'Accept-Ranges': 'bytes' };
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return fs.createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': size });
  fs.createReadStream(file).pipe(res);
}
function cleanName(s) {
  return String(s || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 16);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = fs.readFileSync(path.join(ROOT, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return res.end(html);
    }
    if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
      const name = path.basename(decodeURIComponent(url.pathname));
      const type = MEDIA_TYPES[path.extname(name).toLowerCase()];
      const file = path.join(ROOT, 'media', name);
      if (!type || !fs.existsSync(file)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found');
      }
      return sendFile(req, res, file, type);
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJSON(res, 200, { ok: true, rooms: rooms.size });
    }

    if (req.method === 'GET' && url.pathname === '/events') {
      const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
      const p = room && room.players.get(url.searchParams.get('pid'));
      if (!room || !p) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('gone');
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 2000\n\n');
      const client = { pid: p.id, res };
      room.clients.add(client);
      p.conns += 1;
      ensureHost(room);
      broadcast(room);
      req.on('close', () => {
        room.clients.delete(client);
        p.conns = Math.max(0, p.conns - 1);
        setTimeout(() => {
          if (!rooms.has(room.code)) return;
          ensureHost(room);
          broadcast(room);
          if (room.check) room.check();
        }, 1500);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const body = await readBody(req);
      const what = url.pathname.slice(5);

      if (what === 'create') {
        const name = cleanName(body.name);
        if (!name) return sendJSON(res, 400, { error: 'Введите имя' });
        const room = makeRoom();
        const p = addPlayer(room, name, false);
        return sendJSON(res, 200, { room: room.code, pid: p.id });
      }
      const room = rooms.get(String(body.room || '').toUpperCase().trim());
      if (!room) return sendJSON(res, 404, { error: 'Комната не найдена. Проверьте код.' });

      if (what === 'join') {
        const name = cleanName(body.name);
        if (!name) return sendJSON(res, 400, { error: 'Введите имя' });
        if (!body.spectator && gamers(room).length >= CFG.MAX_PLAYERS)
          return sendJSON(res, 400, { error: 'Комната заполнена' });
        const taken = [...room.players.values()].some((x) => x.name.toLowerCase() === name.toLowerCase());
        if (taken) return sendJSON(res, 400, { error: 'Это имя уже занято в комнате' });
        const p = addPlayer(room, name, !!body.spectator);
        broadcast(room);
        return sendJSON(res, 200, { room: room.code, pid: p.id });
      }
      const p = room.players.get(body.pid);
      if (!p) return sendJSON(res, 404, { error: 'Вы больше не в этой комнате' });
      if (what === 'rejoin') return sendJSON(res, 200, { room: room.code, pid: p.id });
      if (what === 'action') {
        const err = handleAction(room, p, body);
        return sendJSON(res, 200, err ? { error: err } : { ok: true });
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  } catch (e) {
    console.error(e);
    try { sendJSON(res, 500, { error: 'Ошибка сервера' }); } catch (_) {}
  }
});

// Пинг, чтобы соединения не обрывались, и уборка старых комнат
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const c of room.clients) {
      try { c.res.write(': ping\n\n'); } catch (e) {}
    }
    if (room.clients.size === 0 && now - room.lastActive > 60 * 60 * 1000) {
      stopGame(room);
      rooms.delete(room.code);
    }
  }
}, 20000);

server.listen(PORT, () => {
  console.log(`«Последний чек-ин» работает: http://localhost:${PORT}`);
});
