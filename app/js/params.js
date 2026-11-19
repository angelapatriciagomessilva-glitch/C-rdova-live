// Parâmetros padrão do rig (inspirados nos parâmetros do Live2D).
export const PARAMS = [
  { id: 'AngleX',   name: 'Ângulo X (virar)',        min: -30, max: 30, def: 0 },
  { id: 'AngleY',   name: 'Ângulo Y (cima/baixo)',   min: -30, max: 30, def: 0 },
  { id: 'AngleZ',   name: 'Ângulo Z (inclinar)',     min: -30, max: 30, def: 0 },
  { id: 'EyeLOpen', name: 'Olho E aberto',           min: 0,   max: 1,  def: 1 },
  { id: 'EyeROpen', name: 'Olho D aberto',           min: 0,   max: 1,  def: 1 },
  { id: 'EyeBallX', name: 'Olhar X',                 min: -1,  max: 1,  def: 0 },
  { id: 'EyeBallY', name: 'Olhar Y',                 min: -1,  max: 1,  def: 0 },
  { id: 'BrowLY',   name: 'Sobrancelha E',           min: -1,  max: 1,  def: 0 },
  { id: 'BrowRY',   name: 'Sobrancelha D',           min: -1,  max: 1,  def: 0 },
  { id: 'MouthOpen',name: 'Boca aberta',             min: 0,   max: 1,  def: 0 },
  { id: 'MouthForm',name: 'Boca (triste ↔ sorriso)', min: -1,  max: 1,  def: 0 },
  { id: 'Cheek',    name: 'Bochecha corada',         min: 0,   max: 1,  def: 0 },
  { id: 'BodyX',    name: 'Corpo X',                 min: -10, max: 10, def: 0 },
  { id: 'Breath',   name: 'Respiração',              min: 0,   max: 1,  def: 0 },
  { id: 'HairSway', name: 'Balanço do cabelo',       min: -1,  max: 1,  def: 0 },
];
export const PARAM_MAP = Object.fromEntries(PARAMS.map(p => [p.id, p]));

// ── parâmetros personalizados ──────────────────────────────────────────────
// PARAMS e PARAM_MAP são alterados "no lugar" para que todos os módulos que os importaram
// enxerguem os parâmetros criados pelo usuário (marcados com custom: true).
const BASE_COUNT = PARAMS.length;
const BASE_IDS = new Set(PARAMS.map(p => p.id));

export const isValidParamId = id => /^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(id) && !BASE_IDS.has(id);

/** Substitui todos os parâmetros personalizados pela lista dada (valida e ignora entradas inválidas). */
export function setCustomParams(list = []) {
  PARAMS.length = BASE_COUNT;
  for (const k of Object.keys(PARAM_MAP)) if (!BASE_IDS.has(k)) delete PARAM_MAP[k];
  for (const c of list || []) {
    if (!c || !isValidParamId(String(c.id)) || PARAM_MAP[c.id]) continue;
    let min = Number.isFinite(+c.min) ? +c.min : 0, max = Number.isFinite(+c.max) ? +c.max : 1;
    if (max <= min) max = min + 1;
    const def = Math.min(max, Math.max(min, Number.isFinite(+c.def) ? +c.def : min));
    const p = { id: String(c.id), name: String(c.name || c.id), min, max, def, custom: true };
    PARAMS.push(p); PARAM_MAP[p.id] = p;
  }
}
export const getCustomParams = () => PARAMS.filter(p => p.custom).map(p => ({ id: p.id, name: p.name, min: p.min, max: p.max, def: p.def }));

/** Pacote "molengo": parâmetros prontos para amassar/esticar partes (ligue-os a bindings Compressão ↕ ou ao molengo). */
export const JELLY_PACK = [
  { id: 'Squash', name: 'Compressão (achatar ↔ esticar)', min: -1, max: 1, def: 0 },
  { id: 'Wobble', name: 'Molengo (intensidade 0–1)',       min: 0,  max: 1, def: 1 },
];

/** Pacote para formar a boca (visemas): o rastreio facial já alimenta estes ids quando existem. */
export const MOUTH_PACK = [
  { id: 'MouthU',    name: 'Boca “U” (bico)',          min: 0,  max: 1, def: 0 },
  { id: 'MouthO',    name: 'Boca “O” (redonda)',       min: 0,  max: 1, def: 0 },
  { id: 'MouthI',    name: 'Boca “I” (esticada)',      min: 0,  max: 1, def: 0 },
  { id: 'TongueOut', name: 'Língua para fora',         min: 0,  max: 1, def: 0 },
  { id: 'MouthX',    name: 'Boca para o lado (E↔D)',   min: -1, max: 1, def: 0 },
  { id: 'CheekPuff', name: 'Bochecha inflada',         min: 0,  max: 1, def: 0 },
];

// Propriedades que um binding pode controlar.
// kind 'add'  : soma os valores de todos os bindings (rot, x, y)
// kind 'mul'  : multiplica (sx, sy, op)
export const PROPS = [
  { id: 'rot', name: 'Rotação (°)',     kind: 'add' },
  { id: 'x',   name: 'Posição X (px)',  kind: 'add' },
  { id: 'y',   name: 'Posição Y (px)',  kind: 'add' },
  { id: 'sq',  name: 'Compressão ↕ (− achata / + estica)', kind: 'add' },
  { id: 'skx', name: 'Inclinar X (°)',  kind: 'add' },
  { id: 'sky', name: 'Inclinar Y (°)',  kind: 'add' },
  { id: 'sx',  name: 'Escala X (×)',    kind: 'mul' },
  { id: 'sy',  name: 'Escala Y (×)',    kind: 'mul' },
  { id: 'op',  name: 'Opacidade (0–1)', kind: 'mul' },
];
export const PROP_MAP = Object.fromEntries(PROPS.map(p => [p.id, p]));

// ── direção vertical ──────────────────────────────────────────────────────
// Convenção: nos parâmetros abaixo, valor POSITIVO = para CIMA (como no joystick de posar e no rastreio).
// Na tela, y cresce para BAIXO; então um binding de 'y' correto vai de + (valor mínimo) até − (valor máximo).
export const Y_UP = new Set(['AngleY', 'EyeBallY', 'BrowLY', 'BrowRY']);
/** O binding move a camada para BAIXO quando o parâmetro "sobe"? (invertido) */
export function isYInverted(b) {
  if (b.prop !== 'y' || !Y_UP.has(b.param)) return false;
  if (b.keys && b.keys.length >= 2) return b.keys[b.keys.length - 1].o > b.keys[0].o;
  return b.to > b.from;
}
/** Espelha o mapeamento em torno do centro do parâmetro (o neutro não muda). */
export function flipYBinding(b) {
  if (b.keys && b.keys.length >= 2) {
    const p = PARAM_MAP[b.param], lo = b.pmin ?? p?.min ?? -1, hi = b.pmax ?? p?.max ?? 1;
    b.keys = b.keys.map(k => ({ ...k, p: lo + hi - k.p })).sort((x, y) => x.p - y.p);
  } else { const t = b.from; b.from = b.to; b.to = t; }
}
