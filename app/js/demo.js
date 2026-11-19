import { createWarp } from './warp.js';
import { newAnimation, setKey } from './anim.js';

// Modelo demo desenhado por código (sem arquivos de imagem), já com rig completo.
const SKIN = '#ffe3d3', SKIN_SH = '#f3c3ae', HAIR = '#6f56e8', HAIR_DK = '#4a36b5',
  OUTFIT = '#ff7aa8', OUTFIT_DK = '#d9578a', INK = '#2b2140', IRIS = '#38b6ff';

function mk(x, y, w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.translate(-x, -y);              // desenhamos em coordenadas da tela do rig
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  draw(ctx);
  return { src: c.toDataURL('image/png'), x, y };
}

const B = (param, prop, from, to, pmin, pmax) => {
  const b = { param, prop, from, to };
  if (pmin !== undefined) { b.pmin = pmin; b.pmax = pmax; }
  return b;
};

/** Monta um keyform: f(u,v) → [dx,dy] para cada ponto da grade (u,v ∈ [0,1]). */
const keyOf = (w, v, f) => {
  const d = [];
  for (let j = 0; j <= w.rows; j++) for (let i = 0; i <= w.cols; i++) d.push(...(f ? f(i / w.cols, j / w.rows) : [0, 0]));
  return { v, d };
};

