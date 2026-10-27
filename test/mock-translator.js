// テスト用の Translator API モック（実ブラウザの API と同じ形）
(() => {
  const state = { availability: 'available', calls: [], created: 0 };
  globalThis.__mock = state;
  globalThis.Translator = {
    async availability(opts) {
      if (opts.sourceLanguage !== 'ja' || opts.targetLanguage !== 'en') return 'unavailable';
      return state.availability;
    },
    async create(opts) {
      if (state.availability !== 'available' && !navigator.userActivation.isActive) {
        throw new DOMException('Requires user activation', 'NotAllowedError');
      }
      const monitor = new EventTarget();
      opts.monitor?.(monitor);
      if (state.availability !== 'available') {
        for (const loaded of [0, 0.25, 0.5, 1]) {
          await new Promise((r) => setTimeout(r, 50));
          const e = new Event('downloadprogress');
          e.loaded = loaded;
          monitor.dispatchEvent(e);
        }
        state.availability = 'available';
      }
      state.created++;
      return {
        async translate(text) {
          state.calls.push(text);
          await new Promise((r) => setTimeout(r, 5));
          return `EN[${text}]`;
        },
      };
    },
  };
})();
