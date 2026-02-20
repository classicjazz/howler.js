# @classicjazz/howler — Changelog

**Upstream:** howler.js v2.2.4 (GoldFire Studios, 2020)  
**Fork version:** 2.5.0  © Michael Connelly
**License:** MIT — © 2026 Michael Connelly; © 2013–2020 James Simpson of GoldFire Studios

---

## Overview

This document describes every change made to `howler.js` (core + spatial plugin) relative to the upstream v2.2.4 release. The existing public API is **100% preserved** — all `Howl` and `Howler` method signatures, event names, option keys, and module export patterns are identical to v2.2.4. Changes are internal only unless explicitly noted as additive.

Changes fall into five categories:

1. [Dead browser code removed](#1-dead-browser-code-removed)
2. [Security hardening](#2-security-hardening)
3. [Performance improvements](#3-performance-improvements)
4. [API-preserving modernizations](#4-api-preserving-modernizations)
5. [Streaming additions](#5-streaming-additions)

---

## 1. Dead Browser Code Removed

These were workarounds for browsers that no longer hold ≥1% market share. Removing them reduces bundle size and eliminates maintenance surface.

---

### 1.1 `webkitAudioContext` fallback removed

**Original code:**
```js
typeof AudioContext !== 'undefined'
  ? n.ctx = new AudioContext
  : typeof webkitAudioContext !== 'undefined'
    ? n.ctx = new webkitAudioContext
    : n.usingWebAudio = false
```
**New code:**
```js
if (typeof AudioContext !== 'undefined') {
  Howler.ctx = new AudioContext({ latencyHint: 'playback' });
} else {
  Howler.usingWebAudio = false;
}
```

`webkitAudioContext` was Safari's prefixed AudioContext, unprefixed since Safari 14.1 (April 2021). The fallback branch is unreachable on any browser in active use. The `latencyHint: 'playback'` addition is documented in §4.3.

---

### 1.2 `createGainNode` fallback removed

**Original code:**
```js
void 0 === n.ctx.createGain ? n.ctx.createGainNode() : n.ctx.createGain()
```
**New code:**
```js
Howler.ctx.createGain()
```

`createGainNode()` was removed from the Web Audio API spec and dropped by Chrome 24, Firefox 25, and Safari 6.

---

### 1.3 `noteOn` / `noteGrainOn` fallbacks removed

**Original code:**
```js
void 0 === m.bufferSource.start
  ? d._loop
    ? m.bufferSource.noteGrainOn(0, _, 86400)
    : m.bufferSource.noteGrainOn(0, _, s)
  : d._loop
    ? m.bufferSource.start(0, _, 86400)
    : m.bufferSource.start(0, _, s)
```
**New code:**
```js
if (sound._loop) {
  node.bufferSource.start(0, seek, 86400);
} else {
  node.bufferSource.start(0, seek, duration);
}
```

`noteOn()` and `noteGrainOn()` were the original Web Audio API method names, replaced by `start()` before the spec was finalised.

---

### 1.4 iOS < 9 WebAudio workaround removed

The UA-string parsing block that disabled WebAudio on iOS < 9 non-Safari browsers has been removed entirely. iOS 9 reached end-of-life in 2019, and `navigator.platform` is deprecated.

---

### 1.5 Opera < 33 MP3 codec guard removed

**Original code:**
```js
var a = r.match(/OPR\/(\d+)/g),
    u = a && parseInt(a[0].split('/')[1], 10) < 33;
mp3: !(u || !t && !o.canPlayType('audio/mp3;').replace(/^no$/, ''))
```
**New code:** `canPlayType()` called directly; Opera version guard removed.

Opera 33 shipped in October 2015.

---

### 1.6 Safari < 15 WebM/WebA codec guard removed

Safari 15 shipped in October 2021. The guard that disabled WebM on Safari even when the browser reported support has been removed. `canPlayType()` already returns `''` for unsupported codecs.

---

### 1.7 IE / Trident detection removed from `_clearSound`

**Original code:**
```js
/MSIE |Trident\//.test(n._navigator && n._navigator.userAgent) ||
  (e.src = 'data:audio/wav;base64,...');
```
**New code:**
```js
node.src = 'data:audio/wav;base64,...';
```

Internet Explorer 11 reached end-of-support in June 2022. The guard is now applied unconditionally.

---

### 1.8 CocoonJS / Ejecta runtime checks removed

**Original code (in `play`):**
```js
var y = window && window.ejecta || !m.readyState && n._navigator.isCocoonJS;
if (m.readyState >= 3 || y) { ... }
```
**New code:**
```js
if (node.readyState >= 3) { ... }
```

CocoonJS was discontinued by Ludei in 2016. The `readyState` check alone is correct and sufficient.

---

## 2. Security Hardening

---

### 2.1 XHR replaced with `fetch()` — eliminates header injection vector

The old `setRequestHeader()` path accepted header names and values containing `\r\n` characters, which could enable HTTP header injection. The `Headers` constructor used by `fetch()` throws a `TypeError` on any invalid header name or value, making injection structurally impossible.

```js
if (howl._xhr.headers) {
  try {
    fetchOptions.headers = new Headers(howl._xhr.headers);
  } catch (e) {
    console.warn('Howler: Invalid XHR headers - ignoring.', e);
  }
}
fetch(src, fetchOptions)
```

---

### 2.2 HTTP status check uses numeric comparison

**Original code:**
```js
var n = (_ .status + '')[0];
if ('0' !== n && '2' !== n && '3' !== n) return void e._emit('loaderror', ...);
```
**New code:**
```js
if (response.status < 200 || response.status >= 400) {
  throw new Error('HTTP ' + response.status);
}
```

The original string-prefix check treated status `0` (network error / CORS block) as a non-error. Numeric range comparison is explicit, correct, and immune to future status code additions.

---

### 2.3 `withCredentials` now uses `fetch` credentials mode

```js
credentials: howl._xhr.withCredentials ? 'include' : 'same-origin'
```

The `'same-origin'` default matches XHR's default behaviour of sending cookies on same-origin requests.

---

### 2.4 MediaSession artwork URL scheme allowlist

**File:** `Howl.prototype.mediaSession`

ICY / sidecar metadata can include attacker-controlled `artwork.src` values. The original code clamped string length but did not validate the URL scheme. If a caller renders artwork in a DOM `<img>` tag (the typical pattern), a `javascript:` src is a stored XSS vector.

**New code adds a scheme allowlist:**
```js
var allowedScheme = /^https?:\/\//i;
artwork = info.artwork.map(function (a) {
  var src = sanitize(a.src, 2000);
  if (!allowedScheme.test(src)) return null; // reject non-http(s)
  return { src: src, sizes: sanitize(a.sizes, 20), type: sanitize(a.type, 50) };
}).filter(Boolean);
```

`javascript:`, `data:`, and any other non-http(s) scheme is now rejected before the value reaches `MediaMetadata`.

---

### 2.5 `crossOrigin` attribute on stream `<audio>` nodes

**File:** `Sound.prototype.create`

Stream nodes now have `crossOrigin` set to either `'use-credentials'` or `'anonymous'` depending on `xhr.withCredentials`. Without this attribute, the browser does not send the `Origin` header and does not validate CORS response headers, defeating any server-side CORS policy.

**Note on redirects:** If the stream URL redirects to a different origin and the redirect target lacks `Access-Control-Allow-Origin`, the browser will fail silently and trigger `loaderror`. Diagnose with:
```
curl -I --max-redirs 5 -H "Origin: https://your-station.com" <stream-url>
```

---

### 2.6 `workletUrl` scheme validation before `addModule()`

**File:** `_initWorkletTap`

`AudioWorklet.addModule()` loads and executes JavaScript in the audio worklet scope. If `workletUrl` comes from an untrusted source (e.g. ICY metadata), an attacker could load an arbitrary script. `workletUrl` is validated before `addModule()` is called: only `https:` and `blob:` schemes are accepted. All other values (including `http:`, `javascript:`, `data:`, and relative URLs) are rejected with a console warning.

```js
var url = String(cfg.workletUrl);
if (!/^https:\/\//i.test(url) && !/^blob:/i.test(url)) {
  console.warn('Howler [stream]: workletUrl rejected — only https: and blob: schemes allowed.');
  return;
}
```

**Note on CSP:** `AudioWorklet.addModule()` requires the module URL to be allowed by the page's `script-src` CSP directive. Ensure the worklet URL is covered by `'self'` or an explicit origin in your CSP.

**Note on `_clearSound` data URI:** The `data:audio/wav;base64,...` URI in `_clearSound` is assigned to `HTMLAudioElement.src` — a media attribute, not a script. CSP `script-src` does not govern media element sources; this URI is safe under any CSP policy.

---

### 2.7 `onStall` / `onRecover` callback data boundary

**File:** `_attachStreamNodeListeners`

`cfg.onStall` and `cfg.onRecover` are called with **zero arguments** — the library passes no data from the `<audio>` element to these callbacks. Callers receive only a notification signal. There is no ICY metadata leakage through these callbacks. If callers associate ICY metadata with a stall event, they are responsible for sanitising that metadata before rendering it in the DOM.

---

## 3. Performance Improvements

---

### 3.1 `XMLHttpRequest` replaced with `fetch()` + `AbortController`

In-flight audio fetch requests are now cancelled via `AbortController.abort()` when `unload()` is called. Previously, XHR callbacks could fire into a destroyed Howl object, causing errors and potential data corruption.

```js
var controller = new AbortController();
fetchOptions.signal = controller.signal;
howl._fetchControllers[src] = controller;
// ...
// In unload():
Object.keys(self._fetchControllers).forEach(function (src) {
  self._fetchControllers[src].abort();
});
```

---

### 3.2 `_soundById()` uses `Map` for O(1) lookup

The original `_soundById` implementation iterated `this._sounds` linearly. For Howls with large `pool` values under heavy polyphonic use, this was O(n) per sound lookup. The `_soundMap` Map provides O(1) lookup and is kept in sync through all lifecycle transitions (`init`, `reset`, `_drain`, `unload`).

---

### 3.3 `_audioCache` is a 100-entry LRU Map — bounded growth

The original `_audioCache` was a plain object with no eviction policy. Under sustained use with many distinct src values, it would grow without bound, accumulating `AudioBuffer` objects (each potentially several MB). The LRU Map evicts the oldest entry when capacity is reached.

---

### 3.4 `setInterval` fade replaced with `requestAnimationFrame`

The original `_startFadeInterval` used `setInterval` for the entire fade duration, firing at a fixed (often too-frequent) rate. The new implementation hands off to `requestAnimationFrame` after an initial step, synchronising fade steps with the display refresh rate and reducing CPU usage.

The elapsed-time calculation is clamped to 100 ms per frame to prevent a snap-to-target when the tab returns from the background after rAF was suspended (BUG-19).

---

### 3.5 `setTimeout(fn, 0)` event emission replaced with `queueMicrotask`

Event handler invocations in `_emit` are now scheduled as microtasks, running before the next macrotask (paint, I/O). This reduces event latency from ~4 ms (minimum timer clamping) to sub-millisecond.

On Chrome/Edge 94+, `scheduler.postTask` is layered over `queueMicrotask` as a progressive enhancement. Play/pause/stop/end/seek/load events use `priority: 'user-blocking'`; volume, rate, and mute events use `priority: 'background'`. See §4.4.

---

### 3.6 `_html5AudioPool` pre-allocation skipped for stream-only sessions

HTML5 Audio pool nodes are now only pre-allocated during the unlock sequence when at least one non-stream Howl is registered. Stream Howls manage their own `<audio>` nodes and never draw from the pool.

---

### 3.7 `sound._parent = null` on `unload()` breaks circular reference

`Sound` objects hold a reference to their parent `Howl`. If external code retains a `Sound` reference after `unload()`, the `Howl` could not be GC'd. Setting `sound._parent = null` in `unload()` breaks the cycle.

---

### 3.8 End timers cleared before reconnect

`_streamReconnect` now clears all `_endTimers` before reloading, preventing stale timer callbacks from accumulating across reconnect cycles.

---

### 3.9 Named stream event handler refs prevent stacking

Play/pause/stop/loaderror/unlock handlers for stream mode are stored as named references on `self._stream` and removed exactly once in `unload()`. Without named refs, repeated `unload()`/re-init cycles would stack anonymous handlers.

---

### 3.10 AudioWorklet teardown in `unload()`

**File:** `Howl.prototype.unload`

`_initWorkletTap` stored `cfg._workletSource` and `cfg._workletNode` on the stream config but `unload()` never disconnected them. The Web Audio graph retained both nodes indefinitely, preventing GC of the Howl and its `<audio>` element, and keeping the `MessagePort` alive.

**Fix:** `unload()` now explicitly disconnects both nodes, nulls the refs, and closes `AudioWorkletNode.port` (where supported).

```js
if (cfg._workletSource) {
  try { cfg._workletSource.disconnect(); } catch (e) {}
  cfg._workletSource = null;
}
if (cfg._workletNode) {
  try { cfg._workletNode.disconnect(); } catch (e) {}
  if (cfg._workletNode.port && typeof cfg._workletNode.port.close === 'function') {
    try { cfg._workletNode.port.close(); } catch (e) {}
  }
  cfg._workletNode = null;
}
```

---

## 4. API-Preserving Modernizations

---

### 4.1 `decodeAudioData` uses Promise form

```js
Howler.ctx.decodeAudioData(arrayBuffer).then(onSuccess).catch(onError);
```

The callback form of `decodeAudioData` is deprecated in the Web Audio API spec.

---

### 4.2 `atob()` loop replaced with `Uint8Array.from()`

```js
var bytes = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
```

The original code used a manual `for` loop to build a `Uint8Array` from a base64-decoded string. `Uint8Array.from()` with a mapping function is more idiomatic and slightly faster.

---

### 4.3 `AudioContext` created with `{ latencyHint: 'playback' }`

The `'playback'` hint instructs the browser to use larger internal audio buffers, reducing glitch risk under CPU load on mobile. For a 24/7 radio station — where low latency provides no user-perceptible benefit — this is always the correct hint.

---

### 4.4 `scheduler.postTask` progressive enhancement in `_emit`

**File:** `Howl.prototype._emit`

On Chrome/Edge 94+, event callbacks are now scheduled with `scheduler.postTask` instead of `queueMicrotask`:

- User-critical events (`play`, `pause`, `stop`, `end`, `seek`, `load`): `priority: 'user-blocking'`
- Background events (`volume`, `rate`, `mute`, `fade`): `priority: 'background'`

Falls back to `queueMicrotask` on Firefox and Safari, which do not yet implement `scheduler.postTask`.

---

### 4.5 `AudioContext.setSinkId()` — `Howler.setSinkId(deviceId)`

**File:** `HowlerGlobal.prototype.setSinkId`

New additive method (Chrome/Edge 110+). Routes audio output to a specific device without reloading the stream. Useful for radio station UIs that expose an output device picker (e.g. selecting Bluetooth speakers).

```js
// Route to a specific device
Howler.setSinkId(deviceId).then(function () {
  console.log('Routed to', deviceId);
}).catch(function (e) {
  console.error('setSinkId failed:', e);
});

// Route back to system default
Howler.setSinkId('');
```

Returns a resolved `Promise` on unsupported browsers (no-op). `deviceId` values come from `navigator.mediaDevices.enumerateDevices()`.

---

### 4.6 `Howler.autoReroute` + `devicechange` listener

**File:** Module-level `navigator.mediaDevices.addEventListener('devicechange', ...)`

When `Howler.autoReroute = true` (default `false`), the library listens for the `devicechange` event and checks whether the active output device (`Howler._sinkId`) is still present in the enumerated device list. If not, it calls `Howler.setSinkId('')` to re-route to the system default.

```js
Howler.autoReroute = true; // opt-in
```

This prevents silent audio when headphones or Bluetooth speakers are disconnected. Requires `setSinkId()` support (Chrome/Edge 110+). No-ops on unsupported browsers.

---

## 5. Streaming Additions

---

### 5.1 Stream mode (`options.stream`)

A new `options.stream` configuration object activates live stream mode for a Howl. Stream mode enforces `html5: true` (preventing the `arrayBuffer()` deadlock on infinite Icecast/Shoutcast/HLS responses), enables stall detection with exponential-backoff reconnection, and wires the full MediaSession API.

```js
new Howl({
  src: ['https://stream.example.com/live.mp3'],
  format: ['mp3'],
  stream: {
    staleTimeout:        4000,      // ms of stall before reconnect
    maxRetryDelay:       30000,     // ms ceiling on exponential backoff
    maxRetries:          Infinity,  // total reconnect attempt cap
    flushInterval:       7200000,   // ms between periodic buffer-flush reconnects
    sourceFailThreshold: 3,         // consecutive failures before src rotation
    onStall:             fn,        // called when stall is detected
    onRecover:           fn,        // called after confirmed stream health
    onPreviousTrack:     fn,        // MediaSession previoustrack
    onNextTrack:         fn,        // MediaSession nexttrack
    workletUrl:          null,      // AudioWorklet module URL
    onWorkletMessage:    fn,        // AudioWorkletNode.port messages
  }
});
```

---

### 5.2 Stall detection + exponential-backoff reconnection

`stalled` and `waiting` events on the `<audio>` node arm a `staleTimeout` timer. On expiry, `_streamReconnect` is called, which implements exponential backoff with jitter (to prevent CDN thundering-herd) up to `maxRetryDelay`. After `staleTimeout * 2` ms of uninterrupted playback, the backoff resets.

---

### 5.3 Silent reconnect (`_streamSilentReconnect`)

Used for network-change and periodic flush events. Briefly mutes the stream (~80 ms ramp), assigns a cache-busted URL, calls `node.load()` + `node.play()`, then ramps volume back. The gap is inaudible to most listeners.

If `node.play()` is rejected by the autoplay policy, the catch handler emits `'playerror'` and calls `_streamReconnect` after 500 ms so the standard retry machinery takes over. Previously (BUG-15), the catch handler silently returned with no fallback.

---

### 5.4 Periodic buffer-flush reconnect (`flushInterval`)

WebKit accumulates media buffer data over multi-hour sessions, eventually causing quality degradation or stalls. A periodic silent reconnect (default every 2 hours) flushes the internal buffer and reconnects to the live edge.

---

### 5.5 `visibilitychange` recovery

When the tab becomes visible after an iOS phone call or tab switch, the handler resumes a suspended `AudioContext` and restarts a paused-but-should-be-playing stream node.

---

### 5.6 `navigator.connection` reconnect (Chrome/Edge only)

A `change` listener on `navigator.connection` triggers a silent reconnect when `effectiveType` changes (e.g. 4G → 3G) or RTT spikes by more than 500 ms. This handles network interface switches (e.g. Wi-Fi → cellular) before the `staleTimeout` fires.

---

### 5.7 `online` / `offline` event integration

**File:** `Howl.prototype._initStreamMode`, `unload()`

`navigator.connection` is absent on Firefox and Safari. `window` `'offline'` and `'online'` events are handled on all browsers:

- `'offline'`: sets `cfg._offline = true` and cancels the stale timer. The stale timer is suppressed while offline (stalls are expected; burning retry budget on an unresolvable condition is wasteful).
- `'online'`: clears `cfg._offline` and triggers a silent reconnect if the stream was playing.

Handler refs are stored on `cfg._offlineHandler` / `cfg._onlineHandler` and removed in `unload()`.

---

### 5.8 `MediaSession` API

Stream Howls automatically wire the OS-level media controls (lock screen, car display, AirPods, Android notification shade) to `Howl.play()`, `Howl.pause()`, and `Howl.stop()`. `playbackState` is updated synchronously in play/pause handlers.

Additional MediaSession wiring:
- `seekto`: snaps to the live edge via silent reconnect instead of allowing raw `<audio>` scrubbing.
- `previoustrack` / `nexttrack`: delegate to optional `stream.onPreviousTrack` / `stream.onNextTrack` callbacks.
- `setPositionState({ duration: Infinity })`: marks the session as a live stream. Called from the `'play'` event handler (not at bind time) to comply with the MediaSession spec requirement that `setPositionState` only be called while `playbackState !== 'none'`.

**Lock screen artwork:** artwork URLs must be served from the same origin or with `Access-Control-Allow-Origin: *`. On iOS Safari, `MediaMetadata` fetches artwork immediately upon assignment; cross-origin artwork without CORS headers will silently fail to load.

---

### 5.9 `preservesPitch = false` on stream nodes

Disables the browser's pitch-correction DSP stage, which runs at the same cost regardless of `playbackRate`. For live streams, `playbackRate` is always `1.0`; pitch correction provides no benefit and burns CPU on mobile.

---

### 5.10 AudioWorklet tap (`stream.workletUrl`)

An AudioWorklet processing pipeline can be installed on a stream `<audio>` node by providing a `workletUrl` in the stream config. The pipeline runs off the main thread:

```
<audio> → MediaElementAudioSourceNode → AudioWorkletNode → Howler.masterGain → destination
```

Messages from the worklet processor are forwarded to `stream.onWorkletMessage(event)`. Howler's existing volume and mute controls target `Howler.masterGain`, which remains in the signal path.

**Security:** `workletUrl` is validated to `https:` or `blob:` before `addModule()` is called. See §2.6.

**Teardown:** `unload()` disconnects and nulls both the `MediaElementAudioSourceNode` and `AudioWorkletNode`, and closes the `MessagePort`. See §3.10.

---

### 5.11 `autoSuspend` management for streams

`Howler.autoSuspend` is set to `false` while a stream is playing (to prevent the AudioContext from suspending, which would interrupt the stream), and restored to `true` when the stream pauses, stops, or is unloaded.

---

### 5.12 Source URL rotation

**File:** `Howl.prototype._streamReconnect`

Previously, `_streamReconnect` always retried the same resolved URL. If the CDN edge assigned at load time became permanently unreachable, the only recovery was exhausting `maxRetries`.

The original `options.src` array is now preserved as `self._srcList`. After `stream.sourceFailThreshold` consecutive failures on the current source (default 3), `_streamReconnect` rotates to the next URL in `_srcList` (wrapping around), resets `_retryCount` and `_retryDelay`, and logs a warning. `_srcFailCount` is reset to 0 when a health confirmation timer fires.

---

## Bug Fixes

The following bug fixes are incorporated into the fork. Cross-references to the relevant sections above are included where the fix is described in full.

---

### BUG-01 · `_streamSilentReconnect` Promise chain inverted

**File:** `Howl.prototype._streamSilentReconnect`

The original `.catch().then()` chain was inverted: `.catch()` returns a resolved Promise, so `.then()` always fired regardless of whether `node.play()` succeeded or failed. Corrected to `.then(success).catch(failure)`. An `instanceof Promise` guard was added for the synchronous (non-Promise) path where `node.play()` returns `undefined`.

---

### BUG-02 · `seek()` `waitForUnlock` spin-loop froze the tab

**File:** `Howl.prototype.seek`

The original `waitForUnlock` implementation spun in `queueMicrotask`. Microtasks run before the event loop yields; if the Promise clearing `_playLock` was waiting on a browser media pipeline macrotask, the microtask queue never drained and the tab froze.

**Fix:** One microtask attempt followed by `setTimeout(0)` to yield the event loop:
```js
var waitForUnlock = function (useMacrotask) {
  if (self._playLock) {
    if (useMacrotask) {
      setTimeout(function () { waitForUnlock(true); }, 0);
    } else {
      queueMicrotask(function () { waitForUnlock(true); });
    }
  } else {
    resume();
  }
};
```

---

### BUG-03 · `_visibilityHandler` not declared in `_stream` literal

`_visibilityHandler` was assigned dynamically inside `_initStreamMode` but not declared in the `_stream` object literal, making it invisible to static analysis tools. Now explicitly declared as `_visibilityHandler: null` in the literal.

---

### BUG-04 · `_scheduleFlushReconnect` fired after `unload()` set `_stream` to null

Added a null guard: the flush timer callback returns immediately if `self._stream` is null.

---

### BUG-05 · Mixed `setTimeout`/`rAF` handle type caused incorrect cancellation + double `'fade'` event

A `_intervalType` flag (`'timeout'` | `'raf'` | `null`) was introduced to track which kind of handle is stored, and a `_fadeDone` flag prevents `_stopFade` from emitting `'fade'` when the tick has already emitted it naturally.

---

### BUG-06 · `_loadQueue` executed stale task after shift

The condition was inverted: it called `task.action()` on a reference that had already been shifted from the queue, and skipped the actual next task. Logic corrected.

---

### BUG-07 · `_streamReconnect` accumulated stale queue entries and end timers

`_streamReconnect` now flushes `self._queue` and clears all `_endTimers` before reloading, preventing stale-entry duplicate play calls.

---

### BUG-08 · Redundant `_autoSuspend()` call in `HowlerGlobal.init()`

Ran before `ctx` existed; only `_setup()` should call it. Removed.

---

### BUG-09 · `||`-on-DOMString codec detection for wav/flac/m4a/m4b/mp4

The `||` short-circuit evaluates `canPlayType()` return values as booleans — any non-empty string (including `'maybe'`) is truthy, masking the actual codec support status. The `_canPlay(audioTest, ...mimes)` helper iterates each MIME string independently.

---

### BUG-10 · `setPositionState({ duration: Infinity })` called before playback

`setPositionState` was called once at construction time (`playbackState: 'none'`). The MediaSession spec requires this call only while `playbackState !== 'none'`. Moved to the `'play'` event handler.

---

### BUG-11 · AudioWorklet teardown missing in `unload()`

See §3.10 for full description and fix code.

---

### BUG-12 · Concurrent `_rampNodeVolume` calls leave `node.volume` indeterminate 🔴

**File:** `_rampNodeVolume`, `Howl.prototype._streamSilentReconnect`

The `_rampNodeVolume` function stored the `setInterval` handle only in a local variable. If `_streamSilentReconnect` was called twice in quick succession (network change during flush-reconnect), two `setInterval` loops ran concurrently, both writing `node.volume`, producing glitches and an indeterminate final volume.

**Fix:** The interval handle is stored on `cfg._rampInterval`. Each new ramp cancels the previous one before starting. The handle is cleared in `unload()`.

---

### BUG-13 · `_autoResume` called on `'closed'` AudioContext throws `InvalidStateError` 🟠

**File:** `HowlerGlobal.prototype._autoResume`, `_visibilityHandler`

`Howler.unload()` closes the `AudioContext`. A dangling `visibilitychange` handler or timer could call `_autoResume` on the closed context before cleanup completed, throwing `InvalidStateError`.

**Fix:** `_autoResume` returns early if `ctx.state === 'closed'`. The `visibilitychange` handler also checks `ctx.state !== 'closed'` before calling `_autoResume`.

---

### BUG-14 · `_rampNodeVolume` NaN inputs silently mute permanently 🟠

**File:** `_rampNodeVolume`

If `from` or `to` were `NaN` (e.g. from a degraded `<audio>` node), `Math.max(0, Math.min(1, NaN + step * n))` evaluates to `NaN` on every tick. Browsers silently accept `node.volume = NaN`, permanently muting the element.

**Fix:** If `!isFinite(from) || !isFinite(to)`, write `to` directly (clamped to `[0, 1]`) and invoke the callback immediately without starting the interval.

---

### BUG-15 · Silent reconnect autoplay-block `catch` path had no fallback 🟠

See §5.3.

---

### BUG-16 · `_streamReconnect` never rotated to fallback source URLs 🟠

See §5.12.

---

### BUG-17 · `_loaderrorHandler` re-entered `_streamReconnect` after `maxRetries` exhausted 🟠

**File:** `Howl.prototype._initStreamMode`

`_streamReconnect` emits a synthetic `'loaderror'` when `maxRetries` is reached. The `loaderror` handler called `_streamReconnect()` unconditionally — including on this synthetic event — restarting the retry loop and nullifying `maxRetries`.

**Fix:** `_loaderrorHandler` guards: `if (cfg._retryCount <= cfg.maxRetries) self._streamReconnect()`. The synthetic loaderror is emitted only after `_retryCount > maxRetries`, so the guard prevents re-entry.

---

### BUG-18 · `_clearSound()` in `stop()` could corrupt `_state` / `_duration` via `_loadFn` 🟡

**File:** `Howl.prototype.stop`

When `stop()` called `_clearSound()` on an Infinity-duration node, the browser might fire `canplaythrough` for the silent WAV data URI, triggering `_loadListener` (still attached) which overwrote `parent._duration` (~0.1 s) and set `parent._state` to `'loaded'`, corrupting the Howl state.

**Fix:** `sound._loadFn` is explicitly removed before `_clearSound()` is called in `stop()`, mirroring the pattern already used in `unload()`.

---

### BUG-19 · `_startFadeInterval` rAF elapsed-time spike on tab-foreground return 🟡

See §3.4.

---

### BUG-20 · `navigator.mediaSession` null-deref on Safari PWA 🟡

**File:** `Howl.prototype.mediaSession`, `cfg._playHandler`, `cfg._pauseHandler`, `cfg._stopHandler`, `cfg._loaderrorHandler`

On some Safari PWA configurations, `'mediaSession' in navigator` is `true` but `navigator.mediaSession` is `null`. Property access on `null` throws `TypeError`.

**Fix:** All `navigator.mediaSession` accesses now guard `&& navigator.mediaSession` before property read/write. `playbackState` is also set synchronously in stream play/pause handlers (see BUG-23).

---

### BUG-21 · `workletUrl` not validated before `addModule()` 🟠

See §2.6.

---

### BUG-22 · `online` / `offline` events not handled; Firefox/Safari miss reconnect 🟡

See §5.7.

---

### BUG-23 · Flush timer not cancelled in play handler; `playbackState` via microtask 🟢

**File:** `cfg._playHandler`

The `pause` handler scheduled a flush-reconnect timer. If `play()` followed immediately, the timer from the pause was not cancelled (the play handler had no `_cancelFlushTimer` call), so the flush was scheduled from the wrong baseline. Additionally, `playbackState` was set via `queueMicrotask`, allowing out-of-order state updates on rapid play/pause toggles.

**Fix:** The play handler now calls `self._cancelFlushTimer()` followed by `self._scheduleFlushReconnect()` to reset the baseline. `playbackState` is set synchronously in both play and pause handlers.

---

### RES-01 · Network `change` reconnect gated on meaningful signal

The `navigator.connection` `change` listener now only reconnects when `effectiveType` changes or RTT spikes by more than 500 ms, avoiding unnecessary mutes on minor quality fluctuations.

---

### RES-02 · Backoff reset requires confirmed stream health

`_retryDelay` is now reset only after `staleTimeout * 2` ms of uninterrupted playback via a `_healthTimer`, preventing premature backoff collapse in stall-loop scenarios.

---

### RES-03 · `maxRetries` option prevents infinite reconnect loops

`stream.maxRetries` (default `Infinity`) caps total reconnect attempts. When exhausted, a `loaderror` event is emitted and reconnection stops.

---

### AUTO-01 · `unlock` event triggers stream play

If the AudioContext was locked at construction time, the stream now auto-plays when the `'unlock'` event fires (user's first gesture).

---

### AUTO-02 · `loaderror` resets MediaSession `playbackState`

`playbackState` is reset to `'none'` on `loaderror`, removing stale lock screen controls.

---

### AUTO-03 · `seekto` MediaSession handler prevents raw `<audio>` scrubbing

A `seekto` handler snaps to the live edge via silent reconnect instead of allowing the browser to assign an arbitrary `currentTime`.

---

### MOD-01 · `previoustrack` / `nexttrack` MediaSession handlers

Optional `stream.onPreviousTrack` / `stream.onNextTrack` callbacks enable station navigation from the lock screen.

---

### MOD-02 · Volume transition smoothed in `_streamSilentReconnect`

The instant `node.volume = 0` step was replaced with an 8-step linear ramp over 40 ms via `_rampNodeVolume`, eliminating audible clicks on devices with slow DSP pipelines.

---

### POL-6.1 · `pointerdown` replaces `touchstart`/`touchend` in `_unlockAudio`

**File:** `HowlerGlobal.prototype._unlockAudio`

The Pointer Events API (`pointerdown`) covers mouse, touch, and stylus inputs with a single event type. It fires earlier in the event sequence than `click` and is supported by all browsers in scope (Chrome 55+, Edge 79+, Firefox 59+, Safari 13+). `touchstart` and `touchend` are redundant on any device that implements Pointer Events and have been removed. `click` is retained for keyboard activation (Space/Enter on focused elements). `keydown` is retained for explicit keyboard navigation.

---

## Public API

### Unchanged from v2.2.4

- `new Howl(options)` — all existing option keys unchanged
- `Howl.prototype`: `play`, `pause`, `stop`, `mute`, `volume`, `fade`, `loop`, `rate`, `seek`, `playing`, `duration`, `state`, `unload`, `on`, `off`, `once`
- `Howler` (singleton): `volume`, `mute`, `stop`, `unload`, `codecs`
- Spatial plugin: `Howl.prototype.stereo`, `pos`, `orientation`, `pannerAttr`; `Howler.stereo`, `pos`, `orientation`
- All event names: `play`, `pause`, `stop`, `end`, `load`, `loaderror`, `playerror`, `fade`, `mute`, `volume`, `rate`, `seek`, `unlock`, `resume`
- AMD, CommonJS, and browser global exports

### New additions

| Addition | Type | Description |
|---|---|---|
| `options.stream` | New opt-in Howl option | Enables stream mode |
| `howl.mediaSession(info)` | New additive method | Updates MediaSession lock screen metadata |
| `Howler.autoSuspendDelay` | New configurable property | Overrides the 30 s auto-suspend delay |
| `stream.maxRetries` | New stream sub-option | Caps total reconnect attempts (default `Infinity`) |
| `stream.onPreviousTrack` | New stream sub-option | MediaSession `previoustrack` callback |
| `stream.onNextTrack` | New stream sub-option | MediaSession `nexttrack` callback |
| `stream.workletUrl` | New stream sub-option | AudioWorklet module URL for metering/processing tap |
| `stream.onWorkletMessage` | New stream sub-option | Receives messages from the worklet processor port |
| `stream.sourceFailThreshold` | New stream sub-option | Consecutive failures before source rotation (default `3`) |
| `Howler.setSinkId(deviceId)` | New additive method | Routes audio to a specific output device (Chrome/Edge 110+) |
| `Howler.autoReroute` | New configurable property | Auto-reroute on device removal (default `false`, requires setSinkId) |

---

## Compatibility

| Requirement | Minimum version |
|---|---|
| `AudioContext` (unprefixed) | Chrome 35, Firefox 25, Safari 14.1, Edge 12 |
| `AudioContext({ latencyHint })` | Chrome 58, Firefox 53, Safari 14.1, Edge 79 |
| `fetch()` | Chrome 42, Firefox 39, Safari 10.1, Edge 14 |
| `AbortController` | Chrome 66, Firefox 57, Safari 11.1, Edge 16 |
| `queueMicrotask()` | Chrome 71, Firefox 69, Safari 12.1, Edge 79 |
| `requestAnimationFrame` | Chrome 24, Firefox 23, Safari 6.1, Edge 12 |
| `Map` | Chrome 38, Firefox 13, Safari 8, Edge 12 |
| `Uint8Array.from()` | Chrome 45, Firefox 38, Safari 10, Edge 14 |
| `Promise` | Chrome 32, Firefox 29, Safari 8, Edge 12 |
| `PointerEvents` (`pointerdown`) | Chrome 55, Firefox 59, Safari 13, Edge 79 |
| `MediaSession` API | Chrome 73, Firefox 82, Safari 15, Edge 79 |
| `AudioWorklet` | Chrome 66, Firefox 76, Safari 14.1, Edge 79 |
| `MediaElementAudioSourceNode` | Chrome 23, Firefox 25, Safari 6, Edge 12 |
| `navigator.connection` | Chrome 61, Edge 79 *(absent on Firefox/Safari — graceful)* |
| `HTMLMediaElement.crossOrigin` | Chrome 33, Firefox 12, Safari 10.1, Edge 12 |
| `HTMLMediaElement.preservesPitch` | Chrome 86, Firefox 20, Safari 13, Edge 86 |
| `AudioContext.setSinkId()` | Chrome 110, Edge 110 *(progressive enhancement)* |
| `scheduler.postTask` | Chrome 94, Edge 94 *(progressive enhancement, falls back to queueMicrotask)* |
| `navigator.mediaDevices.ondevicechange` | Chrome 57, Firefox 52, Edge 12 *(absent on Safari — graceful)* |

All hard requirements are met by any browser with ≥1% market share as of 2026. `MediaSession`, `AudioWorklet`, `navigator.connection`, `setSinkId()`, `scheduler.postTask`, and `autoReroute` are treated as progressive enhancements — their absence is detected at runtime and the relevant code paths are skipped silently.

---

## File Size

| File | v2.2.4 | v2.5.0 | Delta |
|------|--------|--------|-------|
| `howler.js` (unminified) | ~53 KB | ~120 KB | +67 KB |
| `howler.min.js` (est.) | ~36 KB | ~70 KB | +34 KB |

The increase over v2.2.4 reflects streaming infrastructure, MediaSession integration, AudioWorklet tap, `setSinkId()` + `autoReroute`, source rotation, `online`/`offline` handling, and significantly denser inline documentation. For non-stream `Howl` instances, the runtime cost of these additions is negligible — stream code paths are only entered when `options.stream` is provided.
