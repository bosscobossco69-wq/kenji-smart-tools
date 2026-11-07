/* Lightweight, dependency-free motion for KENJI pages. */
(() => {
  const reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduceMotion || !("IntersectionObserver" in window)) return;
  const selectors = [".hero", ".section-head", ".tool-card", ".more-tool-link", ".glass", ".principle", ".layout .card", ".plans > .card", ".packs > .card", ".grid > .card"];
  const nodes = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
  if (!nodes.length) return;
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("kenji-is-visible");
      currentObserver.unobserve(entry.target);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
  document.documentElement.classList.add("kenji-motion-ready");
  nodes.forEach((node, index) => {
    node.classList.add("kenji-reveal");
    node.style.setProperty("--kenji-reveal-delay", Math.min(index % 5, 4) * 65 + "ms");
    observer.observe(node);
  });
})();
