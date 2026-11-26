/* Stand-in for Claude's live-room API, backed by this site's WebSocket server.
   The game asks for window.claude.use('room') and gets join / on / emit / presence / peers / leave. */
(function () {
  if (window.claude && typeof window.claude.use === 'function') return;
  function join(name) {
    return new Promise(function (resolve, reject) {
      var ws;
      try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws?room=' + encodeURIComponent(name)); }
      catch (e) { return reject({ code: 'unavailable' }); }
      var me = null, myP = {}, peers = new Map(), subs = [], opened = false, left = false;
      var timer = setTimeout(function () { try { ws.close(); } catch (_) {} reject({ code: 'timeout' }); }, 8000);
      function tx(o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
      var rm = {
        peers: function () {
          var out = [{ peer: me, presence: myP, isMe: true, kind: 'viewer', sameTab: true }];
          peers.forEach(function (p, id) { out.push({ peer: id, presence: p || {}, isMe: false, kind: 'viewer', sameTab: false }); });
          return out;
        },
        on: function (topic, fn, onErr) {
          var s = { topic: topic, fn: fn, onErr: onErr }; subs.push(s);
          return function () { subs = subs.filter(function (x) { return x !== s; }); };
        },
        emit: function (topic, data) {
          if (ws.readyState !== 1) return Promise.reject({ code: 'disconnected' });
          tx({ t: 'e', k: topic, d: data }); return Promise.resolve();
        },
        presence: function (o) {
          myP = o || {};
          if (ws.readyState !== 1) return Promise.reject({ code: 'disconnected' });
          tx({ t: 'p', d: myP }); return Promise.resolve();
        },
        leave: function () { left = true; subs = []; try { ws.close(); } catch (_) {} return Promise.resolve(); },
      };
      ws.onmessage = function (ev) {
        var m; try { m = JSON.parse(ev.data); } catch (_) { return; }
        if (m.t === 'hi') {
          me = m.id; (m.peers || []).forEach(function (p) { peers.set(p.id, p.p || {}); });
          opened = true; clearTimeout(timer); resolve(rm);
        } else if (m.t === 'err') { clearTimeout(timer); reject({ code: m.code }); }
        else if (m.t === 'j') peers.set(m.id, {});
        else if (m.t === 'l') peers.delete(m.id);
        else if (m.t === 'p') peers.set(m.id, m.d || {});
        else if (m.t === 'e') {
          subs.slice().forEach(function (s) { if (s.topic === m.k) { try { s.fn({ peer: m.id, isMe: false, data: m.d, topic: m.k }); } catch (e) { console.error(e); } } });
        }
      };
      ws.onclose = function () {
        clearTimeout(timer);
        if (!opened) return reject({ code: 'unavailable' });
        if (!left) subs.slice().forEach(function (s) { if (s.onErr) { try { s.onErr({ code: 'disconnected' }); } catch (_) {} } });
      };
      ws.onerror = function () {};
    });
  }
  window.claude = { use: function (n) { return Promise.resolve(n === 'room' ? { join: join } : null); } };
})();
