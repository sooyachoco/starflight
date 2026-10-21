// =====================================================================
// 잔향 신호 엔진 (모의) — 로그 → 감지 → 신호. 게임과 관측소가 함께 쓴다.
//
// 신호 형식 (실제 NXLog 집계가 같은 형식으로 들어오면 그대로 교체):
//   { t, game, kind, strength, state }
//     t        우주 시각 (일, 소수점은 하루 중 시각)
//     game     은하 id (nexon, maple, ...)
//     kind     spike 급증 | silence 정적 | decline 감소 | sync 동조
//     strength 평소 대비 배율 (sync는 동조한 은하 수)
//     state    start | end
// 모든 수치는 가상 데이터이며 실제 서비스 지표와 무관하다.
// =====================================================================
(function (root) {
  const ROSTER = [
    { id: 'nexon', ko: '넥슨닷컴', col: '#ffc861', daily: 2840000, hub: true },
    { id: 'maple', ko: '메이플스토리', col: '#ff9a3d', daily: 88780000 },
    { id: 'fc', ko: 'FC온라인', col: '#4fe08a', daily: 5310000 },
    { id: 'dnf', ko: '던전앤파이터', col: '#ff5a4e', daily: 10480000 },
    { id: 'mabi', ko: '마비노기', col: '#c49bff', daily: 3420000 },
    { id: 'els', ko: '엘소드', col: '#46d0ff', daily: 700000 },
    { id: 'heroes', ko: '마비노기 영웅전', col: '#b8c6dc', daily: 470000 },
  ];
  const GROWTH = 1.04;   // 하루마다 로그가 4%씩 늘어남
  const gb = (h, m, s) => { let d = Math.abs(h - m); d = Math.min(d, 24 - d); return Math.exp(-d * d / (2 * s * s)); };
  const diurnal = h => .3 + .7 * Math.min(1, .45 * gb(h, 12.5, 2.5) + gb(h, 21, 2.2));
  const DMEAN = (() => { let t = 0; for (let h = 0; h < 24; h += .1) t += diurnal(h); return t / 240; })();
  // 감지 임계값 (평소 대비 배율)
  const TH = { spikeOn: 1.6, spikeOff: 1.25, silenceOn: .25, silenceOff: .6, declineOn: .72, declineOff: .86, rise: 1.3 };
  const KIND_KO = { spike: '급증', silence: '정적', decline: '감소', sync: '동조' };

  function mulberry32(a) {
    return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  // 이상 현상 일정 (모의 로그의 '정답지'). 첫 열흘은 시연용으로 고정, 이후는 시드로 생성
  function buildPlan(seed, n) {
    const R = mulberry32(seed), plan = [
      { kind: 'spike', gis: [1], t0: 1.0, t1: 3.8, amp: 2.6 },          // 대규모 업데이트 → 메이플 급증
      { kind: 'silence', gis: [3], t0: 5.0, t1: 6.6, amp: .03 },        // 정기 점검 → 던파 정적
      { kind: 'sync', gis: [2, 4, 5], t0: 8.2, t1: 10, amp: 1.42 },      // 여러 게임 동시 상승
      { kind: 'decline', gis: [6], t0: 11, t1: 15, amp: .45 },          // 서서히 식어 감
    ];
    let t = 16;
    while (t < 400) {
      const r = R(), gi = 1 + Math.floor(R() * (n - 1));
      if (r < .45) plan.push({ kind: 'spike', gis: [gi], t0: t, t1: t + 2 + R() * 2, amp: 2 + R() * 1.2 });
      else if (r < .7) plan.push({ kind: 'silence', gis: [gi], t0: t, t1: t + 1.2 + R(), amp: .03 });
      else if (r < .85) {
        const gis = [gi, 1 + (gi % (n - 1)), 1 + ((gi + 2) % (n - 1))];
        plan.push({ kind: 'sync', gis, t0: t, t1: t + 1.5 + R(), amp: 1.42 });
      } else plan.push({ kind: 'decline', gis: [gi], t0: t, t1: t + 3 + R() * 2, amp: .45 + R() * .15 });
      t += 3 + R() * 3;
    }
    return plan;
  }
  const ramp = (t, t0, t1, w = .25) => Math.max(0, Math.min(1, (t - t0) / w, (t1 - t) / w));

  function create(opt = {}) {
    const games = (opt.games || ROSTER).map((g, i) => ({ id: g.id, ko: g.ko, daily: g.daily, hub: !!g.hub, i }));
    const n = games.length, plan = buildPlan(opt.seed || 20261021, n);
    const noiseSeed = games.map((_, i) => i * 7.13 + 1.7);
    const noise = (gi, t) => .06 * Math.sin(t * 9.1 + noiseSeed[gi]) + .04 * Math.sin(t * 23.7 + noiseSeed[gi] * 2);

    function mult(gi, t) {
      let m = 1;
      for (const p of plan) {
        if (t < p.t0 - .3 || t > p.t1 + .3 || !p.gis.includes(gi)) continue;
        m *= 1 + (p.amp - 1) * ramp(t, p.t0, p.t1);
      }
      return m;
    }
    const expected = (gi, t) => games[gi].daily * Math.pow(GROWTH, t) * diurnal((t % 1) * 24) / DMEAN;
    // 모의 로그: 은하별 유입량 (로그/일)
    const flow = (gi, t) => expected(gi, t) * mult(gi, t) * (1 + noise(gi, t));
    const total = t => { let s = 0; for (let i = 0; i < n; i++) s += flow(i, t); return s; };
    // 신의 힘: 지금 전체 유입 ÷ 하루 평균 유입 (밤엔 낮고 축제엔 높다)
    const power = t => { let a = 0, b = 0; for (let i = 0; i < n; i++) { a += flow(i, t); b += games[i].daily * Math.pow(GROWTH, t); } return a / b; };

    // ---------- 감지기: 계절성(하루 곡선)을 뺀 수준을 지수 평활하고 임계값으로 신호를 낸다 ----------
    const det = games.map(() => ({ lvl: 1, spike: null, silence: null, decline: null, lowT: 0 }));
    let sync = null, lastT = 0;
    const active = new Map();
    function emit(out, s) {
      out.push(s);
      const key = s.game + ':' + s.kind;
      if (s.state === 'start') active.set(key, s); else active.delete(key);
    }
    function step(t) {
      const out = [];
      if (t <= lastT) return out;
      const DT = .02, steps = Math.min(400, Math.ceil((t - lastT) / DT));
      for (let k = 1; k <= steps; k++) {
        const tt = lastT + (t - lastT) * k / steps, a = 1 - Math.exp(-((t - lastT) / steps) / .06);
        let rising = 0;
        for (let gi = 0; gi < n; gi++) {
          const d = det[gi], g = games[gi].id;
          d.lvl += (flow(gi, tt) / expected(gi, tt) - d.lvl) * a;
          const s = +d.lvl.toFixed(2);
          if (!d.spike && d.lvl > TH.spikeOn) emit(out, d.spike = { t: tt, game: g, kind: 'spike', strength: s, state: 'start' });
          else if (d.spike) { d.spike.strength = Math.max(d.spike.strength, s); if (d.lvl < TH.spikeOff) { emit(out, { t: tt, game: g, kind: 'spike', strength: d.spike.strength, state: 'end' }); d.spike = null; } }
          if (!d.silence && d.lvl < TH.silenceOn) emit(out, d.silence = { t: tt, game: g, kind: 'silence', strength: s, state: 'start' });
          else if (d.silence && d.lvl > TH.silenceOff) { emit(out, { t: tt, game: g, kind: 'silence', strength: d.silence.strength, state: 'end' }); d.silence = null; }
          // 감소: 정적까진 아니지만 하루 가까이 낮게 유지될 때
          d.lowT = d.lvl < TH.declineOn && d.lvl > TH.silenceOn ? d.lowT + (t - lastT) / steps : 0;
          if (!d.decline && d.lowT > .8) emit(out, d.decline = { t: tt, game: g, kind: 'decline', strength: s, state: 'start' });
          else if (d.decline && d.lvl > TH.declineOff) { emit(out, { t: tt, game: g, kind: 'decline', strength: d.decline.strength, state: 'end' }); d.decline = null; }
          if (!games[gi].hub && d.lvl > TH.rise) rising++;
        }
        // 동조: 허브를 뺀 은하 둘 이상이 동시에 오를 때
        if (!sync && rising >= 2) emit(out, sync = { t: tt, game: 'all', kind: 'sync', strength: rising, state: 'start' });
        else if (sync && rising < 2) { emit(out, { t: tt, game: 'all', kind: 'sync', strength: sync.strength, state: 'end' }); sync = null; }
        else if (sync) sync.strength = Math.max(sync.strength, rising);
      }
      lastT = t;
      return out;
    }
    const level = gi => det[gi].lvl;
    return { games, plan, flow, total, power, step, level, active, expected };
  }

  root.Echo = { ROSTER, create, diurnal, DMEAN, TH, KIND_KO };
})(window);
