// ==UserScript==
// @name         WDB Tool
// @namespace    wdb-practice-bot
// @version      0.8.1
// @description  Practice/private rooms only. Records physics and your own key presses to a downloadable file. Sends keys ONLY when you click a Test or Lab button.
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
  var VERSION = '0.8.1';
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
    score: { n: 0, within1: 0, within2: 0, within4: 0, errs: [] }, // live self-score of the ball predictor
    labTrials: [],    // finished control-lab trials (saved in the log's first line)
    moveTrials: [],   // finished move-test trials (saved in the log's first line)
    hooked: false,    // true once we are attached to the game's physics
    ticks: 0,         // how many physics ticks we have logged
    lines: [],        // one text line per tick
    error: '',        // last problem, shown in the panel
    result: ''        // result of the last key test, shown in the panel
  };
  var radiusById = {}; // remembers each object's radius so we only look it up once
  var stepCount = 0;   // physics steps seen since the page loaded (used to find the "phase" of a key press)
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
      stepCount++;
      if (state.logging || test || lab) {
        try {
          var bodies = readBodies(this);
          var joints = readJoints(this);
          if (state.logging) { logTick(bodies, joints); scoreTick(bodies, joints); }
          if (test) updateTest(bodies);
          if (lab) labTick(bodies, joints);
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
      keys: state.keys,
      predictorScore: scoreSummary(),
      labTrials: state.labTrials,
      moveTrials: state.moveTrials
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
    resetScore();
    state.labTrials = [];
    state.moveTrials = [];
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
  // Ball model and live self-score.
  // While the ball is free (no rope on it), it falls with constant gravity,
  // and when it touches a wall, the ceiling or the floor it stops in that
  // direction and keeps sliding along the surface at the same speed.
  // Measured from recordings; the numbers below come from the arena shape.
  // ---------------------------------------------------------------
  var BALL_ID = 4;               // the ball's tag (it was id 4 in every log so far)
  var ARENA_OBJECT_ID = 6;       // the big arena object, not a player
  var GRAVITY_PER_TICK = 0.3333; // measured: the ball gains this much downward speed per tick
  var TICK_SECONDS = 1 / 30;     // measured: one physics tick is 1/30 of a second
  var PREDICT_TICKS = 15;        // half a second ahead
  var WALL_LEFT = 2.917, WALL_RIGHT = 57.917;   // where the ball's centre stops at a side wall
  var CEILING_Y = 1.458, FLOOR_Y = 38.54;       // where the ball's centre stops at the ceiling / floor
  var NET_TOP_Y = 27.04;                        // below this height the side walls are open (the nets)

  // Where will the ball be after `steps` ticks, if nobody touches it?
  function predictBall(x, y, vx, vy, steps) {
    for (var i = 0; i < steps; i++) {
      vy += GRAVITY_PER_TICK;
      var nx = x + vx * TICK_SECONDS, ny = y + vy * TICK_SECONDS;
      if (ny > FLOOR_Y) { ny = FLOOR_Y; vy = 0; }
      else if (ny < CEILING_Y) { ny = CEILING_Y; vy = 0; }
      if (ny < NET_TOP_Y) {
        if (nx > WALL_RIGHT) { nx = WALL_RIGHT; vx = 0; }
        else if (nx < WALL_LEFT) { nx = WALL_LEFT; vx = 0; }
      }
      x = nx; y = ny;
    }
    return [x, y];
  }

  // Self-score: one prediction at a time. When the half second is up, compare with
  // where the ball really is. Only counts moments where the ball is free, inside the
  // arena and moving; any rope, nearby player or pause cancels the prediction.
  var pending = null, lastScoreTime = 0, scoreSeq = 0;

  function resetScore() {
    state.score = { n: 0, within1: 0, within2: 0, within4: 0, errs: [] };
    pending = null;
  }

  function recordScore(err) {
    var sc = state.score;
    sc.n++;
    if (err <= 1) sc.within1++;
    if (err <= 2) sc.within2++;
    if (err <= 4) sc.within4++;
    sc.errs.push(err);
    if (sc.errs.length > 5000) sc.errs.shift();
  }

  function scoreTick(bodies, joints) {
    var now = performance.now();
    if (lastScoreTime && now - lastScoreTime > 200) pending = null; // a pause: start over
    lastScoreTime = now;
    scoreSeq++;
    var tick = { b: bodies, j: joints };
    var ball = findBody(tick, BALL_ID);
    var valid = ball && !ballIsAttached(tick) && !playerNear(tick, ball) && ball[1] > 1.9 && ball[1] < 58.9;
    if (!valid) { pending = null; return; }
    if (pending && scoreSeq === pending.due) {
      recordScore(Math.hypot(pending.x - ball[1], pending.y - ball[2]));
      pending = null;
    }
    if (!pending && Math.hypot(ball[3], ball[4]) > 3) {
      var p = predictBall(ball[1], ball[2], ball[3], ball[4], PREDICT_TICKS);
      pending = { due: scoreSeq + PREDICT_TICKS, x: p[0], y: p[1] };
    }
  }

  function scoreSummary() {
    var sc = state.score;
    if (!sc.n) return 'predictor (0.5 s ahead): nothing scored yet';
    var sorted = sc.errs.slice().sort(function (p, q) { return p - q; });
    var med = sorted[Math.floor(sorted.length / 2)];
    function pct(k) { return Math.round(100 * k / sc.n) + '%'; }
    var verdict = sc.n < 100 ? 'need 100+ scored (' + sc.n + ' so far)'
                : (sc.within2 / sc.n >= 0.9 ? 'MET' : 'NOT MET');
    return 'predictor (0.5 s ahead): ' + sc.n + ' scored, median error ' + med.toFixed(2) + '\n' +
           'within 1 / 2 / 4 units: ' + pct(sc.within1) + ' / ' + pct(sc.within2) + ' / ' + pct(sc.within4) + '\n' +
           'target (2 units, 9 in 10): ' + verdict;
  }

  // ---------------------------------------------------------------
  // Bounce report: how bouncy is each surface? Works on the log in
  // memory, so click it BEFORE you reload the page or press Clear.
  // ---------------------------------------------------------------

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
  // Control lab: do one named action many times and measure what it does.
  // It only runs when you click a Lab button, in a SOLO room. Key presses
  // are timed in game ticks (not browser timers), and every key it pressed
  // is released when it finishes or when you click Stop lab.
  // ---------------------------------------------------------------
  var TAP_CHOICES = [2, 3, 4, 5, 6, 7, 8];   // how many ticks the keys are held (30 ticks = 1 second)
  var LAB_TRIALS = 10;              // trials per button click
  var LAB_STAND_WATCH_TICKS = 300;  // standing trials are watched for at most 10 seconds, but end shortly after you land
  var LAB_RUN_WATCH_TICKS = 30;     // run-first: you hold the direction key for this long, and 'moved' is measured here
  var LAB_RUN_MAX_TICKS = 150;      // run-first trials are watched until you land, at most 5 seconds
  var LAB_RUNUP_TICKS = 8;          // with "Run first": run this long before the action starts
  var LAB_PHASES = 8;               // a press is placed at one of this many points of the game's step rhythm
  var SCAN_TRIALS = 16;             // phase scan: every phase twice
  var labSettings = { tapIndex: 1, holdSideways: false, heavyOffset: -1, scan: false };  // heavy goes 1 tick before (-1) or after (+1) the grapple
  var lab = null;                   // set while the lab is running
  var labNote = '';

  // Each action is a list of [tick, key, 'down' or 'up'], counted from the action start.
  // n = how many ticks the keys are held; off = where heavy goes relative to the grapple (-1 = a tick
  // before, +1 = a tick after). Heavy is never pressed on the very same tick as the grapple, because
  // the game sometimes ignores the grapple then.
  var ACTIONS = {
    'T':          function (n) { return [[0, 't', 'down'], [n, 't', 'up']]; },
    'W':          function (n) { return [[0, 'up', 'down'], [n, 'up', 'up']]; },
    'W+T':        function (n) { return [[0, 'up', 'down'], [0, 't', 'down'], [n, 'up', 'up'], [n, 't', 'up']]; },
    // "jump, then grapple, and hold up": W goes down first and stays down until the grapple is released
    'W>T hold W': function (n) { return [[0, 'up', 'down'], [2, 't', 'down'], [2 + n, 't', 'up'], [2 + n, 'up', 'up']]; },
    // same, but W is never released until the trial ends (you usually keep W held after the grapple)
    'W>T keep W': function (n) { return [[0, 'up', 'down'], [2, 't', 'down'], [2 + n, 't', 'up']]; },
    'Space+T':    function (n, off) { return [[0, 't', 'down'], [n, 't', 'up'], [off, 'space', 'down'], [off + n, 'space', 'up']]; },
    'W+Space+T':  function (n, off) { return [[0, 'up', 'down'], [n, 'up', 'up'], [0, 't', 'down'], [n, 't', 'up'],
                                              [off, 'space', 'down'], [off + n, 'space', 'up']]; },
    'W then T':   function (n) { return [[0, 'up', 'down'], [2, 'up', 'up'], [2, 't', 'down'], [2 + n, 't', 'up']]; }
  };

  // Reach test: a floaty jump (W kept down), then a second grapple press k ticks in, to see what the
  // grapple latches onto from different heights and how far away it was.
  var REACH_TIMES = [6, 12, 18, 24, 32, 40, 52, 64, 80, 100];
  function reachAction(n, off, k) {
    return [[0, 'up', 'down'], [2, 't', 'down'], [2 + n, 't', 'up'], [2 + k, 't', 'down'], [2 + k + n, 't', 'up']];
  }

  // Shift an action so its earliest key event is at tick 0.
  function labNormalise(events) {
    var first = Math.min.apply(null, events.map(function (e) { return e[0]; }));
    return events.map(function (e) { return [e[0] - first, e[1], e[2]]; });
  }

  // Which way can the "Run first" run go? Prefer towards the middle, but never towards the ball
  // and never into a wall. Returns 'left', 'right' or null.
  function labPickDirection(x, ballX) {
    var span = 11.5;   // a run-first trial moves about 10 units while the direction key is held
    var order = ballX === null ? (x > 30.4 ? ['left', 'right'] : ['right', 'left'])
                               : (x < ballX ? ['left', 'right'] : ['right', 'left']);   // away from the ball first
    for (var i = 0; i < order.length; i++) {
      var sign = order[i] === 'right' ? 1 : -1, end = x + sign * span;
      var wallOk = end > 3.5 && end < 57.5;
      var ballOk = ballX === null || ballX < Math.min(x, end) - 6 || ballX > Math.max(x, end) + 6;
      if (wallOk && ballOk) return order[i];
    }
    return null;
  }

  // Steers back to where you stood when the lab started, and stops there.
  // Returns the direction key to hold ('left', 'right') or null. (Acceleration is about 12.8 units/s^2.)
  function labHomeKey(me) {
    var stopDistance = me[3] * Math.abs(me[3]) / 25.6;   // how far you would still slide if you braked now
    var err = lab.homeX - (me[1] + stopDistance);
    if (err > 0.3) return 'right';
    if (err < -0.3) return 'left';
    return null;
  }

  function labPress(keyName, type) {
    lab.held[keyName] = (type === 'down');
    try { sendKey(KEYS[keyName], type === 'down' ? 'keydown' : 'keyup'); }
    catch (e) { state.error = 'key error: ' + e.message; }
    if (state.logging) {   // marked "bot" so it is never mistaken for your own key presses
      state.lines.push(JSON.stringify({ k: type, code: KEYS[keyName].code, n: state.ticks,
                                        t: Math.round(performance.now() * 10) / 10, bot: 1 }));
    }
  }

  function labReleaseAll() {
    if (!lab) return;
    Object.keys(lab.held).forEach(function (name) { if (lab.held[name]) labPress(name, 'up'); });
  }

  function labBrake(want) {   // want: 'left', 'right' or null; slows you down between trials
    if (lab.brake === want) return;
    if (lab.brake) labPress(lab.brake, 'up');
    if (want) { labPress(want, 'down'); lab.lastBrakeDir = want === 'left' ? -1 : 1; }
    lab.lastBrakeAt = lab.clock;
    lab.brake = want;
  }

  // The jump kit: your four jump types, each at the hold length that worked best so far.
  var KIT = [
    { action: 'W',          tap: 3, heavy: -1 },   // low
    { action: 'W+T',        tap: 4, heavy: -1 },   // regular
    { action: 'W>T keep W', tap: 3, heavy: -1 },   // high
    { action: 'W+Space+T',  tap: 5, heavy: -1 },   // super (heavy first)
    { action: 'W+Space+T',  tap: 5, heavy: 1 }     // super-max (heavy second): reaches the ceiling
  ];
  function startKit() {
    if (lab) return;
    var queue = KIT.slice(1);
    startLab(KIT[0].action, KIT[0], queue);
  }

  function startLab(name, opts, queue) {
    if (lab) return;
    if (!state.hooked) { labNote = 'Not attached to the game yet.'; refreshPanel(); return; }
    opts = opts || {};
    lab = { action: name, tap: opts.tap || TAP_CHOICES[labSettings.tapIndex], sideways: labSettings.holdSideways,
            heavy: opts.heavy !== undefined ? opts.heavy : labSettings.heavyOffset, queue: queue || null,
            kitIndex: queue ? KIT.length - queue.length : 0, mode: opts.mode || 'jump', mv: null,
            stage: 'waiting', waited: 0, t: 0, done: 0, held: {}, trial: null, events: [],
            brake: null, dirSign: 1, homeX: null, arena: null, arena0: null,
            clock: 0, lastBrakeDir: 0, lastBrakeAt: null,
            scan: queue ? false : labSettings.scan, total: (queue ? false : labSettings.scan) ? SCAN_TRIALS : LAB_TRIALS };
    if (opts.again) { lab.againList = REACH_TIMES; lab.total = REACH_TIMES.length * 2; }   // reach test: two trials per press time
    labNote = '';
    refreshPanel();
  }

  function stopLab(message) {
    if (!lab) return;
    labReleaseAll();
    lab = null;
    labNote = message;
    refreshPanel();
  }

  function labBeginTrial(me, ball) {
    labBrake(null);
    var dir = null;
    if (lab.sideways) {
      dir = labPickDirection(me[1], ball ? ball[1] : null);
      if (!dir) {
        stopLab('Run first: stand on one side of the ball, about 8 to 15 units from it, with open floor behind you (away from the ball), and try again.');
        return;
      }
    }
    var runup = lab.sideways ? LAB_RUNUP_TICKS : 0;
    var kAgain = lab.againList ? lab.againList[Math.floor(lab.done / 2)] : null;
    var make = lab.againList ? reachAction : ACTIONS[lab.action];
    var events = labNormalise(make(lab.tap, lab.heavy, kAgain))
                   .map(function (e) { return [e[0] + runup, e[1], e[2]]; });
    if (lab.sideways) {
      events.unshift([0, dir, 'down']);
      events.push([runup + LAB_RUN_WATCH_TICKS, dir, 'up']);   // let go of the direction key after a second
    }
    lab.stage = 'running';
    lab.watch = lab.sideways ? LAB_RUN_MAX_TICKS : LAB_STAND_WATCH_TICKS;
    lab.t = 0;
    lab.events = events;
    lab.dirSign = lab.sideways ? (dir === 'right' ? 1 : -1) : 1;
    lab.trial = { action: lab.action, tap: lab.tap, sideways: lab.sideways, runup: runup,
                  off: lab.action.indexOf('Space') >= 0 ? lab.heavy : 0,
                  x0: me[1], y0: me[2], minY: me[2], air: 0, liftT: null, apexT: 0, landT: null, ropeTicks: 0,
                  phase: (stepCount + 1 + runup) % LAB_PHASES, scan: lab.scan,
                  again: kAgain, upAtAgain: null, ropes: [], ropeWas: false,
                  vx0: me[3], vy0: me[4], brakeDir: lab.lastBrakeDir,
                  sinceBrake: lab.lastBrakeAt === null ? null : lab.clock - lab.lastBrakeAt,
                  y6: lab.arena ? lab.arena[2] : 0,
                  arenaY0: lab.arena && lab.arena0 ? lab.arena[2] - lab.arena0[1] : 0,
                  arenaV0: lab.arena ? Math.abs(lab.arena[4]) : 0, arenaMax: 0,
                  ropeLen: null, ropeTarget: null, xEnd: me[1] };
  }

  function labFinishTrial() {
    var tr = lab.trial;
    labReleaseAll();
    state.labTrials.push({ action: tr.action, tap: tr.tap, sideways: tr.sideways, heavy: tr.off, x0: round3(tr.x0),
      rise: round3(tr.y0 - tr.minY), air: tr.air, lift: tr.liftT, apex: tr.apexT, land: tr.landT,
      arenaY0: round3(tr.arenaY0), arenaV0: round3(tr.arenaV0), arenaMax: round3(tr.arenaMax),
      phase: tr.phase, scan: tr.scan, y0: round3(tr.y0), vx0: round3(tr.vx0), vy0: round3(tr.vy0), brakeDir: tr.brakeDir, sinceBrake: tr.sinceBrake, moved: round3((tr.xEnd - tr.x0) * lab.dirSign),
      ropeTicks: tr.ropeTicks, ropeLen: tr.ropeLen, ropeTarget: tr.ropeTarget,
      again: tr.again, upAtAgain: tr.upAtAgain, ropes: tr.ropes });
    lab.done++;
    lab.trial = null;
    if (lab.done >= lab.total) {
      var rest = lab.queue;
      stopLab('Lab finished: ' + lab.done + ' trials of ' + lab.action + '.');
      if (rest && rest.length) { var next = rest.shift(); startLab(next.action, next, rest); }
      else if (rest) { labNote = 'Jump kit finished.'; refreshPanel(); }
      return;
    }
    lab.stage = 'gap';
    lab.waited = 0;
  }

  // ---------------------------------------------------------------
  // Move test: walk to chosen spots on your side of the ball and stand still there.
  // Ground only: it never jumps, never crosses the ball, and never steers while you are in the air.
  // ---------------------------------------------------------------
  var MOVE_ACCEL = 12.8;         // units/s^2 (measured: about 0.43 speed per tick while a direction key is held)
  var MOVE_TRIALS = 10;
  var MOVE_LIMIT_TICKS = 90;     // must be within 1 unit and almost still within 3 seconds
  var MOVE_HOLD_TICKS = 15;      // then stay within 1 unit for half a second
  var MOVE_SPOTS = [0.0, 1.0, 0.45, 0.9, 0.1, 0.65, 0.2, 0.8, 0.3, 0.55];   // where in your zone each target is (0 = outer end, 1 = the end nearest the ball)

  // Which key to hold to arrive at `target` and stop there. It brakes when the distance you would
  // still slide (speed squared over twice the acceleration) reaches the target.
  function moveKey(x, v, target) {
    var stop = v * Math.abs(v) / (2 * MOVE_ACCEL);
    var err = target - (x + stop);
    var dead = Math.abs(v) < 1 ? 0.1 : 0.2;
    return err > dead ? 'right' : (err < -dead ? 'left' : null);
  }

  function moveNextTarget(me) {
    var mv = lab.mv;
    if (mv.i >= MOVE_TRIALS) { stopLab('Move test finished.'); return; }
    mv.from = me[1];
    mv.target = mv.zoneOuter + MOVE_SPOTS[mv.i % MOVE_SPOTS.length] * (mv.zoneInner - mv.zoneOuter);
    mv.phase = 'goto';
    mv.t = 0; mv.holdT = 0; mv.settled = null; mv.holdMax = 0; mv.over = 0; mv.peak = 0;
    lab.done = mv.i;
  }

  function moveRecord() {
    var mv = lab.mv;
    state.moveTrials.push({ from: round3(mv.from), target: round3(mv.target), dist: round3(Math.abs(mv.target - mv.from)),
      settle: mv.settled, hold: round3(mv.holdMax), over: round3(mv.over), peak: round3(mv.peak),
      ok: mv.settled !== null && mv.holdMax < 1.0 });
    mv.i++;
  }

  function moveTick(me, ball) {
    var onFloor = me[2] > 37.9 && Math.abs(me[4]) < 0.5;
    if (!lab.mv) {
      if (!ball || Math.hypot(ball[3], ball[4]) > 1) { stopLab('Move test needs the ball resting on the bump. Try again once it has settled.'); return; }
      if (Math.abs(me[1] - ball[1]) < 8) { stopLab('Move test: stand at least 8 units from the ball first.'); return; }
      var left = me[1] < ball[1];
      var outer = left ? 5 : 56, inner = left ? ball[1] - 9 : ball[1] + 9;   // your zone: between the wall and 9 units from the ball
      if (Math.abs(inner - outer) < 8) { stopLab('Move test: the ball is too far off-centre to leave enough floor on your side.'); return; }
      lab.mv = { zoneOuter: outer, zoneInner: inner, i: 0 };
      lab.stage = 'moving';
      moveNextTarget(me);
    }
    var mv = lab.mv;
    if (!onFloor) { labBrake(null); return; }            // never steer in the air
    var err = mv.target - me[1];
    var sign = mv.target >= mv.from ? 1 : -1;
    mv.peak = Math.max(mv.peak, Math.abs(me[3]));
    mv.over = Math.max(mv.over, sign * (me[1] - mv.target));
    labBrake(moveKey(me[1], me[3], mv.target));
    if (mv.phase === 'goto') {
      mv.t++;
      if (Math.abs(err) < 1.0 && Math.abs(me[3]) < 0.5) { mv.settled = mv.t; mv.phase = 'hold'; mv.holdT = 0; }
      else if (mv.t > MOVE_LIMIT_TICKS) { moveRecord(); moveNextTarget(me); }
    } else {
      mv.holdT++;
      mv.holdMax = Math.max(mv.holdMax, Math.abs(err));
      if (mv.holdT >= MOVE_HOLD_TICKS) { moveRecord(); moveNextTarget(me); }
    }
  }

  function moveSummary() {
    var tr = state.moveTrials;
    if (!tr.length) return '';
    var ok = tr.filter(function (r) { return r.ok; }).length;
    var settled = tr.filter(function (r) { return r.settle !== null; }).map(function (r) { return r.settle; })
                    .sort(function (a, b) { return a - b; });
    var worstHold = Math.max.apply(null, tr.map(function (r) { return r.hold; }));
    var worstOver = Math.max.apply(null, tr.map(function (r) { return r.over; }));
    var lines = ['Move test: ' + ok + '/' + tr.length + ' ok (within 1 unit and almost still in 3 s, then held half a second)'];
    if (settled.length) {
      lines.push('  arrival: median ' + Math.round(median(settled)) + ' ticks (' + (median(settled) / 30).toFixed(1) +
                 ' s), slowest ' + settled[settled.length - 1] + ' ticks');
    }
    lines.push('  overshoot at most ' + worstOver.toFixed(2) + ' units, drift while holding at most ' + worstHold.toFixed(2));
    lines.push('  each (distance:ticks): ' + tr.map(function (r) { return r.dist.toFixed(0) + ':' + (r.settle === null ? 'FAIL' : r.settle); }).join(' '));
    return lines.join('\n');
  }

  function reachSummary() {
    var rows = state.labTrials.filter(function (r) { return r.action === 'Reach'; });
    if (!rows.length) return '';
    var byK = {}, order = [];
    rows.forEach(function (r) {
      if (!byK[r.again]) { byK[r.again] = []; order.push(r.again); }
      byK[r.again].push(r);
    });
    var lines = ['Reach test (second grapple press in mid-air; distance = from your centre to the floor surface):'];
    order.forEach(function (k) {
      var h = byK[k][0].upAtAgain;
      var outcomes = byK[k].map(function (r) {
        if (r.upAtAgain === null || r.upAtAgain === undefined) return 'never pressed (you landed first)';
        var rope = (r.ropes || []).filter(function (x) { return x.at >= 2 + k; })[0];
        return rope ? 'rope to id' + rope.target + ' len ' + (+rope.len).toFixed(1) : 'no rope';
      });
      lines.push('  press at tick ' + k + ', ' + (h === null || h === undefined ? '?' : (h + 1).toFixed(1)) + ' up: ' + outcomes.join(' | '));
    });
    return lines.join('\n');
  }

  function startReach() {
    if (lab) return;
    startLab('Reach', { tap: 3, heavy: -1, again: true });
  }

  function startMove() {
    if (lab) return;
    startLab('Move test', { mode: 'move' });
  }

  // True if you are practically touching the ball, or on a path (with gravity) that gets you within
  // 3.5 units of it in the next 0.6 seconds. (The ball kills on touch; the two touch at about 2.1 units.)
  function labBallDanger(me, ball) {
    if (!ball) return false;
    var dx = ball[1] - me[1], dy = ball[2] - me[2];
    if (Math.hypot(dx, dy) < 3.2) return true;
    var rvx = me[3] - ball[3], rvy = me[4] - ball[4];            // how fast you are closing in on it
    var onFloor = me[2] > 37.9 && Math.abs(me[4]) < 0.5;
    var g = onFloor ? 0 : 20;                                    // you fall at about 20 units/s^2 (measured from the W jump)
    for (var k = 1; k <= 18; k++) {                              // the next 0.6 seconds
      var t = k / 30;
      if (Math.hypot(dx - rvx * t, dy - rvy * t - 0.5 * g * t * t) < 3.5) return true;
    }
    return false;
  }

  // Called after every physics tick while the lab is running.
  function labTick(bodies, joints) {
    var players = bodies.filter(function (b) {
      return b[0] !== BALL_ID && b[0] !== ARENA_OBJECT_ID && b[5] !== null && Math.abs(b[5] - 1) < 0.15;
    });
    if (players.length !== 1) {
      stopLab(players.length ? 'Lab needs a solo room (found ' + players.length + ' players).'
                             : 'Lab stopped: no player found (are you in a running round?).');
      return;
    }
    var me = players[0];
    var ball = findBody({ b: bodies }, BALL_ID);
    if (lab.homeX === null) lab.homeX = me[1];   // "home" = where you stood when the lab started
    lab.clock++;
    lab.arena = findBody({ b: bodies }, ARENA_OBJECT_ID);   // the floor piece players can pull on
    if (lab.arena0 === null && lab.arena) lab.arena0 = [lab.arena[1], lab.arena[2]];
    if (lab.stage === 'avoid') {            // steering away from the ball for a moment, then stopping
      if (lab.clock >= lab.avoidUntil) stopLab('Lab stopped: you were about to touch the ball, so it steered you away from it first.');
      return;
    }
    if (labBallDanger(me, ball)) {
      labReleaseAll();
      lab.stage = 'avoid';
      lab.avoidUntil = lab.clock + 25;
      labPress(me[1] < ball[1] ? 'left' : 'right', 'down');   // push away from the ball
      return;
    }

    if (lab.mode === 'move') { moveTick(me, ball); return; }

    if (lab.stage === 'waiting' || lab.stage === 'gap') {
      lab.waited++;
      if (lab.stage === 'gap') {
        if (lab.waited < 20) return;
        lab.stage = 'waiting';
        lab.waited = 0;
      }
      labBrake(me[2] > 37.9 && Math.abs(me[4]) < 0.5 ? labHomeKey(me) : null);   // between trials, walk back to where you started (only while on the floor)
      var arenaCalm = !lab.arena || (Math.abs(lab.arena[3]) < 0.05 && Math.abs(lab.arena[4]) < 0.05);   // the floor itself is still
      var calm = me[2] > 37.9 && Math.abs(me[4]) < 0.5 && Math.abs(me[3]) < 0.5 && Math.abs(me[1] - lab.homeX) < 1.0 && arenaCalm;
      var far = !ball || Math.hypot(me[1] - ball[1], me[2] - ball[2]) > 8;
      var runupTicks = lab.sideways ? LAB_RUNUP_TICKS : 0;
      var phaseReady = !lab.scan || (stepCount + 1 + runupTicks) % LAB_PHASES === lab.done % LAB_PHASES;
      if (calm && far && phaseReady) labBeginTrial(me, ball);
      else if (lab.waited > 300) stopLab('Lab stopped: no calm start at your starting spot in 10 seconds (' +
        (arenaCalm ? 'stand on the flat floor, away from the ball).' : 'the arena floor was still moving).'));
      return;
    }

    var tr = lab.trial;
    for (var i = 0; i < lab.events.length; i++) {
      if (lab.events[i][0] === lab.t) labPress(lab.events[i][1], lab.events[i][2]);
    }
    if (lab.t >= tr.runup) {
      var since = lab.t - tr.runup;                        // ticks since the action started
      if (me[2] < tr.minY) { tr.minY = me[2]; tr.apexT = since; }
      if (me[2] < tr.y0 - 0.3) { tr.air++; if (tr.liftT === null) tr.liftT = since; }   // first tick off the ground
      else if (tr.air >= 3 && tr.landT === null) tr.landT = since;   // back on the ground after being airborne
    }
    if (lab.arena) tr.arenaMax = Math.max(tr.arenaMax, Math.abs(lab.arena[2] - tr.y6));   // did the floor move?
    if (lab.t - tr.runup <= LAB_RUN_WATCH_TICKS) tr.xEnd = me[1];   // 'moved' = how far you got in the first second
    var ropeNow = null;
    for (var j = 0; j < joints.length; j++) {
      if (joints[j][0] === 3 && (joints[j][1] === me[0] || joints[j][2] === me[0])) { ropeNow = joints[j]; break; }
    }
    if (ropeNow) {
      var ropeTarget = ropeNow[1] === me[0] ? ropeNow[2] : ropeNow[1];
      tr.ropeTicks++;
      if (tr.ropeLen === null) tr.ropeLen = ropeNow[3];
      tr.ropeTarget = ropeTarget;
      if (!tr.ropeWas) tr.ropes.push({ at: lab.t - tr.runup, target: ropeTarget, len: ropeNow[3] });   // a new rope just appeared
    }
    tr.ropeWas = !!ropeNow;
    if (tr.again !== null && lab.t - tr.runup === 2 + tr.again) tr.upAtAgain = round3(tr.y0 - me[2]);   // how high you were at the second press
    lab.t++;
    var elapsed = lab.t - tr.runup;                                  // ticks since the action started
    var landedAWhileAgo = tr.landT !== null && elapsed >= tr.landT + 5;
    var neverLeftTheGround = tr.liftT === null && elapsed > 40;
    var onTheFloor = me[2] > 37.9 && Math.abs(me[4]) < 0.5;
    if ((elapsed > lab.watch && onTheFloor) || landedAWhileAgo || neverLeftTheGround || elapsed > 900) labFinishTrial();
  }

  function labSummary() {
    var groups = {}, order = [];
    state.labTrials.forEach(function (r) {
      if (r.action === 'Reach') return;   // shown by reachSummary
      var key = r.action + ' (tap ' + r.tap + (r.heavy ? ', heavy ' + (r.heavy < 0 ? 'first' : 'second') : '') +
                (r.sideways ? ', running' : '') + (r.scan ? ', phase scan' : '') + ')';
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(r);
    });
    function sorted(g, f) { return g.map(f).sort(function (a, b) { return a - b; }); }
    var shown = order.slice(-10);
    return shown.map(function (key, gi) {
      var g = groups[key], rises = sorted(g, function (r) { return r.rise; });
      var landed = g.filter(function (r) { return r.land !== null && r.land !== undefined; });
      var line = key + ': n=' + g.length + ', rise ' + median(rises).toFixed(1) +
        ' (' + rises[0].toFixed(1) + '-' + rises[rises.length - 1].toFixed(1) + ')' +
        ', lift@' + (g.every(function (r) { return r.lift !== null && r.lift !== undefined; })
            ? Math.round(median(sorted(g, function (r) { return r.lift; }))) : 'never') +
        ', apex@' + Math.round(median(sorted(g, function (r) { return r.apex || 0; }))) +
        ', land@' + (landed.length === g.length ? Math.round(median(sorted(landed, function (r) { return r.land; }))) : landed.length + '/' + g.length + ' landed') +
        ', rope ' + g.filter(function (r) { return r.ropeTicks > 0; }).length + '/' + g.length;
      if (g[0].sideways) line += ', moved ' + median(sorted(g, function (r) { return r.moved; })).toFixed(1);
      if (rises[rises.length - 1] - rises[0] > 1) {          // erratic: show every trial in order
        line += '\n   each trial: ' + g.map(function (r) { return r.rise.toFixed(1); }).join(' ');
        if (gi === shown.length - 1) {             // details for the group you ran last
          var list = function (f, d) {
            return g.map(function (r) { var v = f(r); return v === null || v === undefined ? '-' : (+v).toFixed(d); }).join(' ');
          };
          line += '\n   start x: ' + list(function (r) { return r.x0; }, 2);
          line += '\n   start vx: ' + list(function (r) { return r.vx0; }, 3);
          line += '\n   start y: ' + list(function (r) { return r.y0; }, 4);
          line += '\n   start vy: ' + list(function (r) { return r.vy0; }, 4);
          line += '\n   rope length: ' + list(function (r) { return r.ropeLen; }, 2);
          line += '\n   rope ticks: ' + list(function (r) { return r.ropeTicks; }, 0);
          line += '\n   press phase: ' + list(function (r) { return r.phase; }, 0);
          var byPhase = [];
          for (var ph = 0; ph < LAB_PHASES; ph++) {
            var at = g.filter(function (r) { return r.phase === ph; });
            if (at.length) byPhase.push(ph + ':' + median(sorted(at, function (r) { return r.rise; })).toFixed(1));
          }
          if (byPhase.length > 1) line += '\n   rise by press phase: ' + byPhase.join(' ');
          line += '\n   last steering before: ' + g.map(function (r) {
            return (r.brakeDir < 0 ? '<' : r.brakeDir > 0 ? '>' : '-') + (r.sinceBrake === null || r.sinceBrake === undefined ? '' : r.sinceBrake);
          }).join(' ');
          line += '\n   floor moved at most: ' + Math.max.apply(null, g.map(function (r) { return r.arenaMax || 0; })).toFixed(2);
        }
      }
      return line;
    }).join('\n');
  }

  // Puts the lab results on the clipboard, so you can paste exact text instead of a screenshot.
  function copyResults() {
    var text = [labSummary(), moveSummary(), reachSummary(), state.result].filter(Boolean).join('\n');
    var ok = false;
    try {
      var box = document.createElement('textarea');
      box.value = text;
      box.style.cssText = 'position:fixed;left:-9999px;top:0';
      document.body.appendChild(box);
      box.select();
      ok = document.execCommand('copy');
      box.remove();
    } catch (e) { ok = false; }
    labNote = ok ? 'Results copied: paste them into the chat.' : 'Could not copy automatically: select the yellow text and copy it.';
    refreshPanel();
  }

  function labPanelText() {
    var parts = [];
    if (lab) {
      parts.push('LAB RUNNING (' + lab.action + '): ' + (lab.queue ? '[jump kit ' + lab.kitIndex + ' of ' + KIT.length + '], ' : '') +
                 'trial ' + Math.min(lab.done + 1, lab.total) + ' of ' + lab.total +
                 (lab.stage === 'waiting' ? ', waiting for a calm start away from the ball' : '') +
                 '. Hands off the keyboard.');
    } else if (labNote) {
      parts.push(labNote);
    }
    var sum = labSummary();
    if (sum) parts.push(sum);
    var mvs = moveSummary();
    if (mvs) parts.push(mvs);
    var rs = reachSummary();
    if (rs) parts.push(rs);
    return parts.join('\n');
  }
  window.__wdbTool.lab = { start: startLab, stop: stopLab, summary: labSummary, settings: labSettings, kit: startKit, move: startMove, moveSummary: moveSummary, reach: startReach, reachSummary: reachSummary, copy: copyResults, stage: function () { return lab ? lab.stage : null; },
    note: function () { return labNote; }, active: function () { return !!lab; } };

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
    box.style.cssText = 'position:fixed;left:172px;bottom:8px;z-index:2147483647;' +
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

    var labTitle = document.createElement('div');
    labTitle.textContent = 'Control lab (sends keys! solo room, stand on the floor away from the ball):';
    labTitle.style.cssText = 'margin-top:6px;font-weight:bold';
    var row3 = document.createElement('div');
    Object.keys(ACTIONS).forEach(function (name) {
      row3.appendChild(makeButton(name, function () { startLab(name); }));
    });
    var row4 = document.createElement('div');
    ui.labTap = makeButton('', function () {
      labSettings.tapIndex = (labSettings.tapIndex + 1) % TAP_CHOICES.length;
      refreshPanel();
    });
    ui.labRun = makeButton('', function () {
      labSettings.holdSideways = !labSettings.holdSideways;
      refreshPanel();
    });
    ui.labHeavy = makeButton('', function () {
      labSettings.heavyOffset = labSettings.heavyOffset < 0 ? 1 : -1;
      refreshPanel();
    });
    ui.labScan = makeButton('', function () {
      labSettings.scan = !labSettings.scan;
      refreshPanel();
    });
    row4.appendChild(ui.labTap);
    row4.appendChild(ui.labRun);
    row4.appendChild(ui.labHeavy);
    row4.appendChild(ui.labScan);
    row4.appendChild(makeButton('Jump kit', startKit));
    row4.appendChild(makeButton('Move test', startMove));
    row4.appendChild(makeButton('Reach test', startReach));
    row4.appendChild(makeButton('Copy results', copyResults));
    row4.appendChild(makeButton('Stop lab', function () { stopLab('Lab stopped.'); }));

    ui.result = document.createElement('div');
    ui.result.style.cssText = 'margin-top:6px;white-space:pre-wrap;color:#ffd866;user-select:text';

    box.appendChild(title);
    box.appendChild(badges);
    box.appendChild(ui.info);
    box.appendChild(row1);
    box.appendChild(row2);
    box.appendChild(labTitle);
    box.appendChild(row3);
    box.appendChild(row4);
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
    ui.labTap.textContent = 'Keys held: ' + TAP_CHOICES[labSettings.tapIndex] + ' ticks';
    ui.labRun.textContent = 'Run first: ' + (labSettings.holdSideways ? 'on' : 'off');
    ui.labScan.textContent = 'Phase scan: ' + (labSettings.scan ? 'on (16 trials)' : 'off');
    ui.labHeavy.textContent = 'Heavy: ' + (labSettings.heavyOffset < 0 ? '1 tick before' : '1 tick after') + ' grapple';
    var status = state.hooked ? 'attached to game physics' : 'waiting for the game to load...';
    ui.info.textContent =
      status + '\n' +
      'ticks logged: ' + state.ticks + '   rate: ' + rate.toFixed(1) + '/s   keys recorded: ' + state.keys + '\n' +
      'ticks with a rope on the ball: ' + state.attachedTicks + '\n' +
      scoreSummary() +
      (state.bot ? '\nBOT is ON but has no actions built yet' : '') +
      (state.error ? '\n' + state.error : '');
    ui.result.textContent = [labPanelText(), state.result].filter(Boolean).join('\n');
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
