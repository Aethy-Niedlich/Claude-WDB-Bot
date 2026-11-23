// ==UserScript==
// @name         WDB Tool
// @namespace    wdb-practice-bot
// @version      0.5.0
// @description  Practice/private rooms only. Records physics and your own key presses to a downloadable file. Sends a key ONLY when you click a Test button.
// @homepageURL  https://github.com/Aethy-Niedlich/Claude-WDB-Bot
// @updateURL    https://raw.githubusercontent.com/Aethy-Niedlich/Claude-WDB-Bot/main/wdb-tool.user.js
// @downloadURL  https://raw.githubusercontent.com/Aethy-Niedlich/Claude-WDB-Bot/main/wdb-tool.user.js
// @match        https://bonk.io/gameframe-release.html*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // Never install twice (for example if the page reloads the frame).
  if (window.__wdbTool) return;

  // ---------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------
  var VERSION = '0.5.0';
  var MODULE_NAME = 'physics/box2dweb/Box2DModuleGJMod'; // the game's physics library
  var MAX_TICKS = 120000;                                 // about 1 hour at 30 ticks/second

  // Keys the key test can press. Named by physical key on purpose:
  // we have not yet confirmed which of space / t is heavy and which is grapple.
  var KEYS = {
    right: { key: 'd', code: 'KeyD',  keyCode: 68 },
    left:  { key: 'a', code: 'KeyA',  keyCode: 65 },
    up:    { key: 'w', code: 'KeyW',  keyCode: 87 },
    down:  { key: 's', code: 'KeyS',  keyCode: 83 },
    space: { key: ' ', code: 'Space', keyCode: 32 },
    t:     { key: 't', code: 'KeyT',  keyCode: 84 }
  };

  // ---------------------------------------------------------------
  // State (everything the tool remembers lives here)
  // ---------------------------------------------------------------
  var state = {
    logging: false,   // the RECORD switch. Starts OFF on purpose.
    bot: false,       // the BOT switch. Nothing acts yet; it only shows in the panel.
    keys: 0,          // how many of your own key events were recorded
    attachedTicks: 0, // how many logged ticks had a rope (grapple) on the ball
    hooked: false,    // true once we are attached to the game's physics
    ticks: 0,         // how many physics ticks we have logged
    lines: [],        // one text line per tick
    error: '',        // last problem, shown in the panel
    result: ''        // result of the last key test, shown in the panel
  };
  var radiusById = {}; // remembers each object's radius so we only look it up once
  var test = null;     // set while a key test is running
  var targetMode = 'renderer'; // where test key events are sent: renderer / document / window
  window.__wdbTool = { state: state };

  function round3(n) { return Math.round(n * 1000) / 1000; }

  // ---------------------------------------------------------------
  // GAME-READING CODE (keep all of this in one place; a bonk.io
  // update is most likely to break these few functions)
  // ---------------------------------------------------------------
  function findPhysicsModule() {
    try {
      return window.requirejs.s.contexts._.defined[MODULE_NAME] || null;
    } catch (e) {
      return null;
    }
  }

  function radiusOf(body, id) {
    if (Object.prototype.hasOwnProperty.call(radiusById, id)) return radiusById[id];
    var r = null; // null means "not a simple circle"
    try {
      var fixture = body.GetFixtureList();
      if (fixture) {
        var shape = fixture.GetShape();
        if (typeof shape.GetRadius === 'function') r = round3(shape.GetRadius());
      }
    } catch (e) { /* leave r as null */ }
    radiusById[id] = r;
    return r;
  }

  // Reads every moving object right after one physics tick.
  // Returns a list of [id, x, y, vx, vy, radius].
  function readBodies(world) {
    var bodies = [];
    for (var b = world.GetBodyList(); b; b = b.GetNext()) {
      if (b.GetType() !== 2) continue;           // 2 = moving objects only
      var tag = b.GetUserData();
      var id = tag && tag.arrayID !== undefined ? tag.arrayID : -1;
      var p = b.GetPosition();
      var v = b.GetLinearVelocity();
      bodies.push([id, round3(p.x), round3(p.y), round3(v.x), round3(v.y), radiusOf(b, id)]);
    }
    return bodies;
  }

  // Reads the ropes (grapples) in the world. Returns a list of
  // [type, bodyA id, bodyB id, rope length]. The permanent joint that pins the
  // arena object to the world (it touches the "ground" body, id -1) is left out.
  function idOfBody(body) {
    var tag = body.GetUserData();
    return tag && tag.arrayID !== undefined ? tag.arrayID : -9;
  }

  function readJoints(world) {
    var list = [];
    try {
      for (var j = world.GetJointList(); j; j = j.GetNext()) {
        var a = idOfBody(j.GetBodyA()), b = idOfBody(j.GetBodyB());
        if (a === -1 || b === -1) continue;
        var len = null;
        try { len = round3(j.GetLength()); } catch (e) { /* not every joint has a length */ }
        list.push([j.GetType(), a, b, len]);
      }
    } catch (e) {
      state.error = 'cannot read ropes: ' + e.message;
    }
    return list;
  }

  function installHook(physics) {
    var proto = physics.Dynamics.b2World.prototype;
    var original = proto.Step;
    proto.Step = function () {
      var result = original.apply(this, arguments); // let the game do its normal work first
      if (state.logging || test) {
        try {
          var bodies = readBodies(this);
          var joints = readJoints(this);
          if (state.logging) logTick(bodies, joints);
          if (test) updateTest(bodies);
        } catch (e) { state.error = 'read error: ' + e.message; }
      }
      return result;
    };
    state.hooked = true;
  }

  // Wait for the game to load its physics library, then attach.
  var waitTimer = setInterval(function () {
    var physics = findPhysicsModule();
    if (physics) {
      clearInterval(waitTimer);
      try { installHook(physics); } catch (e) { state.error = 'could not attach: ' + e.message; }
    }
  }, 200);

  // ---------------------------------------------------------------
  // Log file
  // ---------------------------------------------------------------
  function logTick(bodies, joints) {
    if (state.ticks >= MAX_TICKS) {
      setLogging(false);
      state.error = 'Size limit reached, logging stopped. Download the log.';
      return;
    }
    state.ticks++;
    var line = { n: state.ticks, t: Math.round(performance.now() * 10) / 10, b: bodies };
    if (joints.length) line.j = joints;      // only present while a rope exists
    if (ballIsAttached(line)) state.attachedTicks++;
    state.lines.push(JSON.stringify(line));
  }

  function pad(n) { return (n < 10 ? '0' : '') + n; }

  function downloadLog() {
    var d = new Date();
    var stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
                pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    var meta = JSON.stringify({
      type: 'meta',
      tool: 'wdb-tool ' + VERSION,
      savedAt: d.toISOString(),
      ticks: state.ticks,
      tickFields: ['n', 't', 'b'],
      bodyColumns: ['id', 'x', 'y', 'vx', 'vy', 'radius'],
      keyLines: 'k = down or up, code = physical key, n = last logged tick before the key event',
      ropeField: 'j = ropes (grapples), each [type, bodyA id, bodyB id, rope length]; only present while a rope exists',
      keys: state.keys
    });
    var blob = new Blob([meta + '\n' + state.lines.join('\n') + '\n'], { type: 'application/x-ndjson' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'wdb-log-' + stamp + '.jsonl';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function clearLog() {
    state.lines = [];
    state.ticks = 0;
    state.keys = 0;
    state.attachedTicks = 0;
    state.error = '';
  }

  // ---------------------------------------------------------------
  // Your own key presses (real keyboard only, while RECORD is on)
  // ---------------------------------------------------------------
  function noteKey(type, e) {
    if (!state.logging) return;
    if (!e.isTrusted) return;   // ignore keys sent by this tool's own tests
    if (e.repeat) return;       // ignore the keyboard's auto-repeat
    var tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return; // never record typing in text boxes
    state.keys++;
    state.lines.push(JSON.stringify({
      k: type,
      code: e.code,
      n: state.ticks,
      t: Math.round(performance.now() * 10) / 10
    }));
  }
  window.addEventListener('keydown', function (e) { noteKey('down', e); }, true);
  window.addEventListener('keyup', function (e) { noteKey('up', e); }, true);

  // ---------------------------------------------------------------
  // Key test: press ONE key when you click a Test button, then
  // report which object moved. Nothing here runs by itself.
  // ---------------------------------------------------------------
  function getTarget() {
    if (targetMode === 'window') return window;
    if (targetMode === 'document') return document;
    return document.getElementById('gamerenderer') || document;
  }

  function sendKey(def, type) {
    var ev = new KeyboardEvent(type, {
      key: def.key, code: def.code,
      keyCode: def.keyCode, which: def.keyCode,
      bubbles: true, cancelable: true
    });
    // Some browsers ignore keyCode in the constructor; force it if so.
    if (ev.keyCode !== def.keyCode) {
      try { Object.defineProperty(ev, 'keyCode', { get: function () { return def.keyCode; } }); } catch (e) {}
    }
    if (ev.which !== def.keyCode) {
      try { Object.defineProperty(ev, 'which', { get: function () { return def.keyCode; } }); } catch (e) {}
    }
    getTarget().dispatchEvent(ev);
  }

  function updateTest(bodies) {
    for (var i = 0; i < bodies.length; i++) {
      var b = bodies[i], id = b[0];
      var s = test.stats[id];
      if (!s) s = test.stats[id] = { x0: b[1], y0: b[2], x1: b[1], y1: b[2], minY: b[2], peakVx: 0 };
      s.x1 = b[1];
      s.y1 = b[2];
      if (b[2] < s.minY) s.minY = b[2];
      if (Math.abs(b[3]) > s.peakVx) s.peakVx = Math.abs(b[3]);
    }
  }

  function signed(n) { return (n >= 0 ? '+' : '') + n.toFixed(1); }

  function finishTest(keyName) {
    var ids = Object.keys(test.stats).sort(function (a, b) { return a - b; });
    var lines;
    if (!ids.length) {
      lines = ['No physics ticks seen. Is a round running and are you alive?'];
    } else {
      lines = ids.map(function (id) {
        var s = test.stats[id];
        return 'id' + id + ': moved x ' + signed(s.x1 - s.x0) + ', y ' + signed(s.y1 - s.y0) +
               ', peak speed ' + s.peakVx.toFixed(1) + ', rose ' + (s.y0 - s.minY).toFixed(1);
      });
    }
    state.result = 'Test "' + keyName + '" via ' + targetMode + ':\n' + lines.join('\n');
    test = null;
    refreshPanel();
  }

  function runKeyTest(keyName, holdMs) {
    if (test) return;
    if (!state.hooked) { state.result = 'Not attached to the game yet.'; refreshPanel(); return; }
    var def = KEYS[keyName];
    test = { stats: {} };
    state.result = 'KEY TEST RUNNING: hands off the keyboard...';
    refreshPanel();
    setTimeout(function () {                 // let a few ticks be read first
      try { sendKey(def, 'keydown'); } catch (e) { state.error = 'key error: ' + e.message; }
      setTimeout(function () {
        try { sendKey(def, 'keyup'); } catch (e) { state.error = 'key error: ' + e.message; }
        setTimeout(function () { finishTest(keyName); }, 500); // watch the aftermath
      }, holdMs);
    }, 400);
  }

  // ---------------------------------------------------------------
  // Bounce report: how bouncy is each surface? Works on the log in
  // memory, so click it BEFORE you reload the page or press Clear.
  // ---------------------------------------------------------------
  var BALL_ID = 4;               // the ball's tag (it was id 4 in every log so far)
  var ARENA_OBJECT_ID = 6;       // the big arena object, not a player
  var GRAVITY_PER_TICK = 0.333;  // measured: the ball gains this much downward speed per tick

  // True if a rope (grapple) is attached to the ball in this tick.
  function ballIsAttached(tick) {
    if (!tick.j) return false;
    for (var i = 0; i < tick.j.length; i++) {
      if (tick.j[i][1] === BALL_ID || tick.j[i][2] === BALL_ID) return true;
    }
    return false;
  }

  function findBody(tick, id) {
    for (var i = 0; i < tick.b.length; i++) {
      if (tick.b[i][0] === id) return tick.b[i];
    }
    return null;
  }

  // True if any player is close enough to the ball to have touched it.
  function playerNear(tick, ball) {
    for (var i = 0; i < tick.b.length; i++) {
      var o = tick.b[i];
      if (o[0] === BALL_ID || o[0] === ARENA_OBJECT_ID) continue;
      var reach = (o[5] || 1) + (ball[5] || 1) + 0.6;
      if (Math.hypot(o[1] - ball[1], o[2] - ball[2]) < reach) return true;
    }
    return false;
  }

  function median(sorted) {
    var m = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
  }

  function analyseBounces(lines) {
    var ticks = [];
    for (var i = 0; i < lines.length; i++) {
      var o;
      try { o = JSON.parse(lines[i]); } catch (e) { continue; }
      if (o && o.b) ticks.push(o);   // skip key lines
    }
    var ratios = { 'floor/bump': [], 'ceiling': [], 'left wall': [], 'right wall': [] };
    var other = 0, nearPlayer = 0, roped = 0;

    for (var j = 1; j < ticks.length; j++) {
      var a = ticks[j - 1], c = ticks[j];
      if (c.n !== a.n + 1 || c.t - a.t > 200) continue;  // only back-to-back ticks
      var b0 = findBody(a, BALL_ID), b1 = findBody(c, BALL_ID);
      if (!b0 || !b1) continue;
      // Speed just before the hit = last tick's speed plus this tick's gravity.
      var vx0 = b0[3], vy0 = b0[4] + GRAVITY_PER_TICK;
      var vx1 = b1[3], vy1 = b1[4];
      if (Math.abs(vx1 - vx0) < 1.5 && Math.abs(vy1 - vy0) < 1.5) continue; // no sudden change: not a hit
      if (ballIsAttached(a) || ballIsAttached(c)) { roped++; continue; }  // a rope is pulling: not a bounce
      if (playerNear(a, b0) || playerNear(c, b1)) { nearPlayer++; continue; }

      var x = b1[1], y = b1[2];
      var flippedY = (vy0 > 3 && vy1 < 0) || (vy0 < -3 && vy1 > 0);
      var flippedX = (vx0 > 3 && vx1 < 0) || (vx0 < -3 && vx1 > 0);
      var inside = x > 2.5 && x < 58.3;   // inside the arena, not down in a net
      if (flippedY && inside && Math.abs(vy1 - vy0) >= Math.abs(vx1 - vx0)) {
        ratios[y > 20.8 ? 'floor/bump' : 'ceiling'].push(-vy1 / vy0);
      } else if (flippedX && y < 27) {
        ratios[x < 30.4 ? 'left wall' : 'right wall'].push(-vx1 / vx0);
      } else {
        other++;
      }
    }

    var out = ['Bounce report (ball; bounce = speed after / speed before):'];
    var any = false;
    Object.keys(ratios).forEach(function (name) {
      var r = ratios[name].slice().sort(function (p, q) { return p - q; });
      if (!r.length) { out.push(name + ': no clean hits found'); return; }
      any = true;
      var lo = r[Math.floor(r.length * 0.25)];
      var hi = r[Math.min(r.length - 1, Math.floor(r.length * 0.75))];
      out.push(name + ': ' + r.length + ' hits, median ' + median(r).toFixed(2) +
               ' (middle half ' + lo.toFixed(2) + ' to ' + hi.toFixed(2) + ')');
    });
    out.push('skipped: ' + roped + ' while on a rope, ' + nearPlayer + ' near a player, ' + other + ' elsewhere');
    if (!any) out.push('Hit the ball into the floor, walls and ceiling while RECORD is on, then try again.');
    return out.join('\n');
  }

  function runBounceReport() {
    state.result = analyseBounces(state.lines);
    refreshPanel();
  }
  window.__wdbTool.analyseBounces = analyseBounces;

  // ---------------------------------------------------------------
  // Panel (the visible switch and buttons)
  // ---------------------------------------------------------------
  var ui = {};

  function setLogging(on) {
    state.logging = !!on;
    refreshPanel();
  }

  function makeButton(label, onClick) {
    var btn = document.createElement('button');
    btn.textContent = label;
    btn.tabIndex = -1; // so Space/Enter never "press" a panel button while you play
    btn.style.cssText = 'margin:4px 4px 0 0;padding:3px 8px;font:12px sans-serif;cursor:pointer;' +
                        'background:#333;color:#fff;border:1px solid #777;border-radius:4px';
    // Don't let the button take keyboard focus away from the game.
    btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', onClick);
    return btn;
  }

  function buildPanel() {
    var box = document.createElement('div');
    box.id = 'wdb-tool-panel';
    box.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;' +
      'background:rgba(20,20,30,0.92);color:#fff;font:12px/1.4 sans-serif;padding:8px 10px;' +
      'border:1px solid #555;border-radius:6px;min-width:200px;max-width:420px;user-select:none';

    var title = document.createElement('div');
    title.textContent = 'WDB TOOL ' + VERSION + ' (keys sent only when you click a Test button)';
    title.style.cssText = 'font-weight:bold;margin-bottom:4px';

    var badges = document.createElement('div');
    ui.botBadge = document.createElement('span');
    ui.recBadge = document.createElement('span');
    [ui.botBadge, ui.recBadge].forEach(function (el) {
      el.style.cssText = 'font-size:14px;font-weight:bold;padding:2px 6px;border-radius:4px;' +
                         'display:inline-block;margin-right:6px';
      badges.appendChild(el);
    });

    ui.info = document.createElement('div');
    ui.info.style.cssText = 'margin-top:4px;white-space:pre';

    var row1 = document.createElement('div');
    ui.botToggle = makeButton('', function () { state.bot = !state.bot; refreshPanel(); });
    ui.recToggle = makeButton('', function () { setLogging(!state.logging); });
    row1.appendChild(ui.botToggle);
    row1.appendChild(ui.recToggle);
    row1.appendChild(makeButton('Download log', downloadLog));
    row1.appendChild(makeButton('Clear', clearLog));

    var row2 = document.createElement('div');
    row2.appendChild(makeButton('Test: hold D 0.5s', function () { runKeyTest('right', 500); }));
    row2.appendChild(makeButton('Test: tap W', function () { runKeyTest('up', 100); }));
    ui.target = makeButton('', function () {
      targetMode = targetMode === 'renderer' ? 'document' : (targetMode === 'document' ? 'window' : 'renderer');
      refreshPanel();
    });
    row2.appendChild(ui.target);
    row2.appendChild(makeButton('Bounce report', runBounceReport));

    ui.result = document.createElement('div');
    ui.result.style.cssText = 'margin-top:6px;white-space:pre-wrap;color:#ffd866';

    box.appendChild(title);
    box.appendChild(badges);
    box.appendChild(ui.info);
    box.appendChild(row1);
    box.appendChild(row2);
    box.appendChild(ui.result);
    document.body.appendChild(box);
    refreshPanel();
  }

  var lastTicks = 0, lastTime = 0, rate = 0;

  function refreshPanel() {
    if (!ui.botBadge) return;
    ui.botBadge.textContent = state.bot ? 'BOT ON' : 'BOT OFF';
    ui.botBadge.style.background = state.bot ? '#1b7f3a' : '#444';
    ui.recBadge.textContent = state.logging ? 'RECORD ON' : 'RECORD OFF';
    ui.recBadge.style.background = state.logging ? '#b00020' : '#444';
    ui.botToggle.textContent = state.bot ? 'Bot: turn OFF' : 'Bot: turn ON';
    ui.recToggle.textContent = state.logging ? 'Record: turn OFF' : 'Record: turn ON';
    ui.target.textContent = 'Key target: ' + targetMode;
    var status = state.hooked ? 'attached to game physics' : 'waiting for the game to load...';
    ui.info.textContent =
      status + '\n' +
      'ticks logged: ' + state.ticks + '   rate: ' + rate.toFixed(1) + '/s   keys recorded: ' + state.keys + '\n' +
      'ticks with a rope on the ball: ' + state.attachedTicks +
      (state.bot ? '\nBOT is ON but has no actions built yet' : '') +
      (state.error ? '\n' + state.error : '');
    ui.result.textContent = state.result;
  }

  setInterval(function () {
    var now = performance.now();
    if (lastTime) rate = (state.ticks - lastTicks) / ((now - lastTime) / 1000);
    lastTicks = state.ticks;
    lastTime = now;
    if (rate < 0) rate = 0; // happens right after "Clear"
    refreshPanel();
  }, 1000);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', buildPanel);
  } else {
    buildPanel();
  }
})();
