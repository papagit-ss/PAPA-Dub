(() => {
  const ROOT_ID = "papa-dub-caption-root";
  let root = document.getElementById(ROOT_ID);
  if (root) return;

  root = document.createElement("div");
  root.id = ROOT_ID;
  root.setAttribute("dir", "auto");
  root.dataset.scale = localStorage.getItem("papaDubCaptionScale") || "md";
  root.innerHTML = `
    <div class="papa-caption-shell">
      <div class="papa-caption-toolbar" title="برای جابه‌جایی زیرنویس بکشید">
        <div class="papa-caption-brand"><span></span>PAPA DUB · LIVE</div>
        <div class="papa-caption-actions">
          <button type="button" data-scale="sm" title="فونت کوچک">A-</button>
          <button type="button" data-scale="md" title="فونت متوسط">A</button>
          <button type="button" data-scale="lg" title="فونت بزرگ">A+</button>
        </div>
      </div>
      <div class="papa-caption-original"></div>
      <div class="papa-caption-translation"></div>
    </div>`;
  document.documentElement.appendChild(root);

  const toolbar = root.querySelector(".papa-caption-toolbar");
  const original = root.querySelector(".papa-caption-original");
  const translation = root.querySelector(".papa-caption-translation");
  let hideTimer;

  // Restore saved drag position if within viewport
  try {
    const savedPos = JSON.parse(localStorage.getItem("papaDubCaptionPos") || "null");
    if (savedPos && Number.isFinite(savedPos.left) && Number.isFinite(savedPos.bottom)) {
      root.style.left = `${ Math.min(window.innerWidth - 100, Math.max(100, savedPos.left)) }px`;
      root.style.bottom = `${ Math.min(window.innerHeight - 80, Math.max(16, savedPos.bottom)) }px`;
    }
  } catch (_) {}

  // Font size switcher buttons
  root.querySelectorAll(".papa-caption-actions button").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const scale = btn.dataset.scale || "md";
      root.dataset.scale = scale;
      try { localStorage.setItem("papaDubCaptionScale", scale); } catch (_) {}
    });
  });

  // Smooth Drag & Drop via pointer events on the toolbar
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origBottom = 0;

  toolbar.addEventListener("pointerdown", (e) => {
    if (e.target.closest("button")) return;
    dragging = true;
    toolbar.setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    origLeft = rect.left + rect.width / 2;
    origBottom = window.innerHeight - rect.bottom;
    root.classList.add("papa-dragging");
  });

  toolbar.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const nextLeft = Math.min(window.innerWidth - 120, Math.max(120, origLeft + dx));
    const nextBottom = Math.min(window.innerHeight - 80, Math.max(12, origBottom - dy));
    root.style.left = `${Math.round(nextLeft)}px`;
    root.style.bottom = `${Math.round(nextBottom)}px`;
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    root.classList.remove("papa-dragging");
    try {
      localStorage.setItem("papaDubCaptionPos", JSON.stringify({
        left: parseFloat(root.style.left) || window.innerWidth / 2,
        bottom: parseFloat(root.style.bottom) || 30
      }));
    } catch (_) {}
  };
  toolbar.addEventListener("pointerup", endDrag);
  toolbar.addEventListener("pointercancel", endDrag);

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PAPA_CAPTION" || message?.type === "NAVA_CAPTION") {
      original.textContent = message.original || "";
      translation.textContent = message.translation || "";
      root.classList.toggle("papa-visible", Boolean(message.original || message.translation));
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => root.classList.remove("papa-visible"), 8500);
    }
    if (message?.type === "PAPA_CAPTION_STYLE" && message.scale) {
      root.dataset.scale = message.scale;
      try { localStorage.setItem("papaDubCaptionScale", message.scale); } catch (_) {}
    }
    if (message?.type === "PAPA_REMOVE_CAPTIONS" || message?.type === "NAVA_REMOVE_CAPTIONS") {
      original.textContent = "";
      translation.textContent = "";
      root.classList.remove("papa-visible");
    }
  });
})();
