/* NLYRA bridge - hand-written ABI encoding (no libraries).
   Supports: uintN, address, bool, bytes32, bytes, string, and tuples (as JS arrays of types).
   Every selector below is checked against `cast sig` by test/abi.test.js. */
(function (root) {
  'use strict';

  var SEL = {
    approve: '095ea7b3',            // approve(address,uint256)
    allowance: 'dd62ed3e',          // allowance(address,address)
    balanceOf: '70a08231',          // balanceOf(address)
    decimals: '313ce567',           // decimals()
    token: 'fc0c546a',              // token()
    sharedDecimals: '857749b0',     // sharedDecimals()
    quoteSend: '3b6f743b',          // quoteSend((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),bool)
    quoteOFT: '0d35b415',           // quoteOFT((uint32,bytes32,uint256,uint256,bytes,bytes,bytes))
    send: 'c7c7f5b3',               // send((uint32,bytes32,uint256,uint256,bytes,bytes,bytes),(uint256,uint256),address)
    getAmountCanBeSent: 'c272198d', // getAmountCanBeSent(uint32)  (LayerZero RateLimiter)
    peers: 'bb0b6a53',              // peers(uint32)
    latestRoundData: 'feaf968c'     // latestRoundData()  (Chainlink)
  };

  // Known revert selectors -> human text.
  var ERRORS = {
    '08c379a0': { sig: 'Error(string)', text: null },
    '4e487b71': { sig: 'Panic(uint256)', text: 'Contract panic' },
    '71c4efed': { sig: 'SlippageExceeded(uint256,uint256)', text: 'Amount after dust removal is below the minimum' },
    'a74c1c5f': { sig: 'RateLimitExceeded()', text: 'Daily bridge limit reached for this direction. Try a smaller amount or wait.' },
    'f6ff4fb7': { sig: 'NoPeer(uint32)', text: 'The bridge route is not configured yet (no peer)' },
    '9f704120': { sig: 'NotEnoughNative(uint256)', text: 'Not enough gas token sent for the LayerZero fee' },
    '5373352a': { sig: 'LzTokenUnavailable()', text: 'Paying in LZ token is not supported' },
    '9a6d49cd': { sig: 'InvalidOptions(bytes)', text: 'Invalid LayerZero options' },
    'e5eb8f30': { sig: 'Executor_ZeroLzReceiveGasProvided()', text: 'Bridge options not configured (no destination gas). The owner must set enforced options.' },
    '6592671c': { sig: 'LZ_ULN_InvalidWorkerOptions(uint256)', text: 'Bridge options not configured. The owner must set enforced options.' },
    '4f3ec0d3': { sig: 'LZ_InsufficientFee(uint256,uint256,uint256,uint256)', text: 'LayerZero fee changed. Get a new quote and retry.' },
    'fb8f41b2': { sig: 'ERC20InsufficientAllowance(address,uint256,uint256)', text: 'Approval too low. Approve again.' },
    'e450d38c': { sig: 'ERC20InsufficientBalance(address,uint256,uint256)', text: 'Not enough NLYRA in your wallet' },
    '2c5211c6': { sig: 'InvalidAmount()', text: 'Invalid amount' }
  };

  function strip0x(h) { return (h.slice(0, 2) === '0x' || h.slice(0, 2) === '0X') ? h.slice(2) : h; }
  function isHex(h) { return typeof h === 'string' && /^(0x)?[0-9a-fA-F]*$/.test(h) && strip0x(h).length % 2 === 0; }
  function isAddress(a) { return typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a); }
  function isZeroAddress(a) { return isAddress(a) && /^0x0{40}$/.test(a); }

  function toBig(v) {
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('unsafe number ' + v); return BigInt(v); }
    if (typeof v === 'string') { if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(v)) throw new Error('bad integer ' + v); return BigInt(v); }
    if (typeof v === 'boolean') return v ? 1n : 0n;
    throw new Error('bad integer value');
  }

  function word(n) {
    n = toBig(n);
    if (n < 0n) throw new Error('negative not supported');
    var h = n.toString(16);
    if (h.length > 64) throw new Error('value overflows 256 bits');
    return h.padStart(64, '0');
  }

  function padRight(hex) { var r = hex.length % 64; return r === 0 ? hex : hex + '0'.repeat(64 - r); }

  function utf8Hex(s) {
    var bytes = new TextEncoder().encode(s), out = '';
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
    return out;
  }

  function isDynamic(t) {
    if (Array.isArray(t)) return t.some(isDynamic);
    return t === 'bytes' || t === 'string';
  }

  function headSize(t) {
    if (Array.isArray(t) && !isDynamic(t)) return t.reduce(function (a, x) { return a + headSize(x); }, 0);
    return 32;
  }

  function encodeValue(t, v) {
    if (Array.isArray(t)) {
      if (!Array.isArray(v) || v.length !== t.length) throw new Error('tuple arity mismatch');
      return encodeTuple(t, v);
    }
    var m = /^uint(\d+)$/.exec(t);
    if (m) {
      var bits = parseInt(m[1], 10), n = toBig(v);
      if (n < 0n || n >= (1n << BigInt(bits))) throw new Error(t + ' out of range: ' + n);
      return word(n);
    }
    if (t === 'address') {
      if (!isAddress(v)) throw new Error('bad address ' + v);
      return strip0x(v).toLowerCase().padStart(64, '0');
    }
    if (t === 'bool') return word(v ? 1n : 0n);
    if (t === 'bytes32') {
      var b = strip0x(v);
      if (!/^[0-9a-fA-F]{64}$/.test(b)) throw new Error('bad bytes32 ' + v);
      return b.toLowerCase();
    }
    if (t === 'bytes') {
      if (!isHex(v)) throw new Error('bad bytes ' + v);
      var d = strip0x(v).toLowerCase();
      return word(d.length / 2) + padRight(d);
    }
    if (t === 'string') {
      var s = utf8Hex(v);
      return word(s.length / 2) + padRight(s);
    }
    throw new Error('unsupported type ' + t);
  }

  function encodeTuple(types, values) {
    if (types.length !== values.length) throw new Error('arity mismatch');
    var heads = [], tails = [];
    var offset = types.reduce(function (a, t) { return a + headSize(t); }, 0);
    for (var i = 0; i < types.length; i++) {
      var e = encodeValue(types[i], values[i]);
      if (isDynamic(types[i])) {
        heads.push(word(offset));
        tails.push(e);
        offset += e.length / 2;
      } else {
        heads.push(e);
      }
    }
    return heads.join('') + tails.join('');
  }

  function encodeCall(selector, types, values) {
    return '0x' + strip0x(selector) + encodeTuple(types || [], values || []);
  }

  // ---- decoding helpers ----
  function wordAt(hex, i) {
    var h = strip0x(hex), s = h.slice(i * 64, i * 64 + 64);
    if (s.length !== 64) throw new Error('return data too short');
    return BigInt('0x' + s);
  }
  function addressAt(hex, i) { return '0x' + strip0x(hex).slice(i * 64 + 24, i * 64 + 64); }
  function decodeStringAt(hex, byteOffset) {
    var h = strip0x(hex), len = Number(BigInt('0x' + h.slice(byteOffset * 2, byteOffset * 2 + 64)));
    var data = h.slice(byteOffset * 2 + 64, byteOffset * 2 + 64 + len * 2), bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = parseInt(data.substr(i * 2, 2), 16);
    return new TextDecoder().decode(bytes);
  }

  // ---- LayerZero / OFT specific ----
  var SEND_PARAM = ['uint32', 'bytes32', 'uint256', 'uint256', 'bytes', 'bytes', 'bytes'];
  var MESSAGING_FEE = ['uint256', 'uint256'];

  function addressToBytes32(a) {
    if (!isAddress(a)) throw new Error('bad address ' + a);
    return '0x' + strip0x(a).toLowerCase().padStart(64, '0');
  }

  function sendParamValues(p) {
    return [p.dstEid, addressToBytes32(p.to), p.amountLD, p.minAmountLD, p.extraOptions || '0x', p.composeMsg || '0x', p.oftCmd || '0x'];
  }

  var enc = {
    approve: function (spender, amount) { return encodeCall(SEL.approve, ['address', 'uint256'], [spender, amount]); },
    allowance: function (owner, spender) { return encodeCall(SEL.allowance, ['address', 'address'], [owner, spender]); },
    balanceOf: function (a) { return encodeCall(SEL.balanceOf, ['address'], [a]); },
    decimals: function () { return encodeCall(SEL.decimals); },
    token: function () { return encodeCall(SEL.token); },
    sharedDecimals: function () { return encodeCall(SEL.sharedDecimals); },
    getAmountCanBeSent: function (eid) { return encodeCall(SEL.getAmountCanBeSent, ['uint32'], [eid]); },
    peers: function (eid) { return encodeCall(SEL.peers, ['uint32'], [eid]); },
    latestRoundData: function () { return encodeCall(SEL.latestRoundData); },
    quoteSend: function (p, payInLzToken) { return encodeCall(SEL.quoteSend, [SEND_PARAM, 'bool'], [sendParamValues(p), !!payInLzToken]); },
    quoteOFT: function (p) { return encodeCall(SEL.quoteOFT, [SEND_PARAM], [sendParamValues(p)]); },
    send: function (p, fee, refund) {
      return encodeCall(SEL.send, [SEND_PARAM, MESSAGING_FEE, 'address'], [sendParamValues(p), [fee.nativeFee, fee.lzTokenFee || 0n], refund]);
    }
  };

  var dec = {
    uint: function (hex) { return wordAt(hex, 0); },
    address: function (hex) { return addressAt(hex, 0); },
    // quoteSend -> MessagingFee(nativeFee, lzTokenFee)
    messagingFee: function (hex) { return { nativeFee: wordAt(hex, 0), lzTokenFee: wordAt(hex, 1) }; },
    // quoteOFT -> (OFTLimit{min,max}, OFTFeeDetail[] (dynamic, skipped), OFTReceipt{sent,received})
    quoteOFT: function (hex) {
      return { minAmountLD: wordAt(hex, 0), maxAmountLD: wordAt(hex, 1), amountSentLD: wordAt(hex, 3), amountReceivedLD: wordAt(hex, 4) };
    },
    // getAmountCanBeSent -> (currentAmountInFlight, amountCanBeSent)
    amountCanBeSent: function (hex) { return { inFlight: wordAt(hex, 0), canBeSent: wordAt(hex, 1) }; },
    // Chainlink latestRoundData -> (roundId, answer, startedAt, updatedAt, answeredInRound)
    roundData: function (hex) { return { answer: wordAt(hex, 1), updatedAt: wordAt(hex, 3) }; },
    revert: function (hex) {
      var h = strip0x(hex || '').toLowerCase();
      if (h.length < 8) return null;
      var sel = h.slice(0, 8), known = ERRORS[sel];
      if (!known) return { selector: '0x' + sel, sig: null, text: 'Transaction would fail (error 0x' + sel + ')' };
      if (sel === '08c379a0') {
        try { return { selector: '0x' + sel, sig: known.sig, text: decodeStringAt(h.slice(8), 32) }; }
        catch (e) { return { selector: '0x' + sel, sig: known.sig, text: 'Reverted' }; }
      }
      return { selector: '0x' + sel, sig: known.sig, text: known.text };
    }
  };

  // LayerZero Type-3 options with one lzReceive gas option (same bytes as
  // OptionsBuilder.newOptions().addExecutorLzReceiveOption(gas, 0)):
  // 0x0003 | workerId 0x01 | size uint16 (=17) | optionType 0x01 | gas uint128
  function lzReceiveOption(gas) {
    var g = toBig(gas);
    if (g <= 0n || g >= (1n << 128n)) throw new Error('bad gas');
    return '0x0003' + '01' + '0011' + '01' + g.toString(16).padStart(32, '0');
  }

  // ---- units (exact, BigInt) ----
  function parseUnits(str, decimals) {
    str = String(str).trim().replace(/,/g, '');
    if (!/^\d*\.?\d*$/.test(str) || str === '' || str === '.') throw new Error('Enter a valid amount');
    var parts = str.split('.'), whole = parts[0] || '0', frac = parts[1] || '';
    if (frac.length > decimals) throw new Error('Too many decimals (max ' + decimals + ')');
    return BigInt(whole) * (10n ** BigInt(decimals)) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
  }

  function formatUnits(v, decimals, maxFrac, plain) {
    v = toBig(v);
    var base = 10n ** BigInt(decimals), whole = v / base, frac = (v % base).toString().padStart(decimals, '0');
    if (maxFrac != null) frac = frac.slice(0, maxFrac);
    frac = frac.replace(/0+$/, '');
    var w = plain ? whole.toString() : whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return frac ? w + '.' + frac : w;
  }

  // OFT dust: amounts travel with sharedDecimals (6). Anything below 10^(localDecimals - sharedDecimals) stays behind.
  function removeDust(amountLD, localDecimals, sharedDecimals) {
    var rate = 10n ** BigInt(localDecimals - sharedDecimals);
    return amountLD - (amountLD % rate);
  }

  var api = {
    SEL: SEL, ERRORS: ERRORS, SEND_PARAM: SEND_PARAM,
    encodeTuple: encodeTuple, encodeCall: encodeCall, word: word,
    addressToBytes32: addressToBytes32, isAddress: isAddress, isZeroAddress: isZeroAddress, isHex: isHex,
    enc: enc, dec: dec, lzReceiveOption: lzReceiveOption,
    parseUnits: parseUnits, formatUnits: formatUnits, removeDust: removeDust,
    wordAt: wordAt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NlyraAbi = api;
})(typeof self !== 'undefined' ? self : this);
