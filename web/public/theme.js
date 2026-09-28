// Theme follows the sun: light between sunrise and sunset, dark otherwise.
// Load this synchronously in <head> so it runs before first paint — no flash of the wrong theme.
(function () {
  var LAT = 51.5; // UK default; longitude is estimated from the visitor's timezone

  function sunTimes(date) {
    var rad = Math.PI / 180;
    var lng = -date.getTimezoneOffset() / 4; // minutes of offset → degrees
    var day = Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 86400000);
    var g = 2 * Math.PI / 365 * (day - 1);
    var eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g)
      - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
    var decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g)
      - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g)
      - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
    var cosHa = Math.cos(90.833 * rad) / (Math.cos(LAT * rad) * Math.cos(decl))
      - Math.tan(LAT * rad) * Math.tan(decl);
    var ha = Math.acos(Math.min(1, Math.max(-1, cosHa))) / rad;
    var noonUtc = 720 - 4 * lng - eqTime; // minutes after UTC midnight
    var midnight = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return {
      rise: new Date(midnight + (noonUtc - 4 * ha) * 60000),
      set: new Date(midnight + (noonUtc + 4 * ha) * 60000)
    };
  }

  function solarTheme(now) {
    var t = sunTimes(now);
    var isDay = now >= t.rise && now < t.set;
    var next = isDay ? t.set : (now < t.rise ? t.rise : sunTimes(new Date(now.getTime() + 86400000)).rise);
    return { theme: isDay ? 'light' : 'dark', next: next, times: t };
  }

  function readOverride() {
    try { return JSON.parse(localStorage.getItem('themeOverride')); } catch (e) { return null; }
  }

  function set(theme, manual, solar) {
    document.documentElement.setAttribute('data-theme', theme);
    window.__theme = { theme: theme, manual: manual, solar: solar };
    document.dispatchEvent(new CustomEvent('themechange'));
  }

  function apply() {
    var now = new Date();
    var solar = solarTheme(now);
    var override = readOverride();
    // A manual toggle only lasts until the next sunrise or sunset.
    if (override && override.until > now.getTime()) set(override.theme, true, solar);
    else set(solar.theme, false, solar);
  }

  window.__toggleTheme = function () {
    var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    var solar = solarTheme(new Date());
    try {
      if (next === solar.theme) localStorage.removeItem('themeOverride');
      else localStorage.setItem('themeOverride', JSON.stringify({ theme: next, until: solar.next.getTime() }));
    } catch (e) {}
    set(next, next !== solar.theme, solar);
  };


  // ---- Page transitions: zoom the new page's cards in, only on same-site navigations ----
  window.addEventListener('pagereveal', function (e) {
    if (!e.viewTransition) return;
    var root = document.documentElement;
    root.classList.add('vt-enter');
    setTimeout(function () { root.classList.remove('vt-enter'); }, 1400);
  });

  apply();
  setInterval(apply, 60000);
})();
