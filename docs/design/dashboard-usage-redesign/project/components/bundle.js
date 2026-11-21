/* @ds-bundle: {"format":4,"namespace":"OrgAI","components":[]} */
/* Preview helpers only: replaying arrival motion and counting figures up. No components are exported. */
(function () {
  function reduced() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }
  function format(el, v) {
    var dec = +(el.getAttribute('data-dec') || 0);
    var s = v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
    return (el.getAttribute('data-pre') || '') + s + (el.getAttribute('data-suf') || '');
  }
  function countUp(el) {
    var to = parseFloat(el.getAttribute('data-to'));
    if (isNaN(to)) return;
    if (reduced()) { el.textContent = format(el, to); return; }
    var ms = 480, t0 = null;
    function step(t) {
      if (t0 === null) t0 = t;
      var p = Math.min(1, (t - t0) / ms);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = format(el, to * e);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function play(root) {
    root = root || document.body;
    root.classList.remove('oa-play');
    void root.offsetWidth;
    root.classList.add('oa-play');
    Array.prototype.forEach.call(root.querySelectorAll('[data-to]'), countUp);
  }
  /* A sliding indicator under the pressed item of a group: [data-slide] holds buttons and one .oa-indicator. */
  function slide(group) {
    var bar = group.querySelector('.oa-indicator');
    if (!bar) return;
    function place() {
      var on = group.querySelector('[aria-pressed="true"],[aria-selected="true"]');
      if (!on) return;
      var g = group.getBoundingClientRect(), r = on.getBoundingClientRect();
      bar.style.transform = 'translateX(' + (r.left - g.left) + 'px) scaleX(' + r.width / 100 + ')';
      bar.setAttribute('data-ready', '');
    }
    Array.prototype.forEach.call(group.querySelectorAll('button[aria-pressed],button[aria-selected]'), function (b) {
      b.addEventListener('click', function () {
        var attr = b.hasAttribute('aria-pressed') ? 'aria-pressed' : 'aria-selected';
        Array.prototype.forEach.call(group.querySelectorAll('button[' + attr + ']'), function (o) { o.setAttribute(attr, 'false'); });
        b.setAttribute(attr, 'true');
        place();
      });
    });
    place();
    window.addEventListener('resize', place);
  }
  function init() {
    Array.prototype.forEach.call(document.querySelectorAll('[data-slide]'), slide);
    Array.prototype.forEach.call(document.querySelectorAll('[data-replay]'), function (b) {
      b.addEventListener('click', function () { play(document.body); });
    });
    if (window.lucide && window.lucide.createIcons) window.lucide.createIcons();
    play(document.body);
  }
  window.OrgAI = { init: init, play: play, countUp: countUp, slide: slide };
})();