export async function buildDemo(rig) {
  rig.reset();
  rig.name = 'Demo Chibi'; rig.w = 800; rig.h = 1100;
  const add = (name, img, opts = {}) => rig.addLayer({ name, ...img, ...opts });

  // --- corpo (raiz) ---
  const body = await add('Corpo', mk(120, 760, 560, 340, c => {
    c.fillStyle = OUTFIT;
    c.beginPath(); c.moveTo(150, 1100); c.bezierCurveTo(150, 880, 230, 790, 340, 780);
    c.lineTo(460, 780); c.bezierCurveTo(570, 790, 650, 880, 650, 1100); c.closePath(); c.fill();
    c.fillStyle = OUTFIT_DK; c.beginPath(); c.moveTo(340, 780); c.lineTo(400, 860); c.lineTo(460, 780); c.closePath(); c.fill();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(400, 872, 14, 0, 7); c.fill();
  }), {
    pivot: [400, 1100],
    bindings: [B('BodyX', 'x', -10, 10), B('BodyX', 'rot', -1.5, 1.5)],
  });
  body.warp = createWarp(3, 3);          // respiração: ombros sobem e o pescoço/cabeça herdam o movimento
  body.warp.forms.push({ param: 'Breath', keys: [keyOf(body.warp, 0), keyOf(body.warp, 1, (u, v) => [(u - 0.5) * 6 * (1 - v), -9 * (1 - v)])] });

  const neck = await add('Pescoço', mk(365, 680, 70, 120, c => {
    c.fillStyle = SKIN_SH; c.fillRect(372, 690, 56, 100);
  }), { parent: body.id, pivot: [400, 790] });

  const head = await add('Cabeça', mk(240, 300, 320, 430, c => {
    c.fillStyle = SKIN; c.strokeStyle = SKIN_SH; c.lineWidth = 3;
    c.beginPath(); c.moveTo(262, 470); c.bezierCurveTo(262, 360, 338, 320, 400, 320);
    c.bezierCurveTo(462, 320, 538, 360, 538, 470); c.bezierCurveTo(538, 590, 470, 700, 400, 708);
    c.bezierCurveTo(330, 700, 262, 590, 262, 470); c.closePath(); c.fill(); c.stroke();
  }), {
    parent: neck.id, pivot: [400, 700],
    bindings: [B('AngleZ', 'rot', -14, 14), B('AngleX', 'x', -14, 14), B('AngleY', 'y', 10, -10),
      B('AngleY', 'rot', 0, 0)],
  });

  // --- cabelo de trás ---
  const hairBack = await add('Cabelo trás', mk(215, 240, 370, 680, c => {
    c.fillStyle = HAIR_DK;
    c.beginPath(); c.moveTo(225, 500); c.bezierCurveTo(225, 300, 320, 245, 400, 245);
    c.bezierCurveTo(480, 245, 575, 300, 575, 500); c.lineTo(590, 900);
    c.quadraticCurveTo(400, 930, 210, 900); c.closePath(); c.fill();
  }), {
    parent: head.id, pivot: [400, 400],
    bindings: [B('AngleX', 'x', 12, -12)],
  });
  // Warp: a ponta do cabelo balança (HairSway) e fica para trás ao virar a cabeça (AngleX)
  hairBack.warp = createWarp(3, 6);
  hairBack.warp.forms.push(
    { param: 'HairSway', keys: [-1, 0, 1].map(v => keyOf(hairBack.warp, v, (u, t) => [v * 46 * t * t, -Math.abs(v) * 10 * t * t])) },
    { param: 'AngleX', keys: [-30, 0, 30].map(v => keyOf(hairBack.warp, v, (u, t) => [(-v / 30) * 26 * t * t, 0])) },
  );
  // (move o cabelo de trás para antes do corpo na ordem de desenho)
  const hb = rig.layers.pop();
  rig.layers.unshift(hb);

  // --- bochechas ---
  for (const [n, cx] of [['Blush E', 318], ['Blush D', 482]]) {
    await add(n, mk(cx - 34, 585, 68, 36, c => {
      const g = c.createRadialGradient(cx, 603, 2, cx, 603, 32);
      g.addColorStop(0, 'rgba(255,110,140,0.75)'); g.addColorStop(1, 'rgba(255,110,140,0)');
      c.fillStyle = g; c.fillRect(cx - 34, 585, 68, 36);
    }), { parent: head.id, bindings: [B('Cheek', 'op', 0, 1), B('AngleX', 'x', -26, 26), B('AngleY', 'y', 14, -14)] });
  }

  // --- olhos ---
  const eyes = [['E', 328, 'EyeLOpen', 1], ['D', 472, 'EyeROpen', -1]];
  for (const [side, cx, openParam, sgn] of eyes) {
    const cy = 530;
    const sc = await add('Olho ' + side, mk(cx - 44, cy - 38, 88, 76, c => {
      c.fillStyle = '#fff'; c.strokeStyle = SKIN_SH; c.lineWidth = 3;
      c.beginPath(); c.ellipse(cx, cy, 40, 32, 0, 0, 7); c.fill(); c.stroke();
    }), {
      parent: head.id, pivot: [cx, cy],
      bindings: [B('AngleX', 'x', -26, 26), B('AngleY', 'y', 14, -14), B(openParam, 'sy', 0.06, 1)],
    });
    await add('Íris ' + side, mk(cx - 22, cy - 22, 44, 44, c => {
      const g = c.createRadialGradient(cx, cy - 6, 3, cx, cy, 22);
      g.addColorStop(0, '#9be0ff'); g.addColorStop(1, IRIS);
      c.fillStyle = g; c.beginPath(); c.arc(cx, cy, 21, 0, 7); c.fill();
      c.fillStyle = INK; c.beginPath(); c.arc(cx, cy, 10, 0, 7); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(cx - 7, cy - 8, 5, 0, 7); c.fill();
      c.beginPath(); c.arc(cx + 6, cy + 7, 2.5, 0, 7); c.fill();
    }), { parent: sc.id, bindings: [B('EyeBallX', 'x', -10, 10), B('EyeBallY', 'y', 7, -7)] });
    await add('Cílios ' + side, mk(cx - 50, cy - 46, 100, 40, c => {
      c.strokeStyle = INK; c.lineWidth = 7;
      c.beginPath(); c.moveTo(cx - 44, cy - 14); c.quadraticCurveTo(cx, cy - 46, cx + 44, cy - 14); c.stroke();
      c.lineWidth = 5; c.beginPath();
      const o = sgn * 0; c.moveTo(cx + sgn * 42 + o, cy - 14); c.lineTo(cx + sgn * 52, cy - 22); c.stroke();
    }), { parent: sc.id });
  }

  // --- sobrancelhas ---
  for (const [side, cx, param, s] of [['E', 328, 'BrowLY', 1], ['D', 472, 'BrowRY', -1]]) {
    await add('Sobrancelha ' + side, mk(cx - 40, 458, 80, 24, c => {
      c.strokeStyle = HAIR_DK; c.lineWidth = 7;
      c.beginPath(); c.moveTo(cx - 32, 474); c.quadraticCurveTo(cx, 460, cx + 32, 474); c.stroke();
    }), {
      parent: head.id, pivot: [cx, 470],
      bindings: [B('AngleX', 'x', -26, 26), B('AngleY', 'y', 14, -14),
        B(param, 'y', 12, -14), B(param, 'rot', 9 * s, -7 * s)],
    });
  }

  // --- nariz ---
  await add('Nariz', mk(386, 580, 28, 24, c => {
    c.strokeStyle = SKIN_SH; c.lineWidth = 4;
    c.beginPath(); c.moveTo(392, 590); c.quadraticCurveTo(400, 600, 408, 590); c.stroke();
  }), { parent: head.id, bindings: [B('AngleX', 'x', -34, 34), B('AngleY', 'y', 18, -18)] });

  // --- boca ---
  const mouthBind = [B('AngleX', 'x', -28, 28), B('AngleY', 'y', 16, -16)];
  await add('Boca fechada', mk(360, 625, 80, 40, c => {
    c.strokeStyle = INK; c.lineWidth = 5;
    c.beginPath(); c.moveTo(370, 640); c.quadraticCurveTo(400, 658, 430, 640); c.stroke();
  }), {
    parent: head.id, pivot: [400, 645],
    bindings: [...mouthBind, B('MouthForm', 'sx', 0.8, 1.25), B('MouthForm', 'y', 3, -4),
      B('MouthOpen', 'op', 1, 0, 0, 0.12)],
  });
  await add('Boca aberta', mk(360, 620, 80, 70, c => {
    c.fillStyle = '#7a1f3d'; c.strokeStyle = INK; c.lineWidth = 4;
    c.beginPath(); c.ellipse(400, 645, 28, 30, 0, 0, 7); c.fill(); c.stroke();
    c.fillStyle = '#ff7a96'; c.beginPath(); c.ellipse(400, 662, 18, 10, 0, 0, 7); c.fill();
  }), {
    parent: head.id, pivot: [400, 628],
    bindings: [...mouthBind, B('MouthOpen', 'sy', 0.05, 1), B('MouthOpen', 'op', 0, 1, 0.04, 0.14),
      B('MouthForm', 'sx', 0.85, 1.25)],
  });

  // --- franja ---
  const bangs = await add('Franja', mk(225, 262, 350, 400, c => {
    c.fillStyle = HAIR; c.strokeStyle = HAIR_DK; c.lineWidth = 3;
    c.beginPath(); c.moveTo(236, 500); c.bezierCurveTo(230, 330, 320, 268, 400, 268);
    c.bezierCurveTo(480, 268, 570, 330, 564, 500);
    c.lineTo(568, 640); c.quadraticCurveTo(548, 600, 540, 520);
    c.lineTo(520, 470); c.lineTo(488, 420); c.lineTo(455, 470); c.lineTo(420, 410);
    c.lineTo(385, 470); c.lineTo(345, 415); c.lineTo(312, 470); c.lineTo(280, 430);
    c.lineTo(262, 520); c.quadraticCurveTo(250, 600, 232, 640); c.closePath(); c.fill(); c.stroke();
  }), {
    parent: head.id, pivot: [400, 300],
    bindings: [B('AngleX', 'x', -20, 20), B('AngleY', 'y', 10, -10)],
  });
  bangs.warp = createWarp(4, 3);
  bangs.warp.forms.push({ param: 'HairSway', keys: [-1, 0, 1].map(v => keyOf(bangs.warp, v, (u, t) => [v * 16 * t, -Math.abs(v) * 4 * t])) });

  // --- animações de exemplo ---
  const idle = newAnimation('Idle (respirando e olhando)', 4, 30);
  const K = (p, arr, e) => arr.forEach(([t, v]) => setKey(idle, p, t, v, e));
  K('AngleX', [[0, -6], [2, 6], [4, -6]]);
  K('AngleZ', [[0, -3], [1, 3], [3, -3], [4, -3]]);
  K('AngleY', [[0, 2], [2, -3], [4, 2]]);
  K('EyeBallX', [[0, 0], [1, 0.7], [2.2, -0.5], [3.2, 0.2], [4, 0]], 'smooth');
  K('MouthForm', [[0, 0.1], [2, 0.6], [4, 0.1]]);
  for (const p of ['EyeLOpen', 'EyeROpen']) K(p, [[0, 1], [2.7, 1], [2.78, 0.05], [2.9, 1], [4, 1]], 'linear');
  const talk = newAnimation('Falando', 2, 30);
  [0, 0.7, 0.2, 0.9, 0.1, 0.6, 0, 0.8, 0.3, 0.05].forEach((v, i) => setKey(talk, 'MouthOpen', i * 0.2, v));
  setKey(talk, 'MouthOpen', 2, 0);
  [[0, 0], [0.6, 4], [1.3, -3], [2, 0]].forEach(([t, v]) => setKey(talk, 'AngleY', t, v));
  rig.animations = [idle, talk];
  rig.expressions = [
    { id: 'Ex1', name: 'Feliz', fade: 0.2, values: { MouthForm: 1, Cheek: 1, BrowLY: 0.5, BrowRY: 0.5 } },
    { id: 'Ex2', name: 'Surpresa', fade: 0.12, values: { MouthOpen: 0.9, BrowLY: 1, BrowRY: 1, EyeBallY: 0.2 } },
  ];

  return rig;
}
