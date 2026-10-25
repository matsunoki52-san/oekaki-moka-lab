// スンスン（カラーイラスト）から塗り絵台紙SVGを生成するワンオフスクリプト。
// 方式: 色クラス分類 → 連結成分 → パーツ化（potrace）＋ 境界線レイヤー生成。
// 既存の scripts/process_jpg_to_artworks.cjs のSVG形式に合わせる。
const fs = require('fs');
const path = require('path');
const jpeg = require('jpeg-js');
const { Potrace } = require('potrace');
const Bitmap = require('potrace/lib/types/Bitmap');

const SRC = '/home/hatch/workspace/user/media_library/image/8a/8a94665e52d1e7ced26b455a81a6c5040302f0918905beb97639483f7de151d0.jpg';
const OUT = path.resolve(__dirname, '../src/components/svgs/Anime_36_スンスン.svg');

// 内側の絵の範囲（白枠を除く）: 水色ピクセル分布から実測 rows 98-701, cols 38-711
const CROP = { x0: 38, y0: 98, x1: 711, y1: 701 };
const W = CROP.x1 - CROP.x0 + 1;
const H = CROP.y1 - CROP.y0 + 1;

// クラス: 0=BG(水色) 1=WHITE 2=BLUE 3=RED 4=DARK
const PALETTE = [
  [184, 221, 227],
  [252, 252, 252],
  [158, 177, 219],
  [206, 66, 42],
  [62, 62, 62],
];
const BG = 0, WHITE = 1, BLUE = 2, RED = 3, DARK = 4;

const raw = fs.readFileSync(SRC);
const { width: SW, data } = jpeg.decode(raw);

// 1. 色分類（最近傍パレット）
let cls = new Int16Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const si = ((y + CROP.y0) * SW + (x + CROP.x0)) * 4;
    const r = data[si], g = data[si + 1], b = data[si + 2];
    let best = 0, bd = Infinity;
    for (let c = 0; c < PALETTE.length; c++) {
      const dr = r - PALETTE[c][0], dg = g - PALETTE[c][1], db = b - PALETTE[c][2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = c; }
    }
    cls[y * W + x] = best;
  }
}

// 2. 多数決フィルタ 3x3 ×2（JPEGノイズ除去）
function majorityPass(src) {
  const dst = new Int16Array(src);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cnt = [0, 0, 0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) cnt[src[ny * W + nx]]++;
        }
      }
      let best = src[y * W + x];
      for (let c = 0; c < 5; c++) if (cnt[c] > cnt[best]) best = c;
      dst[y * W + x] = best;
    }
  }
  return dst;
}
cls = majorityPass(majorityPass(cls));

// 3. 連結成分解析（クラス別・4近傍）
function cca(classMap, target) {
  const visited = new Int32Array(W * H).fill(-1);
  const comps = [];
  const queue = new Int32Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (classMap[s] !== target || visited[s] !== -1) continue;
    const id = comps.length;
    let head = 0, tail = 0;
    queue[tail++] = s; visited[s] = id;
    let count = 0, minX = W, maxX = 0, minY = H, maxY = 0;
    while (head < tail) {
      const cur = queue[head++]; count++;
      const cx = cur % W, cy = (cur / W) | 0;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      const nb = [cx > 0 ? cur - 1 : -1, cx < W - 1 ? cur + 1 : -1, cy > 0 ? cur - W : -1, cy < H - 1 ? cur + W : -1];
      for (const n of nb) if (n !== -1 && classMap[n] === target && visited[n] === -1) { visited[n] = id; queue[tail++] = n; }
    }
    comps.push({ id, count, minX, maxX, minY, maxY });
  }
  return { visited, comps };
}

// 4. 白い文字（PUPPET SUNSUN）を背景へ: 上部バンド内の小さな白成分を除去
{
  const { visited, comps } = cca(cls, WHITE);
  for (const c of comps) {
    if (c.maxY < 150 && c.count < 4000) {
      for (let i = 0; i < W * H; i++) if (visited[i] === c.id) cls[i] = BG;
    }
  }
  cls = majorityPass(cls);
}

