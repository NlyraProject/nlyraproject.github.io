/* nlyra-wc.js (3/11/2026): WalletConnect for the pages outside the Desk (the staking app, the bridge).
   A phone browser with no wallet inside it, or the Desk installed on the home screen opening one of these pages in Chrome,
   had nothing to sign with: "No wallet found". This script announces a "WalletConnect" wallet through EIP-6963, the same
   way an extension does, so the page's own wallet code finds it, connects, switches chains, signs and sends through it
   without a change. The library (about 1.4 MB, jsdelivr) is fetched only when someone picks WalletConnect, or at load when
   this origin already holds a session (from the Desk, or from a previous visit): then the wallet is linked again on its own.
   Load it before the page's app script.
   4/11: a wallet can link without Robinhood Chain (it approves only the networks it knows). The library then switched on
   this page only, and every signature on that network died inside it ("Missing or invalid. request() chainId"), which ethers
   shows as "could not coalesce error". Now a switch checks that the wallet really approved the network, a send on a network
   it never approved gets a plain answer, and WC.relink() links again asking for that network.
   9/11: a phone can leave the socket to the WalletConnect relay open but dead. The request to sign then never left the
   page: the wallet app opened with nothing to confirm and a minute later the page showed "Failed to publish payload". Now
   the relay is checked before a request goes to the wallet (one small request, 2 s) and the link is reopened when it does
   not answer; a tab that comes back from the background checks on its own, which also brings in an answer the wallet sent
   meanwhile. When the relay cannot be reached the page gets a plain message within 12 s. WC.relay holds the state. */
