'use strict';

/* ============================================================
   状態
   ============================================================ */
const state = {
  sourceImg: null,
  handImg: null,
  handTip: { x: 0.5, y: 0.9 },
  handCalibStep: 0,
  handReady: false,

  strokes: [],
  totalLength: 0,
  fillEnabled: false,
  fillShapes: [],
  sourceAlphaCanvas: null,
  hasTransparency: false,
  penPos: null,

  lineCanvas: null,
  lineCtx: null,
  fillCanvas: null,
  fillCtx: null,
  bakedStrokeIndex: 0,
  bakedFillIndex: 0,

  isPlaying: false,
  playStartTs: null,
  playedMs: 0,
  duration: 14000,
  rafId: null,
  onComplete: null,

  recorder: null,
  recordedChunks: [],
  webmBlob: null,
};

const FILL_SHAPE_FADE_MS = 260; // 1つの塗り図形がふわっと現れるのにかかる時間
const REVEAL_MAX_ALPHA = 0.6; // 完成図は「塗り終わり」と「元画像そのまま」の間、元画像寄りにする

// 「描画時間」スライダーは合計時間として扱う(線画・塗り・リビールの内訳に配分する)。
// 図形数で塗り時間が伸び縮みすると、ユーザーが指定した秒数を大きく超えてしまうため、
// 常に合計が指定秒数に収まるよう比率で配分する。
function computeTimeline() {
  const totalMs = Math.max(2000, state.duration || 0);
  const revealMs = Math.min(1200, Math.max(400, Math.round(totalMs * 0.08)));
  const fillMs = (state.fillEnabled && state.fillShapes.length > 0) ? Math.round(totalMs * 0.28) : 0;
  const lineMs = Math.max(800, totalMs - fillMs - revealMs);
  return { lineMs, fillMs, revealMs };
}

const DETAIL_PRESETS = {
  simple:   { ltres: 1,   qtres: 1,   pathomit: 25, numberofcolors: 5,  blurradius: 2, blurdelta: 20 },
  normal:   { ltres: 1,   qtres: 1,   pathomit: 10, numberofcolors: 8,  blurradius: 1, blurdelta: 20 },
  detailed: { ltres: 0.5, qtres: 0.5, pathomit: 4,  numberofcolors: 14, blurradius: 0, blurdelta: 20 },
};

/* ============================================================
   DOM参照
   ============================================================ */
const els = {};
[
  'sourceDropArea','sourceImageInput','sourceThumb','sourcePlaceholder',
  'handDropArea','handImageInput','handThumb','handPlaceholder',
  'handCalibWrap','handCalibCanvas','handCalibStatus','handCalibResetBtn',
  'stylePresetSelect','detailSelect','colorModeSelect','penColorField','penColorInput',
  'fillCheckbox','lineWidthRange','lineWidthOut','handSizeRange','handSizeOut',
  'durationRange','durationOut','bgColorInput',
  'traceBtn','traceStatus',
  'previewCanvas','playBtn','pauseBtn','restartBtn','progressFill',
  'recordBtn','downloadWebmBtn','convertMp4Btn','exportStatus',
  'geomSvg',
].forEach(id => { els[id] = document.getElementById(id); });

/* ============================================================
   ユーティリティ
   ============================================================ */
function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error('ファイルの読み込みに失敗しました'));
    reader.readAsDataURL(file);
  });
}

function setupDropArea(dropArea, input, onFile) {
  dropArea.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) onFile(input.files[0]); });
  ['dragover'].forEach(evt => dropArea.addEventListener(evt, e => {
    e.preventDefault(); dropArea.classList.add('dragover');
  }));
  ['dragleave', 'drop'].forEach(evt => dropArea.addEventListener(evt, e => {
    e.preventDefault(); dropArea.classList.remove('dragover');
  }));
  dropArea.addEventListener('drop', e => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) onFile(f);
  });
}

