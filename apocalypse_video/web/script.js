/* АПОКАЛИПСИС — детерминированный рендер кадра 1080x1920 на canvas.
 *
 * URL:  index.html?t=<float>   — покадровый рендер (для Playwright)
 *       ?t=...&render=1        — без панели превью, body.rendering
 * После отрисовки ставится window.__frameReady = true.
 *
 * Вся графика рисуется кодом (силуэты/градиенты), шрифты системные,
 * зерно/glitch — по детерминированному PRNG (сид от номера кадра).
 */
(function () {
  "use strict";

  var W = 1080, H = 1920, FPS = 30, DUR = 60;
  var COL = { black: "#0a0a0a", gray: "#8a8a8a", blood: "#8b0000", amber: "#d4a017" };

  var canvas = document.getElementById("scene");
  var ctx = canvas.getContext("2d");

  // ------------------------------------------------------------- utils ---
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, u) { return a + (b - a) * u; }
  function smooth(u) { u = clamp(u, 0, 1); return u * u * (3 - 2 * u); }
  function easeOut(u) { return 1 - Math.pow(1 - clamp(u, 0, 1), 3); }
  function rgba(r, g, b, a) { return "rgba(" + r + "," + g + "," + b + "," + a + ")"; }

  // ---------------------------------------------------------- subtitles --
  var SUBS = [
    [0, 3, ["ВО ВСЁМ ГОРОДЕ", "ПОГАС СВЕТ"], "title"],
    [3, 8, ["Связь пропала.", "Интернет не работает."], null],
    [8, 12, ["Ты — один из немногих,", "кто ещё жив."], null],
    [12, 15, ["Правило первое.", "Не включай свет. Тебя увидят."], "rule"],
    [15, 18, ["Правило второе.", "Найди оружие."], "rule"],
    [18, 22, ["Правило третье.", "Собери воду и еду.", "Не больше, чем унесёшь."], "rule"],
    [22, 26, ["Правило четвёртое.", "Забаррикадируй дверь.", "Не открывай никому."], "rule"],
    [26, 30, ["Правило пятое.", "Слушай. Они издают звук."], "rule"],
    [30, 35, ["Правило шестое.", "Когда всё сделано — не выходи.", "Жди рассвета."], "rule"],
    [35, 38, ["«Я же не включал…»"], "whisper"],
    [38, 42, ["Они выходят."], "danger"],
    [42, 47, ["Беги. Не оглядывайся."], "danger"],
    [47, 52, ["Их — тысячи."], "danger"],
    [52, 58, ["Что будет дальше —", "решаешь ты."], null],
    [58, 60, ["ЧАСТЬ ВТОРАЯ. СКОРО.", "Подпишись, чтобы не пропустить."], "cta"]
  ];

  function drawSubtitles(t) {
    for (var i = 0; i < SUBS.length; i++) {
      var s = SUBS[i];
      if (t < s[0] || t >= s[1]) continue;
      var lines = s[2], kind = s[3];
      var fadeIn = smooth((t - s[0]) / 0.28);
      var fadeOut = smooth((s[1] - t) / 0.28);
      var alpha = Math.min(fadeIn, fadeOut);
      var size = kind === "title" ? 92 : kind === "cta" ? 66 : 60;
      var lineH = size * 1.22;
      var baseY = H - 300;             // нижняя треть
      if (kind === "title") baseY = H / 2 - lines.length * lineH / 2;
      if (kind === "cta") baseY = H / 2 - 40;

      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      var jitter = kind === "danger" ? (Math.sin(t * 40) * 3) : 0;
      for (var j = 0; j < lines.length; j++) {
        var y = baseY + j * lineH + jitter;
        ctx.font = "900 " + size + "px 'Impact','Arial Black',sans-serif";
        ctx.lineWidth = Math.max(8, size * 0.16);
        ctx.strokeStyle = "rgba(0,0,0,0.92)";
        ctx.lineJoin = "round";
        ctx.strokeText(lines[j], W / 2, y);
        ctx.fillStyle = "#ffffff";
        if (kind === "title") ctx.fillStyle = COL.amber;
        if (kind === "rule") ctx.fillStyle = "#f2f2f2";
        if (kind === "danger") ctx.fillStyle = "#ff5555";
        if (kind === "whisper") ctx.fillStyle = "#bdbdbd";
        if (kind === "cta") ctx.fillStyle = COL.amber;
        ctx.fillText(lines[j], W / 2, y);
      }
      // красная черта-акцент под «Правилом N»
      if (kind === "rule") {
        ctx.fillStyle = COL.blood;
        ctx.fillRect(W / 2 - 120, baseY - size, 240, 8);
      }
      ctx.restore();
      return;
    }
  }

  // ------------------------------------------------------- primitives ----
  function fillBG(color) { ctx.fillStyle = color; ctx.fillRect(0, 0, W, H); }

  function vignette(strength) {
    var g = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.75);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0," + strength + ")");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function grain(t, amount) {
    var frame = Math.floor(t * FPS);
    var rnd = mulberry32(frame * 2654435761);
    ctx.save();
    ctx.globalAlpha = amount;
    for (var i = 0; i < 900; i++) {
      var x = rnd() * W, y = rnd() * H, v = rnd() * 255 | 0;
      ctx.fillStyle = rgb(v, v, v);
      ctx.fillRect(x, y, 2, 2);
    }
    ctx.restore();
  }
  function rgb(r, g, b) { return "rgb(" + r + "," + g + "," + b + ")"; }

  function glitch(t, intensity) {
    if (intensity <= 0) return;
    var frame = Math.floor(t * FPS);
    var rnd = mulberry32(frame * 40503 + 7);
    var n = Math.round(intensity * 6);
    for (var i = 0; i < n; i++) {
      var y = rnd() * H, h = 4 + rnd() * 26 * intensity, dx = (rnd() - 0.5) * 90 * intensity;
      try {
        var img = ctx.getImageData(0, y | 0, W, Math.max(1, h | 0));
        ctx.putImageData(img, dx, y | 0);
      } catch (e) { /* noop */ }
      if (rnd() < 0.4) {
        ctx.fillStyle = rnd() < 0.5 ? "rgba(139,0,0,.18)" : "rgba(212,160,23,.12)";
        ctx.fillRect(0, y | 0, W, Math.max(1, h | 0));
      }
    }
  }

  // силуэт героя (справа налево идёт или стоит), x — центр ног, scale
  function heroSilhouette(x, groundY, scale, pose, armAngle) {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(scale, scale);
    ctx.fillStyle = "#050505";
    var swing = pose === "walk" || pose === "run" ? Math.sin(armAngle) : 0;
    var legSwing = pose === "run" ? swing * 0.9 : swing * 0.45;
    // ноги
    ctx.lineWidth = 26; ctx.lineCap = "round"; ctx.strokeStyle = "#050505";
    ctx.beginPath(); ctx.moveTo(0, -120); ctx.lineTo(-30 * legSwing - 10, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -120); ctx.lineTo(30 * legSwing + 10, 0); ctx.stroke();
    // тело (куртка)
    ctx.beginPath();
    ctx.moveTo(-38, -120); ctx.quadraticCurveTo(-46, -240, -30, -280);
    ctx.lineTo(30, -280); ctx.quadraticCurveTo(46, -240, 38, -120);
    ctx.closePath(); ctx.fill();
    // руки
    ctx.lineWidth = 20;
    ctx.beginPath(); ctx.moveTo(-30, -270); ctx.lineTo(-30 - 55 * swing, -170); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(30, -270); ctx.lineTo(30 + 60 * swing, -160); ctx.stroke();
    // голова + капюшон
    ctx.beginPath(); ctx.arc(0, -318, 34, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-40, -300); ctx.quadraticCurveTo(0, -380, 40, -300);
    ctx.quadraticCurveTo(0, -330, -40, -300); ctx.fill();
    ctx.restore();
    return { handX: x + (30 + 60 * swing) * scale, handY: groundY - 160 * scale };
  }

  // конус света фонарика
  function flashlightCone(hx, hy, angleDeg, len, spread, alpha, flickerSeed) {
    var a = angleDeg * Math.PI / 180;
    var rnd = mulberry32(flickerSeed);
    var fl = 0.75 + 0.25 * rnd();
    ctx.save();
    ctx.translate(hx, hy);
    ctx.rotate(a);
    var g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, rgba(255, 230, 160, 0.55 * alpha * fl));
    g.addColorStop(1, rgba(255, 220, 150, 0));
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(len, -len * spread);
    ctx.lineTo(len, len * spread);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // город: массив зданий с окнами; litRatio — доля горящих окон
  function makeCity(seed) {
    var rnd = mulberry32(seed), arr = [];
    var x = -20;
    while (x < W + 40) {
      var w = 60 + rnd() * 130, h = 200 + rnd() * 520;
      arr.push({ x: x, w: w, h: h, cols: Math.max(2, (w / 34) | 0), rows: Math.max(3, (h / 46) | 0), sd: rnd() * 1e6 });
      x += w + 8 + rnd() * 26;
    }
    return arr;
  }
  var CITY_FAR = makeCity(11), CITY_NEAR = makeCity(23);

  function drawSkyline(city, baseY, col, litRatio, winCol, t) {
    ctx.fillStyle = col;
    for (var i = 0; i < city.length; i++) {
      var b = city[i];
      ctx.fillRect(b.x, baseY - b.h, b.w, b.h);
    }
    if (litRatio > 0.001) {
      for (i = 0; i < city.length; i++) {
        var bb = city[i];
        var rnd = mulberry32(bb.sd);
        var cw = bb.w / bb.cols, ch = bb.h / bb.rows;
        for (var cx = 0; cx < bb.cols; cx++) {
          for (var cy = 0; cy < bb.rows; cy++) {
            var r = rnd();
            if (r < litRatio) {
              var flick = rnd() < 0.06 && r > litRatio * 0.7 ? (Math.sin(t * 30 + cx) > 0 ? 1 : 0) : 1;
              ctx.fillStyle = winCol;
              ctx.globalAlpha = 0.9 * flick;
              ctx.fillRect(bb.x + cx * cw + cw * 0.28, baseY - bb.h + cy * ch + ch * 0.3, cw * 0.44, ch * 0.4);
              ctx.globalAlpha = 1;
            }
          }
        }
      }
    }
  }

  function moon(y, alpha) {
    var g = ctx.createRadialGradient(W * 0.72, y, 10, W * 0.72, y, 260);
    g.addColorStop(0, rgba(210, 210, 200, 0.9 * alpha));
    g.addColorStop(0.25, rgba(160, 160, 150, 0.25 * alpha));
    g.addColorStop(1, rgba(0, 0, 0, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  function streetGround(baseY, brightness) {
    var g = ctx.createLinearGradient(0, baseY, 0, H);
    g.addColorStop(0, rgb(brightness, brightness, brightness + 2));
    g.addColorStop(1, "#050505");
    ctx.fillStyle = g;
    ctx.fillRect(0, baseY, W, H - baseY);
    // разметка
    ctx.strokeStyle = rgba(138, 138, 138, 0.25);
    ctx.lineWidth = 6;
    ctx.setLineDash([70, 60]);
    ctx.beginPath(); ctx.moveTo(W / 2, baseY + 20); ctx.lineTo(W / 2, H); ctx.stroke();
    ctx.setLineDash([]);
  }

  // брошенные машины
  function wreck(x, y, s, seed) {
    var rnd = mulberry32(seed);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate((rnd() - 0.5) * 0.12);
    ctx.scale(s, s);
    ctx.fillStyle = "#101010";
    ctx.beginPath();
    ctx.moveTo(-120, 0); ctx.lineTo(-90, -46); ctx.lineTo(40, -52);
    ctx.lineTo(90, -20); ctx.lineTo(120, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#000";
    ctx.beginPath(); ctx.arc(-70, 0, 22, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(70, 0, 22, 0, 7); ctx.fill();
    ctx.restore();
  }

  // зомби-силуэт с белыми глазами
  function zombie(x, groundY, scale, phase, hunched) {
    ctx.save();
    ctx.translate(x, groundY);
    ctx.scale(scale, scale);
    ctx.strokeStyle = "#0c0c0c"; ctx.fillStyle = "#0c0c0c";
    ctx.lineWidth = 24; ctx.lineCap = "round";
    var sw = Math.sin(phase);
    ctx.beginPath(); ctx.moveTo(0, -110); ctx.lineTo(-26 * sw - 8, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0, -110); ctx.lineTo(26 * sw + 8, 0); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-34, -110); ctx.quadraticCurveTo(-44, -220, -26 + (hunched ? 30 : 0), -266);
    ctx.lineTo(28, -262); ctx.quadraticCurveTo(44, -220, 34, -110);
    ctx.closePath(); ctx.fill();
    // вытянутые руки
    ctx.beginPath(); ctx.moveTo(-26, -250); ctx.lineTo(-26, -330 + (hunched ? 60 : 0)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(26, -250); ctx.lineTo(30, -335 + (hunched ? 60 : 0)); ctx.stroke();
    ctx.beginPath(); ctx.arc(hunched ? 14 : 0, hunched ? -280 : -300, 30, 0, 7); ctx.fill();
    // глаза
    ctx.fillStyle = "#e8e8e8";
    var ey = hunched ? -286 : -304;
    ctx.beginPath(); ctx.arc((hunched ? 14 : 0) - 11, ey, 4.5, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc((hunched ? 14 : 0) + 11, ey, 4.5, 0, 7); ctx.fill();
    ctx.restore();
  }

  // квартира: стена, дверь, окно, настольная лампа
  function room(t, lampOn, doorState, barricade) {
    // стены
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#101012"); g.addColorStop(1, "#0a0a0a");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // пол
    ctx.fillStyle = "#151312"; ctx.fillRect(0, 1400, W, H - 1400);
    ctx.strokeStyle = "#1f1c1a"; ctx.lineWidth = 3;
    for (var i = 0; i < 8; i++) {
      ctx.beginPath(); ctx.moveTo(0, 1440 + i * 70); ctx.lineTo(W, 1420 + i * 66); ctx.stroke();
    }
    // окно слева с луной снаружи
    ctx.fillStyle = "#050506"; ctx.fillRect(80, 480, 340, 460);
    var og = ctx.createRadialGradient(250, 640, 20, 250, 640, 200);
    og.addColorStop(0, rgba(150, 155, 160, 0.5)); og.addColorStop(1, rgba(20, 22, 26, 0));
    ctx.fillStyle = og; ctx.fillRect(80, 480, 340, 460);
    ctx.strokeStyle = "#2a2a2a"; ctx.lineWidth = 12;
    ctx.strokeRect(80, 480, 340, 460);
    ctx.beginPath(); ctx.moveTo(250, 480); ctx.lineTo(250, 940);
    ctx.moveTo(80, 710); ctx.lineTo(420, 710); ctx.stroke();
    // ДВЕРЬ справа
    var dx = 700, dy = 520, dw = 300, dh = 880;
    var open = clamp(doorState, 0, 1);
    ctx.save();
    ctx.translate(dx, dy);
    ctx.transform(1 - open * 0.75, 0, open * 0.18, 1, 0, 0); // псевдо-открывание
    ctx.fillStyle = "#1b1410"; ctx.fillRect(0, 0, dw, dh);
    ctx.strokeStyle = "#33261c"; ctx.lineWidth = 8; ctx.strokeRect(10, 10, dw - 20, dh - 20);
    ctx.strokeRect(30, 60, dw - 60, 320);
    ctx.strokeRect(30, 420, dw - 60, 380);
    ctx.fillStyle = "#8a7a55"; ctx.beginPath(); ctx.arc(dw - 40, 470, 16, 0, 7); ctx.fill();
    ctx.restore();
    // свет из приоткрытой двери — красноватый коридор
    if (open > 0.02) {
      var lg = ctx.createLinearGradient(dx, 0, dx + dw, 0);
      lg.addColorStop(0, rgba(139, 0, 0, 0.85 * open));
      lg.addColorStop(1, rgba(60, 10, 10, 0.25 * open));
      ctx.fillStyle = lg;
      ctx.fillRect(dx + 20, dy + 20, dw - 40, dh - 40);
    }
    // баррикада: доски поперёк двери
    if (barricade > 0) {
      ctx.save();
      ctx.fillStyle = "#3a2c1c";
      var planks = Math.round(barricade * 4);
      for (i = 0; i < planks; i++) {
        ctx.save();
        ctx.translate(dx + dw / 2, dy + 180 + i * 210);
        ctx.rotate(i % 2 ? 0.13 : -0.11);
        ctx.fillRect(-dw / 2 - 40, -26, dw + 80, 52);
        ctx.restore();
      }
      ctx.restore();
    }
    // стол + лампа
    ctx.fillStyle = "#171310"; ctx.fillRect(120, 1250, 420, 26);
    ctx.fillRect(160, 1276, 22, 130); ctx.fillRect(480, 1276, 22, 130);
    if (lampOn) {
      var lampG = ctx.createRadialGradient(330, 1180, 10, 330, 1180, 500);
      lampG.addColorStop(0, rgba(255, 210, 120, 0.85));
      lampG.addColorStop(0.3, rgba(212, 160, 23, 0.28));
      lampG.addColorStop(1, rgba(0, 0, 0, 0));
      ctx.fillStyle = lampG; ctx.fillRect(0, 400, W, 1520);
      ctx.fillStyle = "#d4a017";
      ctx.beginPath(); ctx.moveTo(300, 1250); ctx.lineTo(360, 1250); ctx.lineTo(345, 1180); ctx.lineTo(315, 1180); ctx.closePath(); ctx.fill();
    } else {
      ctx.fillStyle = "#241d14";
      ctx.beginPath(); ctx.moveTo(300, 1250); ctx.lineTo(360, 1250); ctx.lineTo(345, 1180); ctx.lineTo(315, 1180); ctx.closePath(); ctx.fill();
    }
    // рюкзак/припасы появляются (правило 3)
  }

  // вспышка огня (финал)
  function fireGlow(cx, cy, rad, alpha, seed) {
    var rnd = mulberry32(seed);
    var g = ctx.createRadialGradient(cx, cy, 10, cx, cy, rad);
    g.addColorStop(0, rgba(255, 170, 60, 0.9 * alpha));
    g.addColorStop(0.4, rgba(139, 0, 0, 0.55 * alpha));
    g.addColorStop(1, rgba(0, 0, 0, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // языки пламени
    ctx.save();
    ctx.fillStyle = rgba(212, 120, 23, 0.5 * alpha);
    for (var i = 0; i < 14; i++) {
      var fx = cx + (rnd() - 0.5) * rad * 1.6;
      var fh = 60 + rnd() * 220;
      ctx.beginPath();
      ctx.moveTo(fx - 26, cy);
      ctx.quadraticCurveTo(fx, cy - fh, fx + 26, cy);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ------------------------------------------------------------ SCENES ---
  function sceneBlack(t) {
    fillBG("#000");
    // едва заметный мерцающий горизонт в конце акта 1
    var a = smooth((t - 1.0) / 2.0);
    var g = ctx.createLinearGradient(0, H * 0.45, 0, H * 0.6);
    g.addColorStop(0, rgba(20, 20, 24, 0));
    g.addColorStop(1, rgba(30, 28, 30, 0.5 * a));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function sceneCityDies(t) { // 3–8 с: город гаснет
    fillBG("#0d0d10");
    var horizon = 1180;
    moon(420, 0.8);
    drawSkyline(CITY_FAR, horizon - 60, "#17171b", 0.05, "#c9c2a8", t);
    // окна гаснут волной сверху вниз со временем сцены
    var p = smooth((t - 3) / 4.5);
    var lit = clamp(0.55 * (1 - p), 0, 1);
    drawSkyline(CITY_NEAR, horizon, "#0c0c0f", lit, "#d4a017", t);
    streetGround(horizon, 24);
    // мигание последних фонарей
    var rnd = mulberry32(Math.floor(t * FPS) * 7919);
    if (rnd() < 0.10 * (1 - p)) {
      ctx.fillStyle = rgba(255, 240, 200, 0.06);
      ctx.fillRect(0, 0, W, H);
    }
  }

  function sceneEmptyStreet(t) { // 8–12 с: пустая улица
    fillBG("#0b0b0d");
    var horizon = 1080;
    moon(380, 0.7);
    drawSkyline(CITY_FAR, horizon - 40, "#141418", 0.02, "#c9c2a8", t);
    drawSkyline(CITY_NEAR, horizon, "#0a0a0c", 0.015, "#d4a017", t);
    streetGround(horizon, 26);
    wreck(180, 1500, 1.1, 5);
    wreck(880, 1680, 1.5, 9);
    // силуэт героя вдаль
    heroSilhouette(W / 2 + 60, 1420, 0.9, "idle", 0);
  }

  function sceneHeroFlashlight(t) { // 12–15 с: герой с фонариком (правило 1)
    fillBG("#08080a");
    var horizon = 1120;
    drawSkyline(CITY_NEAR, horizon, "#0a0a0c", 0.01, "#d4a017", t);
    streetGround(horizon, 20);
    wreck(200, 1560, 1.2, 5);
    var hx = lerp(300, 520, smooth((t - 12) / 3));
    var hp = heroSilhouette(hx, 1500, 1.25, "walk", (t - 12) * 5);
    flashlightCone(hp.handX, hp.handY, -8 + Math.sin((t - 12) * 2) * 10, 900, 0.28, 1, Math.floor(t * FPS));
  }

  function sceneRules(t) { // 15–35 с: правила 2–6, комната
    var idx = clamp(Math.floor((t - 15) / 4), 0, 4); // 15..35 шаг 4
    var lt = t - (15 + idx * 4);                     // локальное время 0..4
    var shake = idx === 2 ? Math.sin(t * 46) * 4 : 0; // правило 4 (стук уже был)
    ctx.save();
    ctx.translate(shake * 0.4, shake);
    var doorOpen = idx === 4 && t > 33 ? smooth((t - 33) / 2) * 0.12 : 0;
    room(t, false, doorOpen, idx >= 2 ? smooth(lt / 1.2) : 0);
    // луч фонарика исследует комнату
    var ang = [-15, 20, -30, 5, 12][idx] + Math.sin(lt * 2.4) * 14;
    flashlightCone(760, 1180, ang + 180, 1050, 0.24, 0.9, Math.floor(t * FPS));
    // правило 2: дубинка на столе
    if (idx >= 0) {
      ctx.save();
      ctx.translate(430, 1236); ctx.rotate(-0.15);
      ctx.fillStyle = "#2b2118"; ctx.fillRect(-90, -12, 180, 24);
      ctx.fillStyle = "#3a2c1c"; ctx.fillRect(40, -16, 60, 32);
      ctx.restore();
    }
    // правило 3: рюкзак + бутылка появляются
    if (idx >= 1) {
      ctx.fillStyle = "#141812";
      roundRect(560, 1330, 150, 190, 26); ctx.fill();
      ctx.fillStyle = "#1d241c"; roundRect(580, 1300, 110, 60, 16); ctx.fill();
      ctx.fillStyle = rgba(120, 160, 190, 0.5); ctx.fillRect(740, 1350, 44, 120);
    }
    // правило 5: вслушивается — жест «тихо» (палем у губ) + звуковые дуги у двери
    if (idx === 3) {
      var pulse = (lt * 1.6) % 1;
      ctx.strokeStyle = rgba(138, 138, 138, 0.5 * (1 - pulse));
      ctx.lineWidth = 6;
      for (var i = 0; i < 3; i++) {
        var rr = 60 + i * 55 + pulse * 60;
        ctx.beginPath(); ctx.arc(850, 900, rr, Math.PI * 0.75, Math.PI * 1.25); ctx.stroke();
      }
    }
    // правило 6: силуэт героя ждёт у окна, виднеется заря
    if (idx === 4) {
      var dawn = smooth((t - 30) / 5);
      var dg = ctx.createLinearGradient(80, 480, 420, 940);
      dg.addColorStop(0, rgba(212, 160, 23, 0.0));
      dg.addColorStop(1, rgba(212, 120, 40, 0.35 * dawn));
      ctx.fillStyle = dg; ctx.fillRect(80, 480, 340, 460);
      heroSilhouette(300, 1400, 1.0, "idle", 0);
    } else {
      heroSilhouette(660, 1400, 1.05, idx === 0 ? "walk" : "idle", lt * 4);
    }
    ctx.restore();
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function sceneLightTurnsOn(t) { // 35–38 с: свет включается сам (шёпот)
    fillBG("#0a0a0a");
    room(t, true, 0, 1);
    // лампа мигает и разгорается
    var rnd = mulberry32(Math.floor(t * FPS) * 104729);
    var on = t > 36 ? (rnd() < 0.15 ? 0.4 : 1) : (rnd() < 0.5 ? 0.15 : 0.6);
    ctx.fillStyle = rgba(255, 220, 150, 0.10 * on);
    ctx.fillRect(0, 0, W, H);
    heroSilhouette(620, 1400, 1.1, "idle", 0);
    // тень у двери
    ctx.fillStyle = rgba(0, 0, 0, 0.6);
    ctx.fillRect(700, 520, 300, 880);
    // глаза за дверью проступают к 37 с
    var eA = smooth((t - 36.5) / 1.5);
    if (eA > 0) {
      ctx.fillStyle = rgba(232, 232, 232, eA);
      ctx.beginPath(); ctx.arc(830, 900, 7, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(880, 910, 7, 0, 7); ctx.fill();
    }
  }

  function sceneDoorOpens(t) { // 38–42 с: дверь открывается, зомби
    fillBG("#0a0a0a");
    var o = smooth((t - 38) / 1.2);
    room(t, true, o, Math.max(0, 1 - o * 2));
    // коридор за дверью залит красным
    ctx.fillStyle = rgba(139, 0, 0, 0.35 * o);
    ctx.fillRect(700, 520, 300, 880);
    var z = 0;
    for (var i = 0; i < 3; i++) {
      var zz = o * (1 - i * 0.12);
      if (zz > 0.05) {
        zombie(850 - i * 26, 1400 - i * 12, 1.0 * zz + 0.4, t * 6 + i, i === 1);
      }
    }
    heroSilhouette(430, 1400, 1.1, "idle", 0);
    glitch(t, o * 0.8);
  }

  function sceneChase(t) { // 42–47 с: погоня по улице
    fillBG("#0b0a0c");
    var horizon = 1050;
    drawSkyline(CITY_NEAR, horizon, "#0a0a0c", 0.02, "#d4a017", t);
    streetGround(horizon, 22);
    var speed = (t - 42) * 900;
    // параллакс: мусор/машины летят
    for (var i = 0; i < 5; i++) {
      var wx = ((i * 420 - speed * (0.8 + i * 0.1)) % (W + 500));
      if (wx < -250) wx += W + 500;
      wreck(wx, 1500 + i * 90, 0.8 + i * 0.2, i * 3 + 1);
    }
    // герой бежит влево-вправо (тряска камеры)
    var shake = Math.sin(t * 34) * 8;
    ctx.save(); ctx.translate(shake, Math.abs(Math.sin(t * 17)) * -10);
    var hp = heroSilhouette(W / 2 + 120, 1480, 1.3, "run", t * 16);
    flashlightCone(hp.handX, hp.handY, 172 + Math.sin(t * 9) * 8, 700, 0.3, 0.7, Math.floor(t * FPS));
    ctx.restore();
    // стая зомби справа
    for (var j = 0; j < 6; j++) {
      var zx = W - 60 - j * 130 + Math.sin(t * 8 + j) * 12;
      zombie(zx, 1500 - j * 8, 1.15 - j * 0.06, t * 9 + j * 2, j % 3 === 0);
    }
    glitch(t, 0.5);
  }

  function sceneRooftop(t) { // 47–52 с: крыша, город вдали («их тысячи»)
    fillBG("#0c0a0b");
    var horizon = 900;
    moon(300, 0.5);
    drawSkyline(CITY_FAR, horizon, "#131216", 0.03, "#c9c2a8", t);
    drawSkyline(CITY_NEAR, horizon + 120, "#0a090c", 0.02, "#d4a017", t);
    // край крыши на переднем плане
    ctx.fillStyle = "#070707"; ctx.fillRect(0, 1350, W, H - 1350);
    ctx.fillStyle = "#0d0d0d"; ctx.fillRect(0, 1330, W, 30);
    // сотни точек-силуэтов движутся по улицам — «их тысячи»
    var rnd = mulberry32(4242);
    ctx.fillStyle = "#000";
    for (var i = 0; i < 140; i++) {
      var px = rnd() * W;
      var py = 1000 + rnd() * 300;
      var ps = 0.18 + rnd() * 0.25;
      var ph = t * (4 + rnd() * 3) + i;
      ctx.save(); ctx.translate(px + Math.sin(ph) * 6 * ps * 10, py); ctx.scale(ps, ps);
      ctx.fillRect(-12, -90, 24, 90);
      ctx.beginPath(); ctx.arc(0, -104, 16, 0, 7); ctx.fill();
      ctx.restore();
    }
    // герой на крыше спиной
    heroSilhouette(W / 2 - 180, 1350, 1.25, "idle", 0);
    // зарева пожаров нарастают к 52
    var f = smooth((t - 49) / 3);
    fireGlow(W * 0.8, 860, 500, 0.35 * f, Math.floor(t * FPS));
  }

  function sceneCityBurns(t) { // 52–58 с: город в огне (бас-дроп)
    fillBG("#0a0705");
    var horizon = 1120;
    var p = smooth((t - 52) / 4);
    drawSkyline(CITY_FAR, horizon - 60, "#1a0f0a", 0.10 * p, "#d4a017", t);
    drawSkyline(CITY_NEAR, horizon, "#120a07", 0.16 * p, "#ff7a20", t);
    streetGround(horizon, 30 + 20 * p);
    // небо дышит огнём
    fireGlow(W * 0.5, horizon - 100, 900, 0.5 + 0.2 * Math.sin(t * 3), Math.floor(t * FPS));
    fireGlow(W * 0.15, horizon + 40, 420, 0.4 * p, Math.floor(t * FPS) + 5);
    fireGlow(W * 0.85, horizon + 60, 460, 0.45 * p, Math.floor(t * FPS) + 9);
    // дым
    ctx.fillStyle = rgba(10, 10, 10, 0.35 * p);
    ctx.fillRect(0, 0, W, 300);
    heroSilhouette(W / 2, 1500, 1.15, "idle", 0);
    glitch(t, 0.35);
  }

  function sceneTeaser(t) { // 58–60 с: тизер части 2
    fillBG("#050505");
    var p = smooth((t - 58) / 1.0);
    // тлеющий горизонт
    fireGlow(W * 0.5, H * 0.72, 700, 0.22 * (1 - p * 0.4), Math.floor(t * FPS));
    drawSkyline(CITY_NEAR, H * 0.78, "#070606", 0.04, "#8b0000", t);
    ctx.save();
    ctx.globalAlpha = p;
    ctx.textAlign = "center";
    ctx.font = "900 110px 'Impact','Arial Black',sans-serif";
    ctx.lineWidth = 14; ctx.strokeStyle = "rgba(0,0,0,.9)";
    ctx.strokeText("ПРОДОЛЖЕНИЕ СЛЕДУЕТ", W / 2, H * 0.3);
    ctx.fillStyle = COL.blood;
    ctx.fillText("ПРОДОЛЖЕНИЕ СЛЕДУЕТ", W / 2, H * 0.3);
    ctx.restore();
  }

  // -------------------------------------------------------------- MAIN ---
  function renderFrame(t) {
    t = clamp(t, 0, DUR);
    window.__frameReady = false;

    if (t < 3) sceneBlack(t);
    else if (t < 8) sceneCityDies(t);
    else if (t < 12) sceneEmptyStreet(t);
    else if (t < 15) sceneHeroFlashlight(t);
    else if (t < 35) sceneRules(t);
    else if (t < 38) sceneLightTurnsOn(t);
    else if (t < 42) sceneDoorOpens(t);
    else if (t < 47) sceneChase(t);
    else if (t < 52) sceneRooftop(t);
    else if (t < 58) sceneCityBurns(t);
    else sceneTeaser(t);

    // глобальная обработка: виньетка + зерно плёнки + лёгкий glitch
    vignette(0.62);
    grain(t, 0.055);
    if (t >= 35 && t < 47) glitch(t, 0.4);
    if (t < 0.4) glitch(t, 1.2);           // глитч на старте (удар)
    if (t > 51.6 && t < 52.4) glitch(t, 1.6); // глитч на дропе

    drawSubtitles(t);

    // буквы-титры ACT-переходы не нужны — чисто вертикальный монтаж
    window.__frameReady = true;
  }

  // --------------------------------------------------------- bootstrap ---
  var params = new URLSearchParams(location.search);
  var q = parseFloat(params.get("t"));

  window.renderFrame = renderFrame;

  if (!isNaN(q)) {
    renderFrame(q);
  } else {
    // live-превью с ползунком
    var slider = document.getElementById("slider");
    var label = document.getElementById("timelabel");
    var playing = false, last = 0;
    function loop(ts) {
      if (playing) {
        if (last) {
          var nt = (parseFloat(slider.value) + (ts - last) / 1000) % DUR;
          slider.value = String(nt);
        }
        last = ts;
      } else last = 0;
      var tt = parseFloat(slider.value);
      label.textContent = "t = " + tt.toFixed(3) + " s";
      renderFrame(tt);
      requestAnimationFrame(loop);
    }
    slider.addEventListener("input", function () { playing = false; });
    document.getElementById("playBtn").addEventListener("click", function () {
      playing = !playing;
      this.textContent = playing ? "⏸ Pause" : "▶ Play (live)";
    });
    requestAnimationFrame(loop);
  }
})();
