/* NLYRA Bridge - public page. No libraries. Wallet via raw EIP-1193 (+ EIP-6963 discovery).
   Reads go to the public RPC of each chain; the wallet is only used to switch chain and sign. */
(function () {
  'use strict';
  var A = window.NlyraAbi;
  var isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

  // Test hook (local only): lets test/harness.html install a stub provider and fake RPC before anything runs.
  if (isLocal && window.parent !== window) {
    try { if (window.parent.NLYRA_TEST_INSTALL) window.parent.NLYRA_TEST_INSTALL(window); } catch (e) { /* cross-origin */ }
  }

  var PREVIEW_TO = '0x000000000000000000000000000000000000dEaD'; // recipient used only for fee previews before connecting
  var $ = function (id) { return document.getElementById(id); };

  var S = {
    cfg: null, ready: false, live: false, dir: 'rh2bsc',
    providers: [], provider: null, account: null, chainId: null,
    balance: null, balanceDst: null, native: null, allowance: null,
    amountLD: null, sendLD: null, quote: null, quoteErr: null, limit: null, limitErr: false,
    prices: { NLYRA: null, ETH: null, BNB: null },
    busy: false, quoteSeq: 0, track: null
  };
  window.NlyraBridge = { state: S, other: function () { return OTHER; } }; // for the test harness / live.js / debugging

  // ---------- helpers ----------
  function src() { return S.dir === 'rh2bsc' ? 'robinhood' : OTHER; }
  function dst() { return S.dir === 'rh2bsc' ? OTHER : 'robinhood'; }
  function C(k) { return S.cfg.chains[k]; }
  // v2: several destinations besides robinhood (arbitrum, bsc, ...); OTHER is the one chosen in the picker
  var OTHER = 'bsc', OTHERS = [];
  function oftOf(k) { var o = (S.cfg && S.cfg.ofts) || {}; return o[k] || '0x0000000000000000000000000000000000000000'; }
  function setDestination(k) {
    OTHER = k;
    S.ready = realAddr(S.cfg.adapter) && realAddr(oftOf(k)) && A.isAddress(S.cfg.token) && S.cfg.eids && S.cfg.eids.robinhood > 0 && S.cfg.eids[k] > 0;
    try { localStorage.setItem('nlyra-bridge-dst', k); } catch (e) { /* ignore */ }
  }
  function expName(k) { var c = C(k) || {}; if (c.explorerName) return c.explorerName; var h = String(c.explorer || ''); return /arbiscan/.test(h) ? 'Arbiscan' : /bscscan/.test(h) ? 'BscScan' : /etherscan/.test(h) ? 'Etherscan' : 'the explorer'; }
  function bridgeAddr() { return S.dir === 'rh2bsc' ? S.cfg.adapter : oftOf(OTHER); }
  function tokenAddr(k) { return k === 'robinhood' ? S.cfg.token : oftOf(k); }
  function needsApprove() { return S.dir === 'rh2bsc'; }
  function hex(n) { return '0x' + BigInt(n).toString(16); }
  function fmt(v, maxFrac) { return v == null ? '-' : A.formatUnits(v, S.cfg.localDecimals, maxFrac == null ? 6 : maxFrac); }
  function fmtNative(v) { return A.formatUnits(v, 18, 8); }
  function usd(n) { if (n == null || !isFinite(n)) return ''; return n >= 0.01 ? '$' + n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 }) : '<$0.01'; }
  function short(a) { return a.slice(0, 6) + '...' + a.slice(-4); }
  function sameAddr(a, b) { return a && b && a.toLowerCase() === b.toLowerCase(); }
  function realAddr(a) { return A.isAddress(a) && !A.isZeroAddress(a); }
  function setMsg(t, cls) { var m = $('msg'); m.textContent = t || ''; m.className = 'msg' + (cls ? ' ' + cls : ''); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  var rpcId = 1;
  function rpc(chain, method, params) {
    return fetch(C(chain).rpc, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId++, method: method, params: params || [] })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) { var e = new Error(j.error.message || 'RPC error'); e.data = j.error.data; e.code = j.error.code; throw e; }
      return j.result;
    });
  }
  function call(chain, to, data) { return rpc(chain, 'eth_call', [{ to: to, data: data }, 'latest']); }

  function revertData(e) {
    var seen = 0;
    while (e && seen++ < 5) {
      if (typeof e.data === 'string' && /^0x[0-9a-fA-F]{8}/.test(e.data)) return e.data;
      if (e.data && typeof e.data.data === 'string') return e.data.data;
      e = e.error || e.data || e.cause;
    }
    return null;
  }
  function errText(e) {
    if (!e) return 'Unknown error';
    if (e.code === 4001 || /user (rejected|denied)/i.test(e.message || '')) return 'Rejected in your wallet.';
    var d = revertData(e), r = d && A.dec.revert(d);
    if (r) return r.text + (r.sig ? '' : '');
    return (e.message || String(e)).slice(0, 220);
  }

  // ---------- config ----------
  function configUrl() {
    var q = new URLSearchParams(location.search).get('config');
    if (isLocal && q && /^[\w\-./]+\.json$/.test(q) && q.indexOf('..') < 0) return q;
    return 'bridge-config.json';
  }

  function loadConfig() {
    return fetch(configUrl(), { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('config ' + r.status);
      return r.json();
    }).then(function (cfg) {
      cfg.localDecimals = cfg.localDecimals || 18;
      cfg.sharedDecimals = cfg.sharedDecimals || 6;
      S.cfg = cfg;
      OTHERS = Object.keys(cfg.chains || {}).filter(function (k) { return k !== 'robinhood'; });
      cfg.ofts = cfg.ofts || {};
      if (OTHERS[0] && !cfg.ofts[OTHERS[0]] && cfg.oft) cfg.ofts[OTHERS[0]] = cfg.oft;   // v1 config: a single destination
      var saved = null; try { saved = localStorage.getItem('nlyra-bridge-dst'); } catch (e) { /* ignore */ }
      var pick = (saved && OTHERS.indexOf(saved) >= 0 && realAddr(cfg.ofts[saved])) ? saved : null;
      if (!pick && cfg.defaultDestination && OTHERS.indexOf(cfg.defaultDestination) >= 0) pick = cfg.defaultDestination;
      if (!pick) pick = OTHERS.filter(function (k) { return realAddr(cfg.ofts[k]); })[0] || OTHERS[0] || 'bsc';
      setDestination(pick);
    });
  }

  // ---------- rendering ----------
  function renderAddrs() {
    var c = S.cfg, ul = $('addrs');
    var rows = [['NLYRA on Robinhood Chain (original token)', c.token, 'robinhood', 'token']];
    OTHERS.forEach(function (k) { rows.push(['NLYRA on ' + C(k).short + ' (official OFT)', oftOf(k), k, 'token']); });
    rows.push(['Bridge adapter on Robinhood Chain', c.adapter, 'robinhood', 'address']);
    var vb = $('vBsc'); if (vb) { if (realAddr(oftOf('bsc'))) { vb.href = C('bsc').explorer + '/address/' + oftOf('bsc') + '#code'; vb.hidden = false; } else vb.hidden = true; }
    ul.innerHTML = '';
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var k = document.createElement('span'); k.className = 'k'; k.textContent = r[0]; li.appendChild(k);
      var v = document.createElement('span'); v.className = 'v';
      if (realAddr(r[1])) {
        var code = document.createElement('code'); code.textContent = r[1]; v.appendChild(code);
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn ghost small copy'; b.textContent = 'Copy';
        b.addEventListener('click', function () { copy(r[1], b); }); v.appendChild(b);
        li.appendChild(v);
        var a = document.createElement('a'); a.href = C(r[2]).explorer + '/' + r[3] + '/' + r[1]; a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'View on ' + (r[2] === 'robinhood' ? 'Blockscout' : expName(r[2])); li.appendChild(a);
      } else {
        var p = document.createElement('span'); p.className = 'pending'; p.textContent = 'Not deployed yet - will be published here.'; v.appendChild(p); li.appendChild(v);
      }
      ul.appendChild(li);
    });
    $('capText').textContent = Number(c.dailyLimit || 20000000).toLocaleString('en-US');
  }

  function copy(text, btn) {
    function done() { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1400); }
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, fallback); } else fallback();
    function fallback() {
      var t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ } t.remove();
    }
  }

  function banner(html, cls) { var b = $('banner'); b.className = 'banner ' + (cls || ''); b.innerHTML = html; b.hidden = !html; }

  function renderHero() {
    var h = $('heroH1'), p = $('heroSub'); if (!h || !OTHERS.length) return;
    var live = OTHERS.filter(function (k) { return realAddr(oftOf(k)); }), soon = OTHERS.filter(function (k) { return !realAddr(oftOf(k)); });
    var names = live.map(function (k) { return '<span class="grad">' + C(k).short + '</span>'; });
    var joined = names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : (names[0] || '<span class="grad">Robinhood Chain</span>');
    h.innerHTML = 'NLYRA, now on ' + joined + '.' + (soon.length ? ' <span class="next">' + soon.map(function (k) { return C(k).short; }).join(' and ') + ' next.</span>' : '');
    var n = live.length + 1, word = n === 2 ? 'two' : n === 3 ? 'three' : n === 4 ? 'four' : String(n);
    if (p) p.textContent = 'One token, one supply, ' + word + ' chains. Your NLYRA is locked on Robinhood Chain and the exact same amount is minted on ' + (live.map(function (k) { return C(k).name; }).join(' or ') || 'the other chain') + '. Coming back burns it there and unlocks it here. Nothing wrapped, nothing custodial: you sign in your own wallet.';
  }
  function soonHtml(k) { return '<b>Coming soon.</b> The NLYRA bridge to ' + C(k).short + ' is being deployed. Its contract address will appear on this page when it goes live. Until then, any "NLYRA" on ' + C(k).short + ' is fake.'; }
  function renderPicker() {
    var box = $('dstPick'); if (!box) return;
    if (OTHERS.length < 2) { box.hidden = true; return; }
    box.hidden = false; box.innerHTML = '';
    var lb = document.createElement('span'); lb.className = 'pl'; lb.textContent = S.dir === 'rh2bsc' ? 'Destination' : 'From'; box.appendChild(lb);
    OTHERS.forEach(function (k) {
      var live = realAddr(oftOf(k)), b = document.createElement('button'); b.type = 'button';
      b.className = 'pick' + (k === OTHER ? ' on' : '') + (live ? '' : ' soon'); b.disabled = S.busy;
      b.textContent = C(k).short + (live ? '' : ' · soon'); b.setAttribute('aria-pressed', k === OTHER ? 'true' : 'false');
      b.addEventListener('click', function () { if (k !== OTHER) chooseDestination(k); });
      box.appendChild(b);
    });
  }
  function chooseDestination(k) {
    setDestination(k);
    S.balance = null; S.balanceDst = null; S.native = null; S.allowance = null; S.quote = null; S.quoteErr = null; S.limit = null; S.live = false;
    setMsg(''); banner('');
    if (!S.ready) { banner(soonHtml(k), 'soon'); render(); return; }
    loadPrices();
    checkContracts().then(function () { render(); refreshBalances(); refreshLimit(); scheduleQuote(); });
  }
  function renderRoute() {
    $('fromName').textContent = C(src()).name;
    $('toName').textContent = C(dst()).name;
    renderPicker();
    $('balance').textContent = S.balance == null ? '-' : fmt(S.balance);
    $('balanceDst').textContent = S.balanceDst == null ? '-' : fmt(S.balanceDst);
  }

  function recipient() {
    var r = $('recipient').value.trim();
    if (r) return A.isAddress(r) ? r : null;
    return S.account;
  }

  function renderSummary() {
    var cfg = S.cfg;
    $('receive').textContent = S.sendLD == null ? '-' : fmt(S.sendLD, cfg.sharedDecimals);
    var dust = (S.amountLD != null && S.sendLD != null) ? S.amountLD - S.sendLD : 0n;
    $('dustRow').hidden = !(dust > 0n);
    if (dust > 0n) $('dust').textContent = A.formatUnits(dust, cfg.localDecimals) + ' NLYRA';
    var nat = C(src()).native.symbol;
    if (S.quote) {
      var p = S.prices[nat], f = S.quote.nativeFee;
      $('fee').textContent = fmtNative(f) + ' ' + nat + (p ? ' (' + usd(Number(f) / 1e18 * p) + ')' : '');
    } else $('fee').textContent = S.quoteErr ? 'Unavailable' : '-';
    $('approvalInfo').textContent = needsApprove()
      ? (S.allowance == null ? 'Needed on Robinhood Chain' : (S.sendLD != null && S.allowance >= S.sendLD && S.sendLD > 0n ? 'Done' : 'Needed (1 transaction)'))
      : 'Not needed on ' + C(OTHER).short;
    if (S.limit) $('limit').textContent = fmt(S.limit.canBeSent, 0) + ' NLYRA';
    else $('limit').textContent = S.limitErr ? 'Up to ' + Number(cfg.dailyLimit || 0).toLocaleString('en-US') + ' / 24 h' : '-';
    var pN = S.prices.NLYRA;
    $('amountUsd').textContent = (pN && S.sendLD) ? '~' + usd(Number(A.formatUnits(S.sendLD, cfg.localDecimals, 6, true)) * pN) : '';
    var r = $('recipient').value.trim();
    $('recipShort').textContent = r ? (A.isAddress(r) ? short(r) : 'invalid address') : (S.account ? 'your address ' + short(S.account) : 'your connected address');
  }

  // Decides what the main button does. Returns {label, enabled, run}.
  function actionState() {
    if (!S.ready) return { label: 'Coming soon', enabled: false };
    if (!S.live) return { label: 'Bridge unavailable', enabled: false };
    if (S.busy) return { label: S.busyLabel || 'Working...', enabled: false };
    if (!S.account) return { label: 'Connect wallet', enabled: true, run: connect };
    var want = C(src()).chainId;
    if (S.chainId !== want) return { label: 'Switch to ' + C(src()).name, enabled: true, run: function () { return switchChain(src()); } };
    if (S.amountLD == null || S.amountLD === 0n) return { label: 'Enter an amount', enabled: false };
    if (S.sendLD === 0n) return { label: 'Amount too small (min 0.000001)', enabled: false };
    if (!recipient()) return { label: 'Invalid recipient', enabled: false };
    if (S.balance != null && S.amountLD > S.balance) return { label: 'Not enough NLYRA', enabled: false };
    if (S.limit && S.sendLD > S.limit.canBeSent) return { label: 'Above the daily limit', enabled: false };
    if (needsApprove() && (S.allowance == null || S.allowance < S.sendLD)) return { label: 'Approve NLYRA', enabled: S.allowance != null, run: approve };
    if (S.quoteErr) return { label: 'Cannot quote', enabled: false };
    if (!S.quote) return { label: 'Getting LayerZero fee...', enabled: false };
    if (S.native != null && S.native < S.quote.nativeFee) return { label: 'Not enough ' + C(src()).native.symbol + ' for the fee', enabled: false };
    return { label: 'Bridge to ' + C(dst()).short, enabled: true, run: bridge };
  }

  function render() {
    if (!S.cfg) return;
    renderRoute(); renderSummary();
    var a = actionState(), b = $('action');
    b.textContent = a.label; b.disabled = !a.enabled; b._run = a.run;
    $('connectTop').textContent = S.account ? short(S.account) : 'Connect wallet';
    $('flip').disabled = S.busy;
    $('amount').disabled = !S.ready || !S.live;
    $('max').disabled = !S.ready || !S.live || S.balance == null;
  }

  // ---------- data ----------
  function amountFromInput() {
    var v = $('amount').value.trim();
    S.amountLD = null; S.sendLD = null;
    if (!v) return null;
    try {
      S.amountLD = A.parseUnits(v, S.cfg.localDecimals);
      S.sendLD = A.removeDust(S.amountLD, S.cfg.localDecimals, S.cfg.sharedDecimals);
      return null;
    } catch (e) { return e.message; }
  }

  function extraOptions() {
    var c = S.cfg;
    if (c.lzReceiveGas && Number(c.lzReceiveGas) > 0) return A.lzReceiveOption(BigInt(c.lzReceiveGas));
    return A.isHex(c.extraOptions || '0x') ? (c.extraOptions || '0x') : '0x';
  }

  function sendParam(to) {
    return {
      dstEid: S.cfg.eids[dst()], to: to, amountLD: S.amountLD, minAmountLD: S.sendLD,
      extraOptions: extraOptions(), composeMsg: '0x', oftCmd: '0x'
    };
  }

  function refreshBalances() {
    if (!S.ready || !S.live || !S.account) return Promise.resolve();
    var s = src(), d = dst(), acct = S.account;
    var jobs = [
      call(s, tokenAddr(s), A.enc.balanceOf(acct)).then(function (r) { S.balance = A.dec.uint(r); }),
      call(d, tokenAddr(d), A.enc.balanceOf(acct)).then(function (r) { S.balanceDst = A.dec.uint(r); }),
      rpc(s, 'eth_getBalance', [acct, 'latest']).then(function (r) { S.native = BigInt(r); })
    ];
    if (needsApprove()) jobs.push(call(s, S.cfg.token, A.enc.allowance(acct, S.cfg.adapter)).then(function (r) { S.allowance = A.dec.uint(r); }));
    return Promise.all(jobs.map(function (p) { return p.catch(function (e) { console.warn('read failed', e); }); })).then(render);
  }

  function refreshLimit() {
    if (!S.ready || !S.live) return Promise.resolve();
    S.limit = null; S.limitErr = false;
    var d = S.dir;
    return call(src(), bridgeAddr(), A.enc.getAmountCanBeSent(S.cfg.eids[dst()]))
      .then(function (r) { if (d === S.dir) S.limit = A.dec.amountCanBeSent(r); })
      .catch(function () { if (d === S.dir) S.limitErr = true; })
      .then(render);
  }

  var quoteTimer = null;
  function scheduleQuote() { clearTimeout(quoteTimer); quoteTimer = setTimeout(quote, 350); }

  function quote() {
    S.quote = null; S.quoteErr = null;
    if (!S.ready || !S.live || !S.sendLD) { render(); return Promise.resolve(null); }
    var seq = ++S.quoteSeq, to = recipient() || PREVIEW_TO;
    render();
    return call(src(), bridgeAddr(), A.enc.quoteSend(sendParam(to), false)).then(function (r) {
      if (seq !== S.quoteSeq) return null;
      S.quote = A.dec.messagingFee(r);
      if (S.quote.nativeFee === 0n) { S.quote = null; S.quoteErr = 'Fee quote returned 0'; }
      render(); return S.quote;
    }).catch(function (e) {
      if (seq !== S.quoteSeq) return null;
      S.quoteErr = errText(e); setMsg('Could not get the LayerZero fee: ' + S.quoteErr, 'err'); render(); return null;
    });
  }

  function loadPrices() {
    var c = S.cfg;
    if (c.priceApi) fetch(c.priceApi).then(function (r) { return r.json(); }).then(function (j) {
      var p = Number(j.priceUsd); if (p > 0) { S.prices.NLYRA = p; render(); }
    }).catch(function () {});
    var cl = c.chainlink || {};
    Object.keys(cl).filter(function (k) { return k !== 'rpc'; }).forEach(function (sym) {
      var f = cl[sym], addr = typeof f === 'string' ? f : (f && f.address), rpcUrl = (f && typeof f === 'object' && f.rpc) || cl.rpc;   // v2: a feed may live on its own chain
      if (!addr || !rpcUrl) return;
      fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data: A.enc.latestRoundData() }, 'latest'] }) })
        .then(function (r) { return r.json(); }).then(function (j) {
          var d = A.dec.roundData(j.result), age = Date.now() / 1000 - Number(d.updatedAt);
          if (d.answer > 0n && age < 86400 * 2) { S.prices[sym] = Number(d.answer) / 1e8; render(); } // feeds use 8 decimals
        }).catch(function () {});
    });
  }

  function checkContracts() {
    return Promise.all([
      rpc('robinhood', 'eth_getCode', [S.cfg.adapter, 'latest']),
      rpc(OTHER, 'eth_getCode', [oftOf(OTHER), 'latest'])
    ]).then(function (codes) {
      if (codes[0] && codes[0] !== '0x' && codes[1] && codes[1] !== '0x') { S.live = true; banner(''); }
      else banner('<b>Bridge not available.</b> The configured contracts were not found on-chain. Do not send anything; check official NLYRA channels.', 'err');
    }).catch(function () {
      S.live = true; // RPC hiccup: do not block, the wallet will still simulate before sending
      banner('<b>Network check failed.</b> Public RPC did not answer; values may be missing. Refresh if the page looks wrong.', 'err');
    });
  }

  // ---------- wallet ----------
  function discover() {
    window.addEventListener('eip6963:announceProvider', function (ev) {
      var d = ev.detail; if (!d || !d.provider || !d.info) return;
      if (!S.providers.some(function (p) { return p.info.uuid === d.info.uuid; })) S.providers.push(d);
    });
    window.dispatchEvent(new Event('eip6963:requestProvider'));
  }

  function pickProvider() {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    var list = S.providers.slice();
    if (list.length <= 1) return Promise.resolve(list[0] ? list[0].provider : window.ethereum || null);
    return new Promise(function (resolve) {
      var ul = $('pickList'); ul.innerHTML = '';
      list.forEach(function (p) {
        var li = document.createElement('li'), b = document.createElement('button'); b.type = 'button';
        if (p.info.icon && /^data:image\//.test(p.info.icon)) { var img = document.createElement('img'); img.src = p.info.icon; img.alt = ''; b.appendChild(img); }
        b.appendChild(document.createTextNode(p.info.name || 'Wallet'));
        b.addEventListener('click', function () { $('walletPick').hidden = true; resolve(p.provider); });
        li.appendChild(b); ul.appendChild(li);
      });
      $('pickClose').onclick = function () { $('walletPick').hidden = true; resolve(null); };
      $('walletPick').hidden = false;
    });
  }

  function attach(p) {
    if (S.provider === p) return;
    S.provider = p;
    if (p && p.on) {
      p.on('accountsChanged', function (a) { S.account = a && a[0] ? a[0] : null; S.allowance = null; S.balance = null; S.balanceDst = null; refreshBalances(); scheduleQuote(); });
      p.on('chainChanged', function (c) { S.chainId = parseInt(c, 16); render(); });
    }
  }

  function connect() {
    return pickProvider().then(function (p) {
      if (!p) { setMsg('No wallet found. Install MetaMask or open this page in your wallet\'s browser.', 'err'); return; }
      attach(p);
      return p.request({ method: 'eth_requestAccounts' }).then(function (accts) {
        S.account = accts && accts[0] ? accts[0] : null;
        return p.request({ method: 'eth_chainId' });
      }).then(function (cid) {
        S.chainId = parseInt(cid, 16); setMsg('');
        render(); return Promise.all([refreshBalances(), quote()]);
      });
    }).catch(function (e) { setMsg(errText(e), 'err'); });
  }

  function switchChain(k) {
    var c = C(k), id = hex(c.chainId);
    return S.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: id }] }).catch(function (e) {
      var code = e && (e.code || (e.data && e.data.originalError && e.data.originalError.code));
      if (code === 4902 || /unrecognized|not added|unknown chain/i.test(e && e.message || '')) {
        return S.provider.request({ method: 'wallet_addEthereumChain', params: [{
          chainId: id, chainName: c.name, nativeCurrency: c.native, rpcUrls: [c.rpc], blockExplorerUrls: [c.explorer]
        }] });
      }
      throw e;
    }).then(function () { return S.provider.request({ method: 'eth_chainId' }); })
      .then(function (cid) { S.chainId = parseInt(cid, 16); setMsg(''); render(); })
      .catch(function (e) { setMsg(errText(e), 'err'); });
  }

  function waitReceipt(chain, hash) {
    var tries = 0;
    function poll() {
      tries++;
      return rpc(chain, 'eth_getTransactionReceipt', [hash]).catch(function (e) {
        if (S.provider && S.chainId === C(chain).chainId) return S.provider.request({ method: 'eth_getTransactionReceipt', params: [hash] });
        if (tries > 150) throw e;
        return null; // public RPC hiccup: keep polling
      }).then(function (r) {
        if (r && r.blockNumber) return r;
        if (tries > 150) throw new Error('Still pending after 5 minutes. Check your wallet activity.');
        return sleep(2000).then(poll);
      });
    }
    return poll();
  }

  function sendTx(tx) {
    return S.provider.request({ method: 'eth_estimateGas', params: [tx] }).then(function (g) {
      var gas = BigInt(g); tx.gas = hex(gas + gas / 5n); // +20 %
      return S.provider.request({ method: 'eth_sendTransaction', params: [tx] });
    });
  }

  function approve() {
    var s = src(), amt = S.sendLD;
    S.busy = true; S.busyLabel = 'Approving...'; render();
    setMsg('Confirm the approval in your wallet. It lets the bridge move exactly ' + fmt(amt, S.cfg.sharedDecimals) + ' NLYRA.');
    var tx = { from: S.account, to: S.cfg.token, data: A.enc.approve(S.cfg.adapter, amt), value: '0x0' };
    return sendTx(tx).then(function (hash) {
      setMsg('Approval sent. Waiting for confirmation...');
      return waitReceipt(s, hash);
    }).then(function (rc) {
      if (rc.status !== '0x1') throw new Error('Approval failed on-chain.');
      setMsg('Approved. Now bridge.', 'ok');
    }).catch(function (e) { setMsg(errText(e), 'err'); })
      .then(function () { S.busy = false; return refreshBalances(); }).then(quote);
  }

  function bridge() {
    var s = src(), d = dst(), to = recipient();
    S.busy = true; S.busyLabel = 'Preparing...'; render();
    setMsg('Getting a fresh LayerZero fee...');
    return quote().then(function (q) {
      if (!q) throw new Error(S.quoteErr || 'No fee quote');
      var p = sendParam(to);
      var data = A.enc.send(p, { nativeFee: q.nativeFee, lzTokenFee: 0n }, S.account);
      var tx = { from: S.account, to: bridgeAddr(), data: data, value: hex(q.nativeFee) };
      S.busy = true; S.busyLabel = 'Confirm in wallet...'; render();
      setMsg('Confirm the transfer in your wallet. LayerZero fee: ' + fmtNative(q.nativeFee) + ' ' + C(s).native.symbol + '.');
      return sendTx(tx);
    }).then(function (hash) {
      startTrack({ hash: hash, src: s, dst: d, amount: S.sendLD.toString(), ts: Date.now() });
      setMsg('Sent. You can close this page; the transfer continues on its own.', 'ok');
      $('amount').value = ''; amountFromInput();
    }).catch(function (e) { setMsg(errText(e), 'err'); })
      .then(function () { S.busy = false; render(); });
  }

  // ---------- tracking ----------
  function step(id, cls, note) {
    var li = $(id); li.className = cls || '';
    var sm = li.querySelector('small'); if (!sm) { sm = document.createElement('small'); li.appendChild(sm); }
    sm.textContent = note || '';
  }
  function link(href, text) { var a = document.createElement('a'); a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text; return a; }

  function startTrack(t) {
    S.track = t;
    try { localStorage.setItem('nlyra-bridge-last', JSON.stringify(t)); } catch (e) { /* storage blocked */ }
    $('track').hidden = false;
    var links = $('trackLinks'); links.innerHTML = '';
    links.appendChild(link(S.cfg.lzScanUrl + t.hash, 'View on LayerZero Scan'));
    links.appendChild(link(C(t.src).explorer + '/tx/' + t.hash, 'Source tx on ' + (t.src === 'robinhood' ? 'Blockscout' : expName(t.src))));
    step('stSrc', 'run', 'Waiting for ' + C(t.src).name + ' confirmation');
    step('stLz', '', ''); step('stDst', '', '');
    waitReceipt(t.src, t.hash).then(function (rc) {
      if (rc.status !== '0x1') { step('stSrc', 'fail', 'Transaction failed on-chain. Nothing was bridged.'); return; }
      step('stSrc', 'done', 'Confirmed in block ' + parseInt(rc.blockNumber, 16));
      step('stLz', 'run', 'Waiting for DVNs (LayerZero Labs + Nethermind) and the executor');
      pollScan(t, 0);
    }).catch(function (e) { step('stSrc', 'run', errText(e)); pollScan(t, 0); });
  }

  // LayerZero Scan public API: GET https://scan.layerzero-api.com/v1/messages/tx/<srcTxHash>
  // -> { data: [ { status: { name }, destination: { tx: { txHash } } } ] }, 404 until indexed.
  function pollScan(t, n) {
    if (S.track !== t) return;
    if (n > 240) { step('stLz', 'run', 'Taking longer than usual. Follow it on LayerZero Scan.'); return; }
    fetch(S.cfg.lzScanApi + t.hash).then(function (r) {
      if (r.status === 404) return { pending: true };
      if (!r.ok) throw new Error('scan ' + r.status);
      return r.json();
    }).then(function (j) {
      if (j.pending || !j.data || !j.data.length) { step('stLz', 'run', 'Waiting for LayerZero Scan to index the message'); return sleep(8000).then(function () { pollScan(t, n + 1); }); }
      var m = j.data[0], st = (m.status && m.status.name) || 'UNKNOWN';
      if (st === 'DELIVERED') {
        step('stLz', 'done', 'Verified and delivered');
        var dh = m.destination && m.destination.tx && m.destination.tx.txHash;
        step('stDst', 'done', fmt(BigInt(t.amount), S.cfg.sharedDecimals) + ' NLYRA arrived on ' + C(t.dst).name);
        if (dh) $('trackLinks').appendChild(link(C(t.dst).explorer + '/tx/' + dh, 'Destination tx'));
        try { localStorage.removeItem('nlyra-bridge-last'); } catch (e) { /* ignore */ }
        refreshBalances(); return;
      }
      if (/FAILED|BLOCKED|UNRESOLVABLE|MALFORMED/.test(st)) {
        step('stLz', 'fail', 'Status ' + st + (m.status.message ? ': ' + m.status.message : '') + '. Your tokens are not lost; contact NLYRA support with the tx hash.');
        return;
      }
      if (st === 'PAYLOAD_STORED') { step('stLz', 'fail', 'Delivery stored but not executed yet. It can be retried; contact NLYRA support with the tx hash.'); return; }
      step('stLz', 'run', st === 'CONFIRMING' ? 'Waiting for block confirmations' : 'In flight (' + st.toLowerCase() + ')');
      return sleep(8000).then(function () { pollScan(t, n + 1); });
    }).catch(function () {
      step('stLz', 'run', 'Live status unavailable right now. Use the LayerZero Scan link.');
      return sleep(15000).then(function () { pollScan(t, n + 1); });
    });
  }

  // ---------- events ----------
  function bind() {
    $('action').addEventListener('click', function () { var r = $('action')._run; if (r) r(); });
    $('connectTop').addEventListener('click', function () { if (!S.account) connect(); });
    $('flip').addEventListener('click', function () {
      S.dir = S.dir === 'rh2bsc' ? 'bsc2rh' : 'rh2bsc';
      S.balance = null; S.balanceDst = null; S.native = null; S.allowance = null; S.quote = null; S.limit = null;
      setMsg(''); render(); refreshBalances(); refreshLimit(); scheduleQuote();
    });
    $('amount').addEventListener('input', function () {
      var err = amountFromInput(); setMsg(err || '', err ? 'err' : ''); S.quote = null; render(); scheduleQuote();
    });
    $('max').addEventListener('click', function () {
      if (S.balance == null) return;
      var m = A.removeDust(S.balance, S.cfg.localDecimals, S.cfg.sharedDecimals);
      $('amount').value = A.formatUnits(m, S.cfg.localDecimals, null, true);
      amountFromInput(); setMsg(''); render(); scheduleQuote();
    });
    $('recipient').addEventListener('input', function () { render(); scheduleQuote(); });
  }

  function resumeTrack() {
    try {
      var t = JSON.parse(localStorage.getItem('nlyra-bridge-last') || 'null');
      if (t && t.hash && Date.now() - t.ts < 6 * 3600e3 && S.cfg.chains[t.src]) startTrack(t);
    } catch (e) { /* ignore */ }
  }

  function init() {
    discover(); bind();
    loadConfig().then(function () {
      renderAddrs(); renderHero();
      if (!S.ready) { banner(soonHtml(OTHER), 'soon'); render(); return; }
      loadPrices();
      return checkContracts().then(function () { render(); refreshLimit(); resumeTrack(); });
    }).catch(function (e) {
      banner('<b>Could not load the bridge configuration.</b> Refresh the page. (' + (e.message || e) + ')', 'err');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