function computeCanvasSize(img) {
  const maxW = 900, maxH = 700;
  const w = img.naturalWidth, h = img.naturalHeight;
  let scale = Math.min(maxW / w, maxH / h, 2);
  scale = Math.max(scale, 0.05);
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

function parseRgbColor(str) {
  const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(str || '');
  if (!m) return null;
  return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) };
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function detectHasTransparency(canvas) {
  const ctx = canvas.getContext('2d');
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const totalPixels = data.length / 4;
  const step = 4 * Math.max(1, Math.floor(totalPixels / 20000)); // サンプリングして高速化
  let transparentCount = 0, sampled = 0;
  for (let i = 0; i < data.length; i += step) {
    if (data[i + 3] < 250) transparentCount++;
    sampled++;
  }
  return sampled > 0 && (transparentCount / sampled) > 0.01;
}

// 白=一番薄い(0) 〜 黒=一番濃い(255) というインクの濃さの尺度として輝度を使う
function luminance(rgb) {
  return 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
}

function hashRandom(seed) {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// imagetracerは輪郭+穴を "M...Z M...Z ..." と1つのd属性に連結して出力する。
// そのまま1本の折れ線としてサンプリングすると輪郭の終点と穴の始点が直線で
// 繋がってしまうため、"Z M" を境目にsubpathごとへ分割する。
function splitSubpaths(d) {
  const raw = (d || '').trim();
  if (!raw) return [];
  const parts = raw.split(/Z\s+(?=M)/i).map(s => s.trim()).filter(Boolean);
  return parts.map(p => (/Z\s*$/i.test(p) ? p : p + ' Z'));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 2000);
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('スクリプトの読み込みに失敗しました: ' + src));
    document.head.appendChild(s);
  });
}

/* ============================================================
   手のキャリブレーション
   ============================================================ */
