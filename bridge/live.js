/* NLYRA Bridge - presentation extras (no wallet, no signing):
   1) hero art direction (the animation itself is CSS, see #art in style.css), 2) live "locked / minted" numbers read from public RPCs,
   3) chain badges on the route boxes. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };

  // ---------- 1) hero art: follow the chosen direction ----------
  (function art() {
    var svg = $('art'); if (!svg) return;
    function setDir() {
      var fn = $('fromName'), fwd = !fn || /robinhood/i.test(fn.textContent);
      svg.classList.toggle('rev', !fwd);
      var tl = $('tagL'), tr = $('tagR'); if (tl && tr) { tl.textContent = fwd ? 'locked' : 'unlocked'; tr.textContent = fwd ? 'minted' : 'burned'; }
    }
    setDir(); if ($('fromName') && window.MutationObserver) new MutationObserver(setDir).observe($('fromName'), { childList: true, characterData: true, subtree: true });
  })();

  // ---------- 2) live numbers ----------
  function cfgUrl() { var m = /[?&]config=([^&]+)/.exec(location.search); return m ? decodeURIComponent(m[1]) : 'bridge-config.json'; }
  function call(rpc, to, data) {
    return fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: to, data: data }, 'latest'] }) })
      .then(function (r) { return r.json(); }).then(function (j) { if (j.error || !j.result || j.result === '0x') throw new Error('rpc'); return BigInt(j.result); });
  }
  function short(n) { // 18 decimals -> "4.00M"
    var v = Number(n / 10n ** 14n) / 1e4;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return v.toFixed(0);
  }
  function set(id, txt, title) { var e = $(id); if (!e) return; e.textContent = txt; if (title) e.title = title; }
  fetch(cfgUrl()).then(function (r) { return r.json(); }).then(function (c) {
    var others = Object.keys(c.chains || {}).filter(function (k) { return k !== 'robinhood'; }), ofts = c.ofts || {};
    if (others[0] && !ofts[others[0]] && c.oft) ofts[others[0]] = c.oft;
    var real = function (x) { return /^0x[0-9a-fA-F]{40}$/.test(x || '') && !/^0x0{40}$/.test(x); };
    if (!real(c.adapter)) return;
    var bal = '0x70a08231' + c.adapter.slice(2).toLowerCase().padStart(64, '0');
    call(c.chains.robinhood.rpc, c.token, bal).then(function (n) { set('stLocked', short(n), Number(n / 10n ** 18n).toLocaleString('en-US') + ' NLYRA'); }, function () { set('stLocked', '—'); });
    var live = others.filter(function (k) { return real(ofts[k]); });
    if (!live.length) { set('stMinted', '—'); return; }
    Promise.all(live.map(function (k) { return call(c.chains[k].rpc, ofts[k], '0x18160ddd').then(function (n) { return { k: k, n: n }; }, function () { return { k: k, n: null }; }); })).then(function (rs) {
      set('stMinted', rs.map(function (r) { return r.n == null ? '—' : short(r.n); }).join(' · '), rs.map(function (r) { return c.chains[r.k].short + ': ' + (r.n == null ? '?' : Number(r.n / 10n ** 18n).toLocaleString('en-US')) + ' NLYRA'; }).join(' · '));
      var lab = $('stMintedLabel'); if (lab) lab.textContent = 'NLYRA on ' + live.map(function (r) { return c.chains[r].short; }).join(' · ');
    });
  }).catch(function () { /* the stats are decorative */ });

  // ---------- 3) chain badges follow the direction ----------
  function badge() {
    var f = $('fromBox'), t = $('toBox'), fn = $('fromName'), tn = $('toName'); if (!f || !t) return;
    var fr = /robinhood/i.test(fn.textContent);
    var ok = (window.NlyraBridge && window.NlyraBridge.other) ? window.NlyraBridge.other() : 'arbitrum', cls = ok === 'bsc' ? 'bsc' : 'arb';
    [f, t].forEach(function (b) { b.classList.remove('arb'); b.classList.remove('bsc'); });
    f.classList.toggle('rh', fr); if (!fr) f.classList.add(cls);
    t.classList.toggle('rh', !fr); if (fr) t.classList.add(cls);
    var im = $('nRimg'), nm = $('nRname'), ring = $('nRring');
    if (im) im.setAttribute('href', cls === 'bsc' ? 'img/bnb.svg' : 'img/arbitrum.png');
    if (nm) nm.textContent = cls === 'bsc' ? 'BNB Smart Chain' : 'Arbitrum One';
    if (ring) ring.setAttribute('fill', cls === 'bsc' ? 'rgba(240,185,11,.12)' : 'rgba(47,180,255,.12)');
  }
  badge();
  if (window.MutationObserver && $('fromName')) new MutationObserver(badge).observe($('fromName'), { childList: true, characterData: true, subtree: true });
  if (window.MutationObserver && $('toName')) new MutationObserver(badge).observe($('toName'), { childList: true, characterData: true, subtree: true });
  if (window.MutationObserver && $('dstPick')) new MutationObserver(badge).observe($('dstPick'), { childList: true, subtree: true });
})();
