(() => {
  "use strict";

  const root = document.documentElement;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const touchInput = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  const smallScreen = window.matchMedia("(max-width: 900px)").matches;
  const lowMemory = Number(navigator.deviceMemory || 8) <= 4;
  const lowCpu = Number(navigator.hardwareConcurrency || 8) <= 4;
  const liteMode = reducedMotion || touchInput || smallScreen || lowMemory || lowCpu;
  const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

  root.classList.add(liteMode ? "performance-lite" : "performance-full");
  if (touchInput) root.classList.add("touch-device");

  // Keep the three-dimensional composition, but only calculate pointer tilt on
  // capable desktop devices and only while the pointer is actually over a card.
  if (!liteMode) {
    document.querySelectorAll("[data-tilt]").forEach((element) => {
      const strength = Number(element.dataset.tiltStrength || 4);
      let frame = 0;

      const update = (event) => {
        if (!element.classList.contains("tilt-active")) return;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = clamp((event.clientX - rect.left) / rect.width, 0, 1);
        const py = clamp((event.clientY - rect.top) / rect.height, 0, 1);
        const ry = (px - 0.5) * strength * 2;
        const rx = (0.5 - py) * strength * 2;
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          element.style.setProperty("--rx", `${rx.toFixed(2)}deg`);
          element.style.setProperty("--ry", `${ry.toFixed(2)}deg`);
        });
      };

      const activate = () => element.classList.add("tilt-active");
      const reset = () => {
        cancelAnimationFrame(frame);
        element.classList.remove("tilt-active");
        element.style.setProperty("--rx", "0deg");
        element.style.setProperty("--ry", "0deg");
      };

      element.addEventListener("pointerenter", activate, { passive: true });
      element.addEventListener("pointermove", update, { passive: true });
      element.addEventListener("pointerleave", reset, { passive: true });
      element.addEventListener("pointercancel", reset, { passive: true });
    });
  }

  const revealItems = document.querySelectorAll(".reveal-up");
  if ("IntersectionObserver" in window && !reducedMotion) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.08, rootMargin: "80px 0px" },
    );
    revealItems.forEach((item, index) => {
      item.style.transitionDelay = liteMode ? "0ms" : `${Math.min(index * 45, 180)}ms`;
      observer.observe(item);
    });
  } else {
    revealItems.forEach((item) => item.classList.add("is-visible"));
  }

  // Continuous animations run only while their scene is visible. This keeps
  // the 3D USB, shield cube and rings, but prevents off-screen GPU work.
  const animatedScenes = document.querySelectorAll(
    ".auth-visual, .guardian-core, .solution-emblem, .readiness-orbit, .download-cube",
  );
  if ("IntersectionObserver" in window && !reducedMotion) {
    const sceneObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          entry.target.classList.toggle("scene-active", entry.isIntersecting);
        });
      },
      { threshold: 0.01, rootMargin: "120px 0px" },
    );
    animatedScenes.forEach((scene) => sceneObserver.observe(scene));
  } else {
    animatedScenes.forEach((scene) => scene.classList.add("scene-active"));
  }

  document.addEventListener("visibilitychange", () => {
    root.classList.toggle("animations-paused", document.hidden);
  });

  document.querySelectorAll(".nav-item, [data-go]").forEach((control) => {
    control.addEventListener("click", () => {
      window.setTimeout(() => {
        document.querySelectorAll(".page.active [data-tilt]").forEach((item) => {
          item.classList.remove("tilt-active");
          item.style.setProperty("--rx", "0deg");
          item.style.setProperty("--ry", "0deg");
        });
      }, 20);
    });
  });
})();