function drawMarker(ctx, x, y, color, label) {
  ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = 'bold 11px sans-serif';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

function initHandCalibCanvas(img) {
  const canvas = els.handCalibCanvas;
  const maxW = 480;
  const scale = Math.min(maxW / img.naturalWidth, 1);
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  state.handCalibStep = 0;
  state.handReady = false;
  els.handCalibStatus.textContent = 'ペン先(描画する先端)をクリックしてください';
  els.handCalibWrap.classList.remove('hidden');
}

els.handCalibCanvas.addEventListener('click', e => {
  if (!state.handImg) return;
  const canvas = els.handCalibCanvas;
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const x = (e.clientX - rect.left) * scaleX;
  const y = (e.clientY - rect.top) * scaleY;
  const relX = x / canvas.width, relY = y / canvas.height;
  const ctx = canvas.getContext('2d');

  state.handTip = { x: relX, y: relY };
  drawMarker(ctx, x, y, '#e63946', '✓');
  els.handCalibStatus.textContent = '設定完了です。プレビューで確認してください。';
  state.handCalibStep = 1;
  state.handReady = true;
});

els.handCalibResetBtn.addEventListener('click', () => {
  if (state.handImg) initHandCalibCanvas(state.handImg);
});

/* ============================================================
   画像アップロード
   ============================================================ */
setupDropArea(els.sourceDropArea, els.sourceImageInput, file => {
  loadImageFile(file).then(img => {
    state.sourceImg = img;
    els.sourceThumb.src = img.src;
    els.sourceThumb.classList.remove('hidden');
    els.sourcePlaceholder.classList.add('hidden');
    els.traceBtn.disabled = false;
    els.traceStatus.textContent = '';
  }).catch(err => { els.traceStatus.textContent = err.message; });
});

setupDropArea(els.handDropArea, els.handImageInput, file => {
  loadImageFile(file).then(img => {
    state.handImg = img;
    els.handThumb.src = img.src;
    els.handThumb.classList.remove('hidden');
    els.handPlaceholder.classList.add('hidden');
    initHandCalibCanvas(img);
  }).catch(err => { els.traceStatus.textContent = err.message; });
});

/* ============================================================
   設定UIの配線
   ============================================================ */
function wireRangeOutputs() {
  [
    ['lineWidthRange', 'lineWidthOut'],
    ['handSizeRange', 'handSizeOut'],
    ['durationRange', 'durationOut'],
  ].forEach(([inId, outId]) => {
    els[inId].addEventListener('input', () => {
      els[outId].textContent = els[inId].value;
      if (inId === 'durationRange') state.duration = Number(els[inId].value) * 1000;
    });
  });
}

function updatePenColorFieldVisibility() {
  els.penColorField.style.display = els.colorModeSelect.value === 'mono' ? '' : 'none';
}
els.colorModeSelect.addEventListener('change', updatePenColorFieldVisibility);

/* ============================================================
   スタイルプリセット(線の細かさ × 太さ の組み合わせ)
   ============================================================ */
const STYLE_PRESETS = {
  'illustration-pen':    { detail: 'detailed', lineWidth: 1 },
  'illustration-crayon': { detail: 'detailed', lineWidth: 5 },
  'illustration-brush':  { detail: 'detailed', lineWidth: 10 },
  'text-pen':            { detail: 'simple',   lineWidth: 1 },
  'text-crayon':         { detail: 'simple',   lineWidth: 5 },
  'text-brush':          { detail: 'simple',   lineWidth: 10 },
};

els.stylePresetSelect.addEventListener('change', () => {
  const preset = STYLE_PRESETS[els.stylePresetSelect.value];
  if (!preset) return;
  els.detailSelect.value = preset.detail;
  els.lineWidthRange.value = preset.lineWidth;
  els.lineWidthOut.textContent = preset.lineWidth;
});

/* ============================================================
   画像トレース → ストローク生成
   ============================================================ */
async function traceImageAndBuildStrokes() {
  if (!state.sourceImg) return;
  pause();
  els.traceBtn.disabled = true;
  els.playBtn.disabled = true; els.pauseBtn.disabled = true; els.restartBtn.disabled = true;
  els.recordBtn.disabled = true; els.downloadWebmBtn.disabled = true; els.convertMp4Btn.disabled = true;
  els.traceStatus.textContent = '画像を解析しています...';
  await new Promise(r => setTimeout(r, 30));

  try {
    const { w, h } = computeCanvasSize(state.sourceImg);
    els.previewCanvas.width = w;
    els.previewCanvas.height = h;

    // 元画像の透明度をそのまま保持したキャンバス(完成後の背景切り抜き用)
    const alphaCanvas = document.createElement('canvas');
    alphaCanvas.width = w; alphaCanvas.height = h;
    alphaCanvas.getContext('2d').drawImage(state.sourceImg, 0, 0, w, h);
    state.sourceAlphaCanvas = alphaCanvas;
    state.hasTransparency = detectHasTransparency(alphaCanvas);

    // トレース用キャンバスは白地の上に合成する(透明部分を黒として誤認識しないように)
    const traceCanvas = document.createElement('canvas');
    traceCanvas.width = w; traceCanvas.height = h;
    const tctx = traceCanvas.getContext('2d');
    tctx.fillStyle = '#ffffff';
    tctx.fillRect(0, 0, w, h);
    tctx.drawImage(state.sourceImg, 0, 0, w, h);
    const imageData = tctx.getImageData(0, 0, w, h);

    const preset = DETAIL_PRESETS[els.detailSelect.value] || DETAIL_PRESETS.normal;
    const options = Object.assign({
      colorsampling: 2, colorquantcycles: 2, rightangleenhance: true,
      scale: 1, roundcoords: 2, viewbox: false, strokewidth: 0,
      linefilter: false, mincolorratio: 0.02,
    }, preset);

    const svgstring = ImageTracer.imagedataToSVG(imageData, options);
    const doc = new DOMParser().parseFromString(svgstring, 'image/svg+xml');
    const pathEls = Array.from(doc.querySelectorAll('path'));

    const geomSvg = els.geomSvg;
    geomSvg.innerHTML = '';
    geomSvg.setAttribute('width', w);
    geomSvg.setAttribute('height', h);

    const MIN_LEN = 6, SAMPLE_STEP = 3, MAX_SAMPLES = 300, MAX_STROKES = 550;
    // 白=薄い(255)〜黒=濃い(0)。完成図がこれより明るい(薄い)場所には、
    // これより大幅に濃いインクを塗らない。中間トーンまで神経質に除外しないよう、
    // 「明らかに薄い場所」だけを対象にする。
    const LIGHT_FINAL_THRESHOLD = 195;
    const DARKNESS_MARGIN = 55;
    const colorMode = els.colorModeSelect.value;
    const penLum = colorMode === 'mono' ? luminance(hexToRgb(els.penColorInput.value)) : null;

    let rawStrokes = [];
    const fillShapes = [];
    for (const el of pathEls) {
      const d = el.getAttribute('d');
      if (!d) continue;
      const fill = el.getAttribute('fill') || '#1a1a1a';

      // 塗りつぶし用: 穴(内側の輪郭)を含む複合パスのまま保持する。位置は
      // 「左上→右下」で塗る順を決めるためにバウンディングボックスを控えておく。
      const gpWhole = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      gpWhole.setAttribute('d', d);
      geomSvg.appendChild(gpWhole);
      let bbox = null;
      try { bbox = gpWhole.getBBox(); } catch (e) { bbox = null; }
      geomSvg.removeChild(gpWhole);
      try {
        fillShapes.push({
          path2d: new Path2D(d), color: fill,
          x: bbox ? bbox.x : 0, y: bbox ? bbox.y : 0,
          cx: bbox ? bbox.x + bbox.width / 2 : 0, cy: bbox ? bbox.y + bbox.height / 2 : 0,
        });
      } catch (e) { /* skip */ }

      // 完成図(=この領域の本来の色)より大幅に濃いインクを、明るい場所の上に描かないようにする。
      // 単色ペンの場合はペン色、元の色モードでは領域自身の色が描画色になる(常に条件を満たす)。
      const rgb = parseRgbColor(fill);
      const finalLum = rgb ? luminance(rgb) : 128;
      const drawLum = colorMode === 'mono' ? penLum : finalLum;
      if (finalLum > LIGHT_FINAL_THRESHOLD && (finalLum - drawLum) > DARKNESS_MARGIN) continue;

      // 縁取り用: 外側の輪郭と穴(内側)の輪郭は別々の線として扱う。
      // ひとつなぎのまま点をサンプリングすると、輪郭の終点から穴の始点へ
      // 直線で結ばれてしまい「変な線」が入るため、subpathごとに分割する。
      const subpaths = splitSubpaths(d);
      for (const sub of subpaths) {
        const gp = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        gp.setAttribute('d', sub);
        geomSvg.appendChild(gp);
        let totalLen = 0;
        try { totalLen = gp.getTotalLength(); } catch (e) { totalLen = 0; }
        if (totalLen < MIN_LEN) { geomSvg.removeChild(gp); continue; }
        const numSamples = Math.max(2, Math.min(MAX_SAMPLES, Math.round(totalLen / SAMPLE_STEP)));
        const points = [];
        for (let i = 0; i <= numSamples; i++) {
          const pt = gp.getPointAtLength(totalLen * i / numSamples);
          points.push({ x: pt.x, y: pt.y });
        }
        geomSvg.removeChild(gp);
        rawStrokes.push({ points, color: fill, length: totalLen });
      }
    }

    if (rawStrokes.length > MAX_STROKES) {
      rawStrokes.sort((a, b) => b.length - a.length);
      rawStrokes = rawStrokes.slice(0, MAX_STROKES);
    }
    // 縁取り: 上から下、同じ高さなら左から右という自然な描き順にする
    rawStrokes.sort((a, b) => {
      const ay = a.points[0].y, by = b.points[0].y;
      if (Math.abs(ay - by) > 20) return ay - by;
      return a.points[0].x - b.points[0].x;
    });

    let cum = 0;
    rawStrokes.forEach((s, i) => { s.cumStart = cum; cum += s.length; s.seed = i * 7.13 + 1; });
    state.strokes = rawStrokes;
    state.totalLength = cum;

    // 色塗り: 左上から右下へ向かって塗る
    fillShapes.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 20) return a.y - b.y;
      return a.x - b.x;
    });
    state.fillEnabled = els.fillCheckbox.checked;
    state.fillShapes = state.fillEnabled ? fillShapes : [];

    state.lineCanvas = document.createElement('canvas'); state.lineCanvas.width = w; state.lineCanvas.height = h;
    state.lineCtx = state.lineCanvas.getContext('2d');
    state.fillCanvas = document.createElement('canvas'); state.fillCanvas.width = w; state.fillCanvas.height = h;
    state.fillCtx = state.fillCanvas.getContext('2d');
    state.bakedStrokeIndex = 0; state.bakedFillIndex = 0;
    state.duration = Number(els.durationRange.value) * 1000;
    state.playedMs = 0; state.playStartTs = null; state.isPlaying = false; state.penPos = null;

    renderAtElapsed(0);
    els.progressFill.style.width = '0%';

    if (state.strokes.length === 0) {
      els.traceStatus.textContent = '線を検出できませんでした。「線の細かさ」を変えて再度お試しください。';
    } else {
      const transparencyNote = state.hasTransparency ? '(透過背景を検出しました。完成後も背景は透過されます)' : '';
      els.traceStatus.textContent = `完了: ${state.strokes.length}本の線を検出しました。${transparencyNote}`;
      els.playBtn.disabled = false; els.restartBtn.disabled = false; els.recordBtn.disabled = false;
    }
  } catch (err) {
    console.error(err);
    els.traceStatus.textContent = '解析中にエラーが発生しました: ' + err.message;
  } finally {
    els.traceBtn.disabled = false;
  }
}
els.traceBtn.addEventListener('click', traceImageAndBuildStrokes);

