import React, { useState, useEffect, useRef, useMemo } from 'react';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip } from 'recharts';

/* ============================================================
   設定ファイル（本番はここをJSON/YAML差し替え。公開/非公開を分離）
   ============================================================ */
const PERSONA = {
  public: {
    name: '佐藤 みなと',
    university: '私立大学 経済学部（文系）',
    grade: '学部4年',
    industries: '人材 / IT / 広告 など幅広く',
    axis: '若いうちから成長できる環境・人の役に立つ実感',
  },
  private: {
    honne: '口では「成長」と言うが、実は安定も気にしている。親から「大手にしなさい」と言われており揺れやすい。詰められる環境は本当は怖い。',
    sasaru: ['具体的なキャリアパスの提示', '社員のリアルな失敗談・本音', '自分の言葉で語る誠実さ', '本人の意思決定を尊重する姿勢'],
    jirai: ['圧迫感のある詰め・急かし', 'テンプレ丸出しの対応', '返信の放置・遅さ', '他社を悪く言う過度な囲い込み', 'その場しのぎの嘘・話を盛る'],
    personality: '慎重派・共感重視。本音は出しにくいが、信頼すると一気に開く',
    decision: '周りの意見＋直感。最後は「この人たちと働きたいか」で決める',
    priority: '成長 ＞ 人・社風 ＞ 安定 ＞ 年収 ＞ 勤務地',
  },
  initialScore: 48,
};

const COMPANY = {
  self: {
    name: '株式会社ブライトキャリア',
    business: '人材紹介・採用支援（HR Tech）',
    scale: '従業員300名 / 設立15年 / 成長中のベンチャー',
    treat: '初任給28万 / 平均残業30h / リモート週2',
    culture: '若手裁量が大きくフラット、スピード感重視',
    flow: '説明会 → 一次面接 → 最終面接 → 内定',
  },
  rivals: [
    { name: 'メガ・ホールディングス', tag: '大手・安定', desc: '年収高・福利厚生充実だが年功序列で裁量は小さめ。親ウケ◎' },
    { name: 'スタートX', tag: '急成長スタートアップ', desc: '裁量最大・成長速いが激務で不安定。ハイリスク' },
  ],
};

const SCENARIOS = [
  { id: 1, label: '説明会後の初回接触', situation: '会社説明会に参加してくれた佐藤さん。熱心にメモを取っていた。翌日、あなたから最初のメッセージを送る場面。まだ志望度は高くない。' },
  { id: 2, label: '一次面接後のフォロー', situation: '一次面接を通過した佐藤さん。手応えはあったが、少し不安そうな様子も見せていた。合否連絡と今後のフォローを兼ねたメッセージ。' },
  { id: 3, label: '「他社から内定が出た」と連絡', situation: '佐藤さんから「実はメガ・ホールディングスさんから内定をいただきました。正直迷っています」と連絡が。最大の山場。' },
  { id: 4, label: '最終面接の案内', situation: '揺れる気持ちを抱えつつ、最終面接に進む意思を見せてくれた佐藤さん。最終面接の案内と、当日への動機づけを行う場面。' },
  { id: 5, label: '内定出し後のクロージング', situation: '最終面接を通過し、あなたの会社から内定を出した。承諾の返事はまだ。最後の意思決定を後押しするクロージングの場面。' },
];

const ACTIONS = ['面談を設定', '社員を紹介', 'オフィス見学', '食事に誘う', '資料を送付', '（メッセージのみ）'];
const THRESHOLD = 75;
const GREEN = '#06C755';

/* ============================================================
   1) 接続設定（Vercel + Gemini）
   ============================================================ */
const CFG = {
  endpoint: '/api/chat',
  model: 'gemini-2.5-flash',
  room: 'mochica0722',
};

/* ============================================================
   2) 共有ランキング（Vercel: /api/rank 経由 = KV保存・個人戦）
   ============================================================ */
function makePid(name) {
  let salt = '';
  try {
    salt = localStorage.getItem('rsg_salt') || '';
    if (!salt) { salt = Math.random().toString(36).slice(2, 8); localStorage.setItem('rsg_salt', salt); }
  } catch (_) { salt = 'nosalt'; }
  const s = `${name}|${salt}`;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const base = String(name).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  return (base + h.toString(36) + salt).replace(/[^a-z0-9]/g, '').slice(0, 20) || `p${h.toString(36)}`;
}
async function saveScore(pid, name, score) {
  try {
    const r = await fetch('/api/rank', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: CFG.room, pid, name, score, ok: score >= THRESHOLD }),
    });
    return r.ok;
  } catch (e) { return false; }
}
async function loadScores() {
  try {
    const r = await fetch('/api/rank?room=' + encodeURIComponent(CFG.room));
    if (!r.ok) return null; // KV未設定/障害 → 呼び出し側でフォールバック表示
    const d = await r.json();
    return Array.isArray(d.rows) ? d.rows : [];
  } catch (e) { return null; }
}
async function clearScores() {
  try {
    await fetch('/api/rank', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room: CFG.room, action: 'clear' }),
    });
  } catch (e) {}
}

const STAGES = [
  { emoji: '😨', label: '引いている', color: '#E5484D' },
  { emoji: '😕', label: '微妙', color: '#F57C00' },
  { emoji: '😐', label: 'ふつう', color: '#F5A623' },
  { emoji: '🙂', label: '好印象', color: '#7CB342' },
  { emoji: '😍', label: 'かなり好印象', color: GREEN },
];
function stageIndex(s) { return s >= 80 ? 4 : s >= 65 ? 3 : s >= 45 ? 2 : s >= 30 ? 1 : 0; }

/* ============================================================
   グローバルアニメーション定義
   ============================================================ */