// 5. パーツ決定
const parts = [];       // {cls, compId, visited, count, label, isBg}
const darkFeature = new Uint8Array(W * H); // 線レイヤーに取り込む小さな濃色成分
function collect(target, minPart) {
  const { visited, comps } = cca(cls, target);
  const kept = [];
  for (const c of comps) {
    if (c.count >= minPart) kept.push({ cls: target, compId: c.id, visited, count: c.count });
    else if (target === DARK) {
      for (let i = 0; i < W * H; i++) if (visited[i] === c.id) darkFeature[i] = 1;
    }
  }
  return kept;
}
// bg は BG 全体を1パーツにする（穴は potrace の複合パスで表現）
parts.push({ cls: BG, whole: true, count: W * H, isBg: true });
for (const p of collect(WHITE, 150)) parts.push(p);
for (const p of collect(BLUE, 150)) parts.push(p);
for (const p of collect(RED, 150)) parts.push(p);
for (const p of collect(DARK, 400)) parts.push(p);

// パーツ用マスクを作り、1px 膨張（線の下に潜り込ませる）
function traceMask(mask, turdSize) {
  const bm = new Bitmap(W, H);
  bm.data.set(mask.map(v => (v ? 0 : 255)));
  const p = new Potrace({ optCurve: true, turdSize });
  p._luminanceData = bm; p._imageLoaded = true;
  const tag = p.getPathTag();
  const m = tag.match(/d="([^"]+)"/);
  return m ? m[1] : '';
}

const partPaths = [];
{
  let idx = 1;
  // bg 以外は面積降順
  const rest = parts.slice(1).sort((a, b) => b.count - a.count);
  const ordered = [parts[0], ...rest];
  for (const p of ordered) {
    const mask = new Uint8Array(W * H);
    if (p.whole) {
      for (let i = 0; i < W * H; i++) mask[i] = cls[i] === BG ? 1 : 0;
    } else {
      for (let i = 0; i < W * H; i++) if (p.visited[i] === p.compId) mask[i] = 1;
      // 1px膨張（他パーツ領域には広げない: 膨張先は「自分以外のクラス」全て可だが元マスク優先で上書きしない設計のため単純膨張）
      const dil = new Uint8Array(mask);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        if (x > 0) dil[y * W + x - 1] = 1;
        if (x < W - 1) dil[y * W + x + 1] = 1;
        if (y > 0) dil[(y - 1) * W + x] = 1;
        if (y < H - 1) dil[(y + 1) * W + x] = 1;
      }
      mask.set(dil);
    }
    const d = traceMask(mask, 4);
    if (!d) continue;
    if (p.isBg) partPaths.push({ id: 'bg', label: 'はいけい', isBg: true, d });
    else { partPaths.push({ id: `part-${idx}`, label: `パーツ ${idx}`, isBg: false, d }); idx++; }
  }
}

// 6. 線レイヤー: クラス境界（2回膨張）＋濃色の小成分（目・瞳など）
const lineMask = new Uint8Array(W * H);
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const c = cls[y * W + x];
    if ((x < W - 1 && cls[y * W + x + 1] !== c) || (y < H - 1 && cls[(y + 1) * W + x] !== c)) lineMask[y * W + x] = 1;
    if (darkFeature[y * W + x]) lineMask[y * W + x] = 1;
  }
}
for (let pass = 0; pass < 2; pass++) {
  const dil = new Uint8Array(lineMask);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!lineMask[y * W + x]) continue;
    if (x > 0) dil[y * W + x - 1] = 1;
    if (x < W - 1) dil[y * W + x + 1] = 1;
    if (y > 0) dil[(y - 1) * W + x] = 1;
    if (y < H - 1) dil[(y + 1) * W + x] = 1;
  }
  lineMask.set(dil);
}
const lineD = traceMask(lineMask, 30);

// 7. SVG出力（既存形式に合わせる）
const svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <title>スンスン</title>
  <g class="coloring-parts" fill="transparent" stroke="none">
${partPaths.map(p => `    <path id="${p.id}" data-part="${p.id}" data-label="${p.label}" class="coloring-part ${p.isBg ? 'coloring-part--bg' : ''}" d="${p.d}" fill="transparent" pointer-events="all" />`).join('\n')}
  </g>
  <g class="coloring-lines" pointer-events="none">
    <path d="${lineD}" fill="black" fill-rule="evenodd" stroke="none" />
  </g>
</svg>`;
fs.writeFileSync(OUT, svg);
console.log(`Wrote ${OUT}`);
console.log(`viewBox ${W}x${H}, parts: ${partPaths.length} (${partPaths.map(p => p.id).join(', ')}), lineD len ${lineD.length}`);