/* ============================================================
   描画(手カーソル)
   ============================================================ */
const PEN_MAX_STEP_PER_FRAME = 150; // ペン先が1フレームで動ける最大距離(px)

// ペン先の表示位置を目標へ近づける。距離が大きいときは最大移動量で頭打ちにし、
// ストローク間・図形間を移動する際に一気に飛ばないようにする。
function advancePenPos(target) {
  if (!state.penPos) {
    state.penPos = { x: target.x, y: target.y };
    return { x: state.penPos.x, y: state.penPos.y };
  }
  const dx = target.x - state.penPos.x, dy = target.y - state.penPos.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= PEN_MAX_STEP_PER_FRAME || dist === 0) {
    state.penPos.x = target.x;
    state.penPos.y = target.y;
  } else {
    const t = PEN_MAX_STEP_PER_FRAME / dist;
    state.penPos.x += dx * t;
    state.penPos.y += dy * t;
  }
  return { x: state.penPos.x, y: state.penPos.y };
}

function drawHandCursor(ctx, tipX, tipY) {
  const img = state.handImg;
  if (!img) return;
  const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
  const tipPx = { x: state.handTip.x * iw, y: state.handTip.y * ih };
  const baseScale = Math.min(els.previewCanvas.width, els.previewCanvas.height) * 0.4 / Math.max(iw, ih);
  const scale = baseScale * (Number(els.handSizeRange.value) / 100);

  ctx.save();
  ctx.translate(tipX, tipY);
  ctx.scale(scale, scale);
  ctx.drawImage(img, -tipPx.x, -tipPx.y);
  ctx.restore();
}

