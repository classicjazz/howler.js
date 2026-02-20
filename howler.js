/*!
 * Package: @classicjazz/howler.js
 * Version: 2.5.0
 *
 * (c) 2026 Michael Connelly
 * MIT License | https://github.com/classicjazz/howler.js
 *
 * Forked from howler.js v2.2.4
 * (c) 2013-2020 James Simpson of GoldFire Studios
 * MIT License | https://github.com/goldfire/howler.js
 *
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Audio buffer cache with simple LRU eviction
  // ---------------------------------------------------------------------------
  var CACHE_MAX = 100;
  var _audioCache = new Map(); // key -> AudioBuffer

  function cacheSet(key, value) {
    if (_audioCache.has(key)) {
      _audioCache.delete(key); // refresh position
    } else if (_audioCache.size >= CACHE_MAX) {
      // Evict oldest entry (first in insertion order)
      _audioCache.delete(_audioCache.keys().next().value);
    }
    _audioCache.set(key, value);
  }

  function cacheGet(key) {
    if (!_audioCache.has(key)) return undefined;
    var val = _audioCache.get(key);
    // Refresh to "most recently used" position
    _audioCache.delete(key);
    _audioCache.set(key, val);
    return val;
  }

  function cacheDelete(key) {
    _audioCache.delete(key);
  }

  // ---------------------------------------------------------------------------
  // Codec detection helper
  // Tests multiple MIME strings; returns true on the first supported one.
  // Uses a loop instead of || to avoid DOMString short-circuit ambiguity.
  // ---------------------------------------------------------------------------
  function _canPlay(audioTest) {
    for (var i = 1; i < arguments.length; i++) {
      var result = audioTest.canPlayType(arguments[i]).replace(/^no$/, '');
      if (result) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // HowlerGlobal
  // ---------------------------------------------------------------------------
  var HowlerGlobal = function () {
    this.init();
  };

  HowlerGlobal.prototype = {
    init: function () {
      var self = this || Howler;

      self._counter        = 1000;
      self._html5AudioPool = [];
      self.html5PoolSize   = 10;
      self._codecs         = {};
      self._howls          = [];
      self._muted          = false;
      self._volume         = 1;
      self._canPlayEvent   = 'canplaythrough';
      self._navigator      = (typeof window !== 'undefined' && window.navigator)
                               ? window.navigator : null;
      self.masterGain      = null;
      self.noAudio         = false;
      self.usingWebAudio   = true;
      self.autoSuspend     = true;
      self.autoSuspendDelay = 30000; // configurable (ms)
      self.ctx             = null;
      self.autoUnlock      = true;
      // When true, re-routes audio to the system default output device if the
      // active device is disconnected. Requires setSinkId() (Chrome/Edge 110+).
      // Default false so existing deployments are unaffected.
      self.autoReroute     = false;

      // _autoSuspend() is called inside _setup(), so we don't call it here.
      self._setup();
      return self;
    },

    volume: function (vol) {
      var self = this || Howler;
      vol = parseFloat(vol);

      self.ctx || _initCtx();

      if (typeof vol !== 'undefined' && vol >= 0 && vol <= 1) {
        self._volume = vol;
        if (self._muted) return self;

        if (self.usingWebAudio) {
          self.masterGain.gain.setValueAtTime(vol, Howler.ctx.currentTime);
        }

        for (var i = 0; i < self._howls.length; i++) {
          if (!self._howls[i]._webAudio) {
            var ids = self._howls[i]._getSoundIds();
            for (var j = 0; j < ids.length; j++) {
              var sound = self._howls[i]._soundById(ids[j]);
              if (sound && sound._node) {
                sound._node.volume = sound._volume * vol;
              }
            }
          }
        }
        return self;
      }

      return self._volume;
    },

    mute: function (muted) {
      var self = this || Howler;
      self.ctx || _initCtx();
      self._muted = muted;

      if (self.usingWebAudio) {
        self.masterGain.gain.setValueAtTime(
          muted ? 0 : self._volume,
          Howler.ctx.currentTime
        );
      }

      for (var i = 0; i < self._howls.length; i++) {
        if (!self._howls[i]._webAudio) {
          var ids = self._howls[i]._getSoundIds();
          for (var j = 0; j < ids.length; j++) {
            var sound = self._howls[i]._soundById(ids[j]);
            if (sound && sound._node) {
              sound._node.muted = !!muted || sound._muted;
            }
          }
        }
      }
      return self;
    },

    stop: function () {
      var self = this || Howler;
      for (var i = 0; i < self._howls.length; i++) {
        self._howls[i].stop();
      }
      return self;
    },

    unload: function () {
      var self = this || Howler;
      for (var i = self._howls.length - 1; i >= 0; i--) {
        self._howls[i].unload();
      }
      if (self.usingWebAudio && self.ctx && typeof self.ctx.close !== 'undefined') {
        self.ctx.close();
        self.ctx = null;
        _initCtx();
      }
      return self;
    },

    codecs: function (ext) {
      return (this || Howler)._codecs[ext.replace(/^x-/, '')];
    },

    _setup: function () {
      var self = this || Howler;
      self.state = self.ctx ? (self.ctx.state || 'suspended') : 'suspended';
      self._autoSuspend();

      if (!self.usingWebAudio) {
        if (typeof Audio !== 'undefined') {
          try {
            var a = new Audio();
            if (typeof a.oncanplaythrough === 'undefined') {
              self._canPlayEvent = 'canplay';
            }
          } catch (e) {
            self.noAudio = true;
          }
        } else {
          self.noAudio = true;
        }
      }

      try {
        var a = new Audio();
        if (a.muted) { self.noAudio = true; }
      } catch (e) {}

      if (!self.noAudio) {
        self._setupCodecs();
      }
      return self;
    },

    _setupCodecs: function () {
      var self = this || Howler;
      var audioTest = null;

      try {
        audioTest = (typeof Audio !== 'undefined') ? new Audio() : null;
      } catch (e) {
        return self;
      }

      if (!audioTest || typeof audioTest.canPlayType !== 'function') {
        return self;
      }

      // Use _canPlay() helper for multi-MIME checks to avoid || short-circuit
      // ambiguity on DOMStrings returned by canPlayType().
      var mpegTest = audioTest.canPlayType('audio/mpeg;').replace(/^no$/, '');

      self._codecs = {
        mp3:   !!(mpegTest || audioTest.canPlayType('audio/mp3;').replace(/^no$/, '')),
        mpeg:  !!mpegTest,
        opus:  !!audioTest.canPlayType('audio/ogg; codecs="opus"').replace(/^no$/, ''),
        ogg:   !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
        oga:   !!audioTest.canPlayType('audio/ogg; codecs="vorbis"').replace(/^no$/, ''),
        wav:   _canPlay(audioTest, 'audio/wav; codecs="1"', 'audio/wav'),
        aac:   !!audioTest.canPlayType('audio/aac;').replace(/^no$/, ''),
        caf:   !!audioTest.canPlayType('audio/x-caf;').replace(/^no$/, ''),
        m4a:   _canPlay(audioTest, 'audio/x-m4a;', 'audio/m4a;', 'audio/aac;'),
        m4b:   _canPlay(audioTest, 'audio/x-m4b;', 'audio/m4b;', 'audio/aac;'),
        mp4:   _canPlay(audioTest, 'audio/x-mp4;', 'audio/mp4;', 'audio/aac;'),
        weba:  !!audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, ''),
        webm:  !!audioTest.canPlayType('audio/webm; codecs="vorbis"').replace(/^no$/, ''),
        dolby: !!audioTest.canPlayType('audio/mp4; codecs="ec-3"').replace(/^no$/, ''),
        flac:  _canPlay(audioTest, 'audio/x-flac;', 'audio/flac;')
      };

      return self;
    },

    _unlockAudio: function () {
      var self = this || Howler;
      if (self._audioUnlocked || !self.ctx) return;

      self._audioUnlocked = false;
      self.autoUnlock = false;

      // If the AudioContext sample rate doesn't match 44100 Hz (common on
      // mobile), tear it down and rebuild. Skip if all Howls are html5-only —
      // those resample inside the browser's media pipeline.
      var allHtml5 = self._howls.length > 0 && self._howls.every(function (h) { return h._html5; });
      if (!self._mobileUnloaded && !allHtml5 && self.ctx.sampleRate !== 44100) {
        self._mobileUnloaded = true;
        self.unload();
      }

      self._scratchBuffer = self.ctx.createBuffer(1, 1, 22050);

      var unlock = function () {
        // Only fill the pool when non-stream Howls are present. Stream Howls
        // manage their own <audio> nodes and never draw from the pool.
        var hasNonStreamHowls = self._howls.some(function (h) { return !h._stream; });
        if (hasNonStreamHowls) {
          while (self._html5AudioPool.length < self.html5PoolSize) {
            try {
              var node = new Audio();
              node._unlocked = true;
              self._releaseHtml5Audio(node);
            } catch (e) {
              self.noAudio = true;
              break;
            }
          }
        }

        // Unlock any existing HTML5 sounds
        for (var i = 0; i < self._howls.length; i++) {
          if (!self._howls[i]._webAudio) {
            var ids = self._howls[i]._getSoundIds();
            for (var j = 0; j < ids.length; j++) {
              var sound = self._howls[i]._soundById(ids[j]);
              if (sound && sound._node && !sound._node._unlocked) {
                sound._node._unlocked = true;
                sound._node.load();
              }
            }
          }
        }

        self._autoResume();

        // Play a silent buffer to unlock the AudioContext
        var src = self.ctx.createBufferSource();
        src.buffer = self._scratchBuffer;
        src.connect(self.ctx.destination);
        src.start(0);

        if (typeof self.ctx.resume === 'function') {
          self.ctx.resume();
        }

        src.onended = function () {
          src.disconnect(0);
          self._audioUnlocked = true;

          // pointerdown covers mouse, touch, and stylus (Chrome 55+, Firefox 59+, Safari 13+).
          // click covers keyboard activation; keydown covers keyboard navigation.
          document.removeEventListener('pointerdown', unlock, true);
          document.removeEventListener('click',       unlock, true);
          document.removeEventListener('keydown',     unlock, true);

          for (var i = 0; i < self._howls.length; i++) {
            self._howls[i]._emit('unlock');
          }
        };
      };

      // pointerdown covers touch + mouse + stylus; click covers keyboard;
      // keydown covers keyboard navigation.
      document.addEventListener('pointerdown', unlock, true);
      document.addEventListener('click',       unlock, true);
      document.addEventListener('keydown',     unlock, true);

      return self;
    },

    _obtainHtml5Audio: function () {
      var self = this || Howler;
      if (self._html5AudioPool.length) {
        return self._html5AudioPool.pop();
      }

      // Pool exhausted — create a new one and warn via the promise rejection
      var node = new Audio();
      var playAttempt = node.play();
      if (playAttempt instanceof Promise) {
        playAttempt.catch(function () {
          console.warn('HTML5 Audio pool exhausted, returning potentially locked audio object.');
        });
      }
      return node;
    },

    _releaseHtml5Audio: function (node) {
      var self = this || Howler;
      if (node._unlocked) {
        self._html5AudioPool.push(node);
      }
      return self;
    },

    _autoSuspend: function () {
      var self = this;
      if (!self.autoSuspend || !self.ctx ||
          typeof self.ctx.suspend === 'undefined' || !Howler.usingWebAudio) {
        return self;
      }

      // Don't suspend if any sound is actively playing
      for (var i = 0; i < self._howls.length; i++) {
        if (self._howls[i]._webAudio) {
          for (var j = 0; j < self._howls[i]._sounds.length; j++) {
            if (!self._howls[i]._sounds[j]._paused) return self;
          }
        }
      }

      if (self._suspendTimer) {
        clearTimeout(self._suspendTimer);
      }

      self._suspendTimer = setTimeout(function () {
        if (!self.autoSuspend) return;
        self._suspendTimer = null;
        self.state = 'suspending';

        var afterSuspend = function () {
          self.state = 'suspended';
          if (self._resumeAfterSuspend) {
            delete self._resumeAfterSuspend;
            self._autoResume();
          }
        };

        self.ctx.suspend().then(afterSuspend, afterSuspend);
      }, self.autoSuspendDelay);

      return self;
    },

    _autoResume: function () {
      var self = this;
      // Guard against calling resume() on a closed AudioContext. Howler.unload()
      // closes ctx, and there is a brief window where a stale listener may call
      // _autoResume on it, which would throw InvalidStateError.
      if (!self.ctx || typeof self.ctx.resume === 'undefined' || !Howler.usingWebAudio) {
        return self;
      }
      if (self.ctx.state === 'closed') {
        return self;
      }

      if (self.state === 'running' &&
          self.ctx.state !== 'interrupted' &&
          self._suspendTimer) {
        clearTimeout(self._suspendTimer);
        self._suspendTimer = null;
      } else if (self.state === 'suspended' ||
                 (self.state === 'running' && self.ctx.state === 'interrupted')) {
        self.ctx.resume().then(function () {
          self.state = 'running';
          for (var i = 0; i < self._howls.length; i++) {
            self._howls[i]._emit('resume');
          }
        });
        if (self._suspendTimer) {
          clearTimeout(self._suspendTimer);
          self._suspendTimer = null;
        }
      } else if (self.state === 'suspending') {
        self._resumeAfterSuspend = true;
      }

      return self;
    },

    // -------------------------------------------------------------------------
    // setSinkId(deviceId) — additive method (v2.5.0)
    // Routes audio output to a specific device (Chrome/Edge 110+).
    // Returns a Promise. Resolves immediately as a no-op on unsupported browsers.
    // deviceId: string from MediaDeviceInfo.deviceId; '' = system default.
    // Note: requires prior user permission via getUserMedia or enumerateDevices
    // on some browsers before device IDs are surfaced.
    // -------------------------------------------------------------------------
    setSinkId: function (deviceId) {
      var self = this;
      if (!self.ctx || typeof self.ctx.setSinkId !== 'function') {
        return Promise.resolve(); // progressive enhancement — no-op on unsupported browsers
      }
      return self.ctx.setSinkId(deviceId).then(function () {
        self._sinkId = deviceId;
      });
    }
  };

  // Singleton global
  var Howler = new HowlerGlobal();

  // ---------------------------------------------------------------------------
  // Howl
  // ---------------------------------------------------------------------------
  var Howl = function (options) {
    if (!options.src || options.src.length === 0) {
      console.error('An array of source files must be passed with any new Howl.');
      return;
    }
    this.init(options);
  };

  Howl.prototype = {
    init: function (options) {
      var self = this;

      Howler.ctx || _initCtx();

      self._autoplay   = options.autoplay  || false;
      self._format     = (typeof options.format !== 'string') ? options.format : [options.format];
      self._html5      = options.html5     || false;
      self._muted      = options.mute      || false;
      self._loop       = options.loop      || false;
      self._pool       = options.pool      || 5;
      self._preload    = (typeof options.preload !== 'boolean' && options.preload !== 'metadata')
                           ? true : options.preload;
      self._rate       = options.rate      || 1;
      self._sprite     = options.sprite    || {};
      self._src        = (typeof options.src !== 'string') ? options.src : [options.src];
      // Preserve the original src array so _streamReconnect can rotate between
      // fallback URLs. After load() resolves _src to a single string, _srcList
      // retains all candidate URLs in their original order.
      self._srcList    = (typeof options.src !== 'string') ? options.src.slice() : [options.src];
      self._volume     = options.volume !== undefined ? options.volume : 1;
      self._xhr        = {
        method:          (options.xhr && options.xhr.method)          ? options.xhr.method : 'GET',
        headers:         (options.xhr && options.xhr.headers)         ? options.xhr.headers : null,
        withCredentials: (options.xhr && options.xhr.withCredentials) ? options.xhr.withCredentials : false
      };

      // -----------------------------------------------------------------------
      // Stream mode configuration
      // When options.stream is provided this Howl is treated as a live stream:
      //  - html5 is forced to true (the WebAudio fetch path deadlocks on
      //    infinite HTTP responses from Icecast/Shoutcast/HLS).
      //  - crossOrigin is set on the <audio> node for correct CORS behaviour.
      //  - Stall detection and exponential-backoff reconnection are activated.
      //  - A periodic buffer-flush reconnect runs every flushInterval ms.
      //  - MediaSession is managed automatically.
      //  - autoSuspend is disabled while the stream is playing.
      //  - AudioWorklet tap is installed when workletUrl is provided.
      // -----------------------------------------------------------------------
      self._stream = null;
      if (options.stream !== undefined && options.stream !== null && options.stream !== false) {
        var s = (typeof options.stream === 'object') ? options.stream : {};
        self._stream = {
          // Public config
          staleTimeout:     s.staleTimeout     || 4000,
          maxRetryDelay:    s.maxRetryDelay    || 30000,
          // Caps total reconnect attempts; prevents infinite loops when origin is down.
          maxRetries:       s.maxRetries !== undefined ? s.maxRetries : Infinity,
          flushInterval:    s.flushInterval    || 7200000,
          // After this many consecutive failures on one source URL, _streamReconnect
          // rotates to the next URL in _srcList (wrapping). Resets on source change or health.
          sourceFailThreshold: s.sourceFailThreshold !== undefined ? s.sourceFailThreshold : 3,
          onStall:          typeof s.onStall          === 'function' ? s.onStall          : null,
          onRecover:        typeof s.onRecover        === 'function' ? s.onRecover        : null,
          // MediaSession station navigation callbacks
          onPreviousTrack:  typeof s.onPreviousTrack  === 'function' ? s.onPreviousTrack  : null,
          onNextTrack:      typeof s.onNextTrack       === 'function' ? s.onNextTrack      : null,
          // AudioWorklet tap for metering / processing
          workletUrl:       s.workletUrl       || null,
          onWorkletMessage: typeof s.onWorkletMessage === 'function' ? s.onWorkletMessage : null,
          // Internal state
          _retryDelay:         1000,
          _retryCount:         0,       // cumulative reconnect attempts per source
          _srcIndex:           0,       // index into _srcList for rotation
          _srcFailCount:       0,       // consecutive failures on current source
          _staleTimer:         null,
          _healthTimer:        null,    // confirms stream health before backoff reset
          _reconnecting:       false,
          _flushTimer:         null,
          _networkHandler:     null,
          // Declared explicitly so this appears in the object shape for static analysis.
          _visibilityHandler:  null,
          // Named event handler refs for clean removal in unload()
          _playHandler:        null,
          _pauseHandler:       null,
          _stopHandler:        null,
          _loaderrorHandler:   null,
          _unlockHandler:      null,
          // online/offline handler refs
          _onlineHandler:      null,
          _offlineHandler:     null,
          // Network quality tracking for smarter reconnect gating
          _lastEffectiveType:  null,
          _lastRtt:            null,
          // offline suppression flag
          _offline:            false,
          // ramp interval handle for concurrent-ramp cancellation
          _rampInterval:       null
        };
        // Enforce html5 for all stream Howls
        self._html5    = true;
        self._webAudio = false;
        if (options.autoplay) {
          console.warn(
            'Howler [stream]: autoplay:true on a stream Howl may be blocked by ' +
            'the browser Autoplay Policy. Call howl.play() from a user gesture ' +
            '(click, touchend, keydown) instead. ' +
            'See: https://developer.chrome.com/blog/autoplay/'
          );
        }
      }

      self._duration         = 0;
      self._state            = 'unloaded';
      self._sounds           = [];
      self._soundMap         = new Map(); // O(1) id -> Sound lookup
      self._endTimers        = {};
      self._queue            = [];
      self._playLock         = false;
      self._fetchControllers = {}; // AbortControllers keyed by src

      // Event handler arrays
      self._onend        = options.onend        ? [{ fn: options.onend }]        : [];
      self._onfade       = options.onfade       ? [{ fn: options.onfade }]       : [];
      self._onload       = options.onload       ? [{ fn: options.onload }]       : [];
      self._onloaderror  = options.onloaderror  ? [{ fn: options.onloaderror }]  : [];
      self._onplayerror  = options.onplayerror  ? [{ fn: options.onplayerror }]  : [];
      self._onpause      = options.onpause      ? [{ fn: options.onpause }]      : [];
      self._onplay       = options.onplay       ? [{ fn: options.onplay }]       : [];
      self._onstop       = options.onstop       ? [{ fn: options.onstop }]       : [];
      self._onmute       = options.onmute       ? [{ fn: options.onmute }]       : [];
      self._onvolume     = options.onvolume     ? [{ fn: options.onvolume }]     : [];
      self._onrate       = options.onrate       ? [{ fn: options.onrate }]       : [];
      self._onseek       = options.onseek       ? [{ fn: options.onseek }]       : [];
      self._onunlock     = options.onunlock     ? [{ fn: options.onunlock }]     : [];
      self._onresume     = [];

      self._webAudio = Howler.usingWebAudio && !self._html5;

      if (typeof Howler.ctx !== 'undefined' && Howler.ctx && Howler.autoUnlock) {
        Howler._unlockAudio();
      }

      Howler._howls.push(self);

      if (self._autoplay) {
        self._queue.push({ event: 'play', action: function () { self.play(); } });
      }

      if (self._preload && self._preload !== 'none') {
        self.load();
      }

      // Wire stream-mode infrastructure once the Howl is constructed.
      if (self._stream) {
        self._initStreamMode();
      }

      return self;
    },

    // -------------------------------------------------------------------------
    // mediaSession(info) — updates MediaSession metadata (lock screen, car
    // display, etc.). info: { title, artist, album, artwork } — all optional.
    // artwork must be an array of { src, sizes, type } objects per the spec.
    //
    // Security: string values are clamped to 500 chars; artwork src values are
    // clamped to 2000 chars and must use http(s) scheme to prevent XSS via
    // unvalidated ICY/sidecar metadata.
    // -------------------------------------------------------------------------
    mediaSession: function (info) {
      // Guard navigator.mediaSession itself — on some Safari PWA configurations
      // 'mediaSession' in navigator is true but the value is null.
      if (typeof navigator === 'undefined' || !('mediaSession' in navigator) ||
          !navigator.mediaSession) {
        return this;
      }
      info = info || {};

      var sanitize = function (v, max) {
        return typeof v === 'string' ? v.slice(0, max || 500) : '';
      };

      // Only allow http(s) artwork src URLs to prevent XSS via malicious ICY
      // metadata when the caller renders artwork in an <img> tag.
      var allowedScheme = /^https?:\/\//i;
      var artwork = [];
      if (Array.isArray(info.artwork)) {
        artwork = info.artwork.map(function (a) {
          var src = sanitize(a.src, 2000);
          if (!allowedScheme.test(src)) return null; // reject non-http(s)
          return { src: src, sizes: sanitize(a.sizes, 20), type: sanitize(a.type, 50) };
        }).filter(Boolean);
      }

      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title:   sanitize(info.title)  || 'Live Radio',
          artist:  sanitize(info.artist) || '',
          album:   sanitize(info.album)  || '',
          artwork: artwork
        });
      } catch (e) {
        // MediaMetadata not supported — fail silently
      }
      return this;
    },

    // -------------------------------------------------------------------------
    // _initStreamMode — called from init() for stream Howls.
    // Wires stall detection, reconnection, periodic buffer-flush, network-change
    // listener, visibilitychange recovery, MediaSession action handlers, and
    // AudioContext autoSuspend management. Internal — not part of public API.
    // -------------------------------------------------------------------------
    _initStreamMode: function () {
      var self = this;
      var cfg  = self._stream;

      // --- MediaSession action handlers (lock screen / car display) -----------
      _bindMediaSessionActions(self);

      // --- visibilitychange: resume AudioContext + restart stalled node -------
      // _visibilityHandler is declared on the _stream object so the guard
      // below is reliable and avoids duplicate listener registration.
      if (typeof document !== 'undefined' && !cfg._visibilityHandler) {
        cfg._visibilityHandler = function () {
          if (document.visibilityState !== 'visible') return;
          // Guard: Howler.unload() closes ctx; don't call _autoResume on it.
          if (Howler.ctx && Howler.ctx.state !== 'closed' && Howler.ctx.state !== 'running') {
            Howler._autoResume();
          }
          // If we think the stream is playing but the node is paused, restart it
          var sound = self._sounds[0];
          if (sound && sound._node && sound._node.paused && !sound._paused) {
            sound._node.play().catch(function () {});
          }
        };
        document.addEventListener('visibilitychange', cfg._visibilityHandler, false);
      }

      // Reconnect preemptively on meaningful network changes (effectiveType
      // change or RTT spike >500 ms). Ignores minor quality fluctuations.
      if (typeof navigator !== 'undefined' &&
          navigator.connection &&
          typeof navigator.connection.addEventListener === 'function' &&
          !cfg._networkHandler) {
        cfg._networkHandler = function () {
          var conn = navigator.connection;
          var prevType = cfg._lastEffectiveType;
          var prevRtt  = cfg._lastRtt;
          cfg._lastEffectiveType = conn.effectiveType || null;
          cfg._lastRtt           = conn.rtt           || null;

          var typeChanged = prevType && prevType !== cfg._lastEffectiveType;
          var rttJump     = prevRtt  && cfg._lastRtt && (cfg._lastRtt - prevRtt) > 500;

          if ((typeChanged || rttJump) && self.playing()) {
            self._streamSilentReconnect(false);
          }
        };
        // Capture current baseline so the first comparison is meaningful
        if (navigator.connection) {
          cfg._lastEffectiveType = navigator.connection.effectiveType || null;
          cfg._lastRtt           = navigator.connection.rtt           || null;
        }
        navigator.connection.addEventListener('change', cfg._networkHandler);
      }

      // --- Periodic buffer-flush reconnect ------------------------------------
      self._scheduleFlushReconnect();

      // Store handlers as named refs so they can be removed cleanly in unload(),
      // preventing stacking if the Howl is reused.
      cfg._playHandler = function () {
        Howler.autoSuspend = false;
        if (Howler.ctx && Howler.ctx.state === 'suspended') {
          Howler.ctx.resume();
        }
        // Null-guard navigator.mediaSession (may be absent or null on Safari PWA).
        // Set playbackState synchronously to avoid out-of-order state on rapid
        // play/pause toggles.
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'playing';
        }
        // setPositionState must be called while playbackState is 'playing'.
        try {
          if (navigator.mediaSession) {
            navigator.mediaSession.setPositionState({
              duration:     Infinity,
              playbackRate: 1,
              position:     0
            });
          }
        } catch (e) {}
        // Cancel any pending flush timer from a prior pause, then reschedule
        // from the new play session's start time.
        self._cancelFlushTimer();
        self._scheduleFlushReconnect();
        // Reset backoff only after confirmed health (see _attachStreamNodeListeners)
        // — do NOT reset _retryDelay here.
      };
      self.on('play', cfg._playHandler);

      cfg._pauseHandler = function () {
        // Re-enable autoSuspend when user deliberately pauses
        Howler.autoSuspend      = true;
        Howler.autoSuspendDelay = 60000;
        // Null-guard + synchronous update (see play handler above).
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'paused';
        }
        self._cancelStaleTimer();
        self._cancelFlushTimer();
        self._scheduleFlushReconnect();
      };
      self.on('pause', cfg._pauseHandler);

      cfg._stopHandler = function () {
        Howler.autoSuspend = true;
        // Null-guard for navigator.mediaSession.
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'none';
        }
        self._cancelStaleTimer();
        self._cancelFlushTimer();
      };
      self.on('stop', cfg._stopHandler);

      // Reset MediaSession playbackState on loaderror, then reconnect if
      // the retry budget hasn't been exhausted (guard prevents re-entry).
      cfg._loaderrorHandler = function (id, err) {
        // Null-guard for navigator.mediaSession.
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'none';
        }
        // _streamReconnect emits a synthetic 'loaderror' when maxRetries is
        // exhausted. Guard prevents that event from re-entering _streamReconnect.
        if (self._stream && cfg._retryCount <= cfg.maxRetries) {
          self._streamReconnect();
        }
      };
      self.on('loaderror', cfg._loaderrorHandler);

      // When the AudioContext is unlocked by a user gesture, auto-play the
      // stream if it was loaded but blocked on autoplay policy.
      cfg._unlockHandler = function () {
        if (self._stream && !self.playing() && self._state === 'loaded') {
          self.play();
        }
      };
      self.once('unlock', cfg._unlockHandler);

      // online/offline handlers for Firefox and Safari (no navigator.connection).
      // offline: set _offline=true to suppress stale timer while disconnected.
      // online: clear flag and silently reconnect if the stream was playing.
      if (typeof window !== 'undefined') {
        cfg._offlineHandler = function () {
          cfg._offline = true;
          self._cancelStaleTimer();
          clearTimeout(cfg._healthTimer);
        };
        cfg._onlineHandler = function () {
          if (!cfg._offline) return;
          cfg._offline = false;
          if (self.playing()) {
            self._streamSilentReconnect(false);
          }
        };
        window.addEventListener('offline', cfg._offlineHandler, false);
        window.addEventListener('online',  cfg._onlineHandler,  false);
      }
    },

    // -------------------------------------------------------------------------
    // _attachStreamNodeListeners — called from Sound.create() for stream nodes.
    // Wires 'stalled', 'waiting', 'playing', and 'error' events on the raw
    // <audio> node after it has been created and its src has been set.
    // -------------------------------------------------------------------------
    _attachStreamNodeListeners: function (node) {
      var self = this;
      var cfg  = self._stream;

      // stalled: browser has stopped receiving data (~3 s with no progress)
      node.addEventListener('stalled', function () {
        self._scheduleStaleTimer();
        // onStall receives no arguments from the library.
        if (cfg.onStall) { cfg.onStall(); }
      }, false);

      // waiting: decoder buffer is empty; a brief underrun is imminent
      node.addEventListener('waiting', function () {
        self._scheduleStaleTimer();
      }, false);

      // Only reset backoff after staleTimeout*2 ms of clean playback to avoid
      // premature reset during a stall loop (single frame doesn't mean healthy).
      node.addEventListener('playing', function () {
        self._cancelStaleTimer();
        cfg._reconnecting = false;
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          navigator.mediaSession.playbackState = 'playing';
        }
        // Start (or restart) the health confirmation timer
        clearTimeout(cfg._healthTimer);
        cfg._healthTimer = setTimeout(function () {
          cfg._retryDelay  = 1000; // confirmed healthy — reset backoff
          cfg._retryCount  = 0;   // also reset cumulative attempt counter
          cfg._srcFailCount = 0;  // reset per-source fail counter on confirmed health
          if (cfg.onRecover) { cfg.onRecover(); }
        }, cfg.staleTimeout * 2);
      }, false);

      // Disable pitch-correction DSP — it costs CPU with no benefit when
      // playbackRate is always 1.0 (live streams never scrub).
      if ('preservesPitch' in node) {
        node.preservesPitch = false;
      }
    },

    // -------------------------------------------------------------------------
    // _scheduleStaleTimer / _cancelStaleTimer
    // -------------------------------------------------------------------------
    _scheduleStaleTimer: function () {
      var self = this;
      var cfg  = self._stream;
      if (cfg._staleTimer) return; // already armed
      // Don't arm the reconnect timer while offline — the stall is expected,
      // and retrying wastes the retry budget. Wait for the 'online' event.
      if (cfg._offline) return;
      cfg._staleTimer = setTimeout(function () {
        cfg._staleTimer = null;
        if (!cfg._reconnecting) {
          self._streamReconnect();
        }
      }, cfg.staleTimeout);
    },

    _cancelStaleTimer: function () {
      var cfg = this._stream;
      if (cfg && cfg._staleTimer) {
        clearTimeout(cfg._staleTimer);
        cfg._staleTimer = null;
      }
    },

    // -------------------------------------------------------------------------
    // _scheduleFlushReconnect / _cancelFlushTimer
    // Periodic silent reconnect to flush browser-internal media buffers that
    // accumulate over hours on mobile (especially Safari/WebKit).
    // -------------------------------------------------------------------------
    _scheduleFlushReconnect: function () {
      var self = this;
      var cfg  = self._stream;
      if (!cfg || !cfg.flushInterval) return;
      self._cancelFlushTimer();
      cfg._flushTimer = setTimeout(function () {
        cfg._flushTimer = null;
        // Guard: this timer may fire after unload() set _stream to null.
        if (!self._stream) return;
        if (self.playing()) {
          self._streamSilentReconnect(true);
        }
        // Reschedule regardless so it keeps running even if paused
        self._scheduleFlushReconnect();
      }, cfg.flushInterval);
    },

    _cancelFlushTimer: function () {
      var cfg = this._stream;
      if (cfg && cfg._flushTimer) {
        clearTimeout(cfg._flushTimer);
        cfg._flushTimer = null;
      }
    },

    // -------------------------------------------------------------------------
    // _streamSilentReconnect — gap-free reconnect for network-change / flush.
    // Briefly mutes (~80 ms), reassigns src with a cache-busting parameter,
    // then restores volume.
    // -------------------------------------------------------------------------
    _streamSilentReconnect: function (isForcedFlush) {
      var self  = this;
      var sound = self._sounds[0];
      if (!sound || !sound._node) return;

      var node  = sound._node;
      var cfg   = self._stream;
      var src   = typeof self._src === 'string' ? self._src : self._src[0];
      // Cache-bust to get a fresh connection to the live edge
      var fresh = src + (src.indexOf('?') >= 0 ? '&' : '?') + '_t=' + Date.now();

      // Ramp volume down quickly to mask the reconnect click
      var prevVolume = node.volume;
      _rampNodeVolume(cfg, node, prevVolume, 0, 40, function () {
        node.src = fresh;
        node.load();

        var playPromise = node.play();
        if (playPromise instanceof Promise) {
          playPromise
            .then(function () {
              _rampNodeVolume(cfg, node, 0, prevVolume, 40, null);
            })
            .catch(function () {
              // Play blocked by autoplay policy. Restore volume so the user
              // can see the play button, notify the app, then schedule a full
              // reconnect so normal retry machinery takes over.
              node.volume = prevVolume;
              if (self._stream) {
                self._emit('playerror', null,
                  'Stream silent reconnect was blocked by autoplay policy. ' +
                  'Call play() from a user gesture.');
                // Give the browser a moment before re-entering reconnect logic.
                setTimeout(function () {
                  if (self._stream) self._streamReconnect();
                }, 500);
              }
            });
        } else {
          // Synchronous path (rare): no Promise returned, restore volume directly
          node.volume = prevVolume;
        }
      });
    },

    // -------------------------------------------------------------------------
    // _streamReconnect — exponential-backoff reconnect after error / stall.
    // Flushes stale queue entries before reloading, and honours maxRetries
    // to avoid infinite retry loops.
    // -------------------------------------------------------------------------
    _streamReconnect: function () {
      var self = this;
      var cfg  = self._stream;
      if (cfg._reconnecting) return;

      // Stop retrying after maxRetries attempts (per source)
      cfg._retryCount++;
      if (cfg._retryCount > cfg.maxRetries) {
        self._emit('loaderror', null, 'Stream: maximum reconnect attempts (' + cfg.maxRetries + ') reached.');
        return;
      }

      // After sourceFailThreshold consecutive failures on the current URL,
      // rotate to the next URL in _srcList (wraps around). Handles the case
      // where a CDN edge is permanently down but a fallback URL is available.
      cfg._srcFailCount++;
      if (cfg._srcFailCount >= cfg.sourceFailThreshold &&
          self._srcList && self._srcList.length > 1) {
        cfg._srcIndex    = (cfg._srcIndex + 1) % self._srcList.length;
        cfg._srcFailCount = 0;
        cfg._retryCount  = 0;
        cfg._retryDelay  = 1000;
        // Overwrite the resolved _src so load() picks up the new URL.
        self._src = self._srcList[cfg._srcIndex];
        console.warn('Howler [stream]: rotating to source ' + self._src);
      }

      cfg._reconnecting = true;
      self._cancelStaleTimer();
      clearTimeout(cfg._healthTimer);

      var delay = cfg._retryDelay + Math.random() * 1000; // add jitter
      cfg._retryDelay = Math.min(cfg._retryDelay * 2, cfg.maxRetryDelay);

      setTimeout(function () {
        if (!self._stream) return; // unloaded during wait

        // Flush stale queued actions from the previous load cycle to prevent
        // duplicate play() calls from corrupting _playLock.
        var timerIds = Object.keys(self._endTimers);
        for (var i = 0; i < timerIds.length; i++) {
          self._clearTimer(parseInt(timerIds[i], 10));
        }
        self._queue = [];

        // Reload using the existing Howl infrastructure
        self._state = 'unloaded';
        self.load();
        // Attempt to resume playback; play() will queue if still loading
        self.play();
      }, delay);
    },

    // -------------------------------------------------------------------------
    // load — unchanged public API; stream guard added internally.
    // -------------------------------------------------------------------------
    load: function () {
      var self = this;
      var src  = null;

      if (Howler.noAudio) {
        self._emit('loaderror', null, 'No audio support.');
        return;
      }

      if (typeof self._src === 'string') {
        self._src = [self._src];
      }

      for (var i = 0; i < self._src.length; i++) {
        var ext, url;

        if (self._format && self._format[i]) {
          ext = self._format[i];
        } else {
          if (typeof self._src[i] !== 'string') {
            self._emit('loaderror', null, 'Non-string found in selected audio sources - ignoring.');
            continue;
          }
          url = self._src[i];
          ext = /^data:audio\/([^;,]+);/i.exec(url);
          if (!ext) {
            ext = /\.([^.]+)$/.exec(url.split('?', 1)[0]);
          }
          if (ext) {
            ext = ext[1].toLowerCase();
          }
        }

        if (!ext) {
          console.warn('No file extension was found. Consider using the "format" property or specify an extension.');
        }

        if (ext && Howler.codecs(ext)) {
          src = self._src[i];
          break;
        }
      }

      if (!src) {
        self._emit('loaderror', null, 'No codec support for selected audio sources.');
        return;
      }

      self._src   = src;
      self._state = 'loading';

      // Upgrade http -> html5 on https pages
      if (window.location.protocol === 'https:' && src.slice(0, 5) === 'http:') {
        self._html5    = true;
        self._webAudio = false;
      }

      // Ensure stream Howls always use HTML5 Audio. The WebAudio fetch path
      // calls response.arrayBuffer() which deadlocks on infinite HTTP responses
      // from Icecast/Shoutcast/HLS (the body never completes).
      if (self._stream && self._webAudio) {
        console.warn(
          'Howler [stream]: forcing html5:true — the WebAudio fetch path is ' +
          'incompatible with infinite HTTP streams and would deadlock the tab.'
        );
        self._html5    = true;
        self._webAudio = false;
      }

      new Sound(self);

      if (self._webAudio) {
        _fetchAudio(self);
      }

      return self;
    },

    play: function (sprite, internal) {
      var self    = this;
      var soundId = null;

      if (typeof sprite === 'number') {
        soundId = sprite;
        sprite  = null;
      } else {
        if (typeof sprite === 'string' && self._state === 'loaded' && !self._sprite[sprite]) {
          return null;
        }

        if (typeof sprite === 'undefined') {
          sprite = '__default';
          if (!self._playLock) {
            var playingCount = 0;
            for (var i = 0; i < self._sounds.length; i++) {
              if (self._sounds[i]._paused && !self._sounds[i]._ended) {
                playingCount++;
                soundId = self._sounds[i]._id;
              }
            }
            if (playingCount === 1) { sprite = null; } else { soundId = null; }
          }
        }
      }

      var sound = soundId ? self._soundById(soundId) : self._inactiveSound();
      if (!sound) return null;

      if (soundId && !sprite) {
        sprite = sound._sprite || '__default';
      }

      if (self._state !== 'loaded') {
        sound._sprite = sprite;
        sound._ended  = false;
        var waitId    = sound._id;
        self._queue.push({ event: 'play', action: function () { self.play(waitId); } });
        return waitId;
      }

      if (soundId && !sound._paused) {
        if (!internal) self._loadQueue('play');
        return sound._id;
      }

      if (self._webAudio) Howler._autoResume();

      var seek     = Math.max(0, sound._seek > 0 ? sound._seek : self._sprite[sprite][0] / 1000);
      var duration = Math.max(0, (self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000 - seek);
      var timeout  = (duration * 1000) / Math.abs(sound._rate);
      var startPos = self._sprite[sprite][0] / 1000;
      var stopPos  = (self._sprite[sprite][0] + self._sprite[sprite][1]) / 1000;

      sound._sprite = sprite;
      sound._ended  = false;

      var setProps = function () {
        sound._paused = false;
        sound._seek   = seek;
        sound._start  = startPos;
        sound._stop   = stopPos;
        sound._loop   = !!(sound._loop || self._sprite[sprite][2]);
      };

      if (seek >= stopPos) {
        self._ended(sound);
        return;
      }

      var node = sound._node;

      if (self._webAudio) {
        var startPlay = function () {
          self._playLock = false;
          setProps();
          self._refreshBuffer(sound);

          var vol = (sound._muted || self._muted) ? 0 : sound._volume;
          node.gain.setValueAtTime(vol, Howler.ctx.currentTime);
          sound._playStart = Howler.ctx.currentTime;

          if (sound._loop) {
            node.bufferSource.start(0, seek, 86400);
          } else {
            node.bufferSource.start(0, seek, duration);
          }

          if (timeout !== Infinity) {
            self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
          }

          if (!internal) {
            queueMicrotask(function () {
              self._emit('play', sound._id);
              self._loadQueue();
            });
          }
        };

        if (Howler.state === 'running' && Howler.ctx.state !== 'interrupted') {
          startPlay();
        } else {
          self._playLock = true;
          self.once('resume', startPlay);
          self._clearTimer(sound._id);
        }
      } else {
        // HTML5 Audio path
        var startHtml5 = function () {
          node.currentTime  = seek;
          node.muted        = sound._muted || self._muted || Howler._muted || node.muted;
          node.volume       = sound._volume * Howler.volume();
          node.playbackRate = sound._rate;

          try {
            var playPromise = node.play();

            if (playPromise instanceof Promise) {
              self._playLock = true;
              setProps();
              playPromise
                .then(function () {
                  self._playLock = false;
                  node._unlocked = true;
                  if (!internal) {
                    self._emit('play', sound._id);
                  } else {
                    self._loadQueue();
                  }
                })
                .catch(function () {
                  self._playLock  = false;
                  self._emit('playerror', sound._id,
                    'Playback was unable to start. This is most commonly an issue on mobile devices and Chrome where playback was not within a user interaction.');
                  sound._ended  = true;
                  sound._paused = true;
                });
            } else if (!internal) {
              self._playLock = false;
              setProps();
              self._emit('play', sound._id);
            }

            node.playbackRate = sound._rate;

            if (node.paused) {
              self._emit('playerror', sound._id,
                'Playback was unable to start. This is most commonly an issue on mobile devices and Chrome where playback was not within a user interaction.');
              return;
            }

            if (sprite !== '__default' || sound._loop) {
              self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), timeout);
            } else {
              self._endTimers[sound._id] = function () {
                self._ended(sound);
                node.removeEventListener('ended', self._endTimers[sound._id], false);
              };
              node.addEventListener('ended', self._endTimers[sound._id], false);
            }
          } catch (e) {
            self._emit('playerror', sound._id, e);
          }
        };

        var isReady = node.readyState >= 3;
        if (isReady) {
          startHtml5();
        } else {
          self._playLock = true;
          self._state    = 'loading';

          var listener = function () {
            self._state = 'loaded';
            startHtml5();
            node.removeEventListener(Howler._canPlayEvent, listener, false);
          };
          node.addEventListener(Howler._canPlayEvent, listener, false);
          self._clearTimer(sound._id);
        }
      }

      return sound._id;
    },

    pause: function (id) {
      var self = this;

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'pause', action: function () { self.pause(id); } });
        return self;
      }

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        self._clearTimer(ids[i]);

        var sound = self._soundById(ids[i]);
        if (sound && !sound._paused) {
          sound._seek     = self.seek(ids[i]);
          sound._rateSeek = 0;
          sound._paused   = true;
          self._stopFade(ids[i]);

          if (sound._node) {
            if (self._webAudio) {
              if (!sound._node.bufferSource) continue;
              sound._node.bufferSource.stop(0);
              self._cleanBuffer(sound._node);
            } else {
              if (!isNaN(sound._node.duration) || sound._node.duration === Infinity) {
                sound._node.pause();
              }
            }
          }
        }

        if (!arguments[1]) {
          self._emit('pause', sound ? sound._id : null);
        }
      }

      return self;
    },

    stop: function (id, internal) {
      var self = this;

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'stop', action: function () { self.stop(id); } });
        return self;
      }

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        self._clearTimer(ids[i]);

        var sound = self._soundById(ids[i]);
        if (sound) {
          sound._seek     = sound._start || 0;
          sound._rateSeek = 0;
          sound._paused   = true;
          sound._ended    = true;
          self._stopFade(ids[i]);

          if (sound._node) {
            if (self._webAudio) {
              if (sound._node.bufferSource) {
                sound._node.bufferSource.stop(0);
                self._cleanBuffer(sound._node);
              }
            } else {
              if (!isNaN(sound._node.duration) || sound._node.duration === Infinity) {
                sound._node.currentTime = sound._start || 0;
                sound._node.pause();
                if (sound._node.duration === Infinity) {
                  // _clearSound() reassigns node.src to a silent WAV. Remove
                  // _loadFn first so canplaythrough doesn't fire for the WAV
                  // and corrupt _duration/_state.
                  if (sound._loadFn) {
                    sound._node.removeEventListener(Howler._canPlayEvent, sound._loadFn, false);
                    sound._loadFn = null;
                  }
                  self._clearSound(sound._node);
                }
              }
            }
          }

          if (!internal) {
            self._emit('stop', sound._id);
          }
        }
      }

      return self;
    },

    mute: function (muted, id) {
      var self = this;

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'mute', action: function () { self.mute(muted, id); } });
        return self;
      }

      if (typeof id === 'undefined') {
        if (typeof muted === 'boolean') {
          self._muted = muted;
        } else {
          return self._muted;
        }
      }

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        var sound = self._soundById(ids[i]);
        if (sound) {
          sound._muted = muted;
          if (sound._interval) self._stopFade(sound._id);

          if (self._webAudio && sound._node) {
            sound._node.gain.setValueAtTime(muted ? 0 : sound._volume, Howler.ctx.currentTime);
          } else if (sound._node) {
            sound._node.muted = Howler._muted || muted;
          }

          self._emit('mute', sound._id);
        }
      }

      return self;
    },

    volume: function () {
      var self = this;
      var args = arguments;
      var vol, id;

      if (args.length === 0) {
        return self._volume;
      }

      if (args.length === 1 || (args.length === 2 && typeof args[1] === 'undefined')) {
        if (self._getSoundIds().indexOf(args[0]) >= 0) {
          id = parseInt(args[0], 10);
        } else {
          vol = parseFloat(args[0]);
        }
      } else if (args.length >= 2) {
        vol = parseFloat(args[0]);
        id  = parseInt(args[1], 10);
      }

      var sound;
      if (typeof vol === 'undefined' || vol < 0 || vol > 1) {
        sound = id ? self._soundById(id) : self._sounds[0];
        return sound ? sound._volume : 0;
      }

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'volume', action: function () { self.volume.apply(self, args); } });
        return self;
      }

      if (typeof id === 'undefined') self._volume = vol;

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        sound = self._soundById(ids[i]);
        if (sound) {
          sound._volume = vol;
          if (!args[2]) self._stopFade(ids[i]);
          if (self._webAudio && sound._node && !sound._muted) {
            sound._node.gain.setValueAtTime(vol, Howler.ctx.currentTime);
          } else if (sound._node && !sound._muted) {
            sound._node.volume = vol * Howler.volume();
          }
          self._emit('volume', sound._id);
        }
      }

      return self;
    },

    fade: function (from, to, duration, id) {
      var self = this;

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'fade', action: function () { self.fade(from, to, duration, id); } });
        return self;
      }

      from     = Math.min(Math.max(0, parseFloat(from)), 1);
      to       = Math.min(Math.max(0, parseFloat(to)), 1);
      duration = parseFloat(duration);

      self.volume(from, id);

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        var sound = self._soundById(ids[i]);
        if (sound) {
          if (!id) self._stopFade(ids[i]);

          if (self._webAudio && !sound._muted) {
            var now  = Howler.ctx.currentTime;
            var end  = now + duration / 1000;
            sound._volume = from;
            sound._node.gain.setValueAtTime(from, now);
            sound._node.gain.linearRampToValueAtTime(to, end);
          }

          self._startFadeInterval(sound, from, to, duration, ids[i], typeof id === 'undefined');
        }
      }

      return self;
    },

    // _startFadeInterval / _stopFade
    //
    // _intervalType ('timeout'|'raf'|null) tracks what kind of handle is stored
    // in sound._interval so _stopFade can cancel it correctly. A `done` guard
    // prevents _stopFade from emitting 'fade' when the tick already did.
    _startFadeInterval: function (sound, from, to, duration, id, isGroup) {
      var self     = this;
      var vol      = from;
      var diff     = to - from;
      var steps    = Math.abs(diff / 0.01);
      var stepTime = Math.max(4, steps > 0 ? duration / steps : duration);
      var lastTime = performance.now();
      var done     = false;

      sound._fadeTo       = to;
      sound._fadeDone     = false; // BUG-05: track natural completion

      var tick = function (now) {
        if (done) return;

        // When the tab is backgrounded, rAF is suspended. On return,
        // `now - lastTime` can spike by many seconds, instantly snapping vol
        // to `to`. Clamp to 100 ms to keep the fade smooth.
        var elapsed = Math.min(now - lastTime, 100);
        lastTime    = now;
        vol        += diff * (elapsed / duration);
        vol         = Math.round(vol * 100) / 100;
        vol         = diff < 0 ? Math.max(to, vol) : Math.min(to, vol);

        if (self._webAudio) {
          sound._volume = vol;
        } else {
          self.volume(vol, sound._id, true);
        }
        if (isGroup) { self._volume = vol; }

        if ((to < from && vol <= to) || (to > from && vol >= to)) {
          done              = true;
          sound._fadeDone   = true; // mark before clearing handles
          sound._interval   = null;
          sound._intervalType = null;
          sound._fadeTo     = null;
          self.volume(to, sound._id);
          self._emit('fade', sound._id);
          return;
        }

        sound._interval     = requestAnimationFrame(tick);
        sound._intervalType = 'raf';
      };

      // Use a short initial setTimeout to honour stepTime, then hand off to rAF
      sound._intervalType = 'timeout';
      sound._interval     = setTimeout(function () {
        lastTime            = performance.now();
        sound._intervalType = 'raf';
        sound._interval     = requestAnimationFrame(tick);
      }, stepTime);
    },

    _stopFade: function (id) {
      var self  = this;
      var sound = self._soundById(id);

      if (sound && sound._interval) {
        if (self._webAudio) {
          sound._node.gain.cancelScheduledValues(Howler.ctx.currentTime);
        }
        // Use _intervalType to cancel the correct kind of handle.
        if (sound._intervalType === 'raf') {
          cancelAnimationFrame(sound._interval);
        } else {
          clearTimeout(sound._interval);
        }
        sound._interval     = null;
        sound._intervalType = null;

        // Only emit 'fade' if the tick didn't already emit it naturally
        if (!sound._fadeDone) {
          self.volume(sound._fadeTo, id);
          sound._fadeTo  = null;
          sound._fadeDone = null;
          self._emit('fade', id);
        } else {
          sound._fadeDone = null;
        }
      }

      return self;
    },

    loop: function () {
      var self = this;
      var args = arguments;
      var loop, id, sound;

      if (args.length === 0) return self._loop;

      if (args.length === 1) {
        if (typeof args[0] === 'boolean') {
          loop      = args[0];
          self._loop = loop;
        } else {
          sound = self._soundById(parseInt(args[0], 10));
          return !!(sound && sound._loop);
        }
      } else if (args.length === 2) {
        loop = args[0];
        id   = parseInt(args[1], 10);
      }

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        sound = self._soundById(ids[i]);
        if (sound) {
          sound._loop = loop;
          if (self._webAudio && sound._node && sound._node.bufferSource) {
            sound._node.bufferSource.loop = loop;
            if (loop) {
              sound._node.bufferSource.loopStart = sound._start || 0;
              sound._node.bufferSource.loopEnd   = sound._stop;
              if (self.playing(ids[i])) {
                self.pause(ids[i], true);
                self.play(ids[i], true);
              }
            }
          }
        }
      }

      return self;
    },

    rate: function () {
      var self = this;
      var args = arguments;
      var rate, id;

      if (args.length === 0) {
        id = self._sounds[0]._id;
      } else if (args.length === 1) {
        var allIds = self._getSoundIds();
        if (allIds.indexOf(args[0]) >= 0) {
          id = parseInt(args[0], 10);
        } else {
          rate = parseFloat(args[0]);
        }
      } else if (args.length === 2) {
        rate = parseFloat(args[0]);
        id   = parseInt(args[1], 10);
      }

      if (typeof rate !== 'number') {
        var sound = self._soundById(id);
        return sound ? sound._rate : self._rate;
      }

      if (self._state !== 'loaded' || self._playLock) {
        self._queue.push({ event: 'rate', action: function () { self.rate.apply(self, args); } });
        return self;
      }

      if (typeof id === 'undefined') self._rate = rate;

      var ids = self._getSoundIds(id);
      for (var i = 0; i < ids.length; i++) {
        var sound = self._soundById(ids[i]);
        if (sound) {
          if (self.playing(ids[i])) {
            sound._rateSeek  = self.seek(ids[i]);
            sound._playStart = self._webAudio ? Howler.ctx.currentTime : sound._playStart;
          }
          sound._rate = rate;

          if (self._webAudio && sound._node && sound._node.bufferSource) {
            sound._node.bufferSource.playbackRate.setValueAtTime(rate, Howler.ctx.currentTime);
          } else if (sound._node) {
            sound._node.playbackRate = rate;
          }

          var seek    = self.seek(ids[i]);
          var dur     = (self._sprite[sound._sprite][0] + self._sprite[sound._sprite][1]) / 1000 - seek;
          var timeout = (dur * 1000) / Math.abs(sound._rate);

          if (self._endTimers[ids[i]] || !sound._paused) {
            self._clearTimer(ids[i]);
            self._endTimers[ids[i]] = setTimeout(self._ended.bind(self, sound), timeout);
          }

          self._emit('rate', sound._id);
        }
      }

      return self;
    },

    seek: function () {
      var self = this;
      var args = arguments;
      var seek, id;

      if (args.length === 0) {
        if (self._sounds.length) id = self._sounds[0]._id;
      } else if (args.length === 1) {
        var allIds = self._getSoundIds();
        if (allIds.indexOf(args[0]) >= 0) {
          id = parseInt(args[0], 10);
        } else if (self._sounds.length) {
          id   = self._sounds[0]._id;
          seek = parseFloat(args[0]);
        }
      } else if (args.length === 2) {
        seek = parseFloat(args[0]);
        id   = parseInt(args[1], 10);
      }

      if (typeof id === 'undefined') return 0;

      if (typeof seek === 'number' && (self._state !== 'loaded' || self._playLock)) {
        self._queue.push({ event: 'seek', action: function () { self.seek.apply(self, args); } });
        return self;
      }

      var sound = self._soundById(id);
      if (!sound) return self;

      if (typeof seek !== 'number' || seek < 0) {
        // Get current position
        if (self._webAudio) {
          var playing  = self.playing(id);
          var elapsed  = playing ? Howler.ctx.currentTime - sound._playStart : 0;
          var rateAdj  = sound._rateSeek ? sound._rateSeek - sound._seek : 0;
          return sound._seek + (rateAdj + elapsed * Math.abs(sound._rate));
        }
        return sound._node.currentTime;
      }

      var isPlaying = self.playing(id);
      if (isPlaying) self.pause(id, true);

      sound._seek   = seek;
      sound._ended  = false;
      self._clearTimer(id);

      if (!self._webAudio && sound._node && !isNaN(sound._node.duration)) {
        sound._node.currentTime = seek;
      }

      var resume = function () {
        if (isPlaying) self.play(id, true);
        self._emit('seek', id);
      };

      if (isPlaying && !self._webAudio) {
        // Try once in a microtask (fast path when _playLock is already clear),
        // then fall back to setTimeout(0) to yield the event loop and allow
        // pending Promise resolution to run (avoids a potential tab hang).
        var waitForUnlock = function (useMacrotask) {
          if (self._playLock) {
            if (useMacrotask) {
              setTimeout(function () { waitForUnlock(true); }, 0);
            } else {
              // First attempt: microtask (no delay if _playLock is already clear)
              queueMicrotask(function () { waitForUnlock(true); });
            }
          } else {
            resume();
          }
        };
        queueMicrotask(function () { waitForUnlock(false); });
      } else {
        resume();
      }

      return self;
    },

    playing: function (id) {
      var self = this;
      if (typeof id === 'number') {
        var sound = self._soundById(id);
        return !!(sound && !sound._paused);
      }
      for (var i = 0; i < self._sounds.length; i++) {
        if (!self._sounds[i]._paused) return true;
      }
      return false;
    },

    duration: function (id) {
      var self  = this;
      var dur   = self._duration;
      var sound = self._soundById(id);
      if (sound) {
        dur = self._sprite[sound._sprite][1] / 1000;
      }
      return dur;
    },

    state: function () {
      return this._state;
    },

    unload: function () {
      var self = this;

      // Abort any in-flight fetch requests
      Object.keys(self._fetchControllers).forEach(function (src) {
        self._fetchControllers[src].abort();
      });
      self._fetchControllers = {};

      // Stream mode teardown: cancel all timers and remove external listeners
      if (self._stream) {
        self._cancelStaleTimer();
        self._cancelFlushTimer();

        var cfg = self._stream;

        // Clear health confirmation timer
        clearTimeout(cfg._healthTimer);
        cfg._healthTimer = null;

        if (cfg._networkHandler && typeof navigator !== 'undefined' &&
            navigator.connection &&
            typeof navigator.connection.removeEventListener === 'function') {
          navigator.connection.removeEventListener('change', cfg._networkHandler);
          cfg._networkHandler = null;
        }

        if (cfg._visibilityHandler && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', cfg._visibilityHandler, false);
          cfg._visibilityHandler = null;
        }

        // Remove named event handlers to prevent stacking and break closures
        // that would keep this Howl alive in memory.
        if (cfg._playHandler)      { self.off('play',      cfg._playHandler);      cfg._playHandler      = null; }
        if (cfg._pauseHandler)     { self.off('pause',     cfg._pauseHandler);     cfg._pauseHandler     = null; }
        if (cfg._stopHandler)      { self.off('stop',      cfg._stopHandler);      cfg._stopHandler      = null; }
        if (cfg._loaderrorHandler) { self.off('loaderror', cfg._loaderrorHandler); cfg._loaderrorHandler = null; }
        if (cfg._unlockHandler)    { self.off('unlock',    cfg._unlockHandler);    cfg._unlockHandler    = null; }

        // Remove online/offline handlers added in _initStreamMode.
        if (cfg._offlineHandler && typeof window !== 'undefined') {
          window.removeEventListener('offline', cfg._offlineHandler, false);
          cfg._offlineHandler = null;
        }
        if (cfg._onlineHandler && typeof window !== 'undefined') {
          window.removeEventListener('online', cfg._onlineHandler, false);
          cfg._onlineHandler = null;
        }

        // Disconnect AudioWorklet nodes. Without this the Web Audio graph
        // keeps them alive, preventing GC of the Howl and its <audio> element.
        if (cfg._workletSource) {
          try { cfg._workletSource.disconnect(); } catch (e) {}
          cfg._workletSource = null;
        }
        if (cfg._workletNode) {
          try { cfg._workletNode.disconnect(); } catch (e) {}
          // Close the MessagePort to release the underlying MessageChannel.
          if (cfg._workletNode.port && typeof cfg._workletNode.port.close === 'function') {
            try { cfg._workletNode.port.close(); } catch (e) {}
          }
          cfg._workletNode = null;
        }

        // Cancel any in-progress volume ramp.
        if (cfg._rampInterval) {
          clearInterval(cfg._rampInterval);
          cfg._rampInterval = null;
        }

        // Clear MediaSession on unload so stale metadata isn't shown
        if (typeof navigator !== 'undefined' && navigator.mediaSession) {
          try { navigator.mediaSession.metadata      = null;   } catch (e) {}
          try { navigator.mediaSession.playbackState = 'none'; } catch (e) {}
        }

        self._stream = null;
        // Restore autoSuspend to its default
        Howler.autoSuspend = true;
      }

      var sounds = self._sounds;
      for (var i = 0; i < sounds.length; i++) {
        if (!sounds[i]._paused) {
          self.stop(sounds[i]._id);
        }
        if (!self._webAudio) {
          self._clearSound(sounds[i]._node);
          sounds[i]._node.removeEventListener('error',               sounds[i]._errorFn, false);
          sounds[i]._node.removeEventListener(Howler._canPlayEvent,  sounds[i]._loadFn,  false);
          sounds[i]._node.removeEventListener('ended',               sounds[i]._endFn,   false);
          Howler._releaseHtml5Audio(sounds[i]._node);
        }
        // Break circular reference so orphaned Sound objects can be GC'd even
        // if external code still holds a Sound reference.
        sounds[i]._parent = null;
        delete sounds[i]._node;
        self._clearTimer(sounds[i]._id);
      }

      var index = Howler._howls.indexOf(self);
      if (index >= 0) Howler._howls.splice(index, 1);

      // Remove from cache if no other Howl references this src
      var canDelete = true;
      for (var j = 0; j < Howler._howls.length; j++) {
        if (Howler._howls[j]._src === self._src ||
            (Array.isArray(self._src) && self._src.indexOf(Howler._howls[j]._src) >= 0)) {
          canDelete = false;
          break;
        }
      }
      if (canDelete) {
        cacheDelete(self._src);
      }

      Howler.noAudio = false;
      self._state    = 'unloaded';
      self._sounds   = [];
      self._soundMap = new Map();
      // Note: `self = null` sets the local variable only and does not help GC;
      // removed to avoid the misleading no-op.
      return null;
    },

    on: function (event, fn, id, once) {
      var self     = this;
      var handlers = self['_on' + event];
      if (typeof fn === 'function') {
        handlers.push(once ? { id: id, fn: fn, once: once } : { id: id, fn: fn });
      }
      return self;
    },

    off: function (event, fn, id) {
      var self     = this;
      var handlers = self['_on' + event];
      var i        = 0;

      if (typeof fn === 'number') {
        id = fn;
        fn = null;
      }

      if (fn || id) {
        for (i = 0; i < handlers.length; i++) {
          if ((fn === handlers[i].fn && id === handlers[i].id) ||
              (!fn && id === handlers[i].id)) {
            handlers.splice(i, 1);
            break;
          }
        }
      } else if (event) {
        self['_on' + event] = [];
      } else {
        var keys = Object.keys(self);
        for (i = 0; i < keys.length; i++) {
          if (keys[i].indexOf('_on') === 0 && Array.isArray(self[keys[i]])) {
            self[keys[i]] = [];
          }
        }
      }

      return self;
    },

    once: function (event, fn, id) {
      var self = this;
      self.on(event, fn, id, 1);
      return self;
    },

    _emit: function (event, id, msg) {
      var self     = this;
      var handlers = self['_on' + event];

      // Use scheduler.postTask (Chrome/Edge 94+) to give user-critical events
      // higher scheduling priority. Falls back to queueMicrotask on other browsers.
      var highPriorityEvents = { play: 1, pause: 1, stop: 1, end: 1, seek: 1, load: 1 };
      var useScheduler = typeof scheduler !== 'undefined' &&
                         typeof scheduler.postTask === 'function';
      var enqueue = useScheduler
        ? function (fn, evt) {
            var priority = highPriorityEvents[evt] ? 'user-blocking' : 'background';
            scheduler.postTask(fn, { priority: priority });
          }
        : function (fn) { queueMicrotask(fn); };

      for (var i = handlers.length - 1; i >= 0; i--) {
        if (!handlers[i].id || handlers[i].id === id || event === 'load') {
          (function (fn, evt) {
            enqueue(function () { fn.call(self, id, msg); }, evt);
          })(handlers[i].fn, event);
          if (handlers[i].once) {
            self.off(event, handlers[i].fn, handlers[i].id);
          }
        }
      }

      self._loadQueue(event);
      return self;
    },

    // Processes the deferred action queue.
    // Without event: execute the head task's action immediately.
    // With event: if the head task matches, shift it and recurse.
    _loadQueue: function (event) {
      var self = this;
      if (self._queue.length === 0) return self;

      var task = self._queue[0];

      if (!event) {
        // Called unconditionally: execute the head task now
        task.action();
      } else if (task.event === event) {
        // Called after matching event: advance and process the next task
        self._queue.shift();
        self._loadQueue();
      }

      return self;
    },

    _ended: function (sound) {
      var self   = this;
      var sprite = sound._sprite;

      // For HTML5, double-check the node hasn't continued playing
      if (!self._webAudio && sound._node &&
          !sound._node.paused && !sound._node.ended &&
          sound._node.currentTime < sound._stop) {
        setTimeout(self._ended.bind(self, sound), 100);
        return self;
      }

      var isLoop = !!(sound._loop || self._sprite[sprite][2]);
      self._emit('end', sound._id);

      if (!self._webAudio && isLoop) {
        self.stop(sound._id, true).play(sound._id);
      }

      if (self._webAudio && isLoop) {
        self._emit('play', sound._id);
        sound._seek      = sound._start || 0;
        sound._rateSeek  = 0;
        sound._playStart = Howler.ctx.currentTime;
        var loopTimeout  = ((sound._stop - sound._start) * 1000) / Math.abs(sound._rate);
        self._endTimers[sound._id] = setTimeout(self._ended.bind(self, sound), loopTimeout);
      }

      if (self._webAudio && !isLoop) {
        sound._paused   = true;
        sound._ended    = true;
        sound._seek     = sound._start || 0;
        sound._rateSeek = 0;
        self._clearTimer(sound._id);
        self._cleanBuffer(sound._node);
        Howler._autoSuspend();
      }

      if (!self._webAudio && !isLoop) {
        self.stop(sound._id, true);
      }

      return self;
    },

    _clearTimer: function (id) {
      var self = this;
      if (self._endTimers[id]) {
        if (typeof self._endTimers[id] !== 'function') {
          clearTimeout(self._endTimers[id]);
        } else {
          var sound = self._soundById(id);
          if (sound && sound._node) {
            sound._node.removeEventListener('ended', self._endTimers[id], false);
          }
        }
        delete self._endTimers[id];
      }
      return self;
    },

    // O(1) lookup via Map
    _soundById: function (id) {
      return this._soundMap.get(id) || null;
    },

    _inactiveSound: function () {
      var self = this;
      self._drain();
      for (var i = 0; i < self._sounds.length; i++) {
        if (self._sounds[i]._ended) {
          return self._sounds[i].reset();
        }
      }
      return new Sound(self);
    },

    _drain: function () {
      var self  = this;
      var limit = self._pool;
      var ended = 0;

      if (self._sounds.length < limit) return;

      for (var i = 0; i < self._sounds.length; i++) {
        if (self._sounds[i]._ended) ended++;
      }

      for (var j = self._sounds.length - 1; j >= 0; j--) {
        if (ended <= limit) break;
        if (self._sounds[j]._ended) {
          if (self._webAudio && self._sounds[j]._node) {
            self._sounds[j]._node.disconnect(0);
          }
          // Remove from Map too
          self._soundMap.delete(self._sounds[j]._id);
          self._sounds.splice(j, 1);
          ended--;
        }
      }
    },

    _getSoundIds: function (id) {
      if (typeof id === 'undefined') {
        return this._sounds.map(function (s) { return s._id; });
      }
      return [id];
    },

    _refreshBuffer: function (sound) {
      var self = this;
      sound._node.bufferSource = Howler.ctx.createBufferSource();
      sound._node.bufferSource.buffer = cacheGet(self._src);

      if (sound._panner) {
        sound._node.bufferSource.connect(sound._panner);
      } else {
        sound._node.bufferSource.connect(sound._node);
      }

      sound._node.bufferSource.loop = sound._loop;
      if (sound._loop) {
        sound._node.bufferSource.loopStart = sound._start || 0;
        sound._node.bufferSource.loopEnd   = sound._stop  || 0;
      }
      sound._node.bufferSource.playbackRate.setValueAtTime(sound._rate, Howler.ctx.currentTime);
      return self;
    },

    _cleanBuffer: function (node) {
      if (!node.bufferSource) return this;

      if (Howler._scratchBuffer && node.bufferSource) {
        node.bufferSource.onended = null;
        node.bufferSource.disconnect(0);
        // Safari quirk: assign scratch buffer to avoid memory leak
        var isApple = !!(Howler._navigator &&
                         Howler._navigator.vendor &&
                         Howler._navigator.vendor.indexOf('Apple') >= 0);
        if (isApple) {
          try { node.bufferSource.buffer = Howler._scratchBuffer; } catch (e) {}
        }
      }
      node.bufferSource = null;
      return this;
    },

    _clearSound: function (node) {
      // Reset src to a tiny silent WAV to release the media resource.
      // Assigning a data: URI to HTMLAudioElement.src is safe under any CSP
      // policy — the script-src directive does not apply to media element sources.
      node.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    }
  };

  // ---------------------------------------------------------------------------
  // Sound (individual sound instance)
  // ---------------------------------------------------------------------------
  var Sound = function (howl) {
    this._parent = howl;
    this.init();
  };

  Sound.prototype = {
    init: function () {
      var self   = this;
      var parent = self._parent;

      self._muted  = parent._muted;
      self._loop   = parent._loop;
      self._volume = parent._volume;
      self._rate   = parent._rate;
      self._seek   = 0;
      self._paused = true;
      self._ended  = true;
      self._sprite = '__default';
      self._id     = ++Howler._counter;

      parent._sounds.push(self);
      parent._soundMap.set(self._id, self); // register in O(1) map

      self.create();
      return self;
    },

    create: function () {
      var self   = this;
      var parent = self._parent;
      var vol    = (Howler._muted || self._muted || parent._muted) ? 0 : self._volume;

      if (parent._webAudio) {
        self._node = Howler.ctx.createGain();
        self._node.gain.setValueAtTime(vol, Howler.ctx.currentTime);
        self._node.paused = true;
        self._node.connect(Howler.masterGain);
      } else if (!Howler.noAudio) {
        self._node = Howler._obtainHtml5Audio();

        self._errorFn = self._errorListener.bind(self);
        self._node.addEventListener('error', self._errorFn, false);

        self._loadFn = self._loadListener.bind(self);
        self._node.addEventListener(Howler._canPlayEvent, self._loadFn, false);

        self._endFn = self._endListener.bind(self);
        self._node.addEventListener('ended', self._endFn, false);

        self._node.src     = parent._src;
        self._node.preload = parent._preload === true ? 'auto' : parent._preload;
        self._node.volume  = vol * Howler.volume();

        // Set crossOrigin on stream nodes so the browser sends the Origin header
        // and enforces CORS. Without this, credentials are never sent even with
        // withCredentials:true, and CDN CORS headers are not validated.
        //
        // Note: if the stream URL redirects to a different origin and the redirect
        // target lacks Access-Control-Allow-Origin, playback will fail. Diagnose
        // with: curl -I -H "Origin: https://your-station.com" <stream-url>
        if (parent._stream) {
          self._node.crossOrigin = parent._xhr.withCredentials
            ? 'use-credentials'
            : 'anonymous';
        }

        self._node.load();

        // Stream mode: attach stall/waiting/playing listeners and set
        // preservesPitch=false to eliminate pitch-correction DSP overhead.
        if (parent._stream) {
          parent._attachStreamNodeListeners(self._node);
          // v2.4.0: install AudioWorklet tap if workletUrl is configured
          _initWorkletTap(parent, self._node);
        }
      }

      return self;
    },

    reset: function () {
      var self   = this;
      var parent = self._parent;

      self._muted    = parent._muted;
      self._loop     = parent._loop;
      self._volume   = parent._volume;
      self._rate     = parent._rate;
      self._seek     = 0;
      self._rateSeek = 0;
      self._paused   = true;
      self._ended    = true;
      self._sprite   = '__default';

      var oldId = self._id;
      self._id  = ++Howler._counter;

      // Update the Map entry
      parent._soundMap.delete(oldId);
      parent._soundMap.set(self._id, self);

      return self;
    },

    _errorListener: function () {
      var self = this;
      self._parent._emit('loaderror', self._id,
        self._node.error ? self._node.error.code : 0);
      self._node.removeEventListener('error', self._errorFn, false);
    },

    _loadListener: function () {
      var self   = this;
      var parent = self._parent;

      parent._duration = Math.ceil(self._node.duration * 10) / 10;
      if (Object.keys(parent._sprite).length === 0) {
        parent._sprite = { __default: [0, parent._duration * 1000] };
      }

      if (parent._state !== 'loaded') {
        parent._state = 'loaded';
        parent._emit('load');
        parent._loadQueue();
      }

      self._node.removeEventListener(Howler._canPlayEvent, self._loadFn, false);
    },

    _endListener: function () {
      var self   = this;
      var parent = self._parent;

      if (parent._duration === Infinity) {
        parent._duration = Math.ceil(self._node.duration * 10) / 10;
        if (parent._sprite.__default[1] === Infinity) {
          parent._sprite.__default[1] = parent._duration * 1000;
        }
        parent._ended(self);
      }
      self._node.removeEventListener('ended', self._endFn, false);
    }
  };

  // ---------------------------------------------------------------------------
  // WebAudio fetch helper (replaces XHR)
  // ---------------------------------------------------------------------------
  function _fetchAudio(howl) {
    var src = howl._src;

    // Already cached?
    var cached = cacheGet(src);
    if (cached) {
      howl._duration = cached.duration;
      _initFromBuffer(howl);
      return;
    }

    // Base64 data URI — decode inline without a network request
    if (/^data:[^;]+;base64,/.test(src)) {
      var b64    = src.split(',')[1];
      var binary = atob(b64);
      var bytes  = Uint8Array.from(binary, function (c) { return c.charCodeAt(0); });
      _decodeAudio(bytes.buffer, howl);
      return;
    }

    // Build fetch options
    var fetchOptions = {
      method:      howl._xhr.method,
      credentials: howl._xhr.withCredentials ? 'include' : 'same-origin'
    };

    if (howl._xhr.headers) {
      try {
        fetchOptions.headers = new Headers(howl._xhr.headers);
      } catch (e) {
        console.warn('Howler: Invalid XHR headers - ignoring.', e);
      }
    }

    // AbortController for cancellation on unload()
    var controller  = new AbortController();
    fetchOptions.signal = controller.signal;
    howl._fetchControllers[src] = controller;

    fetch(src, fetchOptions)
      .then(function (response) {
        if (response.status < 200 || response.status >= 400) {
          throw new Error('HTTP ' + response.status);
        }
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        delete howl._fetchControllers[src];
        _decodeAudio(buffer, howl);
      })
      .catch(function (err) {
        delete howl._fetchControllers[src];
        if (err.name === 'AbortError') return; // unload() called — ignore
        // Fall back to HTML5 audio
        howl._webAudio  = false;
        howl._html5     = true;
        howl._sounds    = [];
        cacheDelete(src);
        howl.load();
      });
  }

  function _decodeAudio(arrayBuffer, howl) {
    var onError = function () {
      howl._emit('loaderror', null, 'Decoding audio data failed.');
    };

    var onSuccess = function (buffer) {
      if (buffer && howl._sounds.length > 0) {
        cacheSet(howl._src, buffer);
        _initFromBuffer(howl, buffer);
      } else {
        onError();
      }
    };

    // All browsers in scope implement the Promise-based single-argument form.
    Howler.ctx.decodeAudioData(arrayBuffer).then(onSuccess).catch(onError);
  }

  function _initFromBuffer(howl, buffer) {
    if (buffer && !howl._duration) {
      howl._duration = buffer.duration;
    }
    if (Object.keys(howl._sprite).length === 0) {
      howl._sprite = { __default: [0, howl._duration * 1000] };
    }
    if (howl._state !== 'loaded') {
      howl._state = 'loaded';
      howl._emit('load');
      howl._loadQueue();
    }
  }

  // ---------------------------------------------------------------------------
  // AudioContext initialisation
  // Uses latencyHint:'playback' for larger internal buffers, reducing glitches
  // under CPU load on mobile. For streaming audio, 'playback' is always more
  // appropriate than the default 'interactive' hint.
  // ---------------------------------------------------------------------------
  function _initCtx() {
    if (!Howler.usingWebAudio) return;

    try {
      if (typeof AudioContext !== 'undefined') {
        Howler.ctx = new AudioContext({ latencyHint: 'playback' });
      } else {
        Howler.usingWebAudio = false;
      }
    } catch (e) {
      Howler.usingWebAudio = false;
    }

    if (!Howler.ctx) {
      Howler.usingWebAudio = false;
      return;
    }

    Howler.masterGain = Howler.ctx.createGain();
    Howler.masterGain.gain.setValueAtTime(
      Howler._muted ? 0 : Howler._volume,
      Howler.ctx.currentTime
    );
    Howler.masterGain.connect(Howler.ctx.destination);

    Howler._setup();
  }

  // ---------------------------------------------------------------------------
  // MediaSession action binding (stream mode)
  // Wires OS-level media controls (lock screen, car display, AirPods, Android
  // notification shade) to Howl play/pause/stop methods.
  //
  // seekto: snaps to live edge via silent reconnect rather than scrubbing the
  //   raw <audio> element, which would silently corrupt the stream position.
  // previoustrack/nexttrack: delegate to optional stream config callbacks for
  //   multi-station navigation.
  // setPositionState: called from the 'play' handler (not here) to ensure
  //   playbackState is already 'playing' when it's invoked.
  // ---------------------------------------------------------------------------
  function _bindMediaSessionActions(howl) {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;

    var cfg = howl._stream;

    var setHandler = function (action, fn) {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) {}
    };

    setHandler('play',  function () { howl.play(); });
    setHandler('pause', function () { howl.pause(); });
    setHandler('stop',  function () { howl.stop(); });

    // For live streams, snap to the live edge instead of letting the browser
    // scrub to an arbitrary currentTime (browsers that render a seekbar despite
    // duration:Infinity would silently corrupt the stream position).
    setHandler('seekto', function (details) {
      if (details && details.fastSeek) return; // ignore scrub intermediates
      if (howl.playing()) {
        howl._streamSilentReconnect(false);
      }
    });

    // Optional station navigation — exposed via stream config callbacks.
    setHandler('previoustrack', cfg.onPreviousTrack || null);
    setHandler('nexttrack',     cfg.onNextTrack     || null);

    // setPositionState is called from the 'play' handler, not here, to ensure
    // playbackState is already 'playing' when it runs.
  }

  // ---------------------------------------------------------------------------
  // _rampNodeVolume — smooth step-wise volume ramp on an HTMLAudioElement.
  // Used by _streamSilentReconnect to avoid audible clicks on reconnect.
  // (HTMLAudioElement.volume is not an AudioParam and cannot be Web Audio
  // scheduled, so a setInterval step-ramp is used instead.)
  //
  // Concurrent calls cancel the previous ramp via cfg._rampInterval before
  // starting a new one. NaN/Infinity inputs skip the ramp and write `to` directly
  // (node.volume = NaN is silently accepted by browsers but permanently mutes).
  // ---------------------------------------------------------------------------
  function _rampNodeVolume(cfg, node, from, to, durationMs, cb) {
    // Cancel any in-flight ramp before starting a new one.
    if (cfg._rampInterval) {
      clearInterval(cfg._rampInterval);
      cfg._rampInterval = null;
    }

    // NaN / Infinity guard: skip the ramp and write `to` directly.
    if (!isFinite(from) || !isFinite(to)) {
      node.volume = isFinite(to) ? Math.max(0, Math.min(1, to)) : 0;
      if (cb) cb();
      return;
    }

    var steps   = 8;
    var step    = (to - from) / steps;
    var delay   = durationMs / steps;
    var count   = 0;

    cfg._rampInterval = setInterval(function () {
      count++;
      node.volume = Math.max(0, Math.min(1, from + step * count));
      if (count >= steps) {
        clearInterval(cfg._rampInterval);
        cfg._rampInterval = null;
        node.volume = to; // ensure exact final value
        if (cb) cb();
      }
    }, delay);
  }

  // ---------------------------------------------------------------------------
  // _initWorkletTap — installs an AudioWorklet processing pipeline on a stream
  // <audio> node when stream config includes a workletUrl.
  //
  // Signal path:
  //   <audio> → MediaElementAudioSourceNode → AudioWorkletNode → masterGain
  //
  // The worklet runs off the main thread (no UI blocking). Messages are
  // forwarded to the main thread via AudioWorkletNode.port and delivered to
  // stream.onWorkletMessage(event).
  //
  // Note: once a MediaElementAudioSourceNode is created, node.volume is ignored;
  // all volume control must go through the Web Audio gain graph. Howler's
  // existing volume/mute methods target masterGain, which is already in path.
  //
  // Only https: and blob: workletUrls are accepted to prevent arbitrary module
  // loading if workletUrl comes from an untrusted source (e.g. ICY metadata).
  //
  // No-op when workletUrl is absent or AudioWorklet is unavailable.
  // ---------------------------------------------------------------------------
  function _initWorkletTap(howl, audioNode) {
    var cfg = howl._stream;
    if (!cfg || !cfg.workletUrl) return;
    if (!Howler.ctx || !Howler.ctx.audioWorklet) return;

    // Only allow https: and blob: (runtime-generated modules from same origin).
    // Reject everything else to prevent loading arbitrary scripts if workletUrl
    // comes from an untrusted source (e.g. ICY metadata).
    var url = String(cfg.workletUrl);
    if (!/^https:\/\//i.test(url) && !/^blob:/i.test(url)) {
      console.warn(
        'Howler [stream]: workletUrl rejected — only https: and blob: schemes ' +
        'are allowed. Received: ' + url
      );
      return;
    }

    Howler.ctx.audioWorklet.addModule(cfg.workletUrl).then(function () {
      // Verify the howl hasn't been unloaded while the module was loading
      if (!howl._stream) return;

      var source  = Howler.ctx.createMediaElementSource(audioNode);
      var worklet = new AudioWorkletNode(Howler.ctx, 'howler-stream-processor');

      if (cfg.onWorkletMessage) {
        worklet.port.onmessage = cfg.onWorkletMessage;
      }

      source.connect(worklet);
      worklet.connect(Howler.masterGain);

      // Store refs so unload() can disconnect them
      cfg._workletSource = source;
      cfg._workletNode   = worklet;
    }).catch(function (err) {
      console.warn('Howler [stream]: AudioWorklet module failed to load — ' +
                   'falling back to direct HTML5 Audio. Error:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Module export (AMD / CommonJS / global)
  // ---------------------------------------------------------------------------
  if (typeof define === 'function' && define.amd) {
    define([], function () { return { Howler: Howler, Howl: Howl }; });
  }
  if (typeof exports !== 'undefined') {
    exports.Howler = Howler;
    exports.Howl   = Howl;
  }
  if (typeof global !== 'undefined') {
    global.HowlerGlobal = HowlerGlobal;
    global.Howler       = Howler;
    global.Howl         = Howl;
    global.Sound        = Sound;
  } else if (typeof window !== 'undefined') {
    window.HowlerGlobal = HowlerGlobal;
    window.Howler       = Howler;
    window.Howl         = Howl;
    window.Sound        = Sound;
  }

  // Opt-in auto-reroute when the active audio output device is removed.
  // When Howler.autoReroute is true and the device disappears, audio is
  // rerouted to the system default so playback continues uninterrupted.
  // Requires AudioContext.setSinkId() (Chrome/Edge 110+).
  // Default false to avoid unexpected routing changes in existing deployments.
  if (typeof navigator !== 'undefined' &&
      navigator.mediaDevices &&
      typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', function () {
      if (!Howler.autoReroute) return;
      if (!Howler.ctx || typeof Howler.ctx.setSinkId !== 'function') return;

      // Enumerate devices to check if the current sink is still available.
      navigator.mediaDevices.enumerateDevices().then(function (devices) {
        var currentSinkId = Howler._sinkId || '';
        if (currentSinkId === '') return; // already on default — nothing to do

        var stillAvailable = devices.some(function (d) {
          return d.kind === 'audiooutput' && d.deviceId === currentSinkId;
        });

        if (!stillAvailable) {
          // Current output device removed — fall back to system default.
          Howler.setSinkId('').then(function () {
            console.info('Howler [autoReroute]: active output device removed; ' +
                         'rerouted to system default.');
          }).catch(function (e) {
            console.warn('Howler [autoReroute]: setSinkId(\'\') failed:', e);
          });
        }
      }).catch(function () {});
    });
  }

})();


// =============================================================================
// Spatial Audio Plugin (modernized)
// =============================================================================
(function () {
  'use strict';

  // Global listener position / orientation
  HowlerGlobal.prototype._pos         = [0, 0, 0];
  HowlerGlobal.prototype._orientation = [0, 0, -1, 0, 1, 0];

  HowlerGlobal.prototype.stereo = function (pan) {
    var self = this;
    if (!self.ctx || !self.ctx.listener) return self;
    for (var i = self._howls.length - 1; i >= 0; i--) {
      self._howls[i].stereo(pan);
    }
    return self;
  };

  HowlerGlobal.prototype.pos = function (x, y, z) {
    var self = this;
    if (!self.ctx || !self.ctx.listener) return self;

    y = typeof y !== 'number' ? self._pos[1] : y;
    z = typeof z !== 'number' ? self._pos[2] : z;

    if (typeof x !== 'number') return self._pos;

    self._pos = [x, y, z];

    if (typeof self.ctx.listener.positionX !== 'undefined') {
      self.ctx.listener.positionX.setTargetAtTime(x, Howler.ctx.currentTime, 0.1);
      self.ctx.listener.positionY.setTargetAtTime(y, Howler.ctx.currentTime, 0.1);
      self.ctx.listener.positionZ.setTargetAtTime(z, Howler.ctx.currentTime, 0.1);
    } else {
      self.ctx.listener.setPosition(x, y, z);
    }

    return self;
  };

  HowlerGlobal.prototype.orientation = function (x, y, z, xUp, yUp, zUp) {
    var self = this;
    if (!self.ctx || !self.ctx.listener) return self;

    var o = self._orientation;
    y   = typeof y   !== 'number' ? o[1] : y;
    z   = typeof z   !== 'number' ? o[2] : z;
    xUp = typeof xUp !== 'number' ? o[3] : xUp;
    yUp = typeof yUp !== 'number' ? o[4] : yUp;
    zUp = typeof zUp !== 'number' ? o[5] : zUp;

    if (typeof x !== 'number') return o;

    self._orientation = [x, y, z, xUp, yUp, zUp];

    if (typeof self.ctx.listener.forwardX !== 'undefined') {
      self.ctx.listener.forwardX.setTargetAtTime(x,   Howler.ctx.currentTime, 0.1);
      self.ctx.listener.forwardY.setTargetAtTime(y,   Howler.ctx.currentTime, 0.1);
      self.ctx.listener.forwardZ.setTargetAtTime(z,   Howler.ctx.currentTime, 0.1);
      self.ctx.listener.upX.setTargetAtTime(xUp,      Howler.ctx.currentTime, 0.1);
      self.ctx.listener.upY.setTargetAtTime(yUp,      Howler.ctx.currentTime, 0.1);
      self.ctx.listener.upZ.setTargetAtTime(zUp,      Howler.ctx.currentTime, 0.1);
    } else {
      self.ctx.listener.setOrientation(x, y, z, xUp, yUp, zUp);
    }

    return self;
  };

  // Wrap Howl.prototype.init to inject spatial properties
  Howl.prototype.init = (function (_super) {
    return function (options) {
      var self = this;

      self._orientation = options.orientation || [1, 0, 0];
      self._stereo      = options.stereo      || null;
      self._pos         = options.pos         || null;
      self._pannerAttr  = {
        coneInnerAngle: options.coneInnerAngle !== undefined ? options.coneInnerAngle : 360,
        coneOuterAngle: options.coneOuterAngle !== undefined ? options.coneOuterAngle : 360,
        coneOuterGain:  options.coneOuterGain  !== undefined ? options.coneOuterGain  : 0,
        distanceModel:  options.distanceModel  !== undefined ? options.distanceModel  : 'inverse',
        maxDistance:    options.maxDistance    !== undefined ? options.maxDistance    : 10000,
        panningModel:   options.panningModel   !== undefined ? options.panningModel   : 'HRTF',
        refDistance:    options.refDistance    !== undefined ? options.refDistance    : 1,
        rolloffFactor:  options.rolloffFactor  !== undefined ? options.rolloffFactor  : 1
      };

      self._onstereo      = options.onstereo      ? [{ fn: options.onstereo }]      : [];
      self._onpos         = options.onpos         ? [{ fn: options.onpos }]         : [];
      self._onorientation = options.onorientation ? [{ fn: options.onorientation }] : [];

      return _super.call(self, options);
    };
  })(Howl.prototype.init);

  Howl.prototype.stereo = function (pan, id) {
    var self   = this;
    if (!self._webAudio) return self;

    if (self._state !== 'loaded') {
      self._queue.push({ event: 'stereo', action: function () { self.stereo(pan, id); } });
      return self;
    }

    var pannerType = typeof Howler.ctx.createStereoPanner === 'undefined' ? 'spatial' : 'stereo';

    if (typeof id === 'undefined') {
      if (typeof pan !== 'number') return self._stereo;
      self._stereo = pan;
      self._pos    = [pan, 0, 0];
    }

    var ids = self._getSoundIds(id);
    for (var i = 0; i < ids.length; i++) {
      var sound = self._soundById(ids[i]);
      if (!sound) continue;

      if (typeof pan !== 'number') return sound._stereo;

      sound._stereo = pan;
      sound._pos    = [pan, 0, 0];

      if (sound._node) {
        sound._pannerAttr.panningModel = 'equalpower';
        if (!sound._panner || sound._panner.pan) {
          _createPanner(sound, pannerType);
        }
        if (pannerType === 'spatial') {
          if (typeof sound._panner.positionX !== 'undefined') {
            sound._panner.positionX.setValueAtTime(pan, Howler.ctx.currentTime);
            sound._panner.positionY.setValueAtTime(0,   Howler.ctx.currentTime);
            sound._panner.positionZ.setValueAtTime(0,   Howler.ctx.currentTime);
          } else {
            sound._panner.setPosition(pan, 0, 0);
          }
        } else {
          sound._panner.pan.setValueAtTime(pan, Howler.ctx.currentTime);
        }
      }

      self._emit('stereo', sound._id);
    }

    return self;
  };

  Howl.prototype.pos = function (x, y, z, id) {
    var self = this;
    if (!self._webAudio) return self;

    if (self._state !== 'loaded') {
      self._queue.push({ event: 'pos', action: function () { self.pos(x, y, z, id); } });
      return self;
    }

    y = typeof y !== 'number' ? 0    : y;
    z = typeof z !== 'number' ? -0.5 : z;

    if (typeof id === 'undefined') {
      if (typeof x !== 'number') return self._pos;
      self._pos = [x, y, z];
    }

    var ids = self._getSoundIds(id);
    for (var i = 0; i < ids.length; i++) {
      var sound = self._soundById(ids[i]);
      if (!sound) continue;

      if (typeof x !== 'number') return sound._pos;

      sound._pos = [x, y, z];
      if (sound._node) {
        if (!sound._panner || sound._panner.pan) {
          _createPanner(sound, 'spatial');
        }
        if (typeof sound._panner.positionX !== 'undefined') {
          sound._panner.positionX.setValueAtTime(x, Howler.ctx.currentTime);
          sound._panner.positionY.setValueAtTime(y, Howler.ctx.currentTime);
          sound._panner.positionZ.setValueAtTime(z, Howler.ctx.currentTime);
        } else {
          sound._panner.setPosition(x, y, z);
        }
      }
      self._emit('pos', sound._id);
    }

    return self;
  };

  Howl.prototype.orientation = function (x, y, z, id) {
    var self = this;
    if (!self._webAudio) return self;

    if (self._state !== 'loaded') {
      self._queue.push({ event: 'orientation', action: function () { self.orientation(x, y, z, id); } });
      return self;
    }

    y = typeof y !== 'number' ? self._orientation[1] : y;
    z = typeof z !== 'number' ? self._orientation[2] : z;

    if (typeof id === 'undefined') {
      if (typeof x !== 'number') return self._orientation;
      self._orientation = [x, y, z];
    }

    var ids = self._getSoundIds(id);
    for (var i = 0; i < ids.length; i++) {
      var sound = self._soundById(ids[i]);
      if (!sound) continue;

      if (typeof x !== 'number') return sound._orientation;

      sound._orientation = [x, y, z];
      if (sound._node) {
        if (!sound._panner) {
          if (!sound._pos) sound._pos = self._pos || [0, 0, -0.5];
          _createPanner(sound, 'spatial');
        }
        if (typeof sound._panner.orientationX !== 'undefined') {
          sound._panner.orientationX.setValueAtTime(x, Howler.ctx.currentTime);
          sound._panner.orientationY.setValueAtTime(y, Howler.ctx.currentTime);
          sound._panner.orientationZ.setValueAtTime(z, Howler.ctx.currentTime);
        } else {
          sound._panner.setOrientation(x, y, z);
        }
      }
      self._emit('orientation', sound._id);
    }

    return self;
  };

  Howl.prototype.pannerAttr = function () {
    var self = this;
    var args = arguments;
    var attr, id, sound;

    if (!self._webAudio) return self;
    if (args.length === 0) return self._pannerAttr;

    if (args.length === 1) {
      if (typeof args[0] === 'object') {
        attr = args[0];
        // Flatten legacy top-level attr keys into pannerAttr sub-object
        if (!attr.pannerAttr) {
          attr.pannerAttr = {
            coneInnerAngle: attr.coneInnerAngle,
            coneOuterAngle: attr.coneOuterAngle,
            coneOuterGain:  attr.coneOuterGain,
            distanceModel:  attr.distanceModel,
            maxDistance:    attr.maxDistance,
            refDistance:    attr.refDistance,
            rolloffFactor:  attr.rolloffFactor,
            panningModel:   attr.panningModel
          };
        }
        var pa = attr.pannerAttr;
        self._pannerAttr = {
          coneInnerAngle: pa.coneInnerAngle !== undefined ? pa.coneInnerAngle : self._pannerAttr.coneInnerAngle,
          coneOuterAngle: pa.coneOuterAngle !== undefined ? pa.coneOuterAngle : self._pannerAttr.coneOuterAngle,
          coneOuterGain:  pa.coneOuterGain  !== undefined ? pa.coneOuterGain  : self._pannerAttr.coneOuterGain,
          distanceModel:  pa.distanceModel  !== undefined ? pa.distanceModel  : self._pannerAttr.distanceModel,
          maxDistance:    pa.maxDistance    !== undefined ? pa.maxDistance    : self._pannerAttr.maxDistance,
          refDistance:    pa.refDistance    !== undefined ? pa.refDistance    : self._pannerAttr.refDistance,
          rolloffFactor:  pa.rolloffFactor  !== undefined ? pa.rolloffFactor  : self._pannerAttr.rolloffFactor,
          panningModel:   pa.panningModel   !== undefined ? pa.panningModel   : self._pannerAttr.panningModel
        };
      } else {
        sound = self._soundById(parseInt(args[0], 10));
        return sound ? sound._pannerAttr : self._pannerAttr;
      }
    } else if (args.length === 2) {
      attr = args[0];
      id   = parseInt(args[1], 10);
    }

    var ids = self._getSoundIds(id);
    for (var i = 0; i < ids.length; i++) {
      sound = self._soundById(ids[i]);
      if (!sound) continue;

      var s = sound._pannerAttr;
      s = {
        coneInnerAngle: attr.coneInnerAngle !== undefined ? attr.coneInnerAngle : s.coneInnerAngle,
        coneOuterAngle: attr.coneOuterAngle !== undefined ? attr.coneOuterAngle : s.coneOuterAngle,
        coneOuterGain:  attr.coneOuterGain  !== undefined ? attr.coneOuterGain  : s.coneOuterGain,
        distanceModel:  attr.distanceModel  !== undefined ? attr.distanceModel  : s.distanceModel,
        maxDistance:    attr.maxDistance    !== undefined ? attr.maxDistance    : s.maxDistance,
        refDistance:    attr.refDistance    !== undefined ? attr.refDistance    : s.refDistance,
        rolloffFactor:  attr.rolloffFactor  !== undefined ? attr.rolloffFactor  : s.rolloffFactor,
        panningModel:   attr.panningModel   !== undefined ? attr.panningModel   : s.panningModel
      };

      var panner = sound._panner;
      if (!panner) {
        if (!sound._pos) sound._pos = self._pos || [0, 0, -0.5];
        _createPanner(sound, 'spatial');
        panner = sound._panner;
      }

      panner.coneInnerAngle = s.coneInnerAngle;
      panner.coneOuterAngle = s.coneOuterAngle;
      panner.coneOuterGain  = s.coneOuterGain;
      panner.distanceModel  = s.distanceModel;
      panner.maxDistance    = s.maxDistance;
      panner.refDistance    = s.refDistance;
      panner.rolloffFactor  = s.rolloffFactor;
      panner.panningModel   = s.panningModel;
    }

    return self;
  };

  // Extend Sound.prototype.init to copy spatial props from parent
  Sound.prototype.init = (function (_super) {
    return function () {
      var self   = this;
      var parent = self._parent;

      self._orientation = parent._orientation;
      self._stereo      = parent._stereo;
      self._pos         = parent._pos;
      self._pannerAttr  = parent._pannerAttr;

      _super.call(self);

      if (self._stereo) {
        parent.stereo(self._stereo);
      } else if (self._pos) {
        parent.pos(self._pos[0], self._pos[1], self._pos[2], self._id);
      }
    };
  })(Sound.prototype.init);

  Sound.prototype.reset = (function (_super) {
    return function () {
      var self   = this;
      var parent = self._parent;

      self._orientation = parent._orientation;
      self._stereo      = parent._stereo;
      self._pos         = parent._pos;
      self._pannerAttr  = parent._pannerAttr;

      if (self._stereo) {
        parent.stereo(self._stereo);
      } else if (self._pos) {
        parent.pos(self._pos[0], self._pos[1], self._pos[2], self._id);
      } else if (self._panner) {
        self._panner.disconnect(0);
        self._panner = undefined;
        parent._refreshBuffer(self);
      }

      return _super.call(self);
    };
  })(Sound.prototype.reset);

  function _createPanner(sound, type) {
    type = type || 'spatial';

    if (type === 'spatial') {
      sound._panner = Howler.ctx.createPanner();
      sound._panner.coneInnerAngle = sound._pannerAttr.coneInnerAngle;
      sound._panner.coneOuterAngle = sound._pannerAttr.coneOuterAngle;
      sound._panner.coneOuterGain  = sound._pannerAttr.coneOuterGain;
      sound._panner.distanceModel  = sound._pannerAttr.distanceModel;
      sound._panner.maxDistance    = sound._pannerAttr.maxDistance;
      sound._panner.refDistance    = sound._pannerAttr.refDistance;
      sound._panner.rolloffFactor  = sound._pannerAttr.rolloffFactor;
      sound._panner.panningModel   = sound._pannerAttr.panningModel;

      if (typeof sound._panner.positionX !== 'undefined') {
        sound._panner.positionX.setValueAtTime(sound._pos[0], Howler.ctx.currentTime);
        sound._panner.positionY.setValueAtTime(sound._pos[1], Howler.ctx.currentTime);
        sound._panner.positionZ.setValueAtTime(sound._pos[2], Howler.ctx.currentTime);
      } else {
        sound._panner.setPosition(sound._pos[0], sound._pos[1], sound._pos[2]);
      }

      if (typeof sound._panner.orientationX !== 'undefined') {
        sound._panner.orientationX.setValueAtTime(sound._orientation[0], Howler.ctx.currentTime);
        sound._panner.orientationY.setValueAtTime(sound._orientation[1], Howler.ctx.currentTime);
        sound._panner.orientationZ.setValueAtTime(sound._orientation[2], Howler.ctx.currentTime);
      } else {
        sound._panner.setOrientation(sound._orientation[0], sound._orientation[1], sound._orientation[2]);
      }
    } else {
      sound._panner = Howler.ctx.createStereoPanner();
      sound._panner.pan.setValueAtTime(sound._stereo, Howler.ctx.currentTime);
    }

    sound._panner.connect(sound._node);

    if (!sound._paused) {
      sound._parent.pause(sound._id, true).play(sound._id, true);
    }
  }

})();