const CSS = `
@keyframes gradientShift {0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}
@keyframes floatUp {0%{transform:translateY(20px) scale(1);opacity:0}10%{opacity:var(--o,.4)}90%{opacity:var(--o,.4)}100%{transform:translateY(-105vh) scale(1.15);opacity:0}}
@keyframes slideUp {from{transform:translateY(24px);opacity:0}to{transform:translateY(0);opacity:1}}
@keyframes slideInLeft {from{transform:translateX(-20px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes slideInRight {from{transform:translateX(20px);opacity:0}to{transform:translateX(0);opacity:1}}
@keyframes popIn {0%{transform:scale(.6);opacity:0}70%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
@keyframes popBig {0%{transform:scale(1)}35%{transform:scale(1.4) rotate(-6deg)}70%{transform:scale(.9) rotate(4deg)}100%{transform:scale(1) rotate(0)}}
@keyframes breathe {0%,100%{transform:scale(1)}50%{transform:scale(1.07)}}
@keyframes shake {0%,100%{transform:translateX(0)}20%{transform:translateX(-7px)}40%{transform:translateX(7px)}60%{transform:translateX(-4px)}80%{transform:translateX(4px)}}
@keyframes riseHeart {0%{transform:translate(0,0) scale(.4);opacity:0}15%{opacity:1}100%{transform:translate(var(--dx,0),-170px) scale(1.25);opacity:0}}
@keyframes confettiFall {0%{transform:translateY(-20px) rotate(0);opacity:1}100%{transform:translateY(104vh) rotate(720deg);opacity:.85}}
@keyframes shimmer {0%{background-position:-200% 0}100%{background-position:200% 0}}
@keyframes flashGlow {0%{opacity:0}30%{opacity:.85}100%{opacity:0}}
@keyframes fadeIn {from{opacity:0}to{opacity:1}}
@keyframes fly {0%{transform:translate(0,0) rotate(0);opacity:1}100%{transform:translate(46px,-46px) rotate(24deg);opacity:0}}
@keyframes ping2 {0%{transform:scale(.9);opacity:.7}100%{transform:scale(2.4);opacity:0}}
@keyframes wiggle {0%,100%{transform:rotate(0)}25%{transform:rotate(-9deg)}75%{transform:rotate(9deg)}}
@keyframes bounceIn {0%{transform:scale(0) translateY(20px);opacity:0}60%{transform:scale(1.18) translateY(-6px);opacity:1}100%{transform:scale(1) translateY(0)}}
@keyframes blink {0%,100%{opacity:1}50%{opacity:.35}}
@keyframes pulseSoft {0%,100%{transform:scale(1)}50%{transform:scale(1.13)}}
@keyframes dropFade {0%{transform:translateY(-10px);opacity:0}20%{opacity:1}100%{transform:translateY(90vh);opacity:0}}
.hover-lift{transition:transform .2s ease, box-shadow .2s ease}
.hover-lift:hover{transform:translateY(-3px);box-shadow:0 12px 24px rgba(0,0,0,.12)}
.press{transition:transform .12s ease}
.press:active{transform:scale(.95)}
`;

/* ---------- パーティクル ---------- */
function FloatingParticles({ emojis }) {
  const items = useMemo(() => Array.from({ length: 16 }, (_, i) => ({
    left: Math.random() * 100, size: 12 + Math.random() * 22, dur: 9 + Math.random() * 9,
    delay: Math.random() * 10, op: 0.2 + Math.random() * 0.35, e: emojis[i % emojis.length],
  })), [emojis]);
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none">
      {items.map((p, i) => (
        <div key={i} className="absolute" style={{ left: p.left + '%', bottom: -40, fontSize: p.size, animation: `floatUp ${p.dur}s linear ${p.delay}s infinite`, '--o': p.op }}>{p.e}</div>
      ))}
    </div>
  );
}

function Confetti() {
  const cols = ['#06C755', '#ffd700', '#ff6b9d', '#4dabf7', '#ffa94d', '#b197fc'];
  const pieces = useMemo(() => Array.from({ length: 80 }, (_, i) => ({
    left: Math.random() * 100, bg: cols[i % cols.length], w: 6 + Math.random() * 8, h: 9 + Math.random() * 10,
    dur: 2.4 + Math.random() * 2.4, delay: Math.random() * 0.9, radius: Math.random() > 0.5 ? '50%' : '2px',
  })), []);
  return (
    <div className="absolute inset-0 overflow-hidden pointer-events-none z-20">
      {pieces.map((p, i) => (
        <div key={i} className="absolute top-0" style={{ left: p.left + '%', width: p.w, height: p.h, background: p.bg, borderRadius: p.radius, animation: `confettiFall ${p.dur}s ease-in ${p.delay}s forwards` }} />
      ))}
    </div>
  );
}

function Reaction({ dir }) {
  const emoji = dir === 'up' ? '❤️' : dir === 'down' ? '💔' : '✨';
  const items = useMemo(() => Array.from({ length: 14 }, (_, i) => ({
    dx: (Math.random() - 0.5) * 180, size: 16 + Math.random() * 18, dur: 1.1 + Math.random() * 0.9,
    delay: Math.random() * 0.35, left: 40 + Math.random() * 20,
  })), []);
  return (
    <div className="absolute inset-x-0 pointer-events-none z-30" style={{ top: 90 }}>
      {items.map((p, i) => (
        <div key={i} className="absolute" style={{ left: p.left + '%', fontSize: p.size, animation: `riseHeart ${p.dur}s ease-out ${p.delay}s forwards`, '--dx': p.dx + 'px' }}>{emoji}</div>
      ))}
    </div>
  );
}

/* ---------- 円形タイマー ---------- */
function CircularTimer({ timeLeft, total = 180 }) {
  const r = 16, c = 2 * Math.PI * r;
  const off = c * (1 - timeLeft / total);
  const low = timeLeft <= 30;
  const color = timeLeft <= 15 ? '#E5484D' : low ? '#F5A623' : GREEN;
  const mm = Math.floor(timeLeft / 60), ss = String(timeLeft % 60).padStart(2, '0');
  return (
    <div className="relative" style={{ width: 42, height: 42, animation: low ? 'pulseSoft 1s ease-in-out infinite' : 'none' }}>
      <svg width={42} height={42}>
        <circle cx={21} cy={21} r={r} fill="none" stroke="#eee" strokeWidth={4} />
        <circle cx={21} cy={21} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} transform="rotate(-90 21 21)"
          style={{ transition: 'stroke-dashoffset 1s linear, stroke .3s' }} />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-xs font-bold" style={{ color }}>
        {timeLeft > 0 ? `${mm}:${ss}` : '0:00'}
      </div>
    </div>
  );
}