function strokeColorFor(stroke) {
  return els.colorModeSelect.value === 'mono' ? els.penColorInput.value : stroke.color;
}

function buildStrokePath(ctx, stroke, fromIdx, toIdx) {
  ctx.beginPath();
  ctx.moveTo(stroke.points[fromIdx].x, stroke.points[fromIdx].y);
  for (let i = fromIdx + 1; i <= toIdx; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
}

// 周期的な「れんこん」模様に見えないよう、長さがバラバラなダッシュ列を作る
function buildIrregularDash(seed, baseWidth, pairs) {
  const arr = [];
  for (let i = 0; i < pairs; i++) {
    const rd = hashRandom(seed + i * 2.13 + 0.7);
    const rg = hashRandom(seed + i * 2.13 + 5.3);
    arr.push(Math.max(0.4, baseWidth * (0.4 + rd * rd * 3.2)));  // ダッシュ長: 不規則(短めが多く、たまに長い)
    arr.push(Math.max(0.3, baseWidth * (0.25 + rg * 1.9)));      // 隙間長: 不規則
  }
  return arr;
}

function drawStrokeSegment(ctx, stroke, fromIdx, toIdx) {
  if (toIdx <= fromIdx) return;
  const baseWidth = Number(els.lineWidthRange.value);
  const color = strokeColorFor(stroke);
  const seed = stroke.seed || 1;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineJoin = 'round';

  // パス1: 薄くにじむ下地(途切れなし。線がバラバラの点に見えすぎないための土台)
  ctx.globalAlpha = 0.2;
  ctx.lineWidth = baseWidth * 1.4;
  ctx.lineCap = 'round';
  ctx.setLineDash([]);
  buildStrokePath(ctx, stroke, fromIdx, toIdx);
  ctx.stroke();

  // パス2: 不規則な破線でクレヨンのかすれた本体を表現(角ばったキャップで丸ビーズ感を避ける)
  ctx.globalAlpha = 0.72;
  ctx.lineWidth = baseWidth;
  ctx.lineCap = 'butt';
  ctx.setLineDash(buildIrregularDash(seed, baseWidth, 9));
  ctx.lineDashOffset = hashRandom(seed + 11) * baseWidth * 8;
  buildStrokePath(ctx, stroke, fromIdx, toIdx);
  ctx.stroke();

  // パス3: 位相をずらした別パターンを重ね、さらに不規則さを足す
  ctx.globalAlpha = 0.55;
  ctx.lineWidth = baseWidth * 0.85;
  ctx.lineCap = 'butt';
  ctx.setLineDash(buildIrregularDash(seed + 137, baseWidth, 9));
  ctx.lineDashOffset = hashRandom(seed + 23) * baseWidth * 8;
  buildStrokePath(ctx, stroke, fromIdx, toIdx);
  ctx.stroke();

  // パス4: 芯となる細い線(輪郭のメリハリ、こちらも軽くかすれさせる)
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(0.6, baseWidth * 0.5);
  ctx.lineCap = 'butt';
  ctx.setLineDash(buildIrregularDash(seed + 271, baseWidth, 9));
  ctx.lineDashOffset = hashRandom(seed + 37) * baseWidth * 8;
  buildStrokePath(ctx, stroke, fromIdx, toIdx);
  ctx.stroke();

  ctx.restore();
}

function clearAndBg(ctx) {
  ctx.fillStyle = els.bgColorInput.value;
  ctx.fillRect(0, 0, els.previewCanvas.width, els.previewCanvas.height);
}

function findStrokeAt(drawnLength) {
  const strokes = state.strokes;
  for (let i = 0; i < strokes.length; i++) {
    const s = strokes[i];
    if (drawnLength <= s.cumStart + s.length || i === strokes.length - 1) {
      const within = s.length > 0 ? Math.min(1, Math.max(0, (drawnLength - s.cumStart) / s.length)) : 1;
      return { idx: i, within };
    }
  }
  return { idx: 0, within: 0 };
}

function bakeCompletedStrokes(uptoIdx) {
  const ctx = state.lineCtx;
  while (state.bakedStrokeIndex < uptoIdx) {
    const s = state.strokes[state.bakedStrokeIndex];
    drawStrokeSegment(ctx, s, 0, s.points.length - 1);
    state.bakedStrokeIndex++;
  }
}

function renderAtElapsed(elapsedMs) {
  const ctx = els.previewCanvas.getContext('2d');
  if (!state.strokes.length) { clearAndBg(ctx); return 0; }

  const { lineMs, fillMs, revealMs } = computeTimeline();
  const totalMs = lineMs + fillMs + revealMs;
  const clamped = Math.min(elapsedMs, totalMs);
  const lineProgress = Math.min(clamped / lineMs, 1);
  const drawnLength = lineProgress * state.totalLength;
  const { idx, within } = findStrokeAt(drawnLength);
  const fullyDoneIdx = lineProgress >= 1 ? state.strokes.length : idx;
  bakeCompletedStrokes(fullyDoneIdx);

  clearAndBg(ctx);
  if (state.fillEnabled) ctx.drawImage(state.fillCanvas, 0, 0);
  ctx.drawImage(state.lineCanvas, 0, 0);

  let tip = null;
  if (lineProgress < 1 && state.strokes.length) {
    const s = state.strokes[idx];
    const pIdx = Math.max(0, Math.min(s.points.length - 1, Math.round(within * (s.points.length - 1))));
    drawStrokeSegment(ctx, s, 0, pIdx);
    // ストロークをまたぐ瞬間などに一気に飛ばず、1フレームあたりの移動量を抑える
    tip = advancePenPos(s.points[pIdx]);
  } else if (state.strokes.length) {
    const last = state.strokes[state.strokes.length - 1];
    tip = last.points[last.points.length - 1];
  }

  if (state.fillEnabled && lineProgress >= 1) {
    const fillElapsed = Math.max(0, clamped - lineMs);
    const n = state.fillShapes.length;
    const spreadMs = Math.max(1, fillMs - FILL_SHAPE_FADE_MS);
    const spacing = n > 0 ? spreadMs / n : 0;

    // 完全にふわっと現れ終えた図形は焼き込んで、以後は塗り直さない
    while (state.bakedFillIndex < n) {
      const startMs = state.bakedFillIndex * spacing;
      if (fillElapsed - startMs < FILL_SHAPE_FADE_MS) break;
      const shp = state.fillShapes[state.bakedFillIndex];
      state.fillCtx.fillStyle = shp.color;
      state.fillCtx.fill(shp.path2d);
      state.bakedFillIndex++;
    }

    clearAndBg(ctx);
    ctx.drawImage(state.fillCanvas, 0, 0);
    ctx.drawImage(state.lineCanvas, 0, 0);

    // 焼き込み待ちの図形のうち、いま現れている途中のものだけ薄く重ねて描く
    for (let i = state.bakedFillIndex; i < n; i++) {
      const startMs = i * spacing;
      if (fillElapsed < startMs) break;
      const alpha = Math.min(1, (fillElapsed - startMs) / FILL_SHAPE_FADE_MS);
      if (alpha <= 0) continue;
      const shp = state.fillShapes[i];
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = shp.color;
      ctx.fill(shp.path2d);
      ctx.restore();
    }

    // 色塗り中もペン先を今塗っている図形の方へ動かす(実際の塗り位置と多少
    // ずれてもよいので、1フレームでの移動量には上限を設けて飛びすぎを防ぐ)
    if (n > 0) {
      const leadIdx = Math.min(n - 1, Math.max(0, Math.floor(fillElapsed / Math.max(1, spacing))));
      const target = state.fillShapes[leadIdx];
      tip = advancePenPos({ x: target.cx, y: target.cy });
    }
  }

  // 最後に、描いた線画から実際の元画像へゆっくりクロスフェードする
  // (完成図は「塗り終わり」と元画像の間、元画像寄りにする)
  const drawingDoneMs = lineMs + fillMs;
  if (clamped >= drawingDoneMs && state.sourceImg) {
    const revealElapsed = clamped - drawingDoneMs;
    const revealProgress = revealMs > 0 ? Math.min(revealElapsed / revealMs, 1) : 1;
    ctx.save();
    ctx.globalAlpha = revealProgress * REVEAL_MAX_ALPHA;
    ctx.drawImage(state.sourceImg, 0, 0, els.previewCanvas.width, els.previewCanvas.height);
    ctx.restore();
  }

  // 元画像が透過している場合は、紙の背景ごと元画像のシルエットで切り抜く
  if (state.hasTransparency && state.sourceAlphaCanvas) {
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.drawImage(state.sourceAlphaCanvas, 0, 0, els.previewCanvas.width, els.previewCanvas.height);
    ctx.restore();
  }

  const showHand = clamped < drawingDoneMs && state.handReady;
  if (tip && showHand) drawHandCursor(ctx, tip.x, tip.y);

  return totalMs;
}

/* ============================================================
   再生制御
   ============================================================ */
function frameTick(ts) {
  if (!state.isPlaying) return;
  if (state.playStartTs === null) state.playStartTs = ts - state.playedMs;
  const elapsed = ts - state.playStartTs;
  state.playedMs = elapsed;
  const totalMs = renderAtElapsed(elapsed);
  els.progressFill.style.width = (Math.min(elapsed / totalMs, 1) * 100) + '%';

  if (elapsed < totalMs) {
    state.rafId = requestAnimationFrame(frameTick);
  } else {
    state.isPlaying = false;
    els.playBtn.disabled = false; els.pauseBtn.disabled = true;
    if (state.onComplete) { const cb = state.onComplete; state.onComplete = null; cb(); }
  }
}

function play() {
  if (state.isPlaying || !state.strokes.length) return;
  state.isPlaying = true;
  state.playStartTs = null;
  els.playBtn.disabled = true; els.pauseBtn.disabled = false; els.restartBtn.disabled = false;
  state.rafId = requestAnimationFrame(frameTick);
}

function pause() {
  state.isPlaying = false;
  if (state.rafId) cancelAnimationFrame(state.rafId);
  els.playBtn.disabled = state.strokes.length ? false : true;
  els.pauseBtn.disabled = true;
}

function restart() {
  pause();
  state.playedMs = 0; state.playStartTs = null;
  state.bakedStrokeIndex = 0; state.bakedFillIndex = 0;
  state.penPos = null;
  if (state.lineCtx) state.lineCtx.clearRect(0, 0, state.lineCanvas.width, state.lineCanvas.height);
  if (state.fillCtx) state.fillCtx.clearRect(0, 0, state.fillCanvas.width, state.fillCanvas.height);
  renderAtElapsed(0);
  els.progressFill.style.width = '0%';
}

els.playBtn.addEventListener('click', play);
els.pauseBtn.addEventListener('click', pause);
els.restartBtn.addEventListener('click', restart);

els.bgColorInput.addEventListener('input', () => { if (!state.isPlaying && state.strokes.length) renderAtElapsed(state.playedMs); });

/* ============================================================
   書き出し(WebM録画 / MP4変換)
   ============================================================ */
function pickMime() {
  const cands = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  for (const c of cands) { if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c; }
  return '';
}

function startRecording() {
  if (!state.strokes.length) return;
  if (!window.MediaRecorder) { els.exportStatus.textContent = 'このブラウザは動画の録画に対応していません。'; return; }
  restart();
  const mime = pickMime();
  const stream = els.previewCanvas.captureStream(30);
  let recorder;
  try {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  } catch (err) {
    els.exportStatus.textContent = '録画の開始に失敗しました: ' + err.message;
    return;
  }
  state.recordedChunks = [];
  recorder.ondataavailable = e => { if (e.data && e.data.size > 0) state.recordedChunks.push(e.data); };
  recorder.onstop = () => {
    state.webmBlob = new Blob(state.recordedChunks, { type: 'video/webm' });
    els.downloadWebmBtn.disabled = false;
    els.convertMp4Btn.disabled = false;
    els.exportStatus.textContent = '録画が完了しました。ダウンロードできます。';
    els.recordBtn.disabled = false;
  };
  state.recorder = recorder;
  els.recordBtn.disabled = true;
  els.downloadWebmBtn.disabled = true;
  els.convertMp4Btn.disabled = true;
  els.exportStatus.textContent = '録画中...';
  recorder.start();
  state.onComplete = () => {
    setTimeout(() => { if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop(); }, 300);
  };
  play();
}
els.recordBtn.addEventListener('click', startRecording);

els.downloadWebmBtn.addEventListener('click', () => {
  if (state.webmBlob) triggerDownload(state.webmBlob, 'whiteboard-animation.webm');
});

async function convertToMp4() {
  if (!state.webmBlob) { els.exportStatus.textContent = '先に動画を録画してください。'; return; }
  els.convertMp4Btn.disabled = true;
  els.exportStatus.textContent = 'MP4変換用のライブラリを読み込み中...(初回は数十MBのダウンロードが発生します)';
  try {
    await loadScriptOnce('https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js');
    await loadScriptOnce('https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js');
    const { FFmpeg } = window.FFmpegWASM;
    const { fetchFile, toBlobURL } = window.FFmpegUtil;
    const ffmpeg = new FFmpeg();
    ffmpeg.on('progress', ({ progress }) => {
      els.exportStatus.textContent = `MP4変換中... ${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%`;
    });
    const baseURL = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    await ffmpeg.writeFile('input.webm', await fetchFile(state.webmBlob));
    await ffmpeg.exec(['-i', 'input.webm', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'output.mp4']);
    const data = await ffmpeg.readFile('output.mp4');
    const mp4Blob = new Blob([data.buffer], { type: 'video/mp4' });
    triggerDownload(mp4Blob, 'whiteboard-animation.mp4');
    els.exportStatus.textContent = 'MP4のダウンロードを開始しました。';
  } catch (err) {
    console.error(err);
    els.exportStatus.textContent = 'MP4変換に失敗しました(' + err.message + ')。WebMをダウンロードしてご利用ください。';
  } finally {
    els.convertMp4Btn.disabled = false;
  }
}
els.convertMp4Btn.addEventListener('click', convertToMp4);

/* ============================================================
   初期化
   ============================================================ */
function init() {
  wireRangeOutputs();
  updatePenColorFieldVisibility();
}
init();