(function () {
  if (window.__NLYRA_WC__) return;
  var WC = window.__NLYRA_WC__ = {
    pid: 'b79832fa47c4994ab3a5ae3874418bd9',       /* Reown project "NLYRA Desk": a public id, it travels in every browser */
    esm: 'https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.26.0/+esm',
    uuid: '7f1c4a8e-0d2b-4c3e-9f5a-2b6d8e1c3a57', raw: null, loading: null, listeners: [],
  };
  var ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#0A84FF"/><path d="M10 13.6c3.3-3.2 8.7-3.2 12 0l.4.4a.4.4 0 0 1 0 .6l-1.4 1.3a.2.2 0 0 1-.3 0l-.5-.5c-2.3-2.3-6.1-2.3-8.4 0l-.6.6a.2.2 0 0 1-.3 0l-1.4-1.4a.4.4 0 0 1 0-.6l.5-.4zm14.8 2.8 1.2 1.2a.4.4 0 0 1 0 .6l-5.5 5.4a.4.4 0 0 1-.6 0l-3.9-3.8a.1.1 0 0 0-.2 0l-3.9 3.8a.4.4 0 0 1-.6 0l-5.5-5.4a.4.4 0 0 1 0-.6l1.2-1.2a.4.4 0 0 1 .6 0l3.9 3.8a.1.1 0 0 0 .2 0l3.9-3.8a.4.4 0 0 1 .6 0l3.9 3.8a.1.1 0 0 0 .2 0l3.9-3.8a.4.4 0 0 1 .6 0z" fill="#fff"/></svg>');
  var NAMES = { 1: 'Ethereum', 4663: 'Robinhood Chain', 42161: 'Arbitrum', 56: 'BNB Chain' };
  function noChain(cid) {
    var n = NAMES[Number(cid)] || ('network ' + cid);
    return 'Your wallet linked through WalletConnect without ' + n + ', so it cannot sign here. Add ' + n + ' in your wallet app and link it again, or open this page in the browser inside your wallet app.';
  }
  var NO_CHAIN = noChain(4663);
  var SIGNS = /^(eth_sendTransaction|eth_signTransaction|eth_sign|personal_sign|eth_signTypedData(_v3|_v4)?|wallet_sendCalls)$/;
  function fail(code, msg) { var e = new Error(msg); e.code = code; return e; }
  /* the networks this wallet approved for the link (a wallet that adds one later tells the session a moment after) */
  function approved(raw, cid) {
    var ns = raw && raw.session && raw.session.namespaces && raw.session.namespaces.eip155, c = 'eip155:' + Number(cid);
    if (!ns) return false;
    return (ns.chains || []).indexOf(c) >= 0 || (ns.accounts || []).some(function (a) { return a.indexOf(c + ':') === 0; });
  }
  function firstApproved(raw) {
    var ns = raw && raw.session && raw.session.namespaces && raw.session.namespaces.eip155;
    var c = ns && ((ns.chains && ns.chains[0]) || (ns.accounts && ns.accounts[0]));
    return c ? Number(String(c).split(':')[1]) : 0;
  }
  function waitApproved(raw, cid, ms) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function tick() { if (approved(raw, cid)) return res(true); if (Date.now() - t0 >= ms) return res(false); setTimeout(tick, 250); })();
    });
  }
  /* switch or add: the library "switches" on this page even when the wallet never approved the network, so look at the
     session afterwards; if the network is not there, go back to one the wallet did approve and say so (4902 makes a page
     ask to add the network next, which is the right step) */
  function chainStep(raw, a) {
    var m = a.method, want = parseInt((a.params && a.params[0] && a.params[0].chainId) || '0x0', 16);
    if (!raw.session || !want || approved(raw, want)) return raw.request(a);
    if (WC.noChain === raw.session.topic + ':' + want) return Promise.reject(fail(m === 'wallet_switchEthereumChain' ? 4902 : 4100, noChain(want)));
    var back = function () { var b = firstApproved(raw); return b ? raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(b) }] }).catch(function () {}) : Promise.resolve(); };
    return alive(raw).then(function () { return raw.request(a); }).then(function () { return waitApproved(raw, want, 3000); }, function (e) {
      e = plain(e);
      /* the wallet said no, asks for the network to be added first, or could not be reached: that answer goes to the page as it is; anything else
         ("not approved", a method the link does not carry) means this link cannot reach the network */
      var keep = e && (e.code === 4900 || e.code === 4001 || e.code === 5000 || /reject|denied|cancel/i.test(e.message || '') ||
        (m === 'wallet_switchEthereumChain' && (e.code === 4902 || /unrecognized|not added/i.test(e.message || ''))));
      return back().then(function () { throw keep ? e : fail(4100, noChain(want)); });
    }).then(function (ok) {
      if (ok) return m === 'wallet_addEthereumChain' ? raw.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex(want) }] }).then(function () { return null; }) : null;
      if (m === 'wallet_addEthereumChain' && raw.session) WC.noChain = raw.session.topic + ':' + want;
      return back().then(function () { throw fail(m === 'wallet_switchEthereumChain' ? 4902 : 4100, noChain(want)); });
    });
  }
  function hex(c) { if (typeof c === 'number') return '0x' + c.toString(16); c = String(c == null ? '' : c); return /^0x/i.test(c) ? c.toLowerCase() : (c ? '0x' + Number(c).toString(16) : c); }

  /* a session on this origin: the Desk marks the wallet it linked, and the library keeps its sessions under wc@2 keys */
  function hasSession() {
    try {
      if (localStorage.getItem('d2.walletId') === 'walletconnect') return true;
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (/^wc@2:.*session$/.test(k)) { var v = localStorage.getItem(k); if (v && v.length > 2 && v !== '[]') return true; }
      }
    } catch (e) {}
    return false;
  }

  /* a small line at the bottom while the library comes down: the page's own code shows nothing until the wallet answers */
  var note = null;
  function say(t, up) {
    if (!t) { if (note) note.remove(); note = null; return; }
    if (!note) {
      note = document.createElement('div');
      note.style.cssText = 'position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:99999;padding:9px 14px;border-radius:999px;background:#141B33;color:#E9EEF8;font:500 13px system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.4);pointer-events:none';
      (document.body || document.documentElement).appendChild(note);
    }
    /* up: under the page's header, clear of the toast a page keeps at the bottom */
    note.style.top = up ? 'calc(env(safe-area-inset-top, 0px) + 72px)' : 'auto'; note.style.bottom = up ? 'auto' : '18px'; note.style.whiteSpace = up ? 'nowrap' : '';
    note.textContent = t;
  }

  /* the link to the relay. A phone can leave that socket open but dead (the tab went to the background, the network
     changed): the browser does not notice, the library keeps writing into it, and the wallet app opens with nothing to
     confirm. relay.ok is the last time the relay said anything; alive() makes sure of the link before a request goes to
     the wallet, and reopens it when the relay does not answer */
  var relay = WC.relay = { ok: 0, hid: 0, checking: null, quiet: false, pill: false, last: '' };
  var LOST = 'Could not reach your wallet through WalletConnect. Check your connection and try again, or open this page in the browser inside your wallet app.';
  var GONE = /Failed to publish payload|socket connection to the relay|No internet connection detected|Socket stalled/i;
  var CAP = 12000;   /* the library's own reconnect can take a minute and a half: the page gets an answer before that */
  function plain(e) { return e && GONE.test(e.message || '') ? fail(4900, LOST) : e; }
  function relayer(raw) {
    try { var r = raw.signer.client.core.relayer; return r && typeof r.request === 'function' && typeof r.restartTransport === 'function' ? r : null; } catch (e) { return null; }
  }
  /* 1: it answered in time, -1: it failed, 0: no answer yet */
  function within(p, ms) {
    return new Promise(function (res) {
      var t = setTimeout(function () { res(0); }, Math.max(0, ms));
      Promise.resolve(p).then(function () { clearTimeout(t); res(1); }, function () { clearTimeout(t); res(-1); });
    });
  }
  function watch(raw) {
    var r = relayer(raw), mark = function () { relay.ok = Date.now(); };
    if (!r) return;
    try { ['relayer_connect', 'relayer_message', 'relayer_message_ack', 'relayer_publish'].forEach(function (ev) { r.on(ev, mark); }); } catch (e) {}
    if (r.connected) mark();   /* the socket was opened a moment ago, while the library started */
  }
  function alive(raw, quiet) {
    var r = relayer(raw);
    if (!r || !raw.session) return Promise.resolve();
    var pill = function () { relay.pill = true; say('Connecting to your wallet…', 1); };
    if (relay.checking) {   /* a check is already running (the tab just came back): wait for that one */
      if (!quiet) { relay.quiet = false; if (relay.last === 'restart') pill(); }
      return relay.checking;
    }
    var t0 = Date.now(), ask, up = function () { return r.connected && relay.ok >= t0; };
    var done = function () { relay.checking = null; if (relay.pill) { relay.pill = false; say(''); } };
    relay.quiet = !!quiet; relay.last = 'probe';
    /* subscribing again to the session's own topic changes nothing at the relay, and the relay has to answer it */
    try { ask = r.connected ? r.request({ method: 'irn_batchSubscribe', params: { topics: [raw.session.topic] } }) : Promise.reject(); } catch (e) { ask = Promise.reject(e); }
    relay.checking = within(ask, 2000).then(function (st) {
      if (r.connected && (st > 0 || relay.ok >= t0)) return;
      relay.last = 'restart';
      if (!relay.quiet) pill();
      var re; try { re = r.restartTransport(); } catch (e) { re = Promise.reject(e); }
      return within(re, CAP - (Date.now() - t0)).then(function (st) {
        if (st < 0 && !up()) throw fail(4900, LOST);
        return new Promise(function (res, rej) {
          (function tick() { if (up()) return res(); if (Date.now() - t0 >= CAP) return rej(fail(4900, LOST)); setTimeout(tick, 200); })();
        });
      });
    }).then(done, function (e) { done(); relay.last = 'fail'; throw e; });
    return relay.checking;
  }
  /* the request that goes to the wallet. After a slow check the phone may no longer open the wallet app by itself */
  function send(raw, a, late) {
    var t = late ? setTimeout(function () { t = 0; say(''); }, 20000) : 0;
    var end = function () { if (t) { clearTimeout(t); t = 0; say(''); } };
    if (late) say('Open your wallet app to confirm.', 1);
    return raw.request(a).then(function (v) { end(); return v; }, function (e) { end(); throw plain(e); });
  }
  /* back from the background (the wallet app, another tab): that is when the socket dies without a word. Checking now
     also brings in an answer the wallet sent meanwhile, instead of leaving the page waiting for it */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') { relay.hid = Date.now(); return; }
    var away = relay.hid ? Date.now() - relay.hid : 0;
    relay.hid = 0;
    if (away > 3000 && WC.raw && WC.raw.session) alive(WC.raw, true).catch(function () {});
  });

  function bind(raw, ev, fn) {
    if (ev === 'chainChanged') raw.on(ev, function (c) { fn(hex(c)); });
    else if (ev === 'accountsChanged') { raw.on(ev, fn); raw.on('disconnect', function () { fn([]); }); }
    else raw.on(ev, fn);
  }
  function load() {
    if (WC.raw) return Promise.resolve(WC.raw);
    if (WC.loading) return WC.loading;
    var imp = new Function('u', 'return import(u)');   /* dynamic import without the syntax in this (classic) file */
    WC.loading = imp(WC.esm).then(function (m) {
      var EP = m.EthereumProvider || (m.default && m.default.EthereumProvider) || m.default;
      if (!EP || !EP.init) throw new Error('WalletConnect did not load');
      return EP.init({
        projectId: WC.pid,
        chains: [1], optionalChains: [4663, 42161, 56],   /* every wallet knows Ethereum; Robinhood Chain, Arbitrum and BNB Chain are switched to by the page */
        rpcMap: { 4663: (/(^|\.)nlyra\.xyz$/i.test(location.hostname) ? location.origin + '/rpc' : 'https://rpc.mainnet.chain.robinhood.com') },
        showQrModal: true,
        qrModalOptions: { themeMode: 'dark', themeVariables: { '--w3m-accent': '#8B7CF6', '--w3m-z-index': '100000' } },
        metadata: { name: 'NLYRA', description: document.title || 'NLYRA', url: location.origin, icons: [location.origin + '/desk2/limpio-icon-192.png'] },
      });
    }).then(function (raw) {
      WC.raw = raw;
      watch(raw);
      WC.listeners.forEach(function (l) { bind(raw, l[0], l[1]); });
      WC.listeners = [];
      return raw;
    }).catch(function (e) { WC.loading = null; throw e; });
    return WC.loading;
  }
  function ready() { return WC.raw ? Promise.resolve(WC.raw) : (WC.loading ? WC.loading.catch(function () { return null; }) : Promise.resolve(null)); }

  /* the EIP-1193 face the page sees: chain ids come back hex like an extension's (the library answers with a number);
     a silent look (eth_accounts) never downloads anything; the first real request downloads the library and pairs */
  var provider = {
    isWalletConnect: true,
    request: function (a) {
      var m = a && a.method;
      if (m === 'eth_accounts') return ready().then(function (raw) { return raw && raw.session ? raw.request(a) : []; });
      if (m === 'eth_chainId') return ready().then(function (raw) { return raw && raw.session ? raw.request(a).then(hex) : hex((raw && raw.chainId) || 1); });
      if (m === 'eth_requestAccounts') {
        if (!WC.raw) say('Opening WalletConnect…');
        return load().then(function (raw) {
          if (raw.session) { say(''); return raw.request(a); }
          say('Approve in your wallet app, then come back here.');
          return raw.connect().then(function () { say(''); return raw.request(a); });
        }).catch(function (e) { say(''); throw e; });
      }
      if (m === 'wallet_switchEthereumChain' || m === 'wallet_addEthereumChain') return load().then(function (raw) { return chainStep(raw, a); });
      if (SIGNS.test(m)) return load().then(function (raw) {
        if (raw.session && !approved(raw, raw.chainId)) throw fail(4100, noChain(raw.chainId));   /* the library would refuse it anyway, with a message nobody understands */
        var t = Date.now();
        return alive(raw).then(function () { return send(raw, a, Date.now() - t > 2500); });
      });
      return load().then(function (raw) { return raw.request(a); });
    },
    on: function (ev, fn) { if (WC.raw) bind(WC.raw, ev, fn); else WC.listeners.push([ev, fn]); return provider; },
    removeListener: function (ev, fn) { try { if (WC.raw) WC.raw.removeListener(ev, fn); } catch (e) {} return provider; },
    disconnect: function () { return WC.raw && WC.raw.session ? WC.raw.disconnect() : Promise.resolve(); },
  };
  var detail = Object.freeze({ info: Object.freeze({ uuid: WC.uuid, name: 'WalletConnect', rdns: 'com.walletconnect', icon: ICON }), provider: provider });
  function announce() { try { window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: detail })); } catch (e) {} }
  /* answered a tick late on purpose: the extensions answer first, so a page that takes the first wallet it hears keeps the extension */
  window.addEventListener('eip6963:requestProvider', function () { setTimeout(announce, 0); });
  announce();
  /* link again, this time asking the wallet for `cid` as a must: a wallet that cannot give it says so at once */
  function relink(cid) {
    cid = Number(cid) || 4663;
    return load().then(function (raw) {
      return (raw.session ? alive(raw).then(function () { return raw.disconnect().catch(function () {}); }) : Promise.resolve()).then(function () {
        say('Approve in your wallet app, then come back here.');
        var opt = [1, 4663, 42161, 56].filter(function (c) { return c !== cid; });
        return raw.connect({ chains: [cid], optionalChains: opt, rpcMap: { 4663: (/(^|\.)nlyra\.xyz$/i.test(location.hostname) ? location.origin + '/rpc' : 'https://rpc.mainnet.chain.robinhood.com') } });
      }).then(function () { say(''); return raw.request({ method: 'eth_requestAccounts' }); }, function (e) { say(''); throw e; });
    });
  }
  WC.provider = provider; WC.load = load; WC.relink = relink; WC.approved = function (cid) { return approved(WC.raw, cid); }; WC.NO_CHAIN = NO_CHAIN;
  if (hasSession()) load().catch(function () {});
})();