/* ---------- 温度感ゲージ ---------- */
function TemperatureGauge({ score, bump, dir, burstId }) {
  const idx = stageIndex(score);
  const st = STAGES[idx];
  return (
    <div className="relative px-4 py-3 bg-white border-b overflow-hidden" style={{ borderColor: '#eee' }}>
      {bump && (
        <div key={burstId} className="absolute inset-0 pointer-events-none" style={{
          background: dir === 'up' ? 'radial-gradient(circle at 22% 50%, rgba(6,199,85,.4), transparent 62%)'
            : dir === 'down' ? 'radial-gradient(circle at 22% 50%, rgba(229,72,77,.4), transparent 62%)' : 'transparent',
          animation: 'flashGlow 1s ease',
        }} />
      )}
      <div className="flex items-center justify-between mb-2 relative">
        <span className="text-xs font-bold" style={{ color: '#999' }}>学生の温度感</span>
        <span className="text-xs" style={{ color: '#ccc' }}>数値は結果発表で公開</span>
      </div>
      <div className="flex items-center gap-4 relative">
        <div className="relative shrink-0" style={{ width: 64, height: 64 }}>
          <div className="absolute inset-0 rounded-full transition-all duration-500" style={{ background: st.color, opacity: 0.14 }} />
          <div className="absolute inset-0 rounded-full transition-all duration-500" style={{ boxShadow: `0 0 20px 3px ${st.color}66` }} />
          <div className="w-full h-full flex items-center justify-center" style={{ fontSize: 40, animation: bump ? 'popBig .6s ease' : 'breathe 3.2s ease-in-out infinite' }}>{st.emoji}</div>
        </div>
        <div className="flex-1">
          <div className="text-lg font-bold mb-2 transition-colors duration-500" style={{ color: st.color }}>{st.label}</div>
          <div className="flex gap-1">
            {STAGES.map((s, i) => (
              <div key={i} className="flex-1 rounded-full overflow-hidden" style={{ height: 11, background: '#eee' }}>
                <div className="h-full rounded-full transition-all duration-700" style={{
                  width: i <= idx ? '100%' : '0%', background: st.color,
                  backgroundImage: i <= idx ? 'linear-gradient(90deg, rgba(255,255,255,.5), rgba(255,255,255,0), rgba(255,255,255,.5))' : 'none',
                  backgroundSize: '200% 100%', animation: i <= idx ? 'shimmer 2.2s linear infinite' : 'none',
                }} />
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-1 px-0.5">
            {STAGES.map((s, i) => (<span key={i} style={{ fontSize: 13, opacity: i === idx ? 1 : 0.3, filter: i === idx ? 'none' : 'grayscale(1)', transition: 'all .4s' }}>{s.emoji}</span>))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- チャット ---------- */
function ChatMessage({ m }) {
  if (m.type === 'divider') {
    return (
      <div className="flex justify-center my-3" style={{ animation: 'popIn .4s ease' }}>
        <span className="text-xs px-3 py-1 rounded-full" style={{ background: '#dfe6ea', color: '#5b6b73' }}>{m.text}</span>
      </div>
    );
  }
  if (m.type === 'player') {
    return (
      <div className="flex justify-end mb-3" style={{ animation: 'slideInRight .4s ease' }}>
        <div className="max-w-[78%]">
          {m.action && m.action !== '（メッセージのみ）' && (
            <div className="text-right mb-1">
              <span className="text-xs px-2 py-1 rounded-md inline-block" style={{ background: '#fff3cd', color: '#8a6d00', animation: 'popIn .4s ease' }}>🎬 {m.action}</span>
            </div>
          )}
          <div className="rounded-2xl rounded-tr-sm px-4 py-2 text-white text-[15px] leading-relaxed" style={{ background: GREEN, boxShadow: '0 4px 12px rgba(6,199,85,.25)' }}>{m.text}</div>
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start mb-3 items-end gap-2" style={{ animation: 'slideInLeft .4s ease' }}>
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg shrink-0" style={{ background: '#e8eef1' }}>🧑‍🎓</div>
      <div className="max-w-[78%] rounded-2xl rounded-tl-sm px-4 py-2 bg-white border text-[15px] leading-relaxed" style={{ borderColor: '#eee', color: '#333', boxShadow: '0 2px 8px rgba(0,0,0,.05)' }}>{m.text}</div>
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start mb-3 items-end gap-2" style={{ animation: 'slideInLeft .3s ease' }}>
      <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg shrink-0" style={{ background: '#e8eef1' }}>🧑‍🎓</div>
      <div className="rounded-2xl rounded-tl-sm px-4 py-3 bg-white border" style={{ borderColor: '#eee' }}>
        <div className="flex gap-1">{[0, 1, 2].map((i) => (<span key={i} className="w-2 h-2 rounded-full" style={{ background: '#bbb', animation: `pulseSoft .9s ease-in-out ${i * 0.15}s infinite` }} />))}</div>
      </div>
    </div>
  );
}

/* ---------- カウントアップ ---------- */
function useCountUp(target, duration, run) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (!run) { setV(target); return; }
    let start = null, raf;
    const step = (t) => { if (!start) start = t; const p = Math.min((t - start) / duration, 1); setV(Math.round(target * (1 - Math.pow(1 - p, 3)))); if (p < 1) raf = requestAnimationFrame(step); };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, run, duration]);
  return v;
}

function buildFallbackReply(msg, act, turnIndex, currentScore) {
  const scenario = SCENARIOS[turnIndex] || SCENARIOS[0];
  let delta = 2;

  if (act === '面談を設定' || act === '社員を紹介' || act === 'オフィス見学') delta += 4;
  if (act === '食事に誘う') delta += 3;
  if (act === '資料を送付') delta += 2;
  if (/不安|迷|悩|他社|内定|決め|最後/i.test(msg)) delta += 3;
  if (turnIndex >= 2) delta += 1;
  if (/急かし|圧迫|放置|テンプレ|嘘/i.test(msg)) delta -= 6;

  const deltaClamped = Math.max(-12, Math.min(14, delta));
  const reply = turnIndex < 2
    ? 'ありがとうございます。まだ少しだけ慎重ですが、今の話なら前向きに考えたい気持ちが伝わってきます。'
    : turnIndex === 2
      ? '少しだけ気持ちが動いた気がします。今の話は、こちらの真剣さが伝わってきました。'
      : '今の言い方なら、ちゃんと向き合ってくれている感じが伝わります。最後まで信頼してもらえそうです。';

  return {
    reply,
    delta: deltaClamped,
    reason: 'AIサービスの応答が取れなかったため、体験用の標準返信で続行します。',
    inner: 'まだ完全には決めきれないけれど、こちらの対応には少しだけ心が動いた。',
    ng: [],
  };
}

/* ============================================================
   メインアプリ
   ============================================================ */
export default function App() {
  const [screen, setScreen] = useState('opening');
  const [turn, setTurn] = useState(0);
  const [score, setScore] = useState(PERSONA.initialScore);
  const [messages, setMessages] = useState([]);
  const [history, setHistory] = useState([]);
  const [input, setInput] = useState('');
  const [action, setAction] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState(null);
  const [bump, setBump] = useState(false);
  const [dir, setDir] = useState('same');
  const [toast, setToast] = useState(null);
  const [burstId, setBurstId] = useState(0);
  const [flying, setFlying] = useState(false);
  const [timeLeft, setTimeLeft] = useState(180);
  const [playerName, setPlayerName] = useState('');
  const [rows, setRows] = useState(undefined);      // undefined=読込中 / null=共有不可 / []=データ
  const [rankLoading, setRankLoading] = useState(false);
  const [armClear, setArmClear] = useState(false);
  const savedRef = useRef(false);
  const chatEndRef = useRef(null);
  const isAdmin = typeof window !== 'undefined' && /[?&]admin=1/.test(window.location.search);

  const finalScore = history.length ? history[history.length - 1].scoreAfter : score;
  const counted = useCountUp(finalScore, 1400, screen === 'result');

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, loading]);
  useEffect(() => {
    if (screen !== 'play') return;
    setTimeLeft(180);
    const id = setInterval(() => setTimeLeft((t) => (t > 0 ? t - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [turn, screen]);

  // 結果画面に入ったら1回だけ共有ランキングへ保存（裏側で実行）
  useEffect(() => {
    if (screen !== 'result' || savedRef.current || history.length === 0) return;
    savedRef.current = true;
    const nm = (playerName || '').trim().slice(0, 12) || '名無し';
    saveScore(makePid(nm), nm, finalScore);
  }, [screen, history, playerName, finalScore]);

  // ランキング画面：取得＋10秒ごと自動更新
  useEffect(() => {
    if (screen !== 'ranking') return;
    let alive = true;
    const run = async () => {
      setRankLoading(true);
      const r = await loadScores();
      if (alive) { setRows(r); setRankLoading(false); }
    };
    run();
    const id = setInterval(run, 10000);
    return () => { alive = false; clearInterval(id); };
  }, [screen]);

  function reset() {
    setScreen('opening'); setTurn(0); setScore(PERSONA.initialScore); setMessages([]); setHistory([]);
    setInput(''); setAction(''); setLoading(false); setError(false); setPending(null); setToast(null);
    setRows(undefined); setArmClear(false); savedRef.current = false;
  }
  async function refreshRanking() {
    setRankLoading(true);
    const r = await loadScores();
    setRows(r); setRankLoading(false);
  }
  async function doClear() {
    setArmClear(false);
    await clearScores();
    refreshRanking();
  }
  function startGame() {
    setMessages([{ type: 'divider', text: `── ターン1 / ${SCENARIOS[0].label} ──` }]);
    setScreen('play');
  }

  async function callStudent(msg, act) {
    const p = PERSONA.public, pv = PERSONA.private, c = COMPANY, sc = SCENARIOS[turn];
    const historyText = messages.filter((m) => m.type !== 'divider').map((m) => `${m.type === 'player' ? '人事' : '学生'}: ${m.text}`).join('\n') || '（まだ会話なし）';
    const prompt = `あなたは新卒採用のコミュニケーション体験ゲームのAIエンジンです。下記の「学生ペルソナ」になりきり、人事担当者（プレイヤー）からのメッセージに1人の就活生として返信してください。同時に、そのメッセージが学生の志望度にどう影響したかを評価します。\n\n# 学生ペルソナ\n## 公開情報\n- 氏名: ${p.name}\n- 大学: ${p.university} / ${p.grade}\n- 志望業界: ${p.industries}\n- 就活の軸: ${p.axis}\n## 非公開の内面（あなただけが知る。口には出さない）\n- 本音: ${pv.honne}\n- 刺さるポイント: ${pv.sasaru.join(' / ')}\n- 地雷（やられると一気に冷める）: ${pv.jirai.join(' / ')}\n- 性格: ${pv.personality}\n- 意思決定: ${pv.decision}\n- 重視条件の優先度: ${pv.priority}\n\n# 企業情報\n## 自社（プレイヤーの会社）\n${c.self.name} / ${c.self.business} / ${c.self.scale} / ${c.self.treat} / 社風: ${c.self.culture} / 選考: ${c.self.flow}\n## 競合\n${c.rivals.map((r) => `${r.name}（${r.tag}）: ${r.desc}`).join('\n')}\n\n# 現在の状況\n- ターン ${sc.id}/5: ${sc.label}\n- ${sc.situation}\n- 現在の志望度: ${score}/100（内部値。絶対に会話で数値に言及しない）\n\n# これまでの会話\n${historyText}\n\n# プレイヤーの今回のアクション\n- 声かけ（メッセージ）: ${msg || '（なし）'}\n- とったアクション: ${act || '（メッセージのみ）'}\n\n# タスク\n1. 状況・会話・あなたの内面に一貫性を持たせ、就活生として自然に返信する\n   - LINEのメッセージのように口語で1〜3文。作り込みすぎない\n   - 刺さる対応には心を開き気味に、地雷を踏まれたら素っ気なく／戸惑い気味に反応する\n2. このプレイヤーの入力を評価し、志望度の変動値(delta)を決める\n   - 評価軸: ペルソナの軸との整合 / パーソナライズ度（テンプレ感） / タイミングの適切さ / NG行動（圧迫・放置・過度な囲い込み・嘘）の有無\n   - 素晴らしい: +8〜+20 / 良い: +3〜+8 / 可もなく不可もなく: -2〜+3 / 微妙: -8〜-2 / NG行動: -25〜-8\n\n# 出力\n下記JSONオブジェクトのみを出力し、前後に説明文やコードブロック記法（バッククォート）を一切付けないこと。\n{"reply":"学生の返信メッセージ","delta":整数,"reason":"スコアが動いた理由。プレイヤーへのフィードバック用に簡潔に（60字程度）","inner":"この瞬間の学生の本音（結果発表で開示。1文）","ng":["該当するNG行動。無ければ空配列"]}`;

    try {
      const res = await fetch(CFG.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CFG.model,
          max_tokens: 800,
          temperature: 0.3,
          json: true,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || data?.error) {
        return buildFallbackReply(msg, act, turn, score);
      }

      let text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s < 0 || e < 0) {
        return buildFallbackReply(msg, act, turn, score);
      }
      return JSON.parse(text.slice(s, e + 1));
    } catch {
      return buildFallbackReply(msg, act, turn, score);
    }
  }

  async function runTurn(msg, act) {
    setLoading(true); setError(false);
    try {
      const r = await callStudent(msg, act);
      const delta = Math.max(-30, Math.min(25, Math.round(r.delta || 0)));
      const newScore = Math.max(0, Math.min(100, score + delta));
      setMessages((m) => [...m, { type: 'student', text: r.reply }]);
      setScore(newScore);
      setHistory((h) => [...h, { label: SCENARIOS[turn].label, message: msg, action: act, delta, reason: r.reason, inner: r.inner, ng: r.ng || [], scoreAfter: newScore }]);
      const d = delta > 0 ? 'up' : delta < 0 ? 'down' : 'same';
      setDir(d); setToast(d); setBurstId((b) => b + 1); setBump(true);
      setTimeout(() => setBump(false), 900);
      setTimeout(() => setToast(null), 2000);
      const next = turn + 1;
      if (next >= SCENARIOS.length) { setTimeout(() => setScreen('result'), 1600); }
      else { setTimeout(() => { setTurn(next); setMessages((m) => [...m, { type: 'divider', text: `── ターン${next + 1} / ${SCENARIOS[next].label} ──` }]); }, 950); }
    } catch (e) { setError(true); } finally { setLoading(false); }
  }

  function handleSend() {
    const msg = input.trim();
    if (!msg || loading) return;
    const act = action;
    setMessages((m) => [...m, { type: 'player', text: msg, action: act }]);
    setPending({ msg, act }); setInput(''); setAction('');
    setFlying(true); setTimeout(() => setFlying(false), 400);
    runTurn(msg, act);
  }

  /* ---------------- 画面本体 ---------------- */
  let content = null;

  if (screen === 'opening') {
    content = (
      <div className="relative min-h-screen flex items-center justify-center p-6 overflow-hidden" style={{ background: 'linear-gradient(135deg,#0b3d2e,#06C755,#0b3d2e)', backgroundSize: '200% 200%', animation: 'gradientShift 12s ease infinite' }}>
        <FloatingParticles emojis={['💬', '❤️', '✨', '📱', '🎓']} />
        <div className="relative max-w-md w-full text-center">
          <div className="text-6xl mb-4" style={{ animation: 'bounceIn .8s ease' }}>💬</div>
          <h1 className="text-3xl font-bold text-white mb-2" style={{ animation: 'slideUp .6s ease' }}>採用コミュニケーション<br />シミュレーション</h1>
          <p className="text-white opacity-80 text-sm mb-8" style={{ animation: 'slideUp .6s ease .15s both' }}>AIが演じる就活生に声をかけ、内定承諾を勝ち取れ。<br />正解のない「学生への向き合い方」を体感するゲーム。</p>
          <div className="bg-white rounded-2xl p-5 text-left mb-6 shadow-2xl hover-lift" style={{ animation: 'slideUp .6s ease .3s both' }}>
            <div className="text-xs font-bold mb-1" style={{ color: '#888' }}>あなたの名前（ランキングに表示・12文字まで）</div>
            <input value={playerName} onChange={(e) => e.target.value.length <= 12 && setPlayerName(e.target.value)} placeholder="例：ふくい" className="w-full rounded-xl border px-3 py-3 text-base font-bold focus:outline-none mb-3" style={{ borderColor: '#ddd' }} />
            <div className="text-xs font-bold mb-1" style={{ color: '#888' }}>担当企業</div>
            <div className="text-base font-bold" style={{ color: GREEN }}>{COMPANY.self.name}</div>
          </div>
          <button onClick={() => playerName.trim() && setScreen('briefing')} disabled={!playerName.trim()} className="press w-full py-4 rounded-2xl text-white font-bold text-lg shadow-2xl" style={{ background: '#0b3d2e', opacity: playerName.trim() ? 1 : 0.45, animation: 'slideUp .6s ease .45s both' }}>作戦会議へ ▶</button>
        </div>
      </div>
    );
  } else if (screen === 'briefing') {
    content = (
      <div className="min-h-screen p-4 md:p-8" style={{ background: '#f0f2f5' }}>
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold mb-1" style={{ animation: 'slideUp .5s ease' }}>📋 作戦会議</h2>
          <p className="text-sm mb-6" style={{ color: '#777', animation: 'slideUp .5s ease .1s both' }}>ゲーム開始前に、攻略対象と自社・競合を頭に入れよう。</p>

          <div className="bg-white rounded-2xl p-5 mb-4 shadow-sm hover-lift" style={{ animation: 'slideUp .5s ease .15s both' }}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-full flex items-center justify-center text-2xl" style={{ background: '#e8eef1', animation: 'breathe 3.5s ease-in-out infinite' }}>🧑‍🎓</div>
              <div><div className="text-lg font-bold">{PERSONA.public.name}</div><div className="text-xs" style={{ color: '#888' }}>攻略対象の学生（公開プロフィール）</div></div>
            </div>
            <Row k="大学・学年" v={`${PERSONA.public.university} / ${PERSONA.public.grade}`} />
            <Row k="志望業界" v={PERSONA.public.industries} />
            <Row k="就活の軸" v={PERSONA.public.axis} />
            <p className="text-xs mt-3 p-2 rounded-lg" style={{ background: '#fff8e1', color: '#8a6d00' }}>⚠️ 本音・地雷・刺さるポイントは非公開。会話の反応から読み取ろう。</p>
          </div>

          <div className="bg-white rounded-2xl p-5 mb-4 shadow-sm hover-lift" style={{ animation: 'slideUp .5s ease .25s both' }}>
            <div className="text-xs font-bold mb-2" style={{ color: GREEN }}>■ あなたの会社</div>
            <div className="text-lg font-bold mb-2">{COMPANY.self.name}</div>
            <Row k="事業" v={COMPANY.self.business} /><Row k="規模" v={COMPANY.self.scale} /><Row k="待遇" v={COMPANY.self.treat} /><Row k="社風" v={COMPANY.self.culture} /><Row k="選考" v={COMPANY.self.flow} />
          </div>

          <div className="bg-white rounded-2xl p-5 mb-4 shadow-sm hover-lift" style={{ animation: 'slideUp .5s ease .35s both' }}>
            <div className="text-xs font-bold mb-3" style={{ color: '#d32f2f' }}>■ 競合他社</div>
            {COMPANY.rivals.map((r, i) => (
              <div key={i} className="mb-3 last:mb-0">
                <div className="font-bold text-sm">{r.name} <span className="text-xs font-normal px-2 py-0.5 rounded-full" style={{ background: '#fce4ec', color: '#c2185b' }}>{r.tag}</span></div>
                <div className="text-sm mt-1" style={{ color: '#555' }}>{r.desc}</div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl p-5 mb-6 shadow-sm" style={{ animation: 'slideUp .5s ease .45s both' }}>
            <div className="text-xs font-bold mb-2" style={{ color: '#555' }}>■ ルール</div>
            <ul className="text-sm space-y-1" style={{ color: '#555' }}>
              <li>・全5ターン。各ターンでチームで相談し、声かけ＋アクションを入力</li>
              <li>・学生の「温度感」を見ながら志望度を上げ、内定承諾を目指す</li>
              <li>・志望度スコアはプレイ中非公開（温度感のみ）。結果発表で全公開</li>
              <li>・承諾ライン{THRESHOLD}点到達＋クロージング成功で内定承諾</li>
            </ul>
          </div>
          <button onClick={startGame} className="press w-full py-4 rounded-2xl text-white font-bold text-lg shadow-lg" style={{ background: GREEN, animation: 'slideUp .5s ease .55s both' }}>ゲーム開始 ▶</button>
        </div>
      </div>
    );
  } else if (screen === 'play') {
    const sc = SCENARIOS[turn];
    content = (
      <div className="relative mx-auto flex flex-col" style={{ height: '90vh', maxWidth: 640, background: '#f0f2f5' }}>
        {toast && <Reaction key={burstId} dir={dir} />}
        <div className="shrink-0 bg-white border-b px-4 py-2 flex items-center justify-between" style={{ borderColor: '#eee' }}>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-lg" style={{ background: '#e8eef1' }}>🧑‍🎓</div>
            <div>
              <div className="font-bold text-sm leading-tight">{PERSONA.public.name}</div>
              <div className="text-xs flex items-center gap-1" style={{ color: GREEN }}>
                <span className="relative inline-flex w-2 h-2">
                  <span className="absolute inline-flex w-2 h-2 rounded-full" style={{ background: GREEN, animation: 'ping2 1.4s ease-out infinite' }} />
                  <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: GREEN }} />
                </span>オンライン
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right"><div className="text-xs" style={{ color: '#999' }}>ターン</div><div className="font-bold text-sm">{turn + 1} / 5</div></div>
            <CircularTimer timeLeft={timeLeft} />
          </div>
        </div>

        <div className="shrink-0 flex gap-1 px-4 py-2 bg-white">
          {SCENARIOS.map((_, i) => (
            <div key={i} className="flex-1 rounded-full transition-all duration-500" style={{ height: 4, background: i < turn ? GREEN : i === turn ? '#a5d6a7' : '#eee', animation: i === turn ? 'blink 1.4s ease-in-out infinite' : 'none' }} />
          ))}
        </div>

        <TemperatureGauge score={score} bump={bump} dir={dir} burstId={burstId} />

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {toast && (
            <div className="sticky top-0 z-10 flex justify-center mb-2">
              <span className="text-sm font-bold px-4 py-1.5 rounded-full shadow-lg text-white" style={{ background: toast === 'up' ? GREEN : toast === 'down' ? '#E5484D' : '#999', animation: 'bounceIn .5s ease' }}>
                {toast === 'up' ? '温度が上がった！▲' : toast === 'down' ? '温度が下がった… ▼' : 'ほぼ変わらず'}
              </span>
            </div>
          )}
          {messages.map((m, i) => <ChatMessage key={i} m={m} />)}
          {loading && <TypingBubble />}
          {error && (
            <div className="rounded-xl p-3 mb-3 text-sm" style={{ background: '#fdecea', color: '#c62828', animation: 'shake .5s ease' }}>
              ⚠️ AI応答に失敗しました。会場のネットワークをご確認ください。
              <button onClick={() => pending && runTurn(pending.msg, pending.act)} className="ml-2 underline font-bold">再送する</button>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="shrink-0 bg-white border-t px-4 pt-3 pb-4" style={{ borderColor: '#eee' }}>
          <div className="text-xs mb-2 p-2 rounded-lg" style={{ background: '#eef7f0', color: '#2e7d32' }}><span className="font-bold">状況：</span>{sc.situation}</div>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {ACTIONS.map((a) => (
              <button key={a} onClick={() => setAction(action === a ? '' : a)} className="press text-xs px-2.5 py-1 rounded-full border transition-all duration-200"
                style={action === a ? { background: GREEN, color: '#fff', borderColor: GREEN, boxShadow: '0 2px 10px rgba(6,199,85,.4)' } : { background: '#fff', color: '#666', borderColor: '#ddd' }}>{a}</button>
            ))}
          </div>
          <div className="flex gap-2 items-end">
            <textarea value={input} onChange={(e) => e.target.value.length <= 400 && setInput(e.target.value)} placeholder="学生への声かけを入力…（チームで相談して）" rows={2}
              className="flex-1 resize-none rounded-xl border px-3 py-2 text-[15px] focus:outline-none transition-shadow" style={{ borderColor: '#ddd' }} disabled={loading} />
            <button onClick={handleSend} disabled={!input.trim() || loading} className="press rounded-full w-12 h-12 shrink-0 flex items-center justify-center text-white text-xl overflow-hidden"
              style={{ background: !input.trim() || loading ? '#ccc' : GREEN, boxShadow: !input.trim() || loading ? 'none' : '0 4px 14px rgba(6,199,85,.45)' }}>
              <span style={{ display: 'inline-block', animation: flying ? 'fly .4s ease forwards' : 'none' }}>➤</span>
            </button>
          </div>
          <div className="text-right text-xs mt-1" style={{ color: '#bbb' }}>{input.length}/400</div>
        </div>
      </div>
    );
  } else if (screen === 'result') {
    const accepted = finalScore >= THRESHOLD;
    const traj = [{ name: '開始', score: PERSONA.initialScore }, ...history.map((h, i) => ({ name: `T${i + 1}`, score: h.scoreAfter }))];
    content = (
      <div className="relative min-h-screen p-4 md:p-8 overflow-hidden" style={{ background: '#f0f2f5' }}>
        {accepted && <Confetti />}
        <div className="relative max-w-2xl mx-auto">
          <div className="rounded-2xl p-6 text-center text-white mb-5 shadow-2xl" style={{ background: accepted ? 'linear-gradient(135deg,#0b3d2e,#06C755,#0b3d2e)' : 'linear-gradient(135deg,#5a1a1a,#c62828)', backgroundSize: '200% 200%', animation: `${accepted ? 'gradientShift 8s ease infinite,' : ''} bounceIn .7s ease` }}>
            <div className="text-6xl mb-2" style={{ display: 'inline-block', animation: accepted ? 'wiggle 1s ease infinite' : 'shake .6s ease' }}>{accepted ? '🎉' : '💔'}</div>
            <div className="text-2xl font-bold mb-1">{accepted ? '内定承諾！' : '辞退…'}</div>
            <div className="text-sm opacity-90 bg-black bg-opacity-20 rounded-lg p-3 mt-3 text-left" style={{ animation: 'slideUp .5s ease .4s both' }}>
              「{accepted ? '正直たくさん迷いましたが、最後まで私のことを一番考えてくれたのはブライトキャリアさんでした。お世話になります！' : '色々ありがとうございました。悩んだ末、別の会社に決めました。ごめんなさい。'}」
            </div>
          </div>

          <div className="bg-white rounded-2xl p-5 mb-5 shadow-sm" style={{ animation: 'slideUp .5s ease .2s both' }}>
            <div className="flex items-baseline justify-between mb-3">
              <div className="text-sm font-bold" style={{ color: '#555' }}>志望度スコアの推移（ここで初公開）</div>
              <div className="text-3xl font-bold" style={{ color: accepted ? GREEN : '#c62828' }}>{counted}<span className="text-sm">/100</span></div>
            </div>
            <div style={{ height: 200 }}>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={traj} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#eee" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 12 }} />
                  <Tooltip />
                  <ReferenceLine y={THRESHOLD} stroke="#f5a623" strokeDasharray="4 4" label={{ value: `承諾ライン ${THRESHOLD}`, fontSize: 11, fill: '#f5a623', position: 'insideTopRight' }} />
                  <Line type="monotone" dataKey="score" stroke={GREEN} strokeWidth={3} dot={{ r: 4, fill: GREEN }} animationDuration={1600} animationBegin={300} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white rounded-2xl p-5 mb-5 shadow-sm" style={{ animation: 'slideUp .5s ease .3s both' }}>
            <div className="text-sm font-bold mb-3" style={{ color: '#555' }}>各ターンのフィードバック</div>
            {history.map((h, i) => (
              <div key={i} className="mb-4 last:mb-0 pb-4 last:pb-0 border-b last:border-0" style={{ borderColor: '#f0f0f0', animation: `slideInLeft .5s ease ${0.4 + i * 0.12}s both` }}>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-bold px-2 py-0.5 rounded" style={{ background: '#eef2f5', color: '#555' }}>ターン{i + 1}｜{h.label}</span>
                  <span className="text-sm font-bold" style={{ color: h.delta > 0 ? GREEN : h.delta < 0 ? '#E5484D' : '#999' }}>{h.delta > 0 ? `+${h.delta}` : h.delta}</span>
                </div>
                <div className="text-sm mb-1"><span style={{ color: '#999' }}>あなた：</span>{h.message}{h.action && h.action !== '（メッセージのみ）' ? `（${h.action}）` : ''}</div>
                <div className="text-sm p-2 rounded-lg mb-1" style={{ background: '#f7f9fa', color: '#444' }}>💡 {h.reason}</div>
                <div className="text-sm italic" style={{ color: '#8e44ad' }}>🗨 本音：{h.inner}</div>
                {h.ng && h.ng.length > 0 && (<div className="text-xs mt-1" style={{ color: '#c62828' }}>⚠️ NG行動：{h.ng.join(' / ')}</div>)}
              </div>
            ))}
          </div>

          <div className="flex gap-3" style={{ animation: 'slideUp .5s ease .5s both' }}>
            <button onClick={() => setScreen('ranking')} className="press flex-1 py-4 rounded-2xl text-white font-bold shadow-lg" style={{ background: GREEN }}>全体ランキングへ 🏆</button>
            <button onClick={reset} className="press py-4 px-5 rounded-2xl font-bold border" style={{ color: '#666', borderColor: '#ddd', background: '#fff' }}>やり直す</button>
          </div>
        </div>
      </div>
    );
  } else if (screen === 'ranking') {
    const myName = (playerName || '').trim().slice(0, 12) || '名無し';
    const kvDown = rows === null;
    const list = Array.isArray(rows)
      ? [...rows]
          .map((r) => ({ name: String(r.name || '?').slice(0, 12), score: Math.max(0, Math.min(100, Math.round(Number(r.score) || 0))), ok: !!r.ok, at: r.at }))
          .sort((a, b) => (Number(b.ok) - Number(a.ok)) || (b.score - a.score) || ((a.at || 0) - (b.at || 0)))
      : kvDown
        ? [{ name: myName, score: finalScore, ok: finalScore >= THRESHOLD }]
        : [];
    content = (
      <div className="min-h-screen p-6 overflow-hidden" style={{ background: 'linear-gradient(135deg,#111,#2d2d2d,#111)', backgroundSize: '200% 200%', animation: 'gradientShift 14s ease infinite' }}>
        <div className="max-w-2xl mx-auto w-full py-8">
          <h2 className="text-3xl font-bold text-white text-center mb-1" style={{ animation: 'bounceIn .7s ease' }}>🏆 全体ランキング</h2>
          <p className="text-center text-sm mb-6" style={{ color: '#aaa', animation: 'fadeIn 1s ease .3s both' }}>内定承諾 → 志望度スコア順（10秒ごとに自動更新）</p>
          {kvDown && (
            <div className="rounded-2xl px-4 py-3 mb-4 text-sm" style={{ background: 'rgba(245,166,35,.15)', color: '#f5a623', border: '1px solid rgba(245,166,35,.4)' }}>
              ⚠️ 共有ランキングを利用できない環境です（KV未設定または一時的なエラー）。あなたの結果のみ表示しています。
            </div>
          )}
          {rows === undefined ? (
            <div className="text-center py-14 text-sm" style={{ color: '#888' }}>ランキングを読み込み中…</div>
          ) : list.length === 0 ? (
            <div className="text-center py-14 text-sm" style={{ color: '#888' }}>まだ記録がありません。最初の挑戦者になろう！</div>
          ) : (
            <div className="space-y-3">
              {list.map((t, i) => {
                const st = STAGES[stageIndex(t.score)];
                const you = t.name === myName;
                const win = i === 0;
                return (
                  <div key={i} className="relative rounded-2xl px-5 py-4 flex items-center gap-4 shadow-lg overflow-hidden hover-lift"
                    style={{ background: you ? 'linear-gradient(90deg,#0b3d2e,#06C755)' : '#fff', border: win ? '2px solid #ffd700' : 'none', animation: `slideInRight .5s ease ${Math.min(i, 8) * 0.12}s both` }}>
                    {win && <div className="absolute inset-0 pointer-events-none" style={{ background: 'linear-gradient(100deg, transparent 30%, rgba(255,215,0,.35) 50%, transparent 70%)', backgroundSize: '200% 100%', animation: 'shimmer 2.5s linear infinite' }} />}
                    <div className="relative text-2xl font-bold w-10 text-center" style={{ color: you ? '#fff' : win ? '#c9a400' : '#999' }}>
                      {win ? <span style={{ display: 'inline-block', animation: 'wiggle 1.2s ease infinite' }}>👑</span> : i + 1}
                    </div>
                    <div className="relative text-3xl" style={{ animation: win ? 'breathe 2.5s ease-in-out infinite' : 'none' }}>{st.emoji}</div>
                    <div className="relative flex-1">
                      <div className="font-bold text-lg" style={{ color: you ? '#fff' : '#333' }}>{t.name}{you ? '（あなた）' : ''}</div>
                      <div className="text-xs" style={{ color: you ? 'rgba(255,255,255,.8)' : '#999' }}>{st.label}</div>
                    </div>
                    <div className="relative text-right">
                      <div className="text-2xl font-bold" style={{ color: you ? '#fff' : '#333' }}>{t.score}</div>
                      <div className="text-xs font-bold" style={{ color: t.ok ? (you ? '#c8f7d4' : GREEN) : (you ? '#ffcdd2' : '#c62828') }}>{t.ok ? '✅ 承諾' : '❌ 辞退'}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="text-center mt-8" style={{ animation: 'fadeIn 1s ease .6s both' }}>
            <button onClick={reset} className="press py-3 px-8 rounded-2xl font-bold text-white" style={{ background: GREEN, boxShadow: '0 4px 16px rgba(6,199,85,.4)' }}>もう一度プレイ</button>
            <div className="mt-3">
              <button onClick={refreshRanking} className="text-xs underline" style={{ color: '#888' }}>{rankLoading ? '更新中…' : '手動で更新'}</button>
            </div>
            {isAdmin && (
              <div className="mt-6 text-xs">
                {armClear ? (
                  <span style={{ color: '#ff8a80' }}>
                    本当に全記録を消去しますか？
                    <button onClick={doClear} className="ml-2 underline font-bold">はい、消去する</button>
                    <button onClick={() => setArmClear(false)} className="ml-2 underline">やめる</button>
                  </span>
                ) : (
                  <button onClick={() => setArmClear(true)} className="underline" style={{ color: '#555' }}>（運営用）記録を全消去</button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <style>{CSS}</style>
      <div key={screen} className="screen-enter">{content}</div>
    </>
  );
}

function Row({ k, v }) {
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-20 shrink-0 font-bold" style={{ color: '#999' }}>{k}</span>
      <span style={{ color: '#444' }}>{v}</span>
    </div>
  );
}
